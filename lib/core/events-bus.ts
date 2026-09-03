/**
 * In-process pub/sub backing the SSE endpoints.
 *
 * Single-instance only. For a multi-instance deployment this is the seam where
 * a Postgres LISTEN/NOTIFY bridge plugs in: `publish` would NOTIFY, and one
 * listener per instance would fan back in through `deliver`. The subscriber
 * API does not change, so nothing above this file is affected.
 */
export interface BusMessage {
  kind: string;
  [key: string]: unknown;
}

type Subscriber = (message: BusMessage) => void;

const channels = new Map<string, Set<Subscriber>>();

export function subscribe(channel: string, subscriber: Subscriber): () => void {
  let subscribers = channels.get(channel);
  if (!subscribers) {
    subscribers = new Set();
    channels.set(channel, subscribers);
  }
  subscribers.add(subscriber);

  return () => {
    const current = channels.get(channel);
    if (!current) return;
    current.delete(subscriber);
    if (current.size === 0) channels.delete(channel);
  };
}

export function publish(channel: string, message: BusMessage): void {
  deliver(channel, message);
}

export function deliver(channel: string, message: BusMessage): void {
  const subscribers = channels.get(channel);
  if (!subscribers) return;
  for (const subscriber of subscribers) {
    try {
      subscriber(message);
    } catch {
      // One broken listener must not stop the rest.
    }
  }
}

export function subscriberCount(channel: string): number {
  return channels.get(channel)?.size ?? 0;
}

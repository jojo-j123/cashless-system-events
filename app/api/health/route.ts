import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';

/** Liveness plus a real database round trip. Public by design. */
export async function GET(): Promise<NextResponse> {
  try {
    await getDb().execute(sql`select 1`);
    return NextResponse.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch {
    return NextResponse.json(
      { status: 'degraded', timestamp: new Date().toISOString() },
      { status: 503 },
    );
  }
}

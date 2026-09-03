'use client';

import { type ReactNode } from 'react';

type Tone = 'brand' | 'neutral' | 'success' | 'warn' | 'danger';

const TONE_CLASSES: Record<Tone, string> = {
  brand: 'bg-brand-600 text-white hover:bg-brand-700 focus-visible:outline-brand-600',
  neutral: 'bg-white text-ink-800 border border-ink-300 hover:bg-ink-50 focus-visible:outline-ink-500',
  success: 'bg-success-600 text-white hover:bg-success-700 focus-visible:outline-success-600',
  warn: 'bg-warn-500 text-ink-900 hover:bg-warn-700 hover:text-white focus-visible:outline-warn-500',
  danger: 'bg-danger-600 text-white hover:bg-danger-700 focus-visible:outline-danger-600',
};

export function Button({
  children,
  tone = 'brand',
  size = 'md',
  type = 'button',
  disabled,
  onClick,
  className = '',
  fullWidth,
}: {
  children: ReactNode;
  tone?: Tone;
  size?: 'sm' | 'md' | 'lg';
  type?: 'button' | 'submit';
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
  fullWidth?: boolean;
}): React.ReactElement {
  const sizing =
    size === 'lg'
      ? 'px-6 py-4 text-lg touch-target'
      : size === 'sm'
        ? 'px-3 py-1.5 text-sm'
        : 'px-4 py-2.5 text-sm';

  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition
        focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
        disabled:cursor-not-allowed disabled:opacity-50
        ${TONE_CLASSES[tone]} ${sizing} ${fullWidth ? 'w-full' : ''} ${className}`}
    >
      {children}
    </button>
  );
}

export function Card({
  children,
  className = '',
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}): React.ReactElement {
  return (
    <section
      className={`rounded-2xl border border-ink-200 bg-white shadow-sm ${padded ? 'p-5' : ''} ${className}`}
    >
      {children}
    </section>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: Tone;
}): React.ReactElement {
  const classes: Record<Tone, string> = {
    brand: 'bg-brand-50 text-brand-700 ring-brand-100',
    neutral: 'bg-ink-100 text-ink-700 ring-ink-200',
    success: 'bg-success-50 text-success-700 ring-success-500/20',
    warn: 'bg-warn-50 text-warn-700 ring-warn-500/20',
    danger: 'bg-danger-50 text-danger-700 ring-danger-500/20',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${classes[tone]}`}
    >
      {children}
    </span>
  );
}

/** Points are the product's unit of value; render them one consistent way. */
export function Points({
  value,
  size = 'md',
  signed = false,
}: {
  value: number;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  signed?: boolean;
}): React.ReactElement {
  const sizing = {
    sm: 'text-sm',
    md: 'text-base',
    lg: 'text-2xl',
    xl: 'text-5xl',
  }[size];
  const tone = signed ? (value > 0 ? 'text-success-700' : value < 0 ? 'text-danger-700' : '') : '';
  const prefix = signed && value > 0 ? '+' : '';

  return (
    <span className={`tabular font-semibold ${sizing} ${tone}`}>
      {prefix}
      {value.toLocaleString()}
    </span>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: Tone;
}): React.ReactElement {
  const accent: Record<Tone, string> = {
    brand: 'text-brand-700',
    neutral: 'text-ink-900',
    success: 'text-success-700',
    warn: 'text-warn-700',
    danger: 'text-danger-700',
  };
  return (
    <div className="rounded-2xl border border-ink-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</p>
      <p className={`tabular mt-1 text-2xl font-bold ${accent[tone]}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </p>
      {hint ? <p className="mt-1 text-xs text-ink-500">{hint}</p> : null}
    </div>
  );
}

export function Alert({
  tone,
  title,
  children,
}: {
  tone: 'success' | 'warn' | 'danger' | 'brand';
  title: string;
  children?: ReactNode;
}): React.ReactElement {
  const classes = {
    success: 'border-success-500/30 bg-success-50 text-success-700',
    warn: 'border-warn-500/30 bg-warn-50 text-warn-700',
    danger: 'border-danger-500/30 bg-danger-50 text-danger-700',
    brand: 'border-brand-400/30 bg-brand-50 text-brand-700',
  }[tone];

  return (
    <div role="status" className={`rounded-xl border px-4 py-3 ${classes}`}>
      <p className="font-semibold">{title}</p>
      {children ? <div className="mt-1 text-sm">{children}</div> : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}): React.ReactElement {
  return (
    <div className="rounded-2xl border border-dashed border-ink-300 bg-white/60 px-6 py-12 text-center">
      <p className="font-semibold text-ink-700">{title}</p>
      <p className="mt-1 text-sm text-ink-500">{description}</p>
    </div>
  );
}

export function Spinner({ label }: { label: string }): React.ReactElement {
  return (
    <div className="flex items-center gap-3 text-sm text-ink-500">
      <span
        aria-hidden
        className="h-4 w-4 animate-spin rounded-full border-2 border-ink-300 border-t-brand-600"
      />
      <span>{label}</span>
    </div>
  );
}

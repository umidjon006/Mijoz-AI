/** Kichik, qayta ishlatiladigan UI bo'laklari. */
import type { ReactNode } from 'react';

import { mashq, outcomeLabel } from '../lugat/mashq.js';

export function Notice({
  kind = 'info',
  children,
}: {
  kind?: 'info' | 'warn' | 'error';
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={`mq-notice mq-notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }): JSX.Element {
  return <div className="mq-empty">{children}</div>;
}

/** Yuklanishda joyni band qilib turadi — sahifa "sakramaydi". */
export function Skeleton({ height = 16, width = '100%' }: { height?: number; width?: number | string }): JSX.Element {
  return (
    <div
      className="mq-skeleton"
      style={{ height, width, marginBottom: 8 }}
      aria-hidden="true"
    />
  );
}

export function OutcomeBadge({ outcome }: { outcome: string | null }): JSX.Element {
  const suffix =
    outcome === 'won' ? 'won' : outcome === 'lost' ? 'lost' : outcome === 'timeout' ? 'timeout' : '';
  return (
    <span className={`mq-badge${suffix ? ` mq-badge-${suffix}` : ''}`}>
      {outcomeLabel(outcome)}
    </span>
  );
}

export function DifficultyDots({ level }: { level: number }): JSX.Element {
  const max = 5;
  return (
    <span className="mq-dots" aria-label={`${mashq.difficulty}: ${level}/${max}`}>
      {'●'.repeat(Math.max(0, Math.min(max, level)))}
      {'○'.repeat(Math.max(0, max - level))}
    </span>
  );
}

/** Mahorat balli halqasi (inline SVG — tashqi kutubxona kerak emas). */
export function ScoreRing({
  score,
  size = 108,
}: {
  score: number | null;
  size?: number;
}): JSX.Element {
  const stroke = 10;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = score === null ? 0 : Math.max(0, Math.min(100, score)) / 100;
  const color = score === null ? 'var(--mq-muted)' : score >= 70 ? 'var(--mq-ok)' : score >= 45 ? 'var(--mq-warn)' : 'var(--mq-bad)';

  return (
    <div>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`${mashq.skillScore}: ${score === null ? mashq.noScore : `${score} / 100`}`}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--mq-line)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference * ratio} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={score === null ? 14 : 24}
          fontWeight="700"
          fill="var(--mq-text)"
        >
          {score === null ? '—' : Math.round(score)}
        </text>
      </svg>
      <div className="mq-ring-label">{mashq.skillScore}</div>
    </div>
  );
}

export function ScoreBar({ score }: { score: 0 | 1 | 2 | 3 }): JSX.Element {
  return (
    <div className="mq-bar" aria-hidden="true">
      <div style={{ width: `${(score / 3) * 100}%` }} />
    </div>
  );
}

export function Metric({ label, value }: { label: string; value: ReactNode }): JSX.Element {
  return (
    <div className="mq-metric">
      <span className="mq-metric-label">{label}</span>
      <span className="mq-metric-value">{value}</span>
    </div>
  );
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m} daq ${s} s` : `${s} s`;
}

export function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('uz-UZ', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

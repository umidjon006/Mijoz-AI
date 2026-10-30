/**
 * Mijoz holati (sabr / ishonch / qiziqish) egri chizig'i.
 * Inline SVG — asosiy repoda grafik kutubxonasi topilmagani uchun
 * (integratsiyada o'sha kutubxonaga almashtirish mumkin).
 */
import { mashq } from '../lugat/mashq.js';
import type { StatePoint } from '../lib/api.js';

const SERIES = [
  { key: 'patience' as const, label: mashq.chartPatience, color: '#b4780a' },
  { key: 'trust' as const, label: mashq.chartTrust, color: '#2f6fed' },
  { key: 'interest' as const, label: mashq.chartInterest, color: '#1f9d6b' },
];

export function StateChart({ series }: { series: StatePoint[] }): JSX.Element | null {
  if (series.length < 2) return null;

  const width = 640;
  const height = 180;
  const pad = { top: 12, right: 12, bottom: 24, left: 30 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const x = (i: number): number =>
    pad.left + (series.length === 1 ? innerW / 2 : (i / (series.length - 1)) * innerW);
  const y = (value: number): number => pad.top + innerH - (value / 100) * innerH;

  return (
    <div>
      <div className="mq-btn-row" style={{ marginBottom: 6 }}>
        {SERIES.map((s) => (
          <span key={s.key} className="mq-small mq-muted">
            <span
              aria-hidden="true"
              style={{
                display: 'inline-block',
                width: 10,
                height: 10,
                borderRadius: 3,
                background: s.color,
                marginRight: 5,
              }}
            />
            {s.label}
          </span>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={mashq.stateChartTitle}
        preserveAspectRatio="none"
      >
        {[0, 50, 100].map((tick) => (
          <g key={tick}>
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke="var(--mq-line)"
              strokeWidth="1"
            />
            <text x={4} y={y(tick) + 4} fontSize="10" fill="var(--mq-muted)">
              {tick}
            </text>
          </g>
        ))}

        {SERIES.map((s) => (
          <polyline
            key={s.key}
            fill="none"
            stroke={s.color}
            strokeWidth="2"
            strokeLinejoin="round"
            points={series.map((point, i) => `${x(i)},${y(point[s.key])}`).join(' ')}
          />
        ))}

        {series.map((point, i) => (
          <text
            key={point.turnSeq}
            x={x(i)}
            y={height - 6}
            fontSize="10"
            fill="var(--mq-muted)"
            textAnchor="middle"
          >
            {i === 0 || i === series.length - 1 || series.length <= 8 ? `T${point.turnSeq}` : ''}
          </text>
        ))}
      </svg>

      {/* Skrinrider uchun matnli variant */}
      <table className="mq-sr-only">
        <caption>{mashq.stateChartTitle}</caption>
        <thead>
          <tr>
            <th>{mashq.turnCounter}</th>
            {SERIES.map((s) => (
              <th key={s.key}>{s.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {series.map((point) => (
            <tr key={point.turnSeq}>
              <td>{point.turnSeq}</td>
              {SERIES.map((s) => (
                <td key={s.key}>{point[s.key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

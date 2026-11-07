/**
 * Tarix / Taraqqiyot: o'z mashqlari, ball dinamikasi, eng zaif mezonlar.
 * `training:view:all` ruxsati bo'lgan rahbar boshqa sotuvchini ham ko'radi.
 */
import { useEffect, useState } from 'react';

import { mashq } from '../lugat/mashq.js';
import { errorText } from '../lib/api-error.js';
import { usePresentation } from '../lib/presentation.js';
import type { SessionListItem, StatsResponse, TrainingApi } from '../lib/api.js';
import { EmptyState, formatDate, Metric, Notice, OutcomeBadge, Skeleton } from '../components/ui.js';

export interface TarixPageProps {
  api: TrainingApi;
  /** `training:view:all` bo'lsa sotuvchi filtri ko'rsatiladi. */
  canViewAll?: boolean;
  onOpenResult: (sessionId: string) => void;
}

/** Ball dinamikasi — kichik inline SVG (sparkline). */
function Trend({ points }: { points: StatsResponse['skillScoreTrend'] }): JSX.Element | null {
  if (points.length < 2) return null;
  const width = 560;
  const height = 90;
  const pad = 8;
  const x = (i: number): number => pad + (i / (points.length - 1)) * (width - pad * 2);
  const y = (value: number): number => height - pad - (value / 100) * (height - pad * 2);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      role="img"
      aria-label={mashq.trend}
      preserveAspectRatio="none"
    >
      <polyline
        fill="none"
        stroke="var(--mq-accent)"
        strokeWidth="2"
        points={points.map((p, i) => `${x(i)},${y(p.skillScore)}`).join(' ')}
      />
      {points.map((p, i) => (
        <circle key={p.sessionId} cx={x(i)} cy={y(p.skillScore)} r="3" fill="var(--mq-accent)" />
      ))}
    </svg>
  );
}

export function TarixPage({ api, canViewAll = false, onOpenResult }: TarixPageProps): JSX.Element {
  const presentation = usePresentation();
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [userId, setUserId] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [list, myStats] = await Promise.all([api.listSessions(), api.myStats()]);
        if (cancelled) return;
        setSessions(list);
        setStats(myStats);
      } catch (err) {
        if (!cancelled) setError(errorText(err, presentation));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function loadOther(): Promise<void> {
    const value = userId.trim();
    if (value.length === 0) return;
    setError(null);
    try {
      setStats(await api.userStats(value));
    } catch (err) {
      setError(errorText(err, presentation));
    }
  }

  return (
    <div>
      <h1 className="mq-h1">{mashq.historyTitle}</h1>
      <p className="mq-sub">{mashq.historySubtitle}</p>

      {error ? <Notice kind="error">{error}</Notice> : null}

      {canViewAll ? (
        <div className="mq-btn-row" style={{ marginBottom: 14 }}>
          <label className="mq-small" htmlFor="mq-user-filter">
            {mashq.sellerFilter}
          </label>
          <input
            id="mq-user-filter"
            className="mq-btn"
            style={{ minWidth: 280 }}
            placeholder="user id"
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
          />
          <button type="button" className="mq-btn" onClick={() => void loadOther()}>
            {mashq.teamOverview}
          </button>
        </div>
      ) : null}

      {stats === null ? (
        <Skeleton height={76} />
      ) : (
        <div className="mq-metrics">
          <Metric label={mashq.totalSessions} value={stats.totalSessions} />
          <Metric
            label={mashq.avgScore}
            value={stats.avgSkillScore === null ? '—' : Math.round(stats.avgSkillScore)}
          />
          {stats.winRateByArchetype.map((row) => (
            <Metric
              key={row.archetypeKey}
              label={`${mashq.winRate}: ${row.archetypeKey}`}
              value={row.winRate === null ? '—' : `${Math.round(row.winRate * 100)}%`}
            />
          ))}
        </div>
      )}

      {stats && stats.skillScoreTrend.length > 1 ? (
        <>
          <h2 className="mq-h2">{mashq.trend}</h2>
          <div className="mq-panel">
            <Trend points={stats.skillScoreTrend} />
          </div>
        </>
      ) : null}

      <h2 className="mq-h2">{mashq.weakest}</h2>
      <div className="mq-panel">
        {stats === null ? (
          <Skeleton height={60} />
        ) : stats.weakestCriteria.length === 0 ? (
          <EmptyState>{mashq.noData}</EmptyState>
        ) : (
          <table className="mq-table">
            <thead>
              <tr>
                <th scope="col">{mashq.criteria}</th>
                <th scope="col">{mashq.avgScore}</th>
                <th scope="col">n</th>
              </tr>
            </thead>
            <tbody>
              {stats.weakestCriteria.map((row) => (
                <tr key={row.code}>
                  <td>{row.name}</td>
                  <td className="mq-mono">{row.avgScore} / 3</td>
                  <td className="mq-mono">{row.samples}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2 className="mq-h2">{mashq.recentSessions}</h2>
      <div className="mq-panel">
        {sessions === null ? (
          <Skeleton height={120} />
        ) : sessions.length === 0 ? (
          <EmptyState>{mashq.noSessions}</EmptyState>
        ) : (
          <table className="mq-table">
            <thead>
              <tr>
                <th scope="col">{mashq.sessionDate}</th>
                <th scope="col">{mashq.customer}</th>
                <th scope="col">{mashq.turnCounter}</th>
                <th scope="col">{mashq.outcome}</th>
                <th scope="col">{mashq.skillScore}</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id}>
                  <td className="mq-small">{formatDate(session.startedAt)}</td>
                  <td className="mq-small">{session.archetypeKey}</td>
                  <td className="mq-mono">{session.turnCount}</td>
                  <td>
                    <OutcomeBadge outcome={session.status === 'active' ? null : session.outcome} />
                  </td>
                  <td className="mq-mono">
                    {session.skillScore === null ? '—' : Math.round(session.skillScore)}
                    {session.resultQuality === 'low' ? ' ⚠' : ''}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="mq-btn mq-small"
                      onClick={() => onOpenResult(session.id)}
                    >
                      {mashq.open}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

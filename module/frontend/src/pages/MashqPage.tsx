/** Bosh sahifa: mijoz tanlash, mashqni boshlash, qisqa natijalar. */
import { useEffect, useState } from 'react';

import { mashq } from '../lugat/mashq.js';
import { errorText } from '../lib/api-error.js';
import { usePresentation } from '../lib/presentation.js';
import type {
  ArchetypeInfo,
  SessionListItem,
  StatsResponse,
  TrainingApi,
} from '../lib/api.js';
import { DifficultyDots, EmptyState, formatDate, Metric, Notice, OutcomeBadge, Skeleton } from '../components/ui.js';

export interface MashqPageProps {
  api: TrainingApi;
  /** Profildagi `callDirection` — `mixed` bo'lsa yo'nalish tanlovi ko'rsatiladi. */
  callDirection?: 'inbound' | 'outbound' | 'mixed';
  /** `archetypeKey` — "Yangi mashq" shu mijoz turi bilan boshlashi uchun. */
  onStarted: (sessionId: string, archetypeKey?: string) => void;
  onOpenResult: (sessionId: string) => void;
  onOpenHistory: () => void;
}

export function MashqPage({
  api,
  callDirection = 'mixed',
  onStarted,
  onOpenResult,
  onOpenHistory,
}: MashqPageProps): JSX.Element {
  const presentation = usePresentation();
  const [archetypes, setArchetypes] = useState<ArchetypeInfo[] | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [direction, setDirection] = useState<'auto' | 'inbound' | 'outbound'>('auto');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [list, recent, myStats] = await Promise.all([
          api.listArchetypes(),
          api.listSessions(),
          api.myStats(),
        ]);
        if (cancelled) return;
        setArchetypes(list);
        setSessions(recent);
        setStats(myStats);
        setSelected((current) => current ?? list[0]?.key ?? null);
      } catch (err) {
        if (!cancelled) setError(errorText(err, presentation));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function start(): Promise<void> {
    if (!selected) return;
    setStarting(true);
    setError(null);
    try {
      const started = await api.startSession({
        archetypeKey: selected,
        ...(direction === 'auto' ? {} : { direction }),
      });
      onStarted(started.sessionId, selected);
    } catch (err) {
      setError(errorText(err, presentation));
    } finally {
      setStarting(false);
    }
  }

  return (
    <div>
      <h1 className="mq-h1">{mashq.homeTitle}</h1>
      <p className="mq-sub">{mashq.homeSubtitle}</p>

      {error ? <Notice kind="error">{error}</Notice> : null}

      {archetypes === null ? (
        <div className="mq-cards">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={120} />
          ))}
        </div>
      ) : (
        <div className="mq-cards">
          {archetypes.map((archetype) => (
            <button
              type="button"
              key={archetype.key}
              className="mq-card"
              aria-pressed={selected === archetype.key}
              onClick={() => setSelected(archetype.key)}
            >
              <span className="mq-card-title">{archetype.title}</span>
              <DifficultyDots level={archetype.difficulty} />
              <span className="mq-card-desc">{archetype.description}</span>
              <span className="mq-muted mq-small">
                {mashq.turnCounter}: {archetype.maxTurns}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="mq-btn-row" style={{ marginTop: 16 }}>
        {callDirection === 'mixed' ? (
          <label className="mq-small">
            {mashq.directionLabel}{' '}
            <select
              value={direction}
              onChange={(event) =>
                setDirection(event.target.value as 'auto' | 'inbound' | 'outbound')
              }
            >
              <option value="auto">{mashq.directionAuto}</option>
              <option value="inbound">{mashq.directionInbound}</option>
              <option value="outbound">{mashq.directionOutbound}</option>
            </select>
          </label>
        ) : null}

        <button
          type="button"
          className="mq-btn mq-btn-primary"
          disabled={!selected || starting}
          onClick={() => void start()}
        >
          {starting ? mashq.starting : mashq.startPractice}
        </button>
      </div>

      <h2 className="mq-h2">{mashq.myProgress}</h2>
      {stats === null ? (
        <Skeleton height={76} />
      ) : (
        <div className="mq-metrics">
          <Metric label={mashq.totalSessions} value={stats.totalSessions} />
          <Metric
            label={mashq.avgScore}
            value={stats.avgSkillScore === null ? '—' : Math.round(stats.avgSkillScore)}
          />
          <Metric
            label={mashq.weakest}
            value={
              stats.weakestCriteria[0] ? (
                <span className="mq-small">{stats.weakestCriteria[0].name}</span>
              ) : (
                '—'
              )
            }
          />
        </div>
      )}

      <h2 className="mq-h2">{mashq.recentSessions}</h2>
      {sessions === null ? (
        <Skeleton height={120} />
      ) : sessions.length === 0 ? (
        <EmptyState>{mashq.noSessions}</EmptyState>
      ) : (
        <>
          <table className="mq-table">
            <thead>
              <tr>
                <th scope="col">{mashq.sessionDate}</th>
                <th scope="col">{mashq.customer}</th>
                <th scope="col">{mashq.outcome}</th>
                <th scope="col">{mashq.skillScore}</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {sessions.slice(0, 5).map((session) => (
                <tr key={session.id}>
                  <td className="mq-small">{formatDate(session.startedAt)}</td>
                  <td className="mq-small">{session.archetypeKey}</td>
                  <td>
                    <OutcomeBadge outcome={session.status === 'active' ? null : session.outcome} />
                  </td>
                  <td className="mq-mono">
                    {session.skillScore === null ? '—' : Math.round(session.skillScore)}
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
          <div className="mq-btn-row" style={{ marginTop: 10 }}>
            <button type="button" className="mq-btn mq-small" onClick={onOpenHistory}>
              {mashq.seeAll}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

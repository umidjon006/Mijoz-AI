/** Bosh sahifa: mijoz tanlash, mashqni boshlash, qisqa natijalar. */
import { useEffect, useState } from 'react';

import { mashq } from '../lugat/mashq.js';
import { errorText } from '../lib/api-error.js';
import { usePresentation } from '../lib/presentation.js';
import type {
  ArchetypeInfo,
  ScenarioInfo,
  SellerProfile,
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

const SELLER_KEY = 'mq-seller-profile';

/** Saqlangan profil (faqat qulaylik uchun; brauzer xotirasi bo'lmasa ham ishlaydi). */
function loadSeller(): Partial<SellerProfile> {
  try {
    const raw = window.localStorage.getItem(SELLER_KEY);
    return raw ? (JSON.parse(raw) as Partial<SellerProfile>) : {};
  } catch {
    return {};
  }
}

function saveSeller(p: SellerProfile): void {
  try {
    window.localStorage.setItem(SELLER_KEY, JSON.stringify(p));
  } catch {
    // brauzer xotirasi yopiq — muhim emas
  }
}

function validSeller(p: Partial<SellerProfile>): p is SellerProfile {
  return (
    typeof p.name === 'string' &&
    p.name.trim().length >= 2 &&
    (p.gender === 'male' || p.gender === 'female') &&
    typeof p.age === 'number' &&
    p.age >= 16 &&
    p.age <= 80
  );
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
  const [scenarios, setScenarios] = useState<ScenarioInfo[]>([]);
  const [selectedScenario, setSelectedScenario] = useState<string | null>(null);
  // Jins oldindan TANLANMAYDI — sotuvchi o'zi belgilaydi.
  const [seller, setSeller] = useState<Partial<SellerProfile>>(() => loadSeller());
  const [ack, setAck] = useState(false);
  const [level, setLevel] = useState<'easy' | 'medium' | 'hard'>('medium');
  const [direction, setDirection] = useState<'auto' | 'inbound' | 'outbound'>('auto');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [list, recent, myStats, scenarioList] = await Promise.all([
          api.listArchetypes(),
          api.listSessions(),
          api.myStats(),
          api.listScenarios(),
        ]);
        if (cancelled) return;
        setArchetypes(list);
        setScenarios(scenarioList);
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

  const scenario = scenarios.find((s) => s.id === selectedScenario) ?? null;
  const needsAck = Boolean(scenario?.content.harsh);
  const canStart = scenario ? validSeller(seller) && (!needsAck || ack) : Boolean(selected);

  async function start(): Promise<void> {
    if (scenario && !validSeller(seller)) {
      setError(mashq.sellerRequired);
      return;
    }
    if (!scenario && !selected) return;
    setStarting(true);
    setError(null);
    try {
      const started = scenario
        ? await api.startSession({ scenarioId: scenario.id, seller: seller as SellerProfile, level })
        : await api.startSession({
            archetypeKey: selected as string,
            ...(direction === 'auto' ? {} : { direction }),
          });
      if (scenario) saveSeller(seller as SellerProfile);
      onStarted(started.sessionId, scenario ? undefined : (selected as string));
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
              aria-pressed={!selectedScenario && selected === archetype.key}
              onClick={() => {
                setSelected(archetype.key);
                setSelectedScenario(null);
              }}
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

      {scenarios.length > 0 ? (
        <>
          <h2 className="mq-h2" style={{ marginTop: 24 }}>{mashq.scenariosTitle}</h2>
          <div className="mq-cards">
            {scenarios.map((sc) => (
              <button
                type="button"
                key={sc.id}
                className="mq-card"
                aria-pressed={selectedScenario === sc.id}
                onClick={() => {
                  setSelectedScenario(sc.id);
                  setAck(false);
                }}
              >
                <span className="mq-card-title">{sc.title}</span>
                <DifficultyDots level={sc.difficulty} />
                <span className="mq-card-desc">{sc.description}</span>
                {sc.content.harsh ? <span className="mq-muted mq-small">⚠ {mashq.harshBadge}</span> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}

      {scenario ? (
        <div className="mq-panel" style={{ marginTop: 16 }}>
          <h2 className="mq-h2">{mashq.sellerTitle}</h2>
          <p className="mq-small mq-muted">{mashq.sellerHint}</p>
          <div className="mq-btn-row">
            <label className="mq-small">
              {mashq.sellerName}{' '}
              <input
                value={seller.name ?? ''}
                maxLength={60}
                onChange={(e) => setSeller({ ...seller, name: e.target.value })}
              />
            </label>
            <fieldset className="mq-small" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="mq-small">{mashq.sellerGender}</legend>
              <label>
                <input
                  type="radio"
                  name="seller-gender"
                  checked={seller.gender === 'female'}
                  onChange={() => setSeller({ ...seller, gender: 'female' })}
                />{' '}
                {mashq.sellerFemale}
              </label>{' '}
              <label>
                <input
                  type="radio"
                  name="seller-gender"
                  checked={seller.gender === 'male'}
                  onChange={() => setSeller({ ...seller, gender: 'male' })}
                />{' '}
                {mashq.sellerMale}
              </label>
            </fieldset>
            <label className="mq-small">
              {mashq.sellerAge}{' '}
              <input
                type="number"
                min={16}
                max={80}
                style={{ width: 70 }}
                value={seller.age ?? ''}
                onChange={(e) => setSeller({ ...seller, age: e.target.value ? Number(e.target.value) : undefined })}
              />
            </label>
          </div>
          <label className="mq-small" style={{ display: 'block', marginTop: 8 }}>
            Daraja:{' '}
            <select value={level} onChange={(e) => setLevel(e.target.value as 'easy' | 'medium' | 'hard')}>
              <option value="easy">Oson</option>
              <option value="medium">O'rta</option>
              <option value="hard">Qiyin</option>
            </select>
          </label>
          {scenario.content.textModeRecommended ? (
            <Notice kind="info">Bu mijoz uchun mos ovoz yo'q — matnli rejimda mashq qilish tavsiya etiladi.</Notice>
          ) : null}
          {scenario.content.harsh && scenario.content.warning ? (
            <Notice kind="warn">
              {scenario.content.warning}{' '}
              <label className="mq-small">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> {mashq.contentAck}
              </label>
            </Notice>
          ) : null}
        </div>
      ) : null}

      <div className="mq-btn-row" style={{ marginTop: 16 }}>
        {callDirection === 'mixed' && !scenario ? (
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
          disabled={!canStart || starting}
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

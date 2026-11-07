/**
 * Natija (debrief) sahifasi: ball, o'lchovlar, grafik, mezonlar, maslahat,
 * muhim lahzalar, transkript va mijozning yashirin kartalari.
 *
 * Baholash fon rejimida ketadi, shuning uchun sahifa `pending` holatda
 * har 2 sekundda tekshiradi (chegara bilan — cheksiz poll qilmaydi).
 * Natija `failed` yoki 3 daqiqadan beri `pending` bo'lsa "Qayta baholash"
 * tugmasi chiqadi (yangi versiya; eskilari saqlanadi).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { mashq } from '../lugat/mashq.js';
import { errorText } from '../lib/api-error.js';
import { usePresentation } from '../lib/presentation.js';
import type { ResultResponse, TrainingApi } from '../lib/api.js';
import { canOfferRescore, scoringRunState } from '../lib/rescore.js';
import {
  EmptyState,
  formatDuration,
  Metric,
  Notice,
  OutcomeBadge,
  ScoreRing,
  Skeleton,
} from '../components/ui.js';
import { CriteriaList } from '../components/CriteriaList.js';
import {
  CoachingCard,
  KeyMoments,
  RedLineViolations,
  ScriptAdherence,
} from '../components/Coaching.js';
import { HiddenCards } from '../components/HiddenCards.js';
import { StateChart } from '../components/StateChart.js';
import { Transcript } from '../components/Transcript.js';

const POLL_INTERVAL_MS = 2000;
// ~3.5 daqiqa: "Qayta baholash" tugmasi (3 daqiqa) chiqquncha kuzatamiz.
const POLL_MAX_ATTEMPTS = 105;

export interface NatijaPageProps {
  api: TrainingApi;
  sessionId: string;
  onRetrySame: (archetypeKey: string) => void;
  onAnotherCustomer: () => void;
}

export function NatijaPage({
  api,
  sessionId,
  onRetrySame,
  onAnotherCustomer,
}: NatijaPageProps): JSX.Element {
  const presentation = usePresentation();
  const [data, setData] = useState<ResultResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [highlight, setHighlight] = useState<number | null>(null);
  /** "Qayta baholash" so'rovi yuborilmoqda (javob kelguncha). */
  const [rescoring, setRescoring] = useState(false);
  /** Server qaytargan run versiyasi — u tugaguncha tugma o'chiq. */
  const awaitingVersion = useRef<number | null>(null);
  /** Qayta baholashdan keyin poll'ni QAYTA boshlash uchun. */
  const [pollKey, setPollKey] = useState(0);
  const attempts = useRef(0);
  /** Qaysi versiya qachondan beri `pending` ko'rinyapti (brauzer soati). */
  const pendingSeen = useRef<{ version: number; since: number } | null>(null);

  const load = useCallback(async (): Promise<'pending' | 'done' | 'missing'> => {
    try {
      const response = await api.getResult(sessionId);
      const run = response.latestRun ?? response.result;
      if (run.status === 'pending') {
        if (pendingSeen.current?.version !== run.version) {
          pendingSeen.current = { version: run.version, since: Date.now() };
        }
      } else {
        pendingSeen.current = null;
      }
      const state = scoringRunState(response.result, response.latestRun, awaitingVersion.current);
      // Biz so'ragan run tugadi (done yoki failed) — tugma yana yoqiladi.
      if (!state.inProgress) awaitingVersion.current = null;
      setData(response);
      setError(null);
      return state.inProgress || response.result.status === 'pending' ? 'pending' : 'done';
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      // Natija hali yaratilmagan bo'lishi mumkin (404) — kutamiz.
      if (raw.includes('404') || raw.toLowerCase().includes('not_found')) return 'missing';
      setError(errorText(err, presentation));
      return 'done';
    }
  }, [api, sessionId, presentation]);

  useEffect(() => {
    let stopped = false;
    attempts.current = 0;
    setTimedOut(false);

    const tick = async (): Promise<void> => {
      if (stopped) return;
      const state = await load();
      if (stopped) return;
      if (state === 'done') return;

      attempts.current += 1;
      if (attempts.current >= POLL_MAX_ATTEMPTS) {
        setTimedOut(true);
        return;
      }
      window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };

    void tick();
    return () => {
      stopped = true;
    };
  }, [load, pollKey]);

  async function rescore(): Promise<void> {
    // Tugma DARHOL o'chadi; server ham bir sessiyada bitta run'ga ruxsat beradi.
    if (rescoring || awaitingVersion.current !== null) return;
    setRescoring(true);
    setTimedOut(false);
    try {
      const response = await api.requestScore(sessionId);
      // Yangi yoki allaqachon ketayotgan run — tugaguncha kuzatamiz.
      awaitingVersion.current = response.version;
      pendingSeen.current = null;
      setPollKey((key) => key + 1);
    } catch (err) {
      setError(errorText(err, presentation));
    } finally {
      setRescoring(false);
    }
  }

  function jumpToTurn(turnSeq: number): void {
    setHighlight(turnSeq);
    const element = document.getElementById(`mq-turn-${turnSeq}`);
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  if (error) {
    return (
      <div>
        <Notice kind="error">{error}</Notice>
        <button type="button" className="mq-btn" onClick={onAnotherCustomer}>
          {mashq.back}
        </button>
      </div>
    );
  }

  if (!data) {
    return (
      <div>
        <h1 className="mq-h1">{mashq.resultTitle}</h1>
        <Notice kind="info">{mashq.scoring}</Notice>
        <p className="mq-sub">{mashq.scoringHint}</p>
        <Skeleton height={110} />
        <Skeleton height={80} />
        <Skeleton height={160} />
        {timedOut ? (
          <button type="button" className="mq-btn" onClick={() => void rescore()}>
            {mashq.retry}
          </button>
        ) : null}
      </div>
    );
  }

  const { result, revealed, transcript } = data;
  const metrics = result.metrics;
  const latestRun = data.latestRun ?? null;
  const runState = scoringRunState(result, latestRun, awaitingVersion.current);
  const run = latestRun ?? result;
  // Run 3 daqiqadan beri pending — server to'xtagan bo'lishi mumkin: tugmani qaytaramiz
  // (server baribir ketayotgan run'ni qaytaradi, yangisini boshlamaydi).
  const stuck = run.status === 'pending' && canOfferRescore(run, Date.now(), pendingSeen.current?.since ?? null);
  const busy = rescoring || (runState.inProgress && !stuck);
  const rescoreButton = (
    <button
      type="button"
      className="mq-btn mq-small"
      disabled={busy}
      aria-busy={busy}
      onClick={() => void rescore()}
    >
      {busy ? mashq.scoring : mashq.scoreAgain}
    </button>
  );

  return (
    <div>
      <div className="mq-btn-row" style={{ justifyContent: 'space-between' }}>
        <h1 className="mq-h1">{mashq.resultTitle}</h1>
        <OutcomeBadge outcome={data.outcome} />
      </div>

      {runState.inProgress || rescoring ? (
        <Notice kind={stuck ? 'warn' : 'info'}>
          {stuck
            ? mashq.scoringStuck
            : result.status === 'pending'
              ? `${mashq.scoring} ${mashq.scoringHint}`
              : `${mashq.scoring} ${mashq.rescoringHint}`}{' '}
          {stuck ? rescoreButton : null}
        </Notice>
      ) : null}
      {runState.failedRun ? (
        <Notice kind="error">
          {mashq.rescoreFailed}
          {runState.failedRun.error ? ` (${runState.failedRun.error})` : ''} {rescoreButton}
        </Notice>
      ) : null}
      {result.status === 'failed' && !runState.inProgress ? (
        <Notice kind="error">
          {mashq.scoringFailed}
          {result.error ? ` (${result.error})` : ''} {rescoreButton}
        </Notice>
      ) : null}
      {result.quality === 'low' &&
      (result.coaching?.lowQualityReasons ?? ['evidence']).includes('evidence') ? (
        <Notice kind="warn">{mashq.qualityLowNotice}</Notice>
      ) : null}
      {result.quality === 'low' && result.coaching?.lowQualityReasons?.includes('language') ? (
        <Notice kind="warn">
          {mashq.qualityLanguageNotice} {rescoreButton}
        </Notice>
      ) : null}

      <RedLineViolations
        violations={result.coaching?.redLineViolations}
        onQuoteClick={jumpToTurn}
      />
      {result.quality === 'insufficient' ? (
        <Notice kind="warn">{mashq.qualityInsufficientNotice}</Notice>
      ) : null}

      <div className="mq-panel mq-score">
        <ScoreRing score={result.skillScore} />
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="mq-metrics">
            <Metric label={mashq.metricTurns} value={metrics?.sellerTurns ?? '—'} />
            <Metric
              label={mashq.metricObjections}
              value={
                metrics
                  ? `${metrics.objections.resolved.length}/${metrics.objections.raised.length} (${metrics.objections.planned})`
                  : '—'
              }
            />
            <Metric
              label={mashq.metricNeed}
              value={
                metrics?.needRevealed === null || metrics?.needRevealed === undefined
                  ? '—'
                  : metrics.needRevealed
                    ? mashq.metricNeedYes
                    : mashq.metricNeedNo
              }
            />
            <Metric label={mashq.metricDuration} value={formatDuration(metrics?.durationSec ?? null)} />
            <Metric
              label={mashq.metricWordShare}
              value={
                metrics ? `${Math.round(metrics.sellerWordShare * 100)}%` : '—'
              }
            />
          </div>
        </div>
      </div>

      {metrics && metrics.series.length > 1 ? (
        <>
          <h2 className="mq-h2">{mashq.stateChartTitle}</h2>
          <div className="mq-panel">
            <StateChart series={metrics.series} />
          </div>
        </>
      ) : null}

      <h2 className="mq-h2">{mashq.criteria}</h2>
      <div className="mq-panel">
        {result.criteria.length === 0 ? (
          <EmptyState>{mashq.noData}</EmptyState>
        ) : (
          <CriteriaList criteria={result.criteria} onQuoteClick={jumpToTurn} />
        )}
      </div>

      {result.coaching ? (
        <>
          <h2 className="mq-h2">{mashq.coaching}</h2>
          <CoachingCard coaching={result.coaching} onQuoteClick={jumpToTurn} />
        </>
      ) : null}

      {result.coaching?.scriptAdherence && result.coaching.scriptAdherence.length > 0 ? (
        <>
          <h2 className="mq-h2">{mashq.scriptTitle}</h2>
          <ScriptAdherence stages={result.coaching.scriptAdherence} onQuoteClick={jumpToTurn} />
        </>
      ) : null}

      {result.keyMoments.length > 0 ? (
        <>
          <h2 className="mq-h2">{mashq.keyMoments}</h2>
          <div className="mq-panel">
            <KeyMoments moments={result.keyMoments} onQuoteClick={jumpToTurn} />
          </div>
        </>
      ) : null}

      {revealed ? (
        <>
          <h2 className="mq-h2">{mashq.hiddenCards}</h2>
          <HiddenCards revealed={revealed} />
        </>
      ) : null}

      <h2 className="mq-h2">{mashq.transcript}</h2>
      <div className="mq-panel">
        <Transcript turns={transcript} highlightSeq={highlight} />
      </div>

      <div className="mq-btn-row" style={{ marginTop: 18 }}>
        <button
          type="button"
          className="mq-btn mq-btn-primary"
          onClick={() => onRetrySame(data.archetypeKey)}
        >
          {mashq.tryAgainSame}
        </button>
        <button type="button" className="mq-btn" onClick={onAnotherCustomer}>
          {mashq.tryAnother}
        </button>
        {result.status === 'done' ? rescoreButton : null}
        {result.model ? (
          <span className="mq-muted mq-small">
            {result.model} · {result.promptVersion} · v{result.version}
          </span>
        ) : null}
      </div>
    </div>
  );
}

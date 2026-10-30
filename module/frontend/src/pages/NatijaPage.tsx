/**
 * Natija (debrief) sahifasi: ball, o'lchovlar, grafik, mezonlar, maslahat,
 * muhim lahzalar, transkript va mijozning yashirin kartalari.
 *
 * Baholash fon rejimida ketadi, shuning uchun sahifa `pending` holatda
 * har 2 sekundda tekshiradi (chegara bilan — cheksiz poll qilmaydi).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { mashq } from '../lugat/mashq.js';
import type { ResultResponse, TrainingApi } from '../lib/api.js';
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
import { CoachingCard, KeyMoments } from '../components/Coaching.js';
import { HiddenCards } from '../components/HiddenCards.js';
import { StateChart } from '../components/StateChart.js';
import { Transcript } from '../components/Transcript.js';

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 45; // ~90 sekund

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
  const [data, setData] = useState<ResultResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [rescoring, setRescoring] = useState(false);
  const attempts = useRef(0);

  const load = useCallback(async (): Promise<'pending' | 'done' | 'missing'> => {
    try {
      const response = await api.getResult(sessionId);
      setData(response);
      setError(null);
      return response.result.status === 'pending' ? 'pending' : 'done';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Natija hali yaratilmagan bo'lishi mumkin (404) — kutamiz.
      if (message.includes('404') || message.toLowerCase().includes('not_found')) return 'missing';
      setError(message);
      return 'done';
    }
  }, [api, sessionId]);

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
  }, [load]);

  async function rescore(): Promise<void> {
    setRescoring(true);
    setTimedOut(false);
    try {
      await api.requestScore(sessionId);
      attempts.current = 0;
      window.setTimeout(() => void load(), POLL_INTERVAL_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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

  return (
    <div>
      <div className="mq-btn-row" style={{ justifyContent: 'space-between' }}>
        <h1 className="mq-h1">{mashq.resultTitle}</h1>
        <OutcomeBadge outcome={data.outcome} />
      </div>

      {result.status === 'pending' ? (
        <Notice kind="info">
          {mashq.scoring} {mashq.scoringHint}
        </Notice>
      ) : null}
      {result.status === 'failed' ? (
        <Notice kind="error">
          {mashq.scoringFailed}{' '}
          <button
            type="button"
            className="mq-btn mq-small"
            disabled={rescoring}
            onClick={() => void rescore()}
          >
            {mashq.scoreAgain}
          </button>
        </Notice>
      ) : null}
      {result.quality === 'low' ? <Notice kind="warn">{mashq.qualityLowNotice}</Notice> : null}
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
        {result.model ? (
          <span className="mq-muted mq-small">
            {result.model} · {result.promptVersion} · v{result.version}
          </span>
        ) : null}
      </div>
    </div>
  );
}

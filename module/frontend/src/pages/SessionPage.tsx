/** Jonli mashq sahifasi: suhbat, matn kiritish, ovoz sloti, tugatish. */
import { useEffect, useRef, useState } from 'react';

import { mashq } from '../lugat/mashq.js';
import { errorText } from '../lib/api-error.js';
import { usePresentation } from '../lib/presentation.js';
import type { SessionDetail, TranscriptTurn, TrainingApi, TurnResponse } from '../lib/api.js';
import { Notice, OutcomeBadge, Skeleton } from '../components/ui.js';
import { Transcript } from '../components/Transcript.js';
import { VoiceControls } from '../components/VoiceControls.js';

export interface SessionPageProps {
  api: TrainingApi;
  sessionId: string;
  /** Debug panelini ko'rsatish (harness; prod'da `false`). */
  debug?: boolean;
  /** Server ovozli navbatni yoqqanmi (`_harness` yoki host sozlamasi). */
  voiceEnabled?: boolean;
  onFinished: (sessionId: string) => void;
  onExit: () => void;
}

export function SessionPage({
  api,
  sessionId,
  debug = false,
  voiceEnabled = false,
  onFinished,
  onExit,
}: SessionPageProps): JSX.Element {
  const presentation = usePresentation();
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [turns, setTurns] = useState<TranscriptTurn[]>([]);
  const [turnCount, setTurnCount] = useState(0);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [ending, setEnding] = useState(false);
  const [ended, setEnded] = useState<{ outcome: string | null } | null>(null);
  const [lastDebug, setLastDebug] = useState<TurnResponse['debug'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const detail = await api.getSession(sessionId);
        if (cancelled) return;
        setSession(detail);
        setTurns(detail.transcript);
        setTurnCount(detail.turnCount);
        if (detail.status !== 'active') setEnded({ outcome: detail.outcome });
      } catch (err) {
        if (!cancelled) setError(errorText(err, presentation));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, sessionId]);

  async function send(): Promise<void> {
    const value = text.trim();
    if (value.length === 0 || sending || ended) return;

    setSending(true);
    setError(null);
    setText('');
    setTurns((previous) => [...previous, { speaker: 'seller', text: value }]);

    try {
      const result = await api.takeTurn(sessionId, value);
      setTurns((previous) => [...previous, { speaker: 'customer', text: result.customerReply }]);
      setLastDebug(result.debug ?? null);
      setTurnCount(result.turnCount);
      if (result.ended) setEnded({ outcome: result.outcome });
    } catch (err) {
      setError(errorText(err, presentation));
      setText(value); // matn yo'qolmasin
      setTurns((previous) => previous.slice(0, -1));
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  async function finish(): Promise<void> {
    setEnding(true);
    try {
      await api.endSession(sessionId, 'user_ended');
      onFinished(sessionId);
    } catch (err) {
      setError(errorText(err, presentation));
      setEnding(false);
    }
  }

  if (error && !session) {
    return (
      <div>
        <Notice kind="error">{error}</Notice>
        <button type="button" className="mq-btn" onClick={onExit}>
          {mashq.back}
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="mq-btn-row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1 className="mq-h1" style={{ marginBottom: 2 }}>
            {mashq.sessionTitle}
          </h1>
          {session ? (
            <p className="mq-sub" style={{ marginBottom: 0 }}>
              {session.persona.name}, {session.persona.age} — {session.persona.role}
              {' · '}
              <span className="mq-muted">
                {session.persona.direction === 'inbound'
                  ? mashq.directionInbound
                  : mashq.directionOutbound}
              </span>
            </p>
          ) : (
            <Skeleton height={18} width={240} />
          )}
        </div>
        <span className="mq-muted mq-small mq-mono">
          {mashq.turnCounter}: {turnCount}
        </span>
      </div>

      {error ? <Notice kind="error">{error}</Notice> : null}

      {ended ? (
        <Notice kind="info">
          {mashq.sessionEnded} · <OutcomeBadge outcome={ended.outcome} />{' '}
          <button
            type="button"
            className="mq-btn mq-btn-primary mq-small"
            style={{ marginLeft: 8 }}
            onClick={() => onFinished(sessionId)}
          >
            {mashq.seeResult}
          </button>
        </Notice>
      ) : null}

      <div className="mq-panel">
        <Transcript turns={turns} autoScroll pending={sending} />

        {!ended ? (
          <div className="mq-composer">
            <label className="mq-sr-only" htmlFor="mq-seller-input">
              {mashq.inputPlaceholder}
            </label>
            <textarea
              id="mq-seller-input"
              ref={inputRef}
              value={text}
              placeholder={mashq.inputPlaceholder}
              disabled={sending}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <button
              type="button"
              className="mq-btn mq-btn-primary"
              disabled={sending || text.trim().length === 0}
              onClick={() => void send()}
            >
              {sending ? mashq.sending : mashq.send}
            </button>
          </div>
        ) : null}
      </div>

      <VoiceControls
        sessionId={sessionId}
        api={api}
        disabled={Boolean(ended)}
        enabled={voiceEnabled}
        debug={debug && !presentation}
        reviewDefault={presentation}
        hasOpeningLine={session?.persona.direction === 'inbound'}
        events={{
          // Tanilgan matn darhol ko'rinadi — mijoz javobi kutilmaydi.
          onSellerText: (value) =>
            setTurns((previous) => [...previous, { speaker: 'seller', text: value }]),
          onCustomerTurn: (result) => {
            setTurns((previous) => [
              ...previous,
              { speaker: 'customer', text: result.customerText },
            ]);
            // "Takrorlaysizmi" navbat sanalmaydi — serverdagi 0 ni yozmaymiz.
            if (!result.needsRepeat) setTurnCount(result.turnCount);
            if (result.ended) setEnded({ outcome: result.outcome });
          },
        }}
      />

      {debug && !presentation && lastDebug?.state ? (
        <details className="mq-panel" style={{ marginTop: 12 }} open>
          <summary>{mashq.debugTitle}</summary>
          <div className="mq-metrics" style={{ marginTop: 10 }}>
            <div className="mq-metric">
              <span className="mq-metric-label">{mashq.chartPatience}</span>
              <span className="mq-metric-value">{lastDebug.state.patience}</span>
            </div>
            <div className="mq-metric">
              <span className="mq-metric-label">{mashq.chartTrust}</span>
              <span className="mq-metric-value">{lastDebug.state.trust}</span>
            </div>
            <div className="mq-metric">
              <span className="mq-metric-label">{mashq.chartInterest}</span>
              <span className="mq-metric-value">{lastDebug.state.interest}</span>
            </div>
          </div>
          <p className="mq-small" style={{ marginBottom: 4 }}>
            {mashq.readyToAgree}: {lastDebug.readiness?.readyToAgree ? 'ha' : "yo'q"}
            {typeof lastDebug.latencyMs === 'number' ? ` · ${lastDebug.latencyMs} ms` : ''}
            {lastDebug.intent ? ` · intent=${lastDebug.intent}` : ''}
          </p>
          {lastDebug.readiness && lastDebug.readiness.blockers.length > 0 ? (
            <>
              <span className="mq-muted mq-small">{mashq.blockers}:</span>
              <ul className="mq-list mq-small">
                {lastDebug.readiness.blockers.map((blocker, i) => (
                  <li key={i}>{blocker}</li>
                ))}
              </ul>
            </>
          ) : null}
        </details>
      ) : null}

      <div className="mq-btn-row" style={{ marginTop: 16 }}>
        {!ended ? (
          <button type="button" className="mq-btn" disabled={ending} onClick={() => void finish()}>
            {ending ? mashq.ending : mashq.endSession}
          </button>
        ) : null}
        <button type="button" className="mq-btn" onClick={onExit}>
          {mashq.back}
        </button>
      </div>
    </div>
  );
}

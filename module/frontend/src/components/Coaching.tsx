/** Maslahat kartasi va muhim lahzalar tasmasi. */
import { mashq } from '../lugat/mashq.js';
import type { ResultPayload } from '../lib/api.js';

export interface CoachingProps {
  coaching: ResultPayload['coaching'];
  onQuoteClick?: (turnSeq: number) => void;
}

export function CoachingCard({ coaching, onQuoteClick }: CoachingProps): JSX.Element | null {
  if (!coaching) return null;

  return (
    <div className="mq-panel">
      <p style={{ marginTop: 0 }}>{coaching.summary}</p>

      {coaching.strengths.length > 0 ? (
        <>
          <h3 className="mq-h2" style={{ marginTop: 12 }}>
            {mashq.strengths}
          </h3>
          <ul className="mq-list">
            {coaching.strengths.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </>
      ) : null}

      {coaching.improvements.length > 0 ? (
        <>
          <h3 className="mq-h2">{mashq.improvements}</h3>
          {coaching.improvements.map((item, i) => (
            <div className="mq-improvement" key={i}>
              <strong>
                {i + 1}. {item.title}
              </strong>
              <p className="mq-small" style={{ margin: '4px 0' }}>
                {item.why}
              </p>

              {item.evidenceQuote && item.evidenceTurnSeq !== null ? (
                <button
                  type="button"
                  className="mq-quote"
                  onClick={() => onQuoteClick?.(item.evidenceTurnSeq as number)}
                >
                  <span className="mq-muted mq-small">
                    {mashq.evidenceLabel} · T{item.evidenceTurnSeq}
                  </span>
                  <br />«{item.evidenceQuote}»
                </button>
              ) : null}

              <div className="mq-better">
                <span className="mq-muted mq-small">{mashq.betterPhrasing}:</span>
                <br />
                <span>«{item.betterPhrasing}»</span>
              </div>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}

/** Qizil chiziq buzilishlari — debrief TEPASIDA ko'rsatiladi. */
export function RedLineViolations({
  violations,
  onQuoteClick,
}: {
  violations: NonNullable<ResultPayload['coaching']>['redLineViolations'];
  onQuoteClick?: (turnSeq: number) => void;
}): JSX.Element | null {
  if (!violations || violations.length === 0) return null;

  return (
    <div className="mq-panel mq-redlines" role="alert">
      <h2 className="mq-h2" style={{ marginTop: 0 }}>
        {mashq.redLinesTitle} ({violations.length})
      </h2>
      <p className="mq-small mq-muted" style={{ marginTop: 0 }}>
        {mashq.redLinesHint}
      </p>
      {violations.map((v, i) => (
        <div className="mq-improvement" key={i}>
          <strong>
            {mashq.redLineRule}: {v.rule}
          </strong>
          <p className="mq-small" style={{ margin: '4px 0' }}>
            {v.explanation}
          </p>
          <button type="button" className="mq-quote" onClick={() => onQuoteClick?.(v.evidenceTurnSeq)}>
            <span className="mq-muted mq-small">
              {mashq.evidenceLabel} · T{v.evidenceTurnSeq}
            </span>
            <br />«{v.evidenceQuote}»
          </button>
        </div>
      ))}
    </div>
  );
}

const STAGE_LABEL = {
  followed: mashq.scriptFollowed,
  partly: mashq.scriptPartly,
  missed: mashq.scriptMissed,
} as const;

/** "Skriptga moslik": har bosqich — holat, izoh va (bo'lsa) tekshirilgan iqtibos. */
export function ScriptAdherence({
  stages,
  onQuoteClick,
}: {
  stages: NonNullable<ResultPayload['coaching']>['scriptAdherence'];
  onQuoteClick?: (turnSeq: number) => void;
}): JSX.Element | null {
  if (!stages || stages.length === 0) return null;

  return (
    <div className="mq-panel">
      {stages.map((stage, i) => (
        <div className="mq-script-stage" key={`${i}-${stage.stage}`}>
          <div className="mq-btn-row" style={{ justifyContent: 'space-between' }}>
            <strong>
              {i + 1}. {stage.stage}
            </strong>
            <span className={`mq-stage-status mq-stage-${stage.status ?? 'unknown'}`}>
              {stage.status ? STAGE_LABEL[stage.status] : mashq.scriptUnknown}
            </span>
          </div>
          <p className="mq-small" style={{ margin: '4px 0' }}>
            {stage.comment}
          </p>
          {stage.evidenceQuote && stage.evidenceTurnSeq !== null ? (
            <button
              type="button"
              className="mq-quote"
              onClick={() => onQuoteClick?.(stage.evidenceTurnSeq as number)}
            >
              <span className="mq-muted mq-small">
                {mashq.evidenceLabel} · T{stage.evidenceTurnSeq}
              </span>
              <br />«{stage.evidenceQuote}»
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function KeyMoments({
  moments,
  onQuoteClick,
}: {
  moments: ResultPayload['keyMoments'];
  onQuoteClick?: (turnSeq: number) => void;
}): JSX.Element | null {
  if (moments.length === 0) return null;

  return (
    <ol className="mq-list" style={{ paddingLeft: 0, listStyle: 'none' }}>
      {moments.map((moment) => (
        <li key={`${moment.turnSeq}-${moment.kind}`} style={{ marginBottom: 8 }}>
          <button
            type="button"
            className="mq-quote"
            onClick={() => onQuoteClick?.(moment.turnSeq)}
          >
            <span className="mq-muted mq-small">
              T{moment.turnSeq} · {moment.kind}
            </span>
            <br />
            {moment.explanation}
          </button>
        </li>
      ))}
    </ol>
  );
}

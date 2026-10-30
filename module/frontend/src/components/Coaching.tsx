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

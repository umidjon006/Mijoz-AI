/** Mezonlar bo'yicha baho + dalil iqtiboslari. */
import { mashq } from '../lugat/mashq.js';
import type { CriterionView } from '../lib/api.js';
import { ScoreBar } from './ui.js';

export interface CriteriaListProps {
  criteria: CriterionView[];
  /** Iqtibosga bosilganda transkriptdagi navbatga sakrash. */
  onQuoteClick?: (turnSeq: number) => void;
}

export function CriteriaList({ criteria, onQuoteClick }: CriteriaListProps): JSX.Element {
  if (criteria.length === 0) {
    return <div className="mq-empty">{mashq.noData}</div>;
  }

  return (
    <div>
      {criteria.map((criterion) => (
        <div className="mq-criterion" key={criterion.code}>
          <div className="mq-criterion-head">
            <span className="mq-criterion-name">{criterion.name}</span>
            <span className="mq-criterion-score mq-mono">
              {criterion.score === null ? (
                <span className="mq-muted mq-small">{mashq.criterionNotScored}</span>
              ) : (
                `${criterion.score} / 3`
              )}
              <span className="mq-muted mq-small">
                {' '}
                ({mashq.weight} {criterion.weight})
              </span>
            </span>
          </div>

          {criterion.score !== null ? <ScoreBar score={criterion.score} /> : null}

          <p className="mq-small" style={{ margin: '4px 0 0' }}>
            {criterion.comment}
          </p>

          {criterion.evidenceQuote && criterion.evidenceTurnSeq !== null ? (
            <button
              type="button"
              className="mq-quote"
              onClick={() => onQuoteClick?.(criterion.evidenceTurnSeq as number)}
              title={`T${criterion.evidenceTurnSeq}`}
            >
              <span className="mq-muted mq-small">
                {mashq.evidenceLabel} · T{criterion.evidenceTurnSeq}
              </span>
              <br />
              «{criterion.evidenceQuote}»
            </button>
          ) : null}

          {criterion.rejectedQuote ? (
            <div className="mq-quote mq-quote-rejected mq-small">
              {mashq.evidenceRejected}
              <br />
              <span className="mq-muted">«{criterion.rejectedQuote}»</span>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

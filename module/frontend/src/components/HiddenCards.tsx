/**
 * "Mijozning yashirin kartalari" — suhbat davomida sotuvchidan yashirilgan
 * ma'lumot. Faqat sessiya TUGAGANDAN keyin ko'rsatiladi (server ham shunday
 * yuboradi: tugamagan sessiyada `revealed` null bo'ladi).
 */
import { mashq } from '../lugat/mashq.js';
import type { RevealedPersona } from '../lib/api.js';

export function HiddenCards({ revealed }: { revealed: RevealedPersona | null }): JSX.Element | null {
  if (!revealed) return null;

  return (
    <div className="mq-panel">
      <p className="mq-small mq-muted" style={{ marginTop: 0 }}>
        {mashq.hiddenCardsHint}
      </p>

      {revealed.hiddenNeed ? (
        <div className="mq-improvement">
          <strong>{mashq.hiddenNeed}</strong>
          <p style={{ margin: '4px 0 0' }}>{revealed.hiddenNeed}</p>
        </div>
      ) : null}

      <div className="mq-metrics" style={{ marginBottom: 12 }}>
        <div className="mq-metric">
          <span className="mq-metric-label">{mashq.situation}</span>
          <span className="mq-small">{revealed.situation}</span>
        </div>
        <div className="mq-metric">
          <span className="mq-metric-label">{mashq.goal}</span>
          <span className="mq-small">{revealed.goal}</span>
        </div>
        <div className="mq-metric">
          <span className="mq-metric-label">{mashq.focusOffer}</span>
          <span className="mq-small">{revealed.focusOffer}</span>
        </div>
      </div>

      {revealed.hiddenFacts.length > 0 ? (
        <>
          <h3 className="mq-h2">{mashq.hiddenFacts}</h3>
          <ul className="mq-list">
            {revealed.hiddenFacts.map((fact, i) => (
              <li key={i}>{fact}</li>
            ))}
          </ul>
        </>
      ) : null}

      <h3 className="mq-h2">{mashq.objectionPlan}</h3>
      <table className="mq-table">
        <thead>
          <tr>
            <th scope="col">{mashq.objectionPlan}</th>
            <th scope="col">#</th>
            <th scope="col">{mashq.outcome}</th>
          </tr>
        </thead>
        <tbody>
          {revealed.objections.map((objection) => (
            <tr key={objection.key}>
              <td>{objection.text}</td>
              <td className="mq-mono">{objection.severity}</td>
              <td className="mq-small">
                {objection.raised ? mashq.objectionRaised : mashq.objectionNotRaised}
                {' · '}
                <span style={{ color: objection.resolved ? 'var(--mq-ok)' : 'var(--mq-bad)' }}>
                  {objection.resolved ? mashq.objectionResolved : mashq.objectionUnresolved}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Suhbat matni. Natija sahifasida dalil iqtibosiga bosilsa, shu komponent
 * kerakli navbatga "sakraydi" va uni belgilab qo'yadi.
 */
import { useEffect, useRef } from 'react';

import { mashq } from '../lugat/mashq.js';
import type { TranscriptTurn } from '../lib/api.js';

export interface TranscriptProps {
  turns: TranscriptTurn[];
  /** Belgilab ko'rsatiladigan navbat (1 dan boshlanadigan `seq`). */
  highlightSeq?: number | null;
  /** Oxirgi navbatga avtomatik sakrash (jonli sessiyada). */
  autoScroll?: boolean;
  /** Mijoz javobi kutilyaptimi. */
  pending?: boolean;
}

export function Transcript({
  turns,
  highlightSeq = null,
  autoScroll = false,
  pending = false,
}: TranscriptProps): JSX.Element {
  const endRef = useRef<HTMLDivElement | null>(null);
  const highlightRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (autoScroll) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns.length, pending, autoScroll]);

  useEffect(() => {
    if (highlightSeq !== null) {
      highlightRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlightSeq]);

  return (
    <div className="mq-chat">
      {turns.length === 0 && !pending ? (
        <div className="mq-empty">{mashq.noData}</div>
      ) : null}

      {turns.map((turn, index) => {
        const seq = index + 1;
        const isHighlighted = highlightSeq === seq;
        return (
          <div
            key={seq}
            id={`mq-turn-${seq}`}
            ref={isHighlighted ? highlightRef : undefined}
            className={
              `mq-turn ${turn.speaker === 'seller' ? 'mq-turn-seller' : 'mq-turn-customer'}` +
              (isHighlighted ? ' mq-highlight' : '')
            }
          >
            <span className="mq-turn-label">
              {turn.speaker === 'seller' ? mashq.you : mashq.customer} · T{seq}
            </span>
            {turn.text}
          </div>
        );
      })}

      {pending ? (
        <div className="mq-turn mq-turn-customer mq-muted" aria-live="polite">
          {mashq.customerThinking}
        </div>
      ) : null}

      <div ref={endRef} />
    </div>
  );
}

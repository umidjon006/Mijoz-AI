/**
 * Ovozli boshqaruv uchun SLOT.
 *
 * HOLAT: Step 3 Phase B (takeVoiceTurn, /voice-turn route, WAV recorder)
 * hali bajarilmagan, shuning uchun bu komponent hozircha faqat eslatma
 * ko'rsatadi va matnli rejim ishlayverishiga xalaqit bermaydi.
 *
 * TODO (Step 3 Phase B tugagach):
 *   - `useWavRecorder` hook: 16 kHz mono 16-bit PCM WAV, brauzerda
 *     (harness/web/record.html dagi mantiqni tiplangan hook'ga ko'chirish);
 *   - bosib turish (hold-to-talk) tugmasi + BO'SHLIQ tugmasi;
 *   - mikrofon darajasi ko'rsatkichi va "quloqchin kiyib oling" eslatmasi;
 *   - `POST /sessions/:id/voice-turn` -> tanilgan matnni darhol ko'rsatish,
 *     mijoz audiosini ijro etish, `needsRepeat` bo'lsa "qaytaring" holati;
 *   - debug rejimida bosqichlar vaqti (sttMs / llmMs / ttsMs).
 */
import { mashq } from '../lugat/mashq.js';

export interface VoiceControlsProps {
  sessionId: string;
  disabled?: boolean;
  /** Step 3B ulangach `true` bo'ladi. */
  enabled?: boolean;
}

export function VoiceControls({ enabled = false }: VoiceControlsProps): JSX.Element | null {
  if (enabled) {
    // Step 3B ulanganda shu yerda haqiqiy boshqaruv bo'ladi.
    return null;
  }

  return (
    <details className="mq-panel" style={{ marginTop: 12 }}>
      <summary>{mashq.voiceSlotTitle}</summary>
      <p className="mq-small mq-muted" style={{ marginBottom: 0 }}>
        {mashq.voiceSlotPending}
      </p>
    </details>
  );
}

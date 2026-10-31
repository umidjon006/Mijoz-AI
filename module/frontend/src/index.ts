/**
 * Modul frontend'ining ommaviy eksportlari.
 * Integratsiyada teammate'lar shu fayldan import qiladi.
 *
 * Uslublar: `styles.css` ni bir marta import qiling (yoki o'z uslublaringizga
 * moslashtiring) — hamma klass `mq-` prefiksi bilan.
 */
export { TrainingApp } from './TrainingApp.js';
export type { TrainingAppProps, TrainingView } from './TrainingApp.js';

export { MashqPage } from './pages/MashqPage.js';
export { SessionPage } from './pages/SessionPage.js';
export { NatijaPage } from './pages/NatijaPage.js';
export { TarixPage } from './pages/TarixPage.js';

export { createTrainingApi } from './lib/api.js';
export type {
  ApiRequest,
  ApiRequestInit,
  TrainingApi,
  ArchetypeInfo,
  SessionDetail,
  SessionListItem,
  ResultResponse,
  ResultPayload,
  RevealedPersona,
  StatsResponse,
  TranscriptTurn,
  VoiceTurnResponse,
  OpeningAudioResponse,
} from './lib/api.js';

export { mashq, outcomeLabel, keyMomentLabel } from './lugat/mashq.js';
export type { MashqStrings } from './lugat/mashq.js';

export { Transcript } from './components/Transcript.js';
export { CriteriaList } from './components/CriteriaList.js';
export { CoachingCard, KeyMoments } from './components/Coaching.js';
export { HiddenCards } from './components/HiddenCards.js';
export { StateChart } from './components/StateChart.js';
export { VoiceControls } from './components/VoiceControls.js';
export type { VoiceControlsProps, VoiceTurnEvents } from './components/VoiceControls.js';
export { useWavRecorder, encodeWav, WAV_SAMPLE_RATE } from './lib/useWavRecorder.js';
export type { WavRecorder, UseWavRecorderOptions } from './lib/useWavRecorder.js';
export { ScoreRing, OutcomeBadge, Notice, EmptyState, Metric } from './components/ui.js';

/**
 * Tiplangan API klient.
 *
 * MUHIM: bu fayl `fetch` ni O'ZI chaqirmaydi. So'rov yuboruvchi funksiya
 * TASHQARIDAN beriladi — integratsiyada teammate'lar asosiy repodagi
 * `frontend/src/api.ts` (auth header, baseURL, xato formatini biladi) ni
 * shu chokka ulaydi.
 *
 *   const api = createTrainingApi(request);
 */

export interface ApiRequestInit {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
  /**
   * XOM tana (ovozli navbat: `audio/wav`). `body` bilan birga berilmaydi.
   * Host so'rov yuboruvchisi buni JSON qilib o'ramasdan, `contentType` bilan
   * shundayligicha yuborishi kerak.
   */
  rawBody?: Blob | ArrayBuffer;
  contentType?: string;
}

/** Host ilovaning so'rov yuboruvchisi. Xato bo'lsa throw qilishi kutiladi. */
export type ApiRequest = <T>(path: string, init?: ApiRequestInit) => Promise<T>;

// --- Server javoblari ------------------------------------------------------
export interface ArchetypeInfo {
  key: string;
  title: string;
  description: string;
  difficulty: number;
  intent: 'wants_to_buy' | 'just_info';
  maxTurns: number;
}

export interface PersonaSummary {
  name: string;
  age: number;
  role: string;
  direction: 'inbound' | 'outbound';
  openingLine: string | null;
}

export interface StartSessionResponse {
  sessionId: string;
  archetype: { key: string; title: string; difficulty: number; maxTurns: number };
  persona: PersonaSummary;
  openingLine: string | null;
}

export interface TranscriptTurn {
  speaker: 'seller' | 'customer';
  text: string;
}

export interface RevealedObjection {
  key: string;
  text: string;
  severity: number;
  raised: boolean;
  resolved: boolean;
}

export interface RevealedPersona {
  name: string;
  role: string;
  situation: string;
  goal: string;
  focusOffer: string;
  hiddenNeed: string | null;
  hiddenFacts: string[];
  objections: RevealedObjection[];
}

export interface SessionDetail {
  sessionId: string;
  archetypeKey: string;
  status: string;
  outcome: string | null;
  endReason: string | null;
  turnCount: number;
  transcript: TranscriptTurn[];
  persona: PersonaSummary;
  revealed: RevealedPersona | null;
  debug?: unknown;
}

export interface TurnResponse {
  customerReply: string;
  ended: boolean;
  outcome: string | null;
  endReason: string | null;
  turnCount: number;
  debug?: {
    state?: {
      patience: number;
      trust: number;
      interest: number;
      flags: { guardViolations: number; needRevealed: boolean };
    };
    readiness?: { readyToAgree: boolean; blockers: string[] };
    intent?: string;
    latencyMs?: number;
  };
}

/** Ovozli navbat javobi. `audio` — base64; hech qayerda saqlanmaydi. */
export interface VoiceTurnResponse {
  sellerText: string;
  customerText: string;
  tone: string;
  audio: string;
  audioMime: string;
  /**
   * Oqimli TTS: mijoz audiosi shu URL'dan (bir marta, ~60 s ichida) keladi va
   * birinchi bo'lak kelishi bilan ijro etiladi; `audio` bo'sh bo'ladi.
   */
  audioStreamUrl?: string;
  /** `true` — nutq tanilmadi: holat o'zgarmadi, navbat sanalmadi. */
  needsRepeat: boolean;
  ended: boolean;
  outcome: string | null;
  endReason: string | null;
  turnCount: number;
  debug?: {
    timings?: { sttMs: number; llmMs: number; ttsMs: number; totalMs: number; ttsStreamed?: boolean };
    costUsd?: number;
  };
}

/** Tekshirish rejimi, 1-qadam: tanilgan matn (javob hali so'ralmagan). */
export interface VoiceTranscriptionResponse {
  transcriptId: string;
  sttText: string;
  recognized: boolean;
  rejected?: 'too_short' | 'empty' | 'foreign_language';
  debug?: { sttMs?: number; durationSec?: number };
}

/** `inbound` sessiyada mijozning birinchi gapi (ovozda). */
export interface OpeningAudioResponse {
  text: string;
  tone: string;
  audio: string;
  audioMime: string;
  debug?: { ttsMs?: number; costUsd?: number };
}

export interface StatePoint {
  turnSeq: number;
  patience: number;
  trust: number;
  interest: number;
}

export interface SessionMetricsView {
  outcome: string | null;
  endReason: string | null;
  sellerTurns: number;
  customerTurns: number;
  sellerWordShare: number;
  avgSellerTurnWords: number;
  durationSec: number | null;
  series: StatePoint[];
  objections: { planned: number; raised: string[]; resolved: string[]; unresolved: string[] };
  needRevealed: boolean | null;
  guardViolations: number;
  voiceRepeatRequests?: number;
}

export interface CriterionView {
  code: string;
  name: string;
  weight: number;
  score: 0 | 1 | 2 | 3 | null;
  comment: string;
  evidenceQuote: string | null;
  evidenceTurnSeq: number | null;
  rejectedQuote?: string | null;
  rejectReason?: string | null;
}

export interface ImprovementView {
  title: string;
  why: string;
  betterPhrasing: string;
  evidenceQuote: string | null;
  evidenceTurnSeq: number | null;
}

export interface RedLineViolationView {
  rule: string;
  explanation: string;
  evidenceQuote: string;
  evidenceTurnSeq: number;
}

export interface ScriptStageView {
  stage: string;
  status: 'followed' | 'partly' | 'missed' | null;
  comment: string;
  evidenceQuote: string | null;
  evidenceTurnSeq: number | null;
}

export interface ResultPayload {
  version: number;
  status: 'pending' | 'done' | 'failed';
  quality: 'ok' | 'low' | 'insufficient';
  skillScore: number | null;
  criteria: CriterionView[];
  metrics: SessionMetricsView | null;
  coaching: {
    summary: string;
    strengths: string[];
    improvements: ImprovementView[];
    /** Eski natijalarda yo'q. */
    redLineViolations?: RedLineViolationView[];
    /** Skript bo'lmasa `null`/yo'q. */
    scriptAdherence?: ScriptStageView[] | null;
    /** Til tekshiruvi: yashirilgan maydonlar o'rnida "Bu qism to'g'ri tilda yaratilmadi". */
    languageCheck?: { transliterated: number; regenerated: number; hidden: string[] };
    lowQualityReasons?: Array<'evidence' | 'language'>;
  } | null;
  keyMoments: Array<{ turnSeq: number; kind: string; explanation: string }>;
  model: string | null;
  promptVersion: string | null;
  error: string | null;
  createdAt: string;
}

export interface LatestRunView {
  version: number;
  status: 'pending' | 'done' | 'failed';
  error: string | null;
  createdAt: string;
}

export interface ResultResponse {
  sessionId: string;
  archetypeKey: string;
  outcome: string | null;
  endReason: string | null;
  transcript: TranscriptTurn[];
  /** Oxirgi TUGALLANGAN natija (bo'lmasa oxirgi run). */
  result: ResultPayload;
  /** Oxirgi run holati (qayta baholash ketayotganini shu ko'rsatadi). */
  latestRun?: LatestRunView | null;
  revealed: RevealedPersona | null;
}

export interface ScoreRequestResponse {
  status: 'pending';
  /** Ketayotgan run versiyasi (yangi yoki allaqachon ketayotgan). */
  version: number;
  /** `true` — yangi run boshlanmadi, mavjudi davom etmoqda. */
  alreadyRunning: boolean;
}

export interface SessionListItem {
  id: string;
  archetypeKey: string;
  status: string;
  outcome: string | null;
  endReason: string | null;
  turnCount: number;
  startedAt: string;
  endedAt: string | null;
  skillScore: number | null;
  resultStatus: string | null;
  resultQuality: string | null;
}

export interface StatsResponse {
  userId: string;
  totalSessions: number;
  endedSessions: number;
  winRateByArchetype: Array<{
    archetypeKey: string;
    total: number;
    won: number;
    winRate: number | null;
  }>;
  skillScoreTrend: Array<{ sessionId: string; startedAt: string; skillScore: number }>;
  avgSkillScore: number | null;
  weakestCriteria: Array<{ code: string; name: string; avgScore: number; samples: number }>;
}

export interface TrainingApi {
  listArchetypes(): Promise<ArchetypeInfo[]>;
  startSession(input: {
    archetypeKey: string;
    direction?: 'inbound' | 'outbound';
  }): Promise<StartSessionResponse>;
  getSession(sessionId: string): Promise<SessionDetail>;
  listSessions(): Promise<SessionListItem[]>;
  takeTurn(sessionId: string, text: string): Promise<TurnResponse>;
  /** Ovozli navbat: 16 kHz mono 16-bit PCM WAV. */
  takeVoiceTurn(sessionId: string, wav: Blob): Promise<VoiceTurnResponse>;
  /** Tekshirish rejimi: faqat STT (mijoz hali javob bermaydi). */
  transcribeVoice(sessionId: string, wav: Blob): Promise<VoiceTranscriptionResponse>;
  /** Tekshirish rejimi: tasdiqlangan (tahrirlangan bo'lishi mumkin) matn bilan javob. */
  voiceReply(sessionId: string, input: { transcriptId: string; text: string }): Promise<VoiceTurnResponse>;
  /** `inbound` bo'lmasa yoki ovoz o'chiq bo'lsa `null`. */
  openingAudio(sessionId: string): Promise<OpeningAudioResponse | null>;
  endSession(sessionId: string, reason?: string): Promise<void>;
  requestScore(sessionId: string): Promise<ScoreRequestResponse>;
  getResult(sessionId: string): Promise<ResultResponse>;
  myStats(): Promise<StatsResponse>;
  userStats(userId: string): Promise<StatsResponse>;
}

/** Prefiks host tomonda ham o'zgarishi mumkin, shuning uchun parametr. */
export function createTrainingApi(request: ApiRequest, prefix = '/api/v1/training'): TrainingApi {
  return {
    async listArchetypes() {
      const res = await request<{ archetypes: ArchetypeInfo[] }>(`${prefix}/archetypes`);
      return res.archetypes;
    },
    startSession(input) {
      return request<StartSessionResponse>(`${prefix}/sessions`, {
        method: 'POST',
        body: input,
      });
    },
    getSession(sessionId) {
      return request<SessionDetail>(`${prefix}/sessions/${sessionId}`);
    },
    async listSessions() {
      const res = await request<{ sessions: SessionListItem[] }>(`${prefix}/sessions`);
      return res.sessions;
    },
    takeTurn(sessionId, text) {
      return request<TurnResponse>(`${prefix}/sessions/${sessionId}/turn`, {
        method: 'POST',
        body: { text },
      });
    },
    takeVoiceTurn(sessionId, wav) {
      return request<VoiceTurnResponse>(`${prefix}/sessions/${sessionId}/voice-turn`, {
        method: 'POST',
        rawBody: wav,
        contentType: 'audio/wav',
      });
    },
    transcribeVoice(sessionId, wav) {
      return request<VoiceTranscriptionResponse>(`${prefix}/sessions/${sessionId}/voice-transcribe`, {
        method: 'POST',
        rawBody: wav,
        contentType: 'audio/wav',
      });
    },
    voiceReply(sessionId, input) {
      return request<VoiceTurnResponse>(`${prefix}/sessions/${sessionId}/voice-reply`, {
        method: 'POST',
        body: input,
      });
    },
    async openingAudio(sessionId) {
      const res = await request<OpeningAudioResponse | undefined>(
        `${prefix}/sessions/${sessionId}/opening-audio`,
        { method: 'POST' },
      );
      return res ?? null;
    },
    async endSession(sessionId, reason) {
      await request(`${prefix}/sessions/${sessionId}/end`, {
        method: 'POST',
        body: reason ? { reason } : {},
      });
    },
    requestScore(sessionId) {
      return request<ScoreRequestResponse>(`${prefix}/sessions/${sessionId}/score`, {
        method: 'POST',
        body: {},
      });
    },
    getResult(sessionId) {
      return request<ResultResponse>(`${prefix}/sessions/${sessionId}/result`);
    },
    myStats() {
      return request<StatsResponse>(`${prefix}/me/stats`);
    },
    userStats(userId) {
      return request<StatsResponse>(`${prefix}/stats?userId=${encodeURIComponent(userId)}`);
    },
  };
}

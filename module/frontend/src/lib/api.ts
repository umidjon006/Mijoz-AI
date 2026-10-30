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

export interface ResultPayload {
  version: number;
  status: 'pending' | 'done' | 'failed';
  quality: 'ok' | 'low' | 'insufficient';
  skillScore: number | null;
  criteria: CriterionView[];
  metrics: SessionMetricsView | null;
  coaching: { summary: string; strengths: string[]; improvements: ImprovementView[] } | null;
  keyMoments: Array<{ turnSeq: number; kind: string; explanation: string }>;
  model: string | null;
  promptVersion: string | null;
  error: string | null;
  createdAt: string;
}

export interface ResultResponse {
  sessionId: string;
  archetypeKey: string;
  outcome: string | null;
  endReason: string | null;
  transcript: TranscriptTurn[];
  result: ResultPayload;
  revealed: RevealedPersona | null;
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
  endSession(sessionId: string, reason?: string): Promise<void>;
  requestScore(sessionId: string): Promise<void>;
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
    async endSession(sessionId, reason) {
      await request(`${prefix}/sessions/${sessionId}/end`, {
        method: 'POST',
        body: reason ? { reason } : {},
      });
    },
    async requestScore(sessionId) {
      await request(`${prefix}/sessions/${sessionId}/score`, { method: 'POST', body: {} });
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

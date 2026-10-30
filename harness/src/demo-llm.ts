/**
 * FAQAT HARNESS. Kalitsiz (ANTHROPIC_API_KEY yo'q) holatda UI ni sinash
 * uchun "demo" LLM. Haqiqiy model emas, hech qanday provayderga ulanmaydi:
 * promptdan kerakli ma'lumotni o'qib, mos shakldagi javob yasaydi.
 *
 * Nega kerak: frontend va baholash oqimini pul sarflamasdan, kalitsiz
 * sinab ko'rish mumkin bo'lsin. Javoblar sodda, lekin SHAKLI to'g'ri va
 * dalil iqtiboslari HAQIQIY transkriptdan olinadi (shuning uchun dalil
 * tekshiruvidan o'tadi).
 */
import type {
  TokenUsage,
  TrainerLlm,
  TrainerLlmRequest,
} from '../../module/backend/src/training/ports.js';
import type { BusinessProfile } from '../../module/backend/src/training/profile-schema.js';

const CUSTOMER_REPLIES = [
  'Qiziq, lekin menga hali to\'liq tushunarli emas.',
  'Yaxshi, davom eting, eshitaman.',
  'Buni biroz aniqroq aytib bering.',
  'Tushundim, yana nima deysiz?',
];

/** System promptdan e'tiroz kalitlari va holatini o'qiydi. */
function parseObjections(system: string): Array<{ key: string; status: string; text: string }> {
  const out: Array<{ key: string; status: string; text: string }> = [];
  const re = /key="([a-z0-9_]+)" severity=\d+ \[([^\]]+)\]: (.*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(system)) !== null) {
    out.push({ key: match[1] as string, status: match[2] as string, text: (match[3] ?? '').trim() });
  }
  return out;
}

function canAgree(system: string): boolean {
  return system.includes('You MAY agree now');
}

/** User promptdagi `[T<seq>] SELLER: ...` qatorlarini ajratadi. */
function parseSellerTurns(user: string): Array<{ seq: number; text: string }> {
  const out: Array<{ seq: number; text: string }> = [];
  for (const line of user.split('\n')) {
    const match = /^\[T(\d+)\] SELLER: (.*)$/.exec(line);
    if (match) out.push({ seq: Number(match[1]), text: (match[2] ?? '').trim() });
  }
  return out;
}

/** Iqtibos uchun: matndan 4-6 so'zli bo'lak (>= 12 belgi). */
function quoteFrom(text: string): string {
  const words = text.trim().split(/\s+/);
  for (let count = 4; count <= Math.min(8, words.length); count += 1) {
    const candidate = words.slice(0, count).join(' ');
    if (candidate.length >= 14) return candidate;
  }
  return words.slice(0, Math.min(6, words.length)).join(' ');
}

function personaFor(profile: BusinessProfile, system: string, user: string): unknown {
  const offer = profile.primaryOffers[0] ?? 'Asosiy taklif';
  const countMatch = /Create exactly (\d+) objection/.exec(system);
  const count = countMatch ? Number(countMatch[1]) : 1;
  const severityMatch = /severity is 1\.\.(\d+)/.exec(system);
  const severityMax = severityMatch ? Number(severityMatch[1]) : 3;
  const needsHidden = system.includes('"hiddenNeed" MUST be a non-empty string');
  // direction va language USER promptda beriladi (system'da emas).
  const direction = /direction: "(inbound|outbound)"/.exec(user)?.[1] ?? 'inbound';
  const language = /language: "(uz|ru|mixed)"/.exec(user)?.[1] ?? 'uz';

  const source = profile.commonObjections.length > 0 ? profile.commonObjections : ['Narxi qimmat'];
  const objections = Array.from({ length: count }, (_, i) => ({
    key: `demo_objection_${i + 1}`,
    text: source[i % source.length] as string,
    severity: Math.min(2, severityMax),
  }));

  return {
    name: 'Dilnoza Karimova',
    age: 32,
    role: 'Ofis xodimi',
    speakingStyle: 'Qisqa gapiradi, aniq javob kutadi',
    language,
    direction,
    situation: 'Vaqti kam, kechqurun bo\'sh bo\'ladi',
    goal: profile.customerProblem,
    focusOffer: offer,
    objections,
    hiddenFacts: ['Oldin boshqa joyda ko\'ngli qolgan'],
    hiddenNeed: needsHidden ? profile.customerProblem : null,
    openingLine: 'Assalomu alaykum, shartlaringizni bilmoqchi edim.',
  };
}

function turnFor(system: string, user: string): unknown {
  const objections = parseObjections(system);
  const pending = objections.find((o) => o.status.includes('raised, still not answered'));
  const notRaised = objections.find((o) => o.status.includes('not raised yet'));
  const sellerLines = parseSellerTurns(user);
  const lastSeller = user.split('## The seller just said')[1] ?? '';
  const sellerLength = lastSeller.trim().split(/\s+/).length;

  // Uzun va mazmunli javob bo'lsa — javobsiz e'tirozni yechilgan deb belgilaymiz.
  if (pending && sellerLength >= 6) {
    return {
      reply: 'Mana bu javob menga ma\'qul, rahmat.',
      intent: 'continue',
      deltas: { patience: 1, trust: 8, interest: 3 },
      objectionRaisedKey: null,
      objectionsResolvedKeys: [pending.key],
      needRevealed: system.includes('hidden') && sellerLength >= 10,
      nextStep: null,
    };
  }

  if (notRaised) {
    return {
      reply: notRaised.text,
      intent: 'continue',
      deltas: { patience: -2, trust: 0, interest: 2 },
      objectionRaisedKey: notRaised.key,
      objectionsResolvedKeys: [],
      needRevealed: false,
      nextStep: null,
    };
  }

  if (canAgree(system)) {
    return {
      reply: 'Mayli, kelishdik. Keyingi qadamni aytasizmi?',
      intent: 'agrees',
      deltas: { patience: 0, trust: 5, interest: 3 },
      objectionRaisedKey: null,
      objectionsResolvedKeys: [],
      needRevealed: false,
      nextStep: null,
    };
  }

  return {
    reply: CUSTOMER_REPLIES[sellerLines.length % CUSTOMER_REPLIES.length] as string,
    intent: 'continue',
    deltas: { patience: -1, trust: 1, interest: 1 },
    objectionRaisedKey: null,
    objectionsResolvedKeys: [],
    needRevealed: false,
    nextStep: null,
  };
}

function scoringFor(system: string, user: string): unknown {
  const codes = [...system.matchAll(/^### ([a-z0-9_]+) — /gm)].map((m) => m[1] as string);
  const sellerTurns = parseSellerTurns(user);
  const pick = (index: number): { quote: string | null; seq: number | null } => {
    const turn = sellerTurns[index % Math.max(1, sellerTurns.length)];
    if (!turn) return { quote: null, seq: null };
    return { quote: quoteFrom(turn.text), seq: turn.seq };
  };

  return {
    criteria: codes.map((code, i) => {
      const evidence = pick(i);
      return {
        code,
        score: evidence.quote ? ((i % 3) + 1) : null,
        evidenceQuote: evidence.quote,
        evidenceTurnSeq: evidence.seq,
        comment:
          'Demo baholash: bu izoh haqiqiy model emas, shakli to\'g\'ri bo\'lishi uchun yozilgan.',
      };
    }),
    coaching: {
      summary:
        'Demo xulosa: suhbat yozib olindi va shakl bo\'yicha baholandi. Haqiqiy maslahat uchun ANTHROPIC_API_KEY ni qo\'ying.',
      strengths: sellerTurns.length > 0 ? ['Suhbatni boshlab berdingiz'] : [],
      improvements:
        sellerTurns.length > 0
          ? [
              {
                title: 'Ehtiyojni aniqroq so\'rang',
                why: 'Mijozning asl sababi ochilmadi',
                evidenceQuote: pick(0).quote,
                evidenceTurnSeq: pick(0).seq,
                betterPhrasing: 'Buni hozir nega hal qilmoqchisiz, nima o\'zgardi?',
              },
            ]
          : [],
    },
    keyMoments: [],
  };
}

export interface DemoLlmOptions {
  profile: BusinessProfile;
}

/** Demo LLM: shakli to'g'ri, mazmuni sodda javoblar. */
export function createDemoLlm({ profile }: DemoLlmOptions): TrainerLlm {
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, model: 'demo-llm' };

  async function answer<T>(req: TrainerLlmRequest<T>): Promise<T> {
    const raw =
      req.stage === 'training.persona'
        ? personaFor(profile, req.system, req.user)
        : req.stage === 'training.scoring'
          ? scoringFor(req.system, req.user)
          : turnFor(req.system, req.user);
    return req.schema.parse(raw);
  }

  return {
    completeJson: answer,
    async completeJsonWithUsage<T>(req: TrainerLlmRequest<T>) {
      return { value: await answer(req), usage };
    },
  };
}

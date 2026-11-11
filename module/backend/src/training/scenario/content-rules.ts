/**
 * TAHRIRLANADIGAN YAGONA KONFIGURATSIYA: ssenariy mijozining murojaat shakllari,
 * haqorat chegaralari, bloklist, emotsiya chegaralari.
 *
 * Bu faylni o'zgartirish kodni o'zgartirishni talab qilmaydi — hamma tekshiruvlar
 * (prompt, post-check, testlar) shu ro'yxatlardan o'qiydi.
 *
 * So'zlar KICHIK harfda, lotin yozuvida, apostrof — oddiy "'" (o', g').
 * Moslash so'z chegarasi bo'yicha (qism so'zga emas).
 */

// ---------------------------------------------------------------------------
// 1. Murojaat shakllari (mijoz -> sotuvchi)
// ---------------------------------------------------------------------------

/** Faqat ERKAK sotuvchiga aytiladigan murojaatlar (ayolga aytilsa — xato). */
export const MALE_ADDRESS_FORMS: readonly string[] = [
  'uka',
  'ukam',
  'ukajon',
  'aka',
  'akajon',
  'akam',
  "o'g'lim",
  "o'g'ilim",
  'bratan',
  'brat',
  'bratishka',
  'yigit',
];

/** Faqat AYOL sotuvchiga aytiladigan murojaatlar (erkakka aytilsa — xato). */
export const FEMALE_ADDRESS_FORMS: readonly string[] = [
  'singlim',
  'singil',
  'singiljon',
  'opa',
  'opajon',
  'opam',
  'qizim',
  'qizaloq',
  'kelin',
  'xonim',
];

/** Har ikki jinsga mos (neytral) murojaatlar. */
export const NEUTRAL_ADDRESS_FORMS: readonly string[] = ['bolam', 'jonim', 'mehribonim'];

/**
 * Yosh farqi chegaralari (yil). `older` — mijoz sotuvchidan shuncha katta bo'lsa
 * "o'g'lim/qizim" kabi; `peer` — oraliq farq; undan kichik/yosh — "aka/opa".
 */
export const ADDRESS_AGE_RULES = {
  /** Mijoz 55+ va sotuvchidan >= 20 yosh katta: "o'g'lim/qizim, bolam". */
  elderGap: 20,
  /** Mijoz sotuvchidan 6..19 yosh katta: "uka/singlim". */
  olderGap: 6,
  /** Mijoz 18 dan kichik: har doim "aka/opa". */
  minorAge: 18,
} as const;

/** Qoidalar jadvali: [holat] -> sotuvchi jinsi -> ruxsat etilgan shakllar. */
export const ADDRESS_TABLE = {
  /** Keksa mijoz, ancha yosh sotuvchi. */
  elder: { male: ["o'g'lim", 'bolam', 'uka'], female: ['qizim', 'bolam', 'singlim'] },
  /** Mijoz katta (6..19 yil). */
  older: { male: ['uka', 'ukajon'], female: ['singlim', 'singil'] },
  /** Tengdosh (farq 5 yilgacha): ism + "siz", yoki hurmat uchun aka/opa. */
  peer: { male: ['aka', 'ism bilan'], female: ['opa', 'ism bilan'] },
  /** Mijoz sotuvchidan yosh yoki voyaga yetmagan. */
  younger: { male: ['aka', 'akajon'], female: ['opa', 'opajon'] },
} as const;

// ---------------------------------------------------------------------------
// 2. Haqorat chegaralari
// ---------------------------------------------------------------------------

/** Ssenariydagi haqorat darajasining yuqori chegarasi (har qanday ssenariy, kelajakdagilar ham). */
export const MAX_INSULT_LEVEL = 2;

/**
 * insult_level = 2 da ruxsat etilgan YUMSHOQ haqoratlar (faqat shu ro'yxatdan).
 * Mijoz faqat jahli juda baland bo'lganda (`EMOTION_THRESHOLDS.insultAt`) aytishi mumkin.
 */
export const INSULT_WHITELIST: readonly string[] = [
  'miyang aynib qolganmi?',
  'tentakmisan?',
  'aqling joyidami?',
  "qulog'ing og'irmi?",
  'miyangiz aynib qolganmi?',
  'aqlingiz joyidami?',
  "qulog'ingiz og'irmi?",
  'esingiz joyidami?',
  'esing joyidami?',
];

/**
 * HAR DOIM TAQIQLANGAN atamalar (so'kinish; millat, din, jins, tana, oila,
 * nogironlik haqidagi haqorat; tahdid; jinsiy mazmun). Javobda shu ro'yxatdan
 * biri bo'lsa — yumshoqroq ko'rsatma bilan qayta so'raladi, yana bo'lsa —
 * neytral gap. Bu boshlang'ich ro'yxat: kerak bo'lsa kengaytiring.
 * Har element — so'z boshi (prefiks): "onangni" -> "onangni...", "onangga..." emas.
 */
export const BLOCKLIST: readonly string[] = [
  // so'kinish (o'zbek / rus)
  'jalab',
  'qanjiq',
  'harom',
  'haromi',
  'itvachcha',
  'iflos',
  'blyat',
  'blya',
  'suka',
  'nahuy',
  'pizd',
  'xuy',
  'yeban',
  'pidor',
  'mudak',
  'dalbayob',
  'dolbayob',
  // oila haqida
  'onangni',
  'onangga',
  'otangni',
  'otangga',
  "ota-onangni",
  'oilangni',
  // millat / din / jins / tana / nogironlik
  'kofir',
  'dinsiz',
  'xotinchalish',
  'baba',
  'semiz cho\'chqa',
  "cho'chqa",
  'maymun',
  'nogiron ahmoq',
  'ahmoq nogiron',
  'kar-soqov',
  // tahdid
  "o'ldiraman",
  "o'ldirib",
  'uraman',
  'urib',
  "so'yaman",
  'tashlab ketaman seni',
  // jinsiy mazmun
  'seks',
];

// ---------------------------------------------------------------------------
// 3. Emotsiya chegaralari (ssenariy o'zi bermasa — default)
// ---------------------------------------------------------------------------
export const EMOTION_THRESHOLDS = {
  /** anger >= shu -> "siz" dan "sen" ga o'tishi mumkin (ruxsat bo'lsa). */
  senAt: 70,
  /** anger <= shu -> yana "siz" ga qaytadi. */
  sizAt: 40,
  /** anger >= shu va insult_level = 2 -> yumshoq haqorat mumkin. */
  insultAt: 85,
  /** anger >= shu -> mijoz qo'ng'iroqni tugatadi. */
  hangupAt: 100,
} as const;

/**
 * Bir navbatda har bir ko'rsatkich (jahl, ishonch, qiziqish) ko'pi bilan
 * shuncha o'zgaradi. Part 1 dagi low/med/high nomlari ham qabul qilinadi
 * (slow/medium/fast ga moslanadi).
 */
export const VOLATILITY_MAX_STEP = { slow: 8, medium: 12, fast: 20 } as const;

/**
 * Jahl tufayli go'shak qo'yishdan OLDIN mijoz BIR marta ochiq ogohlantiradi.
 * Model ogohlantirmagan bo'lsa — kod shu gapni qo'shadi.
 */
export const HANGUP_WARNING_LINE = "Yana shunday gapirsangiz, telefonni qo'yaman!";
/** Mijoz "sen" rejimida bo'lsa (jahl baland) — shu shakl. */
export const HANGUP_WARNING_LINE_SEN = "Yana shunday gapirsang, telefonni qo'yaman!";
/** Javobda ogohlantirish bor-yo'qligini bilish uchun belgilar (kichik harf). */
export const HANGUP_WARNING_CUES: readonly string[] = [
  "qo'yaman",
  'uzaman',
  "o'chiraman",
  'gaplashmayman',
  'oxirgi marta',
  'tugataman',
];

// ---------------------------------------------------------------------------
// 3b. Sabr (patience)
// ---------------------------------------------------------------------------
export const PATIENCE_RULES = {
  /** Sotuvchi shu xatolardan har biri uchun sabr shuncha kamayadi (daraja koeffitsienti bilan). */
  drop: { repeated: 8, lectured: 5, ignored_question: 8, pressured: 6, interrupted: 5 },
  /** Tiklanish: so'ralgan narsaga ANIQ javob +5, samimiy hamdardlik +3 (birga +8). */
  recover: { answered_exactly: 5, empathy: 3 },
  /** Shundan past — "sabri tugagan": juda qisqa, toqatsiz javoblar. */
  lowAt: 20,
} as const;

// ---------------------------------------------------------------------------
// 3a. Sotuvchi tanlaydigan daraja (ssenariyning o'z qiyinligi USTIGA)
// ---------------------------------------------------------------------------
export const DIFFICULTY_LEVELS = {
  easy: {
    label: 'Oson',
    /** Emotsiya qadami chegarasi koeffitsienti (VOLATILITY_MAX_STEP x). */
    volatilityScale: 0.75,
    /** Sabr jarimalari koeffitsienti. */
    patienceDropScale: 0.6,
    /** Sabr tiklanishi koeffitsienti. */
    patienceRecoverScale: 1.4,
    /** Yashirin sababni ochish uchun kerakli dolzarb savollar soniga qo'shimcha (min 1). */
    revealQuestionsDelta: -1,
    /** Shu ssenariy qiyinligidan boshlab rozilikdan oldin haqiqiy e'tiroz yechilishi SHART. */
    objectionRequiredFromDifficulty: 4,
  },
  medium: {
    label: "O'rta",
    volatilityScale: 1,
    patienceDropScale: 1,
    patienceRecoverScale: 1,
    revealQuestionsDelta: 0,
    objectionRequiredFromDifficulty: 3,
  },
  hard: {
    label: 'Qiyin',
    volatilityScale: 1.3,
    patienceDropScale: 1.4,
    patienceRecoverScale: 0.7,
    revealQuestionsDelta: 1,
    objectionRequiredFromDifficulty: 1,
  },
} as const;

export type DifficultyLevel = keyof typeof DIFFICULTY_LEVELS;
export const DIFFICULTY_LEVEL_KEYS = Object.keys(DIFFICULTY_LEVELS) as DifficultyLevel[];

// ---------------------------------------------------------------------------
// 3a'. Ismlardan olib tashlanadigan murojaat/qarindoshlik so'zlari ("Rustam aka" -> "Rustam").
// Murojaat so'zini address qoidalari tanlaydi, ismga "yopishtirilmaydi".
// ---------------------------------------------------------------------------
export const NAME_HONORIFICS: readonly string[] = [
  'aka',
  'akajon',
  'opa',
  'opajon',
  'xonim',
  'buvi',
  'buvijon',
  'bobo',
  'bobojon',
  'uka',
  'ukajon',
  'singlim',
  'singil',
  'ota',
  'ona',
  'hoji',
  'domla',
  'janob',
  'xola',
  'amaki',
  "tog'a",
  'ustoz',
  'momo',
];

// ---------------------------------------------------------------------------
// 3c. Yashirin sabab va rozilik ("oson taslim bo'lmaslik")
// ---------------------------------------------------------------------------
export const REVEAL_RULES = {
  /** Yashirin sababni aytishdan oldin sotuvchi shuncha DOLZARB savol berishi kerak (qiyinlik bo'yicha). */
  questionsByDifficulty: { 1: 1, 2: 1, 3: 2, 4: 3, 5: 3 } as Record<number, number>,
  /** Va ishonch kamida shuncha bo'lishi kerak. */
  minTrust: 50,
} as const;

// ---------------------------------------------------------------------------
// 3d. Xarakter xususiyatlari (ssenariyda ko'pi bilan 4 ta)
// ---------------------------------------------------------------------------
export interface TraitDef {
  /** O'zbekcha nom (UI). */
  label: string;
  /** Promptga bitta ixcham ko'rsatma (inglizcha). */
  prompt: string;
  /** TTS uslubiga qo'shimcha (inglizcha). */
  tts: string;
}

export const TRAITS = {
  jahldor: { label: 'Jahldor', prompt: 'Quick-tempered: small mistakes irritate you.', tts: 'tense, sharp' },
  shoshqaloq: { label: 'Shoshqaloq', prompt: 'In a hurry: wants short answers, cuts long talk.', tts: 'fast pace' },
  ishonchsiz: { label: 'Ishonchsiz', prompt: 'Distrustful: doubts claims, asks for proof.', tts: 'skeptical' },
  kinoyali: { label: 'Kinoyali', prompt: 'Ironic: answers with dry irony (within the sarcasm limit).', tts: 'dry, ironic' },
  injiq: { label: 'Injiq', prompt: 'Picky: finds faults in details.', tts: 'fussy' },
  charchagan: { label: 'Charchagan', prompt: 'Tired: low energy, short replies.', tts: 'tired, slow' },
  ikkilanuvchi: { label: 'Ikkilanuvchi', prompt: 'Indecisive: hesitates, needs reassurance.', tts: 'hesitant, pauses' },
  gapni_boluvchi: { label: "Gapni bo'luvchi", prompt: 'Interrupts: jumps in with own question mid-topic.', tts: 'quick interjections' },
  kam_gapiradigan: { label: 'Kam gapiradigan', prompt: 'Taciturn: very short answers, rarely volunteers info.', tts: 'few words, flat' },
  iliq: { label: 'Iliq', prompt: 'Warm: friendly and polite even when unsure.', tts: 'warm, friendly' },
} as const satisfies Record<string, TraitDef>;

export type TraitKey = keyof typeof TRAITS;
export const TRAIT_KEYS = Object.keys(TRAITS) as TraitKey[];
export const MAX_TRAITS = 4;

/** Ziddiyatli juftliklar: `error` — rad etiladi, `warn` — ogohlantirish (saqlanadi). */
export const TRAIT_CONFLICTS: ReadonlyArray<{ a: TraitKey; b: TraitKey; level: 'error' | 'warn' }> = [
  { a: 'iliq', b: 'jahldor', level: 'error' },
  { a: 'iliq', b: 'kinoyali', level: 'warn' },
  { a: 'iliq', b: 'ishonchsiz', level: 'warn' },
  { a: 'iliq', b: 'injiq', level: 'warn' },
  { a: 'shoshqaloq', b: 'charchagan', level: 'warn' },
  { a: 'kam_gapiradigan', b: 'gapni_boluvchi', level: 'error' },
];

// ---------------------------------------------------------------------------
// 3e. Sotuvchining JINSI/YOSHI/tashqi ko'rinishiga qaratilgan haqorat — HAR DOIM taqiq.
// Haqorat faqat sotuvchining XATTI-HARAKATIGA (takrorlash, chetlash, bosim) bo'lishi mumkin.
// Regex (kichik harf, apostrof — "'").
// ---------------------------------------------------------------------------
export const PERSONAL_ATTACK_PATTERNS: readonly string[] = [
  // "sen qizni", "sen bolani", "sen yosh ...", "sen ayol..."
  "\\bsen\\s+(?:qiz|bola|yosh|ayol|xotin|erkak|go'dak|jujuq|kichkina)",
  // "qiz ekansan", "bola bo'lsang", "ayol bo'la turib" (2-shaxs)
  "\\b(?:qiz|bola|ayol|xotin|yosh|erkak)\\s+(?:bola\\s+)?(?:ekansan|bo'lsang|bo'la turib|emassan)\\b",
  "\\b(?:qiz|yosh)\\s+bolasan\\b",
  "\\bbolakay\\b",
  "\\bsut emizar\\b",
  "og'zidan ona suti",
  "\\byoshing\\s+(?:kichik|yetmaydi)\\b",
  "\\bxotinchalish\\b",
];

// ---------------------------------------------------------------------------
// 4. Zaxira gaplar (LLM javobi ishlatib bo'lmasa)
// ---------------------------------------------------------------------------

/** Xavfsizlik bloki / bloklist / bo'sh javobdan keyin — rolda qoladigan neytral gap. */
export const NEUTRAL_FALLBACK_LINES: readonly string[] = [
  "Xo'p... Yana nima demoqchi edingiz?",
  'Hmm, tushunmadim. Aniqroq aytolasizmi?',
  "Mayli, eshityapman. Davom eting.",
];

/** Jahl tufayli kod qo'ng'iroqni tugatganda (model yakuniy gap aytmagan bo'lsa) qo'shiladi. */
export const HANGUP_CLOSING_LINE = "Bo'ldi, boshqa gaplashmayman. Xayr.";

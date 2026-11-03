/**
 * UI satrlari (lug'at). Barcha ko'rinadigan matn SHU faylda — integratsiyada
 * teammate'lar buni asosiy repodagi `lugat/` mexanizmiga ko'chiradi
 * (fayl nomi: `lugat/mashq`).
 *
 * Soha so'zlari yo'q: hamma matn har qanday biznes uchun yaroqli.
 */
export const mashq = {
  // Umumiy
  appTitle: 'Mashq',
  loading: 'Yuklanmoqda…',
  error: 'Xatolik yuz berdi',
  retry: 'Qayta urinish',
  back: 'Orqaga',
  close: 'Yopish',
  cancel: 'Bekor qilish',

  // Navigatsiya
  navHome: 'Mashq',
  navHistory: 'Tarix',

  // Bosh sahifa
  homeTitle: 'Kim bilan mashq qilamiz?',
  homeSubtitle:
    'Mijozni tanlang. AI mijoz haqiqiy odam kabi javob beradi: oson rozi bo\'lmaydi, e\'tiroz aytadi, sabri tugashi mumkin.',
  difficulty: 'Qiyinlik',
  startPractice: 'Mashqni boshlash',
  starting: 'Mijoz tayyorlanmoqda…',
  directionLabel: "Qo'ng'iroq yo'nalishi",
  directionInbound: 'Mijoz qo\'ng\'iroq qiladi',
  directionOutbound: 'Men qo\'ng\'iroq qilaman',
  directionAuto: 'Avtomatik',
  myProgress: 'Mening natijalarim',
  recentSessions: 'Oxirgi mashqlar',
  noSessions: 'Hali mashq qilmagansiz. Yuqoridan mijoz tanlab boshlang.',
  seeAll: 'Hammasini ko\'rish',

  // Sessiya
  sessionTitle: 'Mashq suhbati',
  you: 'Siz',
  customer: 'Mijoz',
  inputPlaceholder: 'Sotuvchi sifatida yozing…',
  send: 'Yuborish',
  sending: 'Yuborilmoqda…',
  endSession: 'Suhbatni tugatish',
  ending: 'Tugatilmoqda…',
  turnCounter: 'Navbat',
  sessionEnded: 'Suhbat tugadi',
  seeResult: 'Natijani ko\'rish',
  customerThinking: 'Mijoz javob yozyapti…',
  voiceSlotTitle: 'Ovozli mashq',
  voiceSlotPending:
    "Ovozli rejim serverda yoqilmagan. `npm run diag:voice` bilan modellarni aniqlab, " +
    'harness/.env ga yozing. Hozircha matn bilan mashq qiling.',
  voiceHoldToTalk: "Gapirish uchun bosib turing (yoki BO'SHLIQ)",
  voiceRecording: "Yozilyapti… qo'yib yuboring",
  voiceHeadphones: 'Quloqchin taqing — aks holda mijoz ovozi mikrofonga qaytadi.',
  voiceListening: 'Eshityapti…',
  voiceThinking: 'Mijoz javob tayyorlayapti…',
  voiceSpeaking: 'Mijoz gapiryapti…',
  voiceRepeatNotice: "Mijoz eshitmadi — yana bir marta, aniqroq gapiring.",
  voiceMicDenied:
    'Mikrofonga ruxsat berilmadi. Brauzer sozlamalaridan ruxsat bering yoki matn bilan yozing.',
  voiceUnsupported: "Brauzer mikrofonni qo'llamaydi — matn bilan yozing.",
  voiceFailed: "Ovoz ishlamadi — matn bilan yozib ko'ring.",
  voiceTypeInstead: "Hozircha matn bilan yozib ko'ring.",
  errorAtStage: 'bosqichida xato',
  errorStage: {
    audio: 'Yozuvni tekshirish',
    stt: 'Nutqni tanish (STT)',
    llm: 'Mijoz javobi (AI)',
    tts: 'Ovoz yaratish (TTS)',
    session: 'Sessiya',
    server: 'Server',
  },
  voiceTone: 'Ohang',
  voiceTimings: 'Vaqtlar',
  voicePlayOpening: "Mijozning birinchi gapini eshitish",

  /** Muhim lahza turlari — foydalanuvchiga `trust_rise` emas, shu ko'rinadi. */
  keyMomentKinds: {
    objection_raised: "E'tiroz aytildi",
    objection_resolved: "E'tiroz yechildi",
    trust_rise: 'Ishonch oshdi',
    trust_drop: 'Ishonch tushdi',
    patience_drop: 'Sabr tushdi',
    final_turn: 'Oxirgi navbat',
  } as Record<string, string>,
  debugTitle: 'Debug',
  blockers: 'Nega hali rozi bo\'lmaydi',
  readyToAgree: 'Rozi bo\'lishga tayyor',

  // Natija
  resultTitle: 'Natija',
  scoring: 'Baholanmoqda…',
  scoringHint: 'Suhbat tahlil qilinyapti, bu bir necha soniya oladi.',
  scoringFailed: 'Baholash muvaffaqiyatsiz tugadi.',
  scoreAgain: 'Qayta baholash',
  rescoringHint: "Yangi natija tayyor bo'lgach shu yerda avtomatik chiqadi.",
  rescoreFailed: "Qayta baholash muvaffaqiyatsiz tugadi — quyida oldingi natija ko'rsatilmoqda.",
  scoringStuck:
    "Baholash 3 daqiqadan beri tugamadi — server to'xtagan bo'lishi mumkin. Qayta baholab ko'ring.",
  skillScore: 'Mahorat balli',
  noScore: 'Baholanmadi',
  outcome: 'Natija',
  outcomeWon: 'Rozi bo\'ldi',
  outcomeLost: 'Rozi bo\'lmadi',
  outcomeTimeout: 'Vaqt tugadi',
  outcomeUnknown: 'Tugamagan',
  qualityLowNotice:
    'Diqqat: tahlil sifati past — model keltirgan dalillarning ko\'pi transkriptda topilmadi. Ballarga ehtiyotkorlik bilan qarang.',
  qualityLanguageNotice:
    "Diqqat: tahlilning ba'zi qismlari to'g'ri tilda yaratilmadi va yashirildi. Qayta baholab ko'ring.",
  qualityInsufficientNotice:
    'Bu suhbat juda qisqa bo\'lgani uchun baholanmadi. Kamida 3-4 marta gaplashib ko\'ring.',

  metrics: 'O\'lchovlar',
  metricTurns: 'Navbatlar',
  metricObjections: 'E\'tirozlar (yechilgan/aytilgan)',
  metricNeed: 'Yashirin ehtiyoj',
  metricNeedYes: 'ochildi',
  metricNeedNo: 'ochilmadi',
  metricDuration: 'Davomiyligi',
  metricWordShare: 'Sizning gapirish ulushingiz',
  stateChartTitle: 'Mijoz holati suhbat davomida',
  chartPatience: 'Sabr',
  chartTrust: 'Ishonch',
  chartInterest: 'Qiziqish',

  criteria: 'Mezonlar bo\'yicha baho',
  criterionNotScored: 'Baholanmadi',
  evidenceLabel: 'Dalil',
  evidenceRejected: 'Dalil tekshiruvdan o\'tmadi, shuning uchun baho qo\'yilmadi',
  weight: 'vazn',

  coaching: 'Maslahat',
  strengths: 'Yaxshi chiqqan joylar',
  improvements: 'Nimani yaxshilash kerak',
  betterPhrasing: 'Shunday desangiz yaxshiroq edi',
  keyMoments: 'Muhim lahzalar',
  redLinesTitle: 'Qizil chiziq buzildi',
  redLinesHint: 'Bu gaplar biznes qoidalariga zid — haqiqiy qo\'ng\'iroqda aytilmasligi kerak.',
  redLineRule: 'Qoida',
  scriptTitle: 'Skriptga moslik',
  scriptFollowed: 'Bajarildi',
  scriptPartly: 'Qisman',
  scriptMissed: "O'tkazib yuborildi",
  scriptUnknown: 'Baholanmadi',
  transcript: 'Suhbat matni',

  hiddenCards: 'Mijozning yashirin kartalari',
  hiddenCardsHint:
    'Bu ma\'lumot suhbat davomida sizdan yashirilgan edi. Keyingi marta shularni o\'zingiz ochishga harakat qiling.',
  hiddenNeed: 'Haqiqiy ehtiyoji',
  hiddenFacts: 'Aytmagan faktlari',
  objectionPlan: 'E\'tirozlar rejasi',
  objectionRaised: 'aytildi',
  objectionNotRaised: 'aytilmadi',
  objectionResolved: 'yechildi',
  objectionUnresolved: 'yechilmadi',
  situation: 'Vaziyati',
  goal: 'Maqsadi',
  focusOffer: 'Muhokama mavzusi',

  tryAgainSame: 'Qayta urinish',
  tryAnother: 'Boshqa mijoz',

  // Tarix
  historyTitle: 'Tarix va taraqqiyot',
  historySubtitle: 'Mashqlaringiz, mahorat ballining o\'zgarishi va eng zaif tomonlar.',
  avgScore: 'O\'rtacha ball',
  totalSessions: 'Mashqlar',
  winRate: 'G\'alaba ulushi',
  weakest: 'Eng zaif mezonlar',
  trend: 'Ball dinamikasi',
  sellerFilter: 'Sotuvchi',
  teamOverview: 'Jamoa ko\'rinishi',
  noData: 'Hali ma\'lumot yo\'q',
  sessionDate: 'Sana',
  open: 'Ochish',
} as const;

export type MashqStrings = typeof mashq;

/**
 * Muhim lahza turini o'zbekcha nomga o'giradi. Noma'lum kalit kelsa —
 * kalitning o'zi (yangi tur qo'shilsa UI buzilmaydi).
 */
export function keyMomentLabel(kind: string): string {
  return mashq.keyMomentKinds[kind] ?? kind;
}

/** Natija kodini o'zbekcha matnga o'giradi. */
export function outcomeLabel(outcome: string | null): string {
  switch (outcome) {
    case 'won':
      return mashq.outcomeWon;
    case 'lost':
      return mashq.outcomeLost;
    case 'timeout':
      return mashq.outcomeTimeout;
    default:
      return mashq.outcomeUnknown;
  }
}

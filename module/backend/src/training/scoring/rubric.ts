/**
 * Baholash rubrikasi.
 *
 * Ikki manba bo'lishi mumkin:
 *  1. tenant'ning playbook'i (`getPlaybook` porti orqali host beradi);
 *  2. u bo'lmasa — shu fayldagi `DEFAULT_TRAINING_RUBRIC`.
 *
 * Soha so'zlari yo'q: mezonlar har qanday savdo suhbati uchun yaroqli.
 * Rubrika matni o'zbek (lotin) tilida — sotuvchi uni o'z natijasida ko'radi.
 */
import { z } from 'zod';

/**
 * SYNC WITH backend/src/playbook/schema.ts — integratsiyada shu faylni
 * o'chirib, asosiy repodagi playbook sxemasidan import qiling. Bu yerda
 * faqat baholashga KERAK bo'lgan minimal qism (subset) bor: kategoriyalar,
 * mezonlar, vazn va 0-3 rubrika tavsiflari.
 */
export const rubricDescriptorsSchema = z.object({
  '0': z.string().min(3),
  '1': z.string().min(3),
  '2': z.string().min(3),
  '3': z.string().min(3),
});

export type RubricDescriptors = z.infer<typeof rubricDescriptorsSchema>;

export const playbookCriterionSchema = z.object({
  /** Barqaror kalit — natijada va statistikada shu ishlatiladi. */
  code: z
    .string()
    .min(2)
    .max(60)
    .regex(/^[a-z][a-z0-9_]*$/, "code snake_case bo'lishi kerak"),
  name: z.string().min(2).max(120),
  /** Umumiy ballda ulushi. Barcha vaznlar yig'indisi 100 bo'lishi kerak. */
  weight: z.number().int().min(1).max(100),
  rubric: rubricDescriptorsSchema,
});

export type PlaybookCriterion = z.infer<typeof playbookCriterionSchema>;

export const playbookCategorySchema = z.object({
  code: z.string().min(2).max(60),
  name: z.string().min(2).max(120),
  criteria: z.array(playbookCriterionSchema).min(1),
});

export const playbookSubsetSchema = z.object({
  categories: z.array(playbookCategorySchema).min(1),
});

export type PlaybookSubset = z.infer<typeof playbookSubsetSchema>;

/** Playbook bo'lmaganda ishlatiladigan standart rubrika (vaznlar: 100). */
export const DEFAULT_TRAINING_RUBRIC: PlaybookSubset = {
  categories: [
    {
      code: 'training_default',
      name: 'Savdo suhbati — asosiy mezonlar',
      criteria: [
        {
          code: 'greeting_intro',
          name: 'Salomlashish va tanishuv',
          weight: 10,
          rubric: {
            '0': "Salomlashmadi yoki o'zini/kompaniyani tanishtirmadi; mijoz kim bilan gaplashayotganini bilmaydi.",
            '1': "Quruq salomlashdi, lekin tanishtirish chala: nomi yoki qaysi tashkilotdan ekani aytilmadi.",
            '2': "Salomlashdi, o'zini va tashkilotni tanishtirdi, lekin qo'ng'iroqning maqsadini aniq aytmadi.",
            '3': "Tabiiy salomlashdi, o'zini va tashkilotni tanishtirdi, qo'ng'iroq maqsadini bir gapda aytdi va mijozdan gaplashishga qulaylik so'radi.",
          },
        },
        {
          code: 'need_discovery',
          name: 'Ehtiyojni aniqlash',
          weight: 20,
          rubric: {
            '0': "Savol bermadi; mijoz nima xohlayotganini bilmasdan taklif aytdi.",
            '1': "Faqat yopiq savollar berdi (ha/yo'q) yoki bitta yuzaki savol bilan cheklandi.",
            '2': "Ochiq savollar berdi va javobni tingladi, lekin mijozning haqiqiy sababini (nega kerak) ochmadi.",
            '3': "Ketma-ket ochiq savollar bilan mijozning holati, maqsadi va asl ehtiyojini ochdi; javoblarni o'z so'zi bilan takrorlab tasdiqladi.",
          },
        },
        {
          code: 'offer_fit',
          name: 'Taklifni ehtiyojga moslashtirish',
          weight: 15,
          rubric: {
            '0': "Taklifni umuman tushuntirmadi yoki mijozga aloqasi yo'q narsani aytdi.",
            '1': "Taklifni umumiy maqtov bilan aytdi ('yaxshi', 'sifatli'), mijozning holatiga bog'lamadi.",
            '2': "Taklifni aniq aytdi (shart, muddat, narx), lekin uni mijozning aytgan ehtiyoji bilan bog'lamadi.",
            '3': "Taklifni aynan mijoz aytgan ehtiyoj/muammo bilan bog'lab, aniq shart va raqamlar bilan tushuntirdi.",
          },
        },
        {
          code: 'objection_handling',
          name: "E'tirozlar bilan ishlash",
          weight: 20,
          rubric: {
            '0': "E'tirozni eshitmadi, e'tiborsiz qoldirdi yoki mijoz bilan tortishdi.",
            '1': "E'tirozga javob berdi, lekin umumiy gap bilan ('arzon', 'ishonavering'), dalil keltirmadi.",
            '2': "E'tirozni tushunganini bildirdi va javob berdi, lekin bir-ikkitasini javobsiz qoldirdi yoki dalil yetarli emas.",
            '3': "Har e'tirozni oldin tushundi/aniqlashtirdi, keyin aniq dalil, raqam yoki variant bilan yechdi va mijoz qanoat qilganini tekshirdi.",
          },
        },
        {
          code: 'closing_next_step',
          name: "Yopish / keyingi qadam",
          weight: 15,
          rubric: {
            '0': "Suhbat hech qanday qadamsiz tugadi; kim nima qilishi noma'lum.",
            '1': "Noaniq yakun: 'o'ylab ko'ring', 'keyin gaplashamiz' — mas'ul va vaqt yo'q.",
            '2': "Keyingi qadamni taklif qildi, lekin aniq vaqt yoki mas'ul shaxs belgilanmadi.",
            '3': "Aniq keyingi qadamni (vaqti, kim nima qiladi) taklif qildi va mijozdan tasdiq oldi; bosim qilmadi.",
          },
        },
        {
          code: 'tone_respect',
          name: 'Muloqot ohangi va hurmat',
          weight: 10,
          rubric: {
            '0': "Qo'pol, bosim qiluvchi yoki mijozning gapini bo'lib tashlaydigan ohang.",
            '1': "Beparvo yoki mexanik ohang; mijozning holatiga e'tibor yo'q.",
            '2': "Xushmuomala, lekin quruq; mijozni tushunganini bildirmaydi.",
            '3': "Hurmatli va tabiiy ohang; mijozni tingladi, holatini tushunganini bildirdi, hech narsani bo'rttirib va'da qilmadi.",
          },
        },
        {
          code: 'conversation_control',
          name: 'Suhbatni boshqarish',
          weight: 10,
          rubric: {
            '0': "Suhbat butunlay mijoz tomonidan boshqarildi yoki sotuvchi faqat o'zi gapirib ketdi.",
            '1': "Mavzudan chiqib ketdi, o'zini takrorladi yoki mijozning savolini javobsiz qoldirdi.",
            '2': "Suhbat izchil edi, lekin ba'zi joylarda yo'nalish yo'qoldi yoki keraksiz uzun gapirdi.",
            '3': "Suhbatni izchil boshqardi: qisqa gapirdi, savol bilan yo'naltirdi, mijozni tinglash bilan gapirish orasida muvozanat saqladi.",
          },
        },
      ],
    },
  ],
};

export interface ResolvedRubric {
  criteria: PlaybookCriterion[];
  source: 'playbook' | 'default';
  totalWeight: number;
}

export function flattenCriteria(playbook: PlaybookSubset): PlaybookCriterion[] {
  return playbook.categories.flatMap((category) => category.criteria);
}

/**
 * Playbook bo'lsa — undan, bo'lmasa standart rubrikadan mezonlarni oladi.
 * Playbook buzuq bo'lsa ham ilova yiqilmaydi: standartga qaytadi.
 */
export function resolveRubric(playbook: PlaybookSubset | null): ResolvedRubric {
  if (playbook) {
    const parsed = playbookSubsetSchema.safeParse(playbook);
    if (parsed.success) {
      const criteria = flattenCriteria(parsed.data);
      if (criteria.length > 0) {
        return {
          criteria,
          source: 'playbook',
          totalWeight: criteria.reduce((sum, c) => sum + c.weight, 0),
        };
      }
    }
  }

  const criteria = flattenCriteria(DEFAULT_TRAINING_RUBRIC);
  return {
    criteria,
    source: 'default',
    totalWeight: criteria.reduce((sum, c) => sum + c.weight, 0),
  };
}

export function getRubricDescriptor(criterion: PlaybookCriterion, score: 0 | 1 | 2 | 3): string {
  return criterion.rubric[String(score) as keyof RubricDescriptors];
}

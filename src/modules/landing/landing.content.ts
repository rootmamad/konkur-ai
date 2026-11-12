/**
 * Landing-page demo content (spec 1.3: «دو API عمومی نمونه کارنامه و معرفی
 * پلن‌ها»). Pure constants — no DB, no service, no real user/exam data: the
 * numbers below are an invented, self-consistent example and «داده نمایشی
 * هرگز آمار واقعی دیده نمی‌شود».
 *
 * Pricing is deliberately absent: it is undecided in the spec ([باز]), so the
 * plans payload carries the explicit `pricing: 'coming_soon'` marker and no
 * price figures anywhere.
 */

/**
 * Outcome of the manual correction queue (spec 3.9): choice answers are
 * graded on finish, descriptive answers wait for a human correction.
 */
export type CorrectionStatus = 'pending' | 'in_review' | 'corrected';

/**
 * Static sample of the exam result card, shaped like the §3.9 result flow
 * (percent/score, answered/blank counts, time, correction status). Field
 * names mirror the exam flow (`totalScore`/`pendingDescriptive` language).
 */
export interface ReportCardSample {
  /** Marker that distinguishes the demo card from a real result. */
  sample: true;
  examTitle: string;
  examKind: string;
  status: string;
  startedAt: string;
  submittedAt: string;
  /** Total active time of the demo attempt (seconds). */
  durationSeconds: number;
  totalQuestions: number;
  answeredCount: number;
  blankCount: number;
  correctCount: number;
  wrongCount: number;
  /** Raw score in questions (= correctCount, like the real grader). */
  score: number;
  /** Score as a percentage of the total questions. */
  percent: number;
  correctionStatus: CorrectionStatus;
  /** Descriptive answers waiting for manual correction (spec 3.9). */
  pendingDescriptive: number;
}

/**
 * One subscription tier for the landing page (spec 1.3). Feature bullets
 * spell quantities in Persian words — pricing is undecided, so the payload
 * intentionally contains no numeric price (and no digits at all).
 */
export interface LandingPlan {
  id: 'free' | 'full' | 'advisor';
  title: string;
  tagline: string;
  features: string[];
  /** Pricing undecided (spec 1.3 «[باز]») — never a number. */
  pricing: 'coming_soon';
}

/**
 * Demo report card (spec 1.3) mirroring the §3.9 result flow. Numbers are
 * consistent: answered + blank = total, correct + wrong = answered,
 * percent = score / total * 100, and the 09:00→10:20 window is 4800s.
 */
export const REPORT_CARD_SAMPLE: ReportCardSample = {
  sample: true,
  examTitle: 'آزمون آزمایشی جامع — عمومی',
  examKind: 'general_prep',
  status: 'submitted',
  startedAt: '2026-03-01T09:00:00.000Z',
  submittedAt: '2026-03-01T10:20:00.000Z',
  durationSeconds: 4800,
  totalQuestions: 50,
  answeredCount: 43,
  blankCount: 7,
  correctCount: 31,
  wrongCount: 12,
  score: 31,
  percent: 62,
  correctionStatus: 'pending',
  pendingDescriptive: 4,
};

/**
 * The three tiers (spec 1.3). Quantity words are spelled out so the payload
 * cannot drift into showing figures while pricing is still undecided.
 */
export const LANDING_PLANS: LandingPlan[] = [
  {
    id: 'free',
    title: 'رایگان',
    tagline: 'شروع بدون هزینه، برای آشنایی با سامانه.',
    features: [
      'سه آزمونک در هر هفت روز',
      'آزمون‌های عمومی و بعد از مطالعه',
      'کارنامه و تحلیل پایه پس از هر آزمون',
      'ثبت مطالعه روزانه و خلاصه هفتگی',
    ],
    pricing: 'coming_soon',
  },
  {
    id: 'full',
    title: 'کامل',
    tagline: 'دسترسی کامل به همه امکانات پلتفرم.',
    features: [
      'آزمونک بدون محدودیت هفتگی',
      'شبیه‌ساز کنکور و شبیه‌ساز نهایی',
      'تولید سوال با هوش مصنوعی',
      'میکس هوشمند، مرور باهوش و رفع اشکال هدفمند',
      'تحلیل تحصیلی پیشرفته',
    ],
    pricing: 'coming_soon',
  },
  {
    id: 'advisor',
    title: 'مشاور',
    tagline: 'همه امکانات پلن کامل، همراه با پیگیری مشاور.',
    features: [
      'همه امکانات پلن کامل',
      'پیگیری برنامه مطالعاتی توسط مشاور',
      'بازبینی کارنامه‌ها همراه با مشاور',
      'اولویت در پشتیبانی',
    ],
    pricing: 'coming_soon',
  },
];

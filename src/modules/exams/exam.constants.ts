export const MAX_QUESTIONS_PER_EXAM = 200;
export const MAX_EXAM_DURATION_SECONDS = 3 * 60 * 60;
/** Network slack for the last answer before the server deadline. */
export const ANSWER_SUBMIT_GRACE_SECONDS = 5;
export const MAX_TEXT_ANSWER_LENGTH = 5000;

export const DIAGNOSTIC_QUESTION_COUNT = 10;
export const DIAGNOSTIC_DURATION_SECONDS = 15 * 60;
export const KONKUR_SIM_DURATION_SECONDS = 4 * 60 * 60;
export const FINAL_SIM_DURATION_SECONDS = 3 * 60 * 60;

/**
 * Real-exam simulations (spec 3.5) draw only from past-exam bank questions.
 * sourceYear is the Persian (Solar Hijri / Shamsi) year: 1398 = konkur 1398.
 * If the DB ever switches to Gregorian years, change these to 2019 / 2023.
 */
export const SIM_SOURCE_MIN_YEAR = { konkur: 1398, final: 1402 } as const;

/**
 * Simulation length from the active app_config row. A single number applies
 * to both kinds; { konkur, final } overrides them separately.
 */
export const SIM_QUESTION_COUNT_KEY = 'sim_question_count';
export const SIM_QUESTION_COUNT_DEFAULT = { konkur: 60, final: 30 } as const;

/**
 * No topic may supply more than this many questions of one simulation, so a
 * topic-heavy real exam cannot crowd out the comprehensive spread.
 */
export const SIM_TOPIC_CAP = 10;

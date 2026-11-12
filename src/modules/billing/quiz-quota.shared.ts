/**
 * Free-plan quiz quota (spec section 10) — the pieces both consumers must
 * agree on. ExamsService enforces the cap before/at quiz start while
 * DashboardService displays the remaining quota; each previously carried its
 * own copies of these values, so any drift made the dashboard card lie about
 * the remaining quizzes. The SQL itself stays with each service (the same
 * `window_start >= now() - interval '7 days'` predicate on both sides); only
 * the shared numbers/operation/window math live here.
 */

/** Quota operation recorded in `quota_usage` for free quiz starts. */
export const QUIZ_QUOTA_OPERATION = 'quiz';

/** Key of the free weekly quiz cap inside `app_config.quotas`. */
export const FREE_QUIZ_WEEKLY_KEY = 'free_quiz_weekly';

/**
 * Documented default: "3 آزمونک در هر ۷ روز" when no active setting exists.
 * The authoritative numbers live in the active app_config row; this value is
 * only the fallback.
 */
export const FREE_QUIZ_WEEKLY_DEFAULT = 3;

/** Rolling quota window in days (spec §10). */
export const QUOTA_WINDOW_DAYS = 7;

const QUOTA_WINDOW_MS = QUOTA_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Inclusive start of the rolling quota window ending at `now` — the exact TS
 * mirror of the SQL predicate both services share (`window_start >= now() -
 * interval '7 days'`): a usage stamped exactly at the returned instant still
 * counts inside the window, one millisecond earlier falls outside.
 * Millisecond-precise; never rounded down to a day boundary.
 */
export function quizQuotaWindowStart(now: Date): Date {
  return new Date(now.getTime() - QUOTA_WINDOW_MS);
}

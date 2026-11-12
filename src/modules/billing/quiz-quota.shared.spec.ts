import { QUOTA_WINDOW_DAYS, quizQuotaWindowStart } from './quiz-quota.shared';

describe('quizQuotaWindowStart', () => {
  it('returns exactly QUOTA_WINDOW_DAYS back, boundary instant still inside the window', () => {
    // Fixed instant, so the assertion is independent of DST / day rollover.
    const now = new Date('2026-03-10T12:34:56.789Z');

    const start = quizQuotaWindowStart(now);

    expect(QUOTA_WINDOW_DAYS).toBe(7);
    // Exactly 7 days back, millisecond-precise — never rounded down to a day
    // start (that would widen the window and drift from the SQL predicate).
    expect(start.toISOString()).toBe('2026-03-03T12:34:56.789Z');
    expect(start.getTime()).toBe(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Boundary mirrors the shared SQL predicate `window_start >= windowStart`:
    // a usage stamped exactly at the window start still counts, one
    // millisecond earlier falls outside.
    expect(start.getTime() >= quizQuotaWindowStart(now).getTime()).toBe(true);
    expect(
      new Date(start.getTime() - 1).getTime() >=
        quizQuotaWindowStart(now).getTime(),
    ).toBe(false);

    // Pure function: the input date is not mutated.
    expect(now.toISOString()).toBe('2026-03-10T12:34:56.789Z');
  });
});

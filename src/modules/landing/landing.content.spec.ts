import { LANDING_PLANS, REPORT_CARD_SAMPLE } from './landing.content';

describe('landing content — sample report card (spec 1.3)', () => {
  it('marks itself as a sample and covers the §3.9 result-flow fields', () => {
    expect(REPORT_CARD_SAMPLE.sample).toBe(true);

    // percent / score
    expect(typeof REPORT_CARD_SAMPLE.percent).toBe('number');
    expect(typeof REPORT_CARD_SAMPLE.score).toBe('number');
    // answered / blank counts
    expect(typeof REPORT_CARD_SAMPLE.answeredCount).toBe('number');
    expect(typeof REPORT_CARD_SAMPLE.blankCount).toBe('number');
    // time
    expect(typeof REPORT_CARD_SAMPLE.durationSeconds).toBe('number');
    // correction status (choice auto-graded, descriptive waits for review)
    expect(REPORT_CARD_SAMPLE.correctionStatus).toBeDefined();
    expect(typeof REPORT_CARD_SAMPLE.pendingDescriptive).toBe('number');
  });

  it('demo numbers are self-consistent, never real statistics', () => {
    const s = REPORT_CARD_SAMPLE;

    expect(s.answeredCount + s.blankCount).toBe(s.totalQuestions);
    expect(s.correctCount + s.wrongCount).toBe(s.answeredCount);
    expect(s.score).toBe(s.correctCount);
    expect(s.percent).toBe(Math.round((s.score / s.totalQuestions) * 100));
    expect(Date.parse(s.submittedAt) - Date.parse(s.startedAt)).toBe(
      s.durationSeconds * 1000,
    );
    expect(s.status).toBe('submitted');
  });
});

describe('landing content — plans (spec 1.3)', () => {
  it('lists exactly the three tiers', () => {
    expect(LANDING_PLANS.map((p) => p.id)).toEqual(['free', 'full', 'advisor']);
  });

  it('marks pricing as undecided on every tier', () => {
    for (const plan of LANDING_PLANS) {
      expect(plan.pricing).toBe('coming_soon');
    }
  });

  it('contains no numeric price anywhere', () => {
    // Any price-like key anywhere in the payload must never hold a number.
    const priceLike = /price|cost|amount|fee|تومان|قیمت/i;
    const violations: string[] = [];
    const visit = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((child, i) => visit(child, `${path}[${i}]`));
        return;
      }
      if (node !== null && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (priceLike.test(key) && typeof value === 'number') {
            violations.push(path);
          }
          visit(value, `${path}.${key}`);
        }
      }
    };

    visit(LANDING_PLANS, 'plans');

    expect(violations).toEqual([]);
  });

  it('contains no digits at all — quantities are spelled out', () => {
    // Pricing undecided (spec 1.3 «[باز]»): no ASCII or Persian digits may
    // leak into the plans payload, so it can never show a figure.
    expect(JSON.stringify(LANDING_PLANS)).not.toMatch(
      /[0-9\u0660-\u0669\u06F0-\u06F9]/,
    );
  });
});

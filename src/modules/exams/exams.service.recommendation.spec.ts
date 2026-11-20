import type { Db } from '../../db/db.module';
import { ExamsService } from './exams.service';

const USER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const STUDENT_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';

/**
 * Minimal Drizzle stand-in for the recommendation method.
 * The recommendation method makes these calls in order:
 * 1. requireStudentId -> student table (accountId = userId)
 * 2. mastery probe -> questionMastery (studentId = studentId)
 * 3. response probe (only if no mastery) -> response JOIN attempt
 */
function mockRecommendationDb(
  masteryExists: boolean,
  answerExists: boolean = false,
): { db: Db; select: jest.Mock } {
  let callIndex = 0;

  const limit = jest.fn(() => {
    // First call is always requireStudentId -> student table
    if (callIndex === 0) {
      callIndex++;
      // Return student row
      return Promise.resolve([{ id: STUDENT_ID }]);
    }
    // Second call is mastery probe
    if (callIndex === 1) {
      callIndex++;
      const result = masteryExists ? [{ id: 'm-1' }] : [];
      return Promise.resolve(result);
    }
    // Third call is response probe (only reached if no mastery)
    if (callIndex === 2) {
      callIndex++;
      const result = answerExists ? [{ id: 'a-1' }] : [];
      return Promise.resolve(result);
    }
    return Promise.resolve([]);
  });

  const where = jest.fn(() => ({ limit }));
  const innerJoin = jest.fn(() => ({ where }));
  const from = jest.fn(() => ({ where, innerJoin }));
  const select = jest.fn(() => ({ from }));

  return { db: { select } as unknown as Db, select };
}

describe('ExamsService getRecommendation', () => {
  describe('newcomer detection', () => {
    it('treats a student with no mastery rows and no answers as a newcomer', async () => {
      const { db } = mockRecommendationDb(false, false);
      const service = new ExamsService(db);

      const result = await service.getRecommendation(USER_ID);

      expect(result.recommended.kind).toBe('diagnostic');
      expect(result.recommended.newcomer).toBe(true);
      expect(result.recommended.questionCount).toBe(10);
      expect(result.recommended.durationSeconds).toBe(15 * 60);
      expect(result.recommended.reason).toContain('Newcomer');
    });

    it('treats a student with mastery rows as non-newcomer', async () => {
      const { db } = mockRecommendationDb(true);
      const service = new ExamsService(db);

      const result = await service.getRecommendation(USER_ID);

      expect(result.recommended.kind).toBe('smart_mix');
      expect(result.recommended.newcomer).toBe(false);
      expect(result.recommended.questionCount).toBe(3); // 2 easy + 1 normal + 0 hard
      expect(result.recommended.durationSeconds).toBe(15 * 60);
      expect(result.recommended.reason).toContain('History');
    });

    it('treats a student with answer rows but no mastery as non-newcomer', async () => {
      const { db } = mockRecommendationDb(false, true);
      const service = new ExamsService(db);

      const result = await service.getRecommendation(USER_ID);

      expect(result.recommended.kind).toBe('smart_mix');
      expect(result.recommended.newcomer).toBe(false);
    });
  });

  describe('recommended structure', () => {
    it('returns diagnostic with correct fields for newcomer', async () => {
      const { db } = mockRecommendationDb(false, false);
      const service = new ExamsService(db);

      const result = await service.getRecommendation(USER_ID);

      expect(result.recommended).toEqual({
        kind: 'diagnostic',
        title: 'Diagnostic',
        questionCount: 10,
        durationSeconds: 15 * 60,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        reason: expect.stringContaining('Newcomer'),
        newcomer: true,
      });
    });

    it('returns smart_mix with correct fields for non-newcomer', async () => {
      const { db } = mockRecommendationDb(true);
      const service = new ExamsService(db);

      const result = await service.getRecommendation(USER_ID);

      expect(result.recommended).toEqual({
        kind: 'smart_mix',
        title: 'Smart Mix',
        questionCount: 3,
        durationSeconds: 15 * 60,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        reason: expect.stringContaining('History'),
        newcomer: false,
      });
    });
  });

  describe('alternatives list', () => {
    it('returns exactly 10 alternative kinds (per spec list)', async () => {
      const { db } = mockRecommendationDb(true);
      const service = new ExamsService(db);

      const result = await service.getRecommendation(USER_ID);

      expect(result.alternatives).toHaveLength(10);
    });

    it('includes all 10 kinds with correct titles and durations', async () => {
      const { db } = mockRecommendationDb(true);
      const service = new ExamsService(db);

      const result = await service.getRecommendation(USER_ID);

      const kinds = result.alternatives.map((a) => a.kind).sort();
      expect(kinds).toEqual([
        'debug_errors',
        'diagnostic',
        'due_review',
        'final_sim',
        'general_prep',
        'konkur_sim',
        'quiz_after_study',
        'smart_mix',
        'speed',
        'trap_finder',
      ]);

      // Check specific durations
      const diag = result.alternatives.find((a) => a.kind === 'diagnostic');
      expect(diag?.durationSeconds).toBe(15 * 60);
      expect(diag?.counts).toEqual({ easy: 0, normal: 0, hard: 0 });

      const konkurSim = result.alternatives.find(
        (a) => a.kind === 'konkur_sim',
      );
      expect(konkurSim?.durationSeconds).toBe(4 * 60 * 60);
      expect(konkurSim?.counts).toEqual({ easy: 0, normal: 0, hard: 0 });

      const finalSim = result.alternatives.find((a) => a.kind === 'final_sim');
      expect(finalSim?.durationSeconds).toBe(3 * 60 * 60);
      expect(finalSim?.counts).toEqual({ easy: 0, normal: 0, hard: 0 });

      const smartMix = result.alternatives.find((a) => a.kind === 'smart_mix');
      expect(smartMix?.durationSeconds).toBe(15 * 60);
      expect(smartMix?.counts).toEqual({ easy: 2, normal: 1, hard: 0 });
    });

    it('diagnostic, konkur_sim, final_sim have zero counts', async () => {
      const { db } = mockRecommendationDb(true);
      const service = new ExamsService(db);

      const result = await service.getRecommendation(USER_ID);

      const zeroCountKinds = ['diagnostic', 'konkur_sim', 'final_sim'];
      for (const kind of zeroCountKinds) {
        const alt = result.alternatives.find((a) => a.kind === kind);
        expect(alt?.counts).toEqual({ easy: 0, normal: 0, hard: 0 });
      }
    });

    it('other kinds have suggested counts { easy: 2, normal: 1, hard: 0 }', async () => {
      const { db } = mockRecommendationDb(true);
      const service = new ExamsService(db);

      const result = await service.getRecommendation(USER_ID);

      const nonZeroCountKinds = [
        'quiz_after_study',
        'debug_errors',
        'due_review',
        'speed',
        'trap_finder',
        'general_prep',
      ];
      for (const kind of nonZeroCountKinds) {
        const alt = result.alternatives.find((a) => a.kind === kind);
        expect(alt?.counts).toEqual({ easy: 2, normal: 1, hard: 0 });
      }
    });
  });

  describe('scoping', () => {
    it('uses the caller student ID (probes mastery for that student)', async () => {
      const { db, select } = mockRecommendationDb(true);
      const service = new ExamsService(db);

      await service.getRecommendation(USER_ID);

      // When mastery exists: student lookup + mastery probe = 2 select calls
      expect(select).toHaveBeenCalledTimes(2);
    });
  });
});

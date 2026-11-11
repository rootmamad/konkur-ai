import type { Db } from '../../db/db.module';
import type { ReferralsService } from '../referrals/referrals.service';
import { ExamsService } from './exams.service';

const USER_ID = '9f1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const STUDENT_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';
const ATTEMPT_ID = '7d1a9c3e-2b40-4d5a-9c8e-1a2b3c4d5e6f';

type Row = Record<string, unknown>;

type FinishHelpers = {
  requireStudentId(userId: string): Promise<string>;
  loadOwnedAttempt(
    executor: unknown,
    attemptId: string,
    studentId: string,
    lock?: boolean,
  ): Promise<unknown>;
  assertInProgress(status: string): void;
  gradeChoiceResponses(tx: unknown, rows: Row[]): Promise<number>;
  queueDescriptiveForReview(tx: unknown, rows: Row[]): Promise<void>;
};

/**
 * finishExam reaches the database only through private helpers; each is
 * stubbed so the hook wiring is what is actually under test. `events`
 * records ordering: the transaction commit vs the referral hook call.
 */
function setup(referrals?: ReferralsService, events: string[] = []) {
  const tx = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => Promise.resolve([])),
      })),
    })),
    update: jest.fn(() => ({
      set: jest.fn(() => ({
        where: jest.fn(() => Promise.resolve([])),
      })),
    })),
  };

  const transaction = jest.fn(
    async (callback: (t: typeof tx) => Promise<unknown>) => {
      events.push('tx-start');
      const result = await callback(tx);
      events.push('tx-commit');
      return result;
    },
  );

  const service = new ExamsService(
    { transaction } as unknown as Db,
    undefined,
    referrals,
  );
  const priv = service as unknown as FinishHelpers;

  jest.spyOn(priv, 'requireStudentId').mockResolvedValue(STUDENT_ID);
  jest
    .spyOn(priv, 'loadOwnedAttempt')
    .mockResolvedValue({ id: ATTEMPT_ID, status: 'in_progress' });
  jest.spyOn(priv, 'gradeChoiceResponses').mockResolvedValue(7);
  jest.spyOn(priv, 'queueDescriptiveForReview').mockResolvedValue(undefined);

  return { service, events };
}

function makeReferrals(events: string[] = []): {
  referrals: ReferralsService;
  onInviteeExamFinished: jest.Mock<Promise<void>, [string]>;
} {
  const onInviteeExamFinished = jest
    .fn<Promise<void>, [string]>()
    .mockImplementation(() => {
      events.push('hook');
      return Promise.resolve();
    });
  return {
    referrals: { onInviteeExamFinished } as unknown as ReferralsService,
    onInviteeExamFinished,
  };
}

describe('ExamsService.finishExam referral hook (spec 11)', () => {
  it('invokes the referral hook with the finishing student id after commit', async () => {
    const events: string[] = [];
    const { referrals, onInviteeExamFinished } = makeReferrals(events);
    const { service } = setup(referrals, events);

    const result = await service.finishExam(ATTEMPT_ID, USER_ID);

    expect(result).toEqual({ totalScore: 7, pendingDescriptive: 0 });
    expect(onInviteeExamFinished).toHaveBeenCalledTimes(1);
    expect(onInviteeExamFinished).toHaveBeenCalledWith(STUDENT_ID);
    // The hook fires only after the finish transaction has committed.
    expect(events).toEqual(['tx-start', 'tx-commit', 'hook']);
  });

  it('a rejecting referral hook never affects the exam result', async () => {
    const { referrals, onInviteeExamFinished } = makeReferrals();
    onInviteeExamFinished.mockRejectedValue(new Error('referral db down'));
    const { service } = setup(referrals);

    const result = await service.finishExam(ATTEMPT_ID, USER_ID);

    expect(result).toEqual({ totalScore: 7, pendingDescriptive: 0 });
  });

  it('no referrals service wired (unit construction) -> no crash', async () => {
    const { service } = setup(undefined);

    const result = await service.finishExam(ATTEMPT_ID, USER_ID);

    expect(result).toEqual({ totalScore: 7, pendingDescriptive: 0 });
  });
});

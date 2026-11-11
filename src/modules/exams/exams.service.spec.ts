import { BadRequestException } from '@nestjs/common';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { Db } from '../../db/db.module';
import { QuestionType } from '../questions/enums/question-type.enum';
import type { CountsDto, StartExamDto } from './dto/start-exam.dto';
import { ExamsService } from './exams.service';

const TOPIC_ID = '6f1f4c2e-0b1a-4c3d-9f2e-2c7b5a4d8e11';
const STUDENT_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';
const CLIENT_KEY = 'a3f0c1d2-4b5e-4f6a-9b7c-8d9e0f1a2b3c';

const dialect = new PgDialect();

type DtoWithCounts = StartExamDto & {
  counts: CountsDto;
  durationSeconds: number;
};

function makeDto(overrides: Partial<DtoWithCounts> = {}): DtoWithCounts {
  return {
    questionType: QuestionType.MULTIPLE_CHOICE,
    kind: 'quiz_after_study',
    counts: { easy: 0, normal: 0, hard: 0 },
    durationSeconds: 600,
    ...overrides,
  };
}

/**
 * Minimal Drizzle stand-in: the selection helpers only use
 * `select().from().where().orderBy().limit()`. One result set per difficulty
 * bucket, in call order.
 */
function mockDb(rowsPerQuery: string[][] = []) {
  const conditions: SQL[] = [];
  let call = 0;

  const limit = jest.fn(() =>
    Promise.resolve((rowsPerQuery[call++] ?? []).map((id) => ({ id }))),
  );
  const orderBy = jest.fn(() => ({ limit }));
  const where = jest.fn((condition: SQL) => {
    conditions.push(condition);
    return { orderBy };
  });
  const from = jest.fn(() => ({ where }));
  const select = jest.fn(() => ({ from }));

  return { db: { select } as unknown as Db, select, conditions };
}

function callSelectQuestionIds(
  service: ExamsService,
  dto: DtoWithCounts,
  studentId: string,
): Promise<string[]> {
  const privateService = service as unknown as {
    selectQuestionIds(dto: DtoWithCounts, studentId: string): Promise<string[]>;
  };
  return privateService.selectQuestionIds(dto, studentId);
}

describe('ExamsService quiz_after_study selection', () => {
  it('limits every difficulty bucket to the chosen topic', async () => {
    const { db, select, conditions } = mockDb([
      ['q-easy-1', 'q-easy-2'],
      ['q-normal-1'],
    ]);
    const service = new ExamsService(db);

    const ids = await callSelectQuestionIds(
      service,
      makeDto({
        topicId: TOPIC_ID,
        counts: { easy: 2, normal: 1, hard: 0 },
      }),
      STUDENT_ID,
    );

    expect(ids.sort()).toEqual(['q-easy-1', 'q-easy-2', 'q-normal-1']);
    // The empty "hard" bucket is skipped, so one query per non-zero bucket.
    expect(select).toHaveBeenCalledTimes(2);

    for (const condition of conditions) {
      const { sql: text, params } = dialect.sqlToQuery(condition);
      expect(text).toContain('"question"."topic_id" =');
      expect(text).toContain('"question"."status" =');
      expect(text).toContain('"question"."type" =');
      expect(text).toContain('"question"."difficulty_ai" =');
      expect(text).toContain('NOT EXISTS');
      expect(params).toContain(TOPIC_ID);
      expect(params).toContain(STUDENT_ID);
    }
  });

  it('returns partial results when the topic has fewer questions', async () => {
    const { db } = mockDb([['q-easy-1', 'q-easy-2']]);
    const service = new ExamsService(db);

    const ids = await callSelectQuestionIds(
      service,
      makeDto({ topicId: TOPIC_ID, counts: { easy: 3, normal: 0, hard: 0 } }),
      STUDENT_ID,
    );

    expect(ids.sort()).toEqual(['q-easy-1', 'q-easy-2']);
  });

  it('rejects a quiz_after_study start without topicId (HTTP 400)', async () => {
    const { db, select } = mockDb();
    const service = new ExamsService(db);
    const spyTarget = service as unknown as {
      requireStudentId(userId: string): Promise<string>;
      findSessionByKey(key: string): Promise<null>;
      hasPaidPlan(userId: string): Promise<boolean>;
      getFreeQuizLimit(): Promise<number>;
      getFreeQuizMaxQuestions(): Promise<number>;
      countQuizUsage(studentId: string): Promise<number>;
    };
    jest.spyOn(spyTarget, 'requireStudentId').mockResolvedValue(STUDENT_ID);
    jest.spyOn(spyTarget, 'findSessionByKey').mockResolvedValue(null);
    jest.spyOn(spyTarget, 'hasPaidPlan').mockResolvedValue(false);
    jest.spyOn(spyTarget, 'getFreeQuizLimit').mockResolvedValue(3);
    jest.spyOn(spyTarget, 'getFreeQuizMaxQuestions').mockResolvedValue(10);
    jest.spyOn(spyTarget, 'countQuizUsage').mockResolvedValue(0);

    const start = service.startExam(
      'user-1',
      makeDto({ counts: { easy: 1, normal: 0, hard: 0 } }),
      CLIENT_KEY,
    );

    await expect(start).rejects.toBeInstanceOf(BadRequestException);
    await expect(start).rejects.toThrow(/topicId is required/);
    expect(select).not.toHaveBeenCalled();
  });

  it('ignores topicId for other quiz kinds', async () => {
    const { db, conditions } = mockDb([['q-a'], ['q-b']]);
    const service = new ExamsService(db);

    const ids = await callSelectQuestionIds(
      service,
      makeDto({
        kind: 'general_prep',
        topicId: TOPIC_ID,
        counts: { easy: 1, normal: 1, hard: 0 },
      }),
      STUDENT_ID,
    );

    expect(ids.sort()).toEqual(['q-a', 'q-b']);
    for (const condition of conditions) {
      expect(dialect.sqlToQuery(condition).sql).not.toContain('topic_id');
    }
  });
});

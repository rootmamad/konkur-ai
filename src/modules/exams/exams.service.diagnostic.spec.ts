import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { Db } from '../../db/db.module';
import { question } from '../../db/schema/question';
import { student } from '../../db/schema/student';
import { QuestionType } from '../questions/enums/question-type.enum';
import { DIAGNOSTIC_QUESTION_COUNT } from './exam.constants';
import { ExamsService } from './exams.service';

const STUDENT_ID = '0b6a2d3c-1e4f-4a5b-8c6d-7e8f9a0b1c2d';
const TOPIC_A = '4d3c2b1a-0f9e-4d8c-7b6a-5f4e3d2c1b0a';
const TOPIC_B = '5e4d3c2b-1a0f-4e9d-8c7b-6a5f4e3d2c1b';

const MC_IDS = ['mc-1', 'mc-2', 'mc-3', 'mc-4', 'mc-5'];
const DESCRIPTIVE_IDS = ['d-1', 'd-2', 'd-3', 'd-4', 'd-5'];
const GLOBAL_IDS = [
  'g-1',
  'g-2',
  'g-3',
  'g-4',
  'g-5',
  'g-6',
  'g-7',
  'g-8',
  'g-9',
  'g-10',
];

type QueryRecord = {
  table: 'student' | 'question' | 'other';
  sql: string;
  params: unknown[];
  limit?: number;
};

type Pools = {
  studiedTopicIds?: string[] | null;
  hasStudentRow?: boolean;
  multipleChoice?: string[];
  descriptive?: string[];
  unfiltered?: string[];
};

/** Rows the fake database returns for one select, by table and filters. */
function resolveRows(
  table: QueryRecord['table'],
  params: unknown[],
  pools: Pools,
): unknown[] {
  if (table === 'student') {
    return pools.hasStudentRow === false
      ? []
      : [{ studiedTopicIds: pools.studiedTopicIds ?? [] }];
  }
  if (params.includes(QuestionType.MULTIPLE_CHOICE)) {
    return (pools.multipleChoice ?? []).map((id) => ({ id }));
  }
  if (params.includes(QuestionType.DESCRIPTIVE)) {
    return (pools.descriptive ?? []).map((id) => ({ id }));
  }
  return (pools.unfiltered ?? []).map((id) => ({ id }));
}

/**
 * Records every select and compiles its WHERE clause with the real pg dialect,
 * so the assertions read the column names and bound params the database would
 * see. Question rows come from the pool matching the type param, which also
 * proves each half of the diagnostic is its own query.
 */
function diagnosticDb(pools: Pools): { db: Db; queries: QueryRecord[] } {
  const dialect = new PgDialect();
  const queries: QueryRecord[] = [];

  const select = jest.fn(() => ({
    from(source: unknown) {
      const table: QueryRecord['table'] =
        source === student
          ? 'student'
          : source === question
            ? 'question'
            : 'other';
      const record: QueryRecord = { table, sql: '', params: [] };

      const limit = (count: number) => {
        record.limit = count;
        return Promise.resolve(resolveRows(table, record.params, pools));
      };

      return {
        where(condition?: SQL) {
          if (condition) {
            const compiled = dialect.sqlToQuery(condition);
            record.sql = compiled.sql;
            record.params = compiled.params;
          }
          queries.push(record);
          return { orderBy: () => ({ limit }), limit };
        },
      };
    },
  }));

  return { db: { select } as unknown as Db, queries };
}

function runDiagnostic(service: ExamsService): Promise<string[]> {
  return (
    service as unknown as { selectDiagnostic(id: string): Promise<string[]> }
  ).selectDiagnostic(STUDENT_ID);
}

describe('ExamsService diagnostic selection (spec\u00a03.3)', () => {
  it('draws five multiple-choice plus five descriptive basic questions from the studied topics', async () => {
    const { db, queries } = diagnosticDb({
      studiedTopicIds: [TOPIC_A, TOPIC_B],
      multipleChoice: MC_IDS,
      descriptive: DESCRIPTIVE_IDS,
    });

    const ids = await runDiagnostic(new ExamsService(db));

    expect(ids).toHaveLength(DIAGNOSTIC_QUESTION_COUNT);
    expect([...ids].sort()).toEqual([...MC_IDS, ...DESCRIPTIVE_IDS].sort());
    expect(queries).toHaveLength(3);

    const [studentQuery, choiceQuery, descriptiveQuery] = queries;

    expect(studentQuery.table).toBe('student');
    expect(studentQuery.params).toEqual([STUDENT_ID]);

    // Multiple-choice half: five rows, published, basic, studied topics only.
    expect(choiceQuery.table).toBe('question');
    expect(choiceQuery.limit).toBe(5);
    expect(choiceQuery.params).toEqual([
      'published',
      QuestionType.MULTIPLE_CHOICE,
      1,
      TOPIC_A,
      TOPIC_B,
    ]);
    expect(choiceQuery.sql).toContain('"question"."type" =');
    expect(choiceQuery.sql).toContain('"question"."difficulty_ai" =');
    expect(choiceQuery.sql).toContain('"question"."topic_id" in');

    // The short-answer half is descriptive, never fill_blank or true_false.
    expect(descriptiveQuery.table).toBe('question');
    expect(descriptiveQuery.limit).toBe(5);
    expect(descriptiveQuery.params).toEqual([
      'published',
      QuestionType.DESCRIPTIVE,
      1,
      TOPIC_A,
      TOPIC_B,
    ]);
    expect(descriptiveQuery.sql).toContain('"question"."type" =');
    expect(descriptiveQuery.sql).toContain('"question"."topic_id" in');

    for (const query of queries) {
      expect(query.params).not.toContain(QuestionType.TRUE_FALSE);
      expect(query.params).not.toContain(QuestionType.FILL_BLANK);
    }
  });

  it('keeps partial results when a half is short instead of filling from elsewhere', async () => {
    const { db, queries } = diagnosticDb({
      studiedTopicIds: [TOPIC_A],
      multipleChoice: ['mc-1', 'mc-2', 'mc-3'],
      descriptive: [],
    });

    const ids = await runDiagnostic(new ExamsService(db));

    expect([...ids].sort()).toEqual(['mc-1', 'mc-2', 'mc-3']);
    // Student row + one query per half, and no top-up query of any kind.
    expect(queries).toHaveLength(3);
    expect(queries[1].limit).toBe(5);
    expect(queries[2].limit).toBe(5);
  });

  it('keeps the global random ten when the student has no studied topics', async () => {
    const { db, queries } = diagnosticDb({
      studiedTopicIds: [],
      unfiltered: GLOBAL_IDS,
    });

    const ids = await runDiagnostic(new ExamsService(db));

    expect([...ids].sort()).toEqual([...GLOBAL_IDS].sort());
    expect(queries).toHaveLength(2);

    const legacy = queries[1];
    expect(legacy.limit).toBe(DIAGNOSTIC_QUESTION_COUNT);
    expect(legacy.params).toEqual(['published']);
    expect(legacy.sql).not.toContain('"question"."type"');
    expect(legacy.sql).not.toContain('"question"."topic_id"');
    expect(legacy.sql).not.toContain('"question"."difficulty_ai"');
  });

  it('treats a null studied-topics column as an empty list', async () => {
    const { db, queries } = diagnosticDb({
      studiedTopicIds: null,
      unfiltered: ['g-1'],
    });

    const ids = await runDiagnostic(new ExamsService(db));

    expect(ids).toEqual(['g-1']);
    expect(queries).toHaveLength(2);
    expect(queries[1].limit).toBe(DIAGNOSTIC_QUESTION_COUNT);
  });

  it('falls back to the global pool when the student row is missing', async () => {
    const { db, queries } = diagnosticDb({
      hasStudentRow: false,
      unfiltered: ['g-1', 'g-2'],
    });

    const ids = await runDiagnostic(new ExamsService(db));

    expect([...ids].sort()).toEqual(['g-1', 'g-2']);
    expect(queries).toHaveLength(2);
    expect(queries[1].params).toEqual(['published']);
  });
});

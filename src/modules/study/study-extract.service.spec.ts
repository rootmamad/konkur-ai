import { AIService } from '../ai/ai.service';
import { SEVEN_CLAUSES } from '../chat/chat-ai.service';
import {
  buildStudyExtractPrompt,
  parseStudyExtract,
  STUDY_EXTRACT_OPERATION,
  STUDY_EXTRACT_PROMPT_VERSION,
  StudyExtractService,
} from './study-extract.service';

const USER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const STUDENT_TEXT = 'امروز ۴۵ دقیقه مشتق خوندم و ۱۰ تمرین زدم، بعضی‌هاش سختی';

/** Model stub whose happy path runs the REAL parse (like runJob). */
function makeAi(raw?: string | Error) {
  const runJob = jest.fn(
    (input: {
      parse?: (raw: string) => unknown;
      operation?: string;
      promptVersion?: string;
      prompt?: string;
    }) => {
      if (raw instanceof Error) return Promise.reject(raw);
      if (!input.parse) {
        return Promise.reject(new Error('parse required in this test'));
      }
      try {
        return Promise.resolve(input.parse(raw as string));
      } catch (err: unknown) {
        return Promise.reject(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    },
  );
  return { service: { runJob } as unknown as AIService, runJob };
}

describe('parseStudyExtract — DTO-exact validation', () => {
  const GOOD =
    '{"lesson":"ریاضی — مشتق","topic":"قاعده زنجیره‌ای","activity":"learning","minutes":45,"exerciseCount":10,"feeling":"vague","note":"تمرین ۳ را نتوانستم","uncertain":true}';

  it('accepts a full record, trims text, and keeps the uncertain flag', () => {
    expect(
      parseStudyExtract(
        '{"lesson":"  ریاضی — مشتق  ","activity":"learning","minutes":45,"topic":"  قاعده زنجیره‌ای  ","exerciseCount":10,"feeling":"vague","note":"  تمری ن  ","uncertain":true}',
      ),
    ).toEqual({
      lesson: 'ریاضی — مشتق',
      topic: 'قاعده زنجیره‌ای',
      activity: 'learning',
      minutes: 45,
      exerciseCount: 10,
      feeling: 'vague',
      note: 'تمری ن',
      uncertain: true,
    });
  });

  it('omits absent optionals instead of writing nulls', () => {
    expect(
      parseStudyExtract(
        '{"lesson":"زیست","activity":"review","minutes":20,"uncertain":false}',
      ),
    ).toEqual({
      lesson: 'زیست',
      activity: 'review',
      minutes: 20,
      uncertain: false,
    });
  });

  it('the full record parses (fixture sanity)', () => {
    expect(parseStudyExtract(GOOD).lesson).toBe('ریاضی — مشتق');
  });

  it.each([
    ['non-JSON', 'یک رکورد'],
    ['non-object JSON', '[]'],
    [
      'empty lesson',
      '{"lesson":"   ","activity":"learning","minutes":45,"uncertain":false}',
    ],
    [
      'missing lesson',
      '{"activity":"learning","minutes":45,"uncertain":false}',
    ],
    [
      'oversized lesson',
      `{"lesson":"${'ل'.repeat(201)}","activity":"learning","minutes":45,"uncertain":false}`,
    ],
    [
      'unknown activity',
      '{"lesson":"ریاضی","activity":"gym","minutes":45,"uncertain":false}',
    ],
    [
      'minutes 0',
      '{"lesson":"ریاضی","activity":"learning","minutes":0,"uncertain":false}',
    ],
    [
      'minutes 601',
      '{"lesson":"ریاضی","activity":"learning","minutes":601,"uncertain":false}',
    ],
    [
      'fractional minutes',
      '{"lesson":"ریاضی","activity":"learning","minutes":30.5,"uncertain":false}',
    ],
    [
      'string minutes',
      '{"lesson":"ریاضی","activity":"learning","minutes":"45","uncertain":false}',
    ],
    [
      'exerciseCount above 10000',
      '{"lesson":"ریاضی","activity":"exercise","minutes":45,"exerciseCount":10001,"uncertain":false}',
    ],
    [
      'unknown feeling',
      '{"lesson":"ریاضی","activity":"learning","minutes":45,"feeling":"tired","uncertain":false}',
    ],
    [
      'oversized note',
      `{"lesson":"ریاضی","activity":"learning","minutes":45,"note":"${'ن'.repeat(1001)}","uncertain":false}`,
    ],
    [
      'missing uncertain',
      '{"lesson":"ریاضی","activity":"learning","minutes":45}',
    ],
    [
      'non-boolean uncertain',
      '{"lesson":"ریاضی","activity":"learning","minutes":45,"uncertain":"no"}',
    ],
  ])('rejects %s', (_name, raw) => {
    expect(() => parseStudyExtract(raw)).toThrow();
  });
});

describe('StudyExtractService.extractPreview (spec 3.6 path 1)', () => {
  const GOOD =
    '{"lesson":"ریاضی — مشتق","activity":"learning","minutes":45,"exerciseCount":10,"feeling":"vague","note":"تمرین ۳ را نتوانستم","uncertain":false}';

  it('returns the preview and the prompt carries clauses, enums, rules, and the text', async () => {
    const { service: aiService, runJob } = makeAi(GOOD);
    const service = new StudyExtractService(aiService);

    const result = await service.extractPreview(USER_ID, STUDENT_TEXT);

    expect(result).toEqual({
      preview: {
        lesson: 'ریاضی — مشتق',
        activity: 'learning',
        minutes: 45,
        exerciseCount: 10,
        feeling: 'vague',
        note: 'تمرین ۳ را نتوانستم',
        uncertain: false,
      },
    });

    expect(runJob).toHaveBeenCalledTimes(1);
    const input = runJob.mock.calls[0][0] as {
      operation: string;
      promptVersion: string;
      prompt: string;
    };
    expect(input.operation).toBe(STUDY_EXTRACT_OPERATION);
    expect(input.operation).toBe('study_extract');
    expect(input.promptVersion).toBe(STUDY_EXTRACT_PROMPT_VERSION);
    expect(input.promptVersion).toBe('study-extract-v1');
    expect(input.prompt).toContain(SEVEN_CLAUSES);
    expect(input.prompt).toContain(
      'learning | exercise | test | review | teaching',
    );
    expect(input.prompt).toContain('clear | vague');
    expect(input.prompt).toContain('حداکثر 200 نویسه');
    expect(input.prompt).toContain('حداکثر 1000 نویسه');
    expect(input.prompt).toContain('بین 1 تا 600');
    expect(input.prompt).toContain(STUDENT_TEXT);
  });

  it('persists nothing — the extract service has no database dependency', () => {
    // The class cannot write: its constructor takes only AIService and no
    // executor, so the preview path has no insert to call (spec 3.6:
    // «بدون تأیید چیزی ثبت نمی‌شود»).
    const { service: aiService } = makeAi();
    const service = new StudyExtractService(aiService);
    expect((service as unknown as Record<string, unknown>).db).toBeUndefined();
    expect((StudyExtractService as unknown as { length: number }).length).toBe(
      1,
    );
  });

  it('a model failure becomes the ai_unavailable notice envelope, never a 500', async () => {
    const { service: aiService, runJob } = makeAi(
      new Error('AI request failed: boom'),
    );
    const service = new StudyExtractService(aiService);

    await expect(
      service.extractPreview(USER_ID, STUDENT_TEXT),
    ).resolves.toEqual({ preview: null, notice: 'ai_unavailable' });
    expect(runJob).toHaveBeenCalledTimes(1);
  });
});

describe('buildStudyExtractPrompt — pure contract', () => {
  it('carries the clauses verbatim and forbids invented fields and totals', () => {
    const prompt = buildStudyExtractPrompt({ text: STUDENT_TEXT });

    expect(prompt).toContain(SEVEN_CLAUSES);
    expect(prompt).toContain('هیچ فیلدی غیر از فیلدهای بالا نساز');
    expect(prompt).toContain('مجموع دقیقه‌ها');
    expect(prompt).toContain('"uncertain":false');
    expect(prompt).toContain('متن دانش‌آموز:');
    expect(prompt).toContain(STUDENT_TEXT);
  });
});

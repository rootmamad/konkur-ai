import { Injectable, Inject, NotFoundException, ForbiddenException } from '@nestjs/common';
import { DB } from '../../db/db.module';
import type { Db } from '../../db/db.module';
import { examTemplate } from '../../db/schema/exam';
import { examInstance } from '../../db/schema/exam';
import { attempt } from '../../db/schema/attempt';
import { response } from '../../db/schema/response';
import { question } from '../../db/schema/question';
import { student } from '../../db/schema/student';
import { answerKey } from '../../db/schema/answer-key';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { QuestionType } from '../questions/enums/question-type.enum';
import { StartExamDto } from './dto/start-exam.dto';
import { SubmitAnswerDto } from './dto/submit-answer.dto';

export interface ExamAttemptResult {
  attemptId: string;
  questionOrder: string[];
  durationSeconds: number;
  startedAt: Date;
}

export interface QuestionForExam {
  id: string;
  version: number;
  type: QuestionType;
  text: string;
  contentBlocks: unknown[];
  options: unknown[];
  subject: string;
}

@Injectable()
export class ExamsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async startExam(
    userId: string,
    questionType: QuestionType,
    counts: { easy: number; normal: number; hard: number },
    durationSeconds: number,
  ): Promise<ExamAttemptResult> {
    // Get student by account ID
    const studentRows = await this.db
      .select({ id: student.id })
      .from(student)
      .where(eq(student.accountId, userId))
      .limit(1);

    if (studentRows.length === 0) {
      throw new NotFoundException('Student profile not found');
    }

    const studentId = studentRows[0].id;

    // Build question selection criteria
    const totalCount = counts.easy + counts.normal + counts.hard;
    if (totalCount === 0) {
      throw new Error('At least one question must be selected');
    }

    // Select random questions matching criteria
    const selectedQuestions: QuestionForExam[] = [];

    // For each difficulty level
    const difficulties = [
      { level: 1, count: counts.easy },
      { level: 2, count: counts.normal },
      { level: 3, count: counts.hard },
    ];

    for (const { level, count } of difficulties) {
      if (count > 0) {
        const questions = await this.db
          .select({
            id: question.id,
            version: question.version,
            type: question.type,
            text: question.text,
            contentBlocks: question.contentBlocks,
            options: question.options,
            subject: question.subject,
          })
          .from(question)
          .where(
            and(
              sql`${question.status} = 'published'`,
              sql`${question.type} = ${questionType}`,
              eq(question.difficultyAi, level),
            ),
          )
          .orderBy(sql`random()`)
          .limit(count);

        selectedQuestions.push(...questions.map(q => ({
          ...q,
          type: q.type as QuestionType,
          contentBlocks: (q.contentBlocks as unknown[]) ?? [],
          options: (q.options as unknown[]) ?? [],
        })));
      }
    }

    if (selectedQuestions.length === 0) {
      throw new Error('No questions found matching criteria');
    }

    // Shuffle the selected questions
    for (let i = selectedQuestions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [selectedQuestions[i], selectedQuestions[j]] = [
        selectedQuestions[j],
        selectedQuestions[i],
      ];
    }

    // Get or create a template for this type
    const templateRows = await this.db
      .select()
      .from(examTemplate)
      .where(eq(examTemplate.kind, 'smart_mix'))
      .limit(1);

    let templateId: string;
    if (templateRows.length > 0) {
      templateId = templateRows[0].id;
    } else {
      const newTemplate = await this.db
        .insert(examTemplate)
        .values({
          kind: 'smart_mix',
          title: 'Smart Mix Exam',
          config: { questionType, counts },
          settingsVersion: 1,
        })
        .returning({ id: examTemplate.id });
      templateId = newTemplate[0].id;
    }

    // Create exam instance with frozen question order
    const instance = await this.db
      .insert(examInstance)
      .values({
        templateId,
        questionOrder: selectedQuestions.map((q) => q.id),
        settingsSnapshot: {
          questionType,
          counts,
          durationSeconds,
          generatedAt: new Date().toISOString(),
        },
      })
      .returning({ id: examInstance.id });

    const instanceId = instance[0].id;

    // Create attempt
    const idempotencyKey = `exam-${studentId}-${instanceId}-${Date.now()}`;
    const attemptResult = await this.db
      .insert(attempt)
      .values({
        studentId,
        examInstanceId: instanceId,
        status: 'in_progress',
        idempotencyKey,
      })
      .returning({ id: attempt.id });

    const attemptId = attemptResult[0].id;

    return {
      attemptId,
      questionOrder: selectedQuestions.map((q) => q.id),
      durationSeconds,
      startedAt: new Date(),
    };
  }

  async submitAnswer(
    attemptId: string,
    userId: string,
    questionIndex: number,
    answer: number | string,
  ): Promise<void> {
    // Verify attempt belongs to user
    const studentRows = await this.db
      .select({ id: student.id })
      .from(student)
      .where(eq(student.accountId, userId))
      .limit(1);

    if (studentRows.length === 0) {
      throw new NotFoundException('Student profile not found');
    }

    const studentId = studentRows[0].id;

    const attemptRows = await this.db
      .select()
      .from(attempt)
      .where(and(eq(attempt.id, attemptId), eq(attempt.studentId, studentId)))
      .limit(1);

    if (attemptRows.length === 0) {
      throw new NotFoundException('Attempt not found or access denied');
    }

    const attemptRecord = attemptRows[0];

    if (attemptRecord.status !== 'in_progress') {
      throw new ForbiddenException('Attempt is not in progress');
    }

    // Get exam instance to find question at index
    const instanceRows = await this.db
      .select()
      .from(examInstance)
      .where(eq(examInstance.id, attemptRecord.examInstanceId))
      .limit(1);

    if (instanceRows.length === 0) {
      throw new NotFoundException('Exam instance not found');
    }

    const questionOrder = instanceRows[0].questionOrder as string[];
    if (questionIndex < 0 || questionIndex >= questionOrder.length) {
      throw new Error('Invalid question index');
    }

    const questionId = questionOrder[questionIndex];

    // Get question details for version
    const questionRows = await this.db
      .select({ id: question.id, version: question.version, type: question.type })
      .from(question)
      .where(eq(question.id, questionId))
      .limit(1);

    if (questionRows.length === 0) {
      throw new NotFoundException('Question not found');
    }

    const questionRecord = questionRows[0];

    // Check if response already exists for this attempt + question
    const existingResponse = await this.db
      .select({ id: response.id, attemptNumber: response.attemptNumber })
      .from(response)
      .where(
        and(
          eq(response.attemptId, attemptId),
          eq(response.questionId, questionId),
        ),
      )
      .orderBy(desc(response.attemptNumber))
      .limit(1);

    const nextAttemptNumber = existingResponse.length > 0
      ? existingResponse[0].attemptNumber + 1
      : 1;

    // Insert response
    await this.db.insert(response).values({
      attemptId,
      questionId,
      questionVersion: questionRecord.version,
      selectedOption: typeof answer === 'number' ? answer : null,
      textAnswer: typeof answer === 'string' ? answer : null,
      attemptNumber: nextAttemptNumber,
      answeredAt: new Date(),
    });
  }

  async finishExam(attemptId: string, userId: string): Promise<{ totalScore: number }> {
    // Verify attempt belongs to user
    const studentRows = await this.db
      .select({ id: student.id })
      .from(student)
      .where(eq(student.accountId, userId))
      .limit(1);

    if (studentRows.length === 0) {
      throw new NotFoundException('Student profile not found');
    }

    const studentId = studentRows[0].id;

    const attemptRows = await this.db
      .select()
      .from(attempt)
      .where(and(eq(attempt.id, attemptId), eq(attempt.studentId, studentId)))
      .limit(1);

    if (attemptRows.length === 0) {
      throw new NotFoundException('Attempt not found or access denied');
    }

    const attemptRecord = attemptRows[0];

    if (attemptRecord.status !== 'in_progress') {
      throw new ForbiddenException('Attempt is not in progress');
    }

    // Get all responses for this attempt
    const responses = await this.db
      .select()
      .from(response)
      .where(eq(response.attemptId, attemptId));

    // Grade responses
    let totalScore = 0;

    for (const resp of responses) {
      // Get answer key
      const answerKeyRows = await this.db
        .select()
        .from(answerKey)
        .where(
          and(
            eq(answerKey.questionId, resp.questionId),
            eq(answerKey.questionVersion, resp.questionVersion),
          ),
        )
        .limit(1);

      if (answerKeyRows.length > 0) {
        const ak = answerKeyRows[0];
        let isCorrect = false;

        if (ak.correctOptionIndex !== null && resp.selectedOption !== null) {
          isCorrect = ak.correctOptionIndex === resp.selectedOption;
        } else if (ak.correctText && resp.textAnswer) {
          isCorrect = ak.correctText.trim().toLowerCase() === resp.textAnswer.trim().toLowerCase();
        }

        await this.db
          .update(response)
          .set({ isCorrect })
          .where(eq(response.id, resp.id));

        if (isCorrect) {
          totalScore += 1; // Simple scoring: 1 point per correct answer
        }
      }
    }

    // Update attempt status
    await this.db
      .update(attempt)
      .set({
        status: 'submitted',
        submittedAt: new Date(),
        totalScore,
      })
      .where(eq(attempt.id, attemptId));

    return { totalScore };
  }

  async getExamAttempt(attemptId: string, userId: string): Promise<any> {
    const studentRows = await this.db
      .select({ id: student.id })
      .from(student)
      .where(eq(student.accountId, userId))
      .limit(1);

    if (studentRows.length === 0) {
      throw new NotFoundException('Student profile not found');
    }

    const studentId = studentRows[0].id;

    const attemptRows = await this.db
      .select()
      .from(attempt)
      .where(and(eq(attempt.id, attemptId), eq(attempt.studentId, studentId)))
      .limit(1);

    if (attemptRows.length === 0) {
      throw new NotFoundException('Attempt not found or access denied');
    }

    const attemptRecord = attemptRows[0];

    // Get responses
    const responses = await this.db
      .select()
      .from(response)
      .where(eq(response.attemptId, attemptId));

    return {
      ...attemptRecord,
      responses,
    };
  }

  async getUserExams(userId: string): Promise<any[]> {
    const studentRows = await this.db
      .select({ id: student.id })
      .from(student)
      .where(eq(student.accountId, userId))
      .limit(1);

    if (studentRows.length === 0) {
      throw new NotFoundException('Student profile not found');
    }

    const studentId = studentRows[0].id;

    const attempts = await this.db
      .select()
      .from(attempt)
      .where(eq(attempt.studentId, studentId))
      .orderBy(desc(attempt.startedAt))
      .limit(50);

    return attempts;
  }
}
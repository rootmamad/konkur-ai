import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { ExamAttempt, ExamAttemptDocument } from './exam-attempt.schema';
import { QuestionsService } from '../questions/questions.service';
import { QuestionType } from '../questions/schemas/question.schema';
import { AIService } from '../ai/ai.service';

@Injectable()
export class ExamsService {
  constructor(
    @InjectModel(ExamAttempt.name)
    private readonly examAttemptModel: Model<ExamAttemptDocument>,
    private readonly questionsService: QuestionsService,
    private readonly aiService: AIService,
  ) {}

  /**
   * Start a new exam attempt for a user
   * @param userId - The ID of the user taking the exam
   * @param questionType - The type of questions for the exam (multiple_choice or text_answer)
   * @param counts - Object specifying how many questions of each difficulty to include
   * @param durationSeconds - Total time allowed for the exam in seconds
   * @returns The created exam attempt (without the correct answers exposed)
   */
  async startExam(
    userId: string,
    questionType: QuestionType,
    counts: { easy: number; normal: number; hard: number },
    durationSeconds: number,
): Promise<{
     attemptId: string;
     questions: Array<{
       id: string;
       text: string;
       options: string[]; // For multiple choice questions (empty for text questions)
       questionType: 'multiple_choice' | 'text_answer';
     }>;
   }> {
    // Validate counts
    if (
      counts.easy < 0 ||
      counts.normal < 0 ||
      counts.hard < 0 ||
      (counts.easy + counts.normal + counts.hard) === 0
    ) {
      throw new BadRequestException(
        'At least one question must be specified for the exam',
      );
    }

// Build difficulty filters for each level
  const difficultyFilters = {
    easy: { difficulty: { $lte: 2 }, questionType }, // Easy: difficulty 1-2
    normal: { difficulty: { $gte: 3, $lte: 4 }, questionType }, // Normal: difficulty 3-4
    hard: { difficulty: { $gte: 5 }, questionType }, // Hard: difficulty 5
  };

    // Fetch questions for each difficulty level, filtered by questionType
    const [easyQuestions, normalQuestions, hardQuestions] =
      await Promise.all([
        this.questionsService.getRandomQuestions(
          counts.easy,
          difficultyFilters.easy,
        ),
        this.questionsService.getRandomQuestions(
          counts.normal,
          difficultyFilters.normal,
        ),
        this.questionsService.getRandomQuestions(
          counts.hard,
          difficultyFilters.hard,
        ),
      ]);

    // Combine and shuffle questions
    const allQuestions = [
      ...easyQuestions.map((q) => ({ ...q, difficulty: 'easy' })),
      ...normalQuestions.map((q) => ({ ...q, difficulty: 'normal' })),
      ...hardQuestions.map((q) => ({ ...q, difficulty: 'hard' })),
    ];

    // Shuffle the array (Fisher-Yates algorithm)
    for (let i = allQuestions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allQuestions[i], allQuestions[j]] = [
        allQuestions[j],
        allQuestions[i],
      ];
    }

    // Create the exam attempt record
    const attempt = new this.examAttemptModel({
      userId: new Types.ObjectId(userId),
      startTime: new Date(),
      durationSeconds,
answers: allQuestions.map((q) => ({
         questionId: q._id as Types.ObjectId,
         questionType: q.questionType,
       })),
    });

    const savedAttempt = await attempt.save();

// Prepare the questions to return to the user (without correct answers)
     const questionsForUser = allQuestions.map((q) => ({
       id: q._id.toString(),
       text: q.text ?? '',
       options: q.options ?? [],
       questionType:
         q.questionType === QuestionType.MULTIPLE_CHOICE
       ? ('multiple_choice' as const)
      : ('text_answer' as const),
     }));

     return {
       attemptId: (savedAttempt._id as Types.ObjectId).toString(),
       questions: questionsForUser,
     };
  }

  /**
   * Submit an answer for a question in an exam attempt
   * @param attemptId - The ID of the exam attempt
   * @param userId - The ID of the user (for authorization)
   * @param questionIndex - The index of the question in the attempt's questions array
   * @param answer - The user's answer (option index for MCQ, text for text questions)
   */
  async submitAnswer(
    attemptId: string,
    userId: string,
    questionIndex: number,
    answer: number | string,
  ): Promise<void> {
    // Find the attempt
    const attempt = await this.examAttemptModel.findById(attemptId);
    if (!attempt) {
      throw new NotFoundException('Exam attempt not found');
    }

    // Ensure the attempt belongs to the user
    if (attempt.userId.toString() !== userId) {
      throw new ForbiddenException('You do not own this exam attempt');
    }

    // Ensure the exam hasn't been submitted yet
    if (attempt.submittedAt) {
      throw new BadRequestException('Exam has already been submitted');
    }

    // Check time limit
    const now = new Date();
    const elapsedSeconds =
      (now.getTime() - attempt.startTime.getTime()) / 1000;
    if (elapsedSeconds > attempt.durationSeconds) {
      throw new BadRequestException('Exam time has expired');
    }

    // Ensure the question index is valid
    if (
      questionIndex < 0 ||
      questionIndex >= attempt.answers.length
    ) {
      throw new BadRequestException('Invalid question index');
    }

    // Get the question details to determine its type
    const questionId = attempt.answers[questionIndex].questionId;
    const question = await this.questionsService.getQuestionById(
      questionId.toString(),
    );
    if (!question) {
      throw new NotFoundException('Question not found');
    }

        // Get the subdocument (Mongoose subdoc, not plain object)
    const targetAnswer = attempt.answers[questionIndex];

    // Set the answeredAt timestamp
    targetAnswer.answeredAt = new Date();

    if (question.options && question.options.length === 4) {
      // Multiple choice question
      if (typeof answer !== 'number' || answer < 0 || answer > 3) {
        throw new BadRequestException(
          'Invalid answer for multiple choice question',
        );
      }
      targetAnswer.selectedOption = answer as number;
    } else {
      // Text answer question
      if (typeof answer !== 'string') {
        throw new BadRequestException(
          'Invalid answer for text question',
        );
      }
      targetAnswer.textAnswer = answer as string;
    }

    // Tell Mongoose that this subdocument was modified
    //attempt.markModified('answers');
    attempt.markModified(`answers.${questionIndex}`);
    await attempt.save();
  }

  /**
   * Finish an exam attempt, evaluate answers, calculate score, and get AI analysis
   * @param attemptId - The ID of the exam attempt
   * @param userId - The ID of the user (for authorization)
   * @returns The finished exam attempt with results and AI analysis
   */
  async finishExam(
    attemptId: string,
    userId: string,
  ): Promise<ExamAttemptDocument> {
    // Find the attempt
    const attempt = await this.examAttemptModel.findById(attemptId);
    if (!attempt) {
      throw new NotFoundException('Exam attempt not found');
    }

    // Ensure the attempt belongs to the user
    if (attempt.userId.toString() !== userId) {
      throw new ForbiddenException('You do not own this exam attempt');
    }

    // Ensure the exam hasn't been submitted yet
    if (attempt.submittedAt) {
      throw new BadRequestException('Exam has already been submitted');
    }

    // Set submitted time
    attempt.submittedAt = new Date();

    // Evaluate each answer
    let correctCount = 0;
    const totalQuestions = attempt.answers.length;

    for (let i = 0; i < totalQuestions; i++) {
      const answer = attempt.answers[i];
      const questionId = answer.questionId.toString();

      // Fetch the question to get the correct answer
      const question = await this.questionsService.getQuestionById(
        questionId,
      );
      if (!question) {
        // If question is missing, mark as incorrect and continue
        answer.isCorrect = false;
        answer.aiScore = 0;
        continue;
      }

if (
          question?.options &&
          question.options.length === 4
        ) {
          // Multiple choice question
          const selectedOption = answer.selectedOption;
          if (selectedOption === undefined) {
            // No answer selected
            answer.isCorrect = false;
          } else {
            answer.isCorrect =
              selectedOption === question.correctOptionIndex;
          }
          if (answer.isCorrect) correctCount++;
        } else {
          // Text answer question
          if (!answer.textAnswer) {
            // No answer provided
            answer.isCorrect = false;
            answer.aiScore = 0;
          } else {
            // Call AI to evaluate the text answer
            const aiResult = await this.aiService.generate(
              `Determine if the student's answer is semantically equivalent to the correct answer.
              Question: ${question.text}
              Correct answer: ${question.explanation || 'No explanation provided'}
              Student answer: ${answer.textAnswer}
              Respond with JSON: { \"isCorrect\": boolean, \"score\": 0-1 }`,
            );

            // Parse the AI response (assuming it returns valid JSON)
            let aiParsed = { isCorrect: false, score: 0 };
            try {
              aiParsed = JSON.parse(aiResult);
            } catch (e) {
              // If AI returns invalid JSON, fall back to simple comparison
              const isCorrect =
                answer.textAnswer
                  .toLowerCase()
                  .trim() ===
                (question.explanation || '')
                  .toLowerCase()
                  .trim();
              aiParsed = {
                isCorrect,
                score: isCorrect ? 1 : 0,
              };
            }

            answer.isCorrect = aiParsed.isCorrect;
            answer.aiScore = aiParsed.score;
            if (answer.isCorrect) correctCount++;
          }
        }

      // Update the answer in the attempt
      attempt.answers[i] = answer;
    }

    // Calculate total score as percentage
    attempt.totalScore =
      totalQuestions > 0
        ? Math.round((correctCount / totalQuestions) * 100)
        : 0;

    // Generate AI analysis for the entire exam
    const questionsDetails = await Promise.all(
      attempt.answers.map(async (ans, index) => {
        const question = await this.questionsService.getQuestionById(
          ans.questionId.toString(),
        );
        return {
          questionId: ans.questionId.toString(),
          questionText: question?.text || 'Unknown question',
          questionType:
            question?.options && question.options.length === 4
              ? 'multiple_choice'
              : 'text_answer',
          userAnswer:
            ans.selectedOption !== undefined
              ? ans.selectedOption
              : ans.textAnswer,
          correctAnswer:
            question?.options && question.options.length === 4
              ? question.correctOptionIndex
              : question.explanation,
          isCorrect: ans.isCorrect,
          aiScore: ans.aiScore,
        };
      }),
    );

    const aiAnalysisPrompt = `
      You are a Konkorexam expert analyzing a student's exam results.
      Exam details:
      - Total questions: ${totalQuestions}
      - Correct answers: ${correctCount}
      - Score: ${attempt.totalScore}%
      
      Question-by-question breakdown:
      ${questionsDetails
        .map(
          (q, i) => `
        ${i + 1}. [${q.questionType}] 
           Question: ${q.questionText}
           User's answer: ${q.userAnswer}
           Correct answer: ${q.correctAnswer}
           Result: ${q.isCorrect ? 'Correct' : 'Incorrect'}
           ${q.questionType === 'text_answer' ? `AI similarity score: ${q.aiScore}` : ''}
      `,
        )
        .join('\n')}
      
      Provide a detailed analysis of the student's performance, highlighting strengths, weaknesses, and specific recommendations for improvement.
      Format your response as a clear, helpful report for the student.
    `;

    attempt.aiAnalysis = await this.aiService.generate(aiAnalysisPrompt);

    // Save the attempt with results
    return await attempt.save();
  }

  /**
   * Get an exam attempt by ID (for reviewing)
   * @param attemptId - The ID of the exam attempt
   * @param userId - The ID of the user (for authorization)
   * @returns The exam attempt with questions and answers
   */
  async getExamAttempt(
    attemptId: string,
    userId: string,
  ): Promise<ExamAttemptDocument> {
    const attempt = await this.examAttemptModel.findById(attemptId);
    if (!attempt) {
      throw new NotFoundException('Exam attempt not found');
    }

    if (attempt.userId.toString() !== userId) {
      throw new ForbiddenException('You do not own this exam attempt');
    }

    // Populate the questions for each answer
    const attemptWithQuestions = await this.examAttemptModel.populate(
      attempt,
      'answers.questionId',
    );

    return attemptWithQuestions;
  }

  /**
   * Get all exam attempts for a user
   * @param userId - The ID of the user
   * @returns Array of exam attempts (sorted by start time, newest first)
   */
  async getUserExams(userId: string): Promise<ExamAttemptDocument[]> {
    return this.examAttemptModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ startTime: -1 })
      .exec();
  }
}
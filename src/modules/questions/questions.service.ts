import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PipelineStage } from 'mongoose';
import { Question, QuestionDocument } from './schemas/question.schema';

@Injectable()
export class QuestionsService {
  constructor(
    @InjectModel(Question.name)
    private readonly questionModel: Model<QuestionDocument>,
  ) {}

  /**
   * Create a new question
   * @param createQuestionDto - Data for the new question
   */
  async createQuestion(createQuestionDto: any): Promise<QuestionDocument> {
    const createdQuestion = new this.questionModel(createQuestionDto);
    return createdQuestion.save();
  }

  /**
   * Get questions with optional filters
   * @param filters - Object containing filters like subject, topic, difficulty, etc.
   */
  async getQuestions(filters: any = {}): Promise<QuestionDocument[]> {
    return this.questionModel.find(filters).exec();
  }

  /**
   * Get a single question by ID
   * @param id - Question ID
   */
  async getQuestionById(id: string): Promise<QuestionDocument> {
    const question = await this.questionModel.findById(id).exec();
    if (!question) {
      throw new NotFoundException(`Question with ID ${id} not found`);
    }
    return question;
  }

  /**
   * Update a question by ID
   * @param id - Question ID
   * @param updateQuestionDto - Data to update
   */
  async updateQuestion(id: string, updateQuestionDto: any): Promise<QuestionDocument> {
    const existingQuestion = await this.questionModel
      .findByIdAndUpdate(id, updateQuestionDto, { new: true })
      .exec();

    if (!existingQuestion) {
      throw new NotFoundException(`Question with ID ${id} not found`);
    }
    return existingQuestion;
  }

  /**
   * Delete a question by ID
   * @param id - Question ID
   */
  async deleteQuestion(id: string): Promise<void> {
    const result = await this.questionModel.findByIdAndDelete(id).exec();
    if (!result) {
      throw new NotFoundException(`Question with ID ${id} not found`);
    }
  }

  /**
   * Get random questions for exam generation
   * @param count - Number of questions to retrieve
   * @param filters - Optional filters (subject, topic, etc.)
   */
  async getRandomQuestions(count: number, filters: any = {}): Promise<QuestionDocument[]> {
    // Using MongoDB aggregation for random sampling
    const pipeline: PipelineStage[] = [];
    if (Object.keys(filters).length > 0) {
      pipeline.push({ $match: filters });
    }
    pipeline.push({ $sample: { size: count } });

    return this.questionModel.aggregate(pipeline).exec();
  }
}
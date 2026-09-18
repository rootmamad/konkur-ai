import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class AIService {
  constructor(private readonly httpService: HttpService) {}

  /**
   * Call the AI API with a prompt
   * @param prompt - The prompt to send to the AI
   * @returns The AI's response as a string
   */
  async call(prompt: string): Promise<string> {
    // TODO: Replace with actual AI API endpoint and configuration
    // For now, return a mock response
    // In a real implementation, you would do something like:
    // const response = await firstValueFrom(
    //   this.httpService.post('https://api.example.com/ai', { prompt })
    // );
    // return response.data.text;

    // Mock response for development
    return `AI Analysis: Based on the exam results, the student shows strong understanding in [topic] but needs improvement in [topic]. Recommend focusing on [specific areas].`;
  }
}
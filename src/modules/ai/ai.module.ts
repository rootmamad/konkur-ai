import { Global, Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AIService } from './ai.service';

@Global()
@Module({
  imports: [HttpModule],
  providers: [AIService],
  exports: [AIService],
})
export class AIModule {}
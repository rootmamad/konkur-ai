import { Module } from '@nestjs/common';

import { GradingService } from './grading.service';

// AI rubric grading (spec 6, 15.1-item 5): fills the needs_review
// correction placeholders that finishExam queues. AIService arrives from
// the global AIModule. No user-facing quota (spec 6: «سهمیه جدا ندارد») —
// cost is measured only in ai_job rows.
@Module({
  providers: [GradingService],
  exports: [GradingService],
})
export class GradingModule {}

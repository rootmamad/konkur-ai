import { Module } from '@nestjs/common';

import { StudyController } from './study.controller';
import { StudyService } from './study.service';
import { WeekSummaryService } from './week-summary.service';

/**
 * Study log module (spec sections 3.6 and 12): short-form entries,
 * repeat-yesterday, the weekly summary card and the async AI weekly summary
 * that consumes the week's pending entries. DB comes from the global DbModule;
 * AIService comes from the global AIModule.
 */
@Module({
  controllers: [StudyController],
  providers: [StudyService, WeekSummaryService],
  // Exported for the dashboard's weekly-minutes card (spec §3.7).
  exports: [StudyService],
})
export class StudyModule {}

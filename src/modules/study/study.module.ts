import { Module } from '@nestjs/common';

import { StudyController } from './study.controller';
import { StudyService } from './study.service';

/**
 * Study log module (spec sections 3.6 and 12): short-form entries,
 * repeat-yesterday and the weekly summary card. DB comes from the global
 * DbModule; no AI dependency in this task.
 */
@Module({
  controllers: [StudyController],
  providers: [StudyService],
  // Exported for the dashboard's weekly-minutes card (spec §3.7).
  exports: [StudyService],
})
export class StudyModule {}

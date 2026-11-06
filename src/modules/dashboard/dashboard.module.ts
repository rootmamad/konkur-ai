import { Module } from '@nestjs/common';

import { StudyModule } from '../study/study.module';
import { AnalysisService } from './analysis.service';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

/**
 * Dashboard / مانیتور module (spec §1.1 page 3 and §3.7).
 *
 * Rule-based reads are owned by DashboardService; the async AI overall
 * analysis lives in AnalysisService and writes to the student's
 * `exam_analysis` chat thread. StudyService is imported from StudyModule;
 * AIService and HistoryContextService arrive from the global AIModule.
 */
@Module({
  imports: [StudyModule],
  controllers: [DashboardController],
  providers: [DashboardService, AnalysisService],
})
export class DashboardModule {}

import { Module } from '@nestjs/common';

import { ExamsController } from './exams.controller';
import { ExamsService } from './exams.service';
import { BillingModule } from '../billing/billing.module';
import { GradingModule } from '../grading/grading.module';
import { QuestionsModule } from '../questions/questions.module';
import { ReferralsModule } from '../referrals/referrals.module';
import { UsersModule } from '../users/users.module';

// TODO(rewrite): provide Drizzle-backed ExamsService against
// exam_template + exam_instance + attempt + response + correction.
@Module({
  imports: [
    UsersModule,
    QuestionsModule,
    ReferralsModule,
    BillingModule,
    // AI rubric grading of descriptive answers (spec 6): optional dep of
    // ExamsService, fired fire-and-forget after the finish transaction
    // commits.
    GradingModule,
  ],
  controllers: [ExamsController],
  providers: [ExamsService],
})
export class ExamsModule {}

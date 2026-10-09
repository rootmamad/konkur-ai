import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';

import { UsersModule } from './modules/users/users.module';
import { AuthModule } from './modules/auth/auth.module';
import { QuestionsModule } from './modules/questions/questions.module';
import { ExamsModule } from './modules/exams/exams.module';
import { AIModule } from './modules/ai/ai.module';
import { DbModule } from './db/db.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 5 }],
      skipIf: () => process.env.NODE_ENV === 'test',
    }),
    DbModule,
    HealthModule,
    UsersModule,
    AuthModule,
    QuestionsModule,
    AIModule,
    ExamsModule,
  ],
})
export class AppModule {}

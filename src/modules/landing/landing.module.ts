import { Module } from '@nestjs/common';

import { LandingController } from './landing.controller';

// Landing-page public content (spec 1.3): static demo payloads only — a
// controller over constants, deliberately no service and no DB.
@Module({
  controllers: [LandingController],
})
export class LandingModule {}

import { ThrottlerGuard } from '@nestjs/throttler';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { LANDING_PLANS, REPORT_CARD_SAMPLE } from './landing.content';
import { LandingController } from './landing.controller';

/** @UseGuards/@Get metadata lives on the method function itself. */
function methodMetadata(method: string, key: string): unknown {
  const handler = Object.getOwnPropertyDescriptor(
    LandingController.prototype,
    method,
  )?.value as object | undefined;
  return handler ? Reflect.getMetadata(key, handler) : undefined;
}

function methodPath(method: string): string {
  return methodMetadata(method, 'path') as string;
}

function guardNames(method: string): string[] {
  const guards = methodMetadata(method, '__guards__') as
    Array<{ name: string }> | undefined;
  return (guards ?? []).map((g) => g.name);
}

describe('LandingController — public landing routes (spec 1.3)', () => {
  it('serves the sample report card without JWT, rate-limited only', () => {
    expect(guardNames('reportCardSample')).toEqual([ThrottlerGuard.name]);
    expect(guardNames('reportCardSample')).not.toContain(JwtAuthGuard.name);
    expect(methodPath('reportCardSample')).toBe('public/report-card-sample');
  });

  it('serves the plans without JWT, rate-limited only', () => {
    expect(guardNames('plans')).toEqual([ThrottlerGuard.name]);
    expect(guardNames('plans')).not.toContain(JwtAuthGuard.name);
    expect(methodPath('plans')).toBe('public/plans');
  });

  it('returns the sample card verbatim from the static constant', () => {
    const controller = new LandingController();

    expect(controller.reportCardSample()).toBe(REPORT_CARD_SAMPLE);
  });

  it('returns the plans verbatim from the static constant', () => {
    const controller = new LandingController();

    expect(controller.plans()).toBe(LANDING_PLANS);
  });
});

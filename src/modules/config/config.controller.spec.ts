import { ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ConfigController } from './config.controller';
import { ConfigService } from './config.service';
import { EffectiveConfigDto } from './dto/effective-config.dto';

const MOCK_CONFIG: EffectiveConfigDto = {
  version: 7,
  quotas: { free_quiz_weekly: 3, free_quiz_max_questions: 10 },
  notes: 'Updated limits',
};

/** @UseGuards/@Get metadata lives on the method function itself. */
function methodMetadata(method: string, key: string): unknown {
  const handler = Object.getOwnPropertyDescriptor(
    ConfigController.prototype,
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

describe('ConfigController — public effective config endpoint (spec §10, §13.4)', () => {
  it('serves effective config without JWT, rate-limited only', () => {
    expect(guardNames('getEffective')).toEqual([ThrottlerGuard.name]);
    expect(guardNames('getEffective')).not.toContain(JwtAuthGuard.name);
  });

  it('maps getEffective to GET /config/effective', () => {
    expect(methodPath('getEffective')).toBe('effective');
  });

  describe('delegation', () => {
    it('calls service.getEffective and returns the result', async () => {
      const getEffective = jest
        .fn<Promise<EffectiveConfigDto>, []>()
        .mockResolvedValue(MOCK_CONFIG);

      const controller = new ConfigController({
        getEffective,
      } as unknown as ConfigService);

      const result = await controller.getEffective();

      expect(getEffective).toHaveBeenCalledWith();
      expect(result).toEqual(MOCK_CONFIG);
    });

    it('propagates 404 from service when no active config exists', async () => {
      const getEffective = jest
        .fn<Promise<EffectiveConfigDto>, []>()
        .mockRejectedValue(new Error('NotFound'));

      const controller = new ConfigController({
        getEffective,
      } as unknown as ConfigService);

      await expect(controller.getEffective()).rejects.toThrow();
    });
  });
});

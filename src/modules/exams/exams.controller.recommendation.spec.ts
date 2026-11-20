import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '../users/enums/user-role.enum';
import { ExamsController } from './exams.controller';
import { ExamsService } from './exams.service';
import { RecommendationDto } from './dto/recommendation.dto';

const USER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

const user = { userId: USER_ID } as never;

function methodMetadata(method: string, key: string): unknown {
  const handler = Object.getOwnPropertyDescriptor(
    ExamsController.prototype,
    method,
  )?.value as object | undefined;
  return handler ? Reflect.getMetadata(key, handler) : undefined;
}

function classMetadata(key: string): unknown {
  return Reflect.getMetadata(key, ExamsController);
}

function classGuardNames(): string[] {
  const guards = classMetadata('__guards__') as
    Array<{ name: string }> | undefined;
  return (guards ?? []).map((g) => g.name);
}

function methodPath(method: string): string {
  return methodMetadata(method, 'path') as string;
}

describe('ExamsController — recommendation endpoint', () => {
  it('sits behind JWT + roles with ADMIN and STUDENT allowed (class guards)', () => {
    expect(classGuardNames()).toEqual([JwtAuthGuard.name, RolesGuard.name]);
    expect(classMetadata(ROLES_KEY)).toEqual([
      UserRole.ADMIN,
      UserRole.STUDENT,
    ]);
    expect(classMetadata('path')).toBe('exams');
  });

  it('getRecommendation adds no route-level guard overrides', () => {
    // No method-level metadata: every route inherits the class guards,
    // so no route can accidentally drop JWT/Roles.
    expect(methodMetadata('getRecommendation', '__guards__')).toBeUndefined();
    expect(methodMetadata('getRecommendation', ROLES_KEY)).toBeUndefined();
  });

  it('maps getRecommendation to GET /exams/recommendation', () => {
    expect(methodPath('getRecommendation')).toBe('recommendation');
  });

  describe('delegation', () => {
    it('calls service.getRecommendation with the caller userId', async () => {
      const getRecommendation = jest
        .fn<Promise<RecommendationDto>, [string]>()
        .mockResolvedValue({
          recommended: {
            kind: 'smart_mix',
            title: 'Smart Mix',
            questionCount: 3,
            durationSeconds: 900,
            reason: 'History-based mix',
            newcomer: false,
          },
          alternatives: [],
        });

      const controller = new ExamsController({
        getRecommendation,
      } as unknown as ExamsService);

      const result = await controller.getRecommendation(user);

      expect(getRecommendation).toHaveBeenCalledWith(USER_ID);
      expect(result.recommended.kind).toBe('smart_mix');
    });

    it('returns the service result as-is', async () => {
      const expected: RecommendationDto = {
        recommended: {
          kind: 'diagnostic',
          title: 'Diagnostic',
          questionCount: 10,
          durationSeconds: 900,
          reason: 'Newcomer: no history yet',
          newcomer: true,
        },
        alternatives: [
          {
            kind: 'diagnostic',
            title: 'Diagnostic',
            durationSeconds: 900,
            counts: { easy: 0, normal: 0, hard: 0 },
          },
        ],
      };

      const getRecommendation = jest
        .fn<Promise<RecommendationDto>, [string]>()
        .mockResolvedValue(expected);

      const controller = new ExamsController({
        getRecommendation,
      } as unknown as ExamsService);

      const result = await controller.getRecommendation(user);

      expect(result).toEqual(expected);
    });
  });
});

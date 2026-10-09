import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { UserRole } from '../../modules/users/enums/user-role.enum';

export interface AuthenticatedUser {
  userId: string;
  role: UserRole;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser =>
    context.switchToHttp().getRequest().user,
);

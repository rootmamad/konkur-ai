import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { UserRole } from 'src/modules/users/enums/user-role.enum';

export interface AuthenticatedUser {
  userId: string;
  role: UserRole;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest();

    return request.user;
  },
);
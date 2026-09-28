import { Module } from '@nestjs/common';

import { UsersController } from './users.controller';
import { UsersService } from './users.service';

// TODO(rewrite): provide Drizzle-backed UsersService against
// account + student tables. Controllers are stubs until then.
@Module({
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}

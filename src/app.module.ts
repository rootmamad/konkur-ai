import { Module } from '@nestjs/common';
import { UsersModule } from './modules/users/users.module';
import { AuthModule } from './modules/auth/auth.module';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';


@Module({
  imports: [ ConfigModule.forRoot({
      isGlobal: true,
    }),   MongooseModule.forRoot(process.env.MONGODB_URI!),
UsersModule,AuthModule],
  controllers: [],
  providers: [],
})
export class AppModule {}

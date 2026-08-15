import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { UserRole } from '../enums/user-role.enum';

export type UserDocument = HydratedDocument<User>;

@Schema({
  timestamps: true,
})
export class User {
  @Prop({
    required: true,
    unique: true,
    index: true,
    trim: true,
  })
  nationalId: string;

  @Prop({
    required: true,
    unique: true,
    index: true,
    trim: true,
  })
  phoneNumber: string;

  @Prop({
    required: true,
    trim: true,
  })
  firstName: string;

  @Prop({
    required: true,
    trim: true,
  })
  lastName: string;

  @Prop({
    required: true,
  })
  passwordHash: string;

  @Prop({
    required: true,
    enum: UserRole,
    default: UserRole.STUDENT,
  })
  role: UserRole;

  @Prop({
    default: true,
  })
  isActive: boolean;

  @Prop({
    default: 0,
    min: 0,
  })
  xp: number;

  @Prop({
    default: 1,
    min: 1,
  })
  level: number;

  @Prop({
    default: 0,
    min: 0,
  })
  streak: number;
}

export const UserSchema = SchemaFactory.createForClass(User);
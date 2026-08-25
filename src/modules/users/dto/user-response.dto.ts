import { UserDocument } from '../schemas/user.schema';

export class UserResponseDto {
  id: string;
  nationalId: string;
  phoneNumber: string;
  firstName: string;
  lastName: string;
  role: string;
  isActive: boolean;
  xp: number;
  level: number;
  streak: number;
  createdAt: Date;
  updatedAt: Date;

  static fromDocument(user: UserDocument): UserResponseDto {
    return {
      id: user._id.toString(),
      nationalId: user.nationalId,
      phoneNumber: user.phoneNumber,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      isActive: user.isActive,
      xp: user.xp,
      level: user.level,
      streak: user.streak,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}
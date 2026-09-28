import { UserWithProfile } from '../users.service';

/**
 * Outgoing user shape. Maps from account + student rows.
 */
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

  static fromDocument(user: UserWithProfile): UserResponseDto {
    const dto = new UserResponseDto();
    dto.id = user.id;
    dto.nationalId = user.nationalId;
    dto.phoneNumber = user.phoneNumber;
    dto.firstName = user.firstName;
    dto.lastName = user.lastName;
    dto.role = user.role;
    dto.isActive = user.isActive;
    dto.xp = user.xp;
    dto.level = user.level;
    dto.streak = user.streak;
    dto.createdAt = user.createdAt;
    dto.updatedAt = user.updatedAt;
    return dto;
  }
}
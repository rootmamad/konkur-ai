import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{10}$/, {
    message: 'nationalId must contain exactly 10 digits',
  })
  nationalId: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^09\d{9}$/, {
    message: 'phoneNumber must be an 11-digit Iranian mobile number',
  })
  phoneNumber: string;

  @IsString()
  @IsNotEmpty()
  firstName: string;

  @IsString()
  @IsNotEmpty()
  lastName: string;

  /**
   * Optional inviter code (spec 11, 3.7). Same alphabet and length as the
   * generated codes: 8 characters, A-Z and 0-9.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z0-9]{8}$/, {
    message: 'inviteCode must be 8 uppercase letters or digits',
  })
  inviteCode?: string;
}

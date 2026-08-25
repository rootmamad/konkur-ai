import { IsNotEmpty, IsString, Matches } from 'class-validator';

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
  
}
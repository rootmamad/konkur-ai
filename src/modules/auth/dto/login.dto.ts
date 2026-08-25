import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class LoginDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^09\d{9}$/, {
    message: 'phoneNumber must be an 11-digit Iranian mobile number',
  })
  phoneNumber: string;

  @IsString()
  @IsNotEmpty()
  password: string;
}
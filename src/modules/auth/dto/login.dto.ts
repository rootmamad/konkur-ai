import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class LoginDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^09\d{9}$/, {
    message: 'phoneNumber must be an 11-digit Iranian mobile number',
  })
  phoneNumber: string;

  /**
   * National code used as password for authentication
   * Should be exactly 10 digits (Iranian national code)
   */
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{10}$/, {
    message: 'nationalCode must be exactly 10 digits',
  })
  password: string;
}
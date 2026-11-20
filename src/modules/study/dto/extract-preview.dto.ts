import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** The free text the student typed in chat (spec 3.6 path 1). */
export class ExtractPreviewDto {
  @ApiProperty({
    example: 'امروز ۴۵ دقیقه مشتق خوندم و ۱۰ تمرین زدم، بعضی‌هاش سختی',
    minLength: 1,
    maxLength: 1000,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  text: string;
}

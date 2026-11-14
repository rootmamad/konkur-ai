import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

import { CHAT_MESSAGE_MAX_LENGTH } from '../chat.service';

/** One user message appended to an owned thread (spec 9.1, storage only). */
export class CreateMessageDto {
  @ApiProperty({ minLength: 1, maxLength: CHAT_MESSAGE_MAX_LENGTH })
  @IsString()
  @Length(1, CHAT_MESSAGE_MAX_LENGTH, {
    message: `body must be between 1 and ${CHAT_MESSAGE_MAX_LENGTH} characters`,
  })
  body: string;
}

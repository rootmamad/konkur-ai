import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';

import { COACH_MODES } from '../chat-ai.service';
import { CHAT_MESSAGE_MAX_LENGTH } from '../chat.service';

/** One user message appended to an owned thread (spec 9.1, storage only). */
export class CreateMessageDto {
  @ApiProperty({ minLength: 1, maxLength: CHAT_MESSAGE_MAX_LENGTH })
  @IsString()
  @Length(1, CHAT_MESSAGE_MAX_LENGTH, {
    message: `body must be between 1 and ${CHAT_MESSAGE_MAX_LENGTH} characters`,
  })
  body: string;

  /**
   * Coach space only (spec 9.1): which of the three composer tabs this send
   * comes from. Required per coach send (validated in the service, which
   * knows the thread's space); rejected on question/exam_analysis threads.
   */
  @ApiProperty({
    required: false,
    enum: COACH_MODES,
    description: 'Coach threads only: motivation | planning | debug',
  })
  @IsOptional()
  @IsIn(COACH_MODES, {
    message: 'mode must be one of: motivation, planning, debug',
  })
  mode?: (typeof COACH_MODES)[number];
}

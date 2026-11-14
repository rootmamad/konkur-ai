import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';

import { chatSpace } from '../../../db/schema/chat';

/** Space names, derived from the `chat_space` pg enum (spec 9.1). */
export type ChatSpaceKind = (typeof chatSpace.enumValues)[number];

/**
 * Get-or-create payload for a chat thread (spec 9.1). Only field-level rules
 * live here; the per-space reference matrix (which space may carry
 * questionId/attemptId) is business logic enforced in ChatService.
 */
export class CreateThreadDto {
  @ApiProperty({ enum: chatSpace.enumValues })
  @IsIn([...chatSpace.enumValues])
  space: ChatSpaceKind;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  questionId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  attemptId?: string;
}

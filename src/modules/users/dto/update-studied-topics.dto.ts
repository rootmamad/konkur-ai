import { ArrayMaxSize, IsArray, IsUUID } from 'class-validator';

/**
 * Body of PATCH /users/me/studied-topics (spec 3.2 onboarding).
 * The self-reported list of studied topic ids; an empty array clears it.
 * Validated by the global ValidationPipe (whitelist + forbidNonWhitelisted).
 */
export class UpdateStudiedTopicsDto {
  @IsArray()
  @IsUUID('4', { each: true })
  @ArrayMaxSize(30)
  topicIds: string[];
}

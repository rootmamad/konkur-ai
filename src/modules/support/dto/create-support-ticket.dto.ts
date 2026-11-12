import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Public support form (spec 3.8). Limits mirror the `support_ticket` columns
 * exactly; `contact` is intentionally free text (email or phone) so no format
 * is enforced here.
 */
export class CreateSupportTicketDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100, { message: 'name must be at most 100 characters' })
  name: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100, {
    message: 'contact must be at most 100 characters',
  })
  contact: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000, { message: 'message must be at most 2000 characters' })
  message: string;
}

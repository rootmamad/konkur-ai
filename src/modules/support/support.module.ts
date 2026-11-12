import { Module } from '@nestjs/common';

import { SupportController } from './support.controller';
import { SupportService } from './support.service';

/**
 * Support inbox (spec §3.8): public ticket submission plus the admin
 * list/resolve queue. Storage only — no email notifications, no attachments
 * (photo upload is a separate §13 flag) and no reply threading.
 */
@Module({
  controllers: [SupportController],
  providers: [SupportService],
})
export class SupportModule {}

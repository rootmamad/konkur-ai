import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

/** Plans a user may buy; 'free' is never purchasable (spec §15.1.8). */
export const PURCHASABLE_PLANS = ['full', 'advisor'] as const;
export type PurchasablePlan = (typeof PURCHASABLE_PLANS)[number];

export class PurchaseDto {
  @ApiProperty({ enum: PURCHASABLE_PLANS, example: 'full' })
  @IsIn(PURCHASABLE_PLANS)
  plan: PurchasablePlan;
}

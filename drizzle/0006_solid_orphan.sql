ALTER TYPE "public"."referral_stage" RENAME TO "referral_status";--> statement-breakpoint
ALTER TABLE "referral" RENAME COLUMN "inviter_student_id" TO "inviter_id";--> statement-breakpoint
ALTER TABLE "referral" RENAME COLUMN "invitee_student_id" TO "invitee_id";--> statement-breakpoint
ALTER TABLE "referral" RENAME COLUMN "invite_code_used" TO "code_used";--> statement-breakpoint
ALTER TABLE "referral" RENAME COLUMN "stage" TO "status";--> statement-breakpoint
ALTER TABLE "referral" DROP CONSTRAINT "referral_inviter_student_id_student_id_fk";
--> statement-breakpoint
ALTER TABLE "referral" DROP CONSTRAINT "referral_invitee_student_id_student_id_fk";
--> statement-breakpoint
ALTER TABLE "referral" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "referral" ALTER COLUMN "status" SET DEFAULT 'registered'::text;--> statement-breakpoint
DROP TYPE "public"."referral_status";--> statement-breakpoint
CREATE TYPE "public"."referral_status" AS ENUM('registered', 'first_exam', 'purchased', 'expired');--> statement-breakpoint
ALTER TABLE "referral" ALTER COLUMN "status" SET DEFAULT 'registered'::"public"."referral_status";--> statement-breakpoint
ALTER TABLE "referral" ALTER COLUMN "status" SET DATA TYPE "public"."referral_status" USING "status"::"public"."referral_status";--> statement-breakpoint
ALTER TABLE "referral" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "referral" ADD CONSTRAINT "referral_inviter_id_student_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."student"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral" ADD CONSTRAINT "referral_invitee_id_student_id_fk" FOREIGN KEY ("invitee_id") REFERENCES "public"."student"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral" ADD CONSTRAINT "referral_invitee_id_unique" UNIQUE("invitee_id");
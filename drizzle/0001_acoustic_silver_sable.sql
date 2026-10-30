CREATE TYPE "public"."exam_kind" AS ENUM('quiz_after_study', 'debug_errors', 'due_review', 'speed', 'trap_finder', 'general_prep', 'smart_mix');--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "first_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "last_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "question" ADD COLUMN "exam_kind" "exam_kind" DEFAULT 'general_prep' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "response_attempt_question_uq" ON "response" USING btree ("attempt_id","question_id");
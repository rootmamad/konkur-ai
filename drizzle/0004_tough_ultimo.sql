CREATE TYPE "public"."question_origin" AS ENUM('bank', 'ai');--> statement-breakpoint
ALTER TYPE "public"."ai_operation" ADD VALUE 'question_draft';--> statement-breakpoint
ALTER TABLE "question" ADD COLUMN "origin" "question_origin" DEFAULT 'bank' NOT NULL;
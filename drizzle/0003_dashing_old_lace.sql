CREATE TABLE "question_mastery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"current_streak" integer DEFAULT 0 NOT NULL,
	"total_attempts" integer DEFAULT 0 NOT NULL,
	"total_correct" integer DEFAULT 0 NOT NULL,
	"last_is_correct" boolean,
	"last_answered_at" timestamp with time zone,
	"mastered_at" timestamp with time zone,
	"next_due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "question_mastery" ADD CONSTRAINT "question_mastery_student_id_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_mastery" ADD CONSTRAINT "question_mastery_question_id_question_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."question"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "question_mastery_student_question_uq" ON "question_mastery" USING btree ("student_id","question_id");--> statement-breakpoint
CREATE INDEX "qm_not_mastered_idx" ON "question_mastery" USING btree ("student_id") WHERE "question_mastery"."mastered_at" IS NULL;--> statement-breakpoint
CREATE INDEX "qm_mastered_idx" ON "question_mastery" USING btree ("student_id","mastered_at") WHERE "question_mastery"."mastered_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "qm_due_idx" ON "question_mastery" USING btree ("student_id","next_due_at") WHERE "question_mastery"."next_due_at" IS NOT NULL AND "question_mastery"."mastered_at" IS NULL;
# MongoDB to PostgreSQL mapping (spec task 13.1)

Source: current Mongoose models. Target: Drizzle schema in `src/db/schema/`.
IDs move from Mongo ObjectId to UUID primary keys. No data migration:
the team confirmed current data is disposable, so this is a fresh schema.

## 1. User (`src/modules/users/schemas/user.schema.ts`)

| Mongo field | Target | Notes |
| --- | --- | --- |
| `_id` | `account.id` (new UUID) | Old ObjectIds are not reused |
| `nationalId` (unique) | dev-only credential hashed into `account.password_hash` (never stored in plain text) | Spec section 2: national-code login stays for dev only |
| `phoneNumber` (unique) | `account.mobile` (unique) | Login identifier |
| `firstName`, `lastName` | `account.first_name`, `account.last_name` | Stored on account, returned by `GET /users/me` |
| `role` (`admin`/`student`) | `account.is_admin` flag | Spec: admin is a flag, not a table |
| `isActive` | `account.is_active` | Same semantics |
| `xp`, `level`, `streak` | `student.xp`, `student.level`, `student.streak` | One-to-one via `student.account_id` |
| `createdAt`, `updatedAt` | `created_at`, `updated_at` on both tables | |

New rows required per user: one `account` (with `first_name` /
`last_name`) + one `student` (+ one `subscription` free row and one
`credit_wallet` row in the rewrite step).
A user that is also an advisor additionally gets `advisor` + `advisor_student`.

## 2. Question (`src/modules/questions/schemas/question.schema.ts`)

| Mongo field | Target | Notes |
| --- | --- | --- |
| `_id` | `question.id` (new UUID) | Plus integer `version`, starting at 1 |
| `text` | `question.text` | Raw text kept; ordered blocks go to `content_blocks` |
| `options` (4 strings or empty) | `question.options` (jsonb) | Length rule enforced per type |
| `correctOptionIndex` | `answer_key.correct_option_index` | Separate table with `question_version` |
| `explanation` (misused as correct text in grading) | `explanation` table with `origin` | Official/source/AI origins stay separate |
| `subject`, `topic` | `question.subject`, `topic` tree + `question.topic_id` | |
| `difficulty` (1-5 int) | replaced by `question.difficulty_ai` (estimate) + rubric parts | Spec: AI difficulty is an estimate only |
| `questionType` (`multiple_choice`/`text_answer`) | `question.type` enum (`multiple_choice`, `true_false`, `fill_blank`, `descriptive`, `multi_part`) | Old `text_answer` maps to `descriptive` (free-text essay answers live on `response.text_answer` + `correction`) |

## 3. ExamAttempt (`src/modules/exams/exam-attempt.schema.ts`)

| Mongo field | Target | Notes |
| --- | --- | --- |
| `_id` | `attempt.id` (new UUID) | |
| `userId` | `attempt.student_id` via `student.account_id` lookup | |
| `answers[]` (embedded) | `response` rows (one per question) | `question_version` frozen at start |
| `answers[].selectedOption` / `textAnswer` | `response.selected_option` / `response.text_answer` | |
| `answers[].isCorrect`, `aiScore` | `response.is_correct` + `correction` row for descriptive | MCQ graded inline; descriptive via `correction` with model version |
| `answers[].answeredAt` | `response.answered_at` | Plus `active_seconds` from the timing API (spec section 8) |
| `startTime`, `durationSeconds` | `attempt.started_at` + `exam_instance.settings_snapshot.duration_seconds` | Server clock stays authoritative |
| `submittedAt` | `attempt.submitted_at` + `status` (`in_progress`/`submitted`/`reviewed`) | |
| `totalScore` | `attempt.total_score` | |
| `aiAnalysis` | generated on demand, not stored on attempt | History comes from `chat_message` threads |

New: `exam_template` (the 7 quiz kinds + diagnostic + 2 sims) and
`exam_instance` (frozen question order + settings snapshot) have no
Mongo equivalent; they are new per spec sections 3.5 and 5.

## 4. Auth behavior (unchanged in step 1)

- `POST /auth/register` and `POST /auth/login` run against `account` +
  `student` with the same national-code dev credential (SHA-256 of
  `konkur-dev:<nationalCode>` stored in `account.password_hash`).
  `firstName`/`lastName` are stored on `account.first_name` /
  `account.last_name` and returned by `GET /users/me`.
  There is no `findByNationalId`: national IDs are never stored in
  plain text, only as hashes.
- JWT payload `{ sub, role }` is unchanged until the rewrite step,
  where `sub` becomes the account UUID and role derives from `is_admin`.

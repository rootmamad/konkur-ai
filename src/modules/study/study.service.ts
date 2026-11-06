import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm';

import { DB } from '../../db/db.module';
import type { Db } from '../../db/db.module';
import { studyLog } from '../../db/schema/study';
import type { StudyLog } from '../../db/schema/study';
import { student } from '../../db/schema/student';
import type { CreateStudyEntryDto } from './dto/create-study-entry.dto';

/** Hard cap for GET /study/entries (spec section 3.6: `limit <= 50`). */
export const MAX_RECENT_LIMIT = 50;
export const DEFAULT_RECENT_LIMIT = 20;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Null `activity` aggregation bucket (the column is nullable in the schema). */
const UNKNOWN_ACTIVITY = 'unknown';

/**
 * Week aggregate for the "خلاصه هفته من" card.
 *
 * `perActivity` and `perDay` are minutes, not entry counts, so they add up to
 * `totalMinutes`; `entries` is the number of entries in the window. `perDay`
 * keys are UTC calendar days (`YYYY-MM-DD`) so the aggregate is stable
 * regardless of the server's local timezone.
 */
export interface WeekSummary {
  weekStart: Date;
  weekEnd: Date;
  totalMinutes: number;
  entries: number;
  perActivity: Record<string, number>;
  perDay: Record<string, number>;
  vagueCount: number;
}

/**
 * Start of the current ISO week (Monday 00:00 UTC).
 *
 * Week boundaries are computed in UTC on purpose: the "naive server day" is
 * the documented MVP choice and the Persian (Saturday-first) week is still an
 * open decision in the contract doc.
 */
function currentIsoWeekStart(now: Date = new Date()): Date {
  const midnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  // getUTCDay(): 0 = Sunday, 1 = Monday, ... 6 = Saturday.
  const daysSinceMonday = (now.getUTCDay() + 6) % 7;
  return new Date(midnight - daysSinceMonday * 24 * 60 * 60 * 1000);
}

function clampRecentLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_RECENT_LIMIT;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_RECENT_LIMIT);
}

function parseWeekStart(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException('weekStart must be an ISO date');
  }
  return parsed;
}

/**
 * Study log (spec sections 3.6 and 12). Backs the short form, the
 * repeat-yesterday shortcut and the weekly summary card.
 *
 * Requires a student row: the JWT subject is an account id, exactly like
 * exams.service, and every row is scoped by the resolved student id.
 */
@Injectable()
export class StudyService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Insert one form entry. `source` is always `form`, `status` starts
   * `pending` (the future weekly-AI task flips it to `summarized`), and a
   * future `doneAt` is clamped to now instead of being rejected.
   */
  async createStudyEntry(
    userId: string,
    dto: CreateStudyEntryDto,
  ): Promise<StudyLog> {
    const studentId = await this.requireStudentId(userId);

    const now = new Date();
    const doneAt = dto.doneAt === undefined ? now : new Date(dto.doneAt);
    if (Number.isNaN(doneAt.getTime())) {
      throw new BadRequestException('doneAt must be a valid ISO date');
    }
    const effectiveDoneAt = doneAt.getTime() > now.getTime() ? now : doneAt;

    const [row] = await this.db
      .insert(studyLog)
      .values({
        studentId,
        lesson: dto.lesson,
        topic: dto.topic ?? null,
        activity: dto.activity,
        minutes: dto.minutes,
        exerciseCount: dto.exerciseCount ?? null,
        feeling: dto.feeling ?? null,
        note: dto.note ?? null,
        doneAt: effectiveDoneAt,
        source: 'form',
        status: 'pending',
      })
      .returning();

    return row;
  }

  /**
   * Copy the latest entry logged yesterday into today's log.
   *
   * "Yesterday" is the naive server day: entries with
   * `done_at >= date_trunc('day', now() - interval '1 day')` and
   * `< date_trunc('day', now())`. The copy carries the same lesson/topic/
   * activity/exerciseCount/note, but `minutes = 0` (the student repeats the
   * session and can edit the minutes later) and `source = 'repeat_yesterday'`.
   * `feeling` is intentionally not copied: it describes yesterday's session.
   */
  async repeatYesterday(userId: string): Promise<StudyLog> {
    const studentId = await this.requireStudentId(userId);

    const yesterdayStart = sql`date_trunc('day', now() - interval '1 day')`;
    const todayStart = sql`date_trunc('day', now())`;

    const [previous] = await this.db
      .select()
      .from(studyLog)
      .where(
        and(
          eq(studyLog.studentId, studentId),
          gte(studyLog.doneAt, yesterdayStart),
          lt(studyLog.doneAt, todayStart),
        ),
      )
      .orderBy(desc(studyLog.doneAt))
      .limit(1);

    if (!previous) {
      throw new NotFoundException('No study entry from yesterday');
    }

    const [row] = await this.db
      .insert(studyLog)
      .values({
        studentId,
        lesson: previous.lesson,
        topic: previous.topic,
        activity: previous.activity,
        exerciseCount: previous.exerciseCount,
        note: previous.note,
        minutes: 0,
        doneAt: new Date(),
        source: 'repeat_yesterday',
        status: 'pending',
      })
      .returning();

    return row;
  }

  /**
   * Aggregate one ISO week of entries. Pure read: the `pending` -> `summarized`
   * flip belongs to the future weekly-AI task, never to this endpoint.
   *
   * `weekStart` defaults to Monday 00:00 UTC of the current ISO week; an
   * explicit value is used verbatim as the window start (the client sends the
   * Monday it means), so no re-normalisation happens here.
   */
  async getWeekSummary(
    userId: string,
    weekStart?: string,
  ): Promise<WeekSummary> {
    const studentId = await this.requireStudentId(userId);

    const start =
      weekStart === undefined
        ? currentIsoWeekStart()
        : parseWeekStart(weekStart);
    const end = new Date(start.getTime() + WEEK_MS);

    const rows = await this.db
      .select()
      .from(studyLog)
      .where(
        and(
          eq(studyLog.studentId, studentId),
          gte(studyLog.doneAt, start),
          lt(studyLog.doneAt, end),
        ),
      )
      .orderBy(asc(studyLog.doneAt));

    const summary: WeekSummary = {
      weekStart: start,
      weekEnd: end,
      totalMinutes: 0,
      entries: 0,
      perActivity: {},
      perDay: {},
      vagueCount: 0,
    };

    for (const row of rows) {
      // Defensive re-filter: the query already bounds the window, this keeps a
      // mis-seeded row (or clock skew) out of the aggregate.
      if (row.doneAt < start || row.doneAt >= end) continue;

      const activity = row.activity ?? UNKNOWN_ACTIVITY;
      const day = row.doneAt.toISOString().slice(0, 10);

      summary.entries += 1;
      summary.totalMinutes += row.minutes;
      summary.perActivity[activity] =
        (summary.perActivity[activity] ?? 0) + row.minutes;
      summary.perDay[day] = (summary.perDay[day] ?? 0) + row.minutes;
      if (row.feeling === 'vague') summary.vagueCount += 1;
    }

    return summary;
  }

  /** Latest entries for the student, newest first, `limit` clamped to 50. */
  async getRecent(userId: string, limit?: number): Promise<StudyLog[]> {
    const studentId = await this.requireStudentId(userId);

    return this.db
      .select()
      .from(studyLog)
      .where(eq(studyLog.studentId, studentId))
      .orderBy(desc(studyLog.doneAt))
      .limit(clampRecentLimit(limit));
  }

  // ---------- helpers ----------

  private async requireStudentId(userId: string): Promise<string> {
    const [row] = await this.db
      .select({ id: student.id })
      .from(student)
      .where(eq(student.accountId, userId))
      .limit(1);
    if (!row) throw new NotFoundException('Student profile not found');
    return row.id;
  }
}

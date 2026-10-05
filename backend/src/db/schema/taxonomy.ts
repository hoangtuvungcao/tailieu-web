import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { degreeLevelEnum } from './enums.js';

/**
 * Academic taxonomy.
 *
 * This is the part of the schema the brief is most emphatic about: faculties,
 * programs, subjects and semesters must be editable by an administrator at
 * runtime, never hard-coded in the frontend. Everything a document references
 * lives here and is addressed by an opaque UUID, so renaming a faculty or
 * changing a program code never invalidates existing documents.
 *
 * Multi-tenancy is deferred, but every table carries a reserved `tenant_id`
 * that is always NULL and is never referenced in a WHERE clause. When a second
 * university is onboarded, the migration adds an FK and a partial unique index
 * that includes it — feature code does not change.
 *
 * Soft-delete rule: every user-facing natural key gets a PARTIAL unique index
 * on `deleted_at IS NULL`. A plain UNIQUE would let a deleted row permanently
 * burn its code, so a faculty could never be recreated after a mistaken delete.
 */

const softDeleteColumns = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
};

export const faculties = pgTable(
  'faculties',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    code: text('code').notNull(),
    name: text('name').notNull(),
    shortName: text('short_name'),
    description: text('description'),
    /** Lucide icon name rendered by the frontend; keeps icon choice data-driven. */
    icon: text('icon'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    tenantId: uuid('tenant_id'),
    ...softDeleteColumns,
  },
  (t) => [
    uniqueIndex('faculties_code_uq')
      .on(t.code)
      .where(sql`deleted_at IS NULL`),
    index('faculties_active_idx')
      .on(t.sortOrder, t.name)
      .where(sql`deleted_at IS NULL AND is_active`),
  ],
);

export const programs = pgTable(
  'programs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    facultyId: uuid('faculty_id')
      .notNull()
      // RESTRICT, never CASCADE: deleting a faculty must not silently delete
      // every program and document beneath it. Deactivate the faculty instead.
      .references(() => faculties.id, { onDelete: 'restrict' }),
    /** Vietnamese MOET program code, e.g. "7480201". Globally unique. */
    code: text('code').notNull(),
    name: text('name').notNull(),
    shortName: text('short_name'),
    description: text('description'),
    degreeLevel: degreeLevelEnum('degree_level').notNull().default('undergraduate'),
    durationYears: smallint('duration_years'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    tenantId: uuid('tenant_id'),
    ...softDeleteColumns,
  },
  (t) => [
    uniqueIndex('programs_code_uq')
      .on(t.code)
      .where(sql`deleted_at IS NULL`),
    index('programs_faculty_idx')
      .on(t.facultyId, t.sortOrder)
      .where(sql`deleted_at IS NULL AND is_active`),
  ],
);

export const academicYears = pgTable(
  'academic_years',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    code: text('code').notNull(),
    name: text('name').notNull(),
    startsOn: date('starts_on'),
    endsOn: date('ends_on'),
    isCurrent: boolean('is_current').notNull().default(false),
    /** Graduation year for alumni-facing filtering. */
    graduationYear: smallint('graduation_year'),
    tenantId: uuid('tenant_id'),
    ...softDeleteColumns,
  },
  (t) => [
    uniqueIndex('academic_years_code_uq')
      .on(t.code)
      .where(sql`deleted_at IS NULL`),
    // Exactly one academic year may be flagged current. Enforced by the
    // database rather than by application discipline.
    uniqueIndex('academic_years_single_current_uq')
      .on(t.isCurrent)
      .where(sql`is_current AND deleted_at IS NULL`),
  ],
);

export const semesters = pgTable(
  'semesters',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    academicYearId: uuid('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'restrict' }),
    /** 1, 2, 3 — term number within the academic year. */
    termNo: smallint('term_no').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    startsOn: date('starts_on'),
    endsOn: date('ends_on'),
    isCurrent: boolean('is_current').notNull().default(false),
    tenantId: uuid('tenant_id'),
    ...softDeleteColumns,
  },
  (t) => [
    uniqueIndex('semesters_year_term_uq')
      .on(t.academicYearId, t.termNo)
      .where(sql`deleted_at IS NULL`),
    uniqueIndex('semesters_single_current_uq')
      .on(t.isCurrent)
      .where(sql`is_current AND deleted_at IS NULL`),
  ],
);

/** A subject (học phần) in the university-wide catalog, independent of program. */
export const subjects = pgTable(
  'subjects',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    code: text('code').notNull(),
    name: text('name').notNull(),
    nameEn: text('name_en'),
    credits: smallint('credits'),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(true),
    tenantId: uuid('tenant_id'),
    ...softDeleteColumns,
  },
  (t) => [
    uniqueIndex('subjects_code_uq')
      .on(t.code)
      .where(sql`deleted_at IS NULL`),
    // Trigram index over the unaccented name so a partial or diacritic-free
    // query ("cong nghe") still finds "Công nghệ thông tin".
    index('subjects_name_trgm_idx').using(
      'gin',
      sql`immutable_unaccent(name) gin_trgm_ops`,
    ),
    index('subjects_active_idx')
      .on(t.name)
      .where(sql`deleted_at IS NULL AND is_active`),
  ],
);

/** Curriculum mapping: which subjects belong to which program, and when. */
export const programSubjects = pgTable(
  'program_subjects',
  {
    programId: uuid('program_id')
      .notNull()
      .references(() => programs.id, { onDelete: 'cascade' }),
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'cascade' }),
    /** Suggested semester number within the program. */
    semesterNo: smallint('semester_no'),
    isRequired: boolean('is_required').notNull().default(true),
    tenantId: uuid('tenant_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.programId, t.subjectId] }),
    index('program_subjects_subject_idx').on(t.subjectId),
  ],
);

/**
 * A course is a *section offering* of a subject in a specific semester
 * ("lớp học phần") — distinct from the subject catalog above. This is what a
 * document's `course_id` points at, matching the brief's example
 * ("Course: C2026, Subject: C++ Programming").
 */
export const courses = pgTable(
  'courses',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'restrict' }),
    programId: uuid('program_id').references(() => programs.id, { onDelete: 'restrict' }),
    semesterId: uuid('semester_id')
      .notNull()
      .references(() => semesters.id, { onDelete: 'restrict' }),
    /** User id of the lecturer, added as a plain column to avoid a circular
     *  import between the taxonomy and identity schema modules. */
    lecturerUserId: uuid('lecturer_user_id'),
    code: text('code').notNull(),
    name: text('name'),
    capacity: smallint('capacity'),
    isActive: boolean('is_active').notNull().default(true),
    tenantId: uuid('tenant_id'),
    ...softDeleteColumns,
  },
  (t) => [
    uniqueIndex('courses_semester_code_uq')
      .on(t.semesterId, t.code)
      .where(sql`deleted_at IS NULL`),
    index('courses_subject_idx')
      .on(t.subjectId)
      .where(sql`deleted_at IS NULL`),
  ],
);

/**
 * Document categories from the brief (textbook, lecture notes, exam, thesis,
 * answer key, …). A TABLE, not an enum, because administrators must be able to
 * add categories without a deployment.
 */
export const documentTypes = pgTable(
  'document_types',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    code: text('code').notNull(),
    name: text('name').notNull(),
    nameEn: text('name_en'),
    description: text('description'),
    /** Default moderation policy applied to documents of this category. */
    moderationPolicy: text('moderation_policy').notNull().default('allowed'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    tenantId: uuid('tenant_id'),
    ...softDeleteColumns,
  },
  (t) => [
    uniqueIndex('document_types_code_uq')
      .on(t.code)
      .where(sql`deleted_at IS NULL`),
    index('document_types_active_idx')
      .on(t.sortOrder)
      .where(sql`deleted_at IS NULL AND is_active`),
  ],
);

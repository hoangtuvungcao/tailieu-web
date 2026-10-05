import { and, asc, count, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';

import { db, type Database } from '../../db/client.js';
import {
  academicYears,
  courses,
  documentTypes,
  documents,
  faculties,
  programs,
  semesters,
  subjects,
} from '../../db/schema/index.js';
import { activeTaxonomy } from '../../db/schema/predicates.js';
import { toOffset, type PaginationInput } from '../../lib/pagination.js';

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Executor = Tx | typeof db;

/**
 * Taxonomy data access.
 *
 * Two rules run through this file:
 *
 *   1. Deletion is soft, and `is_active` is the real kill switch. A faculty that
 *      has documents cannot be deleted at all — the foreign keys are RESTRICT,
 *      so the database refuses before any application check runs. That is the
 *      correct behaviour: silently cascading would destroy the academic record
 *      of every document filed under it.
 *
 *   2. Search is diacritic- and case-insensitive, via the unaccented trigram
 *      index. A student typing "cong nghe" must find "Công nghệ", and the
 *      index has to be usable — an ILIKE on the raw column would be a
 *      sequential scan on every keystroke.
 */

/** Accent- and case-insensitive name/code search, index-friendly. */
function searchPredicate(columns: SQL[], term: string): SQL {
  const pattern = `%${term}%`;
  const clauses = columns.map(
    (column) => sql`immutable_unaccent(${column}) ILIKE immutable_unaccent(${pattern})`,
  );
  return or(...clauses)!;
}

/**
 * Build predicates from Drizzle column objects rather than raw SQL.
 *
 * Writing `sql\`p.deleted_at IS NULL\`` looks equivalent but is not: Drizzle
 * names tables itself, so a hand-written alias only matches the query it was
 * written against. Reusing the same predicate object in a joined count query
 * then fails with "missing FROM-clause entry for table p" — at runtime, on the
 * paginated path only. Column references render with the correct qualification
 * in every query that uses them.
 */
function withSearch(
  columns: SQL[],
  term: string | undefined,
  base: SQL[],
): SQL {
  return term ? and(...base, searchPredicate(columns, term))! : and(...base)!;
}

// =============================================================================
// Faculties
// =============================================================================

export interface FacultyListFilters {
  q?: string;
  isActive?: boolean;
}

export async function listFaculties(
  filters: FacultyListFilters,
  pagination: PaginationInput,
  executor: Executor = db,
) {
  const conditions: SQL[] = [sql`deleted_at IS NULL`];
  if (filters.isActive !== undefined) {
    conditions.push(sql`is_active = ${filters.isActive}`);
  }
  if (filters.q) {
    conditions.push(searchPredicate([sql`name`, sql`code`, sql`short_name`], filters.q));
  }
  const where = and(...conditions);

  const [items, [totalRow]] = await Promise.all([
    executor
      .select()
      .from(faculties)
      .where(where)
      .orderBy(asc(faculties.sortOrder), asc(faculties.name))
      .limit(pagination.limit)
      .offset(toOffset(pagination)),
    executor.select({ value: count() }).from(faculties).where(where),
  ]);

  return { items, total: Number(totalRow?.value ?? 0) };
}

export async function findFacultyById(id: string, executor: Executor = db) {
  const rows = await executor
    .select()
    .from(faculties)
    .where(and(eq(faculties.id, id), isNull(faculties.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findFacultyByCode(code: string, executor: Executor = db) {
  const rows = await executor
    .select({ id: faculties.id })
    .from(faculties)
    .where(and(eq(faculties.code, code), isNull(faculties.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function insertFaculty(
  executor: Executor,
  values: {
    code: string;
    name: string;
    shortName: string | null;
    description: string | null;
    icon: string | null;
    sortOrder: number;
  },
) {
  const [row] = await executor.insert(faculties).values(values).returning();
  return row!;
}

export async function updateFaculty(
  executor: Executor,
  id: string,
  values: Partial<{
    name: string;
    shortName: string | null;
    description: string | null;
    icon: string | null;
    sortOrder: number;
    isActive: boolean;
  }>,
) {
  const [row] = await executor
    .update(faculties)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(faculties.id, id))
    .returning();
  return row ?? null;
}

export async function softDeleteFaculty(executor: Executor, id: string) {
  const [row] = await executor
    .update(faculties)
    .set({ deletedAt: new Date(), isActive: false, updatedAt: new Date() })
    .where(eq(faculties.id, id))
    .returning({ id: faculties.id });
  return row ?? null;
}

/** How many live programs and documents reference this faculty. */
export async function facultyUsage(id: string, executor: Executor = db) {
  const [[programRow], [documentRow]] = await Promise.all([
    executor
      .select({ value: count() })
      .from(programs)
      .where(and(eq(programs.facultyId, id), isNull(programs.deletedAt))),
    executor
      .select({ value: count() })
      .from(documents)
      .where(and(eq(documents.facultyId, id), isNull(documents.deletedAt))),
  ]);
  return {
    programs: Number(programRow?.value ?? 0),
    documents: Number(documentRow?.value ?? 0),
  };
}

// =============================================================================
// Programs
// =============================================================================

export interface ProgramListFilters {
  q?: string;
  facultyId?: string;
  degreeLevel?: 'undergraduate' | 'postgraduate' | 'college';
  isActive?: boolean;
}

export async function listPrograms(
  filters: ProgramListFilters,
  pagination: PaginationInput,
  executor: Executor = db,
) {
  const predicates: SQL[] = [isNull(programs.deletedAt)];
  if (filters.facultyId) predicates.push(eq(programs.facultyId, filters.facultyId));
  if (filters.isActive !== undefined) predicates.push(eq(programs.isActive, filters.isActive));
  if (filters.degreeLevel) predicates.push(eq(programs.degreeLevel, filters.degreeLevel));

  const where = withSearch(
    [sql`${programs.name}`, sql`${programs.code}`, sql`${programs.shortName}`],
    filters.q,
    predicates,
  );

  const [items, [totalRow]] = await Promise.all([
    executor
      .select({
        id: programs.id,
        code: programs.code,
        name: programs.name,
        shortName: programs.shortName,
        degreeLevel: programs.degreeLevel,
        durationYears: programs.durationYears,
        sortOrder: programs.sortOrder,
        isActive: programs.isActive,
        facultyId: programs.facultyId,
        facultyName: faculties.name,
        facultyCode: faculties.code,
      })
      .from(programs)
      .innerJoin(faculties, eq(faculties.id, programs.facultyId))
      .where(where)
      .orderBy(asc(faculties.sortOrder), asc(programs.sortOrder), asc(programs.name))
      .limit(pagination.limit)
      .offset(toOffset(pagination)),
    executor
      .select({ value: count() })
      .from(programs)
      .innerJoin(faculties, eq(faculties.id, programs.facultyId))
      .where(where),
  ]);

  return { items, total: Number(totalRow?.value ?? 0) };
}

export async function findProgramById(id: string, executor: Executor = db) {
  const rows = await executor
    .select()
    .from(programs)
    .where(and(eq(programs.id, id), isNull(programs.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findProgramByCode(code: string, executor: Executor = db) {
  const rows = await executor
    .select({ id: programs.id })
    .from(programs)
    .where(and(eq(programs.code, code), isNull(programs.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function insertProgram(
  executor: Executor,
  values: {
    facultyId: string;
    code: string;
    name: string;
    shortName: string | null;
    description: string | null;
    degreeLevel: 'undergraduate' | 'postgraduate' | 'college';
    durationYears: number | null;
    sortOrder: number;
  },
) {
  const [row] = await executor.insert(programs).values(values).returning();
  return row!;
}

export async function updateProgram(
  executor: Executor,
  id: string,
  values: Partial<{
    facultyId: string;
    name: string;
    shortName: string | null;
    description: string | null;
    degreeLevel: 'undergraduate' | 'postgraduate' | 'college';
    durationYears: number | null;
    sortOrder: number;
    isActive: boolean;
  }>,
) {
  const [row] = await executor
    .update(programs)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(programs.id, id))
    .returning();
  return row ?? null;
}

export async function softDeleteProgram(executor: Executor, id: string) {
  const [row] = await executor
    .update(programs)
    .set({ deletedAt: new Date(), isActive: false, updatedAt: new Date() })
    .where(eq(programs.id, id))
    .returning({ id: programs.id });
  return row ?? null;
}

export async function programUsage(id: string, executor: Executor = db) {
  const [row] = await executor
    .select({ value: count() })
    .from(documents)
    .where(and(eq(documents.programId, id), isNull(documents.deletedAt)));
  return { documents: Number(row?.value ?? 0) };
}

// =============================================================================
// Subjects
// =============================================================================

export async function listSubjects(
  filters: { q?: string; isActive?: boolean },
  pagination: PaginationInput,
  executor: Executor = db,
) {
  const conditions: SQL[] = [sql`deleted_at IS NULL`];
  if (filters.isActive !== undefined) conditions.push(sql`is_active = ${filters.isActive}`);
  if (filters.q) conditions.push(searchPredicate([sql`name`, sql`code`], filters.q));
  const where = and(...conditions);

  const [items, [totalRow]] = await Promise.all([
    executor
      .select()
      .from(subjects)
      .where(where)
      .orderBy(asc(subjects.name))
      .limit(pagination.limit)
      .offset(toOffset(pagination)),
    executor.select({ value: count() }).from(subjects).where(where),
  ]);

  return { items, total: Number(totalRow?.value ?? 0) };
}

export async function findSubjectById(id: string, executor: Executor = db) {
  const rows = await executor
    .select()
    .from(subjects)
    .where(and(eq(subjects.id, id), isNull(subjects.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findSubjectByCode(code: string, executor: Executor = db) {
  const rows = await executor
    .select({ id: subjects.id })
    .from(subjects)
    .where(and(eq(subjects.code, code), isNull(subjects.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function insertSubject(
  executor: Executor,
  values: {
    code: string;
    name: string;
    nameEn: string | null;
    credits: number | null;
    description: string | null;
  },
) {
  const [row] = await executor.insert(subjects).values(values).returning();
  return row!;
}

export async function updateSubject(
  executor: Executor,
  id: string,
  values: Partial<{
    name: string;
    nameEn: string | null;
    credits: number | null;
    description: string | null;
    isActive: boolean;
  }>,
) {
  const [row] = await executor
    .update(subjects)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(subjects.id, id))
    .returning();
  return row ?? null;
}

export async function softDeleteSubject(executor: Executor, id: string) {
  const [row] = await executor
    .update(subjects)
    .set({ deletedAt: new Date(), isActive: false, updatedAt: new Date() })
    .where(eq(subjects.id, id))
    .returning({ id: subjects.id });
  return row ?? null;
}

export async function subjectUsage(id: string, executor: Executor = db) {
  const [row] = await executor
    .select({ value: count() })
    .from(documents)
    .where(and(eq(documents.subjectId, id), isNull(documents.deletedAt)));
  return { documents: Number(row?.value ?? 0) };
}

// =============================================================================
// Academic years and semesters
// =============================================================================

export async function listAcademicYears(pagination: PaginationInput, executor: Executor = db) {
  const where = sql`deleted_at IS NULL`;
  const [items, [totalRow]] = await Promise.all([
    executor
      .select()
      .from(academicYears)
      .where(where)
      .orderBy(sql`code DESC`)
      .limit(pagination.limit)
      .offset(toOffset(pagination)),
    executor.select({ value: count() }).from(academicYears).where(where),
  ]);
  return { items, total: Number(totalRow?.value ?? 0) };
}

export async function findAcademicYearById(id: string, executor: Executor = db) {
  const rows = await executor
    .select()
    .from(academicYears)
    .where(and(eq(academicYears.id, id), isNull(academicYears.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function insertAcademicYear(
  executor: Executor,
  values: {
    code: string;
    name: string;
    startsOn: string | null;
    endsOn: string | null;
    graduationYear: number | null;
    isCurrent: boolean;
  },
) {
  // Only one year may be current — enforced by a partial unique index, so
  // clear the flag first rather than letting the insert fail with a constraint
  // error the caller cannot act on.
  if (values.isCurrent) {
    await executor
      .update(academicYears)
      .set({ isCurrent: false })
      .where(eq(academicYears.isCurrent, true));
  }
  const [row] = await executor.insert(academicYears).values(values).returning();
  return row!;
}

export async function updateAcademicYear(
  executor: Executor,
  id: string,
  values: Partial<{
    name: string;
    startsOn: string | null;
    endsOn: string | null;
    graduationYear: number | null;
    isCurrent: boolean;
  }>,
) {
  if (values.isCurrent) {
    await executor
      .update(academicYears)
      .set({ isCurrent: false })
      .where(eq(academicYears.isCurrent, true));
  }
  const [row] = await executor
    .update(academicYears)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(academicYears.id, id))
    .returning();
  return row ?? null;
}

export async function listSemesters(
  filters: { academicYearId?: string },
  pagination: PaginationInput,
  executor: Executor = db,
) {
  const predicates: SQL[] = [isNull(semesters.deletedAt)];
  if (filters.academicYearId) {
    predicates.push(eq(semesters.academicYearId, filters.academicYearId));
  }
  const where = and(...predicates)!;

  const [items, [totalRow]] = await Promise.all([
    executor
      .select({
        id: semesters.id,
        code: semesters.code,
        name: semesters.name,
        termNo: semesters.termNo,
        startsOn: semesters.startsOn,
        endsOn: semesters.endsOn,
        isCurrent: semesters.isCurrent,
        academicYearId: semesters.academicYearId,
        academicYearCode: academicYears.code,
      })
      .from(semesters)
      .innerJoin(academicYears, eq(academicYears.id, semesters.academicYearId))
      .where(where)
      .orderBy(desc(academicYears.code), asc(semesters.termNo))
      .limit(pagination.limit)
      .offset(toOffset(pagination)),
    executor
      .select({ value: count() })
      .from(semesters)
      .innerJoin(academicYears, eq(academicYears.id, semesters.academicYearId))
      .where(where),
  ]);

  return { items, total: Number(totalRow?.value ?? 0) };
}

export async function findSemesterById(id: string, executor: Executor = db) {
  const rows = await executor
    .select()
    .from(semesters)
    .where(and(eq(semesters.id, id), isNull(semesters.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function insertSemester(
  executor: Executor,
  values: {
    academicYearId: string;
    termNo: number;
    code: string;
    name: string;
    startsOn: string | null;
    endsOn: string | null;
    isCurrent: boolean;
  },
) {
  if (values.isCurrent) {
    await executor.update(semesters).set({ isCurrent: false }).where(eq(semesters.isCurrent, true));
  }
  const [row] = await executor.insert(semesters).values(values).returning();
  return row!;
}

export async function updateSemester(
  executor: Executor,
  id: string,
  values: Partial<{
    name: string;
    startsOn: string | null;
    endsOn: string | null;
    isCurrent: boolean;
  }>,
) {
  if (values.isCurrent) {
    await executor.update(semesters).set({ isCurrent: false }).where(eq(semesters.isCurrent, true));
  }
  const [row] = await executor
    .update(semesters)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(semesters.id, id))
    .returning();
  return row ?? null;
}

// =============================================================================
// Courses
// =============================================================================

export async function listCourses(
  filters: { subjectId?: string; programId?: string; academicYearId?: string },
  pagination: PaginationInput,
  executor: Executor = db,
) {
  const predicates: SQL[] = [isNull(courses.deletedAt)];
  if (filters.subjectId) predicates.push(eq(courses.subjectId, filters.subjectId));
  if (filters.programId) predicates.push(eq(courses.programId, filters.programId));
  if (filters.academicYearId) {
    predicates.push(eq(semesters.academicYearId, filters.academicYearId));
  }
  const where = and(...predicates)!;

  const [items, [totalRow]] = await Promise.all([
    executor
      .select({
        id: courses.id,
        code: courses.code,
        name: courses.name,
        capacity: courses.capacity,
        isActive: courses.isActive,
        subjectId: courses.subjectId,
        subjectName: subjects.name,
        semesterId: courses.semesterId,
        semesterCode: semesters.code,
      })
      .from(courses)
      .innerJoin(subjects, eq(subjects.id, courses.subjectId))
      .innerJoin(semesters, eq(semesters.id, courses.semesterId))
      .where(where)
      .orderBy(asc(courses.code))
      .limit(pagination.limit)
      .offset(toOffset(pagination)),
    executor
      .select({ value: count() })
      .from(courses)
      .innerJoin(subjects, eq(subjects.id, courses.subjectId))
      .innerJoin(semesters, eq(semesters.id, courses.semesterId))
      .where(where),
  ]);

  return { items, total: Number(totalRow?.value ?? 0) };
}

export async function findCourseById(id: string, executor: Executor = db) {
  const rows = await executor
    .select()
    .from(courses)
    .where(and(eq(courses.id, id), isNull(courses.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function insertCourse(
  executor: Executor,
  values: {
    subjectId: string;
    programId: string | null;
    semesterId: string;
    lecturerUserId: string | null;
    code: string;
    name: string | null;
    capacity: number | null;
  },
) {
  const [row] = await executor.insert(courses).values(values).returning();
  return row!;
}

export async function updateCourse(
  executor: Executor,
  id: string,
  values: Partial<{
    name: string | null;
    lecturerUserId: string | null;
    capacity: number | null;
    isActive: boolean;
  }>,
) {
  const [row] = await executor
    .update(courses)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(courses.id, id))
    .returning();
  return row ?? null;
}

// =============================================================================
// Document types
// =============================================================================

export async function listDocumentTypes(
  filters: { isActive?: boolean },
  pagination: PaginationInput,
  executor: Executor = db,
) {
  const conditions: SQL[] = [sql`deleted_at IS NULL`];
  if (filters.isActive !== undefined) conditions.push(sql`is_active = ${filters.isActive}`);
  const where = and(...conditions);

  const [items, [totalRow]] = await Promise.all([
    executor
      .select()
      .from(documentTypes)
      .where(where)
      .orderBy(asc(documentTypes.sortOrder), asc(documentTypes.name))
      .limit(pagination.limit)
      .offset(toOffset(pagination)),
    executor.select({ value: count() }).from(documentTypes).where(where),
  ]);

  return { items, total: Number(totalRow?.value ?? 0) };
}

export async function findDocumentTypeById(id: string, executor: Executor = db) {
  const rows = await executor
    .select()
    .from(documentTypes)
    .where(and(eq(documentTypes.id, id), isNull(documentTypes.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findDocumentTypeByCode(code: string, executor: Executor = db) {
  const rows = await executor
    .select({ id: documentTypes.id })
    .from(documentTypes)
    .where(and(eq(documentTypes.code, code), isNull(documentTypes.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function insertDocumentType(
  executor: Executor,
  values: {
    code: string;
    name: string;
    nameEn: string | null;
    description: string | null;
    moderationPolicy: 'allowed' | 'review_required' | 'blocked';
    sortOrder: number;
  },
) {
  const [row] = await executor.insert(documentTypes).values(values).returning();
  return row!;
}

export async function updateDocumentType(
  executor: Executor,
  id: string,
  values: Partial<{
    name: string;
    nameEn: string | null;
    description: string | null;
    moderationPolicy: 'allowed' | 'review_required' | 'blocked';
    sortOrder: number;
    isActive: boolean;
  }>,
) {
  const [row] = await executor
    .update(documentTypes)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(documentTypes.id, id))
    .returning();
  return row ?? null;
}

// =============================================================================
// Navigation tree
// =============================================================================

/**
 * Faculties with their active programs, for the site navigation.
 *
 * Fetched as two queries and assembled in memory rather than with a join,
 * because the join would repeat the faculty row for every program and require
 * de-duplication anyway. Two queries with an index on `programs.faculty_id` is
 * both cheaper and easier to read.
 */
export async function buildTaxonomyTree(executor: Executor = db) {
  const facultyRows = await executor
    .select({
      id: faculties.id,
      code: faculties.code,
      name: faculties.name,
      shortName: faculties.shortName,
      icon: faculties.icon,
      sortOrder: faculties.sortOrder,
    })
    .from(faculties)
    .where(and(sql`deleted_at IS NULL`, activeTaxonomy))
    .orderBy(asc(faculties.sortOrder), asc(faculties.name));

  const programRows = await executor
    .select({
      id: programs.id,
      facultyId: programs.facultyId,
      code: programs.code,
      name: programs.name,
      shortName: programs.shortName,
      degreeLevel: programs.degreeLevel,
      durationYears: programs.durationYears,
      sortOrder: programs.sortOrder,
    })
    .from(programs)
    .where(and(sql`deleted_at IS NULL`, activeTaxonomy))
    .orderBy(asc(programs.sortOrder), asc(programs.name));

  const byFaculty = new Map<string, typeof programRows>();
  for (const program of programRows) {
    const list = byFaculty.get(program.facultyId) ?? [];
    list.push(program);
    byFaculty.set(program.facultyId, list);
  }

  return facultyRows.map((faculty) => ({
    ...faculty,
    programs: byFaculty.get(faculty.id) ?? [],
  }));
}

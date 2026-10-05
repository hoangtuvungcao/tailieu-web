import { db } from '../../db/client.js';
import { recordAudit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { paginate, type PaginationInput } from '../../lib/pagination.js';
import type { RequestContext } from '../auth/auth.service.js';
import * as repo from './taxonomy.repository.js';

/**
 * Taxonomy service.
 *
 * Every mutation runs in a transaction and writes its audit row inside it. An
 * administrator renaming a faculty silently rewrites the search haystack of
 * every document filed under it (a database trigger handles that), so "who
 * changed this and when" is a question that will be asked.
 *
 * Referential integrity is checked here for good error messages, but the
 * database is the actual guarantee: the foreign keys are RESTRICT and will
 * refuse a bad reference even if this file has a bug.
 */

// =============================================================================
// Read paths
// =============================================================================

export async function listFaculties(filters: repo.FacultyListFilters, pagination: PaginationInput) {
  const { items, total } = await repo.listFaculties(filters, pagination);
  return paginate(items, total, pagination);
}

export async function listPrograms(filters: repo.ProgramListFilters, pagination: PaginationInput) {
  const { items, total } = await repo.listPrograms(filters, pagination);
  return paginate(items, total, pagination);
}

export async function listSubjects(
  filters: { q?: string; isActive?: boolean },
  pagination: PaginationInput,
) {
  const { items, total } = await repo.listSubjects(filters, pagination);
  return paginate(items, total, pagination);
}

export async function listAcademicYears(pagination: PaginationInput) {
  const { items, total } = await repo.listAcademicYears(pagination);
  return paginate(items, total, pagination);
}

export async function listSemesters(
  filters: { academicYearId?: string },
  pagination: PaginationInput,
) {
  const { items, total } = await repo.listSemesters(filters, pagination);
  return paginate(items, total, pagination);
}

export async function listCourses(
  filters: { subjectId?: string; programId?: string; academicYearId?: string },
  pagination: PaginationInput,
) {
  const { items, total } = await repo.listCourses(filters, pagination);
  return paginate(items, total, pagination);
}

export async function listDocumentTypes(
  filters: { isActive?: boolean },
  pagination: PaginationInput,
) {
  const { items, total } = await repo.listDocumentTypes(filters, pagination);
  return paginate(items, total, pagination);
}

export function getTree() {
  return repo.buildTaxonomyTree();
}

export async function getFaculty(id: string) {
  const faculty = await repo.findFacultyById(id);
  if (!faculty) throw new AppError('FACULTY_NOT_FOUND', 'Faculty not found.');
  return faculty;
}

export async function getProgram(id: string) {
  const program = await repo.findProgramById(id);
  if (!program) throw new AppError('PROGRAM_NOT_FOUND', 'Program not found.');
  return program;
}

export async function getSubject(id: string) {
  const subject = await repo.findSubjectById(id);
  if (!subject) throw new AppError('SUBJECT_NOT_FOUND', 'Subject not found.');
  return subject;
}

export async function getCourse(id: string) {
  const course = await repo.findCourseById(id);
  if (!course) throw new AppError('COURSE_NOT_FOUND', 'Course not found.');
  return course;
}

// =============================================================================
// Faculties
// =============================================================================

export async function createFaculty(
  input: {
    code: string;
    name: string;
    shortName: string | null;
    description: string | null;
    icon: string | null;
    sortOrder: number;
  },
  context: RequestContext,
) {
  return db.transaction(async (tx) => {
    if (await repo.findFacultyByCode(input.code, tx)) {
      throw new AppError('FACULTY_CODE_TAKEN', `Mã khoa "${input.code}" đã tồn tại.`);
    }

    const faculty = await repo.insertFaculty(tx, input);

    await recordAudit(tx, {
      action: 'taxonomy.faculty.created',
      actorUserId: context.actorUserId ?? null,
      targetType: 'faculty',
      targetId: faculty.id,
      metadata: { code: faculty.code, name: faculty.name },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return faculty;
  });
}

export async function updateFaculty(
  id: string,
  input: Partial<{
    name: string;
    shortName: string | null;
    description: string | null;
    icon: string | null;
    sortOrder: number;
    isActive: boolean;
  }>,
  context: RequestContext,
) {
  return db.transaction(async (tx) => {
    const existing = await repo.findFacultyById(id, tx);
    if (!existing) throw new AppError('FACULTY_NOT_FOUND', 'Faculty not found.');

    const updated = await repo.updateFaculty(tx, id, input);
    if (!updated) throw new AppError('FACULTY_NOT_FOUND', 'Faculty not found.');

    await recordAudit(tx, {
      action: 'taxonomy.faculty.updated',
      actorUserId: context.actorUserId ?? null,
      targetType: 'faculty',
      targetId: id,
      metadata: {
        before: { name: existing.name, shortName: existing.shortName, isActive: existing.isActive },
        after: { name: updated.name, shortName: updated.shortName, isActive: updated.isActive },
      },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return updated;
  });
}

/**
 * Soft-delete a faculty.
 *
 * Refuses while programs or documents still reference it. The database would
 * refuse anyway (RESTRICT), but a raw constraint violation tells the
 * administrator nothing — this turns it into "deactivate it instead, or move
 * its 37 programs first", which is actionable.
 */
export async function deleteFaculty(id: string, context: RequestContext) {
  return db.transaction(async (tx) => {
    const existing = await repo.findFacultyById(id, tx);
    if (!existing) throw new AppError('FACULTY_NOT_FOUND', 'Faculty not found.');

    const usage = await repo.facultyUsage(id, tx);
    if (usage.programs > 0 || usage.documents > 0) {
      throw new AppError(
        'FACULTY_IN_USE',
        `Không thể xoá: còn ${usage.programs} ngành và ${usage.documents} tài liệu đang thuộc khoa này. ` +
          'Hãy chuyển chúng sang khoa khác, hoặc tạm ẩn khoa thay vì xoá.',
        { details: usage },
      );
    }

    await repo.softDeleteFaculty(tx, id);

    await recordAudit(tx, {
      action: 'taxonomy.faculty.deleted',
      actorUserId: context.actorUserId ?? null,
      targetType: 'faculty',
      targetId: id,
      metadata: { code: existing.code, name: existing.name },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return { deleted: true };
  });
}

// =============================================================================
// Programs
// =============================================================================

export async function createProgram(
  input: {
    facultyId: string;
    code: string;
    name: string;
    shortName: string | null;
    description: string | null;
    degreeLevel: 'undergraduate' | 'postgraduate' | 'college';
    durationYears: number | null;
    sortOrder: number;
  },
  context: RequestContext,
) {
  return db.transaction(async (tx) => {
    // Checked before insert so the error names the problem. The FK would also
    // catch it, but "violates foreign key constraint" is not a usable message.
    const faculty = await repo.findFacultyById(input.facultyId, tx);
    if (!faculty) {
      throw new AppError(
        'TAXONOMY_INVALID_REFERENCE',
        'Khoa được chọn không tồn tại hoặc đã bị xoá.',
      );
    }

    if (await repo.findProgramByCode(input.code, tx)) {
      throw new AppError('PROGRAM_CODE_TAKEN', `Mã ngành "${input.code}" đã tồn tại.`);
    }

    const program = await repo.insertProgram(tx, input);

    await recordAudit(tx, {
      action: 'taxonomy.program.created',
      actorUserId: context.actorUserId ?? null,
      targetType: 'program',
      targetId: program.id,
      metadata: { code: program.code, name: program.name, facultyId: input.facultyId },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return program;
  });
}

export async function updateProgram(
  id: string,
  input: Partial<{
    facultyId: string;
    name: string;
    shortName: string | null;
    description: string | null;
    degreeLevel: 'undergraduate' | 'postgraduate' | 'college';
    durationYears: number | null;
    sortOrder: number;
    isActive: boolean;
  }>,
  context: RequestContext,
) {
  return db.transaction(async (tx) => {
    const existing = await repo.findProgramById(id, tx);
    if (!existing) throw new AppError('PROGRAM_NOT_FOUND', 'Program not found.');

    if (input.facultyId && input.facultyId !== existing.facultyId) {
      const faculty = await repo.findFacultyById(input.facultyId, tx);
      if (!faculty) {
        throw new AppError('TAXONOMY_INVALID_REFERENCE', 'Khoa được chọn không tồn tại.');
      }
    }

    const updated = await repo.updateProgram(tx, id, input);
    if (!updated) throw new AppError('PROGRAM_NOT_FOUND', 'Program not found.');

    await recordAudit(tx, {
      action: input.facultyId && input.facultyId !== existing.facultyId
        ? 'taxonomy.program.moved'
        : 'taxonomy.program.updated',
      actorUserId: context.actorUserId ?? null,
      targetType: 'program',
      targetId: id,
      metadata: {
        before: { name: existing.name, facultyId: existing.facultyId, isActive: existing.isActive },
        after: { name: updated.name, facultyId: updated.facultyId, isActive: updated.isActive },
      },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return updated;
  });
}

export async function deleteProgram(id: string, context: RequestContext) {
  return db.transaction(async (tx) => {
    const existing = await repo.findProgramById(id, tx);
    if (!existing) throw new AppError('PROGRAM_NOT_FOUND', 'Program not found.');

    const usage = await repo.programUsage(id, tx);
    if (usage.documents > 0) {
      throw new AppError(
        'CONFLICT',
        `Không thể xoá: còn ${usage.documents} tài liệu thuộc ngành này. Hãy tạm ẩn ngành thay vì xoá.`,
        { details: usage },
      );
    }

    await repo.softDeleteProgram(tx, id);

    await recordAudit(tx, {
      action: 'taxonomy.program.deleted',
      actorUserId: context.actorUserId ?? null,
      targetType: 'program',
      targetId: id,
      metadata: { code: existing.code, name: existing.name },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return { deleted: true };
  });
}

// =============================================================================
// Subjects
// =============================================================================

export async function createSubject(
  input: {
    code: string;
    name: string;
    nameEn: string | null;
    credits: number | null;
    description: string | null;
  },
  context: RequestContext,
) {
  return db.transaction(async (tx) => {
    if (await repo.findSubjectByCode(input.code, tx)) {
      throw new AppError('SUBJECT_CODE_TAKEN', `Mã học phần "${input.code}" đã tồn tại.`);
    }

    const subject = await repo.insertSubject(tx, input);

    await recordAudit(tx, {
      action: 'taxonomy.subject.created',
      actorUserId: context.actorUserId ?? null,
      targetType: 'subject',
      targetId: subject.id,
      metadata: { code: subject.code, name: subject.name },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return subject;
  });
}

export async function updateSubject(
  id: string,
  input: Partial<{
    name: string;
    nameEn: string | null;
    credits: number | null;
    description: string | null;
    isActive: boolean;
  }>,
  context: RequestContext,
) {
  return db.transaction(async (tx) => {
    const existing = await repo.findSubjectById(id, tx);
    if (!existing) throw new AppError('SUBJECT_NOT_FOUND', 'Subject not found.');

    const updated = await repo.updateSubject(tx, id, input);
    if (!updated) throw new AppError('SUBJECT_NOT_FOUND', 'Subject not found.');

    await recordAudit(tx, {
      action: 'taxonomy.subject.updated',
      actorUserId: context.actorUserId ?? null,
      targetType: 'subject',
      targetId: id,
      metadata: {
        before: { name: existing.name, credits: existing.credits, isActive: existing.isActive },
        after: { name: updated.name, credits: updated.credits, isActive: updated.isActive },
      },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return updated;
  });
}

export async function deleteSubject(id: string, context: RequestContext) {
  return db.transaction(async (tx) => {
    const existing = await repo.findSubjectById(id, tx);
    if (!existing) throw new AppError('SUBJECT_NOT_FOUND', 'Subject not found.');

    const usage = await repo.subjectUsage(id, tx);
    if (usage.documents > 0) {
      throw new AppError(
        'CONFLICT',
        `Không thể xoá: còn ${usage.documents} tài liệu thuộc học phần này. Hãy tạm ẩn học phần thay vì xoá.`,
        { details: usage },
      );
    }

    await repo.softDeleteSubject(tx, id);

    await recordAudit(tx, {
      action: 'taxonomy.subject.deleted',
      actorUserId: context.actorUserId ?? null,
      targetType: 'subject',
      targetId: id,
      metadata: { code: existing.code, name: existing.name },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return { deleted: true };
  });
}

// =============================================================================
// Academic years, semesters, courses, document types
// =============================================================================

export async function createAcademicYear(
  input: {
    code: string;
    name: string;
    startsOn: string | null;
    endsOn: string | null;
    graduationYear: number | null;
    isCurrent: boolean;
  },
  context: RequestContext,
) {
  return db.transaction(async (tx) => {
    const year = await repo.insertAcademicYear(tx, input);
    await recordAudit(tx, {
      action: 'taxonomy.academic_year.created',
      actorUserId: context.actorUserId ?? null,
      targetType: 'academic_year',
      targetId: year.id,
      metadata: { code: year.code, isCurrent: year.isCurrent },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });
    return year;
  });
}

export async function updateAcademicYear(
  id: string,
  input: Partial<{
    name: string;
    startsOn: string | null;
    endsOn: string | null;
    graduationYear: number | null;
    isCurrent: boolean;
  }>,
  context: RequestContext,
) {
  return db.transaction(async (tx) => {
    const existing = await repo.findAcademicYearById(id, tx);
    if (!existing) throw new AppError('ACADEMIC_YEAR_NOT_FOUND', 'Academic year not found.');

    const updated = await repo.updateAcademicYear(tx, id, input);
    if (!updated) throw new AppError('ACADEMIC_YEAR_NOT_FOUND', 'Academic year not found.');

    await recordAudit(tx, {
      action: 'taxonomy.academic_year.updated',
      actorUserId: context.actorUserId ?? null,
      targetType: 'academic_year',
      targetId: id,
      metadata: { code: updated.code, isCurrent: updated.isCurrent },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return updated;
  });
}

export async function createSemester(
  input: {
    academicYearId: string;
    termNo: number;
    code: string;
    name: string;
    startsOn: string | null;
    endsOn: string | null;
    isCurrent: boolean;
  },
  context: RequestContext,
) {
  return db.transaction(async (tx) => {
    const year = await repo.findAcademicYearById(input.academicYearId, tx);
    if (!year) {
      throw new AppError('ACADEMIC_YEAR_NOT_FOUND', 'Năm học được chọn không tồn tại.');
    }

    const semester = await repo.insertSemester(tx, input);

    await recordAudit(tx, {
      action: 'taxonomy.semester.created',
      actorUserId: context.actorUserId ?? null,
      targetType: 'semester',
      targetId: semester.id,
      metadata: { code: semester.code, academicYearId: input.academicYearId },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return semester;
  });
}

export async function updateSemester(
  id: string,
  input: Partial<{
    name: string;
    startsOn: string | null;
    endsOn: string | null;
    isCurrent: boolean;
  }>,
  context: RequestContext,
) {
  return db.transaction(async (tx) => {
    const existing = await repo.findSemesterById(id, tx);
    if (!existing) throw new AppError('SEMESTER_NOT_FOUND', 'Semester not found.');

    const updated = await repo.updateSemester(tx, id, input);
    if (!updated) throw new AppError('SEMESTER_NOT_FOUND', 'Semester not found.');

    await recordAudit(tx, {
      action: 'taxonomy.semester.updated',
      actorUserId: context.actorUserId ?? null,
      targetType: 'semester',
      targetId: id,
      metadata: { code: updated.code, isCurrent: updated.isCurrent },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return updated;
  });
}

export async function createCourse(
  input: {
    subjectId: string;
    programId: string | null;
    semesterId: string;
    lecturerUserId: string | null;
    code: string;
    name: string | null;
    capacity: number | null;
  },
  context: RequestContext,
) {
  return db.transaction(async (tx) => {
    const [subject, semester] = await Promise.all([
      repo.findSubjectById(input.subjectId, tx),
      repo.findSemesterById(input.semesterId, tx),
    ]);

    if (!subject) throw new AppError('TAXONOMY_INVALID_REFERENCE', 'Học phần không tồn tại.');
    if (!semester) throw new AppError('TAXONOMY_INVALID_REFERENCE', 'Học kỳ không tồn tại.');

    const course = await repo.insertCourse(tx, input);

    await recordAudit(tx, {
      action: 'taxonomy.course.created',
      actorUserId: context.actorUserId ?? null,
      targetType: 'course',
      targetId: course.id,
      metadata: { code: course.code, subjectId: input.subjectId, semesterId: input.semesterId },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return course;
  });
}

export async function updateCourse(
  id: string,
  input: Partial<{
    name: string | null;
    lecturerUserId: string | null;
    capacity: number | null;
    isActive: boolean;
  }>,
  context: RequestContext,
) {
  return db.transaction(async (tx) => {
    const existing = await repo.findCourseById(id, tx);
    if (!existing) throw new AppError('COURSE_NOT_FOUND', 'Course not found.');

    const updated = await repo.updateCourse(tx, id, input);
    if (!updated) throw new AppError('COURSE_NOT_FOUND', 'Course not found.');

    await recordAudit(tx, {
      action: 'taxonomy.course.updated',
      actorUserId: context.actorUserId ?? null,
      targetType: 'course',
      targetId: id,
      metadata: { code: updated.code },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return updated;
  });
}

export async function createDocumentType(
  input: {
    code: string;
    name: string;
    nameEn: string | null;
    description: string | null;
    moderationPolicy: 'allowed' | 'review_required' | 'blocked';
    sortOrder: number;
  },
  context: RequestContext,
) {
  return db.transaction(async (tx) => {
    if (await repo.findDocumentTypeByCode(input.code, tx)) {
      throw new AppError('CONFLICT', `Mã loại tài liệu "${input.code}" đã tồn tại.`);
    }

    const type = await repo.insertDocumentType(tx, input);

    await recordAudit(tx, {
      action: 'taxonomy.document_type.created',
      actorUserId: context.actorUserId ?? null,
      targetType: 'document_type',
      targetId: type.id,
      metadata: { code: type.code, moderationPolicy: type.moderationPolicy },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return type;
  });
}

export async function updateDocumentType(
  id: string,
  input: Partial<{
    name: string;
    nameEn: string | null;
    description: string | null;
    moderationPolicy: 'allowed' | 'review_required' | 'blocked';
    sortOrder: number;
    isActive: boolean;
  }>,
  context: RequestContext,
) {
  return db.transaction(async (tx) => {
    const existing = await repo.findDocumentTypeById(id, tx);
    if (!existing) throw new AppError('DOCUMENT_TYPE_NOT_FOUND', 'Document type not found.');

    const updated = await repo.updateDocumentType(tx, id, input);
    if (!updated) throw new AppError('DOCUMENT_TYPE_NOT_FOUND', 'Document type not found.');

    await recordAudit(tx, {
      action: 'taxonomy.document_type.updated',
      actorUserId: context.actorUserId ?? null,
      targetType: 'document_type',
      targetId: id,
      metadata: {
        before: { moderationPolicy: existing.moderationPolicy, isActive: existing.isActive },
        after: { moderationPolicy: updated.moderationPolicy, isActive: updated.isActive },
      },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return updated;
  });
}

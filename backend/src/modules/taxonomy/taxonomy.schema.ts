import { z } from 'zod';

import { paginationSchema } from '../../lib/pagination.js';
import { uuidSchema } from '../../lib/validation.js';

/**
 * Taxonomy request schemas.
 *
 * Duplicated from `lib/validation.ts` where a stricter variant is needed. The
 * important pattern here is that create and update schemas differ: create
 * requires the natural key (a code), update forbids changing it. Letting an
 * administrator silently rewrite a MOET program code would corrupt the join key
 * that every future admission-data import depends on.
 */

const codeSchema = z
  .string()
  .trim()
  .min(1, 'Mã không được để trống.')
  .max(40, 'Mã quá dài.')
  // Codes appear in URLs and imports; restricting the alphabet avoids
  // percent-encoding surprises and invisible-character collisions such as a
  // trailing non-breaking space producing a "duplicate" code that looks
  // identical.
  .regex(/^[A-Za-z0-9._-]+$/, 'Mã chỉ được chứa chữ, số, dấu chấm, gạch ngang và gạch dưới.');

const nameSchema = z.string().trim().min(1, 'Tên không được để trống.').max(200);
const shortNameSchema = z.string().trim().max(60).nullish().transform((v) => v ?? null);
const descriptionSchema = z.string().trim().max(2000).nullish().transform((v) => v ?? null);
const sortOrderSchema = z.coerce.number().int().min(0).max(9999).optional().default(0);
const iconSchema = z.string().trim().max(40).nullish().transform((v) => v ?? null);

// --- Faculties ---------------------------------------------------------------

export const createFacultySchema = z
  .object({
    code: codeSchema,
    name: nameSchema,
    shortName: shortNameSchema,
    description: descriptionSchema,
    icon: iconSchema,
    sortOrder: sortOrderSchema,
  })
  .strict();

export const updateFacultySchema = z
  .object({
    name: nameSchema.optional(),
    shortName: shortNameSchema,
    description: descriptionSchema,
    icon: iconSchema,
    sortOrder: sortOrderSchema,
    isActive: z.boolean().optional(),
  })
  .strict();

// --- Programs ----------------------------------------------------------------

export const createProgramSchema = z
  .object({
    facultyId: uuidSchema,
    code: codeSchema,
    name: nameSchema,
    shortName: shortNameSchema,
    description: descriptionSchema,
    degreeLevel: z.enum(['undergraduate', 'postgraduate', 'college']).optional().default('undergraduate'),
    durationYears: z.coerce.number().int().min(1).max(10).nullish().transform((v) => v ?? null),
    sortOrder: sortOrderSchema,
  })
  .strict();

export const updateProgramSchema = z
  .object({
    // Moving a program between faculties is supported — the brief calls it out
    // explicitly. Historical documents keep pointing at the program by id, so
    // a move does not rewrite or invalidate their metadata.
    facultyId: uuidSchema.optional(),
    name: nameSchema.optional(),
    shortName: shortNameSchema,
    description: descriptionSchema,
    degreeLevel: z.enum(['undergraduate', 'postgraduate', 'college']).optional(),
    durationYears: z.coerce.number().int().min(1).max(10).nullish().transform((v) => v ?? null),
    sortOrder: sortOrderSchema,
    isActive: z.boolean().optional(),
  })
  .strict();

// --- Subjects ----------------------------------------------------------------

export const createSubjectSchema = z
  .object({
    code: codeSchema,
    name: nameSchema,
    nameEn: z.string().trim().max(200).nullish().transform((v) => v ?? null),
    credits: z.coerce.number().int().min(0).max(30).nullish().transform((v) => v ?? null),
    description: descriptionSchema,
  })
  .strict();

export const updateSubjectSchema = z
  .object({
    name: nameSchema.optional(),
    nameEn: z.string().trim().max(200).nullish().transform((v) => v ?? null),
    credits: z.coerce.number().int().min(0).max(30).nullish().transform((v) => v ?? null),
    description: descriptionSchema,
    isActive: z.boolean().optional(),
  })
  .strict();

// --- Academic years and semesters --------------------------------------------

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày phải theo định dạng YYYY-MM-DD.')
  .nullish()
  .transform((v) => v ?? null);

export const createAcademicYearSchema = z
  .object({
    code: z.string().trim().regex(/^\d{4}-\d{4}$/, 'Mã năm học phải theo định dạng YYYY-YYYY.'),
    name: nameSchema,
    startsOn: isoDateSchema,
    endsOn: isoDateSchema,
    graduationYear: z.coerce.number().int().min(1950).max(2200).nullish().transform((v) => v ?? null),
    isCurrent: z.boolean().optional().default(false),
  })
  .strict();

export const updateAcademicYearSchema = z
  .object({
    name: nameSchema.optional(),
    startsOn: isoDateSchema,
    endsOn: isoDateSchema,
    graduationYear: z.coerce.number().int().min(1950).max(2200).nullish().transform((v) => v ?? null),
    isCurrent: z.boolean().optional(),
  })
  .strict();

export const createSemesterSchema = z
  .object({
    academicYearId: uuidSchema,
    termNo: z.coerce.number().int().min(1).max(6),
    code: z.string().trim().min(1).max(20),
    name: nameSchema,
    startsOn: isoDateSchema,
    endsOn: isoDateSchema,
    isCurrent: z.boolean().optional().default(false),
  })
  .strict();

export const updateSemesterSchema = z
  .object({
    name: nameSchema.optional(),
    startsOn: isoDateSchema,
    endsOn: isoDateSchema,
    isCurrent: z.boolean().optional(),
  })
  .strict();

// --- Courses -----------------------------------------------------------------

export const createCourseSchema = z
  .object({
    subjectId: uuidSchema,
    programId: z.union([uuidSchema, z.null()]).optional().default(null),
    semesterId: uuidSchema,
    lecturerUserId: z.union([uuidSchema, z.null()]).optional().default(null),
    code: z.string().trim().min(1).max(40),
    name: z.string().trim().max(200).nullish().transform((v) => v ?? null),
    capacity: z.coerce.number().int().min(1).max(2000).nullish().transform((v) => v ?? null),
  })
  .strict();

export const updateCourseSchema = z
  .object({
    name: z.string().trim().max(200).nullish().transform((v) => v ?? null),
    lecturerUserId: z.union([uuidSchema, z.null()]).optional(),
    capacity: z.coerce.number().int().min(1).max(2000).nullish().transform((v) => v ?? null),
    isActive: z.boolean().optional(),
  })
  .strict();

// --- Document types ----------------------------------------------------------

export const createDocumentTypeSchema = z
  .object({
    code: codeSchema,
    name: nameSchema,
    nameEn: z.string().trim().max(200).nullish().transform((v) => v ?? null),
    description: descriptionSchema,
    moderationPolicy: z.enum(['allowed', 'review_required', 'blocked']).optional().default('allowed'),
    sortOrder: sortOrderSchema,
  })
  .strict();

export const updateDocumentTypeSchema = z
  .object({
    name: nameSchema.optional(),
    nameEn: z.string().trim().max(200).nullish().transform((v) => v ?? null),
    description: descriptionSchema,
    moderationPolicy: z.enum(['allowed', 'review_required', 'blocked']).optional(),
    sortOrder: sortOrderSchema,
    isActive: z.boolean().optional(),
  })
  .strict();

// --- Queries -----------------------------------------------------------------

export const listQuerySchema = paginationSchema.extend({
  /** Case- and diacritic-insensitive substring match on name or code. */
  q: z.string().trim().max(120).optional(),
  facultyId: uuidSchema.optional(),
  programId: uuidSchema.optional(),
  subjectId: uuidSchema.optional(),
  academicYearId: uuidSchema.optional(),
  degreeLevel: z.enum(['undergraduate', 'postgraduate', 'college']).optional(),
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

export const idParamSchema = z.object({ id: uuidSchema });

import type { FastifyReply, FastifyRequest } from 'fastify';

import { paginationMeta } from '../../lib/pagination.js';
import { parseBody, parseParams, parseQuery } from '../../lib/validation.js';
import type { RequestContext } from '../auth/auth.service.js';
import * as service from './taxonomy.service.js';
import {
  createAcademicYearSchema,
  createCourseSchema,
  createDocumentTypeSchema,
  createFacultySchema,
  createProgramSchema,
  createSemesterSchema,
  createSubjectSchema,
  idParamSchema,
  listQuerySchema,
  updateAcademicYearSchema,
  updateCourseSchema,
  updateDocumentTypeSchema,
  updateFacultySchema,
  updateProgramSchema,
  updateSemesterSchema,
  updateSubjectSchema,
} from './taxonomy.schema.js';

/**
 * Taxonomy HTTP layer.
 *
 * Read endpoints are public — a visitor must be able to browse faculties and
 * programs before creating an account, which is most of what makes the site
 * discoverable. Write endpoints are gated by the permission specific to the
 * entity being changed, so "may edit subjects" does not imply "may edit
 * faculties".
 *
 * `contextOf` pulls the actor id from the authenticated request so every admin
 * mutation lands in the audit log with a name attached.
 */

function contextOf(request: FastifyRequest): RequestContext {
  return {
    userAgent: request.headers['user-agent'] ?? null,
    ip: request.ip ?? null,
    requestId: request.id,
    actorUserId: request.user?.id ?? null,
  };
}

/** Respond with a paginated list, putting counts in the envelope's `meta`. */
function sendPaginated<T>(reply: FastifyReply, result: { items: T[]; page: number; limit: number; total: number; totalPages: number }) {
  return reply.ok(result.items, paginationMeta(result));
}

// =============================================================================
// Reads
// =============================================================================

export async function listFaculties(request: FastifyRequest, reply: FastifyReply) {
  const query = parseQuery(listQuerySchema, request.query);
  const result = await service.listFaculties({ q: query.q, isActive: query.isActive }, query);
  return sendPaginated(reply, result);
}

export async function getFaculty(request: FastifyRequest, reply: FastifyReply) {
  const { id } = parseParams(idParamSchema, request.params);
  return reply.ok(await service.getFaculty(id));
}

export async function listPrograms(request: FastifyRequest, reply: FastifyReply) {
  const query = parseQuery(listQuerySchema, request.query);
  const result = await service.listPrograms(
    {
      q: query.q,
      facultyId: query.facultyId,
      degreeLevel: query.degreeLevel,
      isActive: query.isActive,
    },
    query,
  );
  return sendPaginated(reply, result);
}

export async function getProgram(request: FastifyRequest, reply: FastifyReply) {
  const { id } = parseParams(idParamSchema, request.params);
  return reply.ok(await service.getProgram(id));
}

export async function listSubjects(request: FastifyRequest, reply: FastifyReply) {
  const query = parseQuery(listQuerySchema, request.query);
  const result = await service.listSubjects({ q: query.q, isActive: query.isActive }, query);
  return sendPaginated(reply, result);
}

export async function getSubject(request: FastifyRequest, reply: FastifyReply) {
  const { id } = parseParams(idParamSchema, request.params);
  return reply.ok(await service.getSubject(id));
}

export async function listAcademicYears(request: FastifyRequest, reply: FastifyReply) {
  const query = parseQuery(listQuerySchema, request.query);
  return sendPaginated(reply, await service.listAcademicYears(query));
}

export async function listSemesters(request: FastifyRequest, reply: FastifyReply) {
  const query = parseQuery(listQuerySchema, request.query);
  const result = await service.listSemesters({ academicYearId: query.academicYearId }, query);
  return sendPaginated(reply, result);
}

export async function listCourses(request: FastifyRequest, reply: FastifyReply) {
  const query = parseQuery(listQuerySchema, request.query);
  const result = await service.listCourses(
    {
      subjectId: query.subjectId,
      programId: query.programId,
      academicYearId: query.academicYearId,
    },
    query,
  );
  return sendPaginated(reply, result);
}

export async function getCourse(request: FastifyRequest, reply: FastifyReply) {
  const { id } = parseParams(idParamSchema, request.params);
  return reply.ok(await service.getCourse(id));
}

export async function listDocumentTypes(request: FastifyRequest, reply: FastifyReply) {
  const query = parseQuery(listQuerySchema, request.query);
  const result = await service.listDocumentTypes({ isActive: query.isActive }, query);
  return sendPaginated(reply, result);
}

/**
 * The whole taxonomy as a nested tree, for the site navigation.
 *
 * One request instead of faculty-then-programs-per-faculty, which on a
 * seven-faculty site would be eight round trips through the Cloudflare tunnel
 * before anything rendered.
 */
export async function getTree(_request: FastifyRequest, reply: FastifyReply) {
  return reply.ok(await service.getTree());
}

// =============================================================================
// Faculty writes
// =============================================================================

export async function createFaculty(request: FastifyRequest, reply: FastifyReply) {
  const body = parseBody(createFacultySchema, request.body);
  const faculty = await service.createFaculty(body, contextOf(request));
  reply.status(201);
  return reply.ok(faculty, {}, 'Đã tạo khoa.');
}

export async function updateFaculty(request: FastifyRequest, reply: FastifyReply) {
  const { id } = parseParams(idParamSchema, request.params);
  const body = parseBody(updateFacultySchema, request.body);
  return reply.ok(await service.updateFaculty(id, body, contextOf(request)), {}, 'Đã cập nhật khoa.');
}

export async function deleteFaculty(request: FastifyRequest, reply: FastifyReply) {
  const { id } = parseParams(idParamSchema, request.params);
  await service.deleteFaculty(id, contextOf(request));
  return reply.ok({ deleted: true }, {}, 'Đã xoá khoa.');
}

// =============================================================================
// Program writes
// =============================================================================

export async function createProgram(request: FastifyRequest, reply: FastifyReply) {
  const body = parseBody(createProgramSchema, request.body);
  const program = await service.createProgram(body, contextOf(request));
  reply.status(201);
  return reply.ok(program, {}, 'Đã tạo ngành.');
}

export async function updateProgram(request: FastifyRequest, reply: FastifyReply) {
  const { id } = parseParams(idParamSchema, request.params);
  const body = parseBody(updateProgramSchema, request.body);
  return reply.ok(await service.updateProgram(id, body, contextOf(request)), {}, 'Đã cập nhật ngành.');
}

export async function deleteProgram(request: FastifyRequest, reply: FastifyReply) {
  const { id } = parseParams(idParamSchema, request.params);
  await service.deleteProgram(id, contextOf(request));
  return reply.ok({ deleted: true }, {}, 'Đã xoá ngành.');
}

// =============================================================================
// Subject writes
// =============================================================================

export async function createSubject(request: FastifyRequest, reply: FastifyReply) {
  const body = parseBody(createSubjectSchema, request.body);
  const subject = await service.createSubject(body, contextOf(request));
  reply.status(201);
  return reply.ok(subject, {}, 'Đã tạo học phần.');
}

export async function updateSubject(request: FastifyRequest, reply: FastifyReply) {
  const { id } = parseParams(idParamSchema, request.params);
  const body = parseBody(updateSubjectSchema, request.body);
  return reply.ok(await service.updateSubject(id, body, contextOf(request)), {}, 'Đã cập nhật học phần.');
}

export async function deleteSubject(request: FastifyRequest, reply: FastifyReply) {
  const { id } = parseParams(idParamSchema, request.params);
  await service.deleteSubject(id, contextOf(request));
  return reply.ok({ deleted: true }, {}, 'Đã xoá học phần.');
}

// =============================================================================
// Academic year / semester / course / document type writes
// =============================================================================

export async function createAcademicYear(request: FastifyRequest, reply: FastifyReply) {
  const body = parseBody(createAcademicYearSchema, request.body);
  const year = await service.createAcademicYear(body, contextOf(request));
  reply.status(201);
  return reply.ok(year, {}, 'Đã tạo năm học.');
}

export async function updateAcademicYear(request: FastifyRequest, reply: FastifyReply) {
  const { id } = parseParams(idParamSchema, request.params);
  const body = parseBody(updateAcademicYearSchema, request.body);
  return reply.ok(
    await service.updateAcademicYear(id, body, contextOf(request)),
    {},
    'Đã cập nhật năm học.',
  );
}

export async function createSemester(request: FastifyRequest, reply: FastifyReply) {
  const body = parseBody(createSemesterSchema, request.body);
  const semester = await service.createSemester(body, contextOf(request));
  reply.status(201);
  return reply.ok(semester, {}, 'Đã tạo học kỳ.');
}

export async function updateSemester(request: FastifyRequest, reply: FastifyReply) {
  const { id } = parseParams(idParamSchema, request.params);
  const body = parseBody(updateSemesterSchema, request.body);
  return reply.ok(await service.updateSemester(id, body, contextOf(request)), {}, 'Đã cập nhật học kỳ.');
}

export async function createCourse(request: FastifyRequest, reply: FastifyReply) {
  const body = parseBody(createCourseSchema, request.body);
  const course = await service.createCourse(body, contextOf(request));
  reply.status(201);
  return reply.ok(course, {}, 'Đã tạo lớp học phần.');
}

export async function updateCourse(request: FastifyRequest, reply: FastifyReply) {
  const { id } = parseParams(idParamSchema, request.params);
  const body = parseBody(updateCourseSchema, request.body);
  return reply.ok(await service.updateCourse(id, body, contextOf(request)), {}, 'Đã cập nhật lớp học phần.');
}

export async function createDocumentType(request: FastifyRequest, reply: FastifyReply) {
  const body = parseBody(createDocumentTypeSchema, request.body);
  const type = await service.createDocumentType(body, contextOf(request));
  reply.status(201);
  return reply.ok(type, {}, 'Đã tạo loại tài liệu.');
}

export async function updateDocumentType(request: FastifyRequest, reply: FastifyReply) {
  const { id } = parseParams(idParamSchema, request.params);
  const body = parseBody(updateDocumentTypeSchema, request.body);
  return reply.ok(
    await service.updateDocumentType(id, body, contextOf(request)),
    {},
    'Đã cập nhật loại tài liệu.',
  );
}

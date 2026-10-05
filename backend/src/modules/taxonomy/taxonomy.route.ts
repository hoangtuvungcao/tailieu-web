import type { FastifyInstance } from 'fastify';

import * as controller from './taxonomy.controller.js';

/**
 * Taxonomy routes.
 *
 * Reads are public. Writes require the permission for the specific entity, so
 * holding `subjects.manage` does not confer `faculties.manage`. None of these
 * use `scope: 'faculty'` — taxonomy is institution-wide, and a faculty-scoped
 * moderator editing the faculty list is not a meaningful concept.
 *
 * Note there is no DELETE for academic years, semesters or courses: those are
 * historical records that documents reference, and removing one would orphan
 * metadata. They are deactivated instead, which is why only faculties,
 * programs and subjects expose a delete.
 */
export async function taxonomyRoutes(app: FastifyInstance): Promise<void> {
  const can = (permission: string) => ({
    preHandler: [app.authenticate, app.authorize(permission)],
  });

  // --- Public reads ---------------------------------------------------------

  app.get('/tree', controller.getTree);

  app.get('/faculties', controller.listFaculties);
  app.get('/faculties/:id', controller.getFaculty);
  app.get('/programs', controller.listPrograms);
  app.get('/programs/:id', controller.getProgram);
  app.get('/subjects', controller.listSubjects);
  app.get('/subjects/:id', controller.getSubject);
  app.get('/courses', controller.listCourses);
  app.get('/courses/:id', controller.getCourse);
  app.get('/academic-years', controller.listAcademicYears);
  app.get('/semesters', controller.listSemesters);
  app.get('/document-types', controller.listDocumentTypes);

  // --- Faculties ------------------------------------------------------------

  app.post('/faculties', can('faculties.manage'), controller.createFaculty);
  app.patch('/faculties/:id', can('faculties.manage'), controller.updateFaculty);
  app.delete('/faculties/:id', can('faculties.manage'), controller.deleteFaculty);

  // --- Programs -------------------------------------------------------------

  app.post('/programs', can('programs.manage'), controller.createProgram);
  app.patch('/programs/:id', can('programs.manage'), controller.updateProgram);
  app.delete('/programs/:id', can('programs.manage'), controller.deleteProgram);

  // --- Subjects -------------------------------------------------------------

  app.post('/subjects', can('subjects.manage'), controller.createSubject);
  app.patch('/subjects/:id', can('subjects.manage'), controller.updateSubject);
  app.delete('/subjects/:id', can('subjects.manage'), controller.deleteSubject);

  // --- Academic calendar ----------------------------------------------------

  app.post('/academic-years', can('academic_years.manage'), controller.createAcademicYear);
  app.patch('/academic-years/:id', can('academic_years.manage'), controller.updateAcademicYear);

  app.post('/semesters', can('academic_years.manage'), controller.createSemester);
  app.patch('/semesters/:id', can('academic_years.manage'), controller.updateSemester);

  // --- Courses --------------------------------------------------------------

  app.post('/courses', can('courses.manage'), controller.createCourse);
  app.patch('/courses/:id', can('courses.manage'), controller.updateCourse);

  // --- Document categories --------------------------------------------------

  app.post('/document-types', can('document_types.manage'), controller.createDocumentType);
  app.patch('/document-types/:id', can('document_types.manage'), controller.updateDocumentType);
}

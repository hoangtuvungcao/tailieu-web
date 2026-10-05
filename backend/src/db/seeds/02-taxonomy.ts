/**
 * Seed: academic taxonomy for 2026, document categories, starter tags, and the
 * current academic year.
 *
 * Upserts are done as explicit select-then-insert-or-update rather than
 * `ON CONFLICT`, because every natural key here is protected by a PARTIAL
 * unique index (`... WHERE deleted_at IS NULL`). Postgres only infers a partial
 * index for `ON CONFLICT` when the statement repeats the index predicate, and
 * getting that subtly wrong fails at runtime rather than at compile time.
 * Being explicit is both clearer and impossible to get wrong.
 *
 * Re-running is safe and is the intended way to apply corrections: change a
 * name here, run `npm run db:seed`, and the change propagates.
 */
import { eq, and, isNull } from 'drizzle-orm';

import { db } from '../client.js';
import {
  academicYears,
  documentTypes,
  faculties,
  programs,
  semesters,
  tags,
  subjects,
} from '../schema/index.js';
import {
  DOCUMENT_TYPES,
  FACULTIES,
  PROGRAMS,
  TAG_SEEDS,
} from './data/taxonomy-2026.js';

export interface TaxonomySeedResult {
  faculties: number;
  programs: number;
  documentTypes: number;
  tags: number;
  subjects: number;
  notes: string[];
}

/** Slugify a Vietnamese tag into a URL-safe key, keeping diacritics folded. */
function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export async function seedTaxonomy(): Promise<TaxonomySeedResult> {
  const notes: string[] = [];

  const result = await db.transaction(async (tx) => {
    // --- faculties ---------------------------------------------------------
    const facultyIdByCode = new Map<string, string>();

    for (const faculty of FACULTIES) {
      const existing = await tx
        .select({ id: faculties.id })
        .from(faculties)
        .where(and(eq(faculties.code, faculty.code), isNull(faculties.deletedAt)))
        .limit(1);

      if (existing[0]) {
        await tx
          .update(faculties)
          .set({
            name: faculty.name,
            shortName: faculty.shortName,
            icon: faculty.icon,
            sortOrder: faculty.sortOrder,
            isActive: true,
          })
          .where(eq(faculties.id, existing[0].id));
        facultyIdByCode.set(faculty.code, existing[0].id);
      } else {
        const inserted = await tx
          .insert(faculties)
          .values({
            code: faculty.code,
            name: faculty.name,
            shortName: faculty.shortName,
            icon: faculty.icon,
            sortOrder: faculty.sortOrder,
          })
          .returning({ id: faculties.id });
        facultyIdByCode.set(faculty.code, inserted[0]!.id);
      }
    }

    // --- programs ----------------------------------------------------------
    let programCount = 0;
    const seenProgramCodes = new Set<string>();

    for (const program of PROGRAMS) {
      // A duplicate code in the seed data would otherwise upsert the same row
      // twice and mask the mistake, so fail loudly instead.
      if (seenProgramCodes.has(program.code)) {
        throw new Error(
          `Duplicate program code "${program.code}" in the taxonomy seed. ` +
            'MOET codes must be unique; fix the seed data before loading it.',
        );
      }
      seenProgramCodes.add(program.code);

      const facultyId = facultyIdByCode.get(program.facultyCode);
      if (!facultyId) {
        throw new Error(
          `Program "${program.code}" references unknown faculty "${program.facultyCode}". ` +
            'Add the faculty to FACULTIES first.',
        );
      }

      const existing = await tx
        .select({ id: programs.id })
        .from(programs)
        .where(and(eq(programs.code, program.code), isNull(programs.deletedAt)))
        .limit(1);

      if (existing[0]) {
        await tx
          .update(programs)
          .set({
            name: program.name,
            facultyId,
            durationYears: program.durationYears,
            sortOrder: program.sortOrder,
            isActive: true,
          })
          .where(eq(programs.id, existing[0].id));
      } else {
        await tx.insert(programs).values({
          code: program.code,
          name: program.name,
          facultyId,
          durationYears: program.durationYears,
          sortOrder: program.sortOrder,
        });
      }
      programCount += 1;
    }

    // --- document categories ----------------------------------------------
    for (const type of DOCUMENT_TYPES) {
      const existing = await tx
        .select({ id: documentTypes.id })
        .from(documentTypes)
        .where(and(eq(documentTypes.code, type.code), isNull(documentTypes.deletedAt)))
        .limit(1);

      if (existing[0]) {
        await tx
          .update(documentTypes)
          .set({
            name: type.name,
            nameEn: type.nameEn,
            moderationPolicy: type.moderationPolicy,
            sortOrder: type.sortOrder,
            isActive: true,
          })
          .where(eq(documentTypes.id, existing[0].id));
      } else {
        await tx.insert(documentTypes).values({
          code: type.code,
          name: type.name,
          nameEn: type.nameEn,
          moderationPolicy: type.moderationPolicy,
          sortOrder: type.sortOrder,
        });
      }
    }

    // --- tags --------------------------------------------------------------
    let tagCount = 0;
    for (const name of TAG_SEEDS) {
      const slug = slugify(name);
      if (!slug) continue;
      await tx
        .insert(tags)
        .values({ slug, name })
        .onConflictDoUpdate({ target: tags.slug, set: { name } });
      tagCount += 1;
    }

    // --- current academic year and its semesters ---------------------------
    const yearCode = '2026-2027';
    let [year] = await tx
      .select({ id: academicYears.id })
      .from(academicYears)
      .where(and(eq(academicYears.code, yearCode), isNull(academicYears.deletedAt)))
      .limit(1);

    if (!year) {
      [year] = await tx
        .insert(academicYears)
        .values({
          code: yearCode,
          name: 'Năm học 2026–2027',
          startsOn: '2026-09-01',
          endsOn: '2027-06-30',
          isCurrent: true,
          graduationYear: 2027,
        })
        .returning({ id: academicYears.id });
    }

    if (year) {
      for (const [termNo, code, name, startsOn, endsOn] of [
        [1, 'HK1', 'Học kỳ 1', '2026-09-01', '2027-01-15'],
        [2, 'HK2', 'Học kỳ 2', '2027-01-16', '2027-05-31'],
        [3, 'HK3', 'Học kỳ hè', '2027-06-01', '2027-07-31'],
      ] as const) {
        const existing = await tx
          .select({ id: semesters.id })
          .from(semesters)
          .where(and(eq(semesters.academicYearId, year.id), eq(semesters.termNo, termNo)))
          .limit(1);

        if (existing[0]) {
          await tx
            .update(semesters)
            .set({ name, startsOn, endsOn })
            .where(eq(semesters.id, existing[0].id));
        } else {
          await tx.insert(semesters).values({
            academicYearId: year.id,
            termNo,
            code,
            name,
            startsOn,
            endsOn,
            /** Term 1 is the current one at seed time. */
            isCurrent: termNo === 1,
          });
        }
      }
    }

    // --- demo subjects -----------------------------------------------------
    // A handful of real subjects so the document-upload form and the subject
    // browser are usable immediately. Deliberately small: this is a starting
    // point an administrator extends through the admin panel, not a curriculum.
    const demoSubjects = [
      { code: 'IT101', name: 'Lập trình C++', credits: 3 },
      { code: 'IT201', name: 'Cấu trúc dữ liệu và giải thuật', credits: 4 },
      { code: 'IT301', name: 'Cơ sở dữ liệu', credits: 3 },
      { code: 'IT302', name: 'Mạng máy tính', credits: 3 },
      { code: 'IT401', name: 'Trí tuệ nhân tạo', credits: 3 },
      { code: 'MATH101', name: 'Toán cao cấp', credits: 4 },
      { code: 'ENG101', name: 'Tiếng Anh tổng quát', credits: 3 },
    ];

    let subjectCount = 0;
    for (const subject of demoSubjects) {
      const existing = await tx
        .select({ id: subjects.id })
        .from(subjects)
        .where(and(eq(subjects.code, subject.code), isNull(subjects.deletedAt)))
        .limit(1);

      if (existing[0]) {
        await tx
          .update(subjects)
          .set({ name: subject.name, credits: subject.credits })
          .where(eq(subjects.id, existing[0].id));
      } else {
        await tx.insert(subjects).values(subject);
      }
      subjectCount += 1;
    }

    return {
      faculties: FACULTIES.length,
      programs: programCount,
      documentTypes: DOCUMENT_TYPES.length,
      tags: tagCount,
      subjects: subjectCount,
    };
  });

  notes.push(
    `Verify the ${result.programs} MOET program codes in ` +
      'src/db/seeds/data/taxonomy-2026.ts against the official catalog before production use.',
  );

  return { ...result, notes };
}

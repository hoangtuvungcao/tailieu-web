/**
 * Seed runner.
 *
 * Run with: npm run db:seed
 *
 * Every step is idempotent, so this is safe to run on every deploy — that is
 * how a new permission added to `config/permissions.ts` reaches the database
 * without anyone writing a migration for it.
 *
 * Order matters: RBAC must exist before users (a user needs a role to be
 * granted), and taxonomy before anything that references a faculty.
 */
import { closeDatabase } from './client.js';
import { seedRbac } from './seeds/01-rbac.js';
import { seedTaxonomy } from './seeds/02-taxonomy.js';
import { seedUsers } from './seeds/03-users.js';
import { seedSettings } from './seeds/04-settings.js';
import { seedBadges } from './seeds/05-badges.js';

const notes: string[] = [];

async function main(): Promise<void> {
  console.log('\nSeeding TÀI LIỆU SINH VIÊN\n');

  process.stdout.write('  → roles and permissions ... ');
  const rbac = await seedRbac();
  console.log(`ok (${rbac.notes.at(-1) ?? ''})`);
  notes.push(...rbac.notes.slice(0, -1));

  process.stdout.write('  → academic taxonomy ... ');
  const taxonomy = await seedTaxonomy();
  console.log(
    `ok (${taxonomy.faculties} faculties, ${taxonomy.programs} programs, ` +
      `${taxonomy.documentTypes} document types, ${taxonomy.tags} tags, ${taxonomy.subjects} subjects)`,
  );
  notes.push(...taxonomy.notes);

  process.stdout.write('  → settings ... ');
  const settingsResult = await seedSettings();
  console.log(
    `ok (${settingsResult.inserted} created, ${settingsResult.existing} already present)`,
  );

  process.stdout.write('  → badges ... ');
  const badgesResult = await seedBadges();
  console.log(
    `ok (${badgesResult.inserted} created, ${badgesResult.updated} already present)`,
  );

  process.stdout.write('  → accounts ... ');
  const users = await seedUsers();
  console.log(
    `ok (${users.created.length} created, ${users.skipped.length} already present)`,
  );
  notes.push(...users.notes);

  if (users.created.length > 0) {
    console.log('\n  Created accounts:');
    for (const account of users.created) console.log(`    - ${account}`);
  }
  if (users.skipped.length > 0) {
    console.log(`\n  Existing accounts left untouched: ${users.skipped.join(', ')}`);
  }

  if (notes.length > 0) {
    console.log('\n  Notes:');
    for (const note of notes) console.log(`    ! ${note}`);
  }

  console.log('\nSeeding complete.\n');
}

main()
  .then(async () => {
    await closeDatabase();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error('\nSeeding failed:\n');
    console.error(error);
    await closeDatabase().catch(() => undefined);
    process.exit(1);
  });

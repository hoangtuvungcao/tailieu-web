import { sql } from 'drizzle-orm';

import { db } from '../client.js';
import { DEFAULT_SETTINGS, settings } from '../schema/index.js';

/**
 * Seed: runtime settings.
 *
 * Idempotent, and deliberately **non-destructive**: a row that already exists is
 * left exactly as it is. Re-running the seed must never silently revert an
 * administrator's choices — turning maintenance mode back off, or reopening
 * registration that was deliberately closed, would be a nasty surprise on a
 * routine deploy.
 *
 * Descriptions and categories ARE refreshed, because those are documentation
 * rather than configuration and should track the code that defines them.
 */
export async function seedSettings(): Promise<{ inserted: number; existing: number }> {
  let inserted = 0;
  let existing = 0;

  for (const setting of DEFAULT_SETTINGS) {
    const result = await db
      .insert(settings)
      .values({
        key: setting.key,
        value: setting.value,
        category: setting.category,
        description: setting.description,
      })
      // DO NOTHING on conflict — see the note above. The value column is
      // intentionally not in the update set.
      .onConflictDoNothing({ target: settings.key })
      .returning({ key: settings.key });

    if (result.length > 0) {
      inserted += 1;
    } else {
      existing += 1;
      // Refresh metadata only, never the value.
      await db
        .update(settings)
        .set({ category: setting.category, description: setting.description })
        .where(sql`${settings.key} = ${setting.key}`);
    }
  }

  return { inserted, existing };
}

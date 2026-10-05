import { describe, expect, it } from 'vitest';

import { DEFAULT_SEED_PASSWORDS, isDefaultSeedPassword } from './env.js';

/**
 * The seeder refuses to create an account whose password is published.
 *
 * That guard is only as good as its list, and the list is easy to break in a
 * way nothing else would notice: change a default in the schema and leave the
 * constant behind, and the seeder goes back to happily creating a `super_admin`
 * with a password anyone can read in `.env.example` — with no error, no log
 * line, and a working login for whoever read the repository first.
 *
 * So this pins the two halves together: every value the schema defaults to must
 * be one the guard recognises.
 */
describe('isDefaultSeedPassword', () => {
  it('recognises every published default', () => {
    for (const password of Object.values(DEFAULT_SEED_PASSWORDS)) {
      expect(isDefaultSeedPassword(password), password).toBe(true);
    }
  });

  it('does not recognise a real password', () => {
    // A false positive here is not a security hole but it is a broken deploy:
    // the seeder would refuse a password the operator deliberately chose.
    expect(isDefaultSeedPassword('correct-horse-battery-staple')).toBe(false);
    expect(isDefaultSeedPassword('ChangeMe_Admin_2027')).toBe(false);
    expect(isDefaultSeedPassword('')).toBe(false);
  });

  it('is case-sensitive, because passwords are', () => {
    expect(isDefaultSeedPassword('changeme_admin_2026')).toBe(false);
  });
});

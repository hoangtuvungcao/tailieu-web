import { and, eq, isNull } from 'drizzle-orm';

import { db } from '../client.js';
import { badges } from '../schema/index.js';

/**
 * Seed: badges.
 *
 * Cosmetic only. `tier` is decoration and nothing in the reputation code reads
 * it — a badge that granted points would itself become the thing to farm, and
 * the two systems would amplify each other.
 *
 * Criteria are evaluated lazily, when a reputation event is written. `metric`
 * is either `reputation` (the all-time total) or `event_count` (how many events
 * the account has). An unknown metric awards nothing rather than guessing.
 *
 * Idempotent and mostly non-destructive: the definition (name, description,
 * icon, criteria) is refreshed on every run, because that is documentation for
 * the code that defines it. `is_active` is NOT touched — switching a badge off
 * is an administrative decision, and a routine deploy must not undo it.
 */

interface BadgeDefinition {
  code: string;
  name: string;
  description: string;
  icon: string;
  tier: number;
  category: string;
  criteria: { metric: 'reputation' | 'event_count'; threshold: number };
}

export const DEFAULT_BADGES: BadgeDefinition[] = [
  {
    code: 'first_steps',
    name: 'Bước đầu',
    description: 'Nhận được sự công nhận đầu tiên từ người khác.',
    icon: 'sparkles',
    tier: 1,
    category: 'milestone',
    criteria: { metric: 'reputation', threshold: 10 },
  },
  {
    code: 'contributor',
    name: 'Người đóng góp',
    description: 'Nội dung của bạn được cộng đồng ghi nhận.',
    icon: 'book-open',
    tier: 1,
    category: 'milestone',
    criteria: { metric: 'reputation', threshold: 100 },
  },
  {
    code: 'trusted',
    name: 'Được tin cậy',
    description: 'Thành viên có đóng góp được đánh giá cao.',
    icon: 'shield-check',
    tier: 2,
    category: 'milestone',
    criteria: { metric: 'reputation', threshold: 500 },
  },
  {
    code: 'veteran',
    name: 'Lão làng',
    description: 'Đóng góp lâu dài và bền bỉ.',
    icon: 'award',
    tier: 3,
    category: 'milestone',
    criteria: { metric: 'reputation', threshold: 2000 },
  },
  {
    code: 'well_received',
    name: 'Được yêu thích',
    description: 'Nhận được nhiều tương tác từ cộng đồng.',
    icon: 'heart',
    tier: 2,
    category: 'engagement',
    criteria: { metric: 'event_count', threshold: 50 },
  },
];

export async function seedBadges(): Promise<{ inserted: number; updated: number }> {
  let inserted = 0;
  let updated = 0;

  for (const badge of DEFAULT_BADGES) {
    // Matched explicitly rather than with `ON CONFLICT (code)`: the unique
    // index is partial (`WHERE deleted_at IS NULL`), and a plain conflict
    // target does not infer it — Postgres rejects the statement outright.
    const [existing] = await db
      .select({ id: badges.id })
      .from(badges)
      .where(and(eq(badges.code, badge.code), isNull(badges.deletedAt)))
      .limit(1);

    if (existing) {
      await db
        .update(badges)
        .set({
          name: badge.name,
          description: badge.description,
          icon: badge.icon,
          tier: badge.tier,
          category: badge.category,
          criteria: badge.criteria,
          updatedAt: new Date(),
        })
        .where(eq(badges.id, existing.id));
      updated += 1;
      continue;
    }

    await db.insert(badges).values({
      code: badge.code,
      name: badge.name,
      description: badge.description,
      icon: badge.icon,
      tier: badge.tier,
      category: badge.category,
      criteria: badge.criteria,
      isActive: true,
    });
    inserted += 1;
  }

  return { inserted, updated };
}

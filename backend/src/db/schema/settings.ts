import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { citext } from './custom-types.js';
import { users } from './identity.js';

/**
 * Runtime configuration.
 *
 * A table rather than environment variables for anything an administrator may
 * need to change without redeploying. The distinction is deliberate:
 *
 *   environment   secrets and infrastructure. Changing one requires a restart,
 *                 and that is correct — a JWT secret that can be edited in a
 *                 web form is a liability.
 *   this table    policy. Maintenance mode, upload limits, whether registration
 *                 is open. These need to change *now*, during an incident,
 *                 which is exactly when nobody wants to SSH in and restart.
 *
 * Values are `jsonb` so a setting can be a boolean, a number, a list, or an
 * object without a migration per type. The shape is enforced on read by the
 * typed accessors in `settings.service.ts`, not by the column — a jsonb column
 * will happily hold a string where a number was meant, and the failure would
 * otherwise surface somewhere far away.
 *
 * Reads are cached in Redis with a short TTL, because these are consulted on
 * hot paths (every upload checks `upload_enabled`) and a database round trip
 * per request for a value that changes monthly is waste.
 */
export const settings = pgTable('settings', {
  key: citext('key').primaryKey(),
  value: jsonb('value').notNull(),
  /** Shown in the admin UI next to the field. */
  description: text('description'),
  /** Grouping for the admin settings screen. */
  category: text('category').notNull().default('general'),
  updatedByUserId: uuid('updated_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type SettingRow = typeof settings.$inferSelect;
export type NewSettingRow = typeof settings.$inferInsert;

/**
 * Default values, seeded on first run.
 *
 * Kept next to the table so the schema and its defaults cannot drift apart —
 * a setting added here without a seed default would be absent until an
 * administrator happened to save the form, and the code reading it would have
 * to guess.
 */
export const DEFAULT_SETTINGS: {
  key: string;
  value: unknown;
  category: string;
  description: string;
}[] = [
  // --- System state --------------------------------------------------------
  {
    key: 'maintenance_mode',
    value: false,
    category: 'system',
    description: 'Bật để tạm dừng toàn bộ API (trả 503). Chỉ quản trị viên truy cập được.',
  },
  {
    key: 'read_only_mode',
    value: false,
    category: 'system',
    description: 'Chặn mọi thao tác ghi nhưng vẫn cho đọc. Dùng khi đang sao lưu hoặc di chuyển dữ liệu.',
  },
  {
    key: 'registration_enabled',
    value: true,
    category: 'system',
    description: 'Cho phép đăng ký tài khoản mới.',
  },
  {
    key: 'upload_enabled',
    value: true,
    category: 'system',
    description: 'Cho phép tải lên tài liệu mới.',
  },

  // --- Uploads -------------------------------------------------------------
  {
    key: 'max_upload_bytes',
    value: 2147483648,
    category: 'uploads',
    description: 'Kích thước tệp tối đa (byte). Mặc định 2 GB.',
  },
  {
    key: 'uploads_require_review',
    value: false,
    category: 'uploads',
    description: 'Bắt buộc mọi tài liệu mới phải qua kiểm duyệt, kể cả loại được phép tự động.',
  },

  // --- Community -----------------------------------------------------------
  {
    key: 'comments_enabled',
    value: true,
    category: 'community',
    description: 'Cho phép bình luận trên tài liệu và bài đăng.',
  },
  {
    key: 'posts_enabled',
    value: true,
    category: 'community',
    description: 'Cho phép tạo bài đăng cộng đồng.',
  },
  {
    key: 'feed_ranking_weights',
    value: { like: 3, comment: 5, bookmark: 2, download: 1, recency_halflife_hours: 48 },
    category: 'community',
    description: 'Trọng số xếp hạng feed. Đổi để điều chỉnh nội dung nào nổi bật.',
  },

  // --- Reputation ----------------------------------------------------------
  {
    key: 'reputation_weights',
    value: {
      document_published: 10,
      like_received: 1,
      rating_received: 2,
      comment_like_received: 1,
      moderation_penalty: -50,
      daily_positive_cap: 200,
    },
    category: 'reputation',
    description: 'Điểm uy tín cho từng hành động. Trần dương mỗi ngày chống lạm dụng.',
  },

  // --- SEO and branding ----------------------------------------------------
  {
    key: 'site_name',
    value: 'TAILIEU TTN',
    category: 'branding',
    description: 'Tên hiển thị của nền tảng.',
  },
  {
    key: 'site_description',
    value: 'Kho tri thức cộng đồng Đại học Tây Nguyên',
    category: 'branding',
    description: 'Mô tả dùng cho thẻ meta và chia sẻ mạng xã hội.',
  },
];

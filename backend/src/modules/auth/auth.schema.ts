import { z } from 'zod';

import {
  displayNameSchema,
  emailSchema,
  optionalUuid,
  passwordSchema,
} from '../../lib/validation.js';

/**
 * Auth request schemas.
 *
 * Defined in Zod rather than JSON Schema so the same shapes can be shared with
 * the frontend, and so refinements (password blocklist, cross-field checks) are
 * expressible. `.strict()` is applied where it matters: silently ignoring an
 * unexpected field is how mass-assignment bugs start, where a client sends
 * `{"role":"admin"}` and some layer downstream happens to honour it.
 */

export const registerSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    displayName: displayNameSchema,
    fullName: z.string().trim().max(120).nullish().transform((v) => v ?? null),
    facultyId: optionalUuid,
    programId: optionalUuid,
  })
  .strict();

export const loginSchema = z
  .object({
    email: emailSchema,
    // No length or complexity rules here. Validating the *shape* of a password
    // at login tells an attacker which passwords are even worth trying, and
    // rejects legitimate legacy passwords after a policy change.
    password: z.string().min(1, 'Vui lòng nhập mật khẩu.').max(200),
  })
  .strict();

export const forgotPasswordSchema = z
  .object({
    email: emailSchema,
  })
  .strict();

export const resetPasswordSchema = z
  .object({
    token: z.string().min(10).max(200),
    password: passwordSchema,
  })
  .strict();

export const verifyEmailSchema = z
  .object({
    token: z.string().min(10).max(200),
  })
  .strict();

export const sessionIdSchema = z.object({
  id: z.string().uuid('Mã phiên không hợp lệ.'),
});

/**
 * Usernames someone may reserve for themselves.
 *
 * Short and closed because a username becomes a URL (`/users/@handle` style
 * links, mentions) and an impersonation surface. Blocking the route names and
 * the role names stops the two impersonations that actually matter: `admin`
 * and `quantri` reading as staff, and `settings` colliding with a page.
 */
const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'quantri', 'quantrivien', 'moderator', 'mod',
  'superadmin', 'root', 'system', 'hethong', 'support', 'hotro', 'help',
  'tailieu', 'ttn', 'official', 'chinhthuc', 'banquyen', 'api', 'www',
  'settings', 'caidat', 'login', 'dangnhap', 'register', 'dangky',
  'profile', 'hoso', 'me', 'users', 'nguoidung', 'null', 'undefined',
]);

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Tên người dùng phải có ít nhất 3 ký tự.')
  .max(30, 'Tên người dùng không được vượt quá 30 ký tự.')
  .regex(
    /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/,
    'Tên người dùng chỉ gồm chữ thường, số và các ký tự . _ - (không bắt đầu hoặc kết thúc bằng dấu).',
  )
  .refine((value) => !RESERVED_USERNAMES.has(value), {
    message: 'Tên người dùng này đã được hệ thống giữ riêng. Vui lòng chọn tên khác.',
  });

/**
 * Profile fields.
 *
 * All optional, and `.strict()` — so the only fields a client can reach are the
 * four listed. That is the actual control here: `users.status`, `token_version`
 * and the role tables are all writable by the same repository, and the reason
 * `{ "status": "active" }` in a body cannot touch them is that this schema
 * refuses to parse it rather than that some later layer remembers to drop it.
 *
 * `role`, `faculty`, `program` and `studentCode` are absent on purpose. Those
 * are the fields that decide what a person can see and which documents they are
 * entitled to, so they are verified by staff rather than self-declared. A
 * student who could name their own faculty could read that faculty's internal
 * papers.
 */
export const updateProfileSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    // Nullable as well as optional: absent means "leave it", null means
    // "clear it". Collapsing the two would make a field impossible to empty.
    fullName: z.string().trim().max(120).nullish(),
    bio: z.string().trim().max(500, 'Giới thiệu không được vượt quá 500 ký tự.').nullish(),
    username: z.union([usernameSchema, z.literal(''), z.null()]).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.displayName !== undefined ||
      value.fullName !== undefined ||
      value.bio !== undefined ||
      value.username !== undefined,
    { message: 'Không có thông tin nào để cập nhật.' },
  );

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

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

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

import { z } from 'zod';

import { AppError } from './errors.js';

/**
 * Zod validation helpers.
 *
 * Fastify validates natively with JSON Schema, but this project's request
 * shapes are defined in Zod so that the same schema can be reused by the
 * frontend (via a shared types package) and so that discriminated unions and
 * refinements work the way the rest of the code expects.
 *
 * Rather than wiring a Zod type provider into Fastify — which changes how every
 * route declares schemas and interacts awkwardly with serialisation — handlers
 * call `parseBody` / `parseQuery`. The cost is that validation happens inside
 * the handler; the benefit is that the error shape is identical everywhere and
 * the failure path is explicit rather than magic.
 */

/** Field-level errors, keyed by path, suitable for rendering next to inputs. */
export type FieldErrors = Record<string, string[]>;

function toFieldErrors(error: z.ZodError): FieldErrors {
  const fieldErrors: FieldErrors = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || '_root';
    (fieldErrors[path] ??= []).push(issue.message);
  }
  return fieldErrors;
}

/**
 * Parse and validate, throwing a 422 with per-field detail on failure.
 *
 * Field-level errors are returned rather than a single message because a form
 * needs to mark *which* input is wrong. Collapsing them would force the
 * frontend to re-implement the validation rules to know where to draw the red
 * outline.
 *
 * The return type is written as `T['_output']` rather than `z.infer<T>`:
 * through a generic constrained by `ZodTypeAny`, `z.infer` degrades to a shape
 * with an index signature and `unknown` members, so every field read at the
 * call site becomes `unknown` and nothing type-checks. Indexing `_output`
 * directly resolves the real type.
 */
export function parse<T extends z.ZodTypeAny>(
  schema: T,
  input: unknown,
  what: string,
): T['_output'] {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError('VALIDATION_FAILED', `The ${what} is not valid.`, {
      details: { fields: toFieldErrors(result.error) },
    });
  }
  return result.data as T['_output'];
}

export const parseBody = <T extends z.ZodTypeAny>(schema: T, body: unknown): T['_output'] =>
  parse(schema, body, 'request body');

export const parseQuery = <T extends z.ZodTypeAny>(schema: T, query: unknown): T['_output'] =>
  parse(schema, query, 'query parameters');

export const parseParams = <T extends z.ZodTypeAny>(schema: T, params: unknown): T['_output'] =>
  parse(schema, params, 'path parameters');

// =============================================================================
// Shared field schemas
// =============================================================================

/**
 * Password policy.
 *
 * Length is the dominant factor in resistance to offline cracking, so the
 * minimum is 10 rather than the usual 8. Composition rules (must contain a
 * digit, a symbol) are deliberately NOT enforced: they push users toward
 * `Password1!` and measurably reduce entropy. A blocklist of the passwords
 * that actually appear at the top of every breach corpus does more good, so
 * that is what is checked instead.
 */
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
  'qwertyuiop', 'qwerty123', 'iloveyou', 'admin123', 'administrator',
  'welcome123', 'letmein123', 'tailieu', 'matkhau', 'matkhau123',
  'abc123456', '1q2w3e4r', 'qazwsxedc', 'password1234', 'admin1234',
]);

export const passwordSchema = z
  .string()
  .min(10, 'Mật khẩu phải có ít nhất 10 ký tự.')
  .max(200, 'Mật khẩu quá dài.')
  .refine((value) => !COMMON_PASSWORDS.has(value.toLowerCase()), {
    message: 'Mật khẩu này quá phổ biến và dễ bị đoán. Vui lòng chọn mật khẩu khác.',
  })
  .refine((value) => !/^(.)\1+$/.test(value), {
    message: 'Mật khẩu không được chỉ gồm một ký tự lặp lại.',
  });

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  // Intentionally permissive. Strict email regexes reject valid addresses, and
  // the only real verification is sending mail to it.
  .email('Địa chỉ email không hợp lệ.');

export const uuidSchema = z.string().uuid('Giá trị không phải là UUID hợp lệ.');

export const displayNameSchema = z
  .string()
  .trim()
  .min(2, 'Tên hiển thị phải có ít nhất 2 ký tự.')
  .max(80, 'Tên hiển thị quá dài.');

/** Reusable id-or-null optional field for taxonomy references. */
export const optionalUuid = z
  .union([uuidSchema, z.literal(''), z.null(), z.undefined()])
  .transform((value) => (value === '' || value === null || value === undefined ? null : value));

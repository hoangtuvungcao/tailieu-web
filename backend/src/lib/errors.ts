/**
 * Application error model.
 *
 * Every error the API returns deliberately carries a stable machine-readable
 * `code` alongside a human message. Clients branch on the code; the message is
 * for display and may be localised later. Using HTTP status alone is not enough
 * — three different failures can all be 403, and a frontend cannot tell
 * "verify your email" from "you lack permission" without the code.
 *
 * Nothing here ever includes a stack trace, a SQL fragment, or an upstream
 * error string in the response. Errors are logged in full server-side and
 * reported to the client as a code plus a safe message; leaking internals is
 * how an attacker learns the shape of the system.
 */

export type ErrorCode =
  // --- Generic ---------------------------------------------------------------
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE'
  | 'MAINTENANCE_MODE'
  | 'READ_ONLY_MODE'
  // --- Auth ------------------------------------------------------------------
  | 'AUTH_INVALID_CREDENTIALS'
  | 'AUTH_EMAIL_NOT_VERIFIED'
  | 'AUTH_ACCOUNT_SUSPENDED'
  | 'AUTH_ACCOUNT_DEACTIVATED'
  | 'AUTH_TOKEN_EXPIRED'
  | 'AUTH_TOKEN_INVALID'
  | 'AUTH_NO_REFRESH_TOKEN'
  | 'AUTH_REFRESH_INVALID'
  | 'AUTH_REFRESH_EXPIRED'
  | 'AUTH_REFRESH_REUSE'
  | 'AUTH_REFRESH_RACE'
  | 'AUTH_SESSION_REVOKED'
  | 'AUTH_CSRF_INVALID'
  | 'AUTH_EMAIL_TAKEN'
  | 'AUTH_USERNAME_TAKEN'
  | 'AUTH_WEAK_PASSWORD'
  | 'AUTH_TOKEN_CONSUMED'
  | 'AUTH_PROVIDER_DISABLED'
  | 'CAPTCHA_REQUIRED'
  | 'CAPTCHA_INVALID'
  | 'CAPTCHA_EXPIRED'
  // --- RBAC ------------------------------------------------------------------
  | 'ROLE_NOT_FOUND'
  | 'ROLE_NOT_GRANTABLE'
  | 'FACULTY_SCOPE_REQUIRED'
  | 'INSUFFICIENT_RANK'
  | 'PERMISSION_DENIED'
  // --- Taxonomy --------------------------------------------------------------
  | 'FACULTY_NOT_FOUND'
  | 'FACULTY_CODE_TAKEN'
  | 'FACULTY_IN_USE'
  | 'PROGRAM_NOT_FOUND'
  | 'PROGRAM_CODE_TAKEN'
  | 'PROGRAM_FACULTY_MISMATCH'
  | 'SUBJECT_NOT_FOUND'
  | 'SUBJECT_CODE_TAKEN'
  | 'COURSE_NOT_FOUND'
  | 'SEMESTER_NOT_FOUND'
  | 'ACADEMIC_YEAR_NOT_FOUND'
  | 'DOCUMENT_TYPE_NOT_FOUND'
  | 'TAXONOMY_INVALID_REFERENCE'
  // --- Documents -------------------------------------------------------------
  | 'DOCUMENT_NOT_FOUND'
  | 'DOCUMENT_NOT_OWNER'
  | 'DOCUMENT_NOT_PUBLISHED'
  | 'DOCUMENT_ALREADY_MODERATED'
  | 'FILE_NOT_FOUND'
  | 'FILE_TYPE_NOT_ALLOWED'
  | 'FILE_SIGNATURE_MISMATCH'
  | 'STORAGE_UNAVAILABLE'
  | 'PREVIEW_NOT_AVAILABLE'
  // --- Media ----------------------------------------------------------------
  | 'MEDIA_TOKEN_INVALID'
  | 'MEDIA_TOKEN_EXPIRED'
  | 'MEDIA_NOT_FOUND'
  | 'MEDIA_RANGE_INVALID'
  // --- Uploads ---------------------------------------------------------------
  | 'UPLOAD_SESSION_NOT_FOUND'
  | 'UPLOAD_SESSION_EXPIRED'
  | 'UPLOAD_SESSION_COMPLETED'
  | 'UPLOAD_SESSION_NOT_OWNER'
  | 'UPLOAD_CHUNK_OUT_OF_RANGE'
  | 'UPLOAD_CHUNK_DUPLICATE_MISMATCH'
  | 'UPLOAD_INCOMPLETE'
  | 'UPLOAD_QUOTA_EXCEEDED'
  // --- Users -----------------------------------------------------------------
  | 'USER_NOT_FOUND'
  | 'CANNOT_MODIFY_SELF'
  | 'CANNOT_MODIFY_HIGHER_RANK'
  | 'VERIFICATION_ALREADY_RESOLVED';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
  MAINTENANCE_MODE: 503,
  READ_ONLY_MODE: 503,

  AUTH_INVALID_CREDENTIALS: 401,
  AUTH_EMAIL_NOT_VERIFIED: 403,
  AUTH_ACCOUNT_SUSPENDED: 403,
  AUTH_ACCOUNT_DEACTIVATED: 403,
  AUTH_TOKEN_EXPIRED: 401,
  AUTH_TOKEN_INVALID: 401,
  AUTH_NO_REFRESH_TOKEN: 401,
  AUTH_REFRESH_INVALID: 401,
  AUTH_REFRESH_EXPIRED: 401,
  AUTH_REFRESH_REUSE: 401,
  // 409 not 401: the client should retry with the successor token, not log out.
  AUTH_REFRESH_RACE: 409,
  AUTH_SESSION_REVOKED: 401,
  AUTH_CSRF_INVALID: 403,
  AUTH_EMAIL_TAKEN: 409,
  AUTH_USERNAME_TAKEN: 409,
  AUTH_WEAK_PASSWORD: 422,
  AUTH_TOKEN_CONSUMED: 400,
  AUTH_PROVIDER_DISABLED: 501,
  CAPTCHA_REQUIRED: 400,
  CAPTCHA_INVALID: 400,
  CAPTCHA_EXPIRED: 400,

  ROLE_NOT_FOUND: 404,
  ROLE_NOT_GRANTABLE: 403,
  FACULTY_SCOPE_REQUIRED: 400,
  INSUFFICIENT_RANK: 403,
  PERMISSION_DENIED: 403,

  FACULTY_NOT_FOUND: 404,
  FACULTY_CODE_TAKEN: 409,
  FACULTY_IN_USE: 409,
  PROGRAM_NOT_FOUND: 404,
  PROGRAM_CODE_TAKEN: 409,
  PROGRAM_FACULTY_MISMATCH: 400,
  SUBJECT_NOT_FOUND: 404,
  SUBJECT_CODE_TAKEN: 409,
  COURSE_NOT_FOUND: 404,
  SEMESTER_NOT_FOUND: 404,
  ACADEMIC_YEAR_NOT_FOUND: 404,
  DOCUMENT_TYPE_NOT_FOUND: 404,
  TAXONOMY_INVALID_REFERENCE: 400,

  DOCUMENT_NOT_FOUND: 404,
  DOCUMENT_NOT_OWNER: 403,
  DOCUMENT_NOT_PUBLISHED: 403,
  DOCUMENT_ALREADY_MODERATED: 409,
  FILE_NOT_FOUND: 404,
  FILE_TYPE_NOT_ALLOWED: 415,
  FILE_SIGNATURE_MISMATCH: 415,
  STORAGE_UNAVAILABLE: 503,
  PREVIEW_NOT_AVAILABLE: 404,

  MEDIA_TOKEN_INVALID: 403,
  MEDIA_TOKEN_EXPIRED: 403,
  MEDIA_NOT_FOUND: 404,
  MEDIA_RANGE_INVALID: 416,

  UPLOAD_SESSION_NOT_FOUND: 404,
  UPLOAD_SESSION_EXPIRED: 410,
  UPLOAD_SESSION_COMPLETED: 409,
  UPLOAD_SESSION_NOT_OWNER: 403,
  UPLOAD_CHUNK_OUT_OF_RANGE: 400,
  UPLOAD_CHUNK_DUPLICATE_MISMATCH: 409,
  UPLOAD_INCOMPLETE: 409,
  UPLOAD_QUOTA_EXCEEDED: 413,

  USER_NOT_FOUND: 404,
  CANNOT_MODIFY_SELF: 400,
  CANNOT_MODIFY_HIGHER_RANK: 403,
  VERIFICATION_ALREADY_RESOLVED: 409,
};

export interface AppErrorOptions {
  /** Extra machine-readable context. MUST NOT contain secrets or PII. */
  details?: Record<string, unknown>;
  /** Set when the client should retry — surfaced as a Retry-After hint. */
  retryAfterSeconds?: number;
  /** Original error, logged but never serialised to the client. */
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: Record<string, unknown> | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly isOperational = true;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
    if (options.cause !== undefined) this.cause = options.cause;
    Error.captureStackTrace?.(this, AppError);
  }

  /** The wire format from the API contract. */
  toResponse(): { success: false; error: { code: ErrorCode; message: string; details?: Record<string, unknown> } } {
    return {
      success: false,
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

// --- Constructors for the cases that come up constantly -----------------------

export const notFound = (code: ErrorCode, message: string) => new AppError(code, message);
export const forbidden = (code: ErrorCode, message: string) => new AppError(code, message);
export const unauthorized = (code: ErrorCode, message: string) => new AppError(code, message);
export const conflict = (code: ErrorCode, message: string) => new AppError(code, message);
export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new AppError('BAD_REQUEST', message, details ? { details } : {});

/**
 * True for errors that are safe to show the user as-is.
 *
 * Anything failing this check is an unexpected bug, and its message could
 * contain a SQL fragment or a file path — so the handler replaces it with a
 * generic message and logs the original.
 */
export function isOperationalError(error: unknown): error is AppError {
  return error instanceof AppError;
}

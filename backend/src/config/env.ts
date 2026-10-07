/**
 * Environment configuration.
 *
 * Parsed and validated exactly once at process start. If anything is missing
 * or malformed the process exits immediately rather than failing later at
 * 3am on the first request that happens to need the value.
 *
 * Nothing else in the codebase reads `process.env` directly — import `env`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * Load environment files before anything else reads `process.env`.
 *
 * The repository keeps one `.env` at the root because docker-compose reads it
 * from there, while the API lives in `backend/`. Rather than duplicating the
 * file (and inevitably letting the two drift), resolve both locations: a
 * backend-local `.env` wins if present, otherwise the root one is used.
 * dotenv does not overwrite already-set variables, so ordering is precedence.
 */
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
// src/config -> backend ; dist/config -> backend
const backendRoot = path.resolve(moduleDir, '..', '..');
const projectRoot = path.resolve(backendRoot, '..');

loadDotenv({
  path: [path.join(backendRoot, '.env'), path.join(projectRoot, '.env')],
  // In production the environment comes from systemd's EnvironmentFile, which
  // must win over any stray .env left on the host.
  override: false,
  quiet: true,
});

// --- helpers -----------------------------------------------------------------

/** `z.coerce.boolean()` treats the string "false" as true, so parse explicitly. */
const boolFromEnv = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off', ''])
    .optional()
    .default(defaultValue ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1' || v === 'yes' || v === 'on');

const intFromEnv = (defaultValue: number, min = 0) =>
  z.preprocess(
    (v) => (v === undefined || v === null || v === '' ? defaultValue : v),
    z.coerce.number().int().min(min),
  );

/** Comma-separated list -> trimmed, non-empty array. */
const listFromEnv = (defaultValue: string[] = []) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined
        ? defaultValue
        : v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
    );

const csvOrigins = (defaultValue: string[] = []) =>
  listFromEnv(defaultValue).refine(
    (origins) => !origins.includes('*'),
    'CORS_ORIGINS must not contain "*" — a wildcard origin on an API that sends credentials is a vulnerability.',
  );

/**
 * The passwords the seeder uses when nothing overrides them.
 *
 * Named here rather than inlined so the seeder can recognise them, and so both
 * places cannot drift apart — a guard that checks for a string the schema no
 * longer produces is a guard that silently stops working.
 *
 * These are also published: `.env.example` is in a public repository. That is
 * fine for development, where they exist so a fresh clone can log in without
 * setup, and it is why the seeder refuses them in production. See
 * `seedUsers` in `db/seeds/03-users.ts`.
 */
export const DEFAULT_SEED_PASSWORDS = {
  admin: 'ChangeMe_Admin_2026',
  moderator: 'ChangeMe_Mod_2026',
  student: 'ChangeMe_Student_2026',
} as const;

/** Whether a seed password is one of the published development defaults. */
export function isDefaultSeedPassword(password: string): boolean {
  return Object.values(DEFAULT_SEED_PASSWORDS).some((value) => value === password);
}

// --- schema ------------------------------------------------------------------

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: intFromEnv(3000, 1),
    /**
     * Interface to listen on. Loopback by default, deliberately.
     *
     * The only thing that should ever reach this process is the Cloudflare
     * Tunnel on the same machine, and it connects to `localhost`. Binding to
     * every interface would additionally expose the API to the whole LAN —
     * and, worse, would let anyone on that network send our client-address
     * header from a non-loopback connection and claim someone else's identity
     * for rate limiting. `lib/http/client-ip.ts` trusts that header only
     * because the peer is loopback; this setting is what keeps that true.
     *
     * Set to 0.0.0.0 only for a deliberate, firewalled setup.
     */
    API_HOST: z.string().min(1).default('127.0.0.1'),
    API_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    /**
     * Whether Fastify should trust `X-Forwarded-For` from the tunnel.
     *
     * This does NOT control the real client address — that comes from our own
     * header (`CLIENT_IP_HEADER`). It only tells Fastify it is behind a proxy
     * for logging and `request.protocol`. Kept opt-in because a forwarded
     * header a client can set is a header a client can lie in.
     */
    TRUST_PROXY: boolFromEnv(false),

    // Database
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    DATABASE_SSL: boolFromEnv(false),
    DATABASE_POOL_MAX: intFromEnv(10, 1),

    // Redis
    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

    // Object storage
    S3_ENDPOINT: z.string().url(),
    S3_ACCESS_KEY: z.string().min(1, 'S3_ACCESS_KEY is required'),
    S3_SECRET_KEY: z.string().min(1, 'S3_SECRET_KEY is required'),
    S3_BUCKET: z.string().min(1).default('tailieu-documents'),
    S3_STAGING_BUCKET: z.string().min(1).default('tailieu-staging'),
    S3_REGION: z.string().default('us-east-1'),
    S3_FORCE_PATH_STYLE: boolFromEnv(true),
    S3_SIGNED_URL_TTL_SECONDS: intFromEnv(120, 10),

    // Auth
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
    CSRF_SECRET: z.string().min(32, 'CSRF_SECRET must be at least 32 characters'),
    ARGON2_PEPPER: z.string().default(''),
    JWT_ISSUER: z.string().default('tailieu-ttn'),
    JWT_AUDIENCE: z.string().default('tailieu-ttn-web'),
    ACCESS_TOKEN_TTL: z.string().default('15m'),
    REFRESH_TOKEN_TTL_DAYS: intFromEnv(30, 1),
    SESSION_ABSOLUTE_TTL_DAYS: intFromEnv(90, 1),
    REFRESH_GRACE_MS: intFromEnv(10_000, 0),

    // CORS / cookies
    CORS_ORIGINS: csvOrigins(['http://localhost:5173', 'https://tailieu-ttn.pages.dev']),
    COOKIE_DOMAIN: z.string().optional().default(''),

    // Uploads
    UPLOAD_CHUNK_SIZE_BYTES: intFromEnv(8 * 1024 * 1024, 256 * 1024),
    MAX_UPLOAD_SIZE_BYTES: intFromEnv(2 * 1024 * 1024 * 1024, 1024),
    MAX_FILES_PER_DOCUMENT: intFromEnv(10, 1),
    UPLOAD_SESSION_TTL_HOURS: intFromEnv(24, 1),

    // Rate limits
    RATE_LIMIT_GLOBAL_PER_MIN: intFromEnv(300, 1),
    RATE_LIMIT_LOGIN_PER_15MIN: intFromEnv(10, 1),
    /**
     * The refresh endpoint, which every full page load calls once.
     *
     * Keyed on the client address, so the effective budget is per *address*,
     * not per person. That matters on a campus: a whole faculty browsing
     * through one NAT egress shares this counter, and the default that looks
     * generous for one student can be tight for a lecture hall. The endpoint
     * still requires a valid refresh cookie, so this is a resource limit rather
     * than the abuse control — token rotation is that — which is why it is
     * worth raising here rather than redesigning.
     */
    RATE_LIMIT_REFRESH_PER_15MIN: intFromEnv(60, 1),
    RATE_LIMIT_REGISTER_PER_HOUR: intFromEnv(5, 1),
    RATE_LIMIT_PASSWORD_RESET_PER_HOUR: intFromEnv(5, 1),
    RATE_LIMIT_UPLOAD_PER_HOUR: intFromEnv(100, 1),
    RATE_LIMIT_SEARCH_PER_MIN: intFromEnv(60, 1),
    RATE_LIMIT_DOWNLOAD_PER_HOUR: intFromEnv(300, 1),

    // Mail
    MAIL_DRIVER: z.enum(['console', 'file', 'smtp']).default('console'),
    MAIL_FROM: z.string().default('TAILIEU TTN <no-reply@tailieu.local>'),
    MAIL_FILE_PATH: z.string().default('./tmp/mail'),
    SMTP_HOST: z.string().optional().default(''),
    SMTP_PORT: intFromEnv(587, 1),
    SMTP_USER: z.string().optional().default(''),
    SMTP_PASSWORD: z.string().optional().default(''),
    SMTP_SECURE: boolFromEnv(false),

    // OAuth (designed for, not yet live)
    GOOGLE_CLIENT_ID: z.string().optional().default(''),
    GOOGLE_CLIENT_SECRET: z.string().optional().default(''),
    GOOGLE_REDIRECT_URI: z.string().optional().default(''),

    // AI
    AI_PROVIDER: z.enum(['none', 'openai', 'gemini', 'ollama']).default('none'),
    AI_API_KEY: z.string().optional().default(''),
    AI_BASE_URL: z.string().optional().default(''),
    AI_MODEL: z.string().optional().default(''),

    // Seeding
    SEED_ADMIN_EMAIL: z.string().email().default('admin@tailieu.local'),
    SEED_ADMIN_PASSWORD: z.string().min(8).default(DEFAULT_SEED_PASSWORDS.admin),
    SEED_MODERATOR_EMAIL: z.string().email().default('moderator@tailieu.local'),
    SEED_MODERATOR_PASSWORD: z.string().min(8).default(DEFAULT_SEED_PASSWORDS.moderator),
    SEED_STUDENT_EMAIL: z.string().email().default('student@tailieu.local'),
    SEED_STUDENT_PASSWORD: z.string().min(8).default(DEFAULT_SEED_PASSWORDS.student),

    // Cloudflare & Frontend URLs
    TUNNEL_HOSTNAME: z.string().optional().default(''),
    CLOUDFLARE_PUBLIC_URL: z.string().optional().default(''),
    FRONTEND_URL: z.string().optional().default(''),

    CONVERTER_CONCURRENCY: intFromEnv(1, 1),
    CONVERT_TIMEOUT_MS: intFromEnv(120_000, 1000),

    // --- Virus scanning ------------------------------------------------------
    // Off by default. ClamAV holds a ~1GB signature database in memory, which
    // is a real cost on a laptop — and a deployment that has not installed it
    // must still work, with files marked `skipped` rather than left pending.
    SCAN_ENABLED: boolFromEnv(false),
    CLAMAV_ADDRESS: z.string().default('127.0.0.1:3310'),
    CLAMAV_TIMEOUT_MS: intFromEnv(120_000, 1000),
    // Files above this are not scanned and are marked `skipped_too_large`
    // rather than silently passing. ClamAV's own StreamMaxLength defaults to
    // 100MB; a larger file is rejected by the daemon, which would otherwise
    // look like a scan failure on every large upload.
    SCAN_MAX_BYTES: intFromEnv(104_857_600, 1024),
  })
  .superRefine((val, ctx) => {
    // Security secrets must be distinct. Sharing one secret between the access
    // token, the refresh token and CSRF means a single leak compromises all
    // three controls at once, so this is a hard boot failure, not a warning.
    const secrets = [
      ['JWT_SECRET', val.JWT_SECRET],
      ['JWT_REFRESH_SECRET', val.JWT_REFRESH_SECRET],
      ['CSRF_SECRET', val.CSRF_SECRET],
    ] as const;
    const seen = new Map<string, string>();
    for (const [name, value] of secrets) {
      const existing = seen.get(value);
      if (existing) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `${name} and ${existing} are identical. Each secret must be unique.`,
        });
      }
      seen.set(value, name);
    }

    if (val.NODE_ENV === 'production') {
      // A production boot with development defaults is the single most common
      // way a project like this gets compromised. Refuse to start.
      if (!val.API_PUBLIC_URL.startsWith('https://')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['API_PUBLIC_URL'],
          message: 'API_PUBLIC_URL must use https in production.',
        });
      }
      if (val.CORS_ORIGINS.some((o) => o.includes('localhost'))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CORS_ORIGINS'],
          message: 'CORS_ORIGINS must not contain localhost in production.',
        });
      }
      if (val.MAIL_DRIVER === 'console') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MAIL_DRIVER'],
          message:
            'MAIL_DRIVER=console discards mail. Password-reset and verification emails would be lost. Use "smtp" in production.',
        });
      }
      if (!val.ARGON2_PEPPER) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ARGON2_PEPPER'],
          message: 'ARGON2_PEPPER is required in production.',
        });
      }
      if (/change_me|replace_with|changeme/i.test(val.JWT_SECRET + val.ARGON2_PEPPER)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JWT_SECRET'],
          message: 'Placeholder secret detected. Generate real secrets before deploying.',
        });
      }
    }

    // Scanning enabled with no address is a misconfiguration that would fail
    // every upload after the fact. Catch it at boot.
    if (val.SCAN_ENABLED && !val.CLAMAV_ADDRESS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CLAMAV_ADDRESS'],
        message: 'CLAMAV_ADDRESS is required when SCAN_ENABLED is true.',
      });
    }

    if (val.UPLOAD_CHUNK_SIZE_BYTES > val.MAX_UPLOAD_SIZE_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['UPLOAD_CHUNK_SIZE_BYTES'],
        message: 'UPLOAD_CHUNK_SIZE_BYTES cannot exceed MAX_UPLOAD_SIZE_BYTES.',
      });
    }

    // Cloudflare rejects proxied request bodies above 100MB. A chunk larger
    // than that can never traverse the Pages Function, so the upload would fail
    // only once deployed — catch it at boot instead.
    const CLOUDFLARE_BODY_LIMIT = 100 * 1024 * 1024;
    if (val.UPLOAD_CHUNK_SIZE_BYTES >= CLOUDFLARE_BODY_LIMIT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['UPLOAD_CHUNK_SIZE_BYTES'],
        message:
          `UPLOAD_CHUNK_SIZE_BYTES must stay under Cloudflare's ${CLOUDFLARE_BODY_LIMIT} byte ` +
          'per-request cap, because chunks are proxied through the Pages Function.',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    // Deliberately not using the logger: logging is configured from `env`, so
    // it does not exist yet. A config error must be readable on bare stderr.
    console.error(`\nInvalid environment configuration:\n${details}\n`);
    console.error('See .env.example for the full list of required variables.\n');
    process.exit(1);
  }

  return parsed.data;
}

export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';

/** Derived durations, in milliseconds, to avoid unit bugs at call sites. */
export const durations = {
  refreshTokenMs: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  sessionAbsoluteMs: env.SESSION_ABSOLUTE_TTL_DAYS * 24 * 60 * 60 * 1000,
  uploadSessionMs: env.UPLOAD_SESSION_TTL_HOURS * 60 * 60 * 1000,
  signedUrlMs: env.S3_SIGNED_URL_TTL_SECONDS * 1000,
} as const;

/** Get the public Frontend URL (e.g. https://tailieu-ttn.pages.dev) for email links */
export function getFrontendUrl(): string {
  if (env.FRONTEND_URL) return env.FRONTEND_URL.replace(/\/+$/, '');
  const pages = env.CORS_ORIGINS.find((o) => o.includes('pages.dev'));
  if (pages) return pages.replace(/\/+$/, '');
  if (env.CLOUDFLARE_PUBLIC_URL && !env.CLOUDFLARE_PUBLIC_URL.includes(env.API_HOST)) {
    return env.CLOUDFLARE_PUBLIC_URL.replace(/\/+$/, '');
  }
  return 'https://tailieu-ttn.pages.dev';
}

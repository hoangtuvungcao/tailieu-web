import type { FastifyInstance } from 'fastify';

import { env } from '../../config/env.js';
import * as controller from './auth.controller.js';

/**
 * Auth routes.
 *
 * Rate limits are per-route and much tighter than the global limit, because
 * each of these endpoints is either a credential-guessing surface or an
 * expensive operation:
 *
 *   login      Argon2id at 64 MiB per attempt. Ten concurrent attempts is
 *              already 640 MiB of hashing memory, so the limit protects the
 *              process from being OOM-killed by its own password verification
 *              as much as it protects against credential stuffing.
 *   register   account-farming, and it sends mail.
 *   forgot     mail-bombing a third party through the reset form.
 *
 * `keyGenerator` combines IP and the submitted email so that one attacker
 * cannot lock out a legitimate user by hammering their address from elsewhere,
 * while still bounding attempts per account.
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/captcha',
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: '1 minute',
        },
      },
    },
    controller.getCaptcha,
  );

  app.post(
    '/register',
    {
      config: {
        rateLimit: {
          max: env.RATE_LIMIT_REGISTER_PER_HOUR,
          timeWindow: '1 hour',
          keyGenerator: (request) => {
            const body = request.body as { email?: string } | undefined;
            return `register:${request.ip}:${body?.email ?? 'anon'}`;
          },
        },
      },
    },
    controller.register,
  );

  app.post(
    '/login',
    {
      config: {
        rateLimit: {
          max: env.RATE_LIMIT_LOGIN_PER_15MIN,
          timeWindow: '15 minutes',
          keyGenerator: (request) => {
            const body = request.body as { email?: string } | undefined;
            // Keyed on IP + email: a single IP cannot spray many accounts, and
            // a single account cannot be brute-forced from many IPs within the
            // same window without also tripping the per-IP global limit.
            return `login:${request.ip}:${body?.email?.toLowerCase() ?? 'anon'}`;
          },
        },
      },
    },
    controller.login,
  );

  // Refresh is CSRF-guarded: it is the one pre-authentication endpoint that
  // authenticates purely from a cookie, which is exactly what CSRF exploits.
  app.post(
    '/refresh',
    {
      preHandler: [controller.csrfGuard],
      config: {
        rateLimit: {
          // Generous: every page load after the access token expires triggers
          // one, and multiple tabs share the cookie. The rotation logic itself
          // is the abuse control here, not the rate limit.
          //
          // Configurable because the budget is per client address, and a campus
          // behind one NAT shares it. See `RATE_LIMIT_REFRESH_PER_15MIN`.
          max: env.RATE_LIMIT_REFRESH_PER_15MIN,
          timeWindow: '15 minutes',
        },
      },
    },
    controller.refresh,
  );

  app.post(
    '/logout',
    { preHandler: [app.authenticate, controller.csrfGuard] },
    controller.logout,
  );

  app.post(
    '/logout-all',
    { preHandler: [app.authenticate, controller.csrfGuard] },
    controller.logoutAll,
  );

  app.get('/sessions', { preHandler: [app.authenticate] }, controller.listSessions);

  app.delete(
    '/sessions/:id',
    { preHandler: [app.authenticate, controller.csrfGuard] },
    controller.revokeSession,
  );

  app.get('/me', { preHandler: [app.authenticate] }, controller.me);

  // --- Profile ---------------------------------------------------------------
  //
  // These live on the account endpoints rather than on `/users/:id`, matching
  // the rule `users.route.ts` states: a profile is a projection of an account,
  // and a second place to edit it would be a second place to forget a check.
  //
  // Every one of them acts on `request.user.id` — the authenticated identity —
  // and none takes a target from the URL or the body. That is what makes
  // "can I edit this profile?" unaskable rather than answered: there is no way
  // to name somebody else's account in these requests.
  //
  // The image routes are rate-limited per user. Each request writes an object
  // to the bucket and deletes the previous one, so an unbounded loop is a
  // storage-churn vector rather than merely a nuisance.
  app.patch(
    '/me',
    { preHandler: [app.authenticate, controller.csrfGuard] },
    controller.updateMe,
  );

  app.post(
    '/me/avatar',
    {
      preHandler: [app.authenticate, controller.csrfGuard],
      config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    },
    controller.uploadAvatar,
  );

  app.delete(
    '/me/avatar',
    { preHandler: [app.authenticate, controller.csrfGuard] },
    controller.deleteAvatar,
  );

  app.post(
    '/me/cover',
    {
      preHandler: [app.authenticate, controller.csrfGuard],
      config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    },
    controller.uploadCover,
  );

  app.delete(
    '/me/cover',
    { preHandler: [app.authenticate, controller.csrfGuard] },
    controller.deleteCover,
  );

  app.post(
    '/email/verify',
    {
      config: {
        rateLimit: { max: 30, timeWindow: '1 hour' },
      },
    },
    controller.verifyEmail,
  );

  app.post(
    '/email/resend',
    {
      preHandler: [app.authenticate],
      config: {
        // Sends mail; bounded so it cannot be used to flood an inbox.
        rateLimit: { max: 3, timeWindow: '1 hour' },
      },
    },
    controller.resendVerification,
  );

  app.post(
    '/password/forgot',
    {
      config: {
        rateLimit: {
          max: env.RATE_LIMIT_PASSWORD_RESET_PER_HOUR,
          timeWindow: '1 hour',
          keyGenerator: (request) => {
            const body = request.body as { email?: string } | undefined;
            return `forgot:${request.ip}:${body?.email?.toLowerCase() ?? 'anon'}`;
          },
        },
      },
    },
    controller.forgotPassword,
  );

  app.post(
    '/password/reset',
    {
      config: {
        rateLimit: { max: 10, timeWindow: '1 hour' },
      },
    },
    controller.resetPassword,
  );
}

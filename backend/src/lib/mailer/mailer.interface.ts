/**
 * Mail delivery abstraction.
 *
 * No SMTP credentials exist yet, so the console and file drivers are the
 * working defaults. The point of the interface is that adding real delivery
 * later is a configuration change, not a refactor of every call site — and so
 * that the verification and password-reset flows can be built and tested now
 * rather than waiting on a mail provider.
 *
 * A note on the console driver: in production `env.ts` refuses to boot with
 * `MAIL_DRIVER=console`, because a password-reset email that is printed to a
 * log and never delivered means a user who can never recover their account —
 * and an operator who never notices, since nothing errors.
 */

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain text. Always present — the console and file drivers render only this. */
  text: string;
  /** Optional HTML alternative. */
  html?: string;
}

export interface Mailer {
  readonly driver: string;
  send(message: MailMessage): Promise<void>;
}

/** Redact an address for logging: "sv@example.com" -> "s***@example.com". */
export function redactEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const visible = local?.slice(0, 1) ?? '';
  return `${visible}***@${domain}`;
}

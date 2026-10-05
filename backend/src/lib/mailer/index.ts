import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

import nodemailer, { type Transporter } from 'nodemailer';

import { env, isProduction } from '../../config/env.js';
import { redactEmail, type Mailer, type MailMessage } from './mailer.interface.js';

/**
 * Mail drivers.
 *
 * Selection is by `MAIL_DRIVER`. The drivers differ only in where the message
 * goes; the call sites are identical.
 */

/**
 * Prints to stdout.
 *
 * Useful in development because verification and reset links appear inline in
 * the terminal, so the flows are testable without a mailbox. Deliberately
 * noisy — it should be obvious that no mail is actually being sent.
 */
class ConsoleMailer implements Mailer {
  readonly driver = 'console';

  async send(message: MailMessage): Promise<void> {
    console.info(
      [
        '',
        '─'.repeat(72),
        `  MAIL (console driver — NOT delivered)`,
        `  To:      ${message.to}`,
        `  Subject: ${message.subject}`,
        '─'.repeat(72),
        message.text,
        '─'.repeat(72),
        '',
      ].join('\n'),
    );
  }
}

/**
 * Appends messages to a file.
 *
 * Survives the terminal scrolling away, which matters when testing a flow that
 * several requests deep. Never used in production — a file of password-reset
 * tokens on disk is a credential store nobody is protecting.
 */
class FileMailer implements Mailer {
  readonly driver = 'file';

  constructor(private readonly directory: string) {}

  async send(message: MailMessage): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const file = path.join(this.directory, 'mail.log');
    const entry = [
      `[${new Date().toISOString()}] To: ${message.to}`,
      `Subject: ${message.subject}`,
      '',
      message.text,
      '',
      '='.repeat(72),
      '',
    ].join('\n');
    await appendFile(file, entry, 'utf8');
  }
}

/** Real delivery over SMTP. */
class SmtpMailer implements Mailer {
  readonly driver = 'smtp';
  private transporter: Transporter | null = null;

  private getTransporter(): Transporter {
    this.transporter ??= nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth:
        env.SMTP_USER && env.SMTP_PASSWORD
          ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD }
          : undefined,
      // Bound the wait: a hanging SMTP handshake inside a request handler
      // would hold the response open until the client gives up.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    return this.transporter;
  }

  async send(message: MailMessage): Promise<void> {
    try {
      await this.getTransporter().sendMail({
        from: env.MAIL_FROM,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    } catch (error) {
      // The address is redacted: this log line is written on every failed
      // delivery and would otherwise accumulate a list of real addresses.
      console.error(
        `[mail] delivery to ${redactEmail(message.to)} failed:`,
        (error as Error).message,
      );
      // Deliberately swallowed. Registration and password-reset must not fail
      // because the mail server is down — the token is still valid, and the
      // user can request another. Surfacing this as a 500 would tell an
      // attacker which addresses exist by observing which requests error.
    }
  }
}

let instance: Mailer | null = null;

export function getMailer(): Mailer {
  if (instance) return instance;

  switch (env.MAIL_DRIVER) {
    case 'smtp':
      instance = new SmtpMailer();
      break;
    case 'file':
      if (isProduction) {
        console.warn('[mail] file driver selected in production; messages will not be delivered.');
      }
      instance = new FileMailer(env.MAIL_FILE_PATH);
      break;
    case 'console':
    default:
      instance = new ConsoleMailer();
      break;
  }

  return instance;
}

/** Test hook. */
export function setMailer(mailer: Mailer | null): void {
  instance = mailer;
}

export type { Mailer, MailMessage };

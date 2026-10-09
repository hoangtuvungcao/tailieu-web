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
    const isGmail =
      env.SMTP_HOST?.toLowerCase().includes('gmail') ||
      Boolean(env.SMTP_USER?.toLowerCase().endsWith('@gmail.com'));

    const password = env.SMTP_PASSWORD ? env.SMTP_PASSWORD.replace(/\s+/g, '') : undefined;

    if (isGmail) {
      this.transporter ??= nodemailer.createTransport({
        service: 'gmail',
        auth:
          env.SMTP_USER && password
            ? { user: env.SMTP_USER, pass: password }
            : undefined,
        connectionTimeout: 15_000,
        greetingTimeout: 10_000,
        socketTimeout: 30_000,
      });
      return this.transporter;
    }

    this.transporter ??= nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE || env.SMTP_PORT === 465,
      auth:
        env.SMTP_USER && password
          ? { user: env.SMTP_USER, pass: password }
          : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    return this.transporter;
  }

  async send(message: MailMessage): Promise<void> {
    try {
      const isGmail =
        env.SMTP_HOST?.toLowerCase().includes('gmail') ||
        Boolean(env.SMTP_USER?.toLowerCase().endsWith('@gmail.com'));

      let fromAddress = env.MAIL_FROM;
      if (isGmail && env.SMTP_USER && fromAddress.includes('tailieu.local')) {
        fromAddress = `Tài Liệu Sinh Viên <${env.SMTP_USER}>`;
      }

      await this.getTransporter().sendMail({
        from: fromAddress,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    } catch (error) {
      console.error(
        `[mail] delivery to ${redactEmail(message.to)} failed:`,
        (error as Error).message,
      );
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

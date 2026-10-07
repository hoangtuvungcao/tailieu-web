import { createHmac, randomBytes } from 'node:crypto';

import { env, isTest } from '../../config/env.js';
import { AppError } from '../errors.js';

const CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // Excludes 0, O, 1, I
const CAPTCHA_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Memory store to prevent token reuse
const usedTokens = new Set<string>();

// Cleanup stale used tokens periodically
setInterval(() => {
  if (usedTokens.size > 10000) {
    usedTokens.clear();
  }
}, 10 * 60 * 1000).unref();

export interface CaptchaData {
  token: string;
  image: string; // Base64 data URL
}

function getRandomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getRandomColor(min = 30, max = 150): string {
  const r = getRandomInt(min, max);
  const g = getRandomInt(min, max);
  const b = getRandomInt(min, max);
  return `rgb(${r},${g},${b})`;
}

/**
 * Generate an SVG captcha with noise lines, dots, and distorted characters.
 */
function createSvgCaptcha(text: string): string {
  const width = 140;
  const height = 44;

  let lines = '';
  for (let i = 0; i < 4; i++) {
    const x1 = getRandomInt(0, width / 2);
    const y1 = getRandomInt(0, height);
    const x2 = getRandomInt(width / 2, width);
    const y2 = getRandomInt(0, height);
    const cx = getRandomInt(width / 4, (width * 3) / 4);
    const cy = getRandomInt(0, height);
    const stroke = getRandomColor(120, 200);
    lines += `<path d="M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}" stroke="${stroke}" stroke-width="${getRandomInt(1, 2)}" fill="none" opacity="0.6" />`;
  }

  let dots = '';
  for (let i = 0; i < 28; i++) {
    const cx = getRandomInt(0, width);
    const cy = getRandomInt(0, height);
    const r = getRandomInt(1, 2);
    const fill = getRandomColor(100, 210);
    dots += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" opacity="0.5" />`;
  }

  const charSpacing = width / (text.length + 1);
  let textSvg = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const x = Math.round(charSpacing * (i + 0.8) + getRandomInt(-3, 3));
    const y = Math.round(height * 0.7 + getRandomInt(-3, 3));
    const rot = getRandomInt(-22, 22);
    const fill = getRandomColor(20, 100);
    const size = getRandomInt(22, 26);
    textSvg += `<text x="${x}" y="${y}" font-family="Arial, sans-serif" font-weight="bold" font-size="${size}" fill="${fill}" transform="rotate(${rot}, ${x}, ${y})">${char}</text>`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="background:#f8fafc; border-radius:6px;">${lines}${dots}${textSvg}</svg>`;
  const base64 = Buffer.from(svg).toString('base64');
  return `data:image/svg+xml;base64,${base64}`;
}

export function generateCaptcha(): CaptchaData {
  let text = '';
  for (let i = 0; i < 4; i++) {
    text += CHARS[getRandomInt(0, CHARS.length - 1)];
  }

  const expiresAt = Date.now() + CAPTCHA_TTL_MS;
  const nonce = randomBytes(6).toString('hex');
  const payload = `${text}|${expiresAt}|${nonce}`;
  const hmac = createHmac('sha256', env.CSRF_SECRET)
    .update(payload)
    .digest('hex');

  const token = `${Buffer.from(payload).toString('base64url')}.${hmac}`;
  const image = createSvgCaptcha(text);

  return { token, image };
}

export function verifyCaptcha(token?: string, answer?: string): void {
  // Allow test suite to run without requiring manual captcha solving when no token is provided
  if (isTest && (!token || answer === 'TEST_BYPASS')) {
    return;
  }

  if (!token || !answer || !answer.trim()) {
    throw new AppError('CAPTCHA_REQUIRED', 'Vui lòng nhập mã bảo vệ (captcha).');
  }

  if (usedTokens.has(token)) {
    throw new AppError('CAPTCHA_EXPIRED', 'Mã bảo vệ đã được sử dụng. Vui lòng lấy mã mới.');
  }

  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new AppError('CAPTCHA_INVALID', 'Mã bảo vệ không hợp lệ.');
  }

  const encodedPayload = parts[0];
  const providedHmac = parts[1];
  let payload = '';
  try {
    payload = Buffer.from(encodedPayload, 'base64url').toString('utf8');
  } catch {
    throw new AppError('CAPTCHA_INVALID', 'Mã bảo vệ không hợp lệ.');
  }

  const expectedHmac = createHmac('sha256', env.CSRF_SECRET)
    .update(payload)
    .digest('hex');

  if (providedHmac !== expectedHmac) {
    throw new AppError('CAPTCHA_INVALID', 'Mã bảo vệ không hợp lệ.');
  }

  const [expectedAnswer, expiresAtStr] = payload.split('|');
  const expiresAt = Number(expiresAtStr);

  if (isNaN(expiresAt) || Date.now() > expiresAt) {
    throw new AppError('CAPTCHA_EXPIRED', 'Mã bảo vệ đã hết hạn. Vui lòng bấm làm mới mã.');
  }

  if (answer.trim().toUpperCase() !== expectedAnswer?.toUpperCase()) {
    throw new AppError('CAPTCHA_INVALID', 'Mã bảo vệ không chính xác. Vui lòng thử lại.');
  }

  // Mark token as consumed
  usedTokens.add(token);
}

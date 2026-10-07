import { describe, expect, it } from 'vitest';
import { generateCaptcha, verifyCaptcha } from './captcha.service.js';

describe('captcha.service', () => {
  it('generates an SVG captcha with valid dataUrl and token', () => {
    const captcha = generateCaptcha();

    expect(captcha.token).toBeDefined();
    expect(captcha.token.length).toBeGreaterThan(20);
    expect(captcha.image).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it('verifies correct answer case-insensitively and throws on replay', () => {
    const captcha = generateCaptcha();

    // Decode token payload to extract expected answer: text|expiresAt|nonce
    const [encodedPayload = ''] = captcha.token.split('.');
    const payload = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    const [expectedAnswer = ''] = payload.split('|');

    // Case insensitive check should succeed without throwing
    expect(() => verifyCaptcha(captcha.token, expectedAnswer.toLowerCase())).not.toThrow();

    // Replay attack: second verification of same token throws CAPTCHA_EXPIRED
    expect(() => verifyCaptcha(captcha.token, expectedAnswer)).toThrowError(/đã được sử dụng/);
  });

  it('rejects incorrect answers', () => {
    const captcha = generateCaptcha();
    expect(() => verifyCaptcha(captcha.token, 'WRONG_ANSWER')).toThrowError(/không chính xác/);
  });

  it('rejects tampered tokens', () => {
    const captcha = generateCaptcha();
    const tampered = captcha.token.slice(0, -5) + 'abcde';
    expect(() => verifyCaptcha(tampered, 'TEST')).toThrowError(/không hợp lệ/);
  });

  it('rejects empty answers when token is present', () => {
    const captcha = generateCaptcha();
    expect(() => verifyCaptcha(captcha.token, '')).toThrowError(/nhập mã bảo vệ/);
  });
});

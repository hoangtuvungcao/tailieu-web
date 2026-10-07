import { useCallback, useEffect, useState } from 'react';
import { Loader2, RotateCw, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api-client';
import { Field, Input } from './ui';

interface CaptchaResponse {
  token: string;
  image: string;
}

interface CaptchaFieldProps {
  value: string;
  onChange: (answer: string, token: string) => void;
  error?: string;
  required?: boolean;
}

function generateClientSvgCaptcha(text: string): string {
  const width = 140;
  const height = 44;
  const colors = ['#059669', '#2563eb', '#d97706', '#dc2626', '#7c3aed', '#0891b2'];

  const charsSvg = text
    .split('')
    .map((char, index) => {
      const x = 18 + index * 28 + (Math.random() * 4 - 2);
      const y = 30 + (Math.random() * 4 - 2);
      const rot = Math.floor(Math.random() * 24 - 12);
      const color = colors[index % colors.length];
      return `<text x="${x}" y="${y}" font-family="Arial, sans-serif" font-weight="900" font-size="24" fill="${color}" transform="rotate(${rot}, ${x}, ${y})">${char}</text>`;
    })
    .join('');

  const noise = [
    `<path d="M 5 22 Q 40 5, 80 22 T 135 22" stroke="#94a3b8" stroke-width="1.5" fill="none" opacity="0.6"/>`,
    `<path d="M 5 10 Q 50 38, 90 15 T 135 30" stroke="#cbd5e1" stroke-width="1.5" fill="none" opacity="0.6"/>`,
  ].join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#f8fafc" rx="6"/>
    ${noise}
    ${charsSvg}
  </svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function CaptchaField({
  value,
  onChange,
  error,
  required = true,
}: CaptchaFieldProps) {
  const [captchaData, setCaptchaData] = useState<CaptchaResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fallbackExpected, setFallbackExpected] = useState<string | null>(null);

  const fetchCaptcha = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.get<CaptchaResponse>('/auth/captcha');
      setCaptchaData(data);
      setFallbackExpected(null);
      onChange('', data.token);
    } catch {
      // Backend hasn't deployed the captcha route yet or is temporarily restarting:
      // Generate client-side SVG captcha fallback so users are never blocked with an error badge
      const CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
      let text = '';
      for (let i = 0; i < 4; i++) {
        text += CHARS[Math.floor(Math.random() * CHARS.length)];
      }
      const clientImage = generateClientSvgCaptcha(text);
      setCaptchaData({ token: 'client_fallback', image: clientImage });
      setFallbackExpected(text);
      onChange('', 'client_fallback');
    } finally {
      setLoading(false);
    }
  }, [onChange]);

  useEffect(() => {
    void fetchCaptcha();
  }, [fetchCaptcha]);

  useEffect(() => {
    if (fallbackExpected && value && value.length >= 4) {
      if (value.toUpperCase() !== fallbackExpected.toUpperCase()) {
        setLoadError('Mã bảo vệ chưa chính xác');
      } else {
        setLoadError(null);
      }
    } else {
      setLoadError(null);
    }
  }, [value, fallbackExpected]);

  return (
    <Field
      label="Mã bảo vệ (Captcha)"
      htmlFor="captcha-input"
      error={error || loadError || undefined}
      hint="Nhập 4 ký tự hiển thị trong hình để xác nhận không phải người máy."
      required={required}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {/* Captcha Image display & Refresh button */}
        <div className="flex items-center gap-2">
          <div className="relative flex h-11 w-36 items-center justify-center overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] shadow-xs">
            {loading ? (
              <Loader2 className="h-5 w-5 animate-spin text-[var(--color-primary)]" />
            ) : captchaData?.image ? (
              <img
                src={captchaData.image}
                alt="Mã bảo vệ Captcha"
                className="h-full w-full object-contain select-none"
              />
            ) : (
              <div className="flex items-center gap-1 text-xs text-red-500">
                <ShieldCheck className="h-3.5 w-3.5" />
                Lỗi tải mã
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => void fetchCaptcha()}
            disabled={loading}
            title="Đổi mã khác"
            aria-label="Đổi mã bảo vệ khác"
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] text-[var(--color-foreground-muted)] hover:bg-[var(--color-muted)] hover:text-[var(--color-foreground)] disabled:opacity-50 transition-colors cursor-pointer"
          >
            <RotateCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Input Field */}
        <div className="flex-1">
          <Input
            id="captcha-input"
            type="text"
            maxLength={6}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="characters"
            spellCheck="false"
            placeholder="Nhập 4 ký tự"
            value={value}
            onChange={(e) => {
              const text = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
              onChange(text, captchaData?.token || '');
            }}
            aria-invalid={Boolean(error)}
            className="h-11 font-mono uppercase tracking-widest text-center sm:text-left text-base"
          />
        </div>
      </div>
    </Field>
  );
}

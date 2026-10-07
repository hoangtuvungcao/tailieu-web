import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RotateCw, ShieldAlert } from 'lucide-react';
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

export function CaptchaField({
  value,
  onChange,
  error,
  required = true,
}: CaptchaFieldProps) {
  const [captchaData, setCaptchaData] = useState<CaptchaResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Keep a stable ref to onChange to break any parent re-render dependency cycles
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const fetchCaptcha = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.get<CaptchaResponse>('/auth/captcha');
      setCaptchaData(data);
      onChangeRef.current('', data.token);
    } catch {
      setLoadError('Không thể tải mã bảo vệ từ máy chủ. Vui lòng bấm thử lại.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch exactly once on mount
  useEffect(() => {
    void fetchCaptcha();
  }, [fetchCaptcha]);

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
              <div className="flex items-center gap-1 text-xs text-red-500 px-2 text-center">
                <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
                <span>Lỗi kết nối</span>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => void fetchCaptcha()}
            disabled={loading}
            title="Đổi mã bảo vệ khác"
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
            aria-invalid={Boolean(error || loadError)}
            className="h-11 font-mono uppercase tracking-widest text-center sm:text-left text-base"
          />
        </div>
      </div>
    </Field>
  );
}

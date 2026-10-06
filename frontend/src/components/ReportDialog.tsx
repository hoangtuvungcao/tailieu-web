import { useEffect, useId, useRef, useState } from 'react';
import { Flag, X } from 'lucide-react';
import { Link } from 'react-router-dom';

import { ApiError } from '@/lib/api-client';
import {
  REPORT_REASONS,
  useCreateReport,
  type ReportReason,
  type ReportTargetType,
} from '@/lib/report-hooks';
import { cn } from '@/lib/utils';
import { Button, Field, Textarea } from '@/components/ui';

/**
 * Reporting a document.
 *
 * A dialog rather than a page, because reporting is a two-field interruption and
 * a route change would lose the reader's place in whatever they were reading.
 *
 * The reason is a radio list rather than a `<select>`. Nine options that all fit
 * on screen at once and are worth reading before choosing are the case where a
 * dropdown actively hurts: it hides the alternatives behind a click, and the
 * most common mis-filing is someone picking the first plausible reason because
 * they never saw the better one.
 */
export function ReportDialog({
  targetType,
  targetId,
  targetTitle,
  onClose,
}: {
  targetType: ReportTargetType;
  targetId: string;
  /** Shown back to the reporter so they can see what they are about to flag. */
  targetTitle: string;
  onClose: () => void;
}) {
  const groupName = useId();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const create = useCreateReport();

  // Escape closes, and focus moves into the panel on open so a keyboard user is
  // not left behind on the button that opened it.
  useEffect(() => {
    panelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  async function submit(): Promise<void> {
    if (!reason) {
      setError('Chọn một lý do trước khi gửi.');
      return;
    }
    setError(null);
    try {
      await create.mutateAsync({
        targetType,
        targetId,
        reason,
        details: details.trim() || undefined,
      });
      setDone(true);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Không gửi được báo cáo. Thử lại sau.',
      );
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${groupName}-title`}
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-6 shadow-lg outline-none"
        onClick={(event) => event.stopPropagation()}
      >
        {done ? (
          <div className="space-y-4">
            <h2 id={`${groupName}-title`} className="text-lg font-semibold">
              Đã gửi báo cáo
            </h2>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              Cảm ơn bạn. Kiểm duyệt viên sẽ xem xét và xử lý.
            </p>
            {/* A real link, not a sentence telling people a page exists. The
                route is `/reports` and it lists exactly this report. */}
            <p className="text-sm">
              <Link
                to="/reports"
                className="text-[var(--color-primary)] underline-offset-2 hover:underline"
              >
                Xem báo cáo của tôi
              </Link>
            </p>
            <div className="flex justify-end">
              <Button onClick={onClose}>Đóng</Button>
            </div>
          </div>
        ) : (
          <>
            <div className="mb-1 flex items-start justify-between gap-3">
              <h2 id={`${groupName}-title`} className="text-lg font-semibold">
                Báo cáo nội dung
              </h2>
              {/* An icon rather than the word "Đóng", because the footer already
                  offers "Huỷ" — two text buttons that both only dismiss read as
                  a choice between two different outcomes, and there is only one. */}
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 shrink-0 p-0"
                onClick={onClose}
                aria-label="Đóng"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            <p className="mb-4 line-clamp-2 text-sm text-[var(--color-muted-foreground)]">
              {targetTitle}
            </p>

            {error ? (
              <p
                role="alert"
                className="mb-4 rounded-md border border-[var(--color-destructive)]/30 bg-[color-mix(in_oklch,var(--color-destructive)_6%,transparent)] px-3 py-2 text-sm text-[var(--color-destructive)]"
              >
                {error}
              </p>
            ) : null}

            <fieldset className="mb-4">
              <legend className="mb-2 text-sm font-medium">Lý do</legend>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {REPORT_REASONS.map((entry) => (
                  <label
                    key={entry.value}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                      reason === entry.value
                        ? 'border-[var(--color-primary)] bg-[color-mix(in_oklch,var(--color-primary)_8%,transparent)]'
                        : 'border-[var(--color-border)] hover:bg-[var(--color-muted)]',
                    )}
                  >
                    <input
                      type="radio"
                      name={groupName}
                      value={entry.value}
                      checked={reason === entry.value}
                      onChange={() => setReason(entry.value)}
                      className="accent-[var(--color-primary)]"
                    />
                    {entry.label}
                  </label>
                ))}
              </div>
            </fieldset>

            <Field
              label="Mô tả thêm (không bắt buộc)"
              htmlFor={`${groupName}-details`}
              hint="Càng cụ thể càng dễ xử lý. Tối đa 2000 ký tự."
            >
              <Textarea
                id={`${groupName}-details`}
                value={details}
                onChange={(event) => setDetails(event.target.value)}
                rows={3}
                maxLength={2000}
                placeholder="Ví dụ: tệp đính kèm không mở được, hoặc nội dung không đúng như mô tả."
              />
            </Field>

            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>
                Huỷ
              </Button>
              <Button onClick={() => void submit()} disabled={create.isPending}>
                <Flag className="mr-1.5 h-4 w-4" aria-hidden />
                {create.isPending ? 'Đang gửi…' : 'Gửi báo cáo'}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

import { useEffect, useId, useRef, useState } from 'react';
import { Flag, X, ShieldAlert, Mail, Copy, Check, ExternalLink, LogIn } from 'lucide-react';
import { Link } from 'react-router-dom';

import { useAuth } from '@/lib/auth';
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
 * Reporting a document, post, comment or collection.
 *
 * Safe Harbor & DMCA compliant:
 * - Allows unauthenticated rights holders (lecturers, authors) to directly file
 *   a copyright takedown request via email / template without needing an account.
 * - Authenticated users can file directly to the moderation queue with priority guidance
 *   for copyright issues.
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
  const { isAuthenticated } = useAuth();

  const [guestTab, setGuestTab] = useState<'copyright' | 'general'>('copyright');
  const [copied, setCopied] = useState(false);

  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const create = useCreateReport();

  const currentUrl = typeof window !== 'undefined' ? window.location.href : '';

  const dmcaTemplate = `Kính gửi Ban Quản Trị Tài Liệu Sinh Viên,

Tôi xin gửi yêu cầu gỡ bỏ nội dung vi phạm bản quyền theo quy trình Safe Harbor / DMCA:

1. TÀI LIỆU CẦN GỠ BỎ:
- Tiêu đề: ${targetTitle}
- Định danh (ID): ${targetId}
- Đường dẫn (URL): ${currentUrl}

2. THÔNG TIN CHỦ SỞ HỮU QUYỀN TÁC GIẢ:
- Tên Tác giả / Đơn vị sở hữu: [Điền tên Thầy/Cô hoặc cơ quan/trường học]
- Căn cứ chứng minh bản quyền: [Tác phẩm gốc / giáo trình / bài giảng tương ứng]

3. THÔNG TIN LIÊN HỆ:
- Người đại diện: [Họ và tên]
- Email: [Địa chỉ email liên hệ]
- Số điện thoại: [Số điện thoại nếu có]

Tôi cam kết các thông tin khai báo trên là chính xác và tôi là chủ sở hữu hoặc người được ủy quyền hợp pháp.

Trân trọng,`;

  const mailtoLink = `mailto:admin@5125121.com?subject=${encodeURIComponent(
    `[DMCA Notice] Yêu cầu gỡ bỏ tài liệu: ${targetTitle}`,
  )}&body=${encodeURIComponent(dmcaTemplate)}`;

  useEffect(() => {
    panelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(dmcaTemplate);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      // Clipboard api fallback
    }
  }

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${groupName}-title`}
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-6 shadow-xl outline-none"
        onClick={(event) => event.stopPropagation()}
      >
        {done ? (
          <div className="space-y-4">
            <h2 id={`${groupName}-title`} className="text-lg font-semibold">
              Đã gửi báo cáo thành công
            </h2>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              Cảm ơn bạn đã phản hồi. Đội ngũ kiểm duyệt sẽ rà soát và xử lý theo quy định.
            </p>
            <p className="text-sm">
              <Link
                to="/reports"
                className="text-[var(--color-primary)] underline-offset-2 hover:underline"
              >
                Xem danh sách báo cáo của tôi
              </Link>
            </p>
            <div className="flex justify-end">
              <Button onClick={onClose}>Đóng</Button>
            </div>
          </div>
        ) : !isAuthenticated ? (
          /* GUEST / RIGHTS HOLDER VIEW */
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="inline-flex items-center gap-1.5 rounded-full bg-rose-500/10 px-2.5 py-0.5 text-xs font-semibold text-rose-600 dark:text-rose-400">
                  <ShieldAlert className="h-3.5 w-3.5" />
                  <span>Bảo vệ quyền tác giả &amp; Báo cáo</span>
                </div>
                <h2 id={`${groupName}-title`} className="mt-2 text-lg font-semibold">
                  Khiếu Nại Bản Quyền &amp; Báo Cáo
                </h2>
              </div>
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

            <p className="line-clamp-2 rounded-md bg-[var(--color-muted)] p-2.5 text-xs text-[var(--color-muted-foreground)]">
              <strong>Đối tượng:</strong> {targetTitle}
            </p>

            {/* Guest Tabs */}
            <div className="flex border-b border-[var(--color-border)]">
              <button
                type="button"
                className={cn(
                  'border-b-2 px-3 py-2 text-xs font-medium transition-colors',
                  guestTab === 'copyright'
                    ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
                    : 'border-transparent text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]',
                )}
                onClick={() => setGuestTab('copyright')}
              >
                Tác giả / Giảng viên (DMCA Takedown)
              </button>
              <button
                type="button"
                className={cn(
                  'border-b-2 px-3 py-2 text-xs font-medium transition-colors',
                  guestTab === 'general'
                    ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
                    : 'border-transparent text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]',
                )}
                onClick={() => setGuestTab('general')}
              >
                Báo cáo nội dung khác
              </button>
            </div>

            {guestTab === 'copyright' ? (
              <div className="space-y-3.5 text-xs text-[var(--color-muted-foreground)]">
                <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 leading-relaxed">
                  <p className="font-semibold text-blue-600 dark:text-blue-400">
                    ⚡ Cam kết gỡ bỏ trong vòng 12 – 24 giờ
                  </p>
                  <p className="mt-1">
                    Nếu Quý Thầy/Cô hoặc Đơn vị sở hữu phát hiện tài liệu vi phạm bản quyền, vui lòng gửi yêu cầu gỡ bỏ trực tiếp tới hòm thư tiếp nhận. Không bắt buộc phải có tài khoản trên trang.
                  </p>
                </div>

                <div className="space-y-2">
                  <p className="font-medium text-[var(--color-foreground)]">Lựa chọn gửi yêu cầu:</p>

                  <a href={mailtoLink} className="block w-full">
                    <Button className="w-full gap-2 text-xs" size="sm">
                      <Mail className="h-4 w-4" />
                      Mở ứng dụng Email để gửi yêu cầu ngay
                    </Button>
                  </a>

                  <Button
                    variant="outline"
                    className="w-full gap-2 text-xs"
                    size="sm"
                    onClick={() => void handleCopy()}
                  >
                    {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
                    {copied ? 'Đã sao chép mẫu email vào bộ nhớ!' : 'Sao chép mẫu khiếu nại (gửi từ mail trường/cá nhân)'}
                  </Button>
                </div>

                <div className="border-t border-[var(--color-border)] pt-2 text-[11px]">
                  <p>
                    Email tiếp nhận bản quyền:{' '}
                    <strong className="text-[var(--color-foreground)]">admin@5125121.com</strong>
                  </p>
                  <Link
                    to="/policy/copyright"
                    onClick={onClose}
                    className="mt-1 inline-flex items-center gap-1 text-[var(--color-primary)] hover:underline"
                  >
                    <span>Xem toàn văn Quy trình Notice &amp; Takedown</span>
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                </div>
              </div>
            ) : (
              <div className="space-y-3 py-3 text-center text-xs">
                <p className="text-[var(--color-muted-foreground)]">
                  Để tránh tình trạng gửi báo cáo ảo hoặc quấy rối hàng loạt, việc báo cáo các vấn đề như spam hoặc nội dung không chính xác yêu cầu bạn đăng nhập tài khoản.
                </p>
                <Link to="/login" onClick={onClose}>
                  <Button className="gap-2" size="sm">
                    <LogIn className="h-4 w-4" />
                    Đăng nhập để gửi báo cáo
                  </Button>
                </Link>
              </div>
            )}

            <div className="flex justify-end pt-2">
              <Button variant="ghost" size="sm" onClick={onClose}>
                Đóng
              </Button>
            </div>
          </div>
        ) : (
          /* AUTHENTICATED USER VIEW */
          <>
            <div className="mb-1 flex items-start justify-between gap-3">
              <h2 id={`${groupName}-title`} className="text-lg font-semibold">
                Báo cáo nội dung
              </h2>
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

            {/* Copyright fast-track notice */}
            {reason === 'copyright' ? (
              <div className="mb-4 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-[var(--color-muted-foreground)]">
                <p className="font-semibold text-amber-600 dark:text-amber-400">
                  ⚡ Bạn đang báo cáo vi phạm bản quyền
                </p>
                <p className="mt-1">
                  Nếu bạn là tác giả hoặc đại diện sở hữu quyền tác giả cần gỡ bỏ khẩn cấp trong 12–24h, bạn có thể gửi yêu cầu trực tiếp qua{' '}
                  <a href={mailtoLink} className="font-medium text-[var(--color-primary)] underline">
                    email tiếp nhận DMCA
                  </a>{' '}
                  hoặc xem{' '}
                  <Link
                    to="/policy/copyright"
                    onClick={onClose}
                    className="font-medium text-[var(--color-primary)] underline"
                  >
                    Chính sách Bản quyền
                  </Link>
                  .
                </p>
              </div>
            ) : null}

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
                placeholder="Ví dụ: tài liệu thuộc giáo trình bản quyền của NXB hoặc slide riêng của thầy cô."
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

import { cn } from '@/lib/utils';

/**
 * The brand mark, as inline SVG.
 *
 * Inline rather than an `<img src="/favicon.svg">` for two reasons. It scales
 * without a second request on the one component that renders on every page,
 * and being one element lets the wordmark sit on the baseline with it instead
 * of being aligned against an image box.
 *
 * It is the same drawing as `public/favicon.svg`. The two are duplicated
 * deliberately: the favicon must be a standalone file the browser can fetch
 * before any JavaScript runs, and the header mark must be inline to avoid a
 * layout shift on a component above the fold. A shared source would mean a
 * build step for one 600-byte asset.
 *
 * `decorative` drops the accessible name. The header passes it, because the
 * wordmark beside the mark already says the same thing and a screen reader
 * announcing "Tài liệu TTN" twice is noise.
 */
export function LogoMark({
  className,
  decorative = false,
}: {
  className?: string;
  decorative?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={cn('h-9 w-9 shrink-0', className)}
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : 'Tài liệu TTN'}
    >
      <defs>
        <linearGradient id="logo-badge" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#005f2e" />
          <stop offset="1" stopColor="#007e46" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill="url(#logo-badge)" />
      <path
        d="M19 10h18l11 11v31a4 4 0 0 1-4 4H19a4 4 0 0 1-4-4V14a4 4 0 0 1 4-4z"
        fill="#ffffff"
      />
      <path d="M37 10l11 11H40a3 3 0 0 1-3-3z" fill="#e3ae28" />
      <path d="M31 23c7 6 8.6 13.6 0 21-8.6-7.4-7-15 0-21z" fill="#e3ae28" />
      <path d="M31 44v6" stroke="#e3ae28" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Mark plus wordmark, for the header and the footer.
 *
 * The subtitle is hidden below `sm` because at 360px the wordmark and the
 * account button already compete for the same row, and the university name is
 * the part that can wait.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <LogoMark decorative />
      <span className="flex flex-col leading-none">
        <span className="text-sm font-bold tracking-tight">TAILIEU TTN</span>
        <span className="hidden text-[11px] text-[var(--color-muted-foreground)] sm:block">
          Đại học Tây Nguyên
        </span>
      </span>
    </span>
  );
}

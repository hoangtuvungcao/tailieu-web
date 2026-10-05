import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';

import { cn } from '@/lib/utils';

/**
 * UI primitives.
 *
 * Hand-written in the shadcn idiom rather than pulled from a component library:
 * they are a few hundred lines total, carry no runtime dependency, and — most
 * importantly — are owned, so a variant can be added without fighting an
 * upstream API or waiting for a release.
 */

// =============================================================================
// Button
// =============================================================================

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ring)]',
  {
    variants: {
      variant: {
        default: 'bg-[var(--color-primary)] text-[var(--color-primary-foreground)] hover:opacity-90',
        secondary:
          'bg-[var(--color-secondary)] text-[var(--color-secondary-foreground)] hover:bg-[var(--color-muted)]',
        outline:
          'border border-[var(--color-border)] bg-transparent hover:bg-[var(--color-muted)]',
        ghost: 'hover:bg-[var(--color-muted)]',
        destructive:
          'bg-[var(--color-destructive)] text-[var(--color-destructive-foreground)] hover:opacity-90',
        link: 'text-[var(--color-primary)] underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        default: 'h-10 px-4',
        lg: 'h-12 px-6 text-base',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  isLoading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, isLoading, children, disabled, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      // Disabled while loading, so a double-click cannot submit twice. The
      // server is idempotent for most of these, but a duplicate upload is not.
      disabled={disabled || isLoading}
      // Communicates the pending state to assistive technology, which a
      // spinner alone does not.
      aria-busy={isLoading || undefined}
      {...props}
    >
      {isLoading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  ),
);
Button.displayName = 'Button';

// =============================================================================
// Input, Textarea, Label
// =============================================================================

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'flex h-10 w-full rounded-md border border-[var(--color-input)] bg-[var(--color-card)] px-3 py-2 text-sm',
        'placeholder:text-[var(--color-muted-foreground)]',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-ring)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'flex min-h-24 w-full rounded-md border border-[var(--color-input)] bg-[var(--color-card)] px-3 py-2 text-sm',
        'placeholder:text-[var(--color-muted-foreground)]',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-ring)]',
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';

export function Label({ className, children, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn('text-sm font-medium leading-none', className)}
      {...props}
    >
      {children}
    </label>
  );
}

/** Field wrapper that wires up label, error and description consistently. */
export function Field({
  label,
  htmlFor,
  error,
  hint,
  required,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>
        {label}
        {required ? <span className="ml-0.5 text-[var(--color-destructive)]">*</span> : null}
      </Label>
      {children}
      {hint && !error ? (
        <p className="text-xs text-[var(--color-muted-foreground)]">{hint}</p>
      ) : null}
      {/* role="alert" so a screen reader announces the error when it appears,
          rather than leaving the user to discover it by re-reading the form. */}
      {error ? (
        <p role="alert" className="text-xs text-[var(--color-destructive)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// =============================================================================
// Card
// =============================================================================

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] text-[var(--color-card-foreground)]',
        '[box-shadow:var(--shadow-card)]',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1 p-5 pb-3', className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-base font-semibold leading-tight', className)} {...props} />;
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn('text-sm text-[var(--color-muted-foreground)]', className)} {...props} />
  );
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-5 pt-0', className)} {...props} />;
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center gap-2 p-5 pt-0', className)} {...props} />;
}

// =============================================================================
// Badge
// =============================================================================

const badgeVariants = cva(
  // `whitespace-nowrap`: a badge is a label, not prose. "Quản trị" broke onto
  // two lines in the header chip as soon as the row got tight, which turns a
  // role marker into a tall yellow blob.
  'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium',
  {
    variants: {
      variant: {
        default: 'bg-[var(--color-secondary)] text-[var(--color-secondary-foreground)]',
        brand: 'bg-[var(--color-brand-100)] text-[var(--color-brand-800)]',
        gold: 'bg-[var(--color-gold-100)] text-[var(--color-gold-700)]',
        success: 'bg-[color-mix(in_oklch,var(--color-success)_18%,transparent)] text-[var(--color-success)]',
        warning: 'bg-[var(--color-gold-100)] text-[var(--color-gold-700)]',
        destructive:
          'bg-[color-mix(in_oklch,var(--color-destructive)_15%,transparent)] text-[var(--color-destructive)]',
        outline: 'border border-[var(--color-border)]',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

// =============================================================================
// Feedback: spinner, empty state, error state, skeleton
// =============================================================================

export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2
      className={cn('h-5 w-5 animate-spin text-[var(--color-muted-foreground)]', className)}
      aria-hidden
    />
  );
}

/**
 * Loading placeholder shaped like the content it replaces.
 *
 * A centred spinner tells the user nothing about what is coming; a skeleton
 * with the right shape makes the wait feel shorter and avoids a layout jump
 * when the data lands.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn('animate-pulse rounded-md bg-[var(--color-muted)]', className)}
      aria-hidden
    />
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-[var(--color-border)] px-6 py-14 text-center">
      {icon ? (
        <div className="text-[var(--color-muted-foreground)]" aria-hidden>
          {icon}
        </div>
      ) : null}
      <h3 className="text-base font-semibold">{title}</h3>
      {description ? (
        <p className="max-w-md text-sm text-[var(--color-muted-foreground)]">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-lg border border-[var(--color-destructive)]/30 bg-[color-mix(in_oklch,var(--color-destructive)_6%,transparent)] px-6 py-10 text-center"
    >
      <h3 className="text-base font-semibold">Đã xảy ra lỗi</h3>
      <p className="max-w-md text-sm text-[var(--color-muted-foreground)]">{message}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Thử lại
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Avatar with an initials fallback.
 *
 * Most accounts have no uploaded image, and a broken `<img>` placeholder looks
 * worse than initials. `aria-hidden` on the image because the adjacent name
 * already announces who this is — a screen reader reading the filename too is
 * noise.
 */
export function Avatar({
  name,
  src,
  size = 'default',
  className,
}: {
  name: string;
  src?: string | null;
  size?: 'sm' | 'default' | 'lg';
  className?: string;
}) {
  const dimension = { sm: 'h-8 w-8 text-xs', default: 'h-10 w-10 text-sm', lg: 'h-14 w-14 text-lg' }[size];

  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--color-brand-100)] font-semibold text-[var(--color-brand-800)]',
        dimension,
        className,
      )}
    >
      {src ? (
        <img src={src} alt="" aria-hidden className="h-full w-full object-cover" />
      ) : (
        <span aria-hidden>{initials || '?'}</span>
      )}
    </span>
  );
}

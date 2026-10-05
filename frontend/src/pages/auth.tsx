import { zodResolver } from '@hookform/resolvers/zod';
import { BookOpen, Compass } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';
import { z } from 'zod';

import { Button, Card, CardContent, Field, Input } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';

/**
 * Sign-in and registration.
 *
 * Validation is duplicated between here and the server on purpose. The client
 * copy exists to give immediate feedback and to mark the offending field; the
 * server copy is the actual control. They are intentionally not generated from
 * one schema — the client also needs to *not* enforce anything that would leak
 * policy (it does not validate password shape on sign-in, for instance).
 */

const loginSchema = z.object({
  email: z.string().min(1, 'Vui lòng nhập email.').email('Email không hợp lệ.'),
  password: z.string().min(1, 'Vui lòng nhập mật khẩu.'),
});

const registerSchema = z
  .object({
    displayName: z.string().trim().min(2, 'Tên hiển thị phải có ít nhất 2 ký tự.').max(80),
    email: z.string().min(1, 'Vui lòng nhập email.').email('Email không hợp lệ.'),
    password: z
      .string()
      .min(10, 'Mật khẩu phải có ít nhất 10 ký tự.')
      .max(200, 'Mật khẩu quá dài.'),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Mật khẩu nhập lại không khớp.',
  });

function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <div className="container-page flex min-h-[70vh] items-center justify-center py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <span
            aria-hidden
            className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--color-brand-700)] text-[var(--color-brand-50)]"
          >
            <BookOpen className="h-6 w-6" />
          </span>
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">{subtitle}</p>
        </div>

        <Card>
          <CardContent className="p-6">{children}</CardContent>
        </Card>

        <div className="mt-4 text-center text-sm text-[var(--color-muted-foreground)]">{footer}</div>
      </div>
    </div>
  );
}

export function LoginPage({ redirectTo }: { redirectTo?: string }) {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof loginSchema>>({ resolver: zodResolver(loginSchema) });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await signIn(values.email, values.password);
      navigate(redirectTo ?? '/', { replace: true });
    } catch (error) {
      if (error instanceof ApiError) {
        // Field-level errors when the server identifies a field; otherwise a
        // form-level banner. The server deliberately returns the same code for
        // "wrong password" and "no such account", so this never reveals which.
        const fields = error.fieldErrors;
        if (Object.keys(fields).length > 0) {
          for (const [field, messages] of Object.entries(fields)) {
            setError(field as 'email' | 'password', { message: messages[0] });
          }
        } else {
          setFormError(error.message);
        }
      } else {
        setFormError('Không thể kết nối tới máy chủ. Vui lòng thử lại.');
      }
    }
  });

  return (
    <AuthShell
      title="Đăng nhập"
      subtitle="Tiếp tục tới kho tri thức của bạn"
      footer={
        <>
          Chưa có tài khoản?{' '}
          <Link to="/register" className="font-medium text-[var(--color-primary)] hover:underline">
            Đăng ký ngay
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {formError ? (
          <div
            role="alert"
            className="rounded-md border border-[var(--color-destructive)]/30 bg-[color-mix(in_oklch,var(--color-destructive)_6%,transparent)] px-3 py-2 text-sm text-[var(--color-destructive)]"
          >
            {formError}
          </div>
        ) : null}

        <Field label="Email" htmlFor="email" error={errors.email?.message} required>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="sinhvien@example.com"
            aria-invalid={Boolean(errors.email)}
            {...register('email')}
          />
        </Field>

        <Field label="Mật khẩu" htmlFor="password" error={errors.password?.message} required>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            aria-invalid={Boolean(errors.password)}
            {...register('password')}
          />
        </Field>

        <Button type="submit" className="w-full" isLoading={isSubmitting}>
          Đăng nhập
        </Button>

        <p className="text-center text-xs text-[var(--color-muted-foreground)]">
          <Link to="/forgot-password" className="hover:underline">
            Quên mật khẩu?
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}

export function RegisterPage() {
  const { signUp } = useAuth();
  const navigate = useNavigate();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof registerSchema>>({ resolver: zodResolver(registerSchema) });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await signUp({
        email: values.email,
        password: values.password,
        displayName: values.displayName,
      });
      navigate('/', { replace: true });
    } catch (error) {
      if (error instanceof ApiError) {
        const fields = error.fieldErrors;
        if (Object.keys(fields).length > 0) {
          for (const [field, messages] of Object.entries(fields)) {
            setError(field as 'email' | 'password' | 'displayName', { message: messages[0] });
          }
        } else {
          setFormError(error.message);
        }
      } else {
        setFormError('Không thể kết nối tới máy chủ. Vui lòng thử lại.');
      }
    }
  });

  return (
    <AuthShell
      title="Tạo tài khoản"
      subtitle="Tham gia cộng đồng học thuật Đại học Tây Nguyên"
      footer={
        <>
          Đã có tài khoản?{' '}
          <Link to="/login" className="font-medium text-[var(--color-primary)] hover:underline">
            Đăng nhập
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {formError ? (
          <div
            role="alert"
            className="rounded-md border border-[var(--color-destructive)]/30 bg-[color-mix(in_oklch,var(--color-destructive)_6%,transparent)] px-3 py-2 text-sm text-[var(--color-destructive)]"
          >
            {formError}
          </div>
        ) : null}

        <Field label="Tên hiển thị" htmlFor="displayName" error={errors.displayName?.message} required>
          <Input
            id="displayName"
            autoComplete="name"
            placeholder="Nguyễn Văn A"
            aria-invalid={Boolean(errors.displayName)}
            {...register('displayName')}
          />
        </Field>

        <Field label="Email" htmlFor="email" error={errors.email?.message} required>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="sinhvien@example.com"
            aria-invalid={Boolean(errors.email)}
            {...register('email')}
          />
        </Field>

        <Field
          label="Mật khẩu"
          htmlFor="password"
          error={errors.password?.message}
          hint="Ít nhất 10 ký tự. Câu dài dễ nhớ an toàn hơn câu ngắn phức tạp."
          required
        >
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            aria-invalid={Boolean(errors.password)}
            {...register('password')}
          />
        </Field>

        <Field
          label="Nhập lại mật khẩu"
          htmlFor="confirmPassword"
          error={errors.confirmPassword?.message}
          required
        >
          <Input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            aria-invalid={Boolean(errors.confirmPassword)}
            {...register('confirmPassword')}
          />
        </Field>

        <Button type="submit" className="w-full" isLoading={isSubmitting}>
          Đăng ký
        </Button>

        <p className="text-center text-xs text-[var(--color-muted-foreground)]">
          Bằng việc đăng ký, bạn đồng ý chia sẻ tài liệu có nguồn gốc hợp pháp và không vi phạm bản quyền.
        </p>
      </form>
    </AuthShell>
  );
}

export function NotFoundPage() {
  return (
    <div className="container-page flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      <Compass className="h-12 w-12 text-[var(--color-muted-foreground)]" aria-hidden />
      <h1 className="text-2xl font-bold">Không tìm thấy trang</h1>
      <p className="max-w-md text-sm text-[var(--color-muted-foreground)]">
        Đường dẫn bạn truy cập không tồn tại, hoặc nội dung đã bị xoá.
      </p>
      <Button onClick={() => window.history.back()}>
        Quay lại
      </Button>
    </div>
  );
}

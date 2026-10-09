import { zodResolver } from '@hookform/resolvers/zod';
import { BookOpen, CheckCircle2, Compass, KeyRound, Loader2, Mail } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { z } from 'zod';

import { CaptchaField } from '@/components/CaptchaField';
import { Button, Card, CardContent, Field, Input } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';

/**
 * Sign-in, registration, forgot-password, and reset-password.
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

const forgotSchema = z.object({
  email: z.string().min(1, 'Vui lòng nhập email.').email('Email không hợp lệ.'),
});

const resetSchema = z
  .object({
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
  icon = BookOpen,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  const IconComponent = icon;
  return (
    <div className="container-page flex min-h-[70vh] items-center justify-center py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <span
            aria-hidden
            className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--color-brand-700)] text-[var(--color-brand-50)]"
          >
            <IconComponent className="h-6 w-6" />
          </span>
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">{subtitle}</p>
        </div>

        <Card>
          <CardContent className="p-6">{children}</CardContent>
        </Card>

        {footer ? (
          <div className="mt-4 text-center text-sm text-[var(--color-muted-foreground)]">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}

export function LoginPage({ redirectTo }: { redirectTo?: string }) {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [formError, setFormError] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState('');
  const [captchaAnswer, setCaptchaAnswer] = useState('');
  const [captchaError, setCaptchaError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof loginSchema>>({ resolver: zodResolver(loginSchema) });

  const onSubmit = handleSubmit(async (values) => {
    if (!captchaAnswer) {
      setCaptchaError('Vui lòng nhập mã bảo vệ.');
      return;
    }
    setCaptchaError(null);
    setFormError(null);

    try {
      await signIn(values.email, values.password, { token: captchaToken, answer: captchaAnswer });
      navigate(redirectTo ?? '/', { replace: true });
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === 'CAPTCHA_INVALID' || error.code === 'CAPTCHA_EXPIRED' || error.code === 'CAPTCHA_REQUIRED') {
          setCaptchaError(error.message);
          return;
        }
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

        <CaptchaField
          value={captchaAnswer}
          onChange={(answer, token) => {
            setCaptchaAnswer(answer);
            setCaptchaToken(token);
            setCaptchaError(null);
          }}
          error={captchaError ?? undefined}
        />

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
  const [captchaToken, setCaptchaToken] = useState('');
  const [captchaAnswer, setCaptchaAnswer] = useState('');
  const [captchaError, setCaptchaError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof registerSchema>>({ resolver: zodResolver(registerSchema) });

  const onSubmit = handleSubmit(async (values) => {
    if (!captchaAnswer) {
      setCaptchaError('Vui lòng nhập mã bảo vệ.');
      return;
    }
    setCaptchaError(null);
    setFormError(null);

    try {
      await signUp({
        email: values.email,
        password: values.password,
        displayName: values.displayName,
        captchaToken,
        captchaAnswer,
      });
      navigate('/', { replace: true });
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === 'CAPTCHA_INVALID' || error.code === 'CAPTCHA_EXPIRED' || error.code === 'CAPTCHA_REQUIRED') {
          setCaptchaError(error.message);
          return;
        }
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
      subtitle="Tham gia cộng đồng học thuật sinh viên"
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

        <CaptchaField
          value={captchaAnswer}
          onChange={(answer, token) => {
            setCaptchaAnswer(answer);
            setCaptchaToken(token);
            setCaptchaError(null);
          }}
          error={captchaError ?? undefined}
        />

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

export function ForgotPasswordPage() {
  const [formError, setFormError] = useState<string | null>(null);
  const [successSent, setSuccessSent] = useState(false);
  const [captchaToken, setCaptchaToken] = useState('');
  const [captchaAnswer, setCaptchaAnswer] = useState('');
  const [captchaError, setCaptchaError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof forgotSchema>>({ resolver: zodResolver(forgotSchema) });

  const onSubmit = handleSubmit(async (values) => {
    if (!captchaAnswer) {
      setCaptchaError('Vui lòng nhập mã bảo vệ.');
      return;
    }
    setCaptchaError(null);
    setFormError(null);

    try {
      await api.post('/auth/password/forgot', {
        email: values.email,
        captchaToken,
        captchaAnswer,
      });
      setSuccessSent(true);
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === 'CAPTCHA_INVALID' || error.code === 'CAPTCHA_EXPIRED' || error.code === 'CAPTCHA_REQUIRED') {
          setCaptchaError(error.message);
          return;
        }
        setFormError(error.message);
      } else {
        setFormError('Không thể gửi yêu cầu đặt lại mật khẩu. Vui lòng thử lại sau.');
      }
    }
  });

  return (
    <AuthShell
      title="Quên mật khẩu"
      subtitle="Nhập email tài khoản để nhận liên kết khôi phục mật khẩu"
      icon={Mail}
      footer={
        <Link to="/login" className="font-medium text-[var(--color-primary)] hover:underline">
          Quay lại trang Đăng nhập
        </Link>
      }
    >
      {successSent ? (
        <div className="flex flex-col items-center gap-4 py-4 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10 text-green-600">
            <CheckCircle2 className="h-6 w-6" />
          </div>
          <h3 className="text-base font-semibold text-[var(--color-foreground)]">
            Đã gửi yêu cầu khôi phục!
          </h3>
          <p className="text-sm text-[var(--color-foreground-muted)] max-w-sm">
            Nếu địa chỉ <strong>{getValues('email')}</strong> tồn tại trong hệ thống, chúng tôi đã gửi email hướng dẫn đặt lại mật khẩu. Vui lòng kiểm tra hộp thư đến (và cả mục Spam/Thư rác).
          </p>
          <div className="mt-4">
            <Link to="/login">
              <Button variant="default">Đến trang Đăng nhập</Button>
            </Link>
          </div>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {formError ? (
            <div
              role="alert"
              className="rounded-md border border-[var(--color-destructive)]/30 bg-[color-mix(in_oklch,var(--color-destructive)_6%,transparent)] px-3 py-2 text-sm text-[var(--color-destructive)]"
            >
              {formError}
            </div>
          ) : null}

          <Field
            label="Email tài khoản"
            htmlFor="email"
            error={errors.email?.message}
            hint="Nhập chính xác email bạn đã dùng để đăng ký tài khoản."
            required
          >
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="sinhvien@example.com"
              aria-invalid={Boolean(errors.email)}
              {...register('email')}
            />
          </Field>

          <CaptchaField
            value={captchaAnswer}
            onChange={(answer, token) => {
              setCaptchaAnswer(answer);
              setCaptchaToken(token);
              setCaptchaError(null);
            }}
            error={captchaError ?? undefined}
          />

          <Button type="submit" className="w-full" isLoading={isSubmitting}>
            Gửi email khôi phục
          </Button>
        </form>
      )}
    </AuthShell>
  );
}

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const [formError, setFormError] = useState<string | null>(null);
  const [resetSuccess, setResetSuccess] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof resetSchema>>({ resolver: zodResolver(resetSchema) });

  const onSubmit = handleSubmit(async (values) => {
    if (!token) {
      setFormError('Mã đặt lại mật khẩu không hợp lệ hoặc đã hết hạn.');
      return;
    }
    setFormError(null);

    try {
      await api.post('/auth/password/reset', {
        token,
        password: values.password,
      });
      setResetSuccess(true);
    } catch (error) {
      if (error instanceof ApiError) {
        setFormError(error.message);
      } else {
        setFormError('Không thể đặt lại mật khẩu. Vui lòng thử lại sau.');
      }
    }
  });

  return (
    <AuthShell
      title="Đặt lại mật khẩu mới"
      subtitle="Tạo mật khẩu an toàn mới cho tài khoản của bạn"
      icon={KeyRound}
      footer={
        <Link to="/login" className="font-medium text-[var(--color-primary)] hover:underline">
          Đăng nhập vào tài khoản
        </Link>
      }
    >
      {!token ? (
        <div className="py-4 text-center">
          <p className="text-sm text-[var(--color-destructive)] mb-4">
            Liên kết đổi mật khẩu không hợp lệ hoặc thiếu mã xác thực.
          </p>
          <Link to="/forgot-password">
            <Button variant="outline">Yêu cầu liên kết mới</Button>
          </Link>
        </div>
      ) : resetSuccess ? (
        <div className="flex flex-col items-center gap-4 py-4 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10 text-green-600">
            <CheckCircle2 className="h-6 w-6" />
          </div>
          <h3 className="text-base font-semibold text-[var(--color-foreground)]">
            Đổi mật khẩu thành công!
          </h3>
          <p className="text-sm text-[var(--color-foreground-muted)] max-w-sm">
            Mật khẩu mới đã được cập nhật. Bạn có thể đăng nhập ngay với mật khẩu mới.
          </p>
          <div className="mt-4">
            <Link to="/login">
              <Button variant="default">Đăng nhập ngay</Button>
            </Link>
          </div>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {formError ? (
            <div
              role="alert"
              className="rounded-md border border-[var(--color-destructive)]/30 bg-[color-mix(in_oklch,var(--color-destructive)_6%,transparent)] px-3 py-2 text-sm text-[var(--color-destructive)]"
            >
              {formError}
            </div>
          ) : null}

          <Field
            label="Mật khẩu mới"
            htmlFor="password"
            error={errors.password?.message}
            hint="Ít nhất 10 ký tự."
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
            label="Xác nhận mật khẩu mới"
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
            Lưu mật khẩu mới
          </Button>
        </form>
      )}
    </AuthShell>
  );
}

export function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setError('Mã xác thực không hợp lệ hoặc thiếu.');
      return;
    }
    api
      .post('/auth/email/verify', { token })
      .then(() => {
        setSuccess(true);
      })
      .catch((err) => {
        if (err instanceof ApiError) {
          setError(err.message);
        } else {
          setError('Không thể xác thực email. Liên kết có thể đã hết hạn.');
        }
      })
      .finally(() => {
        setLoading(false);
      });
  }, [token]);

  return (
    <AuthShell
      title="Xác thực Email"
      subtitle="Kích hoạt và xác thực địa chỉ email của bạn"
      icon={CheckCircle2}
      footer={
        <Link to="/login" className="font-medium text-[var(--color-primary)] hover:underline">
          Đăng nhập vào tài khoản
        </Link>
      }
    >
      {loading ? (
        <div className="flex flex-col items-center justify-center py-8 text-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-[var(--color-primary)]" />
          <p className="text-sm text-[var(--color-muted-foreground)]">Đang xác thực email của bạn...</p>
        </div>
      ) : success ? (
        <div className="flex flex-col items-center gap-4 py-4 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10 text-green-600">
            <CheckCircle2 className="h-6 w-6" />
          </div>
          <h3 className="text-base font-semibold text-[var(--color-foreground)]">
            Xác thực email thành công!
          </h3>
          <p className="text-sm text-[var(--color-foreground-muted)] max-w-sm">
            Tài khoản của bạn đã được kích hoạt đầy đủ. Bạn có thể đăng nhập ngay bây giờ.
          </p>
          <div className="mt-4">
            <Link to="/login">
              <Button variant="default">Đăng nhập ngay</Button>
            </Link>
          </div>
        </div>
      ) : (
        <div className="py-4 text-center">
          <p className="text-sm text-[var(--color-destructive)] mb-4">
            {error || 'Xác thực email không thành công.'}
          </p>
          <Link to="/login">
            <Button variant="outline">Về trang đăng nhập</Button>
          </Link>
        </div>
      )}
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

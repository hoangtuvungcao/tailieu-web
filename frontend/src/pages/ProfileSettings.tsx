import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Camera, Loader2, Trash2, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  Avatar,
  Button,
  buttonVariants,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Textarea,
} from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { useAuth, type CurrentUser } from '@/lib/auth';
import {
  useRemoveProfileImage,
  useUpdateProfile,
  useUploadProfileImage,
  type ProfileImageKind,
} from '@/lib/profile-hooks';
import { useSeo } from '@/lib/seo';
import { cn } from '@/lib/utils';

/**
 * Profile settings.
 *
 * Everything here edits the account's *personal* fields. Faculty, program,
 * student code and roles are deliberately absent: those decide what a person
 * may read and which documents they are entitled to, so they are verified by
 * staff rather than self-declared. The server's `updateProfileSchema` is
 * `.strict()` and refuses them outright, so their absence here is not the
 * control — it only avoids offering a field that would be rejected.
 *
 * SAVING. The current user lives in the auth context, not in the React Query
 * cache, so a write cannot invalidate its way to a fresh value. Each mutation
 * returns the updated account and this page hands it straight to `applyUser` —
 * the write is the source, and no second round trip to `/auth/me` is needed.
 * The public profile query *is* a cache entry, so that one is invalidated.
 */

const BIO_MAX = 500;

/** Mirrors the server's limits so the user learns before the upload starts. */
const IMAGE_LIMITS: Record<ProfileImageKind, { bytes: number; label: string }> = {
  avatar: { bytes: 2 * 1024 * 1024, label: '2 MB' },
  cover: { bytes: 5 * 1024 * 1024, label: '5 MB' },
};

const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export function ProfileSettingsPage() {
  const { user, applyUser } = useAuth();
  const queryClient = useQueryClient();

  useSeo({ title: 'Chỉnh sửa hồ sơ — Tài Liệu Sinh Viên', noIndex: true });

  /** One place to record a write's result, so both halves stay in step. */
  const acceptUpdate = (next: CurrentUser) => {
    applyUser(next);
    // The public profile is a cache entry and a different component reads it;
    // without this, visiting your own profile after an edit shows the old name.
    void queryClient.invalidateQueries({ queryKey: ['social', 'profile', next.id] });
  };

  if (!user) {
    // `RequireAuth` gates this route, so this is unreachable in practice. A
    // spinner is still the right answer for the frame before it resolves.
    return (
      <div className="container-page flex min-h-[50vh] items-center justify-center py-10">
        <Loader2 className="h-6 w-6 animate-spin text-[var(--color-muted-foreground)]" aria-hidden />
      </div>
    );
  }

  return (
    <div className="container-page py-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Link
              to={`/users/${user.id}`}
              className="inline-flex items-center gap-1.5 text-sm text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Về hồ sơ của tôi
            </Link>
            <h1 className="mt-1 text-2xl font-bold tracking-tight">Chỉnh sửa hồ sơ</h1>
          </div>
        </div>

        <ProfileImages user={user} onUpdated={acceptUpdate} />
        <ProfileFields user={user} onUpdated={acceptUpdate} />
      </div>
    </div>
  );
}

// =============================================================================
// Images
// =============================================================================

type Account = CurrentUser;

function ProfileImages({ user, onUpdated }: { user: Account; onUpdated: (next: Account) => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Ảnh hồ sơ</CardTitle>
        <CardDescription>
          Ảnh đại diện hiển thị cạnh tên bạn ở mọi nơi. Ảnh bìa là dải phía trên hồ sơ.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* The cover carries the avatar as an overlay, because that is how the
            profile itself renders them — arranging them differently here would
            make this a preview of something the user never sees. */}
        <CoverPicker user={user} onUpdated={onUpdated} />
        <AvatarPicker user={user} onUpdated={onUpdated} />
      </CardContent>
    </Card>
  );
}

function CoverPicker({ user, onUpdated }: { user: Account; onUpdated: (next: Account) => void }) {
  const upload = useUploadProfileImage();
  const remove = useRemoveProfileImage();

  const busy = upload.isPending || remove.isPending;
  const error = upload.error ?? remove.error;

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Ảnh bìa</p>

      <div className="relative">
        <div
          className={cn(
            'relative h-32 w-full overflow-hidden rounded-lg border border-[var(--color-border)] sm:h-40',
            // A gradient rather than a stock photo: an account with no cover
            // should look unfinished-but-intentional, not like someone else's
            // picture was chosen for them.
            !user.coverUrl && 'bg-gradient-to-br from-[var(--color-brand-700)] to-[var(--color-brand-500)]',
          )}
        >
          {user.coverUrl ? (
            <img src={user.coverUrl} alt="" className="h-full w-full object-cover" />
          ) : null}

          {busy ? (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40">
              <Loader2 className="h-6 w-6 animate-spin text-white" aria-hidden />
            </div>
          ) : null}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <ImagePickerButton
            kind="cover"
            disabled={busy}
            onPicked={(file) => upload.mutate({ kind: 'cover', file }, { onSuccess: onUpdated })}
          >
            <Upload className="h-4 w-4" aria-hidden />
            {user.coverUrl ? 'Đổi ảnh bìa' : 'Tải ảnh bìa'}
          </ImagePickerButton>

          {user.coverUrl ? (
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              disabled={busy}
              onClick={() => remove.mutate('cover', { onSuccess: onUpdated })}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
              Gỡ ảnh bìa
            </Button>
          ) : null}
        </div>
      </div>

      <ImageError error={error} />
    </div>
  );
}

function AvatarPicker({ user, onUpdated }: { user: Account; onUpdated: (next: Account) => void }) {
  const upload = useUploadProfileImage();
  const remove = useRemoveProfileImage();

  const busy = upload.isPending || remove.isPending;
  const error = upload.error ?? remove.error;

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Ảnh đại diện</p>

      <div className="flex flex-wrap items-center gap-4">
        <div className="relative">
          <Avatar
            name={user.displayName}
            src={user.avatarUrl}
            // twMerge lets this override the component's own size class, so no
            // new size variant is needed for the one call site that wants one.
            className="h-20 w-20 border-2 border-[var(--color-card)] text-2xl ring-1 ring-[var(--color-border)]"
          />
          {busy ? (
            <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40">
              <Loader2 className="h-5 w-5 animate-spin text-white" aria-hidden />
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          <ImagePickerButton
            kind="avatar"
            disabled={busy}
            onPicked={(file) => upload.mutate({ kind: 'avatar', file }, { onSuccess: onUpdated })}
          >
            <Camera className="h-4 w-4" aria-hidden />
            {user.avatarUrl ? 'Đổi ảnh đại diện' : 'Tải ảnh đại diện'}
          </ImagePickerButton>

          {user.avatarUrl ? (
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              disabled={busy}
              onClick={() => remove.mutate('avatar', { onSuccess: onUpdated })}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
              Gỡ ảnh
            </Button>
          ) : null}
        </div>
      </div>

      <ImageError error={error} />
    </div>
  );
}

/**
 * A button that opens a file picker.
 *
 * The `<input type="file">` is a real input, hidden with `sr-only` rather than
 * `display:none`, and triggered by a `<label>` — which keeps the control
 * reachable by keyboard and announced by a screen reader, neither of which a
 * div-with-onClick would be.
 *
 * Type and size are checked here as well as on the server. Not for security —
 * the server re-checks both, and is the actual control — but because a 40 MB
 * photo sent over a phone connection to be rejected is a minute of the user's
 * life spent for nothing.
 */
function ImagePickerButton({
  kind,
  disabled,
  onPicked,
  children,
}: {
  kind: ProfileImageKind;
  disabled?: boolean;
  onPicked: (file: File) => void;
  children: React.ReactNode;
}) {
  const [localError, setLocalError] = useState<string | null>(null);
  const limit = IMAGE_LIMITS[kind];

  return (
    <>
      <input
        id={`profile-image-${kind}`}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES.join(',')}
        className="sr-only"
        disabled={disabled}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Reset first: without it, picking the same file twice in a row fires
          // no change event the second time and the retry silently does nothing.
          event.target.value = '';
          if (!file) return;

          if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
            setLocalError('Chỉ nhận tệp ảnh PNG, JPEG, WebP hoặc GIF.');
            return;
          }
          if (file.size > limit.bytes) {
            setLocalError(`Ảnh không được vượt quá ${limit.label}.`);
            return;
          }

          setLocalError(null);
          onPicked(file);
        }}
      />
      <label
        htmlFor={`profile-image-${kind}`}
        className={cn(
          buttonVariants({ variant: 'outline', size: 'sm' }),
          // `disabled:` needs the attribute to exist, which a label does not
          // have — so the pending state is spelled out here.
          disabled ? 'pointer-events-none opacity-50' : 'cursor-pointer',
        )}
      >
        {children}
      </label>
      {localError ? (
        <p role="alert" className="w-full text-xs text-[var(--color-destructive)]">
          {localError}
        </p>
      ) : null}
    </>
  );
}

function ImageError({ error }: { error: unknown }) {
  if (!error) return null;

  return (
    <p role="alert" className="text-xs text-[var(--color-destructive)]">
      {error instanceof ApiError ? error.message : 'Không tải được ảnh lên. Vui lòng thử lại.'}
    </p>
  );
}

// =============================================================================
// Text fields
// =============================================================================

function ProfileFields({ user, onUpdated }: { user: Account; onUpdated: (next: Account) => void }) {
  const update = useUpdateProfile();

  const [displayName, setDisplayName] = useState(user.displayName);
  const [fullName, setFullName] = useState(user.fullName ?? '');
  const [username, setUsername] = useState(user.username ?? '');
  const [bio, setBio] = useState(user.bio ?? '');
  const [saved, setSaved] = useState(false);

  const fieldErrors = update.error instanceof ApiError ? update.error.fieldErrors : {};

  // The form is seeded from the account, which can change underneath it — a
  // successful image upload calls `applyUser`, and that produces a new object
  // with the same name. Re-seeding on every identity change would discard what
  // the user has typed, so this only re-seeds when the *fields* differ, which
  // happens after a successful save or a session restore.
  useEffect(() => {
    setDisplayName(user.displayName);
    setFullName(user.fullName ?? '');
    setUsername(user.username ?? '');
    setBio(user.bio ?? '');
  }, [user.displayName, user.fullName, user.username, user.bio]);

  const dirty =
    displayName !== user.displayName ||
    fullName !== (user.fullName ?? '') ||
    username !== (user.username ?? '') ||
    bio !== (user.bio ?? '');

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaved(false);

    update.mutate(
      {
        displayName,
        fullName: fullName.trim() === '' ? null : fullName,
        // An emptied username field means "remove it", which the server reads
        // as null. Sending `''` would fail the pattern.
        username: username.trim() === '' ? null : username,
        bio: bio.trim() === '' ? null : bio,
      },
      {
        onSuccess: (next) => {
          onUpdated(next);
          setSaved(true);
        },
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Thông tin cá nhân</CardTitle>
        <CardDescription>
          Khoa, ngành và mã số sinh viên do nhà trường xác minh nên không sửa được ở đây.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <Field
            label="Tên hiển thị"
            htmlFor="displayName"
            required
            error={fieldErrors.displayName?.[0]}
            hint="Tên mọi người nhìn thấy. Có thể là biệt danh."
          >
            <Input
              id="displayName"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={80}
              autoComplete="nickname"
            />
          </Field>

          <Field
            label="Họ và tên"
            htmlFor="fullName"
            error={fieldErrors.fullName?.[0]}
            hint="Để trống nếu bạn không muốn công khai."
          >
            <Input
              id="fullName"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              maxLength={120}
              autoComplete="name"
            />
          </Field>

          <Field
            label="Tên người dùng"
            htmlFor="username"
            error={fieldErrors.username?.[0]}
            hint="Chỉ chữ thường, số và . _ - (3–30 ký tự). Dùng để mọi người nhắc tới bạn."
          >
            <div className="flex items-center gap-1">
              <span className="text-sm text-[var(--color-muted-foreground)]">@</span>
              <Input
                id="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                maxLength={30}
                autoComplete="username"
                spellCheck={false}
              />
            </div>
          </Field>

          <Field
            label="Giới thiệu"
            htmlFor="bio"
            error={fieldErrors.bio?.[0]}
            hint={`${bio.length}/${BIO_MAX} ký tự`}
          >
            <Textarea
              id="bio"
              value={bio}
              onChange={(event) => setBio(event.target.value)}
              maxLength={BIO_MAX}
              rows={4}
              placeholder="Bạn học ngành gì, quan tâm tới môn nào?"
            />
          </Field>

          {/* Form-level error, for anything the server reports that is not a
              single named field — a rate limit, a network failure. */}
          {update.isError && Object.keys(fieldErrors).length === 0 ? (
            <p role="alert" className="text-sm text-[var(--color-destructive)]">
              {update.error instanceof ApiError
                ? update.error.message
                : 'Không lưu được thay đổi. Vui lòng thử lại.'}
            </p>
          ) : null}

          <div className="flex items-center gap-3">
            <Button type="submit" isLoading={update.isPending} disabled={!dirty}>
              Lưu thay đổi
            </Button>
            {/* Announced rather than only shown: a colour change alone is
                invisible to a screen reader, and this is the only confirmation
                the user gets that the save happened. */}
            {saved && !dirty ? (
              <span role="status" className="text-sm text-[var(--color-success)]">
                Đã lưu.
              </span>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

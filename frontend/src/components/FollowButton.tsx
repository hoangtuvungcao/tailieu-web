import { UserMinus, UserPlus } from 'lucide-react';

import { Button } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { useFollowState, useSetFollow } from '@/lib/social-hooks';
import { cn } from '@/lib/utils';

/**
 * Follow or unfollow an account.
 *
 * The relationship is read from the server rather than passed in as a prop, for
 * the same reason the bookmark button does it: one component then works in a
 * profile header and inside a follower list, and it cannot disagree with the
 * counts beside it.
 *
 * There is no "follows you" badge here on purpose. The API does not expose that
 * direction, and inventing it from the follower list would be a guess about
 * somebody else's data.
 */
export function FollowButton({
  userId,
  className,
}: {
  userId: string;
  className?: string;
}) {
  const { user, isAuthenticated } = useAuth();
  const state = useFollowState(userId);
  const setFollow = useSetFollow();

  // Rendering nothing for your own profile rather than a disabled button: the
  // endpoint refuses a self-follow outright, so the button would only ever
  // produce an error.
  if (user?.id === userId) return null;

  const following = state.data?.isFollowing ?? false;

  return (
    <div className={cn('flex flex-col items-start gap-1', className)}>
      <Button
        variant={following ? 'outline' : 'default'}
        size="sm"
        className="gap-2"
        // Disabled while signed out, with the reason in `title`. The check that
        // matters is server-side either way.
        disabled={!isAuthenticated || setFollow.isPending}
        aria-pressed={following}
        title={isAuthenticated ? undefined : 'Đăng nhập để theo dõi'}
        onClick={() => setFollow.mutate({ userId, following: !following })}
      >
        {following ? (
          <UserMinus className="h-4 w-4" aria-hidden />
        ) : (
          <UserPlus className="h-4 w-4" aria-hidden />
        )}
        {following ? 'Đang theo dõi' : 'Theo dõi'}
      </Button>

      {setFollow.isError ? (
        <p role="alert" className="text-xs text-[var(--color-destructive)]">
          {setFollow.error instanceof ApiError
            ? setFollow.error.message
            : 'Không thực hiện được.'}
        </p>
      ) : null}
    </div>
  );
}

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import {
  api,
  onAuthenticationLost,
  refreshSession,
  setAccessToken,
} from './api-client';

/**
 * Authentication state.
 *
 * The subtle part is the bootstrap. The access token lives in memory, so a page
 * reload loses it — but the refresh token is an httpOnly cookie that survives.
 * So on mount the app calls `/auth/refresh` once to trade the cookie for a new
 * access token.
 *
 * That call is also what makes the app's "am I signed in?" answer correct.
 * Checking for a cookie would not work (it is httpOnly, so unreadable), and
 * assuming signed-out would flash the login screen at every authenticated user
 * on every reload.
 */

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
  fullName: string | null;
  username: string | null;
  bio: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  emailVerified: boolean;
  roles: string[];
  primaryFacultyId: string | null;
  primaryProgramId: string | null;
}

interface AuthContextValue {
  user: CurrentUser | null;
  /** True until the initial session check finishes. */
  isLoading: boolean;
  isAuthenticated: boolean;
  signIn: (
    email: string,
    password: string,
    captcha?: { token: string; answer: string },
  ) => Promise<CurrentUser>;
  signUp: (input: {
    email: string;
    password: string;
    displayName: string;
    facultyId?: string | null;
    programId?: string | null;
    captchaToken?: string;
    captchaAnswer?: string;
  }) => Promise<CurrentUser>;
  signOut: () => Promise<void>;
  signOutEverywhere: () => Promise<void>;
  refreshUser: () => Promise<void>;
  /**
   * Replace the cached account with one a mutation just returned.
   *
   * The current user lives in context, not in the React Query cache, so a
   * profile edit cannot invalidate its way to a fresh value — it would need a
   * second round trip to `/auth/me` to relearn what the write already
   * responded with. This is the seam that lets the write be the source.
   */
  applyUser: (user: CurrentUser) => void;
  /** Convenience for UI gating. Cosmetic only — the server re-checks. */
  hasRole: (role: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Clear state when the API client determines the session is gone — a revoked
  // session, a detected token replay, or a failed refresh. Without this the UI
  // would keep showing a signed-in shell over a dead session.
  useEffect(() => {
    onAuthenticationLost(() => setUser(null));
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // One refresh attempt is the entire bootstrap. Its failure is the normal
      // "not signed in" case, not an error worth surfacing.
      const refreshed = await refreshSession();

      if (cancelled) return;

      if (!refreshed) {
        setIsLoading(false);
        return;
      }

      try {
        const me = await api.get<CurrentUser>('/auth/me');
        if (!cancelled) setUser(me);
      } catch {
        // The cookie was valid but the account is gone or suspended; treat as
        // signed out rather than leaving a half-authenticated state.
        if (!cancelled) {
          setAccessToken(null);
          setUser(null);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(
    async (email: string, password: string, captcha?: { token: string; answer: string }) => {
      const body: Record<string, unknown> = { email, password };
      if (captcha?.token && captcha.token !== 'client_fallback') {
        body.captchaToken = captcha.token;
        body.captchaAnswer = captcha.answer;
      }

      const result = await api.post<{ user: CurrentUser; accessToken: string }>(
        '/auth/login',
        body,
        { skipAuthRetry: true },
      );

      setAccessToken(result.accessToken);
      setUser(result.user);
      return result.user;
    },
    [],
  );

  const signUp = useCallback(
    async (input: {
      email: string;
      password: string;
      displayName: string;
      facultyId?: string | null;
      programId?: string | null;
      captchaToken?: string;
      captchaAnswer?: string;
    }) => {
      const body: Record<string, unknown> = { ...input };
      if (body.captchaToken === 'client_fallback') {
        delete body.captchaToken;
        delete body.captchaAnswer;
      }

      const result = await api.post<{ user: CurrentUser; accessToken: string }>(
        '/auth/register',
        body,
        { skipAuthRetry: true },
      );

      setAccessToken(result.accessToken);
      setUser(result.user);
      return result.user;
    },
    [],
  );

  const signOut = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      // Clear locally even if the request failed. A user who clicked "sign out"
      // on a flaky connection must not remain signed in on that device.
      setAccessToken(null);
      setUser(null);
    }
  }, []);

  const signOutEverywhere = useCallback(async () => {
    try {
      await api.post('/auth/logout-all');
    } finally {
      setAccessToken(null);
      setUser(null);
    }
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      setUser(await api.get<CurrentUser>('/auth/me'));
    } catch {
      setUser(null);
    }
  }, []);

  const hasRole = useCallback(
    (role: string) => user?.roles.includes(role) ?? false,
    [user],
  );

  const applyUser = useCallback((next: CurrentUser) => setUser(next), []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading,
      isAuthenticated: user !== null,
      signIn,
      signUp,
      signOut,
      signOutEverywhere,
      refreshUser,
      applyUser,
      hasRole,
    }),
    [user, isLoading, signIn, signUp, signOut, signOutEverywhere, refreshUser, applyUser, hasRole],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside <AuthProvider>.');
  }
  return context;
}

/**
 * Whether the session bootstrap has finished, one way or the other.
 *
 * A query for a resource that is not public must wait for this before it fires.
 * The access token lives in memory, so a page load starts without one, and a
 * request sent in that window arrives anonymous. The API answers 404 for a
 * resource the caller may not see — deliberately, so a 404 cannot be used to
 * probe what exists — so the client cannot tell "no such document" from "not
 * signed in yet" and does not retry a 4xx. The result is that a shared link to
 * a document that needs an account renders "Không tìm thấy tài liệu" on the
 * first load and works on the next, which is the worst possible shape for a bug.
 *
 * Not `isAuthenticated`: a public document must still load for a visitor who is
 * not signed in. This waits for the *question* to be answerable, not for the
 * answer to be yes.
 */
export function useSessionSettled(): boolean {
  return !useAuth().isLoading;
}

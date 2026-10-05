import { useMutation } from '@tanstack/react-query';

import { api } from './api-client';
import type { CurrentUser } from './auth';

/**
 * Profile mutations.
 *
 * Every one of these returns the updated account and hands it back to the
 * caller, which passes it to `AuthProvider`'s `applyUser`. That is deliberate:
 * the current user is not a React Query cache entry, it is context state, so
 * `invalidateQueries` would do nothing here. Refreshing the session instead
 * would be a round trip to `/auth/me` to learn something the response already
 * said.
 *
 * `useAuth()` exposes `applyUser` for exactly this.
 */

export interface ProfileInput {
  displayName?: string;
  fullName?: string | null;
  bio?: string | null;
  username?: string | null;
}

export function useUpdateProfile() {
  return useMutation({
    mutationFn: (input: ProfileInput) => api.patch<CurrentUser>('/auth/me', input),
  });
}

export type ProfileImageKind = 'avatar' | 'cover';

/**
 * Upload an avatar or cover.
 *
 * Sent as `FormData` rather than base64 in a JSON body. A base64 payload is a
 * third larger, and — more importantly — `FormData` is what lets the browser
 * stream the file and set the multipart boundary itself; hand-rolling a
 * multipart body to keep a JSON content type is how boundary bugs happen.
 */
export function useUploadProfileImage() {
  return useMutation({
    mutationFn: ({ kind, file }: { kind: ProfileImageKind; file: File }) => {
      const form = new FormData();
      // The field name is not read by the route — `request.file()` takes the
      // first file part — but a browser sets a filename from it when the part
      // is built from a File, which is what makes the server's name-based
      // extension fallback work.
      form.append('file', file, file.name);
      return api.post<CurrentUser>(`/auth/me/${kind}`, form);
    },
  });
}

export function useRemoveProfileImage() {
  return useMutation({
    mutationFn: (kind: ProfileImageKind) => api.delete<CurrentUser>(`/auth/me/${kind}`),
  });
}

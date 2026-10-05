import { describe as describeSuite, expect, it } from 'vitest';

import { describe, targetHref } from './Notifications';
import type { Notification } from '@/lib/social-hooks';

/**
 * What a notification row says, and where it goes.
 *
 * Both are small pure functions and both have a plausible wrong answer, which
 * is the reason they are separated out and tested rather than inlined into the
 * component:
 *
 *   - The sentence has to handle a *collapsed* row honestly. "A và 99 người
 *     khác đã thích" is the whole point of aggregation, and an off-by-one there
 *     (saying 100, or omitting the "khác") is the kind of thing nobody notices
 *     in review.
 *   - The link has to be absent when the destination does not exist. A `follow`
 *     points at a user and there is no public profile page yet, so offering a
 *     click would 404 — and a dead link is worse than no link.
 */

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    kind: 'post_like',
    targetType: 'post',
    targetId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    aggregationCount: 1,
    readAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    actorName: 'Nguyễn Văn A',
    actorAvatar: null,
    ...overrides,
  };
}

describeSuite('describe', () => {
  it('names the actor alone when a single event happened', () => {
    expect(describe(notification())).toBe('Nguyễn Văn A đã thích bài viết của bạn');
  });

  it('counts the others, not the total, when a row stands for many events', () => {
    // 100 likes: one actor plus 99 others. Reporting 100 would double-count the
    // named actor, which is exactly the off-by-one worth pinning down.
    expect(describe(notification({ aggregationCount: 100 }))).toBe(
      'Nguyễn Văn A và 99 người khác đã thích bài viết của bạn',
    );
  });

  it('does not add "người khác" for a row of two', () => {
    expect(describe(notification({ aggregationCount: 2 }))).toBe(
      'Nguyễn Văn A và 1 người khác đã thích bài viết của bạn',
    );
  });

  it('describes a reply and a follow distinctly from a like', () => {
    expect(describe(notification({ kind: 'comment_reply' }))).toBe(
      'Nguyễn Văn A đã trả lời bình luận của bạn',
    );
    expect(describe(notification({ kind: 'follow', targetType: 'user' }))).toBe(
      'Nguyễn Văn A đã theo dõi bạn',
    );
  });

  it('distinguishes a document comment from a post comment', () => {
    // These are separate kinds precisely so the sentence can say which. A kind
    // reused across both would read as the wrong one half the time.
    expect(describe(notification({ kind: 'post_comment' }))).toBe(
      'Nguyễn Văn A đã bình luận về bài viết của bạn',
    );
    expect(describe(notification({ kind: 'document_comment' }))).toBe(
      'Nguyễn Văn A đã bình luận về tài liệu của bạn',
    );
  });

  it('uses a whole sentence when there is no actor to name', () => {
    expect(describe(notification({ kind: 'system', actorName: null }))).toBe(
      'Thông báo từ hệ thống.',
    );
    expect(describe(notification({ kind: 'badge_awarded', actorName: null }))).toBe(
      'Bạn vừa nhận được một huy hiệu.',
    );
  });

  it('does not invent a sentence for a kind it does not know', () => {
    // A wrong sentence about why someone was notified is worse than a vague
    // one, so an unrecognised kind falls back rather than guessing.
    const text = describe(notification({ kind: 'something_else', actorName: null }));
    expect(text).toBe('Bạn có một thông báo mới.');
    expect(text).not.toContain('đã thích');
  });
});

describeSuite('targetHref', () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  it('routes each target kind to its own page', () => {
    expect(targetHref(notification({ targetType: 'document', targetId: id }))).toBe(
      `/documents/${id}`,
    );
    expect(targetHref(notification({ targetType: 'post', targetId: id }))).toBe(
      `/community/${id}`,
    );
    expect(targetHref(notification({ targetType: 'collection', targetId: id }))).toBe(
      `/collections/${id}`,
    );
  });

  it('links a follow to the actor’s own profile', () => {
    // This returned null until `/users/:id` existed. Offering the click before
    // the page was real would have 404'd for everyone who took it.
    const follow = notification({ kind: 'follow', targetType: 'user' });
    expect(targetHref(follow)).toBe(`/users/${follow.targetId}`);
  });

  it('offers no link when there is no target at all', () => {
    expect(targetHref(notification({ kind: 'system', targetType: null, targetId: null }))).toBeNull();
  });

  it('offers no link for a target kind it does not recognise', () => {
    // A future server-side kind must not become a link to `/undefined/...`.
    expect(targetHref(notification({ targetType: 'faculty', targetId: id }))).toBeNull();
  });
});

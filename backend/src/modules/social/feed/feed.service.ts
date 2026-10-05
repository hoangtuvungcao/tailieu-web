import * as postsRepo from '../posts/posts.repository.js';
import { toDtos, type PostDto } from '../posts/posts.service.js';
import type { SocialActor } from '../shared/actor.js';
import { anonymousViewer, type Viewer } from '../shared/visibility.js';
import { topTrendingPostIds } from './trending.js';

/**
 * The feed's ranked tabs.
 *
 * Two of them, and neither is a recommender:
 *
 *   `trending` — engagement in the last 24 hours, decayed by age, held in a
 *                Redis sorted set. Falls back to a bounded SQL query.
 *   `for-you`  — a readable three-term heuristic. See `forYouCandidates`.
 *
 * Both reuse the posts module's hydration, so a post rendered here is the same
 * DTO the plain feed renders — same tags, same liked-by-viewer, same
 * permissions block. A second hydration path is a second place for the
 * visibility predicate to be forgotten.
 */

export interface FeedPage {
  posts: PostDto[];
  /**
   * Which ranking actually produced this page.
   *
   * Exposed because "trending" and "the SQL fallback" are different claims
   * about how the list was built, and a caller debugging a surprising order
   * should not have to guess which one ran.
   */
  ranking: 'trending' | 'popular-fallback' | 'heuristic';
}

/**
 * Oversampling factor for the trending ids.
 *
 * The hydrated list can come back shorter than the ids asked for, because
 * anything hidden or deleted since it trended is filtered out by the viewer's
 * own predicate. Asking for three times as many costs one extra range read and
 * usually absorbs that loss.
 */
const TREND_OVERSAMPLE = 3;

export async function trending(limit: number, actor: SocialActor | null): Promise<FeedPage> {
  const viewer: Viewer = actor?.viewer ?? anonymousViewer;

  const ids = await topTrendingPostIds(limit * TREND_OVERSAMPLE);

  if (ids && ids.length > 0) {
    const rows = await postsRepo.findPostsByIds(ids, viewer);
    if (rows.length > 0) {
      return { posts: await toDtos(rows.slice(0, limit), actor), ranking: 'trending' };
    }
  }

  // Redis is down or nothing was engaged with in the window. The fallback is a
  // bounded SQL query rather than an error: trending is an accelerator, and a
  // page that 500s because a cache is empty is a worse outcome than a slightly
  // staler list.
  const rows = await postsRepo.topByHotScore(limit, viewer);
  return { posts: await toDtos(rows, actor), ranking: 'popular-fallback' };
}

export async function forYou(limit: number, actor: SocialActor | null): Promise<FeedPage> {
  const viewer: Viewer = actor?.viewer ?? anonymousViewer;

  // The trend term is a bonus, not a requirement: with Redis down this is an
  // empty list and the other two terms still rank the feed.
  const ids = await topTrendingPostIds(limit * TREND_OVERSAMPLE);
  const rows = await postsRepo.forYouCandidates(viewer, ids ?? [], limit);

  return { posts: await toDtos(rows, actor), ranking: 'heuristic' };
}

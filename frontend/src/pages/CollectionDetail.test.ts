import { describe, expect, it } from 'vitest';

import { parseTargetUrl } from './CollectionDetail';

/**
 * Linking to a collection item.
 *
 * "Add by pasting a link" is the only way in, because a picker needs a search
 * UI that does not exist yet and a fake picker would be worse than none. That
 * makes this parser the entire input surface of the feature, and it must
 * refuse anything it cannot resolve rather than guessing — posting a made-up id
 * would fail server-side with a 404 the user cannot interpret.
 *
 * The case worth the most care is `/collections/` versus `/documents/`: a
 * collection can contain a collection, and a parser that matched the first
 * `/<word>/` it found would file a document link under the wrong type.
 */

const DOC = '11111111-2222-4333-8444-555555555555';
const POST = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const COL = '99999999-8888-4777-8666-555555555555';

describe('parseTargetUrl', () => {
  it('reads a plain path for each of the three kinds', () => {
    expect(parseTargetUrl(`/documents/${DOC}`)).toEqual({ type: 'document', id: DOC });
    expect(parseTargetUrl(`/community/${POST}`)).toEqual({ type: 'post', id: POST });
    expect(parseTargetUrl(`/collections/${COL}`)).toEqual({ type: 'collection', id: COL });
  });

  it('reads a full URL, which is what the address bar produces', () => {
    expect(parseTargetUrl(`https://tailieu.5125121.com/documents/${DOC}`)).toEqual({
      type: 'document',
      id: DOC,
    });
    // The production frontend origin, and http for local development.
    expect(parseTargetUrl(`http://localhost:5173/community/${POST}?ref=feed`)).toEqual({
      type: 'post',
      id: POST,
    });
  });

  it('does not confuse a nested collection with a document', () => {
    // `/collections/` must win over the looser prefix, or a collection saved
    // into a collection would be recorded as a document and never hydrate.
    expect(parseTargetUrl(`https://example.com/collections/${COL}`)).toEqual({
      type: 'collection',
      id: COL,
    });
  });

  it('tolerates surrounding whitespace from a copy-paste', () => {
    expect(parseTargetUrl(`  /documents/${DOC}  `)).toEqual({ type: 'document', id: DOC });
  });

  it('returns null rather than guessing when it cannot resolve a target', () => {
    expect(parseTargetUrl('')).toBeNull();
    expect(parseTargetUrl('   ')).toBeNull();
    // A route that exists but carries no id.
    expect(parseTargetUrl('/documents')).toBeNull();
    expect(parseTargetUrl('/documents/')).toBeNull();
    // A route that is not a collection target at all.
    expect(parseTargetUrl('/admin/users')).toBeNull();
    expect(parseTargetUrl('/collections/mine')).toBeNull();
    // Free text.
    expect(parseTargetUrl('xem cái này đi')).toBeNull();
    // A malformed URL must not throw.
    expect(parseTargetUrl('http://[::1')).toBeNull();
  });

  it('rejects an id that is not a uuid', () => {
    // A slug is not an id, and the API is keyed on uuids — accepting this
    // would produce a request that 422s with an unhelpful message.
    expect(parseTargetUrl('/documents/lap-trinh-c-nang-cao')).toBeNull();
    expect(parseTargetUrl('/documents/12345')).toBeNull();
  });

  it('accepts an uppercase uuid, because uuids are case-insensitive', () => {
    expect(parseTargetUrl(`/documents/${DOC.toUpperCase()}`)).toEqual({
      type: 'document',
      id: DOC.toUpperCase(),
    });
  });
});

// normalizeFacebookPermalink: Graph builds permalink_url from the page id it
// was queried with — for us a New-Pages-Experience alias id — so links come
// back as /{alias-id}/posts/{story} (and legacy permalink.php / photo-viewer
// forms for some post types). Those open as "This isn't available" in the
// Facebook mobile app even when the post is live, so the feed rewrites the
// known-bad shapes to /{vanity-or-true-owner}/posts/{story} and leaves every
// other shape untouched.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/google-business', () => ({ listLocalPosts: jest.fn() }));

const { normalizeFacebookPermalink } = require('../services/social-feed');

const POST_ID = '105084258559617_122093599280012345';

describe('normalizeFacebookPermalink', () => {
  test('rewrites alias-id /{page-id}/posts/{story} onto the vanity handle', () => {
    // The prod case (2026-07-09): Graph permalink_url uses the NPE alias id,
    // which the FB app cannot resolve.
    expect(normalizeFacebookPermalink(
      'https://www.facebook.com/942895248777384/posts/963970846669824',
      '110336442031847_963970846669824',
      'wavespestcontrol'
    )).toBe('https://www.facebook.com/wavespestcontrol/posts/963970846669824');
  });

  test('falls back to the true owner id from the post id when no handle', () => {
    expect(normalizeFacebookPermalink(
      'https://www.facebook.com/942895248777384/posts/963970846669824',
      '110336442031847_963970846669824',
      null
    )).toBe('https://www.facebook.com/110336442031847/posts/963970846669824');
  });

  test('numeric path form still rewrites when the post id is malformed', () => {
    expect(normalizeFacebookPermalink(
      'https://www.facebook.com/942895248777384/posts/963970846669824',
      undefined,
      'wavespestcontrol'
    )).toBe('https://www.facebook.com/wavespestcontrol/posts/963970846669824');
  });

  test('rewrites permalink.php?story_fbid=…&id=… keeping the pfbid story token', () => {
    expect(normalizeFacebookPermalink(
      'https://www.facebook.com/permalink.php?story_fbid=pfbid02AbCdEf&id=105084258559617',
      POST_ID
    )).toBe('https://www.facebook.com/105084258559617/posts/pfbid02AbCdEf');
  });

  test('permalink.php prefers the vanity handle for the owner segment', () => {
    expect(normalizeFacebookPermalink(
      'https://www.facebook.com/permalink.php?story_fbid=pfbid02AbCdEf&id=105084258559617',
      POST_ID,
      'wavespestcontrol'
    )).toBe('https://www.facebook.com/wavespestcontrol/posts/pfbid02AbCdEf');
  });

  test('rewrites photo.php viewer links using the post id', () => {
    expect(normalizeFacebookPermalink(
      'https://www.facebook.com/photo.php?fbid=987654321',
      POST_ID
    )).toBe('https://www.facebook.com/105084258559617/posts/122093599280012345');
  });

  test('rewrites modern /photo/?fbid=… viewer links using the post id', () => {
    expect(normalizeFacebookPermalink(
      'https://www.facebook.com/photo/?fbid=987654321&set=a.123',
      POST_ID
    )).toBe('https://www.facebook.com/105084258559617/posts/122093599280012345');
  });

  test('rewrites album photo permalinks (…/photos/a.…/…) using the post id', () => {
    expect(normalizeFacebookPermalink(
      'https://www.facebook.com/wavespestcontrol/photos/a.113356508048364/122093599280012345/?type=3',
      POST_ID
    )).toBe('https://www.facebook.com/105084258559617/posts/122093599280012345');
  });

  test('leaves canonical /{vanity}/posts/{pfbid} permalinks untouched', () => {
    const canonical = 'https://www.facebook.com/wavespestcontrol/posts/pfbid02AbCdEf';
    expect(normalizeFacebookPermalink(canonical, POST_ID, 'wavespestcontrol')).toBe(canonical);
  });

  test('leaves reel/video permalinks untouched', () => {
    const reel = 'https://www.facebook.com/reel/1234567890/';
    expect(normalizeFacebookPermalink(reel, POST_ID, 'wavespestcontrol')).toBe(reel);
  });

  test('keeps a photo-viewer permalink when the post id is not {page}_{story}', () => {
    const viewer = 'https://www.facebook.com/photo.php?fbid=987654321';
    expect(normalizeFacebookPermalink(viewer, '987654321')).toBe(viewer);
    expect(normalizeFacebookPermalink(viewer, undefined)).toBe(viewer);
  });

  test('keeps permalink.php when params are missing', () => {
    const partial = 'https://www.facebook.com/permalink.php?story_fbid=pfbid02AbCdEf';
    // No id param → cannot trust the URL; only rewrite with full information.
    expect(normalizeFacebookPermalink(partial, POST_ID)).toBe(partial);
  });

  test('returns unparseable values unchanged', () => {
    expect(normalizeFacebookPermalink('not a url', POST_ID)).toBe('not a url');
  });
});

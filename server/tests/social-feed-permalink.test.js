// normalizeFacebookPermalink: Graph hands back permalink_url in legacy forms
// (permalink.php / photo-viewer links) for API-published page posts. Those
// open as "This isn't available" in the Facebook mobile app even when the
// post is live, so the feed rewrites them to the canonical
// /{page}/posts/{post} path form and leaves every other shape untouched.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/google-business', () => ({ listLocalPosts: jest.fn() }));

const { normalizeFacebookPermalink } = require('../services/social-feed');

const POST_ID = '105084258559617_122093599280012345';

describe('normalizeFacebookPermalink', () => {
  test('rewrites permalink.php?story_fbid=…&id=… to the path form', () => {
    expect(normalizeFacebookPermalink(
      'https://www.facebook.com/permalink.php?story_fbid=pfbid02AbCdEf&id=105084258559617',
      POST_ID
    )).toBe('https://www.facebook.com/105084258559617/posts/pfbid02AbCdEf');
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

  test('leaves canonical /{page}/posts/{pfbid} permalinks untouched', () => {
    const canonical = 'https://www.facebook.com/wavespestcontrol/posts/pfbid02AbCdEf';
    expect(normalizeFacebookPermalink(canonical, POST_ID)).toBe(canonical);
  });

  test('leaves reel/video permalinks untouched', () => {
    const reel = 'https://www.facebook.com/reel/1234567890/';
    expect(normalizeFacebookPermalink(reel, POST_ID)).toBe(reel);
  });

  test('keeps a photo-viewer permalink when the post id is not {page}_{story}', () => {
    const viewer = 'https://www.facebook.com/photo.php?fbid=987654321';
    expect(normalizeFacebookPermalink(viewer, '987654321')).toBe(viewer);
    expect(normalizeFacebookPermalink(viewer, undefined)).toBe(viewer);
  });

  test('keeps permalink.php when params are missing', () => {
    const partial = 'https://www.facebook.com/permalink.php?story_fbid=pfbid02AbCdEf';
    // No id param → cannot build the path form from the URL alone.
    expect(normalizeFacebookPermalink(partial, POST_ID)).toBe(partial);
  });

  test('returns unparseable values unchanged', () => {
    expect(normalizeFacebookPermalink('not a url', POST_ID)).toBe('not a url');
  });
});

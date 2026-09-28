/**
 * Licensed identification photos re-hosting (C3 follow-up, Codex P1
 * 2026-09-28). resolveBodyImages/validateBodyImageRefs reject any body
 * image that is not already committed under Astro public/ — a compliant
 * diagnostic draft embedding a remote licensed-catalog URL (per the writer
 * PHOTO SLOTS instruction) would otherwise hard-fail BLOG_BODY_IMAGES_FAILED,
 * and with generation still enabled the shortfall could be filled with AI
 * art instead. rehostLicensedIdentificationPhotos fetches, verifies, and
 * re-hosts each one under the same body-N.webp convention every other body
 * image uses, and resolveBodyImages disables AI generation entirely for a
 * diagnostic draft.
 */

process.env.GATE_BLOG_BODY_IMAGES = 'true';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/content-astro/github-client', () => ({
  createBranch: jest.fn(),
  getFile: jest.fn().mockResolvedValue(null), // nothing committed yet — every body-N name is free
  putFile: jest.fn(),
  createPr: jest.fn(),
  createIssueComment: jest.fn(),
  listDir: jest.fn().mockResolvedValue([]),
}));

const gh = require('../services/content-astro/github-client');
const pub = require('../services/content-astro/astro-publisher');
const {
  rehostLicensedIdentificationPhotos, resolveBodyImages, matchLicensedPhotoLine,
  fetchAndVerifyLicensedPhoto, assertLicensedPhotoUrlAllowed, readCappedResponseBody,
  LICENSED_PHOTO_MAX_BYTES,
} = pub._internals;

const LICENSED_URL = 'https://upload.wikimedia.org/wikipedia/commons/c/ce/Red_Imported_Fire_Ant.jpg';
const LICENSED_ALT = 'Red imported fire ant workers swarming over sandy soil in Florida';

function photoSlotsBrief(overrides = {}) {
  return {
    voice_constraints: {
      photo_slots: [
        {
          slot: 'pest',
          photo: {
            url: LICENSED_URL,
            alt: LICENSED_ALT,
            credit: 'Judy Gallagher',
            license: 'CC BY 2.0',
            license_url: 'https://creativecommons.org/licenses/by/2.0',
            source_page: 'https://commons.wikimedia.org/wiki/File:Red_Imported_Fire_Ant.jpg',
          },
          flagged_for_human: false,
        },
        { slot: 'sign', photo: null, flagged_for_human: true },
        { slot: 'look_alike', photo: null, flagged_for_human: true },
      ],
    },
    ...overrides,
  };
}

// A real, tiny, valid image — compressToWebp uses the real `sharp` library
// and needs decodable bytes, not arbitrary garbage.
async function tinyPngBuffer() {
  const sharp = require('sharp');
  return sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();
}

// A minimal WHATWG ReadableStream-shaped body — fetchAndVerifyLicensedPhoto
// reads via body.getReader() (a manual byte-cap stream read), never
// res.arrayBuffer(), so the mock must support that exact shape.
function streamingBody(buf) {
  let sent = false;
  return {
    getReader: () => ({
      read: async () => {
        if (sent || !buf || !buf.length) { sent = true; return { done: true, value: undefined }; }
        sent = true;
        return { done: false, value: buf };
      },
      cancel: async () => {},
    }),
  };
}
function mockFetchOnce({ ok = true, status = 200, contentType = 'image/jpeg', body, contentLength } = {}) {
  global.fetch = jest.fn().mockResolvedValue({
    ok,
    status,
    headers: {
      get: (h) => {
        if (h === 'content-type') return contentType;
        if (h === 'content-length') return contentLength != null ? String(contentLength) : (body ? String(body.length) : '0');
        return null;
      },
    },
    body: streamingBody(body),
  });
}

describe('rehostLicensedIdentificationPhotos', () => {
  afterEach(() => { delete global.fetch; jest.clearAllMocks(); gh.getFile.mockResolvedValue(null); });

  test('no-op when the brief has no photo_slots', async () => {
    const body = 'Some prose.\n\n![irrelevant](https://example.com/x.jpg)';
    const result = await rehostLicensedIdentificationPhotos({ body, slug: 'fire-ant-id', brief: {}, mdx: true });
    expect(result.body).toBe(body);
    expect(result.files).toEqual([]);
    expect(result.placements).toEqual([]);
  });

  test('re-hosts a licensed photo: fetches, compresses, allocates a body-N.webp name, and strips the remote ref', async () => {
    const png = await tinyPngBuffer();
    mockFetchOnce({ contentType: 'image/jpeg', body: png });
    const body = [
      '<BottomLineBox verdict="Yes." recommendation="Call a pro." />',
      '',
      'Fire ants build sandy mounds.',
      '',
      `![${LICENSED_ALT}](${LICENSED_URL})`,
      '',
      'Photo: [Judy Gallagher](https://commons.wikimedia.org/wiki/File:Red_Imported_Fire_Ant.jpg) ([CC BY 2.0](https://creativecommons.org/licenses/by/2.0))',
    ].join('\n');

    const result = await rehostLicensedIdentificationPhotos({ body, slug: 'fire-ant-id', brief: photoSlotsBrief(), mdx: true });

    // 'manual' (not 'follow'): a redirect must never be transparently
    // chased to an unvalidated host (Codex P1, 4th round).
    expect(global.fetch).toHaveBeenCalledWith(LICENSED_URL, expect.objectContaining({ redirect: 'manual' }));
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('public/images/blog/fire-ant-id/body-1.webp');
    expect(Buffer.isBuffer(result.files[0].buffer)).toBe(true);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({ src: '/images/blog/fire-ant-id/body-1.webp', alt: LICENSED_ALT, licensed: true, sourceUrl: LICENSED_URL });
    expect(result.placements).toHaveLength(1);
    // The remote URL is gone from the stripped body; the attribution prose (a
    // regular line, not the image itself) is untouched.
    expect(result.body).not.toContain(LICENSED_URL);
    expect(result.body).toContain('Photo: [Judy Gallagher]');
  });

  test('rejects a non-image content-type (never silently accepts a bad response as a photo)', async () => {
    mockFetchOnce({ contentType: 'text/html', body: Buffer.from('<html>not an image</html>') });
    const body = `![${LICENSED_ALT}](${LICENSED_URL})`;
    await expect(rehostLicensedIdentificationPhotos({ body, slug: 'fire-ant-id', brief: photoSlotsBrief(), mdx: true }))
      .rejects.toMatchObject({ code: 'BLOG_BODY_IMAGES_FAILED', message: expect.stringContaining('not an image') });
  });

  test('rejects a response over the size cap', async () => {
    mockFetchOnce({ contentType: 'image/jpeg', contentLength: 50 * 1024 * 1024 });
    const body = `![${LICENSED_ALT}](${LICENSED_URL})`;
    await expect(rehostLicensedIdentificationPhotos({ body, slug: 'fire-ant-id', brief: photoSlotsBrief(), mdx: true }))
      .rejects.toMatchObject({ code: 'BLOG_BODY_IMAGES_FAILED', message: expect.stringContaining('cap') });
  });

  test('rejects an HTTP failure from the source', async () => {
    mockFetchOnce({ ok: false, status: 404 });
    const body = `![${LICENSED_ALT}](${LICENSED_URL})`;
    await expect(rehostLicensedIdentificationPhotos({ body, slug: 'fire-ant-id', brief: photoSlotsBrief(), mdx: true }))
      .rejects.toMatchObject({ code: 'BLOG_BODY_IMAGES_FAILED' });
  });

  test('a body image URL that does NOT exactly match a catalog entry is left alone (never re-hosted as if it were licensed)', async () => {
    const body = `![something else](https://example.com/unrelated.jpg)`;
    const result = await rehostLicensedIdentificationPhotos({ body, slug: 'fire-ant-id', brief: photoSlotsBrief(), mdx: true });
    expect(result.body).toBe(body);
    expect(result.files).toEqual([]);
  });

  // Codex P1 (6th round): content-quality-gate's photo_slots_licensed_only
  // (collectBodyImageOccurrences) also approves a raw <img> tag — this pass
  // must re-host that form too, or a gate-approved draft could reach
  // validateBodyImageRefs with an un-rehosted remote URL still in the body.
  test('re-hosts a licensed photo embedded as a raw <img> tag, same as the inline markdown form', async () => {
    const png = await tinyPngBuffer();
    mockFetchOnce({ contentType: 'image/jpeg', body: png });
    const body = [
      '<BottomLineBox verdict="Yes." recommendation="Call a pro." />',
      '',
      'Fire ants build sandy mounds.',
      '',
      `<img src="${LICENSED_URL}" alt="${LICENSED_ALT}">`,
    ].join('\n');
    const result = await rehostLicensedIdentificationPhotos({ body, slug: 'fire-ant-id', brief: photoSlotsBrief(), mdx: true });
    expect(result.files).toHaveLength(1);
    expect(result.images[0]).toMatchObject({ src: '/images/blog/fire-ant-id/body-1.webp', alt: LICENSED_ALT, licensed: true, sourceUrl: LICENSED_URL });
    expect(result.body).not.toContain(LICENSED_URL);
    expect(result.body).not.toContain('<img');
  });

  test('an <img> tag with an unlicensed src is left alone (not silently rewritten, never a false positive)', async () => {
    const body = '<img src="https://example.com/unrelated.jpg" alt="something else">';
    const result = await rehostLicensedIdentificationPhotos({ body, slug: 'fire-ant-id', brief: photoSlotsBrief(), mdx: true });
    expect(result.body).toBe(body);
    expect(result.files).toEqual([]);
  });

  // Reference-style (`![alt][ref]` + a separate `[ref]: url` definition) is
  // a DELIBERATE scope decision, not an oversight: the writer prompt never
  // instructs this form, and validateBodyImageRefs already fails CLOSED on
  // an un-rehosted one (parks for human review — never a silent hotlink).
  test('reference-style images are deliberately left un-rehosted (documented scope decision, not a miss)', async () => {
    const body = `![${LICENSED_ALT}][pic]\n\n[pic]: ${LICENSED_URL}`;
    const result = await rehostLicensedIdentificationPhotos({ body, slug: 'fire-ant-id', brief: photoSlotsBrief(), mdx: true });
    expect(result.body).toBe(body);
    expect(result.files).toEqual([]);
  });
});

describe('matchLicensedPhotoLine', () => {
  test('matches a bare inline markdown image alone on its own line', () => {
    expect(matchLicensedPhotoLine(`![${LICENSED_ALT}](${LICENSED_URL})`)).toEqual({ alt: LICENSED_ALT, url: LICENSED_URL });
  });

  test('matches a raw <img> tag alone on its own line', () => {
    expect(matchLicensedPhotoLine(`<img src="${LICENSED_URL}" alt="${LICENSED_ALT}">`)).toEqual({ alt: LICENSED_ALT, url: LICENSED_URL });
  });

  test('an <img> tag with no src at all does not match', () => {
    expect(matchLicensedPhotoLine('<img alt="no src here">')).toBeNull();
  });

  test('plain prose does not match', () => {
    expect(matchLicensedPhotoLine('Fire ants build sandy mounds.')).toBeNull();
  });

  test('an image NOT alone on its own line does not match (inline within prose)', () => {
    expect(matchLicensedPhotoLine(`See this: ![${LICENSED_ALT}](${LICENSED_URL}) for reference.`)).toBeNull();
  });
});

describe('resolveBodyImages — diagnostic drafts never get AI-generated art', () => {
  afterEach(() => { delete global.fetch; jest.clearAllMocks(); gh.getFile.mockResolvedValue(null); });

  test('a diagnostic draft with a licensed photo publishes it and takes the no-generation path even though BODY_IMAGE_MIN (2) is unmet', async () => {
    const png = await tinyPngBuffer();
    mockFetchOnce({ contentType: 'image/jpeg', body: png });
    const body = [
      '<BottomLineBox verdict="Yes." recommendation="Call a pro." />',
      '',
      'Fire ants build sandy mounds in Florida yards.',
      '',
      `![${LICENSED_ALT}](${LICENSED_URL})`,
      '',
      'Photo: [Judy Gallagher](https://commons.wikimedia.org/wiki/File:Red_Imported_Fire_Ant.jpg) ([CC BY 2.0](https://creativecommons.org/licenses/by/2.0))',
    ].join('\n');

    const result = await resolveBodyImages({
      frontmatter: { post_type: 'diagnostic', title: 'Fire Ant Identification', hero_image: { src: '/images/blog/fire-ant-id/hero.webp' } },
      slug: 'fire-ant-id',
      body,
      existingFile: null,
      brief: photoSlotsBrief(),
      siblings: [],
      mdx: true,
    });

    // The licensed photo shipped, committed as a real body image — and
    // ONLY it: fetch was called exactly once (the licensed fetch), never
    // for AI generation (which hits a completely different, unmocked
    // provider path and would have rejected this test if it ran).
    expect(result.files).toHaveLength(1);
    expect(result.images[0]).toMatchObject({ src: '/images/blog/fire-ant-id/body-1.webp', licensed: true });
    expect(result.body).toContain('/images/blog/fire-ant-id/body-1.webp');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('a diagnostic draft with EVERY slot flagged (no licensed photo at all) publishes with zero body images — never an error, never generated art', async () => {
    const body = [
      '<BottomLineBox verdict="Yes." recommendation="Call a pro." />',
      '',
      'Fire ants build sandy mounds in Florida yards.',
    ].join('\n');
    const brief = {
      voice_constraints: {
        photo_slots: [
          { slot: 'pest', photo: null, flagged_for_human: true },
          { slot: 'sign', photo: null, flagged_for_human: true },
          { slot: 'look_alike', photo: null, flagged_for_human: true },
        ],
      },
    };

    const result = await resolveBodyImages({
      frontmatter: { post_type: 'diagnostic', title: 'Fire Ant Identification', hero_image: { src: '/images/blog/fire-ant-id/hero.webp' } },
      slug: 'fire-ant-id',
      body,
      existingFile: null,
      brief,
      siblings: [],
      mdx: true,
    });

    expect(result.files).toEqual([]);
    expect(result.body).toBe(body);
  });

  test('a NON-diagnostic draft never runs the licensed-photo pass, even carrying a licensed-catalog URL in body', async () => {
    const body = `![${LICENSED_ALT}](${LICENSED_URL})\n\nFire ants build sandy mounds.`;
    // No fetch mocked — resolveBodyImages must never attempt to re-host on
    // a non-diagnostic post_type (isDiagnostic gates the whole pass), so a
    // call here would throw (global.fetch is undefined) if that guard broke.
    // validateBodyImageRefs then correctly rejects the un-rehosted remote
    // ref as "not committed" — the ordinary, pre-existing fail-closed path.
    await expect(resolveBodyImages({
      frontmatter: { post_type: 'supporting-blog', title: 'Fire Ants', hero_image: { src: '/images/blog/some-post/hero.webp' } },
      slug: 'some-post',
      body,
      existingFile: null,
      brief: photoSlotsBrief(),
      siblings: [],
      mdx: true,
    })).rejects.toMatchObject({ code: 'BLOG_BODY_IMAGES_FAILED' });
  });
});

// Codex P1 (3rd round, defense-in-depth): photo.url reaches the fetch call
// from a persisted JSONB field — today always the hardcoded catalog, but
// nothing at the point of the network call previously enforced that.
describe('assertLicensedPhotoUrlAllowed / fetchAndVerifyLicensedPhoto — host allowlist + streaming cap', () => {
  afterEach(() => { delete global.fetch; jest.clearAllMocks(); });

  test('accepts a real upload.wikimedia.org URL', () => {
    expect(() => assertLicensedPhotoUrlAllowed(LICENSED_URL, 'fire-ant-id')).not.toThrow();
  });

  test('rejects a URL on a host outside the allowlist (SSRF guard)', () => {
    expect(() => assertLicensedPhotoUrlAllowed('https://attacker.example.com/x.jpg', 'fire-ant-id'))
      .toThrow(/not on the licensed-photo host allowlist/);
  });

  test('rejects an internal/private-network host even if it were somehow reached', () => {
    expect(() => assertLicensedPhotoUrlAllowed('https://169.254.169.254/latest/meta-data/', 'fire-ant-id'))
      .toThrow(/not on the licensed-photo host allowlist/);
  });

  test('rejects a non-https scheme (file://, http://, etc.) even on an otherwise-trusted-looking host', () => {
    expect(() => assertLicensedPhotoUrlAllowed('file:///etc/passwd', 'fire-ant-id')).toThrow(/disallowed scheme/);
    expect(() => assertLicensedPhotoUrlAllowed('http://upload.wikimedia.org/x.jpg', 'fire-ant-id')).toThrow(/disallowed scheme/);
  });

  test('rejects an unparseable URL', () => {
    expect(() => assertLicensedPhotoUrlAllowed('not a url at all', 'fire-ant-id')).toThrow(/not a valid URL/);
  });

  test('fetchAndVerifyLicensedPhoto never calls fetch() at all for an off-allowlist URL (the check runs BEFORE the network call)', async () => {
    global.fetch = jest.fn();
    await expect(fetchAndVerifyLicensedPhoto('https://attacker.example.com/x.jpg', 'fire-ant-id')).rejects.toMatchObject({ code: 'BLOG_BODY_IMAGES_FAILED' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('readCappedResponseBody aborts (cancels the stream) once the byte cap is crossed, even with NO/absent content-length', async () => {
    // Two chunks that together exceed a tiny cap, streamed with no
    // content-length header at all — the pre-fetch declared-length check
    // cannot catch this; only the streaming read can.
    const chunkA = Buffer.alloc(5, 1);
    const chunkB = Buffer.alloc(5, 2);
    let chunkIndex = 0;
    const cancel = jest.fn(async () => {});
    const res = {
      body: {
        getReader: () => ({
          read: async () => {
            const chunks = [chunkA, chunkB];
            if (chunkIndex >= chunks.length) return { done: true, value: undefined };
            const value = chunks[chunkIndex];
            chunkIndex += 1;
            return { done: false, value };
          },
          cancel,
        }),
      },
    };
    await expect(readCappedResponseBody(res, 6, 'fire-ant-id', 'https://upload.wikimedia.org/x.jpg'))
      .rejects.toMatchObject({ code: 'BLOG_BODY_IMAGES_FAILED' });
    expect(cancel).toHaveBeenCalled();
  });

  test('readCappedResponseBody returns the full buffer when under the cap', async () => {
    const chunk = Buffer.from('hello');
    let sent = false;
    const res = { body: { getReader: () => ({ read: async () => { if (sent) return { done: true, value: undefined }; sent = true; return { done: false, value: chunk }; }, cancel: async () => {} }) } };
    const out = await readCappedResponseBody(res, LICENSED_PHOTO_MAX_BYTES, 'fire-ant-id', 'https://upload.wikimedia.org/x.jpg');
    expect(out.toString()).toBe('hello');
  });

  // Codex P1 (4th round): redirect:'follow' would transparently chase a
  // 3xx to an unvalidated host with no re-check — fetchAndVerifyLicensedPhoto
  // must reject any redirect outright instead of following it.
  test('fetchAndVerifyLicensedPhoto rejects a 3xx redirect response instead of following it', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 302, type: 'default', headers: { get: () => null } });
    await expect(fetchAndVerifyLicensedPhoto(LICENSED_URL, 'fire-ant-id')).rejects.toMatchObject({ code: 'BLOG_BODY_IMAGES_FAILED' });
    expect(global.fetch).toHaveBeenCalledWith(LICENSED_URL, expect.objectContaining({ redirect: 'manual' }));
  });

  test('fetchAndVerifyLicensedPhoto rejects an opaqueredirect response', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 0, type: 'opaqueredirect', headers: { get: () => null } });
    await expect(fetchAndVerifyLicensedPhoto(LICENSED_URL, 'fire-ant-id')).rejects.toMatchObject({ code: 'BLOG_BODY_IMAGES_FAILED' });
  });

  // Codex P1 (5th round): every other risk on this fetch was bounded
  // except the request itself — a stalled connection would hang the
  // publish job forever with no timeout.
  test('fetch() is called with an AbortSignal (a bounded timeout, not an unbounded request)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404, headers: { get: () => null } });
    await expect(fetchAndVerifyLicensedPhoto(LICENSED_URL, 'fire-ant-id')).rejects.toMatchObject({ code: 'BLOG_BODY_IMAGES_FAILED' });
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  test('a fetch() rejection from an aborted (timed-out) request fails closed with BLOG_BODY_IMAGES_FAILED, not a raw AbortError', async () => {
    global.fetch = jest.fn().mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    await expect(fetchAndVerifyLicensedPhoto(LICENSED_URL, 'fire-ant-id')).rejects.toMatchObject({ code: 'BLOG_BODY_IMAGES_FAILED' });
  });

  test('a mid-stream abort (reader.read() rejects after headers arrive) also fails closed with BLOG_BODY_IMAGES_FAILED', async () => {
    const res = {
      body: {
        getReader: () => ({
          read: async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); },
          cancel: async () => {},
        }),
      },
    };
    await expect(readCappedResponseBody(res, LICENSED_PHOTO_MAX_BYTES, 'fire-ant-id', LICENSED_URL))
      .rejects.toMatchObject({ code: 'BLOG_BODY_IMAGES_FAILED' });
  });
});

// Codex P1 (r10): on a diagnostic REFRESH draft, the stale managed-image
// strip removes lines from the body. The licensed re-host pass now runs
// AFTER it, so the photo is spliced back at its own position, not one
// shifted by the lines the strip removed.
describe('resolveBodyImages — licensed photo position survives the refresh stale-strip', () => {
  afterEach(() => { delete global.fetch; jest.clearAllMocks(); gh.getFile.mockResolvedValue(null); gh.listDir.mockResolvedValue([]); });

  test('a stale managed image ABOVE the licensed photo does not shift where the photo lands', async () => {
    const png = await tinyPngBuffer();
    mockFetchOnce({ contentType: 'image/jpeg', body: png });
    const body = [
      '<BottomLineBox verdict="Yes." recommendation="Call a pro." />',
      '',
      '## What they look like',
      '',
      'Reddish workers on sandy soil.',
      '',
      '![an old managed picture](/images/blog/fire-ant-id/body-7.webp)',
      '',
      '## Where you find them',
      '',
      'Open, sunny lawns.',
      '',
      `![${LICENSED_ALT}](${LICENSED_URL})`,
      '',
      'Photo credit line.',
    ].join('\n');
    // The LIVE file never carried body-7 under that heading → the refresh
    // stale-strip removes it before the licensed pass runs.
    const existingFile = { path: 'src/content/blog/pest-control/fire-ant-id.mdx', file: { content: '---\ntitle: x\n---\nOld live body with no images.' } };
    const result = await resolveBodyImages({
      frontmatter: { post_type: 'diagnostic', title: 'Fire Ant Identification', hero_image: { src: '/images/blog/fire-ant-id/hero.webp' } },
      slug: 'fire-ant-id', body, existingFile, brief: photoSlotsBrief(), siblings: [], mdx: true,
    });
    expect(result.body).not.toContain('body-7.webp');
    const lines = result.body.split('\n');
    const photoAt = lines.findIndex((l) => l.includes('/images/blog/fire-ant-id/body-1.webp'));
    expect(photoAt).toBeGreaterThan(-1);
    // Lands after "Open, sunny lawns." and before the credit line — its
    // original neighbours — not two lines off.
    const prose = lines.findIndex((l) => l === 'Open, sunny lawns.');
    const credit = lines.findIndex((l) => l === 'Photo credit line.');
    expect(photoAt).toBeGreaterThan(prose);
    expect(photoAt).toBeLessThan(credit);
  });
});

// Codex r2 on #5216 ("Exempt diagnostic posts from the merge-time image
// minimum"): the autonomous poller's merge-time check uses the SAME
// identification predicate as resolveBodyImages, so a diagnostic PR with
// fewer than BODY_IMAGE_MIN licensed photos is not withheld forever.
describe('assertBodyImagesAtHead — diagnostic exemption from the image minimum', () => {
  const { assertBodyImagesAtHead } = pub._internals;
  const FILE = 'src/content/blog/pest-control/fire-ant-id.mdx';
  const post = (postType) => [
    '---',
    'title: Fire Ant Identification',
    `post_type: ${postType}`,
    '---',
    '<BottomLineBox verdict="Yes." recommendation="Call a pro." />',
    '',
    'Fire ants build sandy mounds in Florida yards.',
    '',
  ].join('\n');
  afterEach(() => { gh.getFile.mockReset(); gh.getFile.mockResolvedValue(null); });

  test('a diagnostic post with zero body images passes the merge-time check', async () => {
    gh.getFile.mockImplementation(async (path) => (path === FILE ? { content: post('diagnostic'), sha: 'abc' } : null));
    const r = await assertBodyImagesAtHead({ frontmatter: {}, branch: 'content/x', filePath: FILE });
    expect(r.reason).toBeNull();
    expect(r).toMatchObject({ ok: true });
  });

  test('the same post as a non-diagnostic type is still held to the minimum', async () => {
    gh.getFile.mockImplementation(async (path) => (path === FILE ? { content: post('how-to'), sha: 'abc' } : null));
    const r = await assertBodyImagesAtHead({ frontmatter: {}, branch: 'content/x', filePath: FILE });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/minimum 2/);
  });

  test('publisher and merge-time check share one predicate', () => {
    const { isIdentificationPost } = require('../services/content/licensed-photo-library');
    expect(isIdentificationPost({ post_type: 'diagnostic' })).toBe(true);
    expect(isIdentificationPost({ post_type: ' Diagnostic ' })).toBe(true);
    expect(isIdentificationPost({ post_type: 'how-to' })).toBe(false);
    expect(isIdentificationPost(null)).toBe(false);
  });
});

test('undecodable bytes behind an image content-type fail closed with BLOG_BODY_IMAGES_FAILED', async () => {
  mockFetchOnce({ contentType: 'image/jpeg', body: Buffer.from('definitely not an image') });
  await expect(fetchAndVerifyLicensedPhoto(LICENSED_URL, 'fire-ant-id')).rejects.toMatchObject({ code: 'BLOG_BODY_IMAGES_FAILED' });
  delete global.fetch;
});

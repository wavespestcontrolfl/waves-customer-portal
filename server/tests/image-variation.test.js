/**
 * Image variation plan + text/logo screen (owner direction 2026-09-05: the
 * autopublished pictures all read as the same postcard; three images per
 * post stay, but they must vary in style and setting, carry no invented
 * labels or logos, and only an infographic may carry text — its own captions).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../config/models', () => ({ TEXT_POLICIES: { visionAnalysis: 'visionAnalysis' }, GEMINI_IMAGE_BEST: 'gemini-x', GEMINI_IMAGE_STABLE: 'gemini-y' }));

const { dispatchWithFallback } = require('../services/llm/call');
const gen = require('../services/content/image-generator')._internals;
const { screenGeneratedImage, parseScreen, buildScreenPrompt } = require('../services/content/hero-alt-vision');

const SLUG = 'lawn-care/rain-bird-sprinkler-timer-guide';

describe('planFor — deterministic variation per post and slot', () => {
  test('same slug + slot → same plan; different slots → different plans', () => {
    const a = gen.planFor({ slug: SLUG, mode: 'blog-hero', index: 0 });
    const b = gen.planFor({ slug: SLUG, mode: 'blog-hero', index: 0 });
    const c = gen.planFor({ slug: SLUG, mode: 'blog-body', index: 1 });
    expect(a).toEqual(b);
    expect([a.style, a.setting, a.timeOfDay, a.vantage].join('|')).not.toBe([c.style, c.setting, c.timeOfDay, c.vantage].join('|'));
    for (const p of [a, c]) {
      expect(Object.keys(gen.IMAGE_STYLES)).toContain(p.style);
      expect(p.setting).toBeTruthy(); expect(p.timeOfDay).toBeTruthy(); expect(p.vantage).toBeTruthy();
    }
  });

  test('different posts get different settings across a handful of slugs (no single postcard)', () => {
    const slugs = ['a-post', 'b-post', 'c-post', 'd-post', 'e-post', 'f-post', 'g-post', 'h-post'];
    const settings = new Set(slugs.map((slug) => gen.planFor({ slug, mode: 'blog-hero', index: 0 }).setting));
    const styles = new Set(slugs.map((slug) => gen.planFor({ slug, mode: 'blog-hero', index: 0 }).style));
    expect(settings.size).toBeGreaterThanOrEqual(4);
    expect(styles.size).toBeGreaterThanOrEqual(2);
  });

  test('infographic needs captions — without them it degrades to illustration; a forced style is honored', () => {
    expect(gen.planFor({ slug: SLUG, mode: 'blog-body', index: 3, style: 'infographic' }).style).toBe('illustration');
    expect(gen.planFor({ slug: SLUG, mode: 'blog-body', index: 3, style: 'infographic', captions: ['1 OFF'] }).style).toBe('infographic');
    expect(gen.planFor({ slug: SLUG, mode: 'blog-hero', index: 0, style: 'cartoon' }).style).toBe('cartoon');
  });
});

describe('module surface', () => {
  test('planFor and IMAGE_STYLES are public on the module (the publisher calls them on the default export)', () => {
    const mod = require('../services/content/image-generator');
    expect(typeof mod.planFor).toBe('function');
    expect(mod.IMAGE_STYLES).toBe(gen.IMAGE_STYLES);
    expect(mod.planFor({ slug: 'x', mode: 'blog-hero', index: 0 })).toEqual(gen.planFor({ slug: 'x', mode: 'blog-hero', index: 0 }));
  });
});

describe('buildPrompt with a plan', () => {
  test('names the style, setting, time and vantage; forbids text and logos; carries the brief\'s guards', () => {
    const plan = { style: 'photo', setting: 'inside a residential garage, controller and tools on the wall', timeOfDay: 'late afternoon', vantage: 'over the shoulder' };
    const p = gen.buildPrompt({ title: 'Rain Bird', keyword: 'How to run it by hand', topic: 'Turn the dial.', mode: 'blog-body', shot: 'action', avoid: 'a timer', plan, avoidDepicting: ['irrigation repair scenes'] });
    expect(p).toMatch(/\(photorealistic scene\)/);
    expect(p).toMatch(/inside a residential garage/);
    expect(p).toMatch(/late afternoon/);
    expect(p).toMatch(/Vantage: over the shoulder/);
    expect(p).toMatch(/No text, words, letters, numbers, watermarks, or logos/);
    expect(p).toMatch(/Must not depict: .*no company logos.*; .*no invented control-panel labels.*; irrigation repair scenes\./);
    // The fixed postcard is gone: no "palm trees, tropical landscaping, sunny afternoon" line.
    expect(p).not.toMatch(/palm trees, tropical landscaping, sunny afternoon/);
    expect(p).toMatch(/do not fill the frame with palms and a tile roof/);
  });

  test('infographic style allows exactly the supplied captions and nothing else', () => {
    const plan = { style: 'infographic', setting: 'on a plain background', timeOfDay: 'noon', vantage: 'straight-on, centered' };
    const p = gen.buildPrompt({ title: 'T', keyword: 'Three steps', mode: 'blog-body', plan, captions: ['1 OFF', '2 MANUAL'] });
    expect(p).toMatch(/The ONLY text in the image is exactly: "1 OFF", "2 MANUAL"/);
    expect(p).not.toMatch(/No text, words/);
    expect(p).toMatch(/infographic/i);
  });

  test('cartoon and illustration styles still forbid text; a caption on a non-infographic style is ignored', () => {
    for (const style of ['cartoon', 'illustration']) {
      const p = gen.buildPrompt({ title: 'T', keyword: 'K', mode: 'blog-hero', plan: { style, setting: 's', timeOfDay: 't', vantage: 'v' }, captions: ['SHOULD NOT APPEAR'] });
      expect(p).toMatch(/No text, words, letters, numbers, watermarks, or logos/);
      expect(p).not.toMatch(/SHOULD NOT APPEAR/);
    }
  });

  test('no plan → the legacy prompt shape (callers that pass none keep their old picture)', () => {
    const p = gen.buildPrompt({ title: 'Pest Control Bradenton', city: 'Bradenton', mode: 'blog-hero' });
    expect(p).toMatch(/Bradenton-area home or yard with characteristic SWFL landscaping/);
    expect(p).toMatch(/Must not depict: .*no company logos/);
  });

  test('alt text names the style so it describes the picture that was asked for', () => {
    expect(gen.buildAltText({ title: 'T', keyword: 'K', mode: 'blog-hero', plan: { style: 'cartoon' } })).toMatch(/^Cartoon illustration of /);
    expect(gen.buildAltText({ title: 'T', keyword: 'K', mode: 'blog-hero' })).toMatch(/^Photorealistic scene of /);
  });

  test('the request timeout is long enough for gpt-image-2 (was 60 s: every image fell to gpt-image-1.5)', () => {
    expect(gen.IMAGE_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
  });
});

describe('screenGeneratedImage', () => {
  const buffer = Buffer.from('fake-image');
  beforeEach(() => jest.clearAllMocks());

  test('clean image passes', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, text: '{"readable_text": [], "logos_or_brand_marks": [], "notes": "a hand on a dial"}' });
    const r = await screenGeneratedImage({ buffer });
    expect(r).toMatchObject({ ok: true, checked: true, reasons: [] });
    expect(dispatchWithFallback.mock.calls[0][0]).toBe('visionAnalysis');
    expect(dispatchWithFallback.mock.calls[0][1].images[0].data).toBe(buffer.toString('base64'));
  });

  test('a logo fails; invented labels fail; the infographic\'s own captions are allowed', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, text: '```json\n{"readable_text": ["ORKIN"], "logos_or_brand_marks": ["Orkin logo on truck"], "notes": ""}\n```' });
    expect(await screenGeneratedImage({ buffer })).toMatchObject({ ok: false, reasons: [expect.stringMatching(/logo or brand mark: Orkin/), expect.stringMatching(/readable text: ORKIN/)] });
    dispatchWithFallback.mockResolvedValue({ ok: true, text: '{"readable_text": ["SET TIME", "ZONE 5 RUN"], "logos_or_brand_marks": []}' });
    expect(await screenGeneratedImage({ buffer })).toMatchObject({ ok: false, reasons: [expect.stringMatching(/readable text: SET TIME, ZONE 5 RUN/)] });
    dispatchWithFallback.mockResolvedValue({ ok: true, text: '{"readable_text": ["1 OFF", "2  MANUAL", "3", "OFF"], "logos_or_brand_marks": []}' });
    expect(await screenGeneratedImage({ buffer, allowedText: ['1 OFF', '2 MANUAL', '3 OFF'] })).toMatchObject({ ok: true });
    // Extra words around an allowed caption are stray text, not the caption.
    dispatchWithFallback.mockResolvedValue({ ok: true, text: '{"readable_text": ["1 OFF SALE", "2 MANUAL"], "logos_or_brand_marks": []}' });
    expect(await screenGeneratedImage({ buffer, allowedText: ['1 OFF', '2 MANUAL'] })).toMatchObject({ ok: false, reasons: [expect.stringMatching(/readable text: 1 OFF SALE/)] });
    expect(buildScreenPrompt({ allowedText: ['1 OFF'] })).toMatch(/ALLOWED.*"1 OFF"/);
  });

  test('fails open on a vision miss, unusable output, or a throw', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'no_key' });
    expect(await screenGeneratedImage({ buffer })).toMatchObject({ ok: true, checked: false });
    dispatchWithFallback.mockResolvedValue({ ok: true, text: 'not json' });
    expect(await screenGeneratedImage({ buffer })).toMatchObject({ ok: true, checked: false });
    dispatchWithFallback.mockRejectedValue(new Error('boom'));
    expect(await screenGeneratedImage({ buffer })).toMatchObject({ ok: true, checked: false });
    expect(await screenGeneratedImage({ buffer: null })).toMatchObject({ ok: true, checked: false });
    expect(parseScreen('{"readable_text": "x"}')).toEqual({ readableText: [], logos: [], notes: '' });
  });
});

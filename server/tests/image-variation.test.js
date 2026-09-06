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

  test('infographic needs captions — without them it degrades to the post\'s unused fourth style; a forced style is honored', () => {
    const degraded = gen.planFor({ slug: SLUG, mode: 'blog-body', index: 1, style: 'infographic' }).style;
    expect(degraded).not.toBe('infographic');
    expect(degraded).toBe(gen.stylePermutation(SLUG)[3]);
    expect(gen.planFor({ slug: SLUG, mode: 'blog-body', index: 3, style: 'infographic', captions: ['1 OFF'] }).style).toBe('infographic');
    expect(gen.planFor({ slug: SLUG, mode: 'blog-hero', index: 0, style: 'cartoon' }).style).toBe('cartoon');
  });

  test('hero, body-1 and body-2 never share a style within one post (Codex r1 P2 on #3964)', () => {
    const slugs = Array.from({ length: 40 }, (_, i) => `post-${i}`);
    let photoHeroes = 0;
    for (const slug of slugs) {
      const styles = [
        gen.planFor({ slug, mode: 'blog-hero', index: 0 }).style,
        gen.planFor({ slug, mode: 'blog-body', index: 1, captions: ['Step one'] }).style,
        gen.planFor({ slug, mode: 'blog-body', index: 2, captions: ['Step two'] }).style,
      ];
      expect(new Set(styles).size).toBe(3);
      // Without captions an infographic slot still lands on a style the other two slots do not use.
      const noCaptions = [gen.planFor({ slug, mode: 'blog-hero', index: 0 }).style, gen.planFor({ slug, mode: 'blog-body', index: 1 }).style, gen.planFor({ slug, mode: 'blog-body', index: 2 }).style];
      expect(new Set(noCaptions).size).toBe(3);
      if (styles[0] === 'photo') photoHeroes += 1;
    }
    expect(photoHeroes).toBeGreaterThan(20); // the hero still leans photo for search thumbnails
  });

  test('a screen retry lands on a style no sibling slot uses, or the slot\'s own style under a fresh seed (Codex r2 P2 on #3964)', () => {
    for (let i = 0; i < 40; i += 1) {
      const slug = `post-${i}`;
      const siblings = [0, 1, 2].map((index) => gen.planFor({ slug, mode: index ? 'blog-body' : 'blog-hero', index, captions: index ? ['Step'] : [] }).style);
      for (const index of [0, 1, 2]) {
        const mode = index ? 'blog-body' : 'blog-hero';
        const captions = index ? ['Step'] : [];
        const retry = gen.retryStyleFor({ slug, mode, index, captions });
        const others = siblings.filter((_, k) => k !== index);
        expect(others).not.toContain(retry);
        expect(Object.keys(gen.IMAGE_STYLES)).toContain(retry);
        // A retried slot never lands on infographic without captions.
        if (!captions.length) expect(retry).not.toBe('infographic');
      }
    }
    const mod = require('../services/content/image-generator');
    expect(mod.retryStyleFor).toBe(gen.retryStyleFor);
  });

  test('the setting pool follows the subject: turf posts stay outdoors, equipment posts may use the garage, indoor pests may look out from the kitchen; no setting carries a time of day', () => {
    const all = Object.values(gen.SETTINGS).flat();
    for (const setting of all) expect(setting).not.toMatch(/\b(dusk|dawn|first light|noon|morning|afternoon|golden hour|night|day)\b/i);
    expect(gen.settingsFor('Tropical sod webworm damage in St. Augustine lawns')).toEqual(gen.SETTINGS.yard);
    expect(gen.settingsFor('Ficus whitefly on hedges in Sarasota')).toEqual(gen.SETTINGS.yard);
    // An equipment or indoor subject SELECTS its pool — no outdoor leftovers (Codex r3 P2 on #3964).
    expect(gen.settingsFor('Rain Bird sprinkler timer: run it by hand')).toEqual(gen.SETTINGS.equipment);
    expect(gen.settingsFor('Which Tiny Ant Is in Your Kitchen?')).toEqual(gen.SETTINGS.indoor);
    // A pest noun alone is not an indoor cue, and a lawn/yard cue wins over one (Codex r4 P2 on #3964).
    expect(gen.settingsFor('What Made That Mound? Fire Ants, Pavement Ants, and Mole Crickets Compared mounds in lawn identification')).toEqual(gen.SETTINGS.yard);
    expect(gen.settingsFor('Bed bug bites: what they look like')).toEqual(gen.SETTINGS.indoor);
    expect(gen.settingsFor('Ghost ants: where they come from')).toEqual(gen.SETTINGS.yard);
    expect(gen.settingsFor('Ants in the kitchen after rain')).toEqual(gen.SETTINGS.indoor);
    expect(gen.settingsFor('Ants along the patio and lanai')).toEqual(gen.SETTINGS.yard);
    for (let i = 0; i < 30; i += 1) {
      expect(gen.SETTINGS.indoor).toContain(gen.planFor({ slug: `ant-${i}`, mode: 'blog-hero', index: 0, subject: 'Which Tiny Ant Is in Your Kitchen?' }).setting);
      expect(gen.SETTINGS.equipment).toContain(gen.planFor({ slug: `timer-${i}`, mode: 'blog-body', index: 1, subject: 'Hunter sprinkler timer guide' }).setting);
    }
    for (let i = 0; i < 30; i += 1) {
      const plan = gen.planFor({ slug: `turf-${i}`, mode: 'blog-hero', index: 0, subject: 'Chinch bug damage in a St. Augustine lawn' });
      expect(gen.SETTINGS.yard).toContain(plan.setting);
    }
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
    const plan = gen.planFor({ slug: SLUG, mode: 'blog-body', index: 1, style: 'infographic', captions: ['1 OFF', '2 MANUAL'] });
    const p = gen.buildPrompt({ title: 'T', keyword: 'Three steps', mode: 'blog-body', shot: 'action', plan, captions: ['1 OFF', '2 MANUAL'] });
    expect(p).toMatch(/The ONLY text in the image is exactly: "1 OFF", "2 MANUAL"/);
    expect(p).not.toMatch(/No text, words/);
    expect(p).toMatch(/infographic/i);
  });

  test('an infographic plan is a layout on a plain background — no yard/room setting, time of day, or camera framing (Codex r10 P2 on #3964)', () => {
    for (let i = 0; i < 20; i += 1) {
      const plan = gen.planFor({ slug: `post-${i}`, mode: 'blog-body', index: 1, style: 'infographic', captions: ['Step one'], subject: 'Rain Bird sprinkler timer guide' });
      expect(plan.style).toBe('infographic');
      expect(gen.INFOGRAPHIC_LAYOUTS).toContain(plan.setting);
      expect(Object.values(gen.SETTINGS).flat()).not.toContain(plan.setting);
      expect(plan.timeOfDay).toBe('');
      const p = gen.buildPrompt({ title: 'T', keyword: 'Three steps', topic: 'Turn the dial.', mode: 'blog-body', shot: 'action', avoid: 'a timer', city: 'Venice', plan, captions: ['Step one'] });
      expect(p).toMatch(/Layout: .*on a plain light background/);
      expect(p).not.toMatch(/Setting:|Vantage:|Framing:|Southwest Florida home/);
      // The style and layout never ask for numbers or labels the caption rule forbids (Codex r12 P2).
      expect(p).not.toMatch(/numbered|labeled|legible .*labels/i);
      expect(p).not.toMatch(/\b(early morning|mid-morning|noon|late afternoon|golden hour|dusk)\b/);
      // The alt describes the composition, not a home at a time of day.
      const alt = gen.buildAltText({ title: 'T', keyword: 'Three steps', city: 'Venice', mode: 'blog-body', plan });
      expect(alt).toMatch(/^Infographic illustrating Three steps: /);
      expect(alt).not.toMatch(/Southwest Florida home/);
    }
    // Every other style keeps its scene plan.
    const photo = gen.planFor({ slug: 'post-1', mode: 'blog-hero', index: 0, style: 'photo' });
    expect(Object.values(gen.SETTINGS).flat()).toContain(photo.setting);
    expect(photo.timeOfDay).toBeTruthy();
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

  test('alt text names the style AND the planned setting so it describes the picture that was asked for', () => {
    const plan = { style: 'cartoon', setting: 'inside a residential garage, controller and tools on the wall', timeOfDay: 'dusk', vantage: 'eye level' };
    const alt = gen.buildAltText({ title: 'T', keyword: 'K', city: 'Venice', mode: 'blog-hero', plan });
    expect(alt).toMatch(/^Cartoon illustration of inside a residential garage, dusk, at a Venice-area Southwest Florida home, illustrating K\./);
    expect(alt).not.toMatch(/palm trees/);
    expect(gen.buildAltText({ title: 'T', keyword: 'K', mode: 'blog-hero' })).toMatch(/^Photorealistic scene of a sunny Southwest Florida home with palm trees/);
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
    // The caller's remaining slot time bounds the vision chain; a spent deadline skips the screen (Codex r7 P2 on #3964).
    expect(dispatchWithFallback.mock.calls[0][1].timeoutMs).toBeUndefined();
    await screenGeneratedImage({ buffer, timeoutMs: 42_000 });
    expect(dispatchWithFallback.mock.calls[1][1].timeoutMs).toBe(42_000);
    dispatchWithFallback.mockClear();
    expect(await screenGeneratedImage({ buffer, timeoutMs: 0 })).toMatchObject({ ok: true, checked: false });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('a logo fails; invented labels fail; the infographic\'s own captions are allowed', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, text: '```json\n{"readable_text": ["ORKIN"], "logos_or_brand_marks": ["Orkin logo on truck"], "notes": ""}\n```' });
    expect(await screenGeneratedImage({ buffer })).toMatchObject({ ok: false, reasons: [expect.stringMatching(/logo or brand mark: Orkin/), expect.stringMatching(/readable text: ORKIN/)], violations: 2 });
    dispatchWithFallback.mockResolvedValue({ ok: true, text: '{"readable_text": ["SET TIME", "ZONE 5 RUN"], "logos_or_brand_marks": []}' });
    expect(await screenGeneratedImage({ buffer })).toMatchObject({ ok: false, reasons: [expect.stringMatching(/readable text: SET TIME, ZONE 5 RUN/)] });
    dispatchWithFallback.mockResolvedValue({ ok: true, text: '{"readable_text": ["1 OFF", "2  MANUAL", "3", "OFF"], "logos_or_brand_marks": []}' });
    // An allowed caption the image rendered is not a violation (Codex r11 P2 on #3964).
    expect(await screenGeneratedImage({ buffer, allowedText: ['1 OFF', '2 MANUAL', '3 OFF'] })).toMatchObject({ ok: true, violations: 0 });
    // Extra words around an allowed caption are stray text, not the caption.
    dispatchWithFallback.mockResolvedValue({ ok: true, text: '{"readable_text": ["1 OFF SALE", "2 MANUAL"], "logos_or_brand_marks": []}' });
    expect(await screenGeneratedImage({ buffer, allowedText: ['1 OFF', '2 MANUAL'] })).toMatchObject({ ok: false, reasons: expect.arrayContaining([expect.stringMatching(/readable text: 1 OFF SALE/), expect.stringMatching(/missing caption: "1 OFF"/)]), violations: 2 });
    // A reordered caption is stray text; a partial one is an incomplete caption (Codex r1 P2 on #3964).
    dispatchWithFallback.mockResolvedValue({ ok: true, text: '{"readable_text": ["Ants Stop How To"], "logos_or_brand_marks": []}' });
    expect(await screenGeneratedImage({ buffer, allowedText: ['How to Stop Ants'] })).toMatchObject({ ok: false, reasons: expect.arrayContaining([expect.stringMatching(/readable text: Ants Stop How To/)]) });
    dispatchWithFallback.mockResolvedValue({ ok: true, text: '{"readable_text": ["Ants"], "logos_or_brand_marks": []}' });
    expect(await screenGeneratedImage({ buffer, allowedText: ['How to Stop Ants'] })).toMatchObject({ ok: false, reasons: [expect.stringMatching(/incomplete caption: "How to Stop Ants"/)] });
    // No caption read back at all is a missing caption (Codex r3 P2 on #3964).
    dispatchWithFallback.mockResolvedValue({ ok: true, text: '{"readable_text": [], "logos_or_brand_marks": []}' });
    expect(await screenGeneratedImage({ buffer, allowedText: ['How to Stop Ants'] })).toMatchObject({ ok: false, reasons: [expect.stringMatching(/missing caption: "How to Stop Ants"/)] });
    // Fragments out of reading order do not reconstruct the caption (Codex r4 P2 on #3964).
    dispatchWithFallback.mockResolvedValue({ ok: true, text: '{"readable_text": ["Ants", "How to Stop"], "logos_or_brand_marks": []}' });
    expect(await screenGeneratedImage({ buffer, allowedText: ['How to Stop Ants'] })).toMatchObject({ ok: false });
    // Split fragments that together cover the caption, in order, still pass.
    dispatchWithFallback.mockResolvedValue({ ok: true, text: '{"readable_text": ["How to", "Stop Ants"], "logos_or_brand_marks": []}' });
    expect(await screenGeneratedImage({ buffer, allowedText: ['How to Stop Ants'] })).toMatchObject({ ok: true });
    expect(buildScreenPrompt({ allowedText: ['1 OFF'] })).toMatch(/ALLOWED.*"1 OFF"/);
  });

  test('a brief exclusion the provider ignored fails the screen; only exclusions the caller named count (Codex r8 P2 on #3964)', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, text: '{"readable_text": [], "logos_or_brand_marks": [], "forbidden_scenes": ["irrigation repair scenes", "a made-up item"]}' });
    const r = await screenGeneratedImage({ buffer, avoidDepicting: ['irrigation repair scenes'] });
    expect(r).toMatchObject({ ok: false, forbidden: ['irrigation repair scenes'], reasons: [expect.stringMatching(/forbidden scene: irrigation repair scenes/)] });
    expect(dispatchWithFallback.mock.calls.at(-1)[1].text).toMatch(/FORBIDDEN .*1\. "irrigation repair scenes"/);
    // Without exclusions the field is ignored entirely.
    expect(await screenGeneratedImage({ buffer })).toMatchObject({ ok: true, forbidden: [] });
  });

  test('a detection counts as its exclusion by id, exact text, or paraphrase — never by invention (Codex r12 P2 on #3964)', async () => {
    const avoidDepicting = ['irrigation repair scenes', 'a competitor\'s branded vehicle'];
    const run = async (forbidden) => {
      dispatchWithFallback.mockResolvedValue({ ok: true, text: JSON.stringify({ readable_text: [], logos_or_brand_marks: [], forbidden_scenes: forbidden }) });
      return screenGeneratedImage({ buffer, avoidDepicting });
    };
    expect(await run([2])).toMatchObject({ ok: false, forbidden: ['a competitor\'s branded vehicle'], violations: 1 });
    expect(await run(['an irrigation repair scene'])).toMatchObject({ ok: false, forbidden: ['irrigation repair scenes'] });
    expect(await run(['Irrigation Repair Scenes', 1])).toMatchObject({ ok: false, forbidden: ['irrigation repair scenes'], violations: 1 });
    // A quoted id is the id (Codex r13 P2 on #3964).
    expect(await run(['2', ' 1 '])).toMatchObject({ ok: false, forbidden: ['a competitor\'s branded vehicle', 'irrigation repair scenes'], violations: 2 });
    expect(await run([3, 0, 'a lawn mower', 'repair'])).toMatchObject({ ok: true, forbidden: [] });
  });

  test('with exclusions active, a missing or scalar forbidden_scenes is an unusable answer, not a clean verdict (Codex r9 P2 on #3964)', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, text: '{"readable_text": [], "logos_or_brand_marks": []}' });
    expect(await screenGeneratedImage({ buffer, avoidDepicting: ['irrigation repair scenes'] })).toMatchObject({ ok: true, checked: false });
    dispatchWithFallback.mockResolvedValue({ ok: true, text: '{"readable_text": [], "logos_or_brand_marks": [], "forbidden_scenes": "irrigation repair scenes"}' });
    expect(await screenGeneratedImage({ buffer, avoidDepicting: ['irrigation repair scenes'] })).toMatchObject({ ok: true, checked: false });
    expect(parseScreen('{"readable_text": [], "logos_or_brand_marks": []}', { requireForbidden: true })).toBeNull();
    // The same answer without exclusions is a checked, clean screen.
    expect(await screenGeneratedImage({ buffer, avoidDepicting: [] })).toMatchObject({ ok: true, checked: true });
  });

  test('fails open on a vision miss, unusable output, or a throw', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'no_key' });
    expect(await screenGeneratedImage({ buffer })).toMatchObject({ ok: true, checked: false });
    dispatchWithFallback.mockResolvedValue({ ok: true, text: 'not json' });
    expect(await screenGeneratedImage({ buffer })).toMatchObject({ ok: true, checked: false });
    dispatchWithFallback.mockRejectedValue(new Error('boom'));
    expect(await screenGeneratedImage({ buffer })).toMatchObject({ ok: true, checked: false });
    expect(await screenGeneratedImage({ buffer: null })).toMatchObject({ ok: true, checked: false });
    // A scalar or missing list is an unusable answer, not a clean verdict (Codex r1 P2 on #3964).
    expect(parseScreen('{"readable_text": "x"}')).toBeNull();
    dispatchWithFallback.mockResolvedValue({ ok: true, text: '{"readable_text": "ORKIN", "logos_or_brand_marks": "Orkin logo"}' });
    expect(await screenGeneratedImage({ buffer })).toMatchObject({ ok: true, checked: false });
  });
});

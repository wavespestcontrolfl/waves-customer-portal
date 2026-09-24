jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockDispatch = jest.fn();
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: (...args) => mockDispatch(...args) }));

const MODELS = require('../config/models');
const { describeHeroForAlt, sanitizeAlt } = require('../services/content/hero-alt-vision');

const PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('describeHeroForAlt', () => {
  const OLD_KEY = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterAll(() => {
    if (OLD_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = OLD_KEY;
  });

  test('returns the sanitized vision description on the happy path', async () => {
    mockDispatch.mockResolvedValue({ ok: true, text: 'Large black-and-yellow orb weaver spider on its web outside a Florida home' });

    const alt = await describeHeroForAlt({
      buffer: PNG_BUFFER,
      title: 'Colorful Spiders in Southwest Florida',
      keyword: 'color spiders',
    });

    expect(alt).toBe('Large black-and-yellow orb weaver spider on its web outside a Florida home');
    const [policy, payload] = mockDispatch.mock.calls[0];
    expect(policy).toBe(MODELS.TEXT_POLICIES.visionAnalysis);
    expect(payload.images).toEqual([{ data: PNG_BUFFER.toString('base64'), mimeType: 'image/webp' }]);
    expect(payload.jsonMode).toBe(false);
    expect(payload.text).toContain('Colorful Spiders in Southwest Florida');
  });

  test('forwards the caller\'s remaining slot time; a spent deadline keeps the writer alt without a call (Codex r9 P2 on #3964)', async () => {
    mockDispatch.mockResolvedValue({ ok: true, text: 'A sprinkler head watering a Bradenton lawn' });
    await describeHeroForAlt({ buffer: PNG_BUFFER, title: 'T', timeoutMs: 42_000 });
    expect(mockDispatch.mock.calls[0][1].timeoutMs).toBe(42_000);
    await describeHeroForAlt({ buffer: PNG_BUFFER, title: 'T' });
    expect(mockDispatch.mock.calls[1][1]).not.toHaveProperty('timeoutMs');
    mockDispatch.mockClear();
    await expect(describeHeroForAlt({ buffer: PNG_BUFFER, title: 'T', timeoutMs: 0 })).resolves.toBeNull();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('fails open (null) when both providers miss', async () => {
    mockDispatch.mockResolvedValue({ ok: false, reason: 'all_providers_failed' });
    await expect(describeHeroForAlt({ buffer: PNG_BUFFER, title: 'T' })).resolves.toBeNull();
  });

  test('fails open (null) when the dispatcher throws', async () => {
    mockDispatch.mockRejectedValue(new Error('overloaded'));
    await expect(describeHeroForAlt({ buffer: PNG_BUFFER, title: 'T' })).resolves.toBeNull();
  });

  test('fails open (null) on unusable output instead of stamping junk', async () => {
    mockDispatch.mockResolvedValue({ ok: true, text: 'A bug.' }); // too short
    await expect(describeHeroForAlt({ buffer: PNG_BUFFER, title: 'T' })).resolves.toBeNull();
  });

  test('skips the dispatcher entirely without image bytes', async () => {
    await expect(describeHeroForAlt({ buffer: null, title: 'T' })).resolves.toBeNull();
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe('sanitizeAlt', () => {
  test('strips label prefixes, wrapping quotes, fences, and collapses whitespace', () => {
    expect(sanitizeAlt('Alt text: "Green lynx spider resting on a bright  tropical leaf"'))
      .toBe('Green lynx spider resting on a bright tropical leaf');
    expect(sanitizeAlt('```\nWasp nest under the eave of a stucco Florida home\n```'))
      .toBe('Wasp nest under the eave of a stucco Florida home');
  });

  test('rejects too-short, too-long, and non-string output', () => {
    expect(sanitizeAlt('A spider.')).toBeNull();
    expect(sanitizeAlt('x'.repeat(200))).toBeNull();
    expect(sanitizeAlt(undefined)).toBeNull();
  });
});

describe('screenGeneratedImage: uniform logo (owner directive 2026-09-24 — required on cap + right chest per technician, forbidden elsewhere)', () => {
  const { screenGeneratedImage, buildScreenPrompt, _internals } = require('../services/content/hero-alt-vision');
  const answer = (obj) => ({ ok: true, text: JSON.stringify(obj) });
  const tech = (extra = {}) => ({ cap_front_visible: true, chest_visible: true, logo_on: ['cap', 'right chest'], ...extra });
  const branded = (extra = {}) => answer({ readable_text: [], logos_or_brand_marks: [], technicians: [tech()], waves_logo_elsewhere: [], uniform_logo_lettering: [], forbidden_scenes: [], notes: '', ...extra });
  const screen = (extra) => { mockDispatch.mockResolvedValue(branded(extra)); return screenGeneratedImage({ buffer: PNG_BUFFER, allowUniformLogo: true }); };
  beforeEach(() => mockDispatch.mockReset());

  test('the screen prompt asks for per-technician placements and names the exception only when the caller allows it', () => {
    const plain = buildScreenPrompt({});
    expect(plain).not.toMatch(/EXCEPTION|technicians|waves_logo_elsewhere/);
    const p = buildScreenPrompt({ allowUniformLogo: true });
    expect(p).toMatch(/"technicians": \[\{"cap_front_visible": boolean, "chest_visible": boolean, "logo_on": string\[\]\}\], "waves_logo_elsewhere": string\[\], "uniform_logo_lettering": string\[\]/);
    expect(p).toMatch(/one entry PER uniformed technician/);
    expect(p).toMatch(/"right chest" \(the wearer's right side/);
    expect(p).toMatch(/EXCEPTION: that Waves logo on a technician's cap or shirt chest is expected/);
  });

  test('logo on the cap AND right chest, nothing else → clean; placements are reported', async () => {
    const r = await screen();
    expect(r).toMatchObject({ ok: true, checked: true, reasons: [], violations: 0, logos: [], placements: ['cap', 'right chest'] });
    expect(mockDispatch.mock.calls[0][1].text).toMatch(/technicians/);
    // the larger per-technician JSON gets room: a truncated answer would fail OPEN (pre-push P1 on 8860b77737)
    expect(mockDispatch.mock.calls[0][1].maxTokens).toBe(_internals.SCREEN_MAX_TOKENS_WITH_LOGO);
    expect(_internals.SCREEN_MAX_TOKENS_WITH_LOGO).toBeGreaterThanOrEqual(1000);
  });

  test('a technician in frame with the logo missing, on one garment only, or on the LEFT chest fails (Codex r1 P1 on #4761)', async () => {
    expect((await screen({ technicians: [tech({ logo_on: [] })] })).reasons).toEqual(['uniform logo missing on the cap', 'uniform logo missing on the chest']);
    expect((await screen({ technicians: [tech({ logo_on: ['cap'] })] })).reasons).toEqual(['uniform logo missing on the chest']);
    const left = await screen({ technicians: [tech({ logo_on: ['cap', 'left chest'] })] });
    expect(left.ok).toBe(false);
    expect(left.reasons).toEqual(['uniform logo on the left chest, not the right']);
    expect(left.violations).toBe(1);
  });

  test('an EXTRA left-chest logo beside a correct right-chest one still fails (Codex r3 P2 on #4761)', async () => {
    const r = await screen({ technicians: [tech({ logo_on: ['cap', 'right chest', 'left chest'] })] });
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(['uniform logo on the left chest as well as the right']);
    expect(r.logos).toEqual(['Waves logo on the left chest']);
  });

  test('each placement is demanded only for a garment that can be judged on THAT person (pre-push P1 on f3efa39462)', async () => {
    expect((await screen({ technicians: [tech({ chest_visible: false, logo_on: ['cap'] })] })).ok).toBe(true);
    expect((await screen({ technicians: [tech({ cap_front_visible: false, logo_on: ['right chest'] })] })).ok).toBe(true);
    expect((await screen({ technicians: [tech({ chest_visible: false, logo_on: [] })] })).reasons).toEqual(['uniform logo missing on the cap']);
    expect((await screen({ technicians: [] })).ok).toBe(true); // a bait-station close-up: nobody to judge
  });

  test('a partially branded crew fails: one correct technician beside an unbranded one (Codex r3 P2 on #4761)', async () => {
    const r = await screen({ technicians: [tech(), tech({ logo_on: [] })] });
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(['technician 2: uniform logo missing on the cap', 'technician 2: uniform logo missing on the chest']);
  });

  test('the Waves logo anywhere else is a brand-mark violation AND stays in logos for the candidate ranking (Codex r3 P2 on #4761)', async () => {
    const r = await screen({ waves_logo_elsewhere: ['van door'] });
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(['logo or brand mark: Waves logo elsewhere: van door']);
    expect(r.logos).toEqual(['Waves logo elsewhere: van door']);
    expect(r.violations).toBe(1);
    expect(r.placements).toEqual(['cap', 'right chest', 'elsewhere: van door']);
    const onGlove = await screen({ technicians: [tech({ logo_on: ['cap', 'right chest', 'glove'] })] });
    expect(onGlove.reasons).toEqual(['logo or brand mark: Waves logo on glove']);
    expect(onGlove.logos).toEqual(['Waves logo on glove']);
    const listed = await screen({ logos_or_brand_marks: ['Waves logo on the van door'] });
    expect(listed.reasons).toEqual(['logo or brand mark: Waves logo on the van door']);
    expect(listed.logos).toEqual(['Waves logo on the van door']);
  });

  test('a model that still lists the uniform logo under logos_or_brand_marks is not failed for it', async () => {
    const r = await screen({ logos_or_brand_marks: ["Waves logo on the technician's cap", 'Waves logo on shirt chest'] });
    expect(r).toMatchObject({ ok: true, logos: [] });
  });

  test('a WAVES string in readable_text is standalone lettering unless the model ALSO attributed it to the uniform logo (Codex r1 P2 on #4761)', async () => {
    const stray = await screen({ readable_text: ['WAVES'] });
    expect(stray.ok).toBe(false);
    expect(stray.reasons).toEqual(['readable text: WAVES']);
    expect(await screen({ readable_text: ['WAVES', 'LAWN & PEST'], uniform_logo_lettering: ['WAVES', 'LAWN & PEST'] })).toMatchObject({ ok: true, reasons: [] });
    expect((await screen({ readable_text: ['WAVES', 'DANGER'], uniform_logo_lettering: ['WAVES', 'DANGER'] })).reasons).toEqual(['readable text: DANGER']);
    mockDispatch.mockResolvedValue(answer({ readable_text: ['WAVES'], logos_or_brand_marks: [], uniform_logo_lettering: ['WAVES'], forbidden_scenes: [], notes: '' }));
    expect((await screenGeneratedImage({ buffer: PNG_BUFFER })).reasons).toEqual(['readable text: WAVES']);
  });

  test('captions still match inside the allowance (the caption logic is shared)', async () => {
    mockDispatch.mockResolvedValue(branded({ readable_text: ['How to', 'Stop Ants', 'SALE'] }));
    const r = await screenGeneratedImage({ buffer: PNG_BUFFER, allowUniformLogo: true, allowedText: ['How to Stop Ants'] });
    expect(r.reasons).toEqual(['readable text: SALE']);
  });

  test('an answer without the technicians list, the elsewhere list, or a per-technician boolean is unusable → unchecked (fail-open), never clean', async () => {
    mockDispatch.mockResolvedValue(answer({ readable_text: [], logos_or_brand_marks: [], forbidden_scenes: [], notes: '' }));
    expect(await screenGeneratedImage({ buffer: PNG_BUFFER, allowUniformLogo: true })).toMatchObject({ ok: true, checked: false });
    expect(await screen({ technicians: [{ cap_front_visible: true, logo_on: [] }] })).toMatchObject({ ok: true, checked: false });
    expect(await screen({ waves_logo_elsewhere: 'none' })).toMatchObject({ ok: true, checked: false });
    // the same bare answer is a perfectly good verdict without the allowance
    mockDispatch.mockResolvedValue(answer({ readable_text: [], logos_or_brand_marks: [], forbidden_scenes: [], notes: '' }));
    expect(await screenGeneratedImage({ buffer: PNG_BUFFER })).toMatchObject({ ok: true, checked: true });
  });

  test('without the allowance the uniform logo is still a violation (a logo-free generation must not carry one)', async () => {
    mockDispatch.mockResolvedValue(answer({ readable_text: ['WAVES'], logos_or_brand_marks: ['Waves logo on cap'], forbidden_scenes: [], notes: '' }));
    const r = await screenGeneratedImage({ buffer: PNG_BUFFER });
    expect(r.ok).toBe(false);
    expect(r.violations).toBe(2);
    expect(mockDispatch.mock.calls[0][1].text).not.toMatch(/EXCEPTION/);
    expect(mockDispatch.mock.calls[0][1].maxTokens).toBe(_internals.SCREEN_MAX_TOKENS);
  });

  test('helpers: placement classification and the allowlist', () => {
    const { isAllowedUniformLogo, classifyPlacement } = _internals;
    expect(['cap', 'Cap front', 'on the hat'].map(classifyPlacement)).toEqual(['cap', 'cap', 'cap']);
    expect(['right chest', 'chest', 'Left chest', 'glove', 'van door'].map(classifyPlacement)).toEqual(['right chest', 'right chest', 'left chest', 'other', 'other']);
    expect(isAllowedUniformLogo('Waves logo on the cap')).toBe(true);
    expect(isAllowedUniformLogo('Waves badge on the polo chest')).toBe(true);
    expect(isAllowedUniformLogo('Waves logo on the cap and on the van')).toBe(false);
    expect(isAllowedUniformLogo('Orkin logo on shirt')).toBe(false);
    expect(isAllowedUniformLogo('Waves logo')).toBe(false);
    expect(isAllowedUniformLogo("Waves logo on the technician's clipboard")).toBe(false);
    expect(isAllowedUniformLogo('Waves logo on the technician')).toBe(false);
    expect(isAllowedUniformLogo('Waves badge on the uniform')).toBe(false);
    expect(isAllowedUniformLogo('wave pattern on the shirt')).toBe(false);
    expect(isAllowedUniformLogo('Waves logo on the glove and cap')).toBe(false);
    expect(isAllowedUniformLogo('Waves logo on left chest')).toBe(false);
    expect(isAllowedUniformLogo("Waves logo on the technician's left chest")).toBe(false);
  });

  test('a left-chest mark reported only under logos_or_brand_marks is still a violation (Codex r4 P2 on #4761)', async () => {
    const r = await screen({ logos_or_brand_marks: ['Waves logo on left chest'] });
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(['logo or brand mark: Waves logo on left chest']);
    expect(r.logos).toEqual(['Waves logo on left chest']);
  });
});

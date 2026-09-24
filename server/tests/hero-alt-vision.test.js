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

describe('screenGeneratedImage: uniform logo (owner directive 2026-09-24 — required on cap + right chest, forbidden elsewhere)', () => {
  const { screenGeneratedImage, buildScreenPrompt, _internals } = require('../services/content/hero-alt-vision');
  const answer = (obj) => ({ ok: true, text: JSON.stringify(obj) });
  const branded = (extra = {}) => answer({ readable_text: [], logos_or_brand_marks: [], waves_logo_placements: ['cap', 'right chest'], technician_visible: true, forbidden_scenes: [], notes: '', ...extra });
  beforeEach(() => mockDispatch.mockReset());

  test('the screen prompt asks for placements and names the exception only when the caller allows it', () => {
    const plain = buildScreenPrompt({});
    expect(plain).not.toMatch(/EXCEPTION|waves_logo_placements/);
    const p = buildScreenPrompt({ allowUniformLogo: true });
    expect(p).toMatch(/"waves_logo_placements": string\[\], "uniform_logo_lettering": string\[\], "technician_visible": boolean/);
    expect(p).toMatch(/"right chest" \(the wearer's right side/);
    expect(p).toMatch(/EXCEPTION: that Waves logo on a technician's cap or shirt chest is expected/);
  });

  test('logo on the cap AND right chest, nothing else → clean; placements are reported', async () => {
    mockDispatch.mockResolvedValue(branded());
    const r = await screenGeneratedImage({ buffer: PNG_BUFFER, allowUniformLogo: true });
    expect(r).toMatchObject({ ok: true, checked: true, reasons: [], violations: 0, placements: ['cap', 'right chest'] });
    expect(mockDispatch.mock.calls[0][1].text).toMatch(/waves_logo_placements/);
  });

  test('a technician in frame with the logo missing, on one garment only, or on the LEFT chest fails (Codex r1 P1 on #4761)', async () => {
    mockDispatch.mockResolvedValue(branded({ waves_logo_placements: [] }));
    expect((await screenGeneratedImage({ buffer: PNG_BUFFER, allowUniformLogo: true })).reasons).toEqual(['uniform logo missing on the cap', 'uniform logo missing on the chest']);
    mockDispatch.mockResolvedValue(branded({ waves_logo_placements: ['cap'] }));
    expect((await screenGeneratedImage({ buffer: PNG_BUFFER, allowUniformLogo: true })).reasons).toEqual(['uniform logo missing on the chest']);
    mockDispatch.mockResolvedValue(branded({ waves_logo_placements: ['cap', 'left chest'] }));
    const left = await screenGeneratedImage({ buffer: PNG_BUFFER, allowUniformLogo: true });
    expect(left.ok).toBe(false);
    expect(left.reasons).toEqual(['uniform logo on the left chest, not the right']);
    expect(left.violations).toBe(1);
  });

  test('no technician garment to judge → no placement demand (a close-up of a bait station is fine)', async () => {
    mockDispatch.mockResolvedValue(branded({ waves_logo_placements: [], technician_visible: false }));
    expect((await screenGeneratedImage({ buffer: PNG_BUFFER, allowUniformLogo: true })).ok).toBe(true);
  });

  test('the Waves logo anywhere else is still a brand-mark violation, even beside a correct uniform', async () => {
    mockDispatch.mockResolvedValue(branded({ waves_logo_placements: ['cap', 'right chest', 'elsewhere: van door'] }));
    const r = await screenGeneratedImage({ buffer: PNG_BUFFER, allowUniformLogo: true });
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(['logo or brand mark: Waves logo elsewhere: van door']);
    mockDispatch.mockResolvedValue(branded({ logos_or_brand_marks: ['Waves logo on the van door'] }));
    expect((await screenGeneratedImage({ buffer: PNG_BUFFER, allowUniformLogo: true })).reasons).toEqual(['logo or brand mark: Waves logo on the van door']);
  });

  test('a model that still lists the uniform logo under logos_or_brand_marks is not failed for it', async () => {
    mockDispatch.mockResolvedValue(branded({ logos_or_brand_marks: ["Waves logo on the technician's cap", 'Waves logo on shirt chest'] }));
    const r = await screenGeneratedImage({ buffer: PNG_BUFFER, allowUniformLogo: true });
    expect(r.ok).toBe(true);
    expect(r.logos).toEqual([]);
  });

  test('a WAVES string in readable_text is standalone lettering unless the model ALSO attributed it to the uniform logo (Codex r1 P2 on #4761)', async () => {
    mockDispatch.mockResolvedValue(branded({ readable_text: ['WAVES'] }));
    const stray = await screenGeneratedImage({ buffer: PNG_BUFFER, allowUniformLogo: true });
    expect(stray.ok).toBe(false);
    expect(stray.reasons).toEqual(['readable text: WAVES']);
    // the badge's own lettering, attributed by the model → not stray
    mockDispatch.mockResolvedValue(branded({ readable_text: ['WAVES', 'LAWN & PEST'], uniform_logo_lettering: ['WAVES', 'LAWN & PEST'] }));
    const attributed = await screenGeneratedImage({ buffer: PNG_BUFFER, allowUniformLogo: true });
    expect(attributed).toMatchObject({ ok: true, reasons: [] });
    // attribution cannot launder other text, and only the logo's own words qualify
    mockDispatch.mockResolvedValue(branded({ readable_text: ['WAVES', 'DANGER'], uniform_logo_lettering: ['WAVES', 'DANGER'] }));
    expect((await screenGeneratedImage({ buffer: PNG_BUFFER, allowUniformLogo: true })).reasons).toEqual(['readable text: DANGER']);
    // a second, un-attributed WAVES elsewhere still fails without the allowance
    mockDispatch.mockResolvedValue(answer({ readable_text: ['WAVES'], logos_or_brand_marks: [], uniform_logo_lettering: ['WAVES'], forbidden_scenes: [], notes: '' }));
    expect((await screenGeneratedImage({ buffer: PNG_BUFFER })).reasons).toEqual(['readable text: WAVES']);
  });

  test('an answer without the placement list or technician_visible is unusable → unchecked (fail-open), never clean', async () => {
    mockDispatch.mockResolvedValue(answer({ readable_text: [], logos_or_brand_marks: [], forbidden_scenes: [], notes: '' }));
    const r = await screenGeneratedImage({ buffer: PNG_BUFFER, allowUniformLogo: true });
    expect(r).toMatchObject({ ok: true, checked: false });
    // the same answer is a perfectly good verdict without the allowance
    const plain = await screenGeneratedImage({ buffer: PNG_BUFFER });
    expect(plain).toMatchObject({ ok: true, checked: true });
  });

  test('without the allowance the uniform logo is still a violation (a logo-free generation must not carry one)', async () => {
    mockDispatch.mockResolvedValue(answer({ readable_text: ['WAVES'], logos_or_brand_marks: ['Waves logo on cap'], forbidden_scenes: [], notes: '' }));
    const r = await screenGeneratedImage({ buffer: PNG_BUFFER });
    expect(r.ok).toBe(false);
    expect(r.violations).toBe(2);
    expect(mockDispatch.mock.calls[0][1].text).not.toMatch(/EXCEPTION/);
  });

  test('helpers: placement classification and the allowlist', () => {
    const { isAllowedUniformLogo, classifyPlacement } = _internals;
    expect(['cap', 'Cap front', 'on the hat'].map(classifyPlacement)).toEqual(['cap', 'cap', 'cap']);
    expect(['right chest', 'chest', 'Left chest', 'elsewhere: mailbox', 'van door'].map(classifyPlacement)).toEqual(['right chest', 'right chest', 'left chest', 'elsewhere', 'elsewhere']);
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
  });
});

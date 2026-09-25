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
    // explicit cap/chest only: another garment location is a forbidden mark (Codex r5 P2 on #4761)
    expect(isAllowedUniformLogo('Waves logo on shirt sleeve')).toBe(false);
    expect(isAllowedUniformLogo('Waves logo on the back of the polo')).toBe(false);
    expect(isAllowedUniformLogo('Waves logo on the shirt collar')).toBe(false);
    expect(isAllowedUniformLogo('Waves logo on the shirt')).toBe(false);
    expect(isAllowedUniformLogo('Waves logo on the polo')).toBe(false);
    expect(isAllowedUniformLogo('Waves logo on the right chest of the polo')).toBe(true);
    expect(isAllowedUniformLogo("Waves logo on the technician's left chest")).toBe(false);
  });

  test('a left-chest mark reported only under logos_or_brand_marks is still a violation (Codex r4 P2 on #4761)', async () => {
    const r = await screen({ logos_or_brand_marks: ['Waves logo on left chest'] });
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(['logo or brand mark: Waves logo on left chest']);
    expect(r.logos).toEqual(['Waves logo on left chest']);
  });
});

describe('screenGeneratedImage: van wrap (owner ruling 2026-09-24 — wrap marks/text allowed ON the van only)', () => {
  const { screenGeneratedImage, buildScreenPrompt, _internals } = require('../services/content/hero-alt-vision');
  const answer = (obj) => ({ ok: true, text: JSON.stringify(obj) });
  const WRAP_TEXT = ['WAVES', 'Lawn & Pest', 'Wave Goodbye to Pests!', '941-241-2459', 'GoWavesFL.com'];
  const van = (extra = {}) => ({ body: 'unsure', wrapped: true, wrap_text: WRAP_TEXT, wrap_mascot: true, ...extra });
  const CLEAN_MAIN = { readable_text: [], logos_or_brand_marks: [], forbidden_scenes: [], notes: '' };
  const isVanQuestion = (req) => req.text.startsWith('Inspect ONLY the van');
  // The main screen and the van's own question are two dispatches; answer
  // each by its prompt.
  const mockAnswers = ({ main = CLEAN_MAIN, vanAnswer = { van: van() } } = {}) => {
    mockDispatch.mockImplementation((_policy, req) => Promise.resolve(isVanQuestion(req) ? answer(vanAnswer) : answer(main)));
  };
  const screen = ({ main, vanAnswer, ...opts } = {}) => {
    mockAnswers({ main, vanAnswer });
    return screenGeneratedImage({ buffer: PNG_BUFFER, allowVanWrap: true, ...opts });
  };
  const withVan = (extra) => screen({ vanAnswer: { van: van(extra) } });
  beforeEach(() => mockDispatch.mockReset());

  test('the van is asked about in its own question; the main screen is told to leave that one van out of every field', () => {
    expect(buildScreenPrompt({})).not.toMatch(/VAN EXCEPTION/);
    expect(buildScreenPrompt({ allowUniformLogo: true })).not.toMatch(/VAN EXCEPTION/);
    const main = buildScreenPrompt({ allowVanWrap: true });
    expect(main).toMatch(/VAN EXCEPTION \(overrides every field above\): when exactly ONE van in the frame carries the Waves van wrap/);
    expect(main).toMatch(/including its maker's badge, out of every field/);
    expect(main).toMatch(/if two or more vans carry the wrap, list them all/);
    expect(main).not.toMatch(/"van":|van_wrap_elsewhere/);
    const q = _internals.buildVanScreenPrompt();
    expect(q).toMatch(/shape \{"van": \{"body": "ford_transit_medium_roof" \| "other" \| "unsure", "wrapped": boolean, "wrap_text": string\[\], "wrap_mascot": boolean\} \| null\}/);
    expect(q).toMatch(/Transit cues: a short hood, a black hexagon-mesh grille with a Ford oval badge/);
    expect(q).toMatch(/Mercedes Sprinter's long sloped nose/);
    expect(q).toMatch(/not the maker's badge/);
  });

  test('two dispatches in parallel, each with its own budget and the same deadline; without the allowance only the main one', async () => {
    mockAnswers();
    await screenGeneratedImage({ buffer: PNG_BUFFER, allowVanWrap: true, timeoutMs: 5000 });
    expect(mockDispatch).toHaveBeenCalledTimes(2);
    const [mainReq, vanReq] = [mockDispatch.mock.calls.find((c) => !isVanQuestion(c[1]))[1], mockDispatch.mock.calls.find((c) => isVanQuestion(c[1]))[1]];
    expect(mainReq).toMatchObject({ maxTokens: _internals.SCREEN_MAX_TOKENS, timeoutMs: 5000, jsonMode: true });
    expect(vanReq).toMatchObject({ maxTokens: _internals.VAN_SCREEN_MAX_TOKENS, timeoutMs: 5000, jsonMode: true });

    mockDispatch.mockReset();
    mockAnswers();
    await screenGeneratedImage({ buffer: PNG_BUFFER, allowUniformLogo: true, allowVanWrap: true });
    expect(mockDispatch.mock.calls.find((c) => !isVanQuestion(c[1]))[1].maxTokens).toBe(_internals.SCREEN_MAX_TOKENS_WITH_LOGO);

    mockDispatch.mockReset();
    mockAnswers();
    expect(await screenGeneratedImage({ buffer: PNG_BUFFER })).toMatchObject({ ok: true, checked: true });
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch.mock.calls[0][1].text).not.toMatch(/VAN EXCEPTION/);
  });

  test('the wrap on the van, nothing off it, exact wrap strings → clean', async () => {
    expect(await screen()).toMatchObject({ ok: true, checked: true, reasons: [], violations: 0, logos: [] });
  });

  test('garbled or TRUNCATED wrap text on the van fails as gibberish lettering (Codex r1 P2 on #4784)', async () => {
    const garbled = await withVan({ wrap_text: ['WAVES', '941-XX9-ZZ59'] });
    expect(garbled.reasons).toEqual(['garbled van wrap text: 941-XX9-ZZ59']);
    expect(garbled.logos).toEqual(['garbled van wrap text: 941-XX9-ZZ59']);
    const phone = await withVan({ wrap_text: ['WAVES', '941-241'] });
    expect(phone.reasons).toEqual(['garbled van wrap text: 941-241']);
    expect(phone.violations).toBe(1);
    expect((await withVan({ wrap_text: ['GoWavesFL'] })).reasons).toEqual(['garbled van wrap text: GoWavesFL']);
  });

  test('PUNCTUATION-SENSITIVE: the right words with the wrong punctuation fail (Codex r2 P2 on #4785)', async () => {
    for (const bad of ['Lawn Pest', 'Lawn-Pest', 'GoWavesFL-com']) {
      expect((await withVan({ wrap_text: [bad] })).reasons).toEqual([`garbled van wrap text: ${bad}`]);
    }
    expect(await withVan({ wrap_text: ['Lawn & Pest', 'Wave Goodbye to Pests!'] })).toMatchObject({ ok: true });
  });

  test('a split is legitimate ONLY at a canonical whitespace boundary (Codex r3 P2 on #4785)', async () => {
    expect((await withVan({ wrap_text: ['941-241', '2459'] })).reasons).toEqual(['garbled van wrap text: 941-241, 2459']);
    expect((await withVan({ wrap_text: ['941', '241', '2459'] })).ok).toBe(false);
    expect((await withVan({ wrap_text: ['GoWavesFL', 'com'] })).ok).toBe(false);
    expect(await withVan({ wrap_text: ['Lawn &', 'Pest'] })).toMatchObject({ ok: true });
    expect(await withVan({ wrap_text: ['Lawn', '& Pest'] })).toMatchObject({ ok: true });
    expect((await withVan({ wrap_text: ['Lawn', 'Pest'] })).reasons).toEqual(['garbled van wrap text: Lawn & Pest']);
    expect(await withVan({ wrap_text: ['Wave Goodbye', 'to Pests!'] })).toMatchObject({ ok: true });
  });

  test('one entry grouping adjacent wrap strings is valid, with the side panel\'s "Lawn & Pest!" anywhere in it (Codex r8, r9, r12 P2s on #4785)', async () => {
    for (const ok of [['Lawn & Pest!'], ['Lawn &', 'Pest!'], ['WAVES Lawn & Pest'], ['WAVES Lawn & Pest! Wave Goodbye to Pests!']]) {
      expect(await withVan({ wrap_text: ok })).toMatchObject({ ok: true, reasons: [] });
    }
    expect((await withVan({ wrap_text: ['WAVES Lawn Pest'] })).reasons).toEqual(['garbled van wrap text: WAVES Lawn Pest']);
    // The tagline's own "!" belongs to "Pests!" — "Pest!" there is not the wrap.
    expect((await withVan({ wrap_text: ['Wave Goodbye to Pest!'] })).ok).toBe(false);
  });

  test('van body: a Sprinter/other body fails even when correctly wrapped; "unsure" and the Transit pass (Codex r2 P2 on #4785)', async () => {
    const other = await withVan({ body: 'other' });
    expect(other.reasons).toEqual(['van body is not a Ford Transit medium-roof cargo van']);
    expect(other.logos).toEqual(['van body is not a Ford Transit medium-roof cargo van']);
    expect(await withVan({ body: 'unsure' })).toMatchObject({ ok: true, reasons: [] });
    expect(await withVan({ body: 'ford_transit_medium_roof' })).toMatchObject({ ok: true, reasons: [] });
    expect((await withVan({ body: 'other', wrap_mascot: false })).reasons).toEqual(['van body is not a Ford Transit medium-roof cargo van', 'van wrap missing the mascot']);
  });

  test('a van present WITHOUT the wrap fails; no van at all is clean (Codex r1 P2 on #4784)', async () => {
    const plain = await withVan({ body: 'ford_transit_medium_roof', wrapped: false, wrap_text: [], wrap_mascot: false });
    expect(plain.reasons).toEqual(['van present without the wrap']);
    expect(plain.logos).toEqual(['van present without the wrap']);
    expect(await screen({ vanAnswer: { van: null } })).toMatchObject({ ok: true, checked: true, reasons: [] });
  });

  test('a PARTIALLY applied wrap — no mascot — fails whatever text rendered (Codex r1 P2 on #4785)', async () => {
    expect((await withVan({ wrap_mascot: false, wrap_text: [] })).reasons).toEqual(['van wrap missing the mascot']);
    const both = await withVan({ wrap_mascot: false, wrap_text: ['941-XX9-ZZ59'] });
    expect(both.reasons).toEqual(['van wrap missing the mascot', 'garbled van wrap text: 941-XX9-ZZ59']);
    expect(both.violations).toBe(2);
  });

  test('a clearly visible Transit must carry the WAVES lettering; a distant "unsure" van is not held to it (Codex r10 P2 on #4785)', async () => {
    expect((await withVan({ body: 'ford_transit_medium_roof', wrap_text: [] })).reasons).toEqual(['van wrap missing the WAVES lettering']);
    expect(await withVan({ body: 'ford_transit_medium_roof', wrap_text: ['WAVES Lawn & Pest'] })).toMatchObject({ ok: true, reasons: [] });
    expect(await withVan({ body: 'unsure', wrap_text: [] })).toMatchObject({ ok: true, reasons: [] });
  });

  test('the wrap\'s marks OFF the van are ordinary violations to the main screen — no attribution exemption for "Ford", wrap text or Waves marks (Codex r11/r12 P2s on #4785)', async () => {
    const ford = await screen({ main: { ...CLEAN_MAIN, readable_text: ['Ford'] } });
    expect(ford.reasons).toEqual(['readable text: Ford']);
    const url = await screen({ main: { ...CLEAN_MAIN, readable_text: ['GoWavesFL.com'] } });
    expect(url.reasons).toEqual(['readable text: GoWavesFL.com']);
    const second = await screen({ main: { ...CLEAN_MAIN, logos_or_brand_marks: ['Waves wrap on a second van'] } });
    expect(second.reasons).toEqual(['logo or brand mark: Waves wrap on a second van']);
  });

  test('with the uniform logo too: a correctly branded technician beside the wrapped van is clean — the uniform rules are unchanged (Codex r12 P2 on #4785)', async () => {
    const tech = { cap_front_visible: true, chest_visible: true, logo_on: ['cap', 'right chest'] };
    const r = await screen({ allowUniformLogo: true, main: { ...CLEAN_MAIN, technicians: [tech], waves_logo_elsewhere: [], uniform_logo_lettering: [] } });
    expect(r).toMatchObject({ ok: true, checked: true, reasons: [] });
    const elsewhere = await screen({ allowUniformLogo: true, main: { ...CLEAN_MAIN, technicians: [tech], waves_logo_elsewhere: ['a sign on the fence'], uniform_logo_lettering: [] } });
    expect(elsewhere.reasons).toEqual(['logo or brand mark: Waves logo elsewhere: a sign on the fence']);
  });

  test('an unusable van answer — omitted key, malformed or contradictory van — fails the screen OPEN, never clean (Codex r1, r4 P2s on #4785)', async () => {
    for (const vanAnswer of [{}, { van: { wrapped: true } }, { van: van({ body: 'sprinter' }) }, { van: van({ body: undefined }) }, { van: van({ wrap_text: 'WAVES' }) }, { van: 'none' }]) {
      expect(await screen({ vanAnswer })).toMatchObject({ ok: true, checked: false });
    }
  });

  test('either dispatch failing fails the screen open', async () => {
    mockDispatch.mockImplementation((_policy, req) => Promise.resolve(isVanQuestion(req) ? { ok: false, reason: 'timeout' } : answer(CLEAN_MAIN)));
    expect(await screenGeneratedImage({ buffer: PNG_BUFFER, allowVanWrap: true })).toMatchObject({ ok: true, checked: false });
    mockDispatch.mockImplementation((_policy, req) => Promise.resolve(isVanQuestion(req) ? answer({ van: van() }) : { ok: false, reason: 'timeout' }));
    expect(await screenGeneratedImage({ buffer: PNG_BUFFER, allowVanWrap: true })).toMatchObject({ ok: true, checked: false });
  });
});

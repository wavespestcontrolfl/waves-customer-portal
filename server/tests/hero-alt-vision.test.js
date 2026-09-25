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
  // facing 'camera' + chest_badges_x LEFT of placket_x (in picture coordinates)
  // is the wearer's correct RIGHT chest — chestSide() judges it from these two
  // numbers only, never from the logo_on wording itself.
  const tech = (extra = {}) => ({ facing: 'camera', cap_front_visible: true, chest_visible: true, logo_on: ['cap', 'chest'], placket_x: 500, chest_badges_x: [440], ...extra });
  const branded = (extra = {}) => answer({ readable_text: [], logos_or_brand_marks: [], technicians: [tech()], waves_logo_elsewhere: [], uniform_logo_lettering: [], forbidden_scenes: [], notes: '', ...extra });
  const screen = (extra) => { mockDispatch.mockResolvedValue(branded(extra)); return screenGeneratedImage({ buffer: PNG_BUFFER, allowUniformLogo: true }); };
  beforeEach(() => mockDispatch.mockReset());

  test('the screen prompt asks for per-technician placements and names the exception only when the caller allows it', () => {
    const plain = buildScreenPrompt({});
    expect(plain).not.toMatch(/EXCEPTION|technicians|waves_logo_elsewhere/);
    const p = buildScreenPrompt({ allowUniformLogo: true });
    expect(p).toMatch(/"technicians": \[\{"facing": "camera" \| "side" \| "away", "cap_front_visible": boolean, "chest_visible": boolean, "logo_on": string\[\], "placket_x": number \| null, "chest_badges_x": number\[\]\}\], "waves_logo_elsewhere": string\[\], "uniform_logo_lettering": string\[\]/);
    expect(p).toMatch(/one entry PER uniformed technician/);
    expect(p).toMatch(/facing is "camera" when their chest and shoulders face the viewer/);
    expect(p).toMatch(/placket_x is the horizontal position of their shirt's button placket/);
    expect(p).toMatch(/chest_badges_x lists the horizontal position of the CENTER of EACH logo badge on their shirt chest, one number per badge/);
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

  test('a technician in frame with the logo missing, on one garment only, or on the LEFT chest (per the picture-position numbers) fails (Codex r1 P1 on #4761)', async () => {
    expect((await screen({ technicians: [tech({ chest_badges_x: [], logo_on: [] })] })).reasons).toEqual(['uniform logo missing on the cap', 'uniform logo missing on the chest']);
    expect((await screen({ technicians: [tech({ chest_badges_x: [], logo_on: ['cap'] })] })).reasons).toEqual(['uniform logo missing on the chest']);
    // chest_badges_x RIGHT of placket_x (in picture coordinates) is the wearer's LEFT chest.
    const left = await screen({ technicians: [tech({ chest_badges_x: [560] })] });
    expect(left.ok).toBe(false);
    expect(left.reasons).toEqual(['uniform logo on the left chest, not the right']);
    expect(left.violations).toBe(1);
  });

  test('an EXTRA chest badge fails: a wrong-side one beside a correct one, or two anywhere (Codex r3 P2 on #4761; pre-push fallback P1 on 0569ff57cd)', async () => {
    const both = await screen({ technicians: [tech({ chest_badges_x: [440, 560] })] });
    expect(both.reasons).toEqual(['uniform logo on the left chest as well as the right']);
    expect(both.logos).toEqual(['Waves logo on the left chest']);
    expect(both.placements).toEqual(['cap', 'right chest', 'left chest']);
    const twoInProfile = await screen({ technicians: [tech({ facing: 'side', chest_badges_x: [300, 340] })] });
    expect(twoInProfile.reasons).toEqual(['more than one chest badge']);
    expect(twoInProfile.logos).toEqual(['extra Waves chest badge']);
  });

  test('a missing (null or empty) placket or badge position never fakes a side verdict — Number(null) is 0 (pre-push fallback P1 on 199826df78)', async () => {
    for (const extra of [{ placket_x: null, chest_badges_x: [440] }, { placket_x: 500, chest_badges_x: [] }, { placket_x: '', chest_badges_x: [440] }, { placket_x: '500', chest_badges_x: [560] }]) {
      const r = await screen({ technicians: [tech(extra)] });
      expect(r).toMatchObject({ ok: true, checked: true, reasons: [] });
      expect(r.placements).toEqual(['cap', 'chest']);
    }
  });

  test('a side-facing technician with no chest badge is not flagged, and a side-facing badge\'s side is never judged (facing gates the chest requirement and chestSide)', async () => {
    const sideNoBadge = await screen({ technicians: [tech({ facing: 'side', chest_badges_x: [], logo_on: ['cap'] })] });
    expect(sideNoBadge.ok).toBe(true);
    // Numbers that would read as the wrong side facing the camera are never
    // judged in profile — the badge's side is not knowable off-camera.
    const sideBadge = await screen({ technicians: [tech({ facing: 'side', chest_badges_x: [560] })] });
    expect(sideBadge.ok).toBe(true);
    expect(sideBadge.placements).toEqual(['cap', 'chest']);
  });

  test('each placement is demanded only for a garment that can be judged on THAT person (pre-push P1 on f3efa39462)', async () => {
    expect((await screen({ technicians: [tech({ chest_visible: false, chest_badges_x: [], logo_on: ['cap'] })] })).ok).toBe(true);
    expect((await screen({ technicians: [tech({ cap_front_visible: false, logo_on: ['chest'] })] })).ok).toBe(true);
    expect((await screen({ technicians: [tech({ chest_visible: false, chest_badges_x: [], logo_on: [] })] })).reasons).toEqual(['uniform logo missing on the cap']);
    expect((await screen({ technicians: [] })).ok).toBe(true); // a bait-station close-up: nobody to judge
  });

  test('a partially branded crew fails: one correct technician beside an unbranded one (Codex r3 P2 on #4761)', async () => {
    const r = await screen({ technicians: [tech(), tech({ chest_badges_x: [], logo_on: [] })] });
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
    const onGlove = await screen({ technicians: [tech({ logo_on: ['cap', 'chest', 'glove'] })] });
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
    // classifyPlacement is cap | chest | other — which chest side is judged
    // separately, from technicians[]' picture-position numbers (chestSide()).
    expect(['cap', 'Cap front', 'on the hat'].map(classifyPlacement)).toEqual(['cap', 'cap', 'cap']);
    expect(['right chest', 'chest', 'Left chest', 'glove', 'van door'].map(classifyPlacement)).toEqual(['chest', 'chest', 'chest', 'other', 'other']);
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
    // Side is judged only from technicians[]' placket_x/chest_badges_x numbers,
    // never from this free text — "left" alone no longer excludes it
    // (Codex r4 P2 on #4761 excluded it; the 2026-09-25 lab showed the
    // screen's own left/right words were unreliable).
    expect(isAllowedUniformLogo('Waves logo on left chest')).toBe(true);
    // explicit cap/chest only: another garment location is a forbidden mark (Codex r5 P2 on #4761)
    expect(isAllowedUniformLogo('Waves logo on shirt sleeve')).toBe(false);
    expect(isAllowedUniformLogo('Waves logo on the back of the polo')).toBe(false);
    expect(isAllowedUniformLogo('Waves logo on the shirt collar')).toBe(false);
    expect(isAllowedUniformLogo('Waves logo on the shirt')).toBe(false);
    expect(isAllowedUniformLogo('Waves logo on the polo')).toBe(false);
    expect(isAllowedUniformLogo('Waves logo on the right chest of the polo')).toBe(true);
    expect(isAllowedUniformLogo("Waves logo on the technician's left chest")).toBe(true);
  });

  test('a wrong-side badge is caught via technicians[] numbers, never via free-text wording (Codex r4 P2 on #4761, superseded 2026-09-25)', async () => {
    // "left chest" in free text alone is now the allowed uniform logo — the
    // side comes only from the picture-position numbers on technicians[].
    expect((await screen({ logos_or_brand_marks: ['Waves logo on left chest'] }))).toMatchObject({ ok: true, logos: [] });
    const r = await screen({ technicians: [tech({ chest_badges_x: [560] })] });
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(['uniform logo on the left chest, not the right']);
    expect(r.logos).toEqual(['Waves logo on the left chest']);
  });
});

describe('screenGeneratedImage: van wrap (owner ruling 2026-09-24 — wrap marks/text allowed ON the van only)', () => {
  const { screenGeneratedImage, buildScreenPrompt, _internals } = require('../services/content/hero-alt-vision');
  const answer = (obj) => ({ ok: true, text: JSON.stringify(obj) });
  const van = (extra = {}) => ({ body: 'unsure', wrapped: true, wrap_mascot: true, phone_numbers: ['941-241-2459'], web_addresses: ['GoWavesFL.com'], ...extra });
  const CLEAN_MAIN = { readable_text: [], logos_or_brand_marks: [], forbidden_scenes: [], notes: '' };
  const isVanQuestion = (req) => req.text.startsWith('Inspect ONLY the van');
  // The main screen and the van's own question are two dispatches; answer
  // each by its prompt.
  const mockAnswers = ({ main = CLEAN_MAIN, vanAnswer = { van_count: 1, van: van() } } = {}) => {
    mockDispatch.mockImplementation((_policy, req) => Promise.resolve(isVanQuestion(req) ? answer(vanAnswer) : answer(main)));
  };
  const screen = ({ main, vanAnswer, ...opts } = {}) => {
    mockAnswers({ main, vanAnswer });
    return screenGeneratedImage({ buffer: PNG_BUFFER, allowVanWrap: true, ...opts });
  };
  const withVan = (extra) => screen({ vanAnswer: { van_count: 1, van: van(extra) } });
  beforeEach(() => mockDispatch.mockReset());

  test('the van is asked about in its own question; the main screen is told to leave that one van out of every field', () => {
    expect(buildScreenPrompt({})).not.toMatch(/IGNORE THE WAVES VAN/);
    expect(buildScreenPrompt({ allowUniformLogo: true })).not.toMatch(/IGNORE THE WAVES VAN/);
    const main = buildScreenPrompt({ allowVanWrap: true });
    expect(main).toMatch(/^IGNORE THE WAVES VAN FIRST: if exactly ONE van in the frame carries the Waves van wrap/);
    expect(main).toMatch(/treat that one van as if it were not in the picture/);
    expect(main).toMatch(/if two or more vans carry the wrap, list them all/);
    expect(main).not.toMatch(/"van":|van_wrap_elsewhere/);
    const q = _internals.buildVanScreenPrompt();
    expect(q).toMatch(/shape \{"van_count": number, "van": \{"body": "ford_transit_medium_roof" \| "mercedes_sprinter" \| "ram_promaster" \| "high_roof_van" \| "box_truck" \| "pickup_or_car" \| "unsure", "wrapped": boolean, "wrap_mascot": boolean, "phone_numbers": string\[\], "web_addresses": string\[\]\} \| null\}/);
    expect(q).toMatch(/a short sloped hood, a black hexagon-mesh grille \(with a Ford oval\), and a MEDIUM roof/);
    expect(q).toMatch(/"mercedes_sprinter" \(a long pointed nose, no Ford grille\)/);
    expect(q).toMatch(/phone number on the van that you can read IN FULL/);
    expect(q).toMatch(/whole van body wrapped bright blue/);
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
    expect(mockDispatch.mock.calls[0][1].text).not.toMatch(/IGNORE THE WAVES VAN/);
  });

  test('both screen questions run on the Sol-first imageScreen policy (Claude backup) at medium reasoning, above the reasoning floor (owner ruling 2026-09-25)', async () => {
    mockAnswers();
    await screenGeneratedImage({ buffer: PNG_BUFFER, allowUniformLogo: true, allowVanWrap: true });
    expect(mockDispatch).toHaveBeenCalledTimes(2);
    for (const [policy, req] of mockDispatch.mock.calls) {
      expect(policy).toBe(MODELS.TEXT_POLICIES.imageScreen);
      expect(req.reasoningEffort).toBe('medium');
      expect(req.maxTokens).toBeGreaterThan(1024);
    }
    expect(MODELS.TEXT_POLICIES.imageScreen.primary.provider).toBe('openai');
    expect(MODELS.TEXT_POLICIES.imageScreen.fallback).toEqual({ provider: 'anthropic', model: MODELS.VISION });
  });

  test('the wrap on the van, nothing off it, its own phone number and web address → clean', async () => {
    expect(await screen()).toMatchObject({ ok: true, checked: true, reasons: [], violations: 0, logos: [] });
  });

  test('a READABLE phone number or web address that is not Waves\' own fails; formatting never matters (owner, 2026-09-25)', async () => {
    const phone = await withVan({ phone_numbers: ['941-214-2459'] });
    expect(phone.reasons).toEqual(['wrong phone number on the van: 941-214-2459']);
    expect(phone.logos).toEqual(['wrong phone number on the van: 941-214-2459']);
    expect(phone.violations).toBe(1);
    const web = await withVan({ web_addresses: ['GoWaveFL.com'] });
    expect(web.reasons).toEqual(['wrong web address on the van: GoWaveFL.com']);
    for (const ok of [['(941) 241-2459'], ['941.241.2459'], ['+1 941 241 2459']]) {
      expect(await withVan({ phone_numbers: ok })).toMatchObject({ ok: true, reasons: [] });
    }
    for (const ok of [['gowavesfl.com'], ['www.GoWavesFL.com'], ['https://gowavesfl.com/'], ['GoWaves FL.com']]) {
      expect(await withVan({ web_addresses: ok })).toMatchObject({ ok: true, reasons: [] });
    }
  });

  test('slight lettering variances pass — only contact details are read back, and an unreadable one is simply absent (owner, 2026-09-25)', async () => {
    expect(await withVan({ phone_numbers: [], web_addresses: [] })).toMatchObject({ ok: true, reasons: [] });
    expect(await withVan({ body: 'ford_transit_medium_roof', phone_numbers: [], web_addresses: [] })).toMatchObject({ ok: true, reasons: [] });
  });

  test('van body: a Sprinter/other body fails even when correctly wrapped; "unsure" and the Transit pass (Codex r2 P2 on #4785)', async () => {
    const sprinter = await withVan({ body: 'mercedes_sprinter' });
    expect(sprinter.reasons).toEqual(['van body is not a Ford Transit medium-roof cargo van']);
    expect(sprinter.logos).toEqual(['van body is not a Ford Transit medium-roof cargo van']);
    expect(await withVan({ body: 'unsure' })).toMatchObject({ ok: true, reasons: [] });
    expect(await withVan({ body: 'ford_transit_medium_roof' })).toMatchObject({ ok: true, reasons: [] });
    expect((await withVan({ body: 'mercedes_sprinter', wrap_mascot: false })).reasons).toEqual(['van body is not a Ford Transit medium-roof cargo van', 'van wrap missing the mascot']);
    // "other" is no longer a valid body value (Codex r2 P2 on #4785 named the
    // wrong bodies instead) — an unusable value fails the screen open, unchecked.
    expect(await withVan({ body: 'other' })).toMatchObject({ ok: true, checked: false });
  });

  test('a second van of any kind fails — a plain, partial or mirrored duplicate carries no mark the main screen would see (Codex r1 P2 on #4822)', async () => {
    const two = await screen({ vanAnswer: { van_count: 2, van: van() } });
    expect(two.reasons).toEqual(['2 vans in the frame, not one']);
    expect(two.logos).toEqual(['2 vans in the frame, not one']);
    expect(_internals.buildVanScreenPrompt()).toMatch(/van_count: how many vans of ANY kind appear in the frame — plain, wrapped, partial, mirrored, reflected or cut off at the edge each count/);
  });

  test('a van present WITHOUT the wrap fails; no van at all is clean (Codex r1 P2 on #4784)', async () => {
    const plain = await withVan({ body: 'ford_transit_medium_roof', wrapped: false, wrap_mascot: false, phone_numbers: [], web_addresses: [] });
    expect(plain.reasons).toEqual(['van present without the wrap']);
    expect(plain.logos).toEqual(['van present without the wrap']);
    expect(await screen({ vanAnswer: { van_count: 0, van: null } })).toMatchObject({ ok: true, checked: true, reasons: [] });
  });

  test('a PARTIALLY applied wrap — no mascot — fails whatever else rendered (Codex r1 P2 on #4785)', async () => {
    expect((await withVan({ wrap_mascot: false, phone_numbers: [] })).reasons).toEqual(['van wrap missing the mascot']);
    const both = await withVan({ wrap_mascot: false, phone_numbers: ['941-555-0100'] });
    expect(both.reasons).toEqual(['van wrap missing the mascot', 'wrong phone number on the van: 941-555-0100']);
    expect(both.violations).toBe(2);
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
    const tech = { facing: 'camera', cap_front_visible: true, chest_visible: true, logo_on: ['cap', 'chest'], placket_x: 500, chest_badges_x: [440] };
    const r = await screen({ allowUniformLogo: true, main: { ...CLEAN_MAIN, technicians: [tech], waves_logo_elsewhere: [], uniform_logo_lettering: [] } });
    expect(r).toMatchObject({ ok: true, checked: true, reasons: [] });
    const elsewhere = await screen({ allowUniformLogo: true, main: { ...CLEAN_MAIN, technicians: [tech], waves_logo_elsewhere: ['a sign on the fence'], uniform_logo_lettering: [] } });
    expect(elsewhere.reasons).toEqual(['logo or brand mark: Waves logo elsewhere: a sign on the fence']);
  });

  test('an unusable van answer — omitted key, malformed or contradictory van — fails the screen OPEN, never clean (Codex r1, r4 P2s on #4785)', async () => {
    for (const vanAnswer of [{}, { van: van() }, { van_count: 1.5, van: van() }, { van_count: -1, van: van() }, { van_count: 0, van: van() }, { van_count: 2, van: null }, { van: { wrapped: true } }, { van: van({ body: 'sprinter' }) }, { van: van({ body: undefined }) }, { van: van({ phone_numbers: '941-241-2459' }) }, { van: van({ web_addresses: undefined }) }, { van: 'none' }]) {
      expect(await screen({ vanAnswer })).toMatchObject({ ok: true, checked: false });
    }
  });

  test('either dispatch failing fails the screen open', async () => {
    mockDispatch.mockImplementation((_policy, req) => Promise.resolve(isVanQuestion(req) ? { ok: false, reason: 'timeout' } : answer(CLEAN_MAIN)));
    expect(await screenGeneratedImage({ buffer: PNG_BUFFER, allowVanWrap: true })).toMatchObject({ ok: true, checked: false });
    mockDispatch.mockImplementation((_policy, req) => Promise.resolve(isVanQuestion(req) ? answer({ van_count: 1, van: van() }) : { ok: false, reason: 'timeout' }));
    expect(await screenGeneratedImage({ buffer: PNG_BUFFER, allowVanWrap: true })).toMatchObject({ ok: true, checked: false });
  });
});

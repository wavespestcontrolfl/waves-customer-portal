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
  const van = (extra = {}) => ({ present: true, body: 'ford_transit_medium_roof', wrapped: true, wrap_text: ['WAVES', 'Lawn & Pest', 'Wave Goodbye to Pests!', '941-241-2459', 'GoWavesFL.com'], wrap_mascot: true, ...extra });
  const branded = (extra = {}) => answer({ readable_text: [], logos_or_brand_marks: [], van: van(), van_wrap_elsewhere: [], forbidden_scenes: [], notes: '', ...extra });
  const screen = (extra) => { mockDispatch.mockResolvedValue(branded(extra)); return screenGeneratedImage({ buffer: PNG_BUFFER, allowVanWrap: true }); };
  beforeEach(() => mockDispatch.mockReset());

  test('the screen prompt asks for the van/elsewhere fields and names the exception only when the caller allows it', () => {
    const plain = buildScreenPrompt({});
    expect(plain).not.toMatch(/van_wrap_elsewhere|"van":/);
    const p = buildScreenPrompt({ allowVanWrap: true });
    expect(p).toMatch(/"van": \{"present": boolean, "body": "ford_transit_medium_roof" \| "other" \| "unsure", "wrapped": boolean, "wrap_text": string\[\], "wrap_mascot": boolean\} \| null, "van_wrap_elsewhere": string\[\]/);
    expect(p).toMatch(/EXCEPTION: that one van's own wrap graphics and its own wrap text are expected/);
    expect(p).toMatch(/Transit cues: a short hood, a black hexagon-mesh grille with a Ford oval badge/);
    expect(p).toMatch(/Mercedes Sprinter's long sloped nose/);
  });

  test('the wrap on the van, nothing off it, exact wrap strings → clean', async () => {
    const r = await screen();
    expect(r).toMatchObject({ ok: true, checked: true, reasons: [], violations: 0, logos: [] });
    expect(mockDispatch.mock.calls[0][1].maxTokens).toBe(_internals.SCREEN_MAX_TOKENS_WITH_VAN_WRAP);
  });

  test('garbled wrap text on the van (a mangled phone number or URL) fails as gibberish lettering', async () => {
    const r = await screen({ van: van({ wrap_text: ['WAVES', '941-XX9-ZZ59'] }) });
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(['garbled van wrap text: 941-XX9-ZZ59']);
    expect(r.logos).toEqual(['garbled van wrap text: 941-XX9-ZZ59']);
  });

  test('a TRUNCATED phone number or URL on the van fails too (Codex r1 P2 on #4784)', async () => {
    // "941-241-2459" and "GoWavesFL.com" are each ONE canonical chunk (no
    // whitespace inside either), so a truncated report of either can never
    // partially cover it — it simply matches no chunk anywhere and is
    // stray, not "incomplete" (Codex r3 P2 on #4785 changed the matcher
    // from word-level to whitespace-chunk-level; see the punctuation-
    // sensitivity test below for why).
    const truncatedPhone = await screen({ van: van({ wrap_text: ['WAVES', '941-241'] }) });
    expect(truncatedPhone.ok).toBe(false);
    expect(truncatedPhone.reasons).toEqual(['garbled van wrap text: 941-241']);
    expect(truncatedPhone.violations).toBe(1);
    const truncatedUrl = await screen({ van: van({ wrap_text: ['GoWavesFL'] }) });
    expect(truncatedUrl.ok).toBe(false);
    expect(truncatedUrl.reasons).toEqual(['garbled van wrap text: GoWavesFL']);
  });

  test('PUNCTUATION-SENSITIVE wrap text: the right words with the WRONG punctuation still fail, even though matchCaptions would have called them equal (Codex r2 P2 on #4785)', async () => {
    const noAmpersand = await screen({ van: van({ wrap_text: ['Lawn Pest'] }) });
    expect(noAmpersand.ok).toBe(false);
    expect(noAmpersand.reasons).toEqual(['garbled van wrap text: Lawn Pest']);
    const wrongPunct1 = await screen({ van: van({ wrap_text: ['Lawn-Pest'] }) });
    expect(wrongPunct1.ok).toBe(false);
    expect(wrongPunct1.reasons).toEqual(['garbled van wrap text: Lawn-Pest']);
    const wrongPunct2 = await screen({ van: van({ wrap_text: ['GoWavesFL-com'] }) });
    expect(wrongPunct2.ok).toBe(false);
    expect(wrongPunct2.reasons).toEqual(['garbled van wrap text: GoWavesFL-com']);
    // the exact wrap strings (correct punctuation) still pass, including the
    // "!" after Pests.
    const exact = await screen({ van: van({ wrap_text: ['Lawn & Pest', 'Wave Goodbye to Pests!'] }) });
    expect(exact.ok).toBe(true);
  });

  test('a split is legitimate ONLY at a canonical WHITESPACE boundary — a split that silently drops required punctuation still fails (Codex r3 P2 on #4785)', async () => {
    // "941-241-2459" and "GoWavesFL.com" have NO whitespace anywhere, so NO
    // split of either is ever legitimate: every hyphen/dot would be dropped
    // exactly at the cut. This reverses the earlier r1/r2 behavior, where a
    // fragment-INTERNAL punctuation check let '941-241' + '2459' pass —
    // that check never looked at the boundary BETWEEN fragments, which is
    // exactly where the missing hyphen was.
    const phoneSplitInTwo = await screen({ van: van({ wrap_text: ['941-241', '2459'] }) });
    expect(phoneSplitInTwo.ok).toBe(false);
    expect(phoneSplitInTwo.reasons).toEqual(['garbled van wrap text: 941-241, 2459']);
    const phoneSplitInThree = await screen({ van: van({ wrap_text: ['941', '241', '2459'] }) });
    expect(phoneSplitInThree.ok).toBe(false);
    const urlSplit = await screen({ van: van({ wrap_text: ['GoWavesFL', 'com'] }) });
    expect(urlSplit.ok).toBe(false);
    // "Lawn & Pest" DOES have whitespace around its "&", so a split right
    // there — keeping the & attached to either neighbor — is legitimate;
    // dropping the & entirely (splitting exactly where it sits) is not.
    const ampersandOnLeft = await screen({ van: van({ wrap_text: ['Lawn &', 'Pest'] }) });
    expect(ampersandOnLeft.ok).toBe(true);
    const ampersandOnRight = await screen({ van: van({ wrap_text: ['Lawn', '& Pest'] }) });
    expect(ampersandOnRight.ok).toBe(true);
    const ampersandDropped = await screen({ van: van({ wrap_text: ['Lawn', 'Pest'] }) });
    expect(ampersandDropped.ok).toBe(false);
    expect(ampersandDropped.reasons).toEqual(['garbled van wrap text: Lawn & Pest']); // incomplete: "Lawn" and "Pest" each validly cover part, but "&" is never covered
    // "Wave Goodbye to Pests!" splits cleanly at any of its real spaces —
    // the "!" has no space before it, so it must stay glued to "Pests".
    const wordSplit = await screen({ van: van({ wrap_text: ['Wave Goodbye', 'to Pests!'] }) });
    expect(wordSplit.ok).toBe(true);
  });

  test('a valid wrap fragment duplicated in readable_text does not double-fail as stray OCR — but a GARBLED one still does (Codex r2 P2 on #4785, fix 2)', async () => {
    const validEcho = await screen({ readable_text: ['WAVES'], van: van({ wrap_text: ['WAVES'] }) });
    expect(validEcho).toMatchObject({ ok: true, reasons: [] });
    const garbledEcho = await screen({ readable_text: ['Lawn-Pest'], van: van({ wrap_text: ['Lawn-Pest'] }) });
    expect(garbledEcho.ok).toBe(false);
    // the garbled fragment fails BOTH the van-wrap check and the general
    // readable-text check — it was never added to the attribution set.
    expect(garbledEcho.reasons).toEqual(['garbled van wrap text: Lawn-Pest', 'readable text: Lawn-Pest']);
  });

  test('van.body conformance: a Sprinter/other body fails even when correctly wrapped; "unsure" passes; a missing/invalid body is malformed (Codex r2 P2 on #4785)', async () => {
    const other = await screen({ van: van({ body: 'other' }) });
    expect(other.ok).toBe(false);
    expect(other.reasons).toEqual(['van body is not a Ford Transit medium-roof cargo van']);
    expect(other.logos).toEqual(['van body is not a Ford Transit medium-roof cargo van']);
    const unsure = await screen({ van: van({ body: 'unsure' }) });
    expect(unsure).toMatchObject({ ok: true, reasons: [] });
    const transit = await screen({ van: van({ body: 'ford_transit_medium_roof' }) });
    expect(transit).toMatchObject({ ok: true, reasons: [] });
    // combines with an independent violation (wrong body AND missing mascot)
    const both = await screen({ van: van({ body: 'other', wrap_mascot: false }) });
    expect(both.ok).toBe(false);
    expect(both.reasons).toEqual(['van body is not a Ford Transit medium-roof cargo van', 'van wrap missing the mascot']);
    // missing or invalid body → malformed, fail-open unchecked (never clean)
    expect(await screen({ van: van({ body: undefined }) })).toMatchObject({ ok: true, checked: false });
    expect(await screen({ van: van({ body: 'sprinter' }) })).toMatchObject({ ok: true, checked: false });
  });

  test('a van present WITHOUT the wrap fails (the editor kept the van but dropped the reference) — no van at all stays clean (Codex r1 P2 on #4784)', async () => {
    const unwrapped = await screen({ van: { present: true, body: 'ford_transit_medium_roof', wrapped: false, wrap_text: [], wrap_mascot: false } });
    expect(unwrapped.ok).toBe(false);
    expect(unwrapped.reasons).toEqual(['van present without the wrap']);
    expect(unwrapped.logos).toEqual(['van present without the wrap']);
    const noVanAtAll = await screen({ van: null });
    expect(noVanAtAll).toMatchObject({ ok: true, reasons: [] });
  });

  test('the same wrap marks anywhere other than the one van fail (a second vehicle, sign, or equipment)', async () => {
    const r = await screen({ van_wrap_elsewhere: ['a second van in the driveway'] });
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(['van wrap off the van: a second van in the driveway']);
    expect(r.logos).toEqual(['van wrap off the van: a second van in the driveway']);
  });

  test('no van in frame at all is clean — nothing to judge', async () => {
    const r = await screen({ van: null });
    expect(r).toMatchObject({ ok: true, reasons: [] });
  });

  test('an answer without the van/elsewhere fields, or a malformed van, is unusable → unchecked (fail-open), never clean', async () => {
    mockDispatch.mockResolvedValue(answer({ readable_text: [], logos_or_brand_marks: [], forbidden_scenes: [], notes: '' }));
    expect(await screenGeneratedImage({ buffer: PNG_BUFFER, allowVanWrap: true })).toMatchObject({ ok: true, checked: false });
    expect(await screen({ van: { present: true } })).toMatchObject({ ok: true, checked: false });
    expect(await screen({ van: { present: true, wrapped: true } })).toMatchObject({ ok: true, checked: false });
    expect(await screen({ van_wrap_elsewhere: 'none' })).toMatchObject({ ok: true, checked: false });
  });

  test('the `van` key must be PRESENT — an OMITTED key (van_wrap_elsewhere answered, van left out entirely) is unusable, never treated as an explicit "no van" (Codex r1 P2 on #4785)', async () => {
    // van_wrap_elsewhere is well-formed but `van` is missing from the JSON
    // entirely — JSON mode does not guarantee every requested key comes
    // back, so this must fail open, not read as "no van" (clean).
    mockDispatch.mockResolvedValue(answer({ readable_text: [], logos_or_brand_marks: [], van_wrap_elsewhere: [], forbidden_scenes: [], notes: '' }));
    const r = await screenGeneratedImage({ buffer: PNG_BUFFER, allowVanWrap: true });
    expect(r).toMatchObject({ ok: true, checked: false });
    // An EXPLICIT null for the same otherwise-complete answer is still a
    // valid, clean "no van" verdict — only the missing key is rejected.
    const explicit = await screen({ van: null });
    expect(explicit).toMatchObject({ ok: true, checked: true, reasons: [] });
  });

  test('a PARTIALLY applied wrap — wrapped: true but no mascot — is a violation, whether or not any wrap text rendered (Codex r1 P2 on #4785)', async () => {
    const noMascotNoText = await screen({ van: van({ wrap_mascot: false, wrap_text: [] }) });
    expect(noMascotNoText.ok).toBe(false);
    expect(noMascotNoText.reasons).toEqual(['van wrap missing the mascot']);
    expect(noMascotNoText.logos).toEqual(['van wrap missing the mascot']);
    // missing mascot AND garbled text both count, as two separate reasons
    const noMascotBadText = await screen({ van: van({ wrap_mascot: false, wrap_text: ['941-XX9-ZZ59'] }) });
    expect(noMascotBadText.ok).toBe(false);
    expect(noMascotBadText.reasons).toEqual(['van wrap missing the mascot', 'garbled van wrap text: 941-XX9-ZZ59']);
    expect(noMascotBadText.violations).toBe(2);
  });

  test('without the allowance, van wrap fields are ignored — a logo-free/wrap-free generation is screened as before', async () => {
    mockDispatch.mockResolvedValue(answer({ readable_text: [], logos_or_brand_marks: [], forbidden_scenes: [], notes: '' }));
    const r = await screenGeneratedImage({ buffer: PNG_BUFFER });
    expect(r).toMatchObject({ ok: true, checked: true });
    expect(mockDispatch.mock.calls[0][1].text).not.toMatch(/van_wrap_elsewhere/);
    expect(mockDispatch.mock.calls[0][1].maxTokens).toBe(_internals.SCREEN_MAX_TOKENS);
  });

  test('the logo and van wrap allowances combine: both technicians and van fields are asked for, with the larger token budget', () => {
    const p = buildScreenPrompt({ allowUniformLogo: true, allowVanWrap: true });
    expect(p).toMatch(/"technicians":/);
    expect(p).toMatch(/"van":/);
    expect(_internals.screenMaxTokens({ allowUniformLogo: true, allowVanWrap: true })).toBe(_internals.SCREEN_MAX_TOKENS_WITH_LOGO_AND_VAN_WRAP);
    expect(_internals.SCREEN_MAX_TOKENS_WITH_LOGO_AND_VAN_WRAP).toBeGreaterThan(_internals.SCREEN_MAX_TOKENS_WITH_LOGO);
  });

  test('combined logo+van prompt exempts the one wrapped van from waves_logo_elsewhere — a compliant answer reporting the van only under `van` is clean (Codex r1 P2 on #4785)', () => {
    // Logo-only prompt (allowVanWrap off) stays byte-identical to before —
    // no inserted clause changes it.
    const logoOnly = buildScreenPrompt({ allowUniformLogo: true });
    expect(logoOnly).toMatch(/EXCEPTION: that Waves logo on a technician's cap or shirt chest is expected — do not list it under logos_or_brand_marks\. Any OTHER lettering \(including "WAVES" on a sign, vehicle or wall\), and the Waves logo anywhere other than a cap or chest, must still be listed\./);
    expect(logoOnly).not.toMatch(/wrapped van/);

    const combined = buildScreenPrompt({ allowUniformLogo: true, allowVanWrap: true });
    expect(combined).toMatch(/waves_logo_elsewhere: every place that Waves logo appears that is NOT a technician's cap or chest and NOT the one wrapped van described below \(report the van's own marks under `van` instead\)/);
    expect(combined).toMatch(/EXCEPTION: that Waves logo on a technician's cap or shirt chest, and on the one wrapped van described below, is expected — do not list it under logos_or_brand_marks or waves_logo_elsewhere\./);
    expect(combined).toMatch(/the Waves logo anywhere other than a cap, chest or that one van, must still be listed\./);

    // A compliant answer: the technician correctly carries the logo, the van
    // correctly carries the wrap, and NEITHER shows up in waves_logo_elsewhere
    // — this must be clean, not rejected as a stray brand mark.
    const tech = { cap_front_visible: true, chest_visible: true, logo_on: ['cap', 'right chest'] };
    mockDispatch.mockResolvedValue({
      ok: true,
      text: JSON.stringify({
        readable_text: [], logos_or_brand_marks: [],
        technicians: [tech], waves_logo_elsewhere: [], uniform_logo_lettering: [],
        van: { present: true, body: 'ford_transit_medium_roof', wrapped: true, wrap_text: ['WAVES', 'Lawn & Pest'], wrap_mascot: true },
        van_wrap_elsewhere: [], forbidden_scenes: [], notes: '',
      }),
    });
    return screenGeneratedImage({ buffer: PNG_BUFFER, allowUniformLogo: true, allowVanWrap: true }).then((r) => {
      expect(r).toMatchObject({ ok: true, checked: true, reasons: [] });
    });
  });

  test('van_wrap_elsewhere also exempts the technician\'s permitted cap/chest logo when both allowances are on (Codex r3 P2 on #4785)', () => {
    // Prompt text: the van-only prompt (allowUniformLogo off) is unaffected;
    // the combined prompt adds the new exemption clause.
    const vanOnly = buildScreenPrompt({ allowVanWrap: true });
    expect(vanOnly).not.toMatch(/permitted cap\/chest logo/);
    const combined = buildScreenPrompt({ allowUniformLogo: true, allowVanWrap: true });
    expect(combined).toMatch(/appearing anywhere OTHER than on that one van or on the technician's permitted cap\/chest logo \(already covered above\)/);

    const tech = { cap_front_visible: true, chest_visible: true, logo_on: ['cap', 'right chest'] };
    const withVan = { present: true, body: 'ford_transit_medium_roof', wrapped: true, wrap_text: [], wrap_mascot: true };
    // A response that (redundantly, against the updated instructions) STILL
    // lists the technician's own correct cap/chest mark under
    // van_wrap_elsewhere must not fail — the JS-level belt catches what the
    // prompt fix alone might not.
    mockDispatch.mockResolvedValue({
      ok: true,
      text: JSON.stringify({
        readable_text: [], logos_or_brand_marks: [],
        technicians: [tech], waves_logo_elsewhere: [], uniform_logo_lettering: [],
        van: withVan, van_wrap_elsewhere: ["Waves logo on the technician's cap"],
        forbidden_scenes: [], notes: '',
      }),
    });
    return screenGeneratedImage({ buffer: PNG_BUFFER, allowUniformLogo: true, allowVanWrap: true }).then((r) => {
      expect(r).toMatchObject({ ok: true, checked: true, reasons: [] });
    });
  });

  test('a genuinely off-van mark still fails under van_wrap_elsewhere even when the uniform logo is also allowed (the exemption is cap/chest-specific, not a blanket pass)', async () => {
    const tech = { cap_front_visible: true, chest_visible: true, logo_on: ['cap', 'right chest'] };
    mockDispatch.mockResolvedValue({
      ok: true,
      text: JSON.stringify({
        readable_text: [], logos_or_brand_marks: [],
        technicians: [tech], waves_logo_elsewhere: [], uniform_logo_lettering: [],
        van: van(), van_wrap_elsewhere: ['a second van in the driveway'],
        forbidden_scenes: [], notes: '',
      }),
    });
    const r = await screenGeneratedImage({ buffer: PNG_BUFFER, allowUniformLogo: true, allowVanWrap: true });
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(['van wrap off the van: a second van in the driveway']);
  });

  test('a generic brand-mark detection explicitly naming the PERMITTED van is exempted from logos_or_brand_marks — a non-Waves brand, or a wrongly-shaped/unwrapped van, still fails (Codex r3 P2 on #4785)', async () => {
    const wrapped = van({ wrap_text: [] });
    // Waves branding explicitly attributed to the correctly-wrapped van,
    // reported (redundantly) under the generic list too — exempted.
    mockDispatch.mockResolvedValue({ ok: true, text: JSON.stringify({ readable_text: [], logos_or_brand_marks: ['Waves logo on the van'], van: wrapped, van_wrap_elsewhere: [], forbidden_scenes: [], notes: '' }) });
    const waves = await screenGeneratedImage({ buffer: PNG_BUFFER, allowVanWrap: true });
    expect(waves).toMatchObject({ ok: true, checked: true, reasons: [] });

    // A non-Waves brand on the van is still a real violation.
    mockDispatch.mockResolvedValue({ ok: true, text: JSON.stringify({ readable_text: [], logos_or_brand_marks: ['Orkin logo on the van'], van: wrapped, van_wrap_elsewhere: [], forbidden_scenes: [], notes: '' }) });
    const competitor = await screenGeneratedImage({ buffer: PNG_BUFFER, allowVanWrap: true });
    expect(competitor.ok).toBe(false);
    expect(competitor.reasons).toEqual(['logo or brand mark: Orkin logo on the van']);

    // The Waves mark on the van is NOT exempted when the van itself isn't
    // the permitted one (unwrapped, or the wrong body) — "Waves logo on the
    // van" then still means a brand mark on an otherwise-unbranded vehicle.
    mockDispatch.mockResolvedValue({ ok: true, text: JSON.stringify({ readable_text: [], logos_or_brand_marks: ['Waves logo on the van'], van: { present: true, body: 'ford_transit_medium_roof', wrapped: false, wrap_text: [], wrap_mascot: false }, van_wrap_elsewhere: [], forbidden_scenes: [], notes: '' }) });
    const unwrapped = await screenGeneratedImage({ buffer: PNG_BUFFER, allowVanWrap: true });
    expect(unwrapped.ok).toBe(false);
    expect(unwrapped.reasons).toContain('logo or brand mark: Waves logo on the van');

    mockDispatch.mockResolvedValue({ ok: true, text: JSON.stringify({ readable_text: [], logos_or_brand_marks: ['Waves logo on the van'], van: { present: true, body: 'other', wrapped: true, wrap_text: [], wrap_mascot: true }, van_wrap_elsewhere: [], forbidden_scenes: [], notes: '' }) });
    const wrongBody = await screenGeneratedImage({ buffer: PNG_BUFFER, allowVanWrap: true });
    expect(wrongBody.ok).toBe(false);
    expect(wrongBody.reasons).toContain('logo or brand mark: Waves logo on the van');
  });
});

/**
 * Job card service (GATE_JOB_CARD) — the pure builders behind the drawer's
 * Job card tab: template paragraph, model-output validator + fallback,
 * spray-check verdicts, tank mix math, and the paragraph cache's
 * "template is not a permanent hit" rule.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = () => ({});
  fn.raw = () => ({});
  fn.schema = { hasTable: async () => true };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const jobCard = require('../services/job-card');

const baseFacts = () => ({
  pets: '', petsSecured: '', gates: [], entry: '', parking: '', instructions: '',
  contactPreference: 'text', chemicalSensitivity: '', awayUntil: null, visitNotes: '',
  lastVisit: null, issues: [], calls: [], irrigation: null, rain7d: null,
});

describe('buildTemplateParagraph', () => {
  test('first visit, nothing on file → one sentence', () => {
    expect(jobCard.buildTemplateParagraph(baseFacts())).toBe('First visit on record.');
  });

  test('pets, gate presence (never the code), last visit and open issue', () => {
    const facts = {
      ...baseFacts(),
      pets: 'dog',
      gates: ['Property gate'],
      lastVisit: { date: '2026-08-12', summary: 'Chinch bugs east side', callback: false },
      issues: [{ kind: 'request', text: 'Ants in kitchen', urgent: true }],
    };
    const text = jobCard.buildTemplateParagraph(facts);
    expect(text).toBe('Pets: dog, property gate code on file, tap to show. Last visit 2026-08-12: Chinch bugs east side, open: URGENT Ants in kitchen.');
  });

  test('lawn: irrigation + rain, or the explicit ask when empty', () => {
    const withIrrigation = { ...baseFacts(), irrigation: 'Mon/Thu, 20 min', rain7d: 1.2 };
    expect(jobCard.buildTemplateParagraph(withIrrigation, { isLawn: true }))
      .toBe('First visit on record. Irrigation Mon/Thu, 20 min, 1.2" rain in the last 7 days.');
    expect(jobCard.buildTemplateParagraph(baseFacts(), { isLawn: true }))
      .toBe('First visit on record. No irrigation on file — ask the customer.');
    // Pest lines never mention irrigation.
    expect(jobCard.buildTemplateParagraph(withIrrigation, { isLawn: false })).toBe('First visit on record.');
  });
});

describe('validateParagraph', () => {
  const grounding = 'Pets: dog, property gate code on file, tap to show. Last visit 2026-08-12: Chinch bugs east side.';
  const codes = [{ label: 'Property gate', code: '4545#' }];

  test('accepts a faithful 1–3 sentence rewrite', () => {
    expect(jobCard.validateParagraph('There is a dog and a gate code on file you can show. Last visit on 2026-08-12 found chinch bugs on the east side.', grounding, codes)).toBeNull();
  });

  test.each([
    ['four sentences', 'One. Two. Three. Four.', 'sentence_count'],
    ['emoji', 'Dog on site 🐶. Gate code on file.', 'emoji'],
    ['bullet markup', '- dog\n- gate', 'markup'],
    ['leaked code', 'Gate code is 4545#. Dog on site.', 'code_leak'],
    ['invented number', 'Two dogs and 3 cats are on site.', 'ungrounded_number'],
    ['empty', '   ', 'empty'],
  ])('rejects %s', (_label, text, reason) => {
    expect(jobCard.validateParagraph(text, grounding, codes)).toBe(reason);
  });

  test('rejects more than 60 words', () => {
    const long = `${Array.from({ length: 61 }, () => 'word').join(' ')}.`;
    expect(jobCard.validateParagraph(long, grounding, codes)).toBe('too_long');
  });
});

describe('writeParagraph', () => {
  const template = 'Pets: dog. First visit on record.';

  test('model text that passes validation is returned as source=model', async () => {
    const callModel = jest.fn(async () => ({ ok: true, text: 'A dog lives here and this is the first visit on record.' }));
    const out = await jobCard.writeParagraph(template, [], { callModel });
    expect(out).toEqual({ text: 'A dog lives here and this is the first visit on record.', source: 'model' });
    // The grounding sent to the model is the template — never a code.
    expect(callModel.mock.calls[0][0].text).toContain(template);
  });

  test('dispatcher miss → template', async () => {
    const callModel = jest.fn(async () => ({ ok: false, reason: 'timeout' }));
    expect(await jobCard.writeParagraph(template, [], { callModel })).toEqual({ text: template, source: 'template' });
  });

  test('injected path returning invalid text → template (defense in depth)', async () => {
    const callModel = jest.fn(async () => ({ ok: true, text: 'Dog. Gate 4545#. Ok.' }));
    expect(await jobCard.writeParagraph(template, [{ label: 'Gate', code: '4545#' }], { callModel })).toEqual({ text: template, source: 'template' });
  });

  test('thrown error → template', async () => {
    const callModel = jest.fn(async () => { throw new Error('boom'); });
    expect(await jobCard.writeParagraph(template, [], { callModel })).toEqual({ text: template, source: 'template' });
  });
});

describe('paragraphForVisit cache', () => {
  const makeDb = () => {
    const update = jest.fn(async () => 1);
    const chain = { where() { return this; }, update };
    const dbh = jest.fn(() => chain);
    return { dbh, update };
  };
  const facts = (stored) => ({
    serviceId: 'svc-1', isLawn: false,
    facts: baseFacts(),
    access: { codes: [] },
    cache: { stored, generatedAt: stored ? '2026-09-01T00:00:00Z' : null },
  });

  test('cached model paragraph with the same grounding hash skips the model', async () => {
    const template = jobCard.buildTemplateParagraph(baseFacts());
    const hash = jobCard._test.groundingHash(template);
    const { dbh, update } = makeDb();
    const callModel = jest.fn();
    const out = await jobCard.paragraphForVisit(facts({ grounding_hash: hash, source: 'model', text: 'Cached text.' }), { dbh, deps: { callModel } });
    expect(out).toEqual({ text: 'Cached text.', source: 'model', cached: true });
    expect(callModel).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  test('a cached TEMPLATE is retried and the fresh model text is stored', async () => {
    const template = jobCard.buildTemplateParagraph(baseFacts());
    const hash = jobCard._test.groundingHash(template);
    const { dbh, update } = makeDb();
    const callModel = jest.fn(async () => ({ ok: true, text: 'This is the first visit on record.' }));
    const out = await jobCard.paragraphForVisit(facts({ grounding_hash: hash, source: 'template', text: template }), { dbh, deps: { callModel } });
    expect(out.source).toBe('model');
    expect(callModel).toHaveBeenCalledTimes(1);
    const written = JSON.parse(update.mock.calls[0][0].job_card);
    expect(written).toMatchObject({ version: jobCard.PROMPT_VERSION, grounding_hash: hash, source: 'model' });
  });
});

describe('buildSprayCheck', () => {
  const now = new Date('2026-09-04T13:00:00Z');
  const hour = (offset, fields) => ({ startTime: new Date(now.getTime() + offset * 3600000).toISOString(), rainChance: 10, temperatureF: 85, windMph: 5, shortForecast: 'Sunny', ...fields });
  const hourly = [hour(0), hour(1), hour(2), hour(3), hour(4, { rainChance: 90, temperatureF: 99, windMph: 30 })];

  test('no limits on file → unknown, never ok', () => {
    const out = jobCard.buildSprayCheck({ products: [{ id: 'p1' }], hourly, now });
    expect(out.verdicts).toEqual([{ productId: 'p1', verdict: 'unknown', reason: 'No limit on file' }]);
    expect(out.hold).toBe(false);
  });

  test('limits inside the 4 h window → ok; the 5th hour does not count', () => {
    const out = jobCard.buildSprayCheck({ products: [{ id: 'p1', max_temp_f: 90, max_wind_mph: 10, rain_free_hours: 2 }], hourly, now });
    expect(out.verdicts[0]).toEqual({ productId: 'p1', verdict: 'ok', reason: null });
    expect(out.forecast).toMatchObject({ windMph: 5, rainPct: 10 });
  });

  test('temperature and wind breaches hold with both reasons', () => {
    const hot = hourly.map((h, i) => (i === 2 ? { ...h, temperatureF: 95, windMph: 12 } : h));
    const out = jobCard.buildSprayCheck({ products: [{ id: 'p1', max_temp_f: 90, max_wind_mph: 10 }], hourly: hot, now });
    expect(out.verdicts[0]).toEqual({ productId: 'p1', verdict: 'hold', reason: 'over 90°F, wind over 10 mph' });
    expect(out.hold).toBe(true);
  });

  test('rain is judged only inside the product\'s rain-free hours', () => {
    const wet = hourly.map((h, i) => (i === 3 ? { ...h, rainChance: 60 } : h));
    const short = jobCard.buildSprayCheck({ products: [{ id: 'p1', rain_free_hours: 2 }], hourly: wet, now });
    expect(short.verdicts[0].verdict).toBe('ok');
    const long = jobCard.buildSprayCheck({ products: [{ id: 'p1', rain_free_hours: 4 }], hourly: wet, now });
    expect(long.verdicts[0]).toEqual({ productId: 'p1', verdict: 'hold', reason: 'rain likely inside 4 h' });
  });

  test('rain-free interval longer than the forecast coverage → unknown, never ok', () => {
    // Four clean hours cannot vouch for a six-hour interval.
    const out = jobCard.buildSprayCheck({ products: [{ id: 'p1', rain_free_hours: 6 }], hourly: hourly.slice(0, 4), now });
    expect(out.verdicts[0]).toEqual({ productId: 'p1', verdict: 'unknown', reason: 'No rain 6 h forecast' });
  });

  test('rain past the 4 h spray window still holds a long rain-free interval', () => {
    const six = [...hourly, hour(5, { rainChance: 5 })];
    const out = jobCard.buildSprayCheck({ products: [{ id: 'p1', rain_free_hours: 6 }], hourly: six, now });
    expect(out.verdicts[0]).toEqual({ productId: 'p1', verdict: 'hold', reason: 'rain likely inside 6 h' });
  });

  test('a null measurement inside the window is unknown, not a pass', () => {
    const gappy = hourly.map((h, i) => (i === 1 ? { ...h, temperatureF: null } : h));
    const out = jobCard.buildSprayCheck({ products: [{ id: 'p1', max_temp_f: 90, max_wind_mph: 10 }], hourly: gappy, now });
    expect(out.verdicts[0]).toEqual({ productId: 'p1', verdict: 'unknown', reason: 'No temperature forecast' });
    // A breach on the other limit still wins over the gap.
    const windy = gappy.map((h, i) => (i === 2 ? { ...h, windMph: 25 } : h));
    expect(jobCard.buildSprayCheck({ products: [{ id: 'p1', max_temp_f: 90, max_wind_mph: 10 }], hourly: windy, now }).verdicts[0].verdict).toBe('hold');
  });

  test('a known breach wins over a missing reading on the same limit (Codex r1 P1)', () => {
    const mixed = hourly.map((h, i) => (i === 1 ? { ...h, temperatureF: null } : i === 2 ? { ...h, temperatureF: 95 } : h));
    const out = jobCard.buildSprayCheck({ products: [{ id: 'p1', max_temp_f: 90 }], hourly: mixed, now });
    expect(out.verdicts[0]).toEqual({ productId: 'p1', verdict: 'hold', reason: 'over 90°F' });
  });

  test('temperature / wind need the whole 4 h window present to pass', () => {
    const oneHour = [hour(0)];
    const out = jobCard.buildSprayCheck({ products: [{ id: 'p1', max_temp_f: 90, max_wind_mph: 10 }], hourly: oneHour, now });
    expect(out.verdicts[0]).toEqual({ productId: 'p1', verdict: 'unknown', reason: 'No temperature / wind forecast' });
    // A breach inside the one hour still holds.
    const hotHour = [hour(0, { temperatureF: 99 })];
    expect(jobCard.buildSprayCheck({ products: [{ id: 'p1', max_temp_f: 90 }], hourly: hotHour, now }).verdicts[0].verdict).toBe('hold');
  });

  test('coverage is continuous timestamps, not a row count (Codex r2 P1)', () => {
    // 09:30 start with rows at 09:00–12:00 covers only through 13:00.
    const late = new Date(now.getTime() + 30 * 60000);
    const out = jobCard.buildSprayCheck({ products: [{ id: 'p1', max_temp_f: 90, max_wind_mph: 10 }], hourly: hourly.slice(0, 4), now: late });
    expect(out.verdicts[0]).toEqual({ productId: 'p1', verdict: 'unknown', reason: 'No temperature / wind forecast' });
    // An interior gap with both boundary hours present never passes.
    const gap = [hour(0), hour(1), hour(3)];
    expect(jobCard.buildSprayCheck({ products: [{ id: 'p1', rain_free_hours: 4 }], hourly: gap, now }).verdicts[0]).toEqual({ productId: 'p1', verdict: 'unknown', reason: 'No rain 4 h forecast' });
    // The fifth row closes a 09:30 window.
    expect(jobCard.buildSprayCheck({ products: [{ id: 'p1', max_wind_mph: 10 }], hourly: hourly.slice(0, 5).map((h) => ({ ...h, windMph: 5 })), now: late }).verdicts[0].verdict).toBe('ok');
  });

  test('rainfast_minutes is the canonical interval; rain_free_hours only fills a gap (Codex r5 P1)', () => {
    // Minutes only: 120 min = 2 h, the hour-5 rain is outside it.
    expect(jobCard.buildSprayCheck({ products: [{ id: 'p1', rainfast_minutes: 120 }], hourly, now }).verdicts[0].verdict).toBe('ok');
    // Conflicting values: minutes win over a stale 6 h legacy value.
    expect(jobCard.buildSprayCheck({ products: [{ id: 'p1', rainfast_minutes: 120, rain_free_hours: 6 }], hourly, now }).verdicts[0].verdict).toBe('ok');
    // Legacy hours alone still judge (6 h reaches the hour-5 rain).
    expect(jobCard.buildSprayCheck({ products: [{ id: 'p1', rain_free_hours: 6 }], hourly, now }).verdicts[0]).toMatchObject({ verdict: 'hold', reason: 'rain likely inside 6 h' });
  });

  test('min_temp_f is a lower bound: cold hour holds, missing coverage is unknown once (Codex r7 P1)', () => {
    const cold = hourly.map((h, i) => (i === 2 ? { ...h, temperatureF: 45 } : h));
    expect(jobCard.buildSprayCheck({ products: [{ id: 'p1', min_temp_f: 50 }], hourly: cold, now }).verdicts[0]).toEqual({ productId: 'p1', verdict: 'hold', reason: 'under 50°F' });
    expect(jobCard.buildSprayCheck({ products: [{ id: 'p1', min_temp_f: 50, max_temp_f: 90 }], hourly, now }).verdicts[0].verdict).toBe('ok');
    const gappy = hourly.map((h, i) => (i === 1 ? { ...h, temperatureF: null } : h));
    expect(jobCard.buildSprayCheck({ products: [{ id: 'p1', min_temp_f: 50, max_temp_f: 90 }], hourly: gappy, now }).verdicts[0]).toEqual({ productId: 'p1', verdict: 'unknown', reason: 'No temperature forecast' });
  });

  test('no forecast → unknown with reason', () => {
    const out = jobCard.buildSprayCheck({ products: [{ id: 'p1', max_temp_f: 90 }], hourly: null, now });
    expect(out.verdicts[0]).toEqual({ productId: 'p1', verdict: 'unknown', reason: 'No forecast' });
    expect(out.forecast).toBeNull();
  });
});

describe('buildMixAmount', () => {
  test('110 gal and 1 gal on a calibrated rig', () => {
    // 1.5 oz per 1,000 sq ft at 2 gal carrier per 1,000 → 0.75 oz per gallon.
    expect(jobCard.buildMixAmount({ ratePer1000: 1.5, rateUnit: 'oz', carrierGalPer1000: 2, gallons: 110 }))
      .toEqual({ amount: 82.5, unit: 'oz', gallons: 110, coversSqft: 55000, reason: null });
    expect(jobCard.buildMixAmount({ ratePer1000: 1.5, rateUnit: 'oz', carrierGalPer1000: 2, gallons: 1 }))
      .toEqual({ amount: 0.75, unit: 'oz', gallons: 1, coversSqft: 500, reason: null });
    // Small doses keep four decimals (Codex r6 P1): 0.113 oz/1,000 at 2 gal/1,000 for 1 gal.
    expect(jobCard.buildMixAmount({ ratePer1000: 0.113, rateUnit: 'oz', carrierGalPer1000: 2, gallons: 1 }).amount).toBe(0.0565);
  });

  test.each([
    ['missing rate', { ratePer1000: null, carrierGalPer1000: 2, gallons: 110 }, 'No verified rate on file'],
    ['expired/missing calibration', { ratePer1000: 1.5, carrierGalPer1000: null, gallons: 110 }, 'Rig not calibrated'],
    ['odd volume', { ratePer1000: 1.5, carrierGalPer1000: 2, gallons: 5 }, 'Pick 110 or 1 gallons'],
  ])('%s → null amount with reason', (_l, input, reason) => {
    expect(jobCard.buildMixAmount(input)).toMatchObject({ amount: null, reason });
  });
});

describe('property coordinates', () => {
  test.each([
    [null, null], ['', ''], [0, 0], ['91', '-82.4'], ['abc', '-82.4'],
  ])('%s / %s falls back to the office pin', (lat, lng) => {
    expect(jobCard._test.propertyCoords(lat, lng)).toBeNull();
  });
  test('a real pin is kept', () => {
    expect(jobCard._test.propertyCoords('27.4989', '-82.5748')).toEqual({ lat: 27.4989, lng: -82.5748 });
  });
});

describe('tankFromCalibrations', () => {
  const now = new Date('2026-09-04T12:00:00Z');
  test('expired calibration is not calibrated', () => {
    expect(jobCard.tankFromCalibrations([{ carrier_gal_per_1000: 2, expires_at: '2026-07-11T00:00:00Z', tank_capacity_gal: 110, system_name: 'Rig' }], now))
      .toMatchObject({ calibrated: false, reason: 'Rig calibration expired', carrierGalPer1000: 2 });
  });
  test('live calibration', () => {
    expect(jobCard.tankFromCalibrations([{ carrier_gal_per_1000: 2, expires_at: '2026-10-01T00:00:00Z', calibration_status: 'field_verified', tank_capacity_gal: 110, system_name: 'Rig' }], now))
      .toMatchObject({ calibrated: true, reason: null, tankCapacityGal: 110 });
  });
  test('unexpired but not field verified → not calibrated (Codex r3 P1, plan-engine block reused)', () => {
    expect(jobCard.tankFromCalibrations([{ carrier_gal_per_1000: 2, expires_at: '2026-10-01T00:00:00Z', calibration_status: 'estimated_not_field_verified', tank_capacity_gal: 110, system_name: 'Rig' }], now))
      .toMatchObject({ calibrated: false, reason: 'Rig calibration not field verified', carrierGalPer1000: 2 });
  });
  test('two active rigs and no assignment → ambiguous, no mix (Codex r4 P1)', () => {
    const live = { carrier_gal_per_1000: 2, expires_at: '2026-10-01T00:00:00Z', calibration_status: 'field_verified', tank_capacity_gal: 110, system_name: 'Rig' };
    expect(jobCard.tankFromCalibrations([live, { ...live, carrier_gal_per_1000: 1, system_name: 'Skid' }], now))
      .toMatchObject({ calibrated: false, reason: 'More than one rig is active — assign the rig on the Lawn plan', carrierGalPer1000: null });
  });
  test('none on file', () => {
    expect(jobCard.tankFromCalibrations([], now)).toMatchObject({ calibrated: false, reason: 'No rig calibration on file' });
  });
});

describe('access codes never enter the model-safe facts', () => {
  test('accessCodes keeps raw codes; clean() redacts a code typed into a note', () => {
    const prefs = { property_gate_code: '4545#', access_notes: 'Side gate, code 4545#' };
    expect(jobCard._test.accessCodes(prefs)).toEqual([{ label: 'Property gate', code: '4545#' }]);
    // A code typed into a free-text note is masked by the loader's clean()
    // before it can reach the template (= the model grounding).
    expect(jobCard._test.petLine({ pet_details: 'Dog; gate code 4545#' })).not.toContain('4545');
    // And the validator refuses model text that prints a known code.
    expect(jobCard.validateParagraph('Gate code 4545# on file.', 'gate code on file', [{ label: 'Property gate', code: '4545#' }])).toBe('code_leak');
  });
  test('a known code value pasted bare into any fact string is scrubbed before grounding (Codex r6 P1)', () => {
    const facts = { entry: '4545#', issues: [{ text: 'Use 4545# at the side gate' }], lastVisit: { summary: 'Fine' }, rain7d: 0.5 };
    expect(jobCard._test.scrubKnownCodes(facts, [{ label: 'Property gate', code: '4545#' }])).toEqual({
      entry: '[code]', issues: [{ text: 'Use [code] at the side gate' }], lastVisit: { summary: 'Fine' }, rain7d: 0.5,
    });
    // Codes carrying regex metacharacters are matched literally (pre-push P0).
    expect(jobCard._test.scrubKnownCodes({ entry: 'Try 12*34 or 1234+ or (77)' }, [{ code: '12*34' }, { code: '1234+' }, { code: '(77)' }])).toEqual({ entry: 'Try [code] or [code] or [code]' });
    // Nothing known → the object is untouched.
    expect(jobCard._test.scrubKnownCodes(facts, [])).toBe(facts);
  });
});

describe('resolveVisitProducts reuses the appointment plan for lawn visits (Codex r2 P1)', () => {
  const catalog = [
    { id: 'orig', name: 'Celsius WG', rate_unit: 'oz' },
    { id: 'sub', name: 'Speedzone Southern', rate_unit: 'fl oz' },
    { id: 'hyd', name: 'Hydretain ES Plus', rate_unit: 'fl oz' },
  ];
  const plan = {
    propertyGate: { month: 'Sep', visit: 9, blocks: [{ code: 'nitrogen_blackout', severity: 'block', message: 'Nitrogen blackout is active for Manatee County.' }] },
    mixCalculator: {
      items: [{ raw: 'Celsius WG 0.113 oz', role: 'base', selected: true, product: { id: 'sub' }, mix: { amount: 12.4, amountUnit: 'fl oz' }, substitution: { originalProductName: 'Celsius WG' } }],
      conditionalOptions: [{ raw: 'Premium only: Hydretain', role: 'conditional', selected: false, product: { id: 'hyd' }, mix: { amount: 6, amountUnit: 'fl oz' }, substitution: null }],
    },
  };
  const facts = { serviceId: 'svc1', isLawn: true, strip: { program: 'Lawn Care · WaveGuard platinum' } };

  test('the plan\'s substitute, its mix and the visit stamp flow into the lines', async () => {
    const buildPlan = jest.fn().mockResolvedValue(plan);
    const out = await jobCard.resolveVisitProducts({ facts, protocols: {}, catalog, dbh: () => ({}), deps: { buildPlan } });
    expect(buildPlan).toHaveBeenCalledWith('svc1', expect.objectContaining({ db: expect.any(Function) }));
    expect(out.visit).toEqual({ month: 'Sep', visit: 9 });
    // The plan's blocking conditions ride along (Codex r8 P1).
    expect(out.blocks).toEqual([{ code: 'nitrogen_blackout', message: 'Nitrogen blackout is active for Manatee County.' }]);
    expect(out.lines).toEqual([
      expect.objectContaining({ selected: true, product: catalog[1], planMix: { amount: 12.4, amountUnit: 'fl oz' }, substitutedFor: 'Celsius WG' }),
      expect.objectContaining({ selected: false, product: catalog[2], substitutedFor: null }),
    ]);
  });

  test('a plan failure yields no lines instead of a crash', async () => {
    const buildPlan = jest.fn().mockRejectedValue(new Error('Scheduled service not found'));
    const out = await jobCard.resolveVisitProducts({ facts, protocols: {}, catalog, dbh: () => ({}), deps: { buildPlan } });
    expect(out).toEqual({ visit: null, lines: [], blocks: [{ code: 'plan_unavailable', message: 'Lawn plan unavailable right now.' }] });
  });
});

describe('isTankMixable', () => {
  const { isTankMixable } = jobCard._test;
  test('granular, bait and dry-weight products stay out of the tank', () => {
    expect(isTankMixable({ name: 'Headway G', rate_unit: 'lb' })).toBe(false);
    expect(isTankMixable({ name: 'Headway G', rate_unit: 'oz' })).toBe(false);
    expect(isTankMixable({ name: 'Espoma Palm-tone', category: 'fertilizer', application_method: 'granular', rate_unit: 'oz' })).toBe(false);
    expect(isTankMixable({ name: 'Advion Ant Gel', category: 'bait', application_method: 'bait_placement', rate_unit: 'g' })).toBe(false);
  });
  test('liquids and wettable granules mix', () => {
    expect(isTankMixable({ name: 'Celsius WG', category: 'herbicide', rate_unit: 'oz' })).toBe(true);
    expect(isTankMixable({ name: 'LESCO K-Flow 0-0-25', category: 'fertilizer', rate_unit: 'fl oz' })).toBe(true);
  });
});

describe('mixForProduct', () => {
  // Generic knex-chain stub: every builder method returns the chain, the
  // terminal (.first / await) resolves the table's fixture.
  const makeDb = (fixtures) => (table) => {
    const rows = fixtures[String(table).split(" as ")[0]] ?? [];
    const chain = {};
    for (const m of ['join', 'where', 'whereIn', 'whereNotNull', 'select', 'orderByRaw', 'orderBy', 'modify']) chain[m] = () => chain;
    chain.first = async () => rows[0] ?? null;
    chain.catch = (fn) => Promise.resolve(rows).catch(fn);
    chain.then = (res, rej) => Promise.resolve(rows).then(res, rej);
    return chain;
  };
  const product = { id: 'p1', name: 'Celsius WG', default_rate_per_1000: 0.113, rate_unit: 'oz', label_verified_at: null };

  const visit = { service_type: 'Quarterly Pest Control', assigned_equipment_system_id: null, assigned_calibration_id: null };
  const lawnVisit = { ...visit, service_type: 'WaveGuard Lawn Care' };
  const live = { carrier_gal_per_1000: 2, expires_at: '2026-10-01T00:00:00Z', calibration_status: 'field_verified', tank_capacity_gal: 110, system_name: 'Rig' };
  const at = { now: new Date('2026-09-04T12:00:00Z') };

  test('a lawn visit whose plan is blocked gets no searched dose either (Codex r11 P1)', async () => {
    const dbh = makeDb({ scheduled_services: [lawnVisit], products_catalog: [product], equipment_calibrations: [live] });
    const buildPlan = jest.fn().mockResolvedValue({ propertyGate: { blocks: [{ code: 'nitrogen_blackout', message: 'Nitrogen blackout is active.' }] } });
    const out = await jobCard.mixForProduct('p1', 110, { serviceId: 'svc1', dbh, deps: { buildPlan }, ...at });
    expect(out).toMatchObject({ amount: null, reason: 'Lawn plan blocked — amounts withheld', planBlocks: [{ code: 'nitrogen_blackout', message: 'Nitrogen blackout is active.' }] });
    // A plan that fails to build is a block too.
    buildPlan.mockRejectedValue(new Error('boom'));
    expect((await jobCard.mixForProduct('p1', 110, { serviceId: 'svc1', dbh, deps: { buildPlan }, ...at })).planBlocks[0].code).toBe('plan_unavailable');
    // A pest visit never builds the plan.
    const pest = makeDb({ scheduled_services: [visit], products_catalog: [product], equipment_calibrations: [live] });
    buildPlan.mockClear();
    expect((await jobCard.mixForProduct('p1', 110, { serviceId: 'svc1', dbh: pest, deps: { buildPlan }, ...at })).amount).toBe(6.215);
    expect(buildPlan).not.toHaveBeenCalled();
  });

  test('a product the lawn plan resolved is dosed at the plan\'s rate, not the catalog default (Codex r12 P1)', async () => {
    const dbh = makeDb({ scheduled_services: [lawnVisit], products_catalog: [product], equipment_calibrations: [live] });
    // Saved substitution override: 0.2 oz/1,000 instead of the catalog's 0.113.
    const buildPlan = jest.fn().mockResolvedValue({ propertyGate: { blocks: [] }, mixCalculator: { items: [{ product: { id: 'p1' }, mix: { ratePer1000: 0.2, rateUnit: 'oz' } }], conditionalOptions: [] } });
    const out = await jobCard.mixForProduct('p1', 110, { serviceId: 'svc1', dbh, deps: { buildPlan }, ...at });
    expect(out).toMatchObject({ amount: 11, ratePer1000: 0.2, rateSource: 'plan' });
    // Not on the plan → catalog rate.
    buildPlan.mockResolvedValue({ propertyGate: { blocks: [] }, mixCalculator: { items: [], conditionalOptions: [] } });
    expect(await jobCard.mixForProduct('p1', 110, { serviceId: 'svc1', dbh, deps: { buildPlan }, ...at })).toMatchObject({ amount: 6.215, rateSource: 'catalog' });
  });

  test('no visit row → null, never a dose from an unassigned rig (Codex r9 P1)', async () => {
    const dbh = makeDb({
      products_catalog: [product],
      equipment_calibrations: [{ carrier_gal_per_1000: 2, expires_at: '2026-10-01T00:00:00Z', calibration_status: 'field_verified', tank_capacity_gal: 110, system_name: 'Rig' }],
    });
    expect(await jobCard.mixForProduct('p1', 110, { serviceId: 'svc-missing', dbh, now: new Date('2026-09-04T12:00:00Z') })).toBeNull();
    expect(await jobCard.mixForProduct('p1', 110, { dbh, now: new Date('2026-09-04T12:00:00Z') })).toBeNull();
  });

  test('expired calibration → amount withheld with the tank reason', async () => {
    const dbh = makeDb({
      scheduled_services: [visit],
      products_catalog: [product],
      equipment_calibrations: [{ carrier_gal_per_1000: 2, expires_at: '2026-07-11T00:00:00Z', tank_capacity_gal: 110, system_name: 'Rig' }],
    });
    const out = await jobCard.mixForProduct('p1', 110, { serviceId: 'svc1', dbh, now: new Date('2026-09-04T12:00:00Z') });
    expect(out).toMatchObject({ amount: null, reason: 'Rig not calibrated', tank: { calibrated: false, reason: 'Rig calibration expired' } });
  });

  test('granular product → no tank amount even on a live rig (Codex r1 P1)', async () => {
    const dbh = makeDb({
      scheduled_services: [visit],
      products_catalog: [{ id: 'hg', name: 'Headway G', default_rate_per_1000: 3, rate_unit: 'lb', label_verified_at: null }],
      equipment_calibrations: [{ carrier_gal_per_1000: 2, expires_at: '2026-10-01T00:00:00Z', calibration_status: 'field_verified', tank_capacity_gal: 110, system_name: 'Rig' }],
    });
    const out = await jobCard.mixForProduct('hg', 110, { serviceId: 'svc1', dbh, now: new Date('2026-09-04T12:00:00Z') });
    expect(out).toMatchObject({ amount: null, tankMixable: false, reason: 'Not a tank mix — apply as labeled', tank: { calibrated: true } });
  });

  test('live calibration → amount for 110 gal', async () => {
    const dbh = makeDb({
      scheduled_services: [visit],
      products_catalog: [product],
      equipment_calibrations: [{ carrier_gal_per_1000: 2, expires_at: '2026-10-01T00:00:00Z', calibration_status: 'field_verified', tank_capacity_gal: 110, system_name: 'Rig' }],
    });
    const out = await jobCard.mixForProduct('p1', 110, { serviceId: 'svc1', dbh, now: new Date('2026-09-04T12:00:00Z') });
    expect(out).toMatchObject({ amount: 6.215, unit: 'oz', gallons: 110, rateVerified: false, tankMixable: true });
  });
});

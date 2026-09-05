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
  });

  test.each([
    ['missing rate', { ratePer1000: null, carrierGalPer1000: 2, gallons: 110 }, 'No verified rate on file'],
    ['expired/missing calibration', { ratePer1000: 1.5, carrierGalPer1000: null, gallons: 110 }, 'Rig not calibrated'],
    ['odd volume', { ratePer1000: 1.5, carrierGalPer1000: 2, gallons: 5 }, 'Pick 110 or 1 gallons'],
  ])('%s → null amount with reason', (_l, input, reason) => {
    expect(jobCard.buildMixAmount(input)).toMatchObject({ amount: null, reason });
  });
});

describe('tankFromCalibration', () => {
  const now = new Date('2026-09-04T12:00:00Z');
  test('expired calibration is not calibrated', () => {
    expect(jobCard.tankFromCalibration({ carrier_gal_per_1000: 2, expires_at: '2026-07-11T00:00:00Z', tank_capacity_gal: 110, system_name: 'Rig' }, now))
      .toMatchObject({ calibrated: false, reason: 'Rig calibration expired', carrierGalPer1000: 2 });
  });
  test('live calibration', () => {
    expect(jobCard.tankFromCalibration({ carrier_gal_per_1000: 2, expires_at: '2026-10-01T00:00:00Z', tank_capacity_gal: 110, system_name: 'Rig' }, now))
      .toMatchObject({ calibrated: true, reason: null, tankCapacityGal: 110 });
  });
  test('none on file', () => {
    expect(jobCard.tankFromCalibration(null, now)).toMatchObject({ calibrated: false, reason: 'No rig calibration on file' });
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
});

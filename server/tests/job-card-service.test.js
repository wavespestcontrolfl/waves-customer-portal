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

  test('a pet-securing plan with no pet description still renders (pre-push P1)', () => {
    const text = jobCard.buildTemplateParagraph({ ...baseFacts(), petsSecured: 'dog crated in garage' });
    expect(text).toContain('Pets secured: dog crated in garage');
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

  test('a grounded number moved to another fact is rejected; rephrased in place it passes (PR r3 P2)', () => {
    const lawn = 'Pets: dog. First visit on record. Irrigation Mon/Thu, 20 min, 1.2" rain in the last 7 days.';
    expect(jobCard.validateParagraph('There are 20 dogs. Irrigation runs Mon and Thu.', lawn, [])).toBe('ungrounded_number');
    expect(jobCard.validateParagraph('One dog on site. Irrigation runs Mon and Thu for 20 min, with 1.2" of rain over the last 7 days.', lawn, [])).toBeNull();
  });

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
    const out = jobCard.buildSprayCheck({ products: [{ id: 'p1', label_verified_at: '2026-07-12', max_temp_f: 90, max_wind_mph: 10, rain_free_hours: 2 }], hourly, now });
    expect(out.verdicts[0]).toEqual({ productId: 'p1', verdict: 'ok', reason: null });
    expect(out.forecast).toMatchObject({ windMph: 5, rainPct: 10 });
  });

  test('temperature and wind breaches hold with both reasons', () => {
    const hot = hourly.map((h, i) => (i === 2 ? { ...h, temperatureF: 95, windMph: 12 } : h));
    const out = jobCard.buildSprayCheck({ products: [{ id: 'p1', label_verified_at: '2026-07-12', max_temp_f: 90, max_wind_mph: 10 }], hourly: hot, now });
    expect(out.verdicts[0]).toEqual({ productId: 'p1', verdict: 'hold', reason: 'over 90°F, wind over 10 mph' });
    expect(out.hold).toBe(true);
  });

  test('rain is judged only inside the product\'s rain-free hours', () => {
    const wet = hourly.map((h, i) => (i === 3 ? { ...h, rainChance: 60 } : h));
    const short = jobCard.buildSprayCheck({ products: [{ id: 'p1', label_verified_at: '2026-07-12', rain_free_hours: 2 }], hourly: wet, now });
    expect(short.verdicts[0].verdict).toBe('ok');
    const long = jobCard.buildSprayCheck({ products: [{ id: 'p1', label_verified_at: '2026-07-12', rain_free_hours: 4 }], hourly: wet, now });
    expect(long.verdicts[0]).toEqual({ productId: 'p1', verdict: 'hold', reason: 'rain likely inside 4 h' });
  });

  test('rain-free interval longer than the forecast coverage → unknown, never ok', () => {
    // Four clean hours cannot vouch for a six-hour interval.
    const out = jobCard.buildSprayCheck({ products: [{ id: 'p1', label_verified_at: '2026-07-12', rain_free_hours: 6 }], hourly: hourly.slice(0, 4), now });
    expect(out.verdicts[0]).toEqual({ productId: 'p1', verdict: 'unknown', reason: 'No rain 6 h forecast' });
  });

  test('rain past the 4 h spray window still holds a long rain-free interval', () => {
    const six = [...hourly, hour(5, { rainChance: 5 })];
    const out = jobCard.buildSprayCheck({ products: [{ id: 'p1', label_verified_at: '2026-07-12', rain_free_hours: 6 }], hourly: six, now });
    expect(out.verdicts[0]).toEqual({ productId: 'p1', verdict: 'hold', reason: 'rain likely inside 6 h' });
  });

  test('a null measurement inside the window is unknown, not a pass', () => {
    const gappy = hourly.map((h, i) => (i === 1 ? { ...h, temperatureF: null } : h));
    const out = jobCard.buildSprayCheck({ products: [{ id: 'p1', label_verified_at: '2026-07-12', max_temp_f: 90, max_wind_mph: 10 }], hourly: gappy, now });
    expect(out.verdicts[0]).toEqual({ productId: 'p1', verdict: 'unknown', reason: 'No temperature forecast' });
    // A breach on the other limit still wins over the gap.
    const windy = gappy.map((h, i) => (i === 2 ? { ...h, windMph: 25 } : h));
    expect(jobCard.buildSprayCheck({ products: [{ id: 'p1', label_verified_at: '2026-07-12', max_temp_f: 90, max_wind_mph: 10 }], hourly: windy, now }).verdicts[0].verdict).toBe('hold');
  });

  test('a known breach wins over a missing reading on the same limit (Codex r1 P1)', () => {
    const mixed = hourly.map((h, i) => (i === 1 ? { ...h, temperatureF: null } : i === 2 ? { ...h, temperatureF: 95 } : h));
    const out = jobCard.buildSprayCheck({ products: [{ id: 'p1', label_verified_at: '2026-07-12', max_temp_f: 90 }], hourly: mixed, now });
    expect(out.verdicts[0]).toEqual({ productId: 'p1', verdict: 'hold', reason: 'over 90°F' });
  });

  test('temperature / wind need the whole 4 h window present to pass', () => {
    const oneHour = [hour(0)];
    const out = jobCard.buildSprayCheck({ products: [{ id: 'p1', label_verified_at: '2026-07-12', max_temp_f: 90, max_wind_mph: 10 }], hourly: oneHour, now });
    expect(out.verdicts[0]).toEqual({ productId: 'p1', verdict: 'unknown', reason: 'No temperature / wind forecast' });
    // A breach inside the one hour still holds.
    const hotHour = [hour(0, { temperatureF: 99 })];
    expect(jobCard.buildSprayCheck({ products: [{ id: 'p1', label_verified_at: '2026-07-12', max_temp_f: 90 }], hourly: hotHour, now }).verdicts[0].verdict).toBe('hold');
  });

  test('coverage is continuous timestamps, not a row count (Codex r2 P1)', () => {
    // 09:30 start with rows at 09:00–12:00 covers only through 13:00.
    const late = new Date(now.getTime() + 30 * 60000);
    const out = jobCard.buildSprayCheck({ products: [{ id: 'p1', label_verified_at: '2026-07-12', max_temp_f: 90, max_wind_mph: 10 }], hourly: hourly.slice(0, 4), now: late });
    expect(out.verdicts[0]).toEqual({ productId: 'p1', verdict: 'unknown', reason: 'No temperature / wind forecast' });
    // An interior gap with both boundary hours present never passes.
    const gap = [hour(0), hour(1), hour(3)];
    expect(jobCard.buildSprayCheck({ products: [{ id: 'p1', label_verified_at: '2026-07-12', rain_free_hours: 4 }], hourly: gap, now }).verdicts[0]).toEqual({ productId: 'p1', verdict: 'unknown', reason: 'No rain 4 h forecast' });
    // The fifth row closes a 09:30 window.
    expect(jobCard.buildSprayCheck({ products: [{ id: 'p1', label_verified_at: '2026-07-12', max_wind_mph: 10 }], hourly: hourly.slice(0, 5).map((h) => ({ ...h, windMph: 5 })), now: late }).verdicts[0].verdict).toBe('ok');
  });

  test('rainfast_minutes is the canonical interval; rain_free_hours only fills a gap (Codex r5 P1)', () => {
    // Minutes only: 120 min = 2 h, the hour-5 rain is outside it.
    expect(jobCard.buildSprayCheck({ products: [{ id: 'p1', label_verified_at: '2026-07-12', rainfast_minutes: 120 }], hourly, now }).verdicts[0].verdict).toBe('ok');
    // Conflicting values: minutes win over a stale 6 h legacy value.
    expect(jobCard.buildSprayCheck({ products: [{ id: 'p1', label_verified_at: '2026-07-12', rainfast_minutes: 120, rain_free_hours: 6 }], hourly, now }).verdicts[0].verdict).toBe('ok');
    // Legacy hours alone still judge (6 h reaches the hour-5 rain).
    expect(jobCard.buildSprayCheck({ products: [{ id: 'p1', label_verified_at: '2026-07-12', rain_free_hours: 6 }], hourly, now }).verdicts[0]).toMatchObject({ verdict: 'hold', reason: 'rain likely inside 6 h' });
  });

  test('min_temp_f is a lower bound: cold hour holds, missing coverage is unknown once (Codex r7 P1)', () => {
    const cold = hourly.map((h, i) => (i === 2 ? { ...h, temperatureF: 45 } : h));
    expect(jobCard.buildSprayCheck({ products: [{ id: 'p1', label_verified_at: '2026-07-12', min_temp_f: 50 }], hourly: cold, now }).verdicts[0]).toEqual({ productId: 'p1', verdict: 'hold', reason: 'under 50°F' });
    expect(jobCard.buildSprayCheck({ products: [{ id: 'p1', label_verified_at: '2026-07-12', min_temp_f: 50, max_temp_f: 90 }], hourly, now }).verdicts[0].verdict).toBe('ok');
    const gappy = hourly.map((h, i) => (i === 1 ? { ...h, temperatureF: null } : h));
    expect(jobCard.buildSprayCheck({ products: [{ id: 'p1', label_verified_at: '2026-07-12', min_temp_f: 50, max_temp_f: 90 }], hourly: gappy, now }).verdicts[0]).toEqual({ productId: 'p1', verdict: 'unknown', reason: 'No temperature forecast' });
  });

  test('a zero rain-free interval is no rain limit at all, even at a half-hour start (Codex r14 P1)', () => {
    const late = new Date(now.getTime() + 30 * 60000);
    const wetNow = hourly.map((h, i) => (i === 0 ? { ...h, rainChance: 90 } : h));
    expect(jobCard.buildSprayCheck({ products: [{ id: 'p1', label_verified_at: '2026-07-12', rain_free_hours: 0 }], hourly: wetNow, now: late }).verdicts[0]).toEqual({ productId: 'p1', verdict: 'unknown', reason: 'No limit on file' });
    expect(jobCard.buildSprayCheck({ products: [{ id: 'p1', label_verified_at: '2026-07-12', rain_free_hours: 0, max_wind_mph: 10 }], hourly: wetNow.slice(0, 5).map((h) => ({ ...h, windMph: 5 })), now: late }).verdicts[0].verdict).toBe('ok');
  });

  test('the forecast headline keeps unmeasured wind / rain null, never 0 (PR r1 P2)', () => {
    const noWind = hourly.map((h) => ({ ...h, windMph: null, rainChance: null }));
    const out = jobCard.buildSprayCheck({ products: [{ id: 'p1', label_verified_at: '2026-07-12', max_wind_mph: 10 }], hourly: noWind, now });
    expect(out.forecast).toMatchObject({ windMph: null, rainPct: null });
    expect(out.verdicts[0].verdict).toBe('unknown');
  });

  test('unverified label limits are never judged (PR r3 P1)', () => {
    const out = jobCard.buildSprayCheck({ products: [{ id: 'p1', max_temp_f: 90 }], hourly, now });
    expect(out.verdicts[0]).toEqual({ productId: 'p1', verdict: 'unknown', reason: 'Label limits not yet verified' });
  });

  test('no forecast → unknown with reason', () => {
    const out = jobCard.buildSprayCheck({ products: [{ id: 'p1', label_verified_at: '2026-07-12', max_temp_f: 90 }], hourly: null, now });
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

describe('safety-critical facts survive the rewrite (PR r1 P1)', () => {
  test('criticalFacts lists sensitivity, pet plan, urgent issues; a rewrite that drops one falls back', () => {
    const facts = { chemicalSensitivity: 'asthma, no pyrethroids', petsSecured: 'dog crated in garage', issues: [{ urgent: true, text: 'wasps at the front door' }, { urgent: false, text: 'ants' }] };
    const critical = jobCard._test.criticalFacts(facts);
    expect(critical).toEqual(['asthma, no pyrethroids', 'dog crated in garage', 'wasps at the front door']);
    const grounding = 'Chemical sensitivity: asthma, no pyrethroids, pets: dog crated in garage. Open: URGENT wasps at the front door.';
    expect(jobCard.validateParagraph('Customer has asthma, no pyrethroids; dog crated in garage. Urgent: wasps at the front door.', grounding, [], critical)).toBeNull();
    expect(jobCard.validateParagraph('Customer has a chemical sensitivity; dog crated in garage.', grounding, [], critical)).toBe('critical_fact_dropped');
    expect(jobCard._test.criticalFacts({ chemicalSensitivity: 'yes', issues: [] })).toEqual(['sensitiv']);
  });
});

describe('non-lawn protocol text resolves products without lineMeta (PR r1 P2)', () => {
  test('primary lines are base, secondary lines are "if needed"', () => {
    const catalog = [{ id: 's', name: 'Snapshot 2.5TG', cost_per_unit: 1 }, { id: 'm', name: 'Merit 2F', cost_per_unit: 1 }];
    const visit = { primary: 'Snapshot 2.5TG Q1: 2.3 lb/1,000 sq ft beds ($17)', secondary: 'Merit 2F drench only for documented scale ($4)' };
    expect(jobCard._test.linesFromProtocolText(visit, catalog)).toEqual([
      expect.objectContaining({ product: catalog[0], role: 'base', selected: true }),
      expect.objectContaining({ product: catalog[1], role: 'conditional', selected: false }),
    ]);
  });
});

describe('lineMeta hints keep the secondary line\'s role (pre-push P1)', () => {
  test('a hint on a secondary line is conditional and unselected', () => {
    const catalog = [{ id: 'a', name: 'Advion WDG', cost_per_unit: 1 }, { id: 't', name: 'Talstar P', cost_per_unit: 1 }];
    const visit = {
      primary: 'Perimeter spray with a residual',
      secondary: 'Granular bait in mulch beds if ants are active',
      lineMeta: { 'Perimeter spray with a residual': { catalogProductHints: ['Talstar P'] }, 'Granular bait in mulch beds if ants are active': { catalogProductHints: ['Advion WDG'] } },
    };
    expect(jobCard._test.linesFromLineMeta(visit, catalog)).toEqual([
      expect.objectContaining({ product: catalog[1], role: 'base', selected: true }),
      expect.objectContaining({ product: catalog[0], role: 'conditional', selected: false }),
    ]);
  });
});

describe('serviceDayInstant (PR r3 P2)', () => {
  test('a future visit is judged at noon ET on its day; today is now', () => {
    const now = new Date('2026-09-04T18:00:00Z');
    expect(jobCard._test.serviceDayInstant('2026-09-10', now).toISOString()).toBe('2026-09-10T16:00:00.000Z');
    // Today, past noon ET → now; a morning open is judged at noon.
    expect(jobCard._test.serviceDayInstant('2026-09-04', now)).toBe(now);
    expect(jobCard._test.serviceDayInstant('2026-09-04', new Date('2026-09-04T12:00:00Z')).toISOString()).toBe('2026-09-04T16:00:00.000Z');
    expect(jobCard._test.serviceDayInstant('2026-08-01', now)).toBe(now);
  });
});

describe('order quantity (PR r1 P2)', () => {
  const { orderFor } = jobCard._test;
  test('shortage wins, then one pack in the inventory unit, then 1', () => {
    expect(orderFor({ inventory_unit: 'fl_oz' }, '2.5 gal', 3.2).quantity).toBe(3.2);
    expect(orderFor({ inventory_unit: 'fl_oz' }, '2.5 gal', null).quantity).toBe(320);
    expect(orderFor({ inventory_unit: 'gal' }, '2.5 gal', null).quantity).toBe(2.5);
    expect(orderFor({ inventory_unit: 'each' }, null, null).quantity).toBe(1);
    // An unconvertible pack unit withholds ordering (hook P1 on the add-ons PR).
    expect(orderFor({ inventory_unit: 'fl_oz' }, '1 each', null).quantity).toBeNull();
  });
});

describe('per-gallon label rates (PR r1 P2)', () => {
  test('perGallonRate parses X and X-Y with a /gal unit', () => {
    expect(jobCard._test.perGallonRate({ default_rate: '0.2-0.8', default_unit: 'fl_oz/gal' })).toEqual({ lo: 0.2, hi: 0.8, unit: 'fl_oz' });
    expect(jobCard._test.perGallonRate({ default_rate: '0.5', default_unit: 'oz/gal' })).toEqual({ lo: 0.5, hi: 0.5, unit: 'oz' });
    expect(jobCard._test.perGallonRate({ default_rate: '0.8', default_unit: 'oz/1000sf' })).toBeNull();
  });
});

describe('loadLastVisit picks the most severe finding, not the alphabetically last (Codex r13 P1)', () => {
  test('a failed history lookup is "unavailable", never "first visit" (PR r2 P2)', async () => {
    const dbh = () => { const chain = {}; for (const m of ['where', 'modify', 'orderBy', 'select']) chain[m] = () => chain; chain.first = () => ({ catch: (fn) => Promise.resolve(fn(new Error('db down'))) }); return chain; };
    expect(await jobCard._test.loadLastVisit(dbh, 'c1', 'lawn')).toEqual({ unavailable: true });
    expect(jobCard.buildTemplateParagraph({ ...baseFacts(), lastVisit: { unavailable: true } })).toContain('Visit history unavailable right now');
    expect(jobCard.buildTemplateParagraph({ ...baseFacts(), lastVisit: { unavailable: true } })).not.toContain('First visit');
  });

  test('history is strictly before the card\'s visit date (PR r3 P2)', async () => {
    const seen = [];
    const dbh = (table) => { const chain = {}; for (const m of ['orderBy', 'select']) chain[m] = () => chain; chain.modify = (fn) => { fn(chain); return chain; }; chain.where = (...a) => { seen.push(a); return chain; }; chain.first = () => ({ catch: async () => null }); return chain; };
    await jobCard._test.loadLastVisit(dbh, 'c1', 'lawn', '2026-09-04');
    expect(seen).toContainEqual(['sr.service_date', '<', '2026-09-04']);
  });

  test('critical beats medium and low', async () => {
    const tables = {
      service_records: [{ id: 'r1', service_date: '2026-08-20', service_type: 'Lawn', technician_notes: 'notes', is_callback: false }],
      service_findings: [{ title: 'Minor dollar spot', severity: 'medium' }, { title: 'Chinch bug outbreak', severity: 'critical' }, { title: 'Thin edge', severity: 'low' }],
    };
    const dbh = (table) => {
      const rows = tables[String(table).split(' as ')[0]] ?? [];
      const chain = {};
      for (const m of ['where', 'modify', 'orderBy', 'select']) chain[m] = () => chain;
      chain.first = async () => rows[0] ?? null;
      chain.catch = (fn) => Promise.resolve(rows).catch(fn);
      chain.then = (res, rej) => Promise.resolve(rows).then(res, rej);
      return chain;
    };
    const out = await jobCard._test.loadLastVisit(dbh, 'c1', 'lawn');
    expect(out.summary).toBe('Chinch bug outbreak');
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
    // Short codes are scrubbed as whole tokens (PR r2 P1): 12 on file hits "12" but not the 12 in 2026-08-12.
    expect(jobCard._test.scrubKnownCodes({ entry: 'code 12, last visit 2026-08-12, box A1' }, [{ code: '12' }, { code: 'A1' }])).toEqual({ entry: 'code [code], last visit 2026-08-12, box [code]' });
    // Case-insensitive: BLUE on file, blue in the note (PR r1 P1).
    expect(jobCard._test.scrubKnownCodes({ entry: 'say blue at the gate' }, [{ code: 'BLUE' }])).toEqual({ entry: 'say [code] at the gate' });
    expect(jobCard.validateParagraph('Say blue at the gate.', 'say blue at the gate', [{ code: 'BLUE' }])).toBe('code_leak');
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
    for (const m of ['join', 'leftJoin', 'where', 'whereIn', 'whereNotNull', 'select', 'orderByRaw', 'orderBy', 'modify']) chain[m] = () => chain;
    chain.first = async () => rows[0] ?? null;
    chain.catch = (fn) => Promise.resolve(rows).catch(fn);
    chain.then = (res, rej) => Promise.resolve(rows).then(res, rej);
    return chain;
  };
  makeDb.withRaw = (fixtures) => Object.assign(makeDb(fixtures), { raw: (sql) => sql });
  const product = { id: 'p1', name: 'Celsius WG', default_rate_per_1000: 0.113, rate_unit: 'oz', label_verified_at: '2026-07-12' };

  const visit = { customer_id: 'c1', scheduled_date: '2026-09-04', service_type: 'Quarterly Pest Control', assigned_equipment_system_id: null, assigned_calibration_id: null };
  const lawnVisit = { ...visit, service_type: 'WaveGuard Lawn Care' };
  const live = { carrier_gal_per_1000: 2, expires_at: '2026-10-01T00:00:00Z', calibration_status: 'field_verified', tank_capacity_gal: 110, system_name: 'Rig' };
  const at = { now: new Date('2026-09-04T12:00:00Z') };

  const approve = () => jest.fn().mockResolvedValue({ blocks: [], warnings: [] });

  test('a lawn visit whose plan is blocked gets no searched dose either (Codex r11 P1)', async () => {
    const dbh = makeDb.withRaw({ scheduled_services: [lawnVisit], products_catalog: [product], equipment_calibrations: [live] });
    const buildPlan = jest.fn().mockResolvedValue({ propertyGate: { blocks: [{ code: 'nitrogen_blackout', message: 'Nitrogen blackout is active.' }] } });
    const evaluateApprovals = approve();
    const out = await jobCard.mixForProduct('p1', 110, { serviceId: 'svc1', dbh, deps: { buildPlan, evaluateApprovals }, ...at });
    expect(out).toMatchObject({ amount: null, reason: 'Lawn plan blocked — amounts withheld', planBlocks: [{ code: 'nitrogen_blackout', message: 'Nitrogen blackout is active.' }] });
    // A plan that fails to build is a block too.
    buildPlan.mockRejectedValue(new Error('boom'));
    expect((await jobCard.mixForProduct('p1', 110, { serviceId: 'svc1', dbh, deps: { buildPlan, evaluateApprovals }, ...at })).planBlocks[0].code).toBe('plan_unavailable');
    // A pest visit never builds the plan nor runs approvals.
    const pest = makeDb.withRaw({ scheduled_services: [visit], products_catalog: [product], equipment_calibrations: [live] });
    buildPlan.mockClear(); evaluateApprovals.mockClear();
    expect((await jobCard.mixForProduct('p1', 110, { serviceId: 'svc1', dbh: pest, deps: { buildPlan, evaluateApprovals }, ...at })).amount).toBe(6.215);
    expect(buildPlan).not.toHaveBeenCalled();
    expect(evaluateApprovals).not.toHaveBeenCalled();
  });

  test('an off-plan searched product still faces the plan\'s guards (Codex r13 + r14 P1)', async () => {
    const urea = { id: 'n1', name: 'Urea 46-0-0', category: 'fertilizer', analysis_n: 46, analysis_p: 0, default_rate_per_1000: 2, rate_unit: 'lb' };
    const windows = [{ jurisdictionName: 'Manatee County', restrictedNitrogen: true, restrictedPhosphorus: false }];
    const cleanPlan = { propertyGate: { blocks: [], activeOrdinanceWindows: windows }, mixCalculator: { items: [], conditionalOptions: [] } };
    const buildPlan = jest.fn().mockResolvedValue(cleanPlan);
    const dbh = (rows) => makeDb.withRaw({ scheduled_services: [lawnVisit], products_catalog: rows, equipment_calibrations: [live] });
    // Ordinance blackout on an off-plan nitrogen product.
    const n = await jobCard.mixForProduct('n1', 110, { serviceId: 'svc1', dbh: dbh([urea]), deps: { buildPlan, evaluateApprovals: approve() }, ...at });
    expect(n).toMatchObject({ amount: null, reason: expect.stringContaining('Nitrogen blackout'), planBlocks: [{ code: 'nitrogen_blackout' }] });
    // The manager-approval engine judges the searched product (off-protocol,
    // conditional, PGR, max rate, rotation) with the visit's plan and rate.
    const evaluateApprovals = jest.fn().mockResolvedValue({ blocks: [{ code: 'off_protocol_product', message: 'Celsius WG is not part of the current WaveGuard protocol card.' }], warnings: [] });
    const off = await jobCard.mixForProduct('p1', 110, { serviceId: 'svc1', dbh: dbh([product]), deps: { buildPlan, evaluateApprovals }, ...at });
    expect(off).toMatchObject({ amount: null, reason: 'Celsius WG is not part of the current WaveGuard protocol card.', planBlocks: [{ code: 'off_protocol_product' }] });
    expect(evaluateApprovals).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ plan: cleanPlan, products: [{ productId: 'p1', name: 'Celsius WG', rate: 0.113, rateUnit: 'oz' }] }));
    // Approved by every guard → doses normally under the same plan.
    expect((await jobCard.mixForProduct('p1', 110, { serviceId: 'svc1', dbh: dbh([product]), deps: { buildPlan, evaluateApprovals: approve() }, ...at })).amount).toBe(6.215);
  });

  test('a per-gallon pest product dilutes straight into the tank, range and all (PR r1 P2)', async () => {
    const demand = { id: 'd', name: 'Demand CS', category: 'insecticide', default_rate_per_1000: null, rate_unit: null, default_rate: '0.2-0.8', default_unit: 'fl_oz/gal', label_verified_at: '2026-07-12' };
    const dbh = makeDb.withRaw({ scheduled_services: [visit], products_catalog: [demand], equipment_calibrations: [] });
    const out = await jobCard.mixForProduct('d', 110, { serviceId: 'svc1', dbh, ...at });
    expect(out).toMatchObject({ amount: 22, amountMax: 88, unit: 'fl_oz', gallons: 110, basis: 'per_gallon', reason: null, ratePerGallon: { lo: 0.2, hi: 0.8, unit: 'fl_oz' }, rateVerified: true });
    expect((await jobCard.mixForProduct('d', 1, { serviceId: 'svc1', dbh, ...at })).amount).toBe(0.2);
  });

  test('a product the lawn plan resolved is dosed at the plan\'s rate, not the catalog default (Codex r12 P1)', async () => {
    const dbh = makeDb.withRaw({ scheduled_services: [lawnVisit], products_catalog: [product], equipment_calibrations: [live] });
    // Saved substitution override: 0.2 oz/1,000 instead of the catalog's 0.113.
    const buildPlan = jest.fn().mockResolvedValue({ propertyGate: { blocks: [] }, mixCalculator: { items: [{ product: { id: 'p1' }, mix: { ratePer1000: 0.2, rateUnit: 'oz' } }], conditionalOptions: [] } });
    const out = await jobCard.mixForProduct('p1', 110, { serviceId: 'svc1', dbh, deps: { buildPlan, evaluateApprovals: approve() }, ...at });
    expect(out).toMatchObject({ amount: 11, ratePer1000: 0.2, rateSource: 'plan' });
    // Not on the plan → catalog rate.
    buildPlan.mockResolvedValue({ propertyGate: { blocks: [] }, mixCalculator: { items: [], conditionalOptions: [] } });
    expect(await jobCard.mixForProduct('p1', 110, { serviceId: 'svc1', dbh, deps: { buildPlan, evaluateApprovals: approve() }, ...at })).toMatchObject({ amount: 6.215, rateSource: 'catalog' });
  });

  test('no visit row → null, never a dose from an unassigned rig (Codex r9 P1)', async () => {
    const dbh = makeDb.withRaw({
      products_catalog: [product],
      equipment_calibrations: [{ carrier_gal_per_1000: 2, expires_at: '2026-10-01T00:00:00Z', calibration_status: 'field_verified', tank_capacity_gal: 110, system_name: 'Rig' }],
    });
    expect(await jobCard.mixForProduct('p1', 110, { serviceId: 'svc-missing', dbh, now: new Date('2026-09-04T12:00:00Z') })).toBeNull();
    expect(await jobCard.mixForProduct('p1', 110, { dbh, now: new Date('2026-09-04T12:00:00Z') })).toBeNull();
  });

  test('expired calibration → amount withheld with the tank reason', async () => {
    const dbh = makeDb.withRaw({
      scheduled_services: [visit],
      products_catalog: [product],
      equipment_calibrations: [{ carrier_gal_per_1000: 2, expires_at: '2026-07-11T00:00:00Z', tank_capacity_gal: 110, system_name: 'Rig' }],
    });
    const out = await jobCard.mixForProduct('p1', 110, { serviceId: 'svc1', dbh, now: new Date('2026-09-04T12:00:00Z') });
    expect(out).toMatchObject({ amount: null, reason: 'Rig not calibrated', tank: { calibrated: false, reason: 'Rig calibration expired' } });
  });

  test('granular product → no tank amount even on a live rig (Codex r1 P1)', async () => {
    const dbh = makeDb.withRaw({
      scheduled_services: [visit],
      products_catalog: [{ id: 'hg', name: 'Headway G', default_rate_per_1000: 3, rate_unit: 'lb', label_verified_at: null }],
      equipment_calibrations: [{ carrier_gal_per_1000: 2, expires_at: '2026-10-01T00:00:00Z', calibration_status: 'field_verified', tank_capacity_gal: 110, system_name: 'Rig' }],
    });
    const out = await jobCard.mixForProduct('hg', 110, { serviceId: 'svc1', dbh, now: new Date('2026-09-04T12:00:00Z') });
    expect(out).toMatchObject({ amount: null, tankMixable: false, reason: 'Not a tank mix — apply as labeled', tank: { calibrated: true } });
  });

  test('an unverified label rate gets no dose on either basis (PR r2 P1)', async () => {
    const dbh = makeDb.withRaw({ scheduled_services: [visit], products_catalog: [{ ...product, label_verified_at: null }], equipment_calibrations: [live] });
    expect(await jobCard.mixForProduct('p1', 110, { serviceId: 'svc1', dbh, ...at })).toMatchObject({ amount: null, reason: 'Label rate not yet verified', rateVerified: false });
    const gal = makeDb.withRaw({ scheduled_services: [visit], products_catalog: [{ id: 'd', name: 'Demand CS', default_rate: '0.2-0.8', default_unit: 'fl_oz/gal', label_verified_at: null }], equipment_calibrations: [] });
    expect((await jobCard.mixForProduct('d', 110, { serviceId: 'svc1', dbh: gal, ...at })).amount).toBeNull();
  });

  test('live calibration → amount for 110 gal', async () => {
    const dbh = makeDb.withRaw({
      scheduled_services: [visit],
      products_catalog: [product],
      equipment_calibrations: [{ carrier_gal_per_1000: 2, expires_at: '2026-10-01T00:00:00Z', calibration_status: 'field_verified', tank_capacity_gal: 110, system_name: 'Rig' }],
    });
    const out = await jobCard.mixForProduct('p1', 110, { serviceId: 'svc1', dbh, now: new Date('2026-09-04T12:00:00Z') });
    expect(out).toMatchObject({ amount: 6.215, unit: 'oz', gallons: 110, rateVerified: true, tankMixable: true });
  });
});

describe('PR review r4', () => {
  const failing = (fail, rows = []) => {
    const chain = {};
    for (const m of ['where', 'whereNotIn', 'orderBy', 'select', 'limit', 'modify', 'whereIn']) chain[m] = () => chain;
    chain.orderByRaw = (sql) => { chain.orderByRawSql = sql; return chain; };
    chain.catch = (fn) => (fail ? Promise.resolve(fn(new Error('db down'))) : Promise.resolve(rows));
    return chain;
  };

  test('open requests are read urgent-first so the three-row cutoff never hides an urgent one (hook P1)', async () => {
    const chains = {};
    const dbh = (table) => { chains[table] = failing(false); return chains[table]; };
    await jobCard._test.loadOpenIssues(dbh, 'c1');
    expect(chains.service_requests.orderByRawSql).toBe("CASE WHEN urgency = 'urgent' THEN 0 ELSE 1 END");
  });

  test('the searched dose runs the approval engine strict; a failed approval read withholds the dose (hook P1)', async () => {
    const { mixForProduct } = jobCard;
    const visit = { id: 'svc1', customer_id: 'c1', scheduled_date: '2026-09-04', service_type: 'WaveGuard Lawn Care', assigned_equipment_system_id: null, assigned_calibration_id: null };
    const product = { id: 'p1', name: 'Celsius WG', default_rate_per_1000: 0.113, rate_unit: 'oz', label_verified_at: '2026-08-01' };
    const live = { carrier_gal_per_1000: 2, expires_at: '2026-10-01T00:00:00Z', calibration_status: 'field_verified', tank_capacity_gal: 110 };
    const rows = { scheduled_services: [visit], products_catalog: [product], equipment_calibrations: [live], distributor_product_map: [] };
    const dbh = (t) => {
      const table = String(t).split(' as ')[0];
      const chain = {};
      for (const m of ['where', 'whereIn', 'whereNotNull', 'whereNull', 'orderBy', 'select', 'modify', 'andWhere', 'join', 'leftJoin', 'limit']) chain[m] = () => chain;
      chain.first = () => Promise.resolve((rows[table] || [])[0] || null);
      chain.then = (res, rej) => Promise.resolve(rows[table] || []).then(res, rej);
      chain.catch = (fn) => Promise.resolve(rows[table] || []).catch(fn);
      return chain;
    };
    dbh.raw = (sql) => sql;
    const buildPlan = jest.fn().mockResolvedValue({ propertyGate: { blocks: [] }, mixCalculator: { items: [] } });
    const evaluateApprovals = jest.fn().mockRejectedValue(new Error('rotation read failed'));
    const out = await mixForProduct('p1', 110, { serviceId: 'svc1', dbh, deps: { buildPlan, evaluateApprovals }, now: new Date('2026-09-04T12:00:00Z') });
    expect(evaluateApprovals.mock.calls[0][1]).toMatchObject({ strict: true });
    expect(out.amount).toBeNull();
    expect(out.planBlocks[0].code).toBe('approvals_unavailable');
  });

  test('a failed open-requests read fails the card (503), never "nothing open" (P1)', async () => {
    const dbh = (table) => failing(table === 'service_requests');
    await expect(jobCard._test.loadOpenIssues(dbh, 'c1')).rejects.toMatchObject({ statusCode: 503, message: 'Open requests unavailable' });
    const complaints = (table) => failing(table === 'customer_interactions');
    await expect(jobCard._test.loadOpenIssues(complaints, 'c1')).rejects.toMatchObject({ statusCode: 503 });
  });

  test('a complaint is recent history with its date, never an open issue (P2)', async () => {
    const dbh = (table) => failing(false, table === 'customer_interactions' ? [{ subject: 'Ants came back', created_at: new Date('2026-08-20T15:00:00Z') }] : []);
    const out = await jobCard._test.loadOpenIssues(dbh, 'c1');
    expect(out).toEqual({ issues: [], recentComplaints: [{ date: '2026-08-20', text: 'Ants came back' }] });
    const text = jobCard.buildTemplateParagraph({ ...baseFacts(), ...out });
    expect(text).toBe('First visit on record, recent complaints: 2026-08-20 Ants came back.');
    expect(text).not.toContain('open:');
  });

  test('calls come from the canonical reader, since the last visit; a failed read is said, not "no calls" (P1)', async () => {
    const getRecentCalls = jest.fn(async () => [
      { call_summary: 'Asked about ants', direction: 'inbound', created_at: new Date('2026-08-20T15:00:00Z') },
      // Same calendar day as the visit but BEFORE its start (r5 P2): not "since".
      { call_summary: 'Morning call', direction: 'inbound', created_at: new Date('2026-08-12T13:00:00Z') },
      { call_summary: 'Old call', direction: 'inbound', created_at: new Date('2026-08-01T15:00:00Z') },
    ]);
    const calls = await jobCard._test.loadCallsSince('c1', new Date('2026-08-12T14:30:00Z'), { getRecentCalls });
    expect(getRecentCalls).toHaveBeenCalledWith('c1', { sentinelOnError: true });
    expect(calls).toEqual([{ summary: 'Asked about ants', direction: 'inbound', date: '2026-08-20' }]);
    expect(await jobCard._test.loadCallsSince('c1', null, { getRecentCalls: async () => null })).toBeNull();
    expect(jobCard.buildTemplateParagraph({ ...baseFacts(), calls: null })).toBe('First visit on record, call history unavailable right now.');
  });

  test('the template is bounded to 60 words and keeps the safety-critical facts (P2)', () => {
    const long = (w) => Array.from({ length: 14 }, (_, i) => `${w}${i}`).join(' ');
    const facts = {
      ...baseFacts(),
      pets: 'two dogs',
      petsSecured: 'crated in garage',
      chemicalSensitivity: 'asthma',
      entry: long('entry'),
      parking: long('park'),
      instructions: long('inst'),
      visitNotes: long('note'),
      lastVisit: { date: '2026-08-12', summary: long('sum'), callback: true },
      issues: [{ text: 'Ants in kitchen', urgent: true }, { text: long('issue'), urgent: false }],
      recentComplaints: [{ date: '2026-08-20', text: long('cmp') }],
      calls: [{ date: '2026-08-21', summary: long('call') }],
    };
    const text = jobCard.buildTemplateParagraph(facts, { isLawn: true });
    expect(text.split(/\s+/).length).toBeLessThanOrEqual(60);
    expect(jobCard.validateParagraph(text, text, [], jobCard._test.criticalFacts(facts))).toBeNull();
    expect(text).toContain('Pets: two dogs (crated in garage)');
    expect(text).toContain('chemical sensitivity: asthma');
    expect(text).toContain('open: URGENT Ants in kitchen');
    expect(text).toContain('Last visit 2026-08-12 (callback)');
    expect(text).toContain('No irrigation on file');
    expect(text).not.toContain('park0');
    // Short facts are untouched.
    expect(jobCard.buildTemplateParagraph({ ...baseFacts(), pets: 'dog' })).toBe('Pets: dog. First visit on record.');
  });

  test('a failed catalog read is an outage (503), not an empty protocol (P2)', async () => {
    const dbh = () => failing(true);
    await expect(jobCard._test.loadCatalog(dbh)).rejects.toMatchObject({ statusCode: 503, message: 'Product catalog unavailable' });
  });

  test('precautions include the product-specific pet / child guidance (P2)', () => {
    const text = jobCard._test.precautionText({ customer_safety_summary: 'Keep off until dry.', pet_kid_guidance_text: 'Do not disturb bait stations.', reentry_text: 'Re-entry 2 h.' });
    expect(text).toBe('Keep off until dry. Do not disturb bait stations. Re-entry 2 h.');
  });

  test('the cached best price is owner-only: absent unless the viewer may see pricing (P1)', () => {
    const product = { inventory_unit: 'gal', best_price_amount_cached: '129.5' };
    expect(jobCard._test.orderFor(product, null, null)).not.toHaveProperty('lastPrice');
    expect(jobCard._test.orderFor(product, null, null, { includePricing: true }).lastPrice).toBe(129.5);
  });
});

describe('PR review r5', () => {
  test('a lapsed away-mode date is not "customer away" (hook P1)', () => {
    const now = new Date('2026-09-04T16:00:00Z');
    expect(jobCard._test.awayUntil({ away_mode_until: '2026-08-01' }, now)).toBeNull();
    expect(jobCard._test.awayUntil({ away_mode_until: '2026-09-04' }, now)).toBe('2026-09-04');
    expect(jobCard._test.awayUntil({ away_mode_until: '2026-09-10' }, now)).toBe('2026-09-10');
    expect(jobCard._test.awayUntil({}, now)).toBeNull();
  });

  test('a month-keyed program resolves by the appointment month; "Any" programs keep the matcher pick (P1)', async () => {
    const program = { visits: [{ visit: 1, month: 'Jan', primary: 'Celsius WG 1 oz' }, { visit: 9, month: 'Sep', primary: 'Speedzone Southern 1 fl oz' }] };
    expect(jobCard._test.seasonalVisit(program, '2026-09-04').visit).toBe(9);
    expect(jobCard._test.seasonalVisit(program, '2026-01-15').visit).toBe(1);
    expect(jobCard._test.seasonalVisit({ visits: [{ visit: 1, month: 'Any' }] }, '2026-09-04')).toBeNull();
    expect(jobCard._test.seasonalVisit(program, null)).toBeNull();
    const catalog = [{ id: 'c', name: 'Celsius WG' }, { id: 's', name: 'Speedzone Southern' }];
    const out = await jobCard.resolveVisitProducts({ facts: { isLawn: false, serviceType: 'Tree & Shrub Care', scheduledDate: '2026-09-04' }, protocols: { tree_shrub: program }, catalog, dbh: () => ({}) });
    expect(out.visit.visit).toBe(9);
    expect(out.lines.map((l) => l.product.id)).toEqual(['s']);
  });

  test('a lawn card withholds the plan amount for an unverified label rate (P1)', async () => {
    const line = (product) => ({ raw: 'x', role: 'base', selected: true, product, planMix: { amount: 12.4, amountUnit: 'fl oz' } });
    const facts = { customerId: 'c1', scheduledDate: '2026-09-04' };
    const [unverified] = await jobCard._test.buildProductCards({ facts, lines: [line({ id: 'p', name: 'P', rate_unit: 'fl oz', label_verified_at: null })], verdicts: [], packSizes: {} });
    expect(unverified.planned).toBeNull();
    expect(unverified.amountNote).toBe('Label rate not yet verified — amount withheld');
    const [verified] = await jobCard._test.buildProductCards({ facts, lines: [line({ id: 'p', name: 'P', rate_unit: 'fl oz', label_verified_at: '2026-08-01' })], verdicts: [], packSizes: {} });
    expect(verified.planned).toEqual({ amount: 12.4, unit: 'fl oz' });
    expect(verified.amountNote).toBeNull();
  });

  test('rotation history covers MOA-only products (P2)', async () => {
    const seen = [];
    const dbh = (table) => {
      seen.push(table);
      const chain = {};
      for (const m of ['join', 'leftJoin', 'where', 'modify', 'orderBy', 'select', 'limit']) chain[m] = () => chain;
      chain.catch = async () => [{ service_date: '2026-06-10', product_name: 'Bifen IT' }];
      return chain;
    };
    const note = await jobCard._test.rotationNote(dbh, { customerId: 'c1', scheduledDate: '2026-09-04' }, { name: 'Talstar P', moa_group: '3A' });
    expect(note).toBe('MOA 3A last used 2026-06-10 (Bifen IT)');
    expect(seen).toContain('service_products as sp');
  });
});

describe('PR review r6', () => {
  test('a blocked plan still computes the shortage and the order quantity (hook P1)', async () => {
    const product = { id: 'p', name: 'P', rate_unit: 'fl oz', inventory_on_hand: 1, inventory_unit: 'fl oz', label_verified_at: '2026-08-01' };
    const line = { raw: 'x', role: 'base', selected: true, product, planMix: { amount: 12.4, amountUnit: 'fl oz' } };
    const [card] = await jobCard._test.buildProductCards({ facts: { customerId: 'c1', scheduledDate: '2026-09-04' }, lines: [line], verdicts: [], packSizes: {}, blocked: true });
    expect(card.planned).toBeNull();
    expect(card.short).toBe(true);
    expect(card.order.quantity).toBeCloseTo(11.4, 2);
  });

  test('a rig that lapsed after noon withholds the card amounts with the tank reason (hook P1)', async () => {
    const line = { raw: 'x', role: 'base', selected: true, product: { id: 'p', name: 'P', rate_unit: 'fl oz', label_verified_at: '2026-08-01' }, planMix: { amount: 12.4, amountUnit: 'fl oz' } };
    const facts = { customerId: 'c1', scheduledDate: '2026-09-04' };
    const [card] = await jobCard._test.buildProductCards({ facts, lines: [line], verdicts: [], packSizes: {}, tankReason: 'Rig calibration expired' });
    expect(card.planned).toBeNull();
    expect(card.amountNote).toBe('Rig calibration expired — amount withheld');
    const [ok] = await jobCard._test.buildProductCards({ facts, lines: [line], verdicts: [], packSizes: {}, tankReason: null });
    expect(ok.planned).toEqual({ amount: 12.4, unit: 'fl oz' });
    // The boundary: a calibration valid at noon but expired by the time the card opens.
    const cal = { carrier_gal_per_1000: 2, expires_at: '2026-09-04T18:00:00Z', calibration_status: 'field_verified', tank_capacity_gal: 110 };
    expect(jobCard.tankFromCalibrations([cal], new Date('2026-09-04T16:00:00Z')).calibrated).toBe(true);
    expect(jobCard.tankFromCalibrations([cal], new Date('2026-09-04T20:00:00Z')).calibrated).toBe(false);
  });

  test('the lawn plan is built strict so a catalog outage is a plan block, not an empty card (P2)', async () => {
    const buildPlan = jest.fn().mockRejectedValue(new Error('products_catalog down'));
    const out = await jobCard.resolveVisitProducts({ facts: { isLawn: true, serviceId: 'svc1' }, protocols: {}, catalog: [], dbh: () => ({}), deps: { buildPlan } });
    expect(buildPlan.mock.calls[0][1]).toMatchObject({ strict: true });
    expect(out.blocks[0].code).toBe('plan_unavailable');
  });

  test('a failed findings read makes the history unavailable, never "no findings" (P2)', async () => {
    const dbh = (table) => {
      const chain = {};
      for (const m of ['where', 'modify', 'orderBy', 'select']) chain[m] = () => chain;
      chain.first = () => ({ catch: async () => ({ id: 'r1', service_date: '2026-08-12', technician_notes: 'fine' }) });
      chain.catch = (fn) => (table === 'service_findings' ? Promise.resolve(fn(new Error('db down'))) : Promise.resolve([]));
      return chain;
    };
    expect(await jobCard._test.loadLastVisit(dbh, 'c1', 'lawn')).toEqual({ unavailable: true });
  });

  test('a failed pack-size read withholds ordering (P2)', async () => {
    const dbh = () => { const chain = {}; for (const m of ['whereIn', 'whereNotNull', 'where', 'orderBy', 'select']) chain[m] = () => chain; chain.catch = (fn) => Promise.resolve(fn(new Error('db down'))); return chain; };
    expect(await jobCard._test.loadPackSizes(dbh, ['p'])).toBeNull();
    const line = { raw: 'x', role: 'base', selected: true, product: { id: 'p', name: 'P', rate_unit: 'fl oz', label_verified_at: '2026-08-01' } };
    const [card] = await jobCard._test.buildProductCards({ facts: { customerId: 'c1', scheduledDate: '2026-09-04' }, lines: [line], verdicts: [], packSizes: null });
    expect(card.order).toBeNull();
    const [ok] = await jobCard._test.buildProductCards({ facts: { customerId: 'c1', scheduledDate: '2026-09-04' }, lines: [line], verdicts: [], packSizes: {} });
    expect(ok.order.quantity).toBe(1);
  });

  test('a current away date is a critical fact the rewrite may not drop (P2)', () => {
    const facts = { ...baseFacts(), awayUntil: '2026-09-10' };
    expect(jobCard._test.criticalFacts(facts)).toContain('2026-09-10');
    const template = jobCard.buildTemplateParagraph(facts);
    expect(jobCard.validateParagraph('First visit on record.', template, [], jobCard._test.criticalFacts(facts))).toBe('critical_fact_dropped');
  });
});

describe('PR review r7 (Adam-authorized r8 for the small guards)', () => {
  const factsDb = (rows) => {
    const dbh = (table) => {
      const chain = {};
      for (const m of ['join', 'leftJoin', 'where', 'whereNotIn', 'whereIn', 'modify', 'orderBy', 'orderByRaw', 'select', 'limit', 'whereNotNull']) chain[m] = () => chain;
      const value = rows[table];
      chain.first = () => Object.assign(Promise.resolve(value ?? null), { catch: async () => value ?? null });
      chain.catch = async () => (Array.isArray(value) ? value : []);
      return chain;
    };
    dbh.raw = (sql) => sql;
    return dbh;
  };
  const prefs = { property_gate_code: '4545#', access_notes: 'Side gate', parking_notes: 'Driveway', pet_details: 'dog', watering_days: '["Mon"]' };
  const visit = (address_diverges) => ({ id: 'svc1', customer_id: 'c1', scheduled_date: '2026-09-04', service_type: 'Quarterly Pest Control', first_name: 'A', last_name: 'B', address_diverges, notes: 'Try 4545# first' });

  test('a visit stamped at a divergent address shows none of the primary home\'s codes, entry, parking (P1)', async () => {
    const deps = { getRecentCalls: async () => [] };
    const away = await jobCard.loadJobCardFacts('svc1', factsDb({ 'scheduled_services as ss': visit(true), property_preferences: prefs }), deps);
    expect(away.access.codes).toEqual([]);
    expect(away.facts).toMatchObject({ gates: [], entry: '', parking: '', alternateAddress: true, pets: 'dog' });
    expect(jobCard.buildTemplateParagraph(away.facts)).toContain('visit at a non-primary address');
    // The primary home's code is still scrubbed from notes and still a leak check for the rewrite (hook P1).
    expect(away.facts.visitNotes).toBe('Try [code] first');
    expect(away.knownCodes).toEqual([{ label: 'Property gate', code: '4545#' }]);
    const home = await jobCard.loadJobCardFacts('svc1', factsDb({ 'scheduled_services as ss': visit(false), property_preferences: prefs }), deps);
    expect(home.access.codes).toEqual([{ label: 'Property gate', code: '4545#' }]);
    expect(home.facts).toMatchObject({ gates: ['Property gate'], entry: 'Side gate', parking: 'Driveway', alternateAddress: false });
  });

  test('pet presence is a critical fact even without a securing plan (P1)', () => {
    const facts = { ...baseFacts(), pets: 'dog' };
    expect(jobCard._test.criticalFacts(facts)).toContain('dog');
    expect(jobCard.validateParagraph('First visit on record.', jobCard.buildTemplateParagraph(facts), [], jobCard._test.criticalFacts(facts))).toBe('critical_fact_dropped');
  });
});

describe('PR review r8', () => {
  test('a failed product_aliases read is the catalog outage (P2)', async () => {
    const dbh = (table) => {
      const chain = {};
      for (const m of ['where', 'whereIn', 'select']) chain[m] = () => chain;
      chain.catch = (fn) => (table === 'product_aliases' ? Promise.resolve(fn(new Error('db down'))) : Promise.resolve([{ id: 'p', name: 'P' }]));
      return chain;
    };
    await expect(jobCard._test.loadCatalog(dbh)).rejects.toMatchObject({ statusCode: 503, message: 'Product catalog unavailable' });
  });

  test('pack sizes come from the active verified mapping, highest confidence first; case_quantity is never a pack (P2 + hook P1)', async () => {
    const seen = [];
    const dbh = () => {
      const chain = {};
      for (const m of ['whereIn', 'whereNotNull', 'orderBy', 'select']) chain[m] = () => chain;
      chain.where = (arg) => { seen.push(arg); return chain; };
      chain.catch = async () => [
        { product_id: 'a', pack_size: '2.5 gal', case_quantity: '2', uom: 'gal' },
        { product_id: 'a', pack_size: '1 gal' },
        { product_id: 'b', pack_size: '32 fl_oz' },
      ];
      return chain;
    };
    expect(await jobCard._test.loadPackSizes(dbh, ['a', 'b', 'c'])).toEqual({ a: '2.5 gal', b: '32 fl_oz' });
    expect(seen).toContainEqual({ active: true, mapping_status: 'verified' });
  });
});

describe('follow-up PR: add-on lines + tank-search spray check', () => {
  test('the primary line is gated by catalog identity too; legacy rows keep the name match (hook P1)', async () => {
    const protocols = { pest: { visits: [{ visit: 1, month: 'Any', primary: 'Demand CS 0.4 fl oz/gal' }] }, cockroach: { visits: [{ visit: 1, month: 'Any', primary: 'Advion Gel 1 tube' }] }, bed_bug: { visits: [{ visit: 1, month: 'Any', primary: 'CrossFire 13 fl oz/gal' }] } };
    const catalog = [{ id: 'd', name: 'Demand CS' }, { id: 'a', name: 'Advion Gel' }, { id: 'x', name: 'CrossFire' }];
    const run = (serviceType, serviceCategory) => jobCard.resolveVisitLines({ facts: { isLawn: false, serviceType, serviceCategory, scheduledDate: '2026-09-04', addons: [] }, protocols, catalog, dbh: () => ({}) });
    const inspection = await run('Pest Inspection Service', 'inspection');
    expect(inspection.lines).toEqual([]);
    expect(inspection.note).toBe('No treatment protocol for this service (inspection)');
    // Specialty (r3 P2): the bed-bug treatment's catalog category is
    // `specialty`; its name resolves the bed-bug program, while the rest of
    // the grab-bag (wildlife, tick, the general appointment) has no default.
    expect((await run('Bed Bug Treatment', 'specialty')).lines.map((l) => l.product.id)).toEqual(['x']);
    const wildlife = await run('Wildlife Trapping Service', 'specialty');
    expect(wildlife.lines).toEqual([]);
    expect(wildlife.note).toBe('No treatment protocol for this service (specialty)');
    expect((await run('Bed Bug Inspection', 'inspection')).lines).toEqual([]);
    expect((await run('Initial German Roach Knockdown', 'pest_control')).lines.map((l) => l.product.id)).toEqual(['a']);
    expect((await run('Quarterly Pest Control', 'pest_control')).lines.map((l) => l.product.id)).toEqual(['d']);
    // No identity (legacy row) → the name match as before.
    expect((await run('Quarterly Pest Control', null)).lines.map((l) => l.product.id)).toEqual(['d']);
    // A lawn-named inspection never builds the lawn plan (hook P1).
    const buildPlan = jest.fn();
    const lawnInspection = await jobCard.resolveVisitLines({ facts: { isLawn: true, serviceId: 'svc1', serviceType: 'Lawn Assessment Service', serviceCategory: 'inspection', scheduledDate: '2026-09-04', addons: [] }, protocols, catalog, dbh: () => ({}), deps: { buildPlan } });
    expect(buildPlan).not.toHaveBeenCalled();
    expect(lawnInspection.lines).toEqual([]);
    expect(lawnInspection.note).toBe('No treatment protocol for this service (inspection)');
  });

  test('card line text keeps the instruction, never the dosing value (hook P1)', () => {
    const { describeLine } = jobCard._test;
    expect(describeLine('Celsius WG 0.113 oz per 1,000 sq ft if rotation calls for IRAC 7C')).toBe('Celsius WG if rotation calls for IRAC 7C');
    expect(describeLine('Distance IGR 6 fl oz/100 gal foliar, only if crawlers are present')).toBe('Distance IGR foliar, only if crawlers are present');
    expect(describeLine('Headway G 3 lbs/1000 broadcast')).toBe('Headway G broadcast');
    expect(describeLine('IMA-jet or Propizol only when diagnosis supports it')).toBe('IMA-jet or Propizol only when diagnosis supports it');
    // Real protocol formats (hook P1): percentages, ranges, per-100-gal, tsp/gal, and owner prices.
    expect(describeLine('TriTek spray oil: 1.0% standard, 1.5% only with active scale/mites and safe weather ($6.08)')).toBe('TriTek spray oil: standard, only with active scale/mites and safe weather');
    expect(describeLine('TriTek spray oil: 1.0-1.5% only if safe ($6.08)')).toBe('TriTek spray oil: only if safe');
    expect(describeLine('KPHITE 7LP: 1-2 qt/100 gal, FRAC P07 where root/oomycete risk is justified ($4.68)')).toBe('KPHITE 7LP: FRAC P07 where root/oomycete risk is justified');
    expect(describeLine('Liquid copper (Southern Ag 27.15%): 1-2 tsp/gal for labeled leaf spot, separate from oil ($11.35)')).toBe('Liquid copper (Southern Ag): for labeled leaf spot, separate from oil');
    expect(describeLine('Mainspring GNL: 4-8 fl oz/100 gal, IRAC 28 where target pest fits ($26.98)')).toBe('Mainspring GNL: IRAC 28 where target pest fits');
    expect(describeLine('LESCO 24-0-11 75% PolyPlus fert ($8.68)')).toBe('LESCO 24-0-11 PolyPlus fert');
  });

  test('a lineMeta line phrased "if …" stays conditional too (hook P1)', () => {
    const catalog = [{ id: 't', name: 'TriTek' }, { id: 'c', name: 'Celsius WG' }];
    const visit = {
      primary: 'Celsius WG 1 oz\nTriTek 1 gal only if crawlers are present',
      secondary: '',
      lineMeta: { 'Celsius WG 1 oz': { catalogProductHints: ['Celsius WG'] }, 'TriTek 1 gal only if crawlers are present': { catalogProductHints: ['TriTek'] } },
    };
    expect(jobCard._test.linesFromLineMeta(visit, catalog).map((l) => [l.product.id, l.role, l.selected])).toEqual([['c', 'base', true], ['t', 'conditional', false]]);
  });

  test('non-"if" conditions on primary lines are conditional too; placement and legality phrasing is not (r3 P2)', () => {
    const { isConditionalLine, linesFromProtocolText, linesFromLineMeta } = jobCard._test;
    for (const raw of [
      'KPHITE 7LP: 1-2 qt/100 gal, FRAC P07 where root/oomycete risk is justified ($4.68)',
      'Liquid copper (Southern Ag 27.15%): 1-2 tsp/gal for labeled leaf spot/bacterial disease, separate from oil ($11.35)',
      'TriTek spray oil: 1.0% early morning only when plant/weather safe ($6.08)',
      'Fe/Mn micros: label rate where deficiency symptoms justify ($2.85)',
      'Mainspring GNL: 4-8 fl oz/100 gal, IRAC 28 where target pest fits ($26.98)',
      'Kelp/humates via NutriRoot drench — premium/stressed accounts only ($5.65)',
      '13-0-13 ornamental fertilizer: 0.25-0.50 lb N/1,000 sq ft equivalent where needed ($4.32)',
      'Floramite for confirmed mites ($6.02)',
      'Spot treat cracks, crevices, or harborages as needed',
    ]) expect([raw, isConditionalLine(raw)]).toEqual([raw, true]);
    for (const raw of [
      'Talus IGR: label rate for whitefly/scale nymphs, IRAC 16 ($4.69)',
      'Kontos: 1.7-3.4 fl oz/100 gal, IRAC 23 ($13.52)',
      'IGR where label allows',
      '8-2-12 palm fertilizer: 1.5 lb/100 sq ft canopy/root-zone where ordinance allows ($5.31)',
      'Interior crack/edge treatment where pets rest',
      'Snapshot 2.5TG Q3: 2.3-3.45 lb/1,000 sq ft beds; water in ($17.16)',
    ]) expect([raw, isConditionalLine(raw)]).toEqual([raw, false]);
    const catalog = [{ id: 'k', name: 'KPHITE 7LP' }, { id: 'l', name: 'Liquid copper' }, { id: 't', name: 'Talus IGR' }];
    const visit = { primary: 'Talus IGR: label rate for whitefly/scale nymphs\nKPHITE 7LP: 1-2 qt/100 gal, FRAC P07 where root/oomycete risk is justified\nLiquid copper: 1-2 tsp/gal for labeled leaf spot', secondary: '' };
    expect(linesFromProtocolText(visit, catalog).map((l) => [l.product.id, l.role, l.selected])).toEqual([['t', 'base', true], ['k', 'conditional', false], ['l', 'conditional', false]]);
    const meta = { ...visit, lineMeta: { 'KPHITE 7LP: 1-2 qt/100 gal, FRAC P07 where root/oomycete risk is justified': { catalogProductHints: ['KPHITE 7LP'] }, 'Talus IGR: label rate for whitefly/scale nymphs': { catalogProductHints: ['Talus IGR'] } } };
    expect(linesFromLineMeta(meta, catalog).map((l) => [l.product.id, l.selected])).toEqual([['k', false], ['t', true]]);
  });

  test('a primary protocol line phrased "if …" stays conditional (hook P1)', () => {
    const catalog = [{ id: 'd', name: 'Distance IGR' }, { id: 't', name: 'TriTek' }, { id: 'c', name: 'Celsius WG' }];
    const visit = { primary: 'Celsius WG 1 oz\nDistance IGR 6 fl oz if rotation calls for IRAC 7C\nTriTek 1 gal only if crawlers are present', secondary: '' };
    const lines = jobCard._test.linesFromProtocolText(visit, catalog);
    expect(lines.map((l) => [l.product.id, l.role, l.selected])).toEqual([['c', 'base', true], ['d', 'conditional', false], ['t', 'conditional', false]]);
  });

  test('a spray-check Hold withholds the card amount like the tank search (hook P1)', async () => {
    const line = { raw: 'x', role: 'base', selected: true, product: { id: 'p', name: 'P', rate_unit: 'fl oz', inventory_on_hand: 1, inventory_unit: 'fl oz', label_verified_at: '2026-08-01' }, planMix: { amount: 12.4, amountUnit: 'fl oz' } };
    const facts = { customerId: 'c1', scheduledDate: '2026-09-04' };
    const [held] = await jobCard._test.buildProductCards({ facts, lines: [line], verdicts: [{ productId: 'p', verdict: 'hold', reason: 'wind over 10 mph' }], packSizes: {} });
    expect(held.planned).toBeNull();
    expect(held.amountNote).toBe('Spray check: wind over 10 mph — amount withheld');
    // Demand (shortage, order quantity) is unaffected by the hold.
    expect(held.short).toBe(true);
    const [ok] = await jobCard._test.buildProductCards({ facts, lines: [line], verdicts: [{ productId: 'p', verdict: 'ok', reason: null }], packSizes: {} });
    expect(ok.planned).toEqual({ amount: 12.4, unit: 'fl oz' });
  });

  const program = { visits: [{ visit: 9, month: 'Sep', primary: 'Speedzone Southern 1 fl oz' }] };
  const catalog = [{ id: 'c', name: 'Celsius WG', rate_unit: 'oz' }, { id: 's', name: 'Speedzone Southern', rate_unit: 'fl oz' }];

  test('add-on lines resolve onto the card with their source and visit; unmatched, lawn and pest-default add-ons are reported, not dosed', async () => {
    const facts = {
      isLawn: false,
      serviceType: 'Quarterly Pest Control',
      scheduledDate: '2026-09-04',
      addons: [
        { name: 'Tree & Shrub Care', category: 'tree_shrub' },
        { name: 'Lawn Care', category: 'lawn_care' },
        { name: 'Mosquito', category: 'mosquito' },
        // Identity, not name (r2 P1): an inspection is never a treatment, and
        // a name the matcher would classify as pest resolves nothing without
        // a treatment category.
        { name: 'Pest Inspection Service', category: 'inspection' },
        { name: 'Bee/Wasp removal', category: null },
        // A specialized program inside the category (hook P1): the matcher's
        // cockroach pick is honoured because it is in pest_control's set.
        { name: 'Initial German Roach Knockdown', category: 'pest_control' },
      ],
    };
    const protocols = {
      pest: { visits: [{ visit: 1, month: 'Any', primary: 'Celsius WG 1 oz' }] },
      tree_shrub: program,
      cockroach: { visits: [{ visit: 1, month: 'Any', primary: 'Advion Gel 1 tube' }] },
    };
    const out = await jobCard.resolveVisitLines({ facts, protocols, catalog: [...catalog, { id: 'a', name: 'Advion Gel' }], dbh: () => ({}) });
    expect(out.lines.map((l) => [l.product.id, l.source || null])).toEqual([['c', null], ['s', 'Tree & Shrub Care'], ['a', 'Initial German Roach Knockdown']]);
    expect(out.addons).toEqual([
      { name: 'Tree & Shrub Care', products: 1, visit: { number: 9, month: 'Sep' }, note: null },
      { name: 'Lawn Care', products: 0, visit: null, note: 'Lawn add-on — no plan for this line on the card' },
      { name: 'Mosquito', products: 0, visit: null, note: 'No protocol matched this add-on' },
      { name: 'Pest Inspection Service', products: 0, visit: null, note: 'No treatment protocol for this add-on (inspection)' },
      { name: 'Bee/Wasp removal', products: 0, visit: null, note: 'No treatment protocol for this add-on (no catalog identity)' },
      { name: 'Initial German Roach Knockdown', products: 1, visit: { number: 1, month: 'Any' }, note: null },
    ]);
    const [, card] = await jobCard._test.buildProductCards({ facts: { customerId: 'c1', scheduledDate: '2026-09-04' }, lines: out.lines, verdicts: [], packSizes: {} });
    expect(card.line).toBe('Tree & Shrub Care: Speedzone Southern');
  });

  test('an add-on that selects a product the primary lists as conditional wins the card through the merger (r1 P1)', async () => {
    const facts = { isLawn: false, serviceType: 'Quarterly Pest Control', scheduledDate: '2026-09-04', addons: [{ name: 'Tree & Shrub Care', category: 'tree_shrub' }] };
    const protocols = { pest: { visits: [{ visit: 1, month: 'Any', primary: 'Speedzone Southern 1 fl oz', secondary: 'Celsius WG 1 oz' }] }, tree_shrub: { visits: [{ visit: 9, month: 'Sep', primary: 'Celsius WG 1 oz' }] } };
    const out = await jobCard.resolveVisitLines({ facts, protocols, catalog, dbh: () => ({}) });
    expect(out.lines.filter((l) => l.product.id === 'c').map((l) => [l.selected, l.source || null])).toEqual([[false, null], [true, 'Tree & Shrub Care']]);
    const cards = await jobCard._test.buildProductCards({ facts: { customerId: 'c1', scheduledDate: '2026-09-04' }, lines: out.lines, verdicts: [], packSizes: {} });
    const celsius = cards.find((c) => c.id === 'c');
    expect(cards).toHaveLength(2);
    expect(celsius.conditional).toBe(false);
    expect(celsius.line).toBe('Tree & Shrub Care: Celsius WG · Celsius WG');
  });

  test('a failed add-on read fails the card (503); rows carry the catalog category', async () => {
    const dbh = () => { const chain = {}; for (const m of ['leftJoin', 'where', 'orderBy', 'select']) chain[m] = () => chain; chain.catch = (fn) => Promise.resolve(fn(new Error('db down'))); return chain; };
    dbh.raw = (sql) => sql;
    await expect(jobCard._test.loadAddons(dbh, 'svc1')).rejects.toMatchObject({ statusCode: 503 });
    const ok = () => { const chain = {}; for (const m of ['leftJoin', 'where', 'orderBy', 'select']) chain[m] = () => chain; chain.catch = async () => [{ service_name: 'Tree & Shrub Care', category: 'tree_shrub' }, { service_name: 'Bee/Wasp removal', category: null }]; return chain; };
    ok.raw = (sql) => sql;
    expect(await jobCard._test.loadAddons(ok, 'svc1')).toEqual([{ name: 'Tree & Shrub Care', category: 'tree_shrub' }, { name: 'Bee/Wasp removal', category: null }]);
  });

  test('a searched product booked through a non-lawn add-on is judged under that add-on, not the lawn plan (r2 P2)', async () => {
    const live = { carrier_gal_per_1000: 2, expires_at: '2026-10-01T00:00:00Z', calibration_status: 'field_verified', tank_capacity_gal: 110 };
    const product = { id: 'd', name: 'Demand CS', default_rate: '0.2-0.8', default_unit: 'fl_oz/gal', label_verified_at: '2026-07-12' };
    const visit = { customer_id: 'c1', scheduled_date: '2026-09-04', service_type: 'WaveGuard Lawn Care' };
    const rows = { scheduled_services: [visit], products_catalog: [product], equipment_calibrations: [live], scheduled_service_addons: [{ service_name: 'Quarterly Pest Control', category: 'pest_control' }], product_aliases: [] };
    const dbh = (t) => {
      const table = String(t).split(' as ')[0];
      const chain = {};
      for (const m of ['join', 'leftJoin', 'where', 'whereIn', 'whereNotNull', 'select', 'orderByRaw', 'orderBy', 'modify']) chain[m] = () => chain;
      chain.first = async () => (rows[table] || [])[0] ?? null;
      chain.catch = (fn) => Promise.resolve(rows[table] || []).catch(fn);
      chain.then = (res, rej) => Promise.resolve(rows[table] || []).then(res, rej);
      return chain;
    };
    dbh.raw = (sql) => sql;
    const buildPlan = jest.fn().mockResolvedValue({ propertyGate: { blocks: [{ code: 'nitrogen_blackout', message: 'Nitrogen blackout is active.' }] }, mixCalculator: { items: [] } });
    const protocols = { pest: { visits: [{ visit: 1, month: 'Any', primary: 'Demand CS 0.4 fl oz/gal' }] } };
    const out = await jobCard.mixForProduct('d', 1, { serviceId: 'svc1', dbh, deps: { buildPlan, protocols }, now: new Date('2026-09-03T14:00:00Z') });
    expect(buildPlan).not.toHaveBeenCalled();
    expect(out.context).toEqual({ line: 'Quarterly Pest Control', conditional: false });
    expect(out.planBlocks).toEqual([]);
    expect(out.amount).toBe(0.2);
  });

  test('a product the add-on protocol lists as "if needed" is withheld in the tank search, not dosed off the catalog (r3 P1)', async () => {
    const live = { carrier_gal_per_1000: 2, expires_at: '2026-10-01T00:00:00Z', calibration_status: 'field_verified', tank_capacity_gal: 110 };
    const product = { id: 'h', name: 'Headway', default_rate: '0.5-1', default_unit: 'fl_oz/gal', label_verified_at: '2026-07-12' };
    const visit = { customer_id: 'c1', scheduled_date: '2026-09-04', service_type: 'WaveGuard Lawn Care' };
    const rows = { scheduled_services: [visit], products_catalog: [product], equipment_calibrations: [live], scheduled_service_addons: [{ service_name: 'Tree & Shrub Care', category: 'tree_shrub' }], product_aliases: [] };
    const dbh = (t) => {
      const table = String(t).split(' as ')[0];
      const chain = {};
      for (const m of ['join', 'leftJoin', 'where', 'whereIn', 'whereNotNull', 'select', 'orderByRaw', 'orderBy', 'modify']) chain[m] = () => chain;
      chain.first = async () => (rows[table] || [])[0] ?? null;
      chain.catch = (fn) => Promise.resolve(rows[table] || []).catch(fn);
      chain.then = (res, rej) => Promise.resolve(rows[table] || []).then(res, rej);
      return chain;
    };
    dbh.raw = (sql) => sql;
    const buildPlan = jest.fn();
    // September's Headway line is secondary: "only for labeled ornamental disease and only if FRAC history allows".
    const protocols = { tree_shrub: { visits: [{ visit: 9, month: 'Sep', primary: 'Talus IGR: label rate for whitefly/scale nymphs', secondary: 'Headway only for labeled ornamental disease and only if FRAC history allows' }] } };
    const out = await jobCard.mixForProduct('h', 1, { serviceId: 'svc1', dbh, deps: { buildPlan, protocols }, now: new Date('2026-09-03T14:00:00Z') });
    expect(buildPlan).not.toHaveBeenCalled();
    expect(out.context).toEqual({ line: 'Tree & Shrub Care', conditional: true });
    expect(out.amount).toBeNull();
    expect(out.reason).toBe('Listed as "if needed" on Tree & Shrub Care — confirm the call before mixing');
    expect(out.ratePerGallon).toBeNull();
    // The same product as a selected primary line doses normally.
    protocols.tree_shrub.visits[0] = { visit: 9, month: 'Sep', primary: 'Headway 0.75 fl oz/gal foliar', secondary: '' };
    const selected = await jobCard.mixForProduct('h', 1, { serviceId: 'svc1', dbh, deps: { buildPlan, protocols }, now: new Date('2026-09-03T14:00:00Z') });
    expect(selected.context).toEqual({ line: 'Tree & Shrub Care', conditional: false });
    expect(selected.amount).toBe(0.5);
    // The same guard on the PRIMARY non-lawn visit (hook P1): a Tree & Shrub
    // visit's own "if needed" Headway is withheld, its selected Talus doses.
    rows.scheduled_services = [{ ...visit, service_type: 'Tree & Shrub Care', service_category: 'tree_shrub' }];
    rows.scheduled_service_addons = [];
    protocols.tree_shrub.visits[0] = { visit: 9, month: 'Sep', primary: 'Talus IGR 0.5 fl oz/gal for whitefly/scale nymphs', secondary: 'Headway only for labeled ornamental disease and only if FRAC history allows' };
    const primary = await jobCard.mixForProduct('h', 1, { serviceId: 'svc1', dbh, deps: { buildPlan, protocols }, now: new Date('2026-09-03T14:00:00Z') });
    expect(primary.context).toEqual({ line: null, conditional: true });
    expect(primary.amount).toBeNull();
    expect(primary.reason).toBe('Listed as "if needed" on this visit\'s protocol — confirm the call before mixing');
    rows.products_catalog = [{ ...product, id: 't', name: 'Talus IGR' }];
    const talus = await jobCard.mixForProduct('t', 1, { serviceId: 'svc1', dbh, deps: { buildPlan, protocols }, now: new Date('2026-09-03T14:00:00Z') });
    expect(talus.context).toEqual({ line: null, conditional: false });
    expect(talus.amount).toBe(0.5);
    // An inspection by identity has no protocol line: nothing to withhold on, nothing to dose under.
    rows.scheduled_services = [{ ...visit, service_type: 'Tree & Shrub Assessment', service_category: 'inspection' }];
    expect((await jobCard.mixForProduct('t', 1, { serviceId: 'svc1', dbh, deps: { buildPlan, protocols }, now: new Date('2026-09-03T14:00:00Z') })).context).toEqual({ line: null });
    expect(buildPlan).not.toHaveBeenCalled();
  });

  test('the tank search runs the spray check at the property: a Hold withholds the dose', async () => {
    const live = { carrier_gal_per_1000: 2, expires_at: '2026-10-01T00:00:00Z', calibration_status: 'field_verified', tank_capacity_gal: 110 };
    const product = { id: 'p1', name: 'Celsius WG', default_rate_per_1000: 0.113, rate_unit: 'oz', label_verified_at: '2026-07-12', max_wind_mph: 10 };
    const visit = { customer_id: 'c1', scheduled_date: '2026-09-04', service_type: 'Quarterly Pest Control', latitude: 27.4, longitude: -82.5 };
    const dbh = (table) => {
      const rows = { scheduled_services: [visit], products_catalog: [product], equipment_calibrations: [live] }[String(table).split(' as ')[0]] ?? [];
      const chain = {};
      for (const m of ['join', 'leftJoin', 'where', 'whereIn', 'whereNotNull', 'select', 'orderByRaw', 'orderBy', 'modify']) chain[m] = () => chain;
      chain.first = async () => rows[0] ?? null;
      chain.catch = (fn) => Promise.resolve(rows).catch(fn);
      chain.then = (res, rej) => Promise.resolve(rows).then(res, rej);
      return chain;
    };
    dbh.raw = (sql) => sql;
    const now = new Date('2026-09-04T14:00:00Z');
    const windy = [{ startTime: '2026-09-04T14:00:00Z', temperatureF: 88, windMph: 14, rainChance: 10 }, { startTime: '2026-09-04T15:00:00Z', temperatureF: 88, windMph: 14, rainChance: 10 }, { startTime: '2026-09-04T16:00:00Z', temperatureF: 88, windMph: 14, rainChance: 10 }, { startTime: '2026-09-04T17:00:00Z', temperatureF: 88, windMph: 14, rainChance: 10 }];
    const getHourly = jest.fn(async () => windy);
    const hold = await jobCard.mixForProduct('p1', 110, { serviceId: 'svc1', dbh, deps: { getHourly }, now });
    expect(getHourly).toHaveBeenCalledWith(27.4, -82.5);
    expect(hold.sprayCheck).toEqual({ verdict: 'hold', reason: 'wind over 10 mph' });
    expect(hold.amount).toBeNull();
    expect(hold.reason).toBe('Spray check: wind over 10 mph');
    // A withheld mix carries no label rate either (hook P1).
    expect(hold.ratePer1000).toBeNull();
    expect(hold.ratePerGallon).toBeNull();
    const calm = await jobCard.mixForProduct('p1', 110, { serviceId: 'svc1', dbh, deps: { getHourly: async () => windy.map((h) => ({ ...h, windMph: 5 })) }, now });
    expect(calm.sprayCheck.verdict).toBe('ok');
    expect(calm.amount).toBe(6.215);
    // Not today → judged on the visit day, dose allowed.
    const later = await jobCard.mixForProduct('p1', 110, { serviceId: 'svc1', dbh, deps: { getHourly }, now: new Date('2026-09-03T14:00:00Z') });
    expect(later.sprayCheck).toEqual({ verdict: 'unknown', reason: 'Judged on the visit day' });
    expect(later.amount).toBe(6.215);
  });
});

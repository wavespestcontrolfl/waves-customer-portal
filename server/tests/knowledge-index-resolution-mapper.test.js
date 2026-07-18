const { mapCall, mapVisit } = require('../services/knowledge-index/resolution-mapper');
const { applyRecencyDecay, RESOLUTION_HALF_LIFE_DAYS } = require('../services/knowledge-index/hybrid-search');

const CALL = { id: 'c1', customer_id: 'cu1', created_at: new Date('2026-07-01T12:00:00Z'), call_summary: null };
const CONTEXT = { first_name: 'Jane', last_name: 'Doe', phone: '9415551234' };

const extraction = (over = {}) => ({
  meta: { call_summary: 'Jane Doe called about german roaches in her Bradenton kitchen; booked quarterly service.', is_spam: false },
  call_nature: 'new_lead',
  recommended_disposition: 'booked',
  service_request: { primary_service_category: 'pest_control', service_intent: 'recurring', urgency: 'routine', pests_observed: ['german roach'], secondary_categories: [] },
  ...over,
});

describe('resolution mapper — calls', () => {
  test('spam and junk natures map to null', () => {
    expect(mapCall({ call: CALL, extraction: extraction({ meta: { call_summary: 'x', is_spam: true } }) })).toBeNull();
    expect(mapCall({ call: CALL, extraction: extraction({ call_nature: 'robocall' }) })).toBeNull();
    expect(mapCall({ call: CALL, extraction: extraction({ recommended_disposition: 'spam_discarded' }) })).toBeNull();
  });

  test('unparseable or missing extraction maps to null', () => {
    expect(mapCall({ call: CALL, extraction: null })).toBeNull();
    expect(mapCall({ call: CALL, extraction: '{not json' })).toBeNull();
  });

  test('nothing-resolved calls map to null', () => {
    expect(mapCall({ call: CALL, extraction: extraction({ recommended_disposition: null }), triageNotes: [] })).toBeNull();
  });

  test('booked call maps with redacted customer name', () => {
    const a = mapCall({ call: CALL, extraction: extraction(), context: CONTEXT });
    expect(a).not.toBeNull();
    expect(a.source).toBe('call');
    expect(a.sourceId).toBe('c1');
    expect(a.customerId).toBe('cu1');
    expect(a.situation).not.toMatch(/Doe/);
    expect(a.resolution).toContain('Booked the service');
    expect(a.question).toContain('new lead');
    expect(a.systems).toEqual(expect.arrayContaining(['new_lead', 'pest_control', 'german roach']));
    expect(a.outcome.disposition).toBe('booked');
  });

  test('terminal call_log.disposition overrides the model recommendation (codex r2)', () => {
    // Production stamped it spam even though the model recommended booking.
    const stamped = { ...CALL, disposition: 'spam_discarded' };
    expect(mapCall({ call: stamped, extraction: extraction({ recommended_disposition: 'booked' }) })).toBeNull();
    // And a stamped real outcome wins over a differing recommendation.
    const booked = { ...CALL, disposition: 'booked' };
    const a = mapCall({ call: booked, extraction: extraction({ recommended_disposition: 'callback_task_created' }), context: CONTEXT });
    expect(a.resolution).toContain('Booked the service');
    expect(a.outcome.disposition).toBe('booked');
    expect(a.outcome.recommendedDisposition).toBe('callback_task_created');
  });

  test('single-name references are redacted via the context pass (codex P1)', () => {
    const a = mapCall({
      call: CALL,
      extraction: extraction(),
      triageNotes: [{ reason_code: 'callback', resolution_note: 'Spoke with Jane about the side gate' }],
      context: CONTEXT,
    });
    expect(a.resolution).not.toMatch(/Jane/);
    expect(a.resolution).toContain('[name]');
  });

  test('V2 object-shaped pests render names, never [object Object] (codex P2)', () => {
    const a = mapCall({
      call: CALL,
      extraction: extraction({
        service_request: { primary_service_category: 'pest_control', pests_observed: [{ pest_type: 'german roach', severity_signal: 'high' }, 'silverfish'] },
      }),
      context: CONTEXT,
    });
    expect(a.question).toContain('german roach');
    expect(a.question).toContain('silverfish');
    expect(JSON.stringify(a)).not.toContain('[object Object]');
    expect(a.systems).toEqual(expect.arrayContaining(['german roach', 'silverfish']));
  });

  test('triage resolution notes and differing final action land in resolution', () => {
    const a = mapCall({
      call: CALL,
      extraction: extraction({ recommended_disposition: 'callback_task_created' }),
      triageNotes: [{ reason_code: 'address_unverified', resolution_note: 'Verified address with Jane Doe by SMS' }],
      finalAction: 'booked',
      context: CONTEXT,
    });
    expect(a.resolution).toContain('Created a callback task');
    expect(a.resolution).toContain('Action taken: booked');
    expect(a.resolution).toContain('address_unverified');
    expect(a.resolution).not.toMatch(/Doe/);
    expect(a.outcome.triageReasonCodes).toEqual(['address_unverified']);
  });
});

describe('resolution mapper — visits', () => {
  const RECORD = { id: 'v1', customer_id: 'cu1', service_date: new Date('2026-06-15'), service_type: 'lawn_care', technician_notes: 'Spoke with Jane Doe about irrigation.' };

  test('no recommendations → null', () => {
    expect(mapVisit({ record: RECORD, findings: [{ category: 'turf', detail: 'thin patches' }] })).toBeNull();
  });

  test('free-form finding titles are redacted (codex P1)', () => {
    const a = mapVisit({
      record: RECORD,
      findings: [{ category: 'access', severity: 'info', title: 'Gate code from Jane Doe', detail: 'x', recommendation: 'Use side entrance' }],
      context: { first_name: 'Jane', last_name: 'Doe' },
    });
    expect(a.resolution).not.toMatch(/Jane|Doe/);
    expect(a.resolution).toContain('Use side entrance');
  });

  test('structured-notes recommendations map when findings carry none (codex P2)', () => {
    const a = mapVisit({
      record: RECORD,
      findings: [{ category: 'turf', detail: 'thin patches', recommendation: null }],
      structuredRecommendations: ['Raise mow height to 4 inches', 'Water 2x weekly for Jane Doe'],
      context: { first_name: 'Jane', last_name: 'Doe' },
    });
    expect(a).not.toBeNull();
    expect(a.resolution).toContain('Raise mow height');
    expect(a.resolution).not.toMatch(/Doe/);
  });

  test('findings with recommendations map, redacted', () => {
    const a = mapVisit({
      record: RECORD,
      findings: [{ category: 'disease', severity: 'moderate', title: 'Brown patch', detail: 'Rings near irrigation heads', recommendation: 'Rotate azoxystrobin; correct watering schedule' }],
      context: { first_name: 'Jane', last_name: 'Doe' },
    });
    expect(a.source).toBe('visit');
    expect(a.resolution).toContain('azoxystrobin');
    expect(a.situation).not.toMatch(/Doe/);
    expect(a.systems).toEqual(expect.arrayContaining(['lawn care', 'disease']));
    expect(a.outcome.findingCategories).toEqual(['disease']);
  });
});

describe('recency decay', () => {
  const now = Date.parse('2026-07-18T00:00:00Z');
  const doc = (source, ageDays) => ({
    source, score: 1.0,
    metadata: { occurredAt: new Date(now - ageDays * 86400000).toISOString() },
  });

  test('resolution halves at one half-life', () => {
    expect(applyRecencyDecay(doc('resolution', RESOLUTION_HALF_LIFE_DAYS), now)).toBeCloseTo(0.5, 5);
    expect(applyRecencyDecay(doc('resolution', 0), now)).toBeCloseTo(1.0, 5);
  });

  test('curated sources never decay', () => {
    expect(applyRecencyDecay(doc('kb', 1000), now)).toBe(1.0);
    expect(applyRecencyDecay(doc('protocol', 1000), now)).toBe(1.0);
  });

  test('missing occurredAt leaves score untouched', () => {
    expect(applyRecencyDecay({ source: 'resolution', score: 1.0, metadata: {} }, now)).toBe(1.0);
  });
});

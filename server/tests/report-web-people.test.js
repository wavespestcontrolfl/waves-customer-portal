/**
 * GATE_REPORT_WEB_PEOPLE (owner 2026-10-20): the webPeople payload key of the simple web service report.
 * The review link needs a good visit (lawn score 85 or more, or a clean pest visit) and a quiet customer
 * (no complaint, low rating or negative call in 30 days); a failed read shows no link.
 */
const { buildWebPeople, isCleanPestVisit } = require('../services/service-report/report-web-people');

const NOW = new Date('2026-10-20T15:00:00Z');
const SERVICE = {
  id: 'rec-1', customer_id: 'cust-1', technician_id: 'tech-1', service_date: '2026-10-20', scheduled_service_id: 'ss-1',
};

// A tiny knex stand-in: each table answers from `tables`; a function value throws or returns per call.
function fakeKnex(tables = {}) {
  const builder = (value) => {
    const b = {
      where: () => b, whereIn: () => b, orWhere: () => b, leftJoin: () => b, modify: () => b, select: () => b, limit: () => b,
      first: async () => (typeof value === 'function' ? value() : (Array.isArray(value) ? value[0] : value)) || undefined,
      then: (res, rej) => Promise.resolve(typeof value === 'function' ? value() : value).then(res, rej),
    };
    return b;
  };
  return (table) => builder(tables[table.split(' ')[0]] ?? []);
}

function lawnData(score, extra = {}) {
  return {
    serviceLine: 'lawn',
    lawnAssessment: { scores: { overallScore: score } },
    reviewLocation: { id: 'venice', reviewUrl: 'https://g.page/r/example/review' },
    reviewRequestEligible: true,
    hasLeftGoogleReview: false,
    technician: { name: 'Alex Rivera', photoUrl: 'https://img.example/alex.jpg' },
    applicatorFdacsId: 'JF123456',
    ...extra,
  };
}

const QUIET = { customer_interactions: [], satisfaction_responses: [], call_log: [] };

describe('webPeople review link', () => {
  test('lawn score 85 and a quiet month: link is sent', async () => {
    const out = await buildWebPeople({ data: lawnData(85), service: SERVICE, knex: fakeKnex(QUIET), nextVisits: [], readsOk: true, now: NOW });
    expect(out.review).toEqual({ url: 'https://g.page/r/example/review', locationId: 'venice' });
  });

  test('lawn score 84: no link', async () => {
    const out = await buildWebPeople({ data: lawnData(84), service: SERVICE, knex: fakeKnex(QUIET), nextVisits: [], readsOk: true, now: NOW });
    expect(out.review).toBeUndefined();
  });

  test('lawn with no score: no link', async () => {
    const out = await buildWebPeople({ data: lawnData(null), service: SERVICE, knex: fakeKnex(QUIET), nextVisits: [], readsOk: true, now: NOW });
    expect(out.review).toBeUndefined();
  });

  test.each([
    ['a complaint', { customer_interactions: [{ id: 1 }], satisfaction_responses: [], call_log: [] }],
    ['a low rating', { customer_interactions: [], satisfaction_responses: [{ id: 1 }], call_log: [] }],
    ['a negative call', { customer_interactions: [], satisfaction_responses: [], call_log: [{ id: 1 }] }],
  ])('%s in the last 30 days: no link', async (_label, tables) => {
    const out = await buildWebPeople({ data: lawnData(92), service: SERVICE, knex: fakeKnex(tables), nextVisits: [], readsOk: true, now: NOW });
    expect(out.review).toBeUndefined();
  });

  test('a failed contact read shows no link (the quiet month is unproven)', async () => {
    const knex = fakeKnex({ ...QUIET, call_log: () => { throw new Error('boom'); } });
    const out = await buildWebPeople({ data: lawnData(92), service: SERVICE, knex, nextVisits: [], readsOk: true, now: NOW });
    expect(out.review).toBeUndefined();
  });

  test('the customer already left a review, or the server says not eligible: no link', async () => {
    const left = await buildWebPeople({ data: lawnData(92, { hasLeftGoogleReview: true }), service: SERVICE, knex: fakeKnex(QUIET), nextVisits: [], readsOk: true, now: NOW });
    const off = await buildWebPeople({ data: lawnData(92, { reviewRequestEligible: false }), service: SERVICE, knex: fakeKnex(QUIET), nextVisits: [], readsOk: true, now: NOW });
    expect(left.review).toBeUndefined();
    expect(off.review).toBeUndefined();
  });

  test('a failed findings or zones read (readsOk not true) shows no link, whatever the payload says', async () => {
    const data = { ...lawnData(null), serviceLine: 'pest', treatmentPerformed: true, findings: [], serviceCoverage: { items: [] } };
    for (const readsOk of [false, undefined]) {
      const out = await buildWebPeople({ data, service: SERVICE, knex: fakeKnex(QUIET), nextVisits: [], readsOk, now: NOW });
      expect(out.review).toBeUndefined();
    }
    const lawn = await buildWebPeople({ data: lawnData(92), service: SERVICE, knex: fakeKnex(QUIET), nextVisits: [], readsOk: false, now: NOW });
    expect(lawn.review).toBeUndefined();
  });

  test('no resolved review office: no link', async () => {
    const out = await buildWebPeople({ data: lawnData(92, { reviewLocation: null }), service: SERVICE, knex: fakeKnex(QUIET), nextVisits: [], readsOk: true, now: NOW });
    expect(out.review).toBeUndefined();
  });
});

describe('clean pest visit', () => {
  const clean = () => ({ serviceLine: 'pest', treatmentPerformed: true, findings: [{ severity: 'low' }], serviceCoverage: { items: [{ status: 'completed' }] } });

  test('treated, no high finding, nothing to follow up', () => {
    expect(isCleanPestVisit(clean())).toBe(true);
  });

  test.each([
    ['a re-service', { isCallback: true }],
    ['no treatment', { treatmentPerformed: false }],
    ['an unknown treatment verdict (null)', { treatmentPerformed: null }],
    ['no treatment verdict at all', { treatmentPerformed: undefined }],
    ['a high finding', { findings: [{ severity: 'high' }] }],
    ['an area that needed attention', { serviceCoverage: { items: [{ status: 'needs_attention' }] } }],
    ['a planned follow-up', { followUp: { reason: 'x' } }],
    ['a completed item with a recorded follow-up', { serviceCoverage: { items: [{ status: 'completed', needsFollowUp: true }] } }],
    ['a treated item with a recorded follow-up', { serviceCoverage: { items: [{ status: 'treated', needsFollowUp: true }] } }],
    ['another line', { serviceLine: 'mosquito' }],
  ])('%s is not clean', (_label, patch) => {
    expect(isCleanPestVisit({ ...clean(), ...patch })).toBe(false);
  });

  test('a clean pest visit gets the link', async () => {
    const data = { ...lawnData(null), serviceLine: 'pest', treatmentPerformed: true, lawnAssessment: undefined, findings: [], serviceCoverage: { items: [] } };
    const out = await buildWebPeople({ data, service: SERVICE, knex: fakeKnex(QUIET), nextVisits: [], readsOk: true, now: NOW });
    expect(out.review.url).toBe('https://g.page/r/example/review');
  });
});

describe('webPeople tech, map and next visit', () => {
  const HOME = { service_address_line1: '100 Palm Ave', service_address_city: 'Parrish', service_address_zip: '34219' };
  const ELSEWHERE = { service_address_line1: '9 Oak Ct', service_address_city: 'Sarasota', service_address_zip: '34236' };
  const performed = (id, visit, stamp = HOME) => ({ id, scheduled_service_id: id, visit_id: visit || null, structured_notes: { visitOutcome: 'completed' }, ...stamp });

  test('tech strip: first name, photo, FDACS id and the visit count from two or more stops', async () => {
    const knex = fakeKnex({
      ...QUIET,
      scheduled_services: HOME,
      service_records: [performed('a'), performed('b', 'v1'), performed('c', 'v1'), performed('d')],
    });
    const out = await buildWebPeople({ data: lawnData(70), service: SERVICE, knex, nextVisits: [], readsOk: true, now: NOW });
    expect(out.tech).toEqual({ firstName: 'Alex', photoUrl: 'https://img.example/alex.jpg', fdacsId: 'JF123456', visitsAtHome: 3 });
  });

  test('one visit is not worth a count; a typed shadow record never counts', async () => {
    const shadow = { id: 'z', scheduled_service_id: 'z', structured_notes: { typedReportDelivery: 'shadow', visitOutcome: 'completed' } };
    const knex = fakeKnex({ ...QUIET, scheduled_services: HOME, service_records: [performed('a'), shadow] });
    const out = await buildWebPeople({ data: lawnData(70), service: SERVICE, knex, nextVisits: [], readsOk: true, now: NOW });
    expect(out.tech.visitsAtHome).toBeNull();
  });

  test('only visits at the same premises count: another home of the same customer is left out', async () => {
    const knex = fakeKnex({
      ...QUIET,
      scheduled_services: HOME,
      service_records: [performed('a'), performed('b'), performed('c', null, ELSEWHERE)],
    });
    const out = await buildWebPeople({ data: lawnData(70), service: SERVICE, knex, nextVisits: [], readsOk: true, now: NOW });
    expect(out.tech.visitsAtHome).toBe(2);
  });

  test('a booking that carries no premises evidence (no stamp, property or estimate): no count, though other records exist', async () => {
    const knex = fakeKnex({
      ...QUIET,
      scheduled_services: { property_id: null },
      service_records: [performed('a'), performed('b'), performed('c')],
    });
    const out = await buildWebPeople({ data: lawnData(70), service: SERVICE, knex, nextVisits: [], readsOk: true, now: NOW });
    expect(out.tech.visitsAtHome).toBeNull();
  });

  test('a record with no premises evidence is never counted as this home', async () => {
    const knex = fakeKnex({
      ...QUIET,
      scheduled_services: HOME,
      service_records: [performed('a'), performed('b'), performed('c', null, {})],
    });
    const out = await buildWebPeople({ data: lawnData(70), service: SERVICE, knex, nextVisits: [], readsOk: true, now: NOW });
    expect(out.tech.visitsAtHome).toBe(2);
  });

  test('a failed count read still shows the strip', async () => {
    const knex = fakeKnex({ ...QUIET, scheduled_services: () => { throw new Error('x'); } });
    const out = await buildWebPeople({ data: lawnData(70), service: SERVICE, knex, nextVisits: [], readsOk: true, now: NOW });
    expect(out.tech.firstName).toBe('Alex');
    expect(out.tech.visitsAtHome).toBeNull();
  });

  test('no technician name: no strip', async () => {
    const data = lawnData(92, { technician: null, technicianName: null });
    const out = await buildWebPeople({ data, service: SERVICE, knex: fakeKnex(QUIET), nextVisits: [], readsOk: true, now: NOW });
    expect(out.tech).toBeUndefined();
  });

  test.each(['Your Waves technician', 'your technician', 'Waves Team'])('placeholder name %s (the production payload shape): no strip', async (label) => {
    const data = lawnData(92, { technician: { name: label, photoUrl: null, initials: 'W' }, technicianName: label });
    const out = await buildWebPeople({ data, service: SERVICE, knex: fakeKnex(QUIET), nextVisits: [], readsOk: true, now: NOW });
    expect(out.tech).toBeUndefined();
  });

  test('a real customer-facing name ("Alex R.") shows the strip with the first name', async () => {
    const data = lawnData(92, { technician: { name: 'Alex R.', photoUrl: null, initials: 'AR' }, technicianName: 'Alex R.' });
    const out = await buildWebPeople({ data, service: SERVICE, knex: fakeKnex(QUIET), nextVisits: [], readsOk: true, now: NOW });
    expect(out.tech.firstName).toBe('Alex');
  });

  test('treatedMap is true only when a traced snapshot exists', async () => {
    const withMap = lawnData(70, { treatmentMap: { traced: { snapshotUrl: 'https://img.example/map.jpg' } } });
    expect((await buildWebPeople({ data: withMap, service: SERVICE, knex: fakeKnex(QUIET), nextVisits: [], readsOk: true, now: NOW })).treatedMap).toBe(true);
    expect((await buildWebPeople({ data: lawnData(70), service: SERVICE, knex: fakeKnex(QUIET), nextVisits: [], readsOk: true, now: NOW })).treatedMap).toBeUndefined();
  });

  test('next visit: the first visit, date and window only; a reschedule link or token in the input never reaches the payload', async () => {
    const visits = [
      { serviceType: 'Lawn Care', scheduledDate: '2026-11-18', windowStart: '09:00:00', rescheduleUrl: 'https://portal.example/reschedule/abc', reschedule_token: 'tok' },
      { serviceType: 'Pest Control', scheduledDate: '2026-12-01', windowStart: null },
    ];
    const out = await buildWebPeople({ data: lawnData(70), service: SERVICE, knex: fakeKnex(QUIET), nextVisits: visits, readsOk: true, now: NOW });
    expect(out.nextVisit).toEqual({ serviceType: 'Lawn Care', scheduledDate: '2026-11-18', windowStart: '09:00:00' });
    expect(JSON.stringify(out)).not.toMatch(/reschedule|tok/i);
  });

  test('nothing to show returns null', async () => {
    const data = { serviceLine: 'mosquito' };
    expect(await buildWebPeople({ data, service: SERVICE, knex: fakeKnex(QUIET), nextVisits: [], readsOk: true, now: NOW })).toBeNull();
  });
});

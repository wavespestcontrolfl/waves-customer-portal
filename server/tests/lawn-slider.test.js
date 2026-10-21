/**
 * GATE_REPORT_WEB_SLIDER (owner 2026-10-20, idea 2b): the pairing behind the customer's
 * before/after slider and the technician's "same angle" guide. Synthetic ids only.
 * Proves: the previous visit at the SAME property is used (property history answers), only
 * the same-spot shots pair, both photos must exist and sign, and nothing is guessed.
 */
jest.mock('../services/lawn-assessment-history', () => ({
  historyForAssessment: jest.fn(),
  historyBeforeVisit: jest.fn(),
}));

const history = require('../services/lawn-assessment-history');
const { buildLawnSlider, lastVisitShots, lastVisitShotsForService, SLIDER_SHOTS } = require('../services/service-report/lawn-slider');

// A knex stub: photo rows per assessment id; assessment rows by id; scheduled_services by id.
function knexStub({ photos = {}, assessments = {}, visits = {} } = {}) {
  return (table) => {
    const state = { where: {} };
    const chain = {
      where(cond) { state.where = cond; return chain; },
      whereIn() { return chain; },
      orderBy() { return chain; },
      first: async () => (table === 'lawn_assessments' ? assessments[state.where.id] : visits[state.where.id]) || null,
      then: (resolve, reject) => Promise.resolve(photos[state.where.assessment_id] || []).then(resolve, reject),
    };
    return chain;
  };
}
const photo = (zone, tag, extra = {}) => ({ id: `${zone}-${tag}`, zone, s3_key: `k/${zone}-${tag}`, customer_visible: true, ...extra });
const signer = jest.fn(async (row) => `https://signed.test/${row.s3_key}`);

beforeEach(() => { jest.clearAllMocks(); });

describe('buildLawnSlider', () => {
  const knex = knexStub({
    assessments: { cur: { id: 'cur', customer_id: 'c1' } },
    photos: {
      prev: [photo('back', 'p'), photo('front', 'p'), photo('close_up', 'p'), photo('side', 'p')],
      cur: [photo('front', 'c'), photo('close_up', 'c'), photo('side', 'c')],
    },
  });
  const scoped = (over = {}) => ({
    current: { id: 'cur', visit_date: '2026-10-21' },
    previous: { id: 'prev', visit_date: '2026-09-20' },
    ...over,
  });

  test('pairs by shot key: front pairs; close-up, side and back never do', async () => {
    history.historyForAssessment.mockResolvedValue(scoped());
    const out = await buildLawnSlider({ assessmentId: 'cur', knex, photoUrl: signer });
    expect(out).toEqual({
      pairs: [{
        key: 'front',
        label: 'Front yard',
        before: { url: 'https://signed.test/k/front-p', date: '2026-09-20' },
        after: { url: 'https://signed.test/k/front-c', date: '2026-10-21' },
      }],
    });
  });

  test('back never pairs, even with a back photo on both visits: the compact "Back or side" button also stores zone back, so a side photo could meet a back photo', async () => {
    history.historyForAssessment.mockResolvedValue(scoped());
    const both = knexStub({
      assessments: { cur: { id: 'cur' } },
      photos: { prev: [photo('back', 'p'), photo('front', 'p')], cur: [photo('back', 'c'), photo('front', 'c')] },
    });
    const out = await buildLawnSlider({ assessmentId: 'cur', knex: both, photoUrl: signer });
    expect(out.pairs.map((p) => p.key)).toEqual(['front']);
    const backOnly = knexStub({ assessments: { cur: { id: 'cur' } }, photos: { prev: [photo('back', 'p')], cur: [photo('back', 'c')] } });
    expect(await buildLawnSlider({ assessmentId: 'cur', knex: backOnly, photoUrl: signer })).toBeNull();
    expect(SLIDER_SHOTS).toEqual(['front']);
  });

  test('no earlier visit at this property: no slider (the history module is what says "same property")', async () => {
    history.historyForAssessment.mockResolvedValue(scoped({ previous: null }));
    expect(await buildLawnSlider({ assessmentId: 'cur', knex, photoUrl: signer })).toBeNull();
  });

  test('a previous visit that is not earlier, or a current row the history does not recognise, gives nothing', async () => {
    history.historyForAssessment.mockResolvedValue(scoped({ previous: { id: 'prev', visit_date: '2026-10-21' } }));
    expect(await buildLawnSlider({ assessmentId: 'cur', knex, photoUrl: signer })).toBeNull();
    history.historyForAssessment.mockResolvedValue(scoped({ current: { id: 'other', visit_date: '2026-10-21' } }));
    expect(await buildLawnSlider({ assessmentId: 'cur', knex, photoUrl: signer })).toBeNull();
  });

  test('a photo that will not sign drops its pair; no half pair is ever sent', async () => {
    history.historyForAssessment.mockResolvedValue(scoped());
    const failing = jest.fn(async (row) => (row.id === 'front-p' ? null : `https://signed.test/${row.s3_key}`));
    expect(await buildLawnSlider({ assessmentId: 'cur', knex, photoUrl: failing })).toBeNull();
  });

  test('an unknown assessment gives nothing', async () => {
    expect(await buildLawnSlider({ assessmentId: 'missing', knex, photoUrl: signer })).toBeNull();
    expect(await buildLawnSlider({ assessmentId: null, knex, photoUrl: signer })).toBeNull();
  });
});

describe('lastVisitShots (technician guide)', () => {
  const knex = knexStub({ photos: { prev: [photo('front', 'p'), photo('back', 'p'), photo('hot_edge', 'p')] } });

  test('returns only the previous visit front photo with its date; back and detail shots are not offered', async () => {
    history.historyBeforeVisit.mockResolvedValue({ previous: { id: 'prev', visit_date: '2026-09-20' } });
    const out = await lastVisitShots({ customerId: 'c1', scheduledService: { id: 's1' }, throughVisitDate: '2026-10-21', knex, photoUrl: signer });
    expect(Object.keys(out)).toEqual(['front']);
    expect(out.front).toEqual({ url: 'https://signed.test/k/front-p', date: '2026-09-20' });
    expect(history.historyBeforeVisit).toHaveBeenCalledWith({ customerId: 'c1', scheduledService: { id: 's1' }, throughVisitDate: '2026-10-21' }, knex);
  });

  test('no previous visit, or none with a front photo: null', async () => {
    history.historyBeforeVisit.mockResolvedValue({ previous: null });
    expect(await lastVisitShots({ customerId: 'c1', scheduledService: { id: 's1' }, throughVisitDate: '2026-10-21', knex, photoUrl: signer })).toBeNull();
    history.historyBeforeVisit.mockResolvedValue({ previous: { id: 'empty', visit_date: '2026-09-20' } });
    expect(await lastVisitShots({ customerId: 'c1', scheduledService: { id: 's1' }, throughVisitDate: '2026-10-21', knex, photoUrl: signer })).toBeNull();
  });

  test('from a scheduled visit: uses the visit day and customer; a visit with no day gives null', async () => {
    history.historyBeforeVisit.mockResolvedValue({ previous: { id: 'prev', visit_date: '2026-09-20' } });
    const withDay = knexStub({ photos: { prev: [photo('front', 'p')] }, visits: { s1: { id: 's1', customer_id: 'c1', scheduled_date: '2026-10-21' }, s2: { id: 's2', customer_id: 'c1', scheduled_date: null } } });
    const out = await lastVisitShotsForService({ serviceId: 's1', knex: withDay, photoUrl: signer });
    expect(out.front.date).toBe('2026-09-20');
    expect(history.historyBeforeVisit.mock.calls[0][0]).toMatchObject({ customerId: 'c1', throughVisitDate: '2026-10-21' });
    expect(await lastVisitShotsForService({ serviceId: 's2', knex: withDay, photoUrl: signer })).toBeNull();
    expect(await lastVisitShotsForService({ serviceId: 'nope', knex: withDay, photoUrl: signer })).toBeNull();
  });
});

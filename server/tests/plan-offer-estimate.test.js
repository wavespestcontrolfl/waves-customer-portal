'use strict';

// The plan offer's stamp reader (owner 2026-11-19 "build"): the one function the mint, the slot reservation, the estimate
// page and the extension check read the stamp through. Pure, no database.
const { planOfferOf, PLAN_OFFER_WAIVER_REASON } = require('../services/plan-offer-estimate');

const OFFER = { jobId: 'job-1', endsAt: '2026-12-22T17:38:16.650Z', firstVisitFrom: '2027-02-15' };
const dataWith = (offer) => ({ planStart: { serviceKey: 'pest_control', offer } });

describe('planOfferOf', () => {
  test('reads the stamp from the estimate data as an object or as its JSON string', () => {
    expect(planOfferOf(dataWith(OFFER))).toEqual(OFFER);
    expect(planOfferOf(JSON.stringify(dataWith(OFFER)))).toEqual(OFFER);
  });

  test('returns only the three fields', () => {
    expect(planOfferOf(dataWith({ ...OFFER, extra: 'x' }))).toEqual(OFFER);
  });

  test.each([
    ['no estimate data', null],
    ['undefined', undefined],
    ['a string that is not JSON', '{not json'],
    ['a JSON string of a non-object', '"text"'],
    ['no planStart', {}],
    ['a plan quote with no offer', { planStart: { serviceKey: 'pest_control' } }],
    ['a plan restart quote', { planRestart: { offer: OFFER } }],
    ['an offer that is not an object', dataWith('offer')],
    ['no job id', dataWith({ ...OFFER, jobId: undefined })],
    ['an empty job id', dataWith({ ...OFFER, jobId: '' })],
    ['a job id that is a number', dataWith({ ...OFFER, jobId: 7 })],
    ['an end date that does not parse', dataWith({ ...OFFER, endsAt: 'soon' })],
    ['an end date that is not a string', dataWith({ ...OFFER, endsAt: 1766425096650 })],
    ['no end date', dataWith({ ...OFFER, endsAt: undefined })],
    ['a first visit date with a time', dataWith({ ...OFFER, firstVisitFrom: '2027-02-15T00:00:00Z' })],
    ['a first visit date in another shape', dataWith({ ...OFFER, firstVisitFrom: '02/15/2027' })],
    ['no first visit date', dataWith({ ...OFFER, firstVisitFrom: undefined })],
  ])('is null for %s', (_label, data) => {
    expect(planOfferOf(data)).toBeNull();
  });

  test('the waiver reason is the owner-dated audit text', () => {
    expect(PLAN_OFFER_WAIVER_REASON).toBe('One-time job to plan offer: setup fee waived (owner 2026-11-19)');
  });
});

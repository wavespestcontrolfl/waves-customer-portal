/**
 * create_appointment close-name resolution (booking-service-match.js): a name
 * the owner dictates ("a pre-slab termite treatment") resolves to ONE catalog
 * service only when every word he said is accounted for by that service and
 * no other service fits (an unsaid cadence also blocks a lone fit); several fitting services come
 * back as choices; a word no service has resolves nothing (an "annual" pest
 * request must never book the one-time service). Pure: synthetic catalog rows.
 */
const { resolveCloseCatalogService, phraseTokens } = require('../services/intelligence-bar/booking-service-match');

const SLAB = { id: 'svc-slab', name: 'Slab Pre-Treat Termite Service', short_name: 'Slab Pre-Treat' };
const PRETREATMENT = { id: 'svc-tpt', name: 'Termite Pretreatment Service', short_name: 'Pre-Treat' };
const SPOT = { id: 'svc-spot', name: 'Termite Spot Treatment Service', short_name: 'Spot Treat' };
const ONE_TIME_PEST = { id: 'svc-otp', name: 'One-Time Pest Control Service', short_name: null };
const QUARTERLY_PEST = { id: 'svc-qp', name: 'Quarterly Pest Control Service', short_name: null };
const MONTHLY_PEST = { id: 'svc-mp', name: 'Monthly Pest Control Service', short_name: null };
const BIMONTHLY_PEST = { id: 'svc-bp', name: 'Bi-Monthly Pest Control Service', short_name: null };
const LAWN = { id: 'svc-lawn', name: 'Bi-Monthly Lawn Care Service', short_name: 'Lawn Care' };
const CATALOG = [SLAB, PRETREATMENT, SPOT, ONE_TIME_PEST, QUARTERLY_PEST, MONTHLY_PEST, BIMONTHLY_PEST, LAWN];

const names = (rows) => rows.map((r) => r.name).sort();

describe('resolveCloseCatalogService', () => {
  test.each([
    ['a pre-slab termite treatment', SLAB],
    ['pre-slab termite treatment', SLAB],
    ['slab pre-treat', SLAB],
    ['slab pretreat termite', SLAB],
    ['quarterly pest control', QUARTERLY_PEST],
    ['a quarterly pest control service', QUARTERLY_PEST],
    ['monthly pest', MONTHLY_PEST],
    ['monthly pest control', MONTHLY_PEST],
    ['bi-monthly pest control', BIMONTHLY_PEST],
    ['bimonthly pest control', BIMONTHLY_PEST],
    ['every other month pest control', BIMONTHLY_PEST],
    ['single pest control', ONE_TIME_PEST],
    ['one time pest control', ONE_TIME_PEST],
    ['termite spot treatment', SPOT],
    ['quartely pest control', QUARTERLY_PEST],
    ['bi monthly lawn', LAWN],
    ['pre-slab', SLAB],
    ['slab termite', SLAB],
  ])('"%s" resolves to exactly that one service', (said, row) => {
    expect(resolveCloseCatalogService(CATALOG, said)).toEqual({ row });
  });

  test.each([
    ['annual pest control'],
    ['yearly pest control'],
    ['semi-annual pest control'],
    ['weekly pest control'],
    ['quarterly lawn care'],
    ['spider web sweep'],
    ['   '],
    ['appointment for today'],
  ])('"%s" resolves nothing', (said) => {
    expect(resolveCloseCatalogService(CATALOG, said)).toEqual({ row: null });
  });

  test('"pre-treat termite" fits two services, so both come back as choices, never one', () => {
    const result = resolveCloseCatalogService(CATALOG, 'pre-treat termite');
    expect(result.row).toBeUndefined();
    expect(names(result.candidates)).toEqual([PRETREATMENT.name, SLAB.name].sort());
  });

  test('"pest control" alone returns every pest cadence as choices, never one row', () => {
    const result = resolveCloseCatalogService(CATALOG, 'pest control');
    expect(result.row).toBeUndefined();
    expect(names(result.candidates)).toEqual([BIMONTHLY_PEST.name, MONTHLY_PEST.name, ONE_TIME_PEST.name, QUARTERLY_PEST.name].sort());
  });

  test('a lone "termite" returns the termite services as choices', () => {
    const result = resolveCloseCatalogService(CATALOG, 'termite');
    expect(names(result.candidates)).toEqual([PRETREATMENT.name, SLAB.name, SPOT.name].sort());
  });

  test('"pest control" against a catalog with one pest row picks nothing: it lacks the cadence the operator never said', () => {
    expect(resolveCloseCatalogService([ONE_TIME_PEST], 'pest control')).toEqual({ row: null });
  });

  test('"bi-monthly" and "monthly" never match each other', () => {
    expect(resolveCloseCatalogService([MONTHLY_PEST], 'bi-monthly pest control')).toEqual({ row: null });
    expect(resolveCloseCatalogService([BIMONTHLY_PEST], 'monthly pest control')).toEqual({ row: null });
    expect(phraseTokens('bi-monthly')).toEqual(['cad:bimonthly']);
    expect(phraseTokens('monthly')).toEqual(['cad:monthly']);
  });

  test('an empty catalog resolves nothing', () => {
    expect(resolveCloseCatalogService([], 'pre-slab termite treatment')).toEqual({ row: null });
  });
  describe('the cadence of the FULL identity blocks a lone pick, whichever alias matched', () => {
    const BIMONTHLY_LAWN = { id: 'svc-bl', name: 'Bi-Monthly Lawn Care Service', short_name: 'Lawn Care' };
    const QUARTERLY_LAWN = { id: 'svc-ql', name: 'Quarterly Lawn Care Service', short_name: 'Lawn Care' };

    test('a lone row whose short name hides its cadence never resolves from words that match only the short name', () => {
      expect(resolveCloseCatalogService([BIMONTHLY_LAWN], 'a lawn care treatment')).toEqual({ row: null });
      expect(resolveCloseCatalogService([BIMONTHLY_LAWN, SLAB], 'lawn care')).toEqual({ row: null });
    });

    test('two cadences of lawn care come back as choices', () => {
      const result = resolveCloseCatalogService([BIMONTHLY_LAWN, QUARTERLY_LAWN], 'a lawn care treatment');
      expect(names(result.candidates)).toEqual([BIMONTHLY_LAWN.name, QUARTERLY_LAWN.name].sort());
    });

    test('saying the cadence still resolves it, and a short name that carries the cadence behaves as before', () => {
      expect(resolveCloseCatalogService([BIMONTHLY_LAWN], 'bi-monthly lawn care')).toEqual({ row: BIMONTHLY_LAWN });
      const carried = { id: 'svc-q', name: 'Quarterly Pest Control Service', short_name: 'Quarterly Pest' };
      expect(resolveCloseCatalogService([carried], 'quarterly pest')).toEqual({ row: carried });
      expect(resolveCloseCatalogService([carried], 'pest')).toEqual({ row: null });
    });

    test('a row with no cadence anywhere still resolves, even with a one_time frequency column', () => {
      expect(resolveCloseCatalogService([SLAB], 'pre-slab termite treatment')).toEqual({ row: SLAB });
      const oneOff = { ...SLAB, frequency: 'one_time' };
      expect(resolveCloseCatalogService([oneOff], 'pre-slab termite treatment')).toEqual({ row: oneOff });
    });

    test('the services.frequency column counts as identity when the name says nothing', () => {
      const hidden = { id: 'svc-h', name: 'Rodent Bait Station Service', short_name: null, frequency: 'monthly' };
      expect(resolveCloseCatalogService([hidden], 'rodent bait station')).toEqual({ row: null });
      const everySix = { id: 'svc-e', name: 'Rodent Bait Station Service', short_name: null, frequency: 'every_6_weeks' };
      expect(resolveCloseCatalogService([everySix], 'rodent bait station')).toEqual({ row: null });
    });
  });
});

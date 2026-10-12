/**
 * create_appointment close-name resolution (booking-service-match.js): a name
 * the owner dictates ("a pre-slab termite treatment") resolves to ONE catalog
 * service, several close services come back as choices, and a short phrase
 * never prices a service it only partly names. Pure: synthetic catalog rows.
 */
const { resolveCloseCatalogService, stripLeadingArticle } = require('../services/intelligence-bar/booking-service-match');

const SLAB = { id: 'svc-slab', name: 'Slab Pre-Treat Termite Service', short_name: 'Slab Pre-Treat' };
const PRETREATMENT = { id: 'svc-tpt', name: 'Termite Pretreatment Service', short_name: 'Pre-Treat' };
const SPOT = { id: 'svc-spot', name: 'Termite Spot Treatment Service', short_name: 'Spot Treat' };
const ONE_TIME_PEST = { id: 'svc-otp', name: 'One-Time Pest Control Service', short_name: null };
const QUARTERLY_PEST = { id: 'svc-qp', name: 'Quarterly Pest Control Service', short_name: null };
const CATALOG = [SLAB, PRETREATMENT, SPOT, ONE_TIME_PEST, QUARTERLY_PEST];

describe('resolveCloseCatalogService', () => {
  test('a dictated description with a leading article resolves to the one service it describes', () => {
    expect(resolveCloseCatalogService(CATALOG, 'a pre-slab termite treatment')).toEqual({ row: SLAB });
    expect(resolveCloseCatalogService(CATALOG, 'pre-slab termite treatment')).toEqual({ row: SLAB });
    expect(resolveCloseCatalogService(CATALOG, 'pre slab termite')).toEqual({ row: SLAB });
  });

  test('a spelling variant of a full name resolves to that row, not its lookalike', () => {
    expect(resolveCloseCatalogService(CATALOG, 'termite pretreatment')).toEqual({ row: PRETREATMENT });
    expect(resolveCloseCatalogService(CATALOG, 'termite spot treatment')).toEqual({ row: SPOT });
  });

  test('several close services come back as choices, best first, never a guess', () => {
    const result = resolveCloseCatalogService(CATALOG, 'pest control service');
    expect(result.row).toBeUndefined();
    expect(result.candidates.map((r) => r.name).sort()).toEqual([ONE_TIME_PEST.name, QUARTERLY_PEST.name]);
  });

  test('a short phrase that names only part of a service does not resolve it', () => {
    expect(resolveCloseCatalogService(CATALOG, 'pest control')).toEqual({ row: null });
    expect(resolveCloseCatalogService(CATALOG, 'termite')).toEqual({ row: null });
    expect(resolveCloseCatalogService(CATALOG, 'pre-slab')).toEqual({ row: null });
  });

  test('words that match no service, an empty phrase and an empty catalog resolve nothing', () => {
    expect(resolveCloseCatalogService(CATALOG, 'spider web sweep')).toEqual({ row: null });
    expect(resolveCloseCatalogService(CATALOG, '   ')).toEqual({ row: null });
    expect(resolveCloseCatalogService([], 'pre-slab termite treatment')).toEqual({ row: null });
  });
});

describe('stripLeadingArticle', () => {
  test('drops one leading article and leaves the rest', () => {
    expect(stripLeadingArticle('  A pre-slab treatment')).toBe('pre-slab treatment');
    expect(stripLeadingArticle('The Termite Pretreatment')).toBe('Termite Pretreatment');
    expect(stripLeadingArticle('Another service')).toBe('Another service');
  });
});

/**
 * Shared-email household: the subscriber row is pinned to an ARCHIVED profile
 * (linkToCustomer never refreshes a non-null link). The send path must read
 * personalization (city / grass) and stamp touchpoints from the LIVE twin —
 * resolved at load time, no writes — primary profile first, then oldest
 * created_at.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: () => false, unsubscribeUrl: () => '', sendOne: jest.fn() }));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn() }));
jest.mock('../services/newsletter-audience-profiles', () => ({
  selectAudience: jest.fn(async () => []),
  SELLABLE_LINES: ['lawn', 'pest', 'mosquito', 'termite', 'irrigation', 'tree_shrub'],
}));

const db = require('../models/db');
const { selectAudience } = require('../services/newsletter-audience-profiles');
const { resolveEffectiveCustomerIds, loadPersonalizationContext, selectSegmentRecipients, dropArchivedAfterSelection } = require('../services/newsletter-sender');
const { whereLiveCustomer, CUSTOMER_STAGES } = require('../services/customer-stages');

const ARCHIVED = 'cust-archived';
const LIVE_PRIMARY = 'cust-live-primary';
const LIVE_OLDER = 'cust-live-older';
const SUB = { id: 'sub-1', email: 'Household@Example.com ', customer_id: ARCHIVED };
const SOLO_SUB = { id: 'sub-2', email: 'solo@example.com', customer_id: 'cust-solo' };
const LEAD_SUB = { id: 'sub-3', email: 'lead@example.com', customer_id: null };

function chain(rows) {
  const q = {};
  ['whereIn', 'whereNotNull', 'whereNull', 'whereRaw', 'select', 'orderByRaw', 'where', 'modify'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.then = (res, rej) => Promise.resolve(rows).then(res, rej);
  return q;
}

// Ordered customers-table responses: 1) archived check, 2) live twins in the
// DB's ORDER BY (primary first, then created_at ASC), 3) personalization rows.
function routeCustomers(queries, { subscribers = null } = {}) {
  let n = 0;
  db.mockImplementation((table) => {
    if (table === 'customers') { const q = queries[n++] || chain([]); return q; }
    if (table === 'customer_turf_profiles') return chain([]);
    if (table === 'newsletter_subscribers' && subscribers) {
      const q = chain(subscribers);
      q.whereNotExists = jest.fn(() => q);
      q.whereExists = jest.fn(() => q);
      return q;
    }
    throw new Error(`unexpected table ${table}`);
  });
}

beforeEach(() => jest.clearAllMocks());

describe('resolveEffectiveCustomerIds', () => {
  test('substitutes the primary live twin for an archived link; live links and leads untouched', async () => {
    const twins = chain([
      { id: LIVE_PRIMARY, email: 'household@example.com', is_primary_profile: true, created_at: '2026-02-01' },
      { id: LIVE_OLDER, email: 'household@example.com', is_primary_profile: false, created_at: '2026-01-01' },
    ]);
    routeCustomers([chain([{ id: ARCHIVED }]), twins]);

    const map = await resolveEffectiveCustomerIds([SUB, SOLO_SUB, LEAD_SUB]);
    expect(map.get('sub-1')).toBe(LIVE_PRIMARY);
    expect(map.get('sub-2')).toBe('cust-solo');
    expect(map.get('sub-3')).toBeNull();
    // Deterministic ordering + normalized-email match are pushed to SQL.
    expect(twins.orderByRaw).toHaveBeenCalledWith('is_primary_profile DESC NULLS LAST, created_at ASC, id ASC');
    expect(twins.whereRaw).toHaveBeenCalledWith('LOWER(TRIM(email)) IN (?)', ['household@example.com']);
    // Canonical live-customer scope (active + not deleted + customer stage),
    // reused from customer-stages rather than a local copy.
    expect(twins.modify).toHaveBeenCalledWith(whereLiveCustomer);
  });

  test('same-email row in a non-customer stage (new_lead) is not a rescue — scope is delegated to whereLiveCustomer', () => {
    const q = { where: jest.fn(() => q), whereNull: jest.fn(() => q), whereIn: jest.fn(() => q) };
    whereLiveCustomer(q);
    expect(q.where).toHaveBeenCalledWith('active', true);
    expect(q.whereNull).toHaveBeenCalledWith('deleted_at');
    expect(q.whereIn).toHaveBeenCalledWith('pipeline_stage', CUSTOMER_STAGES);
    expect(CUSTOMER_STAGES).not.toContain('new_lead');
  });

  test('archived link with no live twin resolves to null (anti-join already excludes it)', async () => {
    routeCustomers([chain([{ id: ARCHIVED }]), chain([])]);
    const map = await resolveEffectiveCustomerIds([SUB]);
    expect(map.get('sub-1')).toBeNull();
  });

  test('no archived links → single cheap query, identity map', async () => {
    routeCustomers([chain([])]);
    const map = await resolveEffectiveCustomerIds([SOLO_SUB]);
    expect(map.get('sub-2')).toBe('cust-solo');
    expect(db).toHaveBeenCalledTimes(1);
  });
});

describe('loadPersonalizationContext fails closed', () => {
  test('resolver failure aborts (rejects) instead of falling back to the archived customer_id', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    await expect(loadPersonalizationContext([SUB])).rejects.toThrow(/effective-customer resolution failed/);
  });
});

describe('loadPersonalizationContext with an archived link', () => {
  test('city/grass come from the live twin and effectiveCustomerId points at it', async () => {
    routeCustomers([
      chain([{ id: ARCHIVED }]),
      chain([{ id: LIVE_PRIMARY, email: 'household@example.com', is_primary_profile: true, created_at: '2026-02-01' }]),
      chain([
        { id: LIVE_PRIMARY, city: 'Bradenton', lawn_type: 'zoysia' },
        { id: 'cust-solo', city: 'Sarasota', lawn_type: null },
      ]),
    ]);

    const ctx = await loadPersonalizationContext([SUB, SOLO_SUB, LEAD_SUB]);
    expect(ctx.effectiveCustomerId(SUB)).toBe(LIVE_PRIMARY);
    expect(ctx.effectiveCustomerId(SOLO_SUB)).toBe('cust-solo');
    expect(ctx.effectiveCustomerId(LEAD_SUB)).toBeNull();
    expect(ctx.has(ARCHIVED)).toBe(false);
    expect(ctx.get(LIVE_PRIMARY)).toEqual(expect.objectContaining({ city: 'Bradenton' }));
    expect(ctx.get(LIVE_PRIMARY).grassLabel).toMatch(/zoysia/i);
  });
});

// Segmentation runs on EFFECTIVE ids: resolve first, then match the
// service-line audience. The pinned (archived) id never decides membership.
describe('selectSegmentRecipients segments on the effective live customer', () => {
  const SEG = { has_service: ['lawn'] };
  const twins = () => chain([{ id: LIVE_PRIMARY, email: 'household@example.com', is_primary_profile: true, created_at: '2026-02-01' }]);

  test('archived link whose live twin matches the segment → included', async () => {
    selectAudience.mockResolvedValueOnce([{ customer_id: LIVE_PRIMARY }]);
    routeCustomers([chain([{ id: ARCHIVED }]), twins()], { subscribers: [SUB] });
    const rows = await selectSegmentRecipients(SEG);
    expect(rows.map((r) => r.id)).toEqual(['sub-1']);
  });

  test('archived link whose live twin does NOT match the segment → excluded (even though the archived id would)', async () => {
    selectAudience.mockResolvedValueOnce([{ customer_id: ARCHIVED }, { customer_id: 'cust-other' }]);
    routeCustomers([chain([{ id: ARCHIVED }]), twins()], { subscribers: [SUB] });
    const rows = await selectSegmentRecipients(SEG);
    expect(rows).toEqual([]);
  });

  test('live link unchanged: in the audience → included, not in it → excluded; leads never match a service-line segment', async () => {
    selectAudience.mockResolvedValueOnce([{ customer_id: 'cust-solo' }]);
    routeCustomers([chain([])], { subscribers: [SOLO_SUB, LEAD_SUB, { id: 'sub-4', email: 'x@example.com', customer_id: 'cust-x' }] });
    const rows = await selectSegmentRecipients(SEG);
    expect(rows.map((r) => r.id)).toEqual(['sub-2']);
  });

  test('no service-line intent → plain query rows, no resolution', async () => {
    routeCustomers([], { subscribers: [SUB, LEAD_SUB] });
    const rows = await selectSegmentRecipients(null);
    expect(rows.map((r) => r.id)).toEqual(['sub-1', 'sub-3']);
    expect(selectAudience).not.toHaveBeenCalled();
  });
});

// Archival AFTER recipient selection (or before a resume): the subscriber is
// removed from the batch before any payload/personalization/touchpoint.
describe('dropArchivedAfterSelection', () => {
  test('archived link with no live twin is dropped; live link and lead kept; personalization never loads the archived id', async () => {
    routeCustomers([chain([{ id: ARCHIVED }]), chain([])]);
    const { kept, dropped, effective } = await dropArchivedAfterSelection([SUB, SOLO_SUB, LEAD_SUB]);
    expect(dropped.map((s) => s.id)).toEqual(['sub-1']);
    expect(kept.map((s) => s.id)).toEqual(['sub-2', 'sub-3']);
    expect(effective.get('sub-1')).toBeNull();

    // The send loop builds payload/touchpoints from `kept` only; the
    // personalization load receives the same pre-resolved map and must not
    // touch the archived id — and must not collapse null back to it.
    const personalization = chain([{ id: 'cust-solo', city: 'Sarasota', lawn_type: null }]);
    routeCustomers([personalization]);
    const ctx = await loadPersonalizationContext(kept, { effective });
    expect(personalization.whereIn).toHaveBeenCalledWith('id', ['cust-solo']);
    expect(ctx.effectiveCustomerId(SUB)).toBeNull();
    expect(ctx.effectiveCustomerId(SOLO_SUB)).toBe('cust-solo');
  });

  test('resolver failure propagates (fail closed)', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    await expect(dropArchivedAfterSelection([SUB])).rejects.toThrow('db down');
  });
});

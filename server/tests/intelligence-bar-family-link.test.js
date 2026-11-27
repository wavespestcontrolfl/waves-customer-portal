/**
 * IB link_customer_family / unlink_customer_family (IB gap #27): the customer page's Same family Link and Unlink run
 * in process behind a card, on the platform path (needs GATE_IB_PLATFORM). What the card shows (both profiles, the
 * family after the link, that nothing is sent and no price changes), the refusals (same profile, inactive, already
 * linked, two families, not linked), pin drift (before and under the family-change lock), gate off, admin only, and
 * that the confirmed run calls the SAME shared service the page's route calls, once, inside one transaction that
 * takes the family-change lock first. The service is mocked here; the real service on real Postgres is
 * intelligence-bar-family-link-postgres.test.js. Synthetic names only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockFamily = {
  familyMembers: jest.fn(),
  linkFamily: jest.fn(),
  unlinkFamily: jest.fn(),
  lockFamilyChanges: jest.fn(async () => {}),
};
jest.mock('../services/multi-home-family', () => mockFamily);

const db = require('../models/db');
const { executeFamilyLinkTool, FAMILY_LINK_TOOLS, cardLines, pinnedDisplay } = require('../services/intelligence-bar/family-link-tools');
const registry = require('../services/intelligence-bar/action-registry');
const gates = require('../services/intelligence-bar/write-gates');
const { buildContract } = require('../services/intelligence-bar/authorization-contract');

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b1';
const C = '00000000-0000-4000-8000-0000000000c1';
const ADMIN = { isAdmin: true, technicianId: '00000000-0000-4000-8000-0000000000f1' };

let customers;
let families; // customer id -> family id
let order;
let extraRows; // family id -> membership rows of soft-deleted profiles (counted by the writer, hidden from the card's members)

const row = (id) => customers.find((c) => c.id === id);
const membersOf = (familyId) => Object.entries(families).filter(([, f]) => f === familyId).map(([id]) => {
  const c = row(id);
  return { id, name: `${c.first_name} ${c.last_name}`, address: `${c.address_line1}, ${c.city}, FL ${c.zip}`, active: c.active, isSelf: false };
});

function stubDb() {
  const make = () => (table) => {
    const q = { where: null, count: false };
    const b = {
      where: (w) => { q.where = w; return b; },
      whereIn: () => b,
      orderBy: () => b,
      forUpdate: () => { order.push(`rowlock:${table}`); return b; },
      select: async () => (table === 'multi_home_family_members' && q.where?.family_id
        ? Object.keys(families).filter((id) => families[id] === q.where.family_id).map((id) => ({ customer_id: id }))
        : []),
      count: () => { q.count = true; return b; },
      first: async () => {
        if (table === 'customers') return row(q.where.id);
        if (table === 'multi_home_family_members' && q.count) return { n: String(Object.values(families).filter((f) => f === q.where.family_id).length + (extraRows[q.where.family_id] || 0)) };
        return undefined;
      },
    };
    return b;
  };
  const fn = make();
  db.mockImplementation(fn);
  db.transaction = jest.fn(async (cb) => {
    order.push('tx');
    const trx = make();
    return cb(trx);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  order = [];
  extraRows = {};
  customers = [
    { id: A, first_name: 'Robin', last_name: 'Sample', company_name: null, address_line1: '100 Test Ln', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34201', active: true, deleted_at: null },
    { id: B, first_name: 'Casey', last_name: 'Sample', company_name: null, address_line1: '200 Demo Ave', address_line2: null, city: 'Sarasota', state: 'FL', zip: '34231', active: true, deleted_at: null },
    { id: C, first_name: 'Jordan', last_name: 'Example', company_name: null, address_line1: '300 Mock Rd', address_line2: null, city: 'Venice', state: 'FL', zip: '34285', active: true, deleted_at: null },
  ];
  families = {};
  mockFamily.familyMembers.mockImplementation(async (_conn, id) => (families[id] ? { familyId: families[id], members: membersOf(families[id]) } : { familyId: null, members: [] }));
  mockFamily.lockFamilyChanges.mockImplementation(async () => { order.push('lock'); });
  mockFamily.linkFamily.mockImplementation(async (_conn, { customerId, otherCustomerId }) => {
    order.push('link');
    const f = families[customerId] || families[otherCustomerId] || 'fam-new';
    families[customerId] = f; families[otherCustomerId] = f;
    return { familyId: f, members: membersOf(f) };
  });
  mockFamily.unlinkFamily.mockImplementation(async (_conn, { customerId }) => {
    order.push('unlink');
    const f = families[customerId];
    delete families[customerId];
    const left = Object.keys(families).filter((id) => families[id] === f);
    if (left.length === 1) delete families[left[0]];
    return { familyId: null, members: [] };
  });
  stubDb();
  process.env.GATE_IB_PLATFORM = 'true';
  process.env.GATE_IB_OWNER_DIRECT = 'true';
});
afterAll(() => { delete process.env.GATE_IB_PLATFORM; delete process.env.GATE_IB_OWNER_DIRECT; });

const link = (input = { customer_id: A, other_customer_id: B }, ctx = ADMIN) => executeFamilyLinkTool('link_customer_family', input, ctx);
const confirmLink = (card, input = { customer_id: A, other_customer_id: B }, ctx = ADMIN) => executeFamilyLinkTool('link_customer_family',
  { ...input, confirmed: true, _verified_family_link_version: card._version }, ctx);

describe('registration', () => {
  it('is a two-step, card-confirmed admin write on the platform path, never owner-direct', () => {
    for (const name of ['link_customer_family', 'unlink_customer_family']) {
      expect(gates.WRITE_TWO_STEP_TOOL_NAMES.has(name)).toBe(true);
      expect(gates.UI_GATED_WRITE_TOOL_NAMES.has(name)).toBe(true);
      expect(registry.actions.get(name)).toMatchObject({ domain: 'customers', role: 'admin', approval: 'ui_confirm', scope: 'record', module: 'family-link-tools.js' });
      expect(registry.policyErrors).not.toContain(name);
      expect(require('../services/intelligence-bar/owner-direct').OWNER_DIRECT_TOOL_NAMES.has(name)).toBe(false);
      // Two customers per card, one task target per request: owner login only.
      expect(gates.FULL_ACCESS_TWO_STEP_TOOL_NAMES.has(name)).toBe(true);
    }
    expect(FAMILY_LINK_TOOLS.map((t) => t.name)).toEqual(['link_customer_family', 'unlink_customer_family']);
    expect(registry.allowed(registry.actions.get('link_customer_family'), { role: 'admin', context: 'customers', fullAccess: true })).toBe(true);
    expect(registry.allowed(registry.actions.get('link_customer_family'), { role: 'admin', context: 'customers' })).toBe(false);
    expect(registry.allowed(registry.actions.get('link_customer_family'), { role: 'technician', context: 'tech' })).toBe(false);
    // Owner-direct off: a task holds one customer, so no link card could ever pass its target check; it is not offered.
    delete process.env.GATE_IB_OWNER_DIRECT;
    expect(registry.allowed(registry.actions.get('link_customer_family'), { role: 'admin', context: 'customers', fullAccess: true })).toBe(false);
    expect(registry.allowed(registry.actions.get('unlink_customer_family'), { role: 'admin', context: 'customers', fullAccess: true })).toBe(true);
    process.env.GATE_IB_OWNER_DIRECT = 'true';
    delete process.env.GATE_IB_PLATFORM;
    expect(registry.allowed(registry.actions.get('link_customer_family'), { role: 'admin', context: 'customers', fullAccess: true })).toBe(false);
  });
});

describe('link_customer_family', () => {
  it('previews both profiles and the family after the link, and writes nothing', async () => {
    const card = await link();
    expect(card).toMatchObject({ preview: true, tool: 'link_customer_family', customer_id: A, other_customer_id: B, joins_existing: false, sends_to_customer: false });
    expect(card.family_after).toEqual(['Robin Sample (100 Test Ln, Bradenton, FL 34201)', 'Casey Sample (200 Demo Ave, Sarasota, FL 34231)']);
    expect(mockFamily.linkFamily).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    const texts = cardLines('link_customer_family', card).map((l) => l.text);
    expect(texts).toEqual(expect.arrayContaining([
      'Account: Robin Sample, 100 Test Ln, Bradenton, FL 34201',
      'Family member: Casey Sample, 200 Demo Ave, Sarasota, FL 34231',
      'Confirming sends nothing: no text, email or call goes to anyone.',
      'No price, visit, invoice, Bill-To payer, contact or login changes now.',
    ]));
    expect(pinnedDisplay('link_customer_family', card)).toEqual({ account: 'Robin Sample', family_member: 'Casey Sample', family_after: 2, prices_change: 'no', sends_to_customer: 'nothing' });
    const contract = buildContract({ toolName: 'link_customer_family', params: { customer_id: A, other_customer_id: B }, displayParams: {}, preview: card, summary: 'x' });
    expect(JSON.stringify(contract)).toContain('Family member: Casey Sample');
  });

  it('names the automatic discount job and email only while their gates are on, and pins them', async () => {
    const plain = await link();
    expect(cardLines('link_customer_family', plain).some((l) => l.text.startsWith('Later, automatically'))).toBe(false);
    process.env.GATE_MULTI_HOME_ALL_HOMES = 'true';
    process.env.GATE_MULTI_HOME_DISCOUNT_EMAIL = 'true';
    try {
      const card = await link();
      const later = cardLines('link_customer_family', card).filter((l) => l.text.startsWith('Later, automatically'));
      expect(later.map((l) => l.kind)).toEqual(['billing', 'comms']);
      expect(card._version.later).toHaveLength(2);
      // A gate flipped between the card and Confirm is drift.
      delete process.env.GATE_MULTI_HOME_DISCOUNT_EMAIL;
      expect(await confirmLink(card)).toMatchObject({ code: 'preview_changed' });
    } finally {
      delete process.env.GATE_MULTI_HOME_ALL_HOMES;
      delete process.env.GATE_MULTI_HOME_DISCOUNT_EMAIL;
    }
  });

  it('shows the existing family when one side is already linked', async () => {
    families = { [B]: 'fam-1', [C]: 'fam-1' };
    const card = await link();
    expect(card.joins_existing).toBe(true);
    expect(card.family_after).toHaveLength(3);
    // The undo names the profile that joins (unlinking an original member would leave the newcomer linked).
    expect(cardLines('link_customer_family', card).map((l) => l.text)).toContain('Undo the link (not a discount already added): Unlink Robin Sample (the profile that joins) in its Same family section, or ask the bar to unlink it.');
  });

  it.each([
    ['the same profile twice', () => ({ customer_id: A, other_customer_id: A }), 'same_profile'],
    ['an inactive profile', () => { row(B).active = false; return undefined; }, 'profile_inactive'],
    ['a deleted profile', () => { row(B).deleted_at = new Date(); return undefined; }, 'customer_not_found'],
    ['profiles already linked', () => { families = { [A]: 'f', [B]: 'f' }; return undefined; }, 'already_linked'],
    ['two different families', () => { families = { [A]: 'f1', [C]: 'f1', [B]: 'f2' }; return undefined; }, 'different_families'],
    ['a malformed id', () => ({ customer_id: A, other_customer_id: 'nope' }), 'invalid_target'],
  ])('refuses %s', async (_label, arrange, code) => {
    const input = arrange();
    expect(await link(input)).toMatchObject({ code });
    expect(mockFamily.linkFamily).not.toHaveBeenCalled();
  });

  it('confirm takes the lock, re-reads the card under it, then links once through the shared service', async () => {
    const card = await link();
    const result = await confirmLink(card);
    expect(result).toMatchObject({ success: true, sent_to_customer: false, customer_id: A, other_customer_id: B });
    expect(order).toEqual(['tx', 'lock', 'rowlock:customers', 'link']);
    expect(mockFamily.linkFamily).toHaveBeenCalledTimes(1);
    expect(mockFamily.linkFamily.mock.calls[0][1]).toEqual({ customerId: A, otherCustomerId: B, actorId: ADMIN.technicianId });
  });

  it('refuses a card whose family changed before Confirm', async () => {
    const card = await link();
    families = { [B]: 'fam-1', [C]: 'fam-1' };
    expect(await confirmLink(card)).toMatchObject({ code: 'preview_changed', preview_changed: true });
    expect(mockFamily.linkFamily).not.toHaveBeenCalled();
  });

  it('refuses when the family changes between the pre-check and the lock', async () => {
    const card = await link();
    mockFamily.lockFamilyChanges.mockImplementationOnce(async () => { order.push('lock'); families = { [B]: 'fam-1', [C]: 'fam-1' }; });
    expect(await confirmLink(card)).toMatchObject({ code: 'preview_changed' });
    expect(mockFamily.linkFamily).not.toHaveBeenCalled();
  });

  it('passes the service\'s own refusal through as nothing changed', async () => {
    const card = await link();
    mockFamily.linkFamily.mockRejectedValueOnce(Object.assign(new Error('One of these profiles was linked by someone else just now. Reload and try again.'), { code: 'multi_home_family', isOperational: true }));
    expect(await confirmLink(card)).toMatchObject({ failed: true, code: 'family_refused', error: expect.stringContaining('Nothing was changed') });
  });

  it('reports an unexpected failure as outcome unknown', async () => {
    const card = await link();
    mockFamily.linkFamily.mockRejectedValueOnce(new Error('connection reset'));
    expect(await confirmLink(card)).toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
  });

  it('needs the card pin, an admin, and the platform path', async () => {
    expect(await executeFamilyLinkTool('link_customer_family', { customer_id: A, other_customer_id: B, confirmed: true }, ADMIN)).toMatchObject({ code: 'approval_required' });
    const card = await link();
    expect(await confirmLink(card, undefined, { isAdmin: undefined })).toMatchObject({ code: 'permission_denied' });
    expect(await link(undefined, { isAdmin: false })).toMatchObject({ code: 'permission_denied' });
    delete process.env.GATE_IB_PLATFORM;
    expect(await link()).toMatchObject({ code: 'gate_off' });
    expect(mockFamily.linkFamily).not.toHaveBeenCalled();
  });
});

describe('unlink_customer_family', () => {
  const unlink = (input = { customer_id: A }) => executeFamilyLinkTool('unlink_customer_family', input, ADMIN);

  it('refuses a profile that is not linked', async () => {
    expect(await unlink()).toMatchObject({ code: 'not_linked' });
  });

  it('previews a two-profile family as dissolved, then unlinks once under the lock', async () => {
    families = { [A]: 'f', [B]: 'f' };
    const card = await unlink();
    expect(card).toMatchObject({ preview: true, tool: 'unlink_customer_family', dissolves: true, stays_linked: [] });
    expect(cardLines('unlink_customer_family', card).map((l) => l.text)).toContain('Casey Sample is then alone, so the family link is removed from both profiles.');
    const result = await executeFamilyLinkTool('unlink_customer_family', { customer_id: A, confirmed: true, _verified_family_link_version: card._version }, ADMIN);
    expect(result).toMatchObject({ success: true, sent_to_customer: false });
    expect(order).toEqual(['tx', 'lock', 'rowlock:customers', 'unlink']);
    expect(families).toEqual({});
  });

  it('does not call a family dissolved when a soft-deleted profile still holds a membership row', async () => {
    families = { [A]: 'f', [B]: 'f' };
    extraRows = { f: 1 };
    const card = await unlink();
    expect(card.dissolves).toBe(false);
    expect(cardLines('unlink_customer_family', card).map((l) => l.text)).toContain('Casey Sample stays in the family.');
  });

  it('keeps the others linked in a bigger family', async () => {
    families = { [A]: 'f', [B]: 'f', [C]: 'f' };
    const card = await unlink();
    expect(card.dissolves).toBe(false);
    expect(card.stays_linked).toHaveLength(2);
  });
});

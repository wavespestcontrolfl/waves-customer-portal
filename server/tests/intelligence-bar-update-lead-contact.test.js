/**
 * update_lead_contact (IB gap #2): the bar could not edit a lead's name /
 * phone / email. Two-step write: the unconfirmed call resolves the lead,
 * validates the fields and returns a before → after diff without writing;
 * the confirmed call commits inside one transaction whose UPDATE re-asserts
 * every "from" value and appends the activity row.
 */

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  fn.transaction = jest.fn(async (cb) => cb(fn));
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/lead-funnel-bridge', () => ({
  bridgeLeadFunnelStage: jest.fn().mockResolvedValue(undefined),
  bridgeLeadsFunnelStage: jest.fn().mockResolvedValue(undefined),
}));

const db = require('../models/db');
const { executeLeadsTool, LEADS_TOOLS } = require('../services/intelligence-bar/leads-tools');
const { buildContract } = require('../services/intelligence-bar/authorization-contract');

function chain(resultByMethod = {}) {
  const c = {};
  for (const m of ['where', 'whereIn', 'whereNull', 'whereRaw', 'whereILike', 'orWhereILike', 'orWhereRaw', 'orWhere', 'leftJoin', 'orderBy', 'clone']) {
    c[m] = jest.fn(function (arg) {
      // Grouped where(function () {...}) callbacks run against the chain.
      if (typeof arg === 'function') arg.call(c);
      return c;
    });
  }
  for (const m of ['first', 'limit', 'select', 'update', 'insert']) {
    c[m] = jest.fn(async () => resultByMethod[m]);
  }
  return c;
}

const LEAD = { id: 'lead-1', first_name: 'Testc', last_name: 'Beta', status: 'contacted', phone: '+19415553333', email: null, customer_id: null };
const LEAD_B = { id: 'lead-2', first_name: 'Testd', last_name: 'Beta', status: 'new', phone: '+19415554444', email: null };

beforeEach(() => jest.clearAllMocks());

test('the tool is registered without a model-facing confirmed flag', () => {
  const tool = LEADS_TOOLS.find(t => t.name === 'update_lead_contact');
  expect(tool).toBeDefined();
  expect(Object.keys(tool.input_schema.properties)).not.toContain('confirmed');
});

test('unconfirmed: returns the before → after diff and writes nothing', async () => {
  const leads = chain({ first: LEAD });
  db.mockReturnValue(leads);
  const res = await executeLeadsTool('update_lead_contact', {
    lead_id: 'lead-1', first_name: 'Tess', phone: '(941) 555-0199', email: 'Tess@Example.test ',
  });
  expect(res.preview).toBe(true);
  expect(res.lead_name).toBe('Testc Beta');
  expect(res.changes).toEqual({
    first_name: { from: 'Testc', to: 'Tess' },
    phone: { from: '+19415553333', to: '+19415550199' },
    email: { from: null, to: 'tess@example.test' },
  });
  expect(leads.update).not.toHaveBeenCalled();
  expect(leads.insert).not.toHaveBeenCalled();
  expect(db.transaction).not.toHaveBeenCalled();
});

test('a field already at the requested value is not in the diff; all-unchanged refuses', async () => {
  db.mockReturnValue(chain({ first: LEAD }));
  const same = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', last_name: 'Beta', phone: '9415553333' });
  expect(same.error).toMatch(/already has those contact details/);
  const mixed = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', last_name: 'Beta', first_name: 'Tess' });
  expect(Object.keys(mixed.changes)).toEqual(['first_name']);
});

test('invalid inputs are refused before any lookup', async () => {
  db.mockReturnValue(chain({ first: LEAD }));
  expect((await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1' })).error).toMatch(/Nothing to update/);
  expect((await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', first_name: '  ' })).error).toMatch(/first_name cannot be blank/);
  expect((await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', phone: '12' })).error).toMatch(/not a valid phone/);
  expect((await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', email: 'nope' })).error).toMatch(/not a valid email/);
  expect(db).not.toHaveBeenCalled();
});

test('blank last_name / phone / email clear the field', async () => {
  db.mockReturnValue(chain({ first: { ...LEAD, email: 'old@example.test' } }));
  const res = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', last_name: '', email: '' });
  expect(res.changes).toEqual({
    last_name: { from: 'Beta', to: null },
    email: { from: 'old@example.test', to: null },
  });
});

test('a name matching two active leads is refused — nothing is written', async () => {
  const leads = chain({ limit: [LEAD, LEAD_B] });
  db.mockReturnValue(leads);
  const res = await executeLeadsTool('update_lead_contact', { lead_name: 'Beta', first_name: 'Tess' });
  expect(res.ambiguous).toBe(true);
  expect(res.candidates.map(c => c.id)).toEqual(['lead-1', 'lead-2']);
  expect(leads.update).not.toHaveBeenCalled();
});

test('confirmed: commits in one transaction, re-asserting each old value, and appends the activity row', async () => {
  const leads = chain({ first: LEAD, update: [{ id: 'lead-1' }] });
  const activities = chain({ insert: undefined });
  db.mockImplementation((table) => (table === 'leads' ? leads : activities));

  const res = await executeLeadsTool('update_lead_contact', {
    lead_id: 'lead-1', first_name: 'Tess', email: 'tess@example.test', confirmed: true,
  });
  expect(res.success).toBe(true);
  expect(res.updated_fields).toEqual(['first_name', 'email']);
  expect(db.transaction).toHaveBeenCalledTimes(1);
  expect(leads.where).toHaveBeenCalledWith('id', 'lead-1');
  expect(leads.whereNull).toHaveBeenCalledWith('deleted_at');
  // Old first name re-asserted; old email was NULL so the guard is NULL-or-empty.
  expect(leads.where).toHaveBeenCalledWith('first_name', 'Testc');
  expect(leads.whereNull).toHaveBeenCalledWith('email');
  expect(leads.orWhere).toHaveBeenCalledWith('email', '');
  expect(leads.update).toHaveBeenCalledWith(
    expect.objectContaining({ first_name: 'Tess', email: 'tess@example.test', updated_at: expect.any(Date) }), ['id'],
  );
  expect(leads.update.mock.calls[0][0]).not.toHaveProperty('phone');
  expect(activities.insert).toHaveBeenCalledWith(expect.objectContaining({
    lead_id: 'lead-1', activity_type: 'updated', performed_by: 'Intelligence Bar',
    description: 'Contact updated: first_name, email',
  }));
});

test('confirmed: a zero-row guarded update (concurrent edit) refuses with preview_changed and appends nothing', async () => {
  const leads = chain({ first: LEAD, update: [] });
  const activities = chain({ insert: undefined });
  db.mockImplementation((table) => (table === 'leads' ? leads : activities));
  const res = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', first_name: 'Tess', confirmed: true });
  expect(res.preview_changed).toBe(true);
  expect(res.success).toBeUndefined();
  expect(activities.insert).not.toHaveBeenCalled();
});

test('a lead linked to a customer says the customer account is untouched', async () => {
  db.mockReturnValue(chain({ first: { ...LEAD, customer_id: 'cust-1' } }));
  const res = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', first_name: 'Tess' });
  expect(res.linked_customer_unchanged).toBe(true);
  expect(res.note).toMatch(/customer account is NOT changed/);
});

test('authorization contract: one before/after effect per changed field, tier yellow', () => {
  const preview = {
    preview: true, lead_id: 'lead-1', lead_name: 'Testc Beta', lead_status: 'contacted',
    changes: { first_name: { from: 'Testc', to: 'Tess' }, email: { from: null, to: 'tess@example.test' } },
  };
  const c = buildContract({
    toolName: 'update_lead_contact',
    params: { lead_id: 'lead-1', first_name: 'Tess', email: 'tess@example.test' },
    displayParams: { lead: 'Testc Beta (contacted)', first_name: 'Testc → Tess', email: '(empty) → tess@example.test' },
    preview,
  });
  expect(c.tier).toBe('yellow');
  expect(c.action_label).toBe('Update lead contact details');
  expect(c.notifies_customer).toBe(false);
  expect(c.effects).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'customer', label: 'Lead Testc Beta: first name Testc → Tess', before: 'Testc', after: 'Tess' }),
    expect.objectContaining({ kind: 'customer', label: 'Lead Testc Beta: email (empty) → tess@example.test', before: '(empty)', after: 'tess@example.test' }),
    expect.objectContaining({ kind: 'operational', label: expect.stringMatching(/activity history.*customer account is NOT changed/) }),
  ]));
  expect(c.preview_fingerprint).toEqual(expect.any(String));
});

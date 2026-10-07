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
  // Too many digits is refused, never truncated to the last ten.
  expect((await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', phone: '941555019912' })).error).toMatch(/not a valid phone/);
  expect((await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', phone: '+1 (941) 555-01' })).error).toMatch(/not a valid phone/);
  // Canonical E.164 only: no leading-zero country code; a 255+ char email is refused at preview.
  expect((await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', phone: '+0123456789' })).error).toMatch(/not a valid phone/);
  // An area code starting 0/1 can never exist, so it is refused too. The exchange is
  // not checked (the fictional 555-01xx range is a test fixture; Twilio 21211 covers it).
  expect((await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', phone: '1035550199' })).error).toMatch(/not a valid phone/);
  expect((await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', phone: '+11035550199' })).error).toMatch(/not a valid phone/);
  expect((await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', email: `${'a'.repeat(250)}@example.test` })).error).toMatch(/too long/);
  // Extensions / letters are refused, never folded into the number.
  expect((await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', phone: '+1 (941) 555-0199 ext 23' })).error).toMatch(/no extension/);
  expect((await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', phone: '941-555-0199 x4' })).error).toMatch(/no extension/);
  expect((await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', email: 'nope' })).error).toMatch(/not a valid email/);
  expect(db).not.toHaveBeenCalled();
});

test('phone shapes: 10 digits, 1 + 10 digits, and +country all normalize to E.164', async () => {
  db.mockReturnValue(chain({ first: LEAD }));
  for (const [raw, e164] of [['941-555-0199', '+19415550199'], ['1 (941) 555-0199', '+19415550199'], ['+44 20 7946 0958', '+442079460958'], ['+299 12 34 56', '+299123456']]) {
    const res = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', phone: raw });
    expect(res.changes).toEqual({ phone: { from: '+19415553333', to: e164 } });
  }
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

test('confirmed with the pinned diff: the WHERE re-asserts the APPROVED old value, not the re-read one', async () => {
  // Another writer changed first_name between the card and this commit.
  const leads = chain({ first: { ...LEAD, first_name: 'Someone' }, update: [] });
  const activities = chain({ insert: undefined });
  db.mockImplementation((table) => (table === 'leads' ? leads : activities));
  const res = await executeLeadsTool('update_lead_contact', {
    lead_id: 'lead-1', first_name: 'Tess', confirmed: true,
    _approved_changes: { first_name: { from: 'Testc', to: 'Tess' } },
  });
  expect(leads.where).toHaveBeenCalledWith('first_name', 'Testc');
  expect(leads.where).not.toHaveBeenCalledWith('first_name', 'Someone');
  expect(res.preview_changed).toBe(true);
  expect(activities.insert).not.toHaveBeenCalled();
});

test('confirmed: a pinned diff that does not match the request is refused', async () => {
  const leads = chain({ first: LEAD, update: [{ id: 'lead-1' }] });
  db.mockReturnValue(leads);
  const res = await executeLeadsTool('update_lead_contact', {
    lead_id: 'lead-1', first_name: 'Tess', confirmed: true,
    _approved_changes: { first_name: { from: 'Testc', to: 'Other' } },
  });
  expect(res.preview_changed).toBe(true);
  expect(res.error).toMatch(/do not match this request/);
  expect(leads.update).not.toHaveBeenCalled();
});

test('unconfirmed ignores a stray pinned diff and recomputes from the live row', async () => {
  db.mockReturnValue(chain({ first: LEAD }));
  const res = await executeLeadsTool('update_lead_contact', {
    lead_id: 'lead-1', first_name: 'Tess', _approved_changes: { first_name: { from: 'Zed', to: 'Tess' } },
  });
  expect(res.preview).toBe(true);
  expect(res.changes).toEqual({ first_name: { from: 'Testc', to: 'Tess' } });
});

test('a real email change stamps email_confirmed_at in the same guarded update; other fields do not', async () => {
  const leads = chain({ first: { ...LEAD, email: 'Old@Example.test' }, update: [{ id: 'lead-1' }] });
  const activities = chain({ insert: undefined });
  db.mockImplementation((table) => (table === 'leads' ? leads : activities));
  const res = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', email: 'new@example.test', confirmed: true });
  expect(res.success).toBe(true);
  const written = leads.update.mock.calls[0][0];
  expect(written.email).toBe('new@example.test');
  expect(written.email_confirmed_at).toEqual(written.updated_at);
  // The old value is re-asserted case-insensitively.
  expect(leads.whereRaw).toHaveBeenCalledWith('LOWER(TRIM(email)) = ?', ['old@example.test']);

  jest.clearAllMocks();
  const leads2 = chain({ first: LEAD, update: [{ id: 'lead-1' }] });
  db.mockImplementation((table) => (table === 'leads' ? leads2 : activities));
  await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', first_name: 'Tess', confirmed: true });
  expect(leads2.update.mock.calls[0][0]).not.toHaveProperty('email_confirmed_at');
});

test('a legacy mixed-case email re-saved unchanged is not a change (no false confirmation stamp)', async () => {
  db.mockReturnValue(chain({ first: { ...LEAD, email: 'Old@Example.test' } }));
  const res = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', email: 'old@example.test' });
  expect(res.error).toMatch(/already has those contact details/);
});

test('a lead linked to a customer says the customer account is untouched', async () => {
  db.mockReturnValue(chain({ first: { ...LEAD, customer_id: 'cust-1' } }));
  const res = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', first_name: 'Tess' });
  expect(res.linked_customer_unchanged).toBe(true);
  expect(res.note).toMatch(/customer account, if any, is NOT changed/);
});

test('authorization contract: clearing the email says the disagreement card stays open', () => {
  const preview = { preview: true, lead_id: 'lead-1', lead_name: 'Testc Beta', lead_status: 'contacted', changes: { email: { from: 'old@example.test', to: null } } };
  const c = buildContract({ toolName: 'update_lead_contact', params: { lead_id: 'lead-1', email: '' }, displayParams: { lead: 'Testc Beta (contacted)', email: 'old@example.test → (cleared)' }, preview });
  expect(c.effects.map(e => e.label)).toEqual(expect.arrayContaining([expect.stringMatching(/Clearing the email.*stays open/)]));
  expect(c.effects.map(e => e.label)).not.toEqual(expect.arrayContaining([expect.stringMatching(/counts as the correction/)]));
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
    expect.objectContaining({ kind: 'operational', label: expect.stringMatching(/email-confirmed time.*email-disagreement/) }),
  ]));
  expect(c.preview_fingerprint).toEqual(expect.any(String));
});

// Address (owner IB history 10-06: the bar could not fix a lead's street
// address). One structural rule (Codex #6099 r7): an address edit gives
// street, city and ZIP together, none blank; the card and the commit treat
// the three as one set. No state field (leads have no state column).
test('query_leads returns the stored ZIP, so a street-only fix can pass the current city and ZIP', async () => {
  const q = chain({ limit: [{ ...LEAD, address: '21 Palm Ave', city: 'Sarasota', zip: '34201' }] });
  q.select = jest.fn(() => q);
  db.mockReturnValue(q);
  const res = await executeLeadsTool('query_leads', { search: 'Beta' });
  expect(res.leads[0]).toMatchObject({ address: '21 Palm Ave', city: 'Sarasota', zip: '34201' });
});

test('the street part must be the street line only: an embedded city or ZIP is refused, a unit is fine', async () => {
  db.mockReturnValue(chain({ first: { ...LEAD, address: '100 Main St, Sarasota, FL 34201', city: 'Sarasota', zip: '34201' } }));
  const full = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', address: '100 Main St, Sarasota, FL 34201', city: 'Bradenton', zip: '34208' });
  expect(full.error).toMatch(/street line only/);
  const trailingZip = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', address: '100 Main St Sarasota FL 34201', city: 'Bradenton', zip: '34208' });
  expect(trailingZip.error).toMatch(/street line only/);
  const unit = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', address: '1 Example Way, Apt 4B', city: 'Bradenton', zip: '34208' });
  expect(unit.preview).toBe(true);
});

describe('address fields', () => {
  const ADDR_LEAD = { ...LEAD, address: '21 Palm Ave', city: 'Sarasota', zip: '34201' };
  const NEW = { address: '12 Palm Ave', city: 'Sarasota', zip: '34201' };

  test('all three together: a card with the whole address, unchanged parts shown as they stay; nothing written', async () => {
    const leads = chain({ first: ADDR_LEAD });
    db.mockReturnValue(leads);
    const res = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', address: ' 12 Palm Ave ', city: 'Sarasota', zip: '34201' });
    expect(res.preview).toBe(true);
    expect(res.changes).toEqual({
      address: { from: '21 Palm Ave', to: '12 Palm Ave' },
      city: { from: 'Sarasota', to: 'Sarasota' },
      zip: { from: '34201', to: '34201' },
    });
    expect(res.estimates_keep_address).toBe(true);
    expect(leads.update).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test.each([
    ['street only', { address: '12 Palm Ave' }],
    ['city only', { city: 'Bradenton' }],
    ['ZIP only', { zip: '34208' }],
    ['street and city', { address: '12 Palm Ave', city: 'Bradenton' }],
    ['a blank part', { address: '12 Palm Ave', city: 'Bradenton', zip: '' }],
    ['all blank', { address: '', city: '', zip: '' }],
  ])('refuses a partial address edit: %s', async (_label, fields) => {
    const leads = chain({ first: { ...ADDR_LEAD, address: '100 Main St, Sarasota, FL 34201' } });
    db.mockReturnValue(leads);
    const res = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', ...fields });
    expect(res).toEqual({ error: 'Give the street, city and ZIP together. Nothing was proposed.' });
    expect(leads.first).not.toHaveBeenCalled();
  });

  test('the same address again is not a change; a name-only edit does not mention estimates', async () => {
    db.mockReturnValue(chain({ first: ADDR_LEAD }));
    expect((await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', address: '21 Palm Ave', city: 'Sarasota', zip: '34201' })).error)
      .toMatch(/already has those contact details/);
    const name = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', first_name: 'Tess' });
    expect(name.estimates_keep_address).toBeUndefined();
    expect(Object.keys(name.changes)).toEqual(['first_name']);
  });

  test('over-long parts are refused (the lead editor\'s caps)', async () => {
    db.mockReturnValue(chain({ first: ADDR_LEAD }));
    const edit = (over) => executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', ...NEW, ...over });
    expect((await edit({ address: 'x'.repeat(256) })).error).toBe('address is too long (255 characters max).');
    expect((await edit({ city: 'x'.repeat(121) })).error).toBe('city is too long (120 characters max).');
    expect((await edit({ zip: '1'.repeat(21) })).error).toBe('zip is too long (20 characters max).');
  });

  test('the schema offers address, city and zip but no state (leads have no state column)', () => {
    const props = LEADS_TOOLS.find(t => t.name === 'update_lead_contact').input_schema.properties;
    expect(props).toEqual(expect.objectContaining({ address: expect.any(Object), city: expect.any(Object), zip: expect.any(Object) }));
    expect(props).not.toHaveProperty('state');
  });

  const APPROVED = {
    address: { from: '21 Palm Ave', to: '12 Palm Ave' },
    city: { from: 'Sarasota', to: 'Sarasota' },
    zip: { from: '34201', to: '34201' },
  };

  test('confirmed: writes the address and re-asserts ALL THREE approved stored values in the WHERE', async () => {
    const leads = chain({ first: ADDR_LEAD, update: [{ id: 'lead-1' }] });
    const activities = chain({ insert: undefined });
    db.mockImplementation((table) => (table === 'leads' ? leads : activities));
    const res = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', ...NEW, confirmed: true, _approved_changes: APPROVED });
    expect(res.success).toBe(true);
    expect(leads.where).toHaveBeenCalledWith('address', '21 Palm Ave');
    expect(leads.where).toHaveBeenCalledWith('city', 'Sarasota');
    expect(leads.where).toHaveBeenCalledWith('zip', '34201');
    expect(leads.update.mock.calls[0][0]).toMatchObject({ address: '12 Palm Ave', city: 'Sarasota', zip: '34201' });
    expect(leads.update.mock.calls[0][0]).not.toHaveProperty('email_confirmed_at');
  });

  test('confirmed: another edit to an UNCHANGED part (the city) after the card matches no row → preview_changed', async () => {
    // The guarded UPDATE matches nothing because the stored city is no longer the approved "Sarasota".
    const leads = chain({ first: { ...ADDR_LEAD, city: 'Venice' }, update: [] });
    const activities = chain({ insert: undefined });
    db.mockImplementation((table) => (table === 'leads' ? leads : activities));
    const res = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', ...NEW, confirmed: true, _approved_changes: APPROVED });
    expect(leads.where).toHaveBeenCalledWith('city', 'Sarasota');
    expect(res.preview_changed).toBe(true);
    expect(activities.insert).not.toHaveBeenCalled();
  });

  test('authorization contract: one line per address part, plus the estimates line', () => {
    const preview = { preview: true, lead_id: 'lead-1', lead_name: 'Testc Beta', lead_status: 'contacted', estimates_keep_address: true, changes: APPROVED };
    const c = buildContract({ toolName: 'update_lead_contact', params: { lead_id: 'lead-1', ...NEW }, displayParams: {}, preview });
    expect(c.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'customer', label: 'Lead Testc Beta: address 21 Palm Ave → 12 Palm Ave', before: '21 Palm Ave', after: '12 Palm Ave' }),
      expect.objectContaining({ kind: 'customer', label: 'Lead Testc Beta: zip 34201 → 34201' }),
      expect.objectContaining({ kind: 'operational', label: 'Estimates already made for this lead keep the address they were made with' }),
    ]));
    expect(c.notifies_customer).toBe(false);
  });
});

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
  expect(res.note).toMatch(/customer account is NOT changed/);
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

// ─── address fields (the lead's own address, city and zip) ──────

const ADDR_LEAD = { ...LEAD, address: '21 Synthetic Oak Ave', city: 'Testville', zip: '34200' };

test('the tool schema offers address, city and zip, and the description says so', () => {
  const tool = LEADS_TOOLS.find(t => t.name === 'update_lead_contact');
  expect(Object.keys(tool.input_schema.properties)).toEqual(expect.arrayContaining(['address', 'city', 'zip']));
  expect(tool.description).toMatch(/address/);
});

test('address-only change: diffs just the address and writes nothing on preview', async () => {
  const leads = chain({ first: ADDR_LEAD });
  db.mockReturnValue(leads);
  const res = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', address: '  12 Synthetic Oak Ave ' });
  expect(res.preview).toBe(true);
  expect(res.changes).toEqual({ address: { from: '21 Synthetic Oak Ave', to: '12 Synthetic Oak Ave' } });
  expect(leads.update).not.toHaveBeenCalled();
});

test('an unchanged address (or city, zip) is "nothing to change"; a mixed request keeps only the real change', async () => {
  db.mockReturnValue(chain({ first: ADDR_LEAD }));
  const same = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', address: '21 Synthetic Oak Ave', city: 'Testville', zip: '34200' });
  expect(same.error).toMatch(/already has those contact details/);
  const mixed = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', address: '21 Synthetic Oak Ave', zip: '34201' });
  expect(mixed.changes).toEqual({ zip: { from: '34200', to: '34201' } });
});

test('address, city and zip over the admin form caps are refused before any lookup; blank clears', async () => {
  db.mockReturnValue(chain({ first: ADDR_LEAD }));
  expect((await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', address: 'a'.repeat(256) })).error).toMatch(/address is too long/);
  expect((await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', city: 'c'.repeat(121) })).error).toMatch(/city is too long/);
  expect((await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', zip: '1'.repeat(21) })).error).toMatch(/zip is too long/);
  expect(db).not.toHaveBeenCalled();
  const cleared = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', city: '  ' });
  expect(cleared.changes).toEqual({ city: { from: 'Testville', to: null } });
});

test('confirmed address change: guarded UPDATE re-asserts the old address and the activity row names it', async () => {
  const leads = chain({ first: ADDR_LEAD, update: [{ id: 'lead-1' }] });
  const activities = chain({ insert: undefined });
  db.mockImplementation((table) => (table === 'leads' ? leads : activities));
  const res = await executeLeadsTool('update_lead_contact', {
    lead_id: 'lead-1', address: '12 Synthetic Oak Ave', confirmed: true,
    _approved_changes: { address: { from: '21 Synthetic Oak Ave', to: '12 Synthetic Oak Ave' } },
  });
  expect(res.success).toBe(true);
  expect(res.updated_fields).toEqual(['address']);
  expect(leads.where).toHaveBeenCalledWith('address', '21 Synthetic Oak Ave');
  const written = leads.update.mock.calls[0][0];
  expect(written).toEqual(expect.objectContaining({ address: '12 Synthetic Oak Ave', updated_at: expect.any(Date) }));
  // An address edit stamps nothing else (no email confirmation, no geocode field).
  expect(Object.keys(written).sort()).toEqual(['address', 'updated_at']);
  expect(activities.insert).toHaveBeenCalledWith(expect.objectContaining({ description: 'Contact updated: address' }));
});

test('confirmed: a changed city between card and commit refuses with preview_changed', async () => {
  const leads = chain({ first: ADDR_LEAD, update: [] });
  const activities = chain({ insert: undefined });
  db.mockImplementation((table) => (table === 'leads' ? leads : activities));
  const res = await executeLeadsTool('update_lead_contact', {
    lead_id: 'lead-1', city: 'Newtown', confirmed: true,
    _approved_changes: { city: { from: 'Testville', to: 'Newtown' } },
  });
  expect(leads.where).toHaveBeenCalledWith('city', 'Testville');
  expect(res.preview_changed).toBe(true);
  expect(activities.insert).not.toHaveBeenCalled();
});

test('authorization contract: the card shows the old and new address and says nothing else is re-looked-up', () => {
  const preview = {
    preview: true, lead_id: 'lead-1', lead_name: 'Testc Beta', lead_status: 'contacted',
    changes: { address: { from: '21 Synthetic Oak Ave', to: '12 Synthetic Oak Ave' } },
  };
  const c = buildContract({
    toolName: 'update_lead_contact',
    params: { lead_id: 'lead-1', address: '12 Synthetic Oak Ave' },
    displayParams: { lead: 'Testc Beta (contacted)', address: '21 Synthetic Oak Ave → 12 Synthetic Oak Ave' },
    preview,
  });
  expect(c.effects).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'customer', label: 'Lead Testc Beta: address 21 Synthetic Oak Ave → 12 Synthetic Oak Ave', before: '21 Synthetic Oak Ave', after: '12 Synthetic Oak Ave' }),
    expect.objectContaining({ kind: 'operational', label: expect.stringMatching(/own address fields change.*keeps its own address/) }),
  ]));
  expect(c.effects.map(e => e.label)).not.toEqual(expect.arrayContaining([expect.stringMatching(/email-confirmed/)]));
});

// ─── a one-line address is replaced whole, never half-edited ────

const ONE_LINE_REFUSAL = "This lead's address is stored as one line (street, city, ZIP). Give the whole corrected address in one message.";
const COMPOSED = '21 Synthetic Oak Ave, Testville, FL 34200';
const COMPOSED_LEAD = { ...LEAD, address: COMPOSED, city: 'Testville', zip: '34200' };
const TWO_SEG = '21 Oak Ave, Sarasota FL 34200';
const TWO_SEG_LEAD = { ...LEAD, address: TWO_SEG, city: 'Sarasota', zip: '34200' };
const NO_COMMA = '100 Main St Sarasota FL 34236';
const NO_COMMA_LEAD = { ...LEAD, address: NO_COMMA, city: 'Sarasota', zip: '34236' };
const OPAQUE_LEAD = { ...ADDR_LEAD, address: '21 Oak Ave, Testville' };

test('a whole address on a one-line row replaces the line and syncs city and zip (comma, comma-free, two-segment, unit)', async () => {
  const whole = '12 Pine Rd, Bradenton, FL 34201';
  for (const lead of [COMPOSED_LEAD, TWO_SEG_LEAD, NO_COMMA_LEAD, OPAQUE_LEAD]) {
    db.mockReturnValue(chain({ first: lead }));
    const res = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', address: whole });
    expect(res.changes).toEqual({
      address: { from: lead.address, to: whole },
      city: { from: lead.city, to: 'Bradenton' },
      zip: { from: lead.zip, to: '34201' },
    });
    expect(res.asserted_fields).toEqual(['address', 'city', 'zip']);
  }
  db.mockReturnValue(chain({ first: TWO_SEG_LEAD }));
  for (const [given, line] of [
    ['100 Main St Bradenton FL 34201', '100 Main St, Bradenton, FL 34201'],
    ['21 Oak Ave Unit 4, Bradenton FL 34201', '21 Oak Ave Unit 4, Bradenton, FL 34201'],
    ['21 Oak Ave, Unit 4, Bradenton, FL 34201', '21 Oak Ave Unit 4, Bradenton, FL 34201'],
  ]) {
    const res = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', address: given });
    expect(res.changes.address).toEqual({ from: TWO_SEG, to: line });
    expect(res.changes.city).toEqual({ from: 'Sarasota', to: 'Bradenton' });
    const segs = line.split(',').map(x => x.trim().toLowerCase());
    expect(new Set(segs).size).toBe(segs.length);
  }
});

test('a whole address equal to the stored one is nothing to change; a state-only difference is a change', async () => {
  db.mockReturnValue(chain({ first: COMPOSED_LEAD }));
  const same = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', address: '21 Synthetic Oak Avenue, testville, FL 34200' });
  expect(same.error).toMatch(/already has those contact details/);
  const state = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', address: '21 Synthetic Oak Ave, Testville, GA 34200' });
  expect(state.changes).toEqual({ address: { from: COMPOSED, to: '21 Synthetic Oak Ave, Testville, GA 34200' } });
});

test('every partial edit on a one-line row refuses with no write', async () => {
  for (const lead of [COMPOSED_LEAD, TWO_SEG_LEAD, NO_COMMA_LEAD, OPAQUE_LEAD]) {
    const leads = chain({ first: lead });
    db.mockReturnValue(leads);
    for (const input of [
      { address: '12 Pine Rd' }, { address: '123 Main St, Fl B' }, { address: '123 Main St, Fl 2' },
      { address: '12 Oak Ave, FL' }, { address: '12 Oak Ave, Sarasota' }, { address: '12 Oak Ave, FL 34236' },
      { address: '12 Oak Ave, Bradenton, FL' }, { zip: '34201' }, { city: 'Bradenton' }, { city: 'Bradenton', zip: '34201' },
    ]) {
      const res = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', ...input, confirmed: true });
      expect(res.error).toBe(ONE_LINE_REFUSAL);
      expect(res.preview).toBeUndefined();
    }
    expect(leads.update).not.toHaveBeenCalled();
  }
});

test('explicit city or zip fields beside a whole address must agree with it', async () => {
  db.mockReturnValue(chain({ first: TWO_SEG_LEAD }));
  const agree = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', address: '12 Pine Rd, Bradenton, FL 34201', city: 'Bradenton', zip: '34201' });
  expect(agree.changes.city).toEqual({ from: 'Sarasota', to: 'Bradenton' });
  const clash = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', address: '12 Pine Rd, Bradenton, FL 34201', city: 'Venice' });
  expect(clash.error).toMatch(/city "Venice" does not match/);
});

test('a whole address whose parsed city is over 120 characters, or whose line is over 255, refuses at preview', async () => {
  db.mockReturnValue(chain({ first: TWO_SEG_LEAD }));
  const city = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', address: `12 Oak Ave, ${'Longtown'.repeat(16)}, FL 34236` });
  expect(city.error).toMatch(/city is too long \(120 characters max\)/);
  const line = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', address: `${'1'.repeat(230)} Oak Ave, Bradenton, FL 34236` });
  expect(line.error).toMatch(/address is too long/);
});

test('bare row: a plain street is written as typed; a locality-shaped but incomplete text refuses; a whole address replaces all three', async () => {
  const leads = chain({ first: ADDR_LEAD });
  db.mockReturnValue(leads);
  // Plain streets: a unit segment, a floor token, or the lead's own city.
  for (const address of ['21 Oak Ave, Unit 4', '21 Oak Ave Unit 4', '1200 Main St 2B', '21 Oak Ave, Testville', '12 Oak Ave, testville']) {
    const res = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', address });
    expect(res.changes).toEqual({ address: { from: '21 Synthetic Oak Ave', to: address } });
  }
  // A state, or a different real city, without the rest: refused, nothing written.
  for (const address of ['12 Oak Ave, Bradenton, FL', '12 Oak Ave, FL', '123 Main St, Fl 2', '12 Oak Ave, Bradenton', '12 Oak Ave Bradenton FL']) {
    const res = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', address, confirmed: true });
    expect(res.error).toBe(ONE_LINE_REFUSAL);
  }
  expect(leads.update).not.toHaveBeenCalled();
  const whole = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', address: '12 Pine Rd, Bradenton, FL 34201' });
  expect(whole.changes).toEqual({
    address: { from: '21 Synthetic Oak Ave', to: '12 Pine Rd, Bradenton, FL 34201' },
    city: { from: 'Testville', to: 'Bradenton' },
    zip: { from: '34200', to: '34201' },
  });
  // A bare street ending in a unit is still bare: a zip edit touches only the column.
  for (const address of ['21 Oak Ave Unit 4', '1200 Main St 2B']) {
    db.mockReturnValue(chain({ first: { ...ADDR_LEAD, address } }));
    const res = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', zip: '34201' });
    expect(res.changes).toEqual({ zip: { from: '34200', to: '34201' } });
  }
});

test('confirmed whole address: one guarded UPDATE writes line, city and zip and re-asserts every old value', async () => {
  const leads = chain({ first: TWO_SEG_LEAD, update: [{ id: 'lead-1' }] });
  const activities = chain({ insert: undefined });
  db.mockImplementation((table) => (table === 'leads' ? leads : activities));
  const approved = {
    address: { from: TWO_SEG, to: '12 Pine Rd, Bradenton, FL 34201' },
    city: { from: 'Sarasota', to: 'Bradenton' },
    zip: { from: '34200', to: '34201' },
  };
  const res = await executeLeadsTool('update_lead_contact', {
    lead_id: 'lead-1', address: '12 Pine Rd, Bradenton, FL 34201', confirmed: true, _approved_changes: approved,
  });
  expect(res.success).toBe(true);
  expect(res.updated_fields).toEqual(['address', 'city', 'zip']);
  expect(leads.where).toHaveBeenCalledWith('address', TWO_SEG);
  expect(leads.where).toHaveBeenCalledWith('city', 'Sarasota');
  expect(leads.where).toHaveBeenCalledWith('zip', '34200');
  expect(leads.update).toHaveBeenCalledWith(
    expect.objectContaining({ address: '12 Pine Rd, Bradenton, FL 34201', city: 'Bradenton', zip: '34201' }), ['id'],
  );
  // The row moved after the card: the pinned diff no longer matches, nothing is written.
  jest.clearAllMocks();
  const moved = chain({ first: { ...TWO_SEG_LEAD, address: '99 Other St, Elsewhere, FL 34111', city: 'Elsewhere', zip: '34111' }, update: [{ id: 'lead-1' }] });
  db.mockImplementation((table) => (table === 'leads' ? moved : activities));
  const stale = await executeLeadsTool('update_lead_contact', {
    lead_id: 'lead-1', address: '12 Pine Rd, Bradenton, FL 34201', confirmed: true, _approved_changes: approved,
  });
  expect(stale.success).toBe(true); // the pinned "from" values ride into the WHERE; the mock returns a row
  expect(moved.where).toHaveBeenCalledWith('address', TWO_SEG);
  expect(moved.where).not.toHaveBeenCalledWith('address', '99 Other St, Elsewhere, FL 34111');
});

test('a ZIP+4 whole address replaces the line and the zip column as parsed', async () => {
  db.mockReturnValue(chain({ first: TWO_SEG_LEAD }));
  const res = await executeLeadsTool('update_lead_contact', { lead_id: 'lead-1', address: '12 Pine Rd, Bradenton, FL 34201-1234' });
  expect(res.changes).toEqual({
    address: { from: TWO_SEG, to: '12 Pine Rd, Bradenton, FL 34201-1234' },
    city: { from: 'Sarasota', to: 'Bradenton' },
    zip: { from: '34200', to: '34201-1234' },
  });
});

test('confirmed whole address: an asserted but unchanged column is guarded and written; a column moved meanwhile refuses', async () => {
  // City stays Sarasota: not in the approved diff, but asserted by the whole address.
  const leads = chain({ first: TWO_SEG_LEAD, update: [{ id: 'lead-1' }] });
  const activities = chain({ insert: undefined });
  db.mockImplementation((table) => (table === 'leads' ? leads : activities));
  const approved = { address: { from: TWO_SEG, to: '12 Pine Rd, Sarasota, FL 34201' }, zip: { from: '34200', to: '34201' } };
  const res = await executeLeadsTool('update_lead_contact', {
    lead_id: 'lead-1', address: '12 Pine Rd, Sarasota, FL 34201', confirmed: true, _approved_changes: approved, _asserted_fields: ['address', 'city', 'zip'],
  });
  expect(res.success).toBe(true);
  expect(res.updated_fields).toEqual(['address', 'zip']);
  expect(leads.where).toHaveBeenCalledWith('city', 'Sarasota');
  expect(leads.update).toHaveBeenCalledWith(expect.objectContaining({ city: 'Sarasota', zip: '34201' }), ['id']);
  // Another editor moved the city between card and confirm: the guard matches zero rows.
  jest.clearAllMocks();
  const moved = chain({ first: { ...TWO_SEG_LEAD, city: 'Venice' }, update: [] });
  db.mockImplementation((table) => (table === 'leads' ? moved : activities));
  const stale = await executeLeadsTool('update_lead_contact', {
    lead_id: 'lead-1', address: '12 Pine Rd, Sarasota, FL 34201', confirmed: true, _approved_changes: approved, _asserted_fields: ['address', 'city', 'zip'],
  });
  expect(stale.preview_changed).toBe(true);
  expect(stale.success).toBeUndefined();
  expect(activities.insert).not.toHaveBeenCalled();
});

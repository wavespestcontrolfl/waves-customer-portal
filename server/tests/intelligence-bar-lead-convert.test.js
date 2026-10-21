/**
 * IB convert_lead (owner ruling 2026-10-12): the Leads page "Convert to Customer" handler run in
 * process behind a card, dark behind GATE_IB_LEAD_CONVERT (needs GATE_IB_PLATFORM). What the card
 * shows (lead, customer, match, every change, that nothing is sent), pin drift, the duplicate-customer
 * case, gate off, admin only, and that the commit runs the page's handler once with exactly the
 * carded body. The handler itself is mocked here; admin-leads-convert-handler-replay.test.js runs the
 * real one. Nothing here reaches a provider. Synthetic names only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/admin-leads', () => ({ convertLeadFromBar: jest.fn() }));

const db = require('../models/db');
const Leads = require('../routes/admin-leads');
const tools = require('../services/intelligence-bar/lead-convert-tools');
const { executeLeadConvertTool, LEAD_CONVERT_TOOLS, cardLines } = tools;
const registry = require('../services/intelligence-bar/action-registry');
const gates = require('../services/intelligence-bar/write-gates');
const { buildContract } = require('../services/intelligence-bar/authorization-contract');

const LEAD = '00000000-0000-4000-8000-0000000000b1';
const CUST = '00000000-0000-4000-8000-0000000000c1';
const OTHER = '00000000-0000-4000-8000-0000000000c2';
const EST = '00000000-0000-4000-8000-0000000000e1';
const ADMIN = { isAdmin: true, technicianId: 'staff-1', operationId: 'op-1' };

let state;
function freshState() {
  return {
    leads: [{
      id: LEAD, first_name: 'Robin', last_name: 'Sample', phone: '+19415550142', email: 'robin@example.test',
      address: '12 Sample Way', city: 'Venice', zip: '34285', status: 'contacted', converted_at: null, customer_id: null,
      estimate_id: EST, monthly_value: null, initial_service_value: null, waveguard_tier: null,
      updated_at: new Date('2099-01-01T12:00:00.123Z'), deleted_at: null,
    }],
    customers: [
      { id: CUST, first_name: 'Robin', last_name: 'Sample', phone: '(941) 555-0142', email: 'ROBIN@example.test', address_line1: '12 Sample Way', city: 'Venice', zip: '34285', deleted_at: null },
    ],
    estimates: [{ id: EST, status: 'sent', customer_id: null }],
    ad_service_attribution: [{ lead_id: LEAD }],
    // The customers that share the lead's phone or email (the contact-match read).
    contactMatches: [{ id: CUST, first_name: 'Robin', last_name: 'Sample', phone: '(941) 555-0142', email: 'ROBIN@example.test', city: 'Venice' }],
  };
}

// A small knex stand-in: plain-object where / whereNull filter the seeded rows; the contact-match read
// (customers with a limit) answers `contactMatches` minus the excluded id. Any write throws.
function makeDb() {
  function builder(table) {
    const q = { wheres: [], nulls: [], notId: null, single: false, limited: false, count: false };
    const rows = () => {
      if (table === 'customers' && q.limited) return state.contactMatches.filter((row) => row.id !== q.notId);
      const found = (state[table] || []).filter((row) => q.wheres.every((w) => Object.entries(w).every(([k, v]) => String(row[k]) === String(v)))
        && q.nulls.every((k) => row[k] == null));
      if (q.count) return { n: String(found.length) };
      return q.single ? found[0] : found;
    };
    const b = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve().then(rows).then(res, rej);
        if (prop === 'where') return (arg) => { if (arg && typeof arg === 'object') q.wheres.push(arg); return b; };
        if (prop === 'whereNull') return (k) => { q.nulls.push(k); return b; };
        if (prop === 'whereNot') return (k, v) => { q.notId = v; return b; };
        if (prop === 'modify') return (fn) => { fn(b); return b; };
        if (prop === 'limit') return () => { q.limited = true; return b; };
        if (prop === 'first') return () => { q.single = true; return b; };
        if (prop === 'count') return () => { q.count = true; return b; };
        if (['insert', 'update', 'del', 'delete', 'upsert'].includes(prop)) throw new Error(`unexpected ${String(prop)} on ${table}`);
        return () => b;
      },
    });
    return b;
  }
  return (table) => builder(table);
}

function envGate(on) {
  if (on) { process.env.GATE_IB_LEAD_CONVERT = 'true'; process.env.GATE_IB_PLATFORM = 'true'; }
  else { delete process.env.GATE_IB_LEAD_CONVERT; delete process.env.GATE_IB_PLATFORM; }
}

const preview = (input = {}, ctx = ADMIN) => executeLeadConvertTool('convert_lead', { lead_id: LEAD, customer_id: CUST, ...input }, ctx);
const confirm = (card, input = {}, ctx = ADMIN) => executeLeadConvertTool('convert_lead',
  { lead_id: LEAD, customer_id: CUST, ...input, confirmed: true, _verified_lead_convert_version: card._version }, ctx);

beforeEach(() => {
  jest.clearAllMocks();
  state = freshState();
  db.mockImplementation(makeDb());
  envGate(true);
  Leads.convertLeadFromBar.mockResolvedValue({ status: 200, json: { lead: { id: LEAD, status: 'won', customer_id: CUST } } });
});
afterEach(() => envGate(false));

describe('registration', () => {
  test('a two-step write, admin only, in the leads domain, with a customer-scoped policy', () => {
    expect(gates.WRITE_TWO_STEP_TOOL_NAMES.has('convert_lead')).toBe(true);
    expect(gates.UI_GATED_WRITE_TOOL_NAMES.has('convert_lead')).toBe(true);
    const action = registry.actions.get('convert_lead');
    expect(action).toMatchObject({ domain: 'leads', role: 'admin', approval: 'ui_confirm', scope: 'record', module: 'lead-convert-tools.js' });
    expect(registry.policyErrors).not.toContain('convert_lead');
    expect(Object.keys(LEAD_CONVERT_TOOLS[0].input_schema.properties)).not.toContain('confirmed');
  });

  test('the discovery search finds it by the operator’s words', () => {
    for (const query of ['convert lead', 'make this lead a customer', 'turn lead into customer']) {
      const { definitions } = registry.discover({ query }, { role: 'admin', context: 'leads', fullAccess: false });
      expect(definitions.map((d) => d.name)).toContain('convert_lead');
    }
  });

  test('the Leads page offers it while the gate is on, and no page offers it with the gate off', () => {
    const on = registry.initialTools('leads', { role: 'admin', fullAccess: false }).map((t) => t.name);
    expect(on).toContain('convert_lead');
    envGate(false);
    for (const page of ['leads', 'customers', 'dashboard']) {
      expect(registry.initialTools(page, { role: 'admin', fullAccess: false }).map((t) => t.name)).not.toContain('convert_lead');
    }
    const { definitions } = registry.discover({ query: 'convert lead to customer' }, { role: 'admin', context: 'leads', fullAccess: false });
    expect(definitions.map((d) => d.name)).not.toContain('convert_lead');
  });

  test('it needs the platform gate: the convert gate alone offers nothing', () => {
    delete process.env.GATE_IB_PLATFORM;
    expect(registry.allowed(registry.actions.get('convert_lead'), { role: 'admin', context: 'leads' })).toBe(false);
  });

  test('a technician never gets it', () => {
    expect(registry.allowed(registry.actions.get('convert_lead'), { role: 'technician', context: 'tech' })).toBe(false);
  });
});

describe('gate and login', () => {
  test('gate off: the tool refuses every call and changes nothing', async () => {
    envGate(false);
    const res = await preview();
    expect(res).toMatchObject({ code: 'gate_off' });
    const confirmed = await executeLeadConvertTool('convert_lead', { lead_id: LEAD, customer_id: CUST, confirmed: true, _verified_lead_convert_version: {} }, ADMIN);
    expect(confirmed).toMatchObject({ code: 'gate_off' });
    expect(Leads.convertLeadFromBar).not.toHaveBeenCalled();
  });

  test('a non-admin is refused, and a confirmed run needs a positive admin flag', async () => {
    expect(await preview({}, { isAdmin: false })).toMatchObject({ code: 'permission_denied' });
    const card = await preview();
    expect(await confirm(card, {}, {})).toMatchObject({ code: 'permission_denied' });
    expect(await confirm(card, {}, { isAdmin: false })).toMatchObject({ code: 'permission_denied' });
    expect(Leads.convertLeadFromBar).not.toHaveBeenCalled();
  });
});

describe('the preview', () => {
  test('shows the lead, the customer, the match and every change, and writes and sends nothing', async () => {
    const card = await preview({ monthly_value: 49, initial_service_value: 129, waveguard_tier: 'Gold' });
    expect(card).toMatchObject({
      preview: true, tool: 'convert_lead', lead_id: LEAD, lead_name: 'Robin Sample', lead_status: 'contacted',
      customer_id: CUST, customer_name: 'Robin Sample', matched_on: 'phone and email', sends_to_customer: false,
    });
    expect(card.lead.phone).toBe('***0142');
    expect(card.customer.address).toBe('12 Sample Way, Venice, 34285');
    expect(card.lead.address).toBe('12 Sample Way, Venice, 34285');
    const text = card.effects.map((e) => e.text).join('\n');
    expect(text).toMatch(/status contacted → won; linked to customer Robin Sample; marked qualified/);
    expect(text).toMatch(/monthly value \$49\.00, first-service value \$129\.00, WaveGuard tier Gold/);
    expect(text).toMatch(/ad funnel row moves to booked and is linked to the customer \(1 row/);
    expect(text).toMatch(/estimate \(sent\) has no customer yet: it is attached to this customer/);
    expect(text).toMatch(/"converted" entry is added/);
    expect(text).toMatch(/Nothing is sent: no text, email or call/);
    expect(text).toMatch(/No charge, invoice, deposit or estimate acceptance/);
    expect(card.warnings).toEqual([]);
    expect(Leads.convertLeadFromBar).not.toHaveBeenCalled();
    // The card lines and the contract carry the same facts.
    const lines = cardLines('convert_lead', card).map((l) => l.text).join('\n');
    expect(lines).toMatch(/Convert lead Robin Sample \(contacted\) → customer Robin Sample/);
    const contract = buildContract({ toolName: 'convert_lead', params: { lead_id: LEAD, customer_id: CUST }, displayParams: {}, preview: card, summary: 'x' });
    const labels = JSON.stringify(contract.effects || contract);
    expect(labels).toMatch(/Nothing is sent/);
    expect(JSON.stringify(contract)).not.toMatch(/Customer will be contacted/);
  });

  test('with no customer_id it returns the matching customers and writes nothing', async () => {
    const res = await executeLeadConvertTool('convert_lead', { lead_id: LEAD }, ADMIN);
    expect(res).toMatchObject({ code: 'customer_required', lead_id: LEAD });
    expect(res.preview).toBeUndefined();
    expect(res.candidates).toEqual([{ customer_id: CUST, name: 'Robin Sample', city: 'Venice', matched_on: ['phone', 'email'] }]);
    state.contactMatches = [];
    const none = await executeLeadConvertTool('convert_lead', { lead_id: LEAD }, ADMIN);
    expect(none.error).toMatch(/create the customer first/);
    expect(none.candidates).toEqual([]);
  });

  test('duplicate customers: another account on the same phone is named, and a mismatch is flagged', async () => {
    state.contactMatches = [
      { id: CUST, first_name: 'Robin', last_name: 'Sample', phone: '(941) 555-0142', email: 'ROBIN@example.test', city: 'Venice' },
      { id: OTHER, first_name: 'Robyn', last_name: 'Sample', phone: '941-555-0142', email: 'other@example.test', city: 'Nokomis' },
    ];
    const card = await preview();
    expect(card.other_matching_customers).toEqual([{ customer_id: OTHER, name: 'Robyn Sample', city: 'Nokomis', matched_on: 'phone' }]);
    expect(card.warnings.join(' ')).toMatch(/Another customer shares the lead’s phone or email: Robyn Sample \(Nokomis\) on phone/);
    // A customer whose phone and email differ from the lead's.
    state.customers[0] = { ...state.customers[0], phone: '(941) 555-0999', email: 'else@example.test' };
    const mismatch = await preview();
    expect(mismatch.matched_on).toBe('none');
    expect(mismatch.warnings.join(' ')).toMatch(/do not match the lead’s/);
  });

  test('refuses a lead already converted, a missing lead, a missing customer and a bad value', async () => {
    state.leads[0].converted_at = new Date('2099-01-02T00:00:00Z');
    expect(await preview()).toMatchObject({ code: 'already_converted' });
    state.leads[0].converted_at = null;
    state.leads[0].status = 'won';
    expect(await preview()).toMatchObject({ code: 'already_converted' });
    state.leads[0].status = 'contacted';
    expect(await executeLeadConvertTool('convert_lead', { lead_id: '00000000-0000-4000-8000-0000000000ff', customer_id: CUST }, ADMIN)).toMatchObject({ code: 'lead_not_found' });
    expect(await preview({ customer_id: '00000000-0000-4000-8000-0000000000fe' })).toMatchObject({ code: 'customer_not_found' });
    expect(await preview({ monthly_value: -5 })).toMatchObject({ code: 'invalid_value' });
    expect(await preview({ initial_service_value: 2e6 })).toMatchObject({ code: 'invalid_value' });
    expect(await executeLeadConvertTool('convert_lead', { lead_id: 'nope', customer_id: CUST }, ADMIN)).toMatchObject({ code: 'invalid_target' });
  });

  test('a lead marked lost is flagged as reopened, and an estimate on another customer stays', async () => {
    state.leads[0].status = 'lost';
    state.estimates[0].customer_id = OTHER;
    const card = await preview();
    expect(card.warnings.join(' ')).toMatch(/marked lost; converting reopens it as won/);
    expect(card.effects.map((e) => e.text).join('\n')).toMatch(/belongs to a different customer: it stays there/);
  });
});

describe('the confirmed run', () => {
  test('runs the page’s handler once with exactly the carded body', async () => {
    const card = await preview({ monthly_value: 49, waveguard_tier: 'Gold' });
    const res = await confirm(card, { monthly_value: 49, waveguard_tier: 'Gold' });
    expect(Leads.convertLeadFromBar).toHaveBeenCalledTimes(1);
    expect(Leads.convertLeadFromBar).toHaveBeenCalledWith({
      leadId: LEAD,
      body: { customer_id: CUST, monthly_value: 49, waveguard_tier: 'Gold', seen_status: 'contacted', seen_updated_at: '2099-01-01T12:00:00.123Z' },
      // The lead version the card showed: the handler's own UPDATE must still match it.
      expected: { status: 'contacted', updatedAt: new Date('2099-01-01T12:00:00.123Z').getTime(), customerId: null },
    });
    expect(res).toMatchObject({ success: true, status: 'won', sent_to_customer: false, lead_id: LEAD, customer_id: CUST });
    expect(res.note).toMatch(/Nothing was sent to anyone/);
  });

  test('a call with no figures sends none in the body (the lead’s own figures stay)', async () => {
    const card = await preview();
    await confirm(card);
    expect(Leads.convertLeadFromBar.mock.calls[0][0].body).toEqual({ customer_id: CUST, seen_status: 'contacted', seen_updated_at: '2099-01-01T12:00:00.123Z' });
  });

  test('no pin: use the card; the handler is not run', async () => {
    const res = await executeLeadConvertTool('convert_lead', { lead_id: LEAD, customer_id: CUST, confirmed: true }, ADMIN);
    expect(res).toMatchObject({ code: 'approval_required' });
    expect(Leads.convertLeadFromBar).not.toHaveBeenCalled();
  });

  test.each([
    ['the lead was edited after the card', (s) => { s.leads[0].updated_at = new Date('2099-01-01T12:05:00Z'); }],
    ['the lead’s status moved', (s) => { s.leads[0].status = 'estimate_sent'; }],
    ['the lead’s phone changed', (s) => { s.leads[0].phone = '+19415550999'; }],
    ['the customer’s email changed', (s) => { s.customers[0].email = 'new@example.test'; }],
    ['the customer’s address changed', (s) => { s.customers[0].address_line1 = '99 Other Way'; }],
    ['another customer now shares the contact', (s) => { s.contactMatches.push({ id: OTHER, first_name: 'Robyn', last_name: 'Sample', phone: '941-555-0142', email: 'x@example.test', city: 'Venice' }); }],
    ['the estimate was attached elsewhere', (s) => { s.estimates[0].customer_id = OTHER; }],
    ['the funnel row went away', (s) => { s.ad_service_attribution = []; }],
    ['the lead was converted by someone else', (s) => { s.leads[0].converted_at = new Date(); s.leads[0].status = 'won'; }],
    ['the lead was deleted', (s) => { s.leads[0].deleted_at = new Date(); }],
  ])('drift (%s) refuses with preview_changed and runs nothing', async (_name, mutate) => {
    const card = await preview({ monthly_value: 49 });
    mutate(state);
    const res = await confirm(card, { monthly_value: 49 });
    expect(res).toMatchObject({ preview_changed: true });
    expect(Leads.convertLeadFromBar).not.toHaveBeenCalled();
  });

  test('a different figure at Confirm than on the card is drift', async () => {
    const card = await preview({ monthly_value: 49 });
    const res = await confirm(card, { monthly_value: 59 });
    expect(res).toMatchObject({ preview_changed: true });
    expect(Leads.convertLeadFromBar).not.toHaveBeenCalled();
  });

  test('the page’s own refusals come back in its words: 409 and 404 are preview_changed, others a plain refusal', async () => {
    const card = await preview();
    Leads.convertLeadFromBar.mockResolvedValueOnce({ status: 409, json: { error: 'This lead changed since the page loaded (it may have closed on its own when the customer booked online). Reload to see it.' } });
    expect(await confirm(card)).toMatchObject({ failed: true, code: 'lead_changed', preview_changed: true, error: expect.stringMatching(/changed since the page loaded/) });
    Leads.convertLeadFromBar.mockResolvedValueOnce({ status: 404, json: { error: 'Customer not found' } });
    expect(await confirm(card)).toMatchObject({ failed: true, code: 'not_found', preview_changed: true });
    Leads.convertLeadFromBar.mockResolvedValueOnce({ status: 400, json: { error: 'customer_id is required to convert a lead' } });
    const refused = await confirm(card);
    expect(refused).toMatchObject({ failed: true, code: 'convert_refused' });
    expect(refused.preview_changed).toBeUndefined();
  });

  test('a handler that throws, or answers a lead that does not read as converted, never invites a blind retry', async () => {
    const card = await preview();
    Leads.convertLeadFromBar.mockRejectedValueOnce(new Error('connection reset'));
    expect(await confirm(card)).toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
    Leads.convertLeadFromBar.mockResolvedValueOnce({ status: 200, json: { lead: { id: LEAD, status: 'contacted', customer_id: null } } });
    expect(await confirm(card)).toMatchObject({ outcome_unknown: true, code: 'convert_unverified' });
  });

  test('nothing in the tool reaches a message sender', () => {
    const source = require('fs').readFileSync(require.resolve('../services/intelligence-bar/lead-convert-tools.js'), 'utf8');
    expect(source).not.toMatch(/twilio|sendgrid|sendSms|sendEmail|stripe|notifyAdmin|messaging/i);
  });
});

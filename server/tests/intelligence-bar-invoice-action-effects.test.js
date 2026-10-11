/**
 * The Intelligence Bar's one effects plan for send_invoice
 * (invoice-action-effects.js): every post-commit effect, from the handlers' own
 * predicates, with the card wording, one pinned digest, and a source contract that
 * fails when a handler gains a side-effect call the plan does not name.
 * Sources are mocked; synthetic ids only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/invoice-issued-closeout', () => ({ issuedCloseoutTarget: jest.fn(async () => null) }));
jest.mock('../services/lead-estimate-link', () => ({ invoiceSentConversionTargets: jest.fn(async () => ({ leadIds: [] })) }));
jest.mock('../services/invoice-followups', () => ({
  planFollowupSequence: jest.fn(async () => ({ arms: true, state: 'active', cadence: [3, 7, 14, 30] })),
}));

const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const { issuedCloseoutTarget } = require('../services/invoice-issued-closeout');
const LeadLink = require('../services/lead-estimate-link');
const Followups = require('../services/invoice-followups');
const effects = require('../services/intelligence-bar/invoice-action-effects');

const LEAD = '11111111-2222-4333-8444-555555555555';
const invoice = (overrides = {}) => ({
  id: 'inv-1', customer_id: 'cust-1', status: 'draft', sent_at: null, sms_sent_at: null, payer_id: null,
  service_record_id: null, visit_completion_packet_id: null, annual_prepay_term_id: null, ...overrides,
});
const customer = { id: 'cust-1', phone: '9415550100' };
const byKey = (plan, key) => plan.effects.find((e) => e.key === key);
// The attachment rows the stubbed table answers with; every other read answers no row.
let attachments = [];
const dbStub = (table) => ({
  where: () => ({
    first: async () => null,
    orderBy: () => ({ orderBy: () => ({ select: async () => (table === 'invoice_attachments' ? attachments : []) }) }),
  }),
});

beforeEach(() => {
  jest.clearAllMocks();
  attachments = [];
  db.mockImplementation(dbStub);
  issuedCloseoutTarget.mockResolvedValue(null);
  LeadLink.invoiceSentConversionTargets.mockResolvedValue({ leadIds: [] });
  Followups.planFollowupSequence.mockResolvedValue({ arms: true, state: 'active', cadence: [3, 7, 14, 30] });
});

describe('planSendEffects', () => {
  test('a first send lists delivery, closeout, lead, reminders, review and credit, each from the handler\'s own predicate', async () => {
    issuedCloseoutTarget.mockResolvedValue({ visitId: 'visit-1', serviceType: 'Pest', date: '2099-01-02', resuming: false });
    LeadLink.invoiceSentConversionTargets.mockResolvedValue({ leadIds: [LEAD] });
    const plan = await effects.planSendEffects(invoice(), customer, {});
    expect(plan.effects.map((e) => e.key)).toEqual(['delivery', 'attachments', 'closeout', 'lead_conversion', 'followups', 'review', 'credit']);
    expect(byKey(plan, 'delivery')).toMatchObject({ state: 'first', line: 'Not sent before.' });
    expect(issuedCloseoutTarget).toHaveBeenCalledWith(expect.objectContaining({ id: 'inv-1' }), { trigger: 'sent', conn: expect.anything() });
    expect(byKey(plan, 'closeout').line).toMatch(/^Sending this invoice also completes the linked visit/);
    // The lead is named by a masked id (first 8 characters), and the resolver is the lead module's own.
    expect(LeadLink.invoiceSentConversionTargets).toHaveBeenCalledWith('cust-1', expect.anything());
    expect(byKey(plan, 'lead_conversion')).toMatchObject({ applies: true, line: 'Sending this invoice also marks lead 11111111 won' });
    expect(JSON.stringify(plan.effects.map((e) => e.line))).not.toContain(LEAD);
    // The reminders follow the invoice as it will stand after the delivery ('sent'), with the cadence and the suppression state.
    expect(Followups.planFollowupSequence).toHaveBeenCalledWith(expect.objectContaining({ id: 'inv-1', status: 'sent' }), expect.anything(), customer);
    expect(byKey(plan, 'followups').line).toBe('Sending this invoice also arms billing reminders on Day 3, 7, 14, 30 unless Auto Pay or a payment plan suppresses them (currently: reminders will run)');
    // The bar takes no review decision, so the handler's own rule says no review request.
    expect(byKey(plan, 'review')).toMatchObject({ applies: false, line: 'No review request is sent.' });
    expect(byKey(plan, 'credit')).toMatchObject({ applies: false, state: 'skipped' });
  });

  test('a resend converts no lead and says it sends again; Auto Pay and a payment plan show as the reminder state', async () => {
    const plan = await effects.planSendEffects(invoice({ status: 'sent', sent_at: new Date('2098-12-01T15:00:00Z') }), customer, {});
    expect(byKey(plan, 'delivery')).toMatchObject({ state: 'resend' });
    expect(byKey(plan, 'delivery').line).toMatch(/^Already sent on 2098-12-01/);
    expect(LeadLink.invoiceSentConversionTargets).not.toHaveBeenCalled();
    expect(byKey(plan, 'lead_conversion')).toMatchObject({ applies: false, line: null });
    for (const [state, text] of [['autopay_hold', 'held: the customer is on Auto Pay'], ['payment_plan', 'none: the invoice has an active payment plan'], ['existing:stopped', 'the invoice already has a reminder sequence (stopped); it is left as it is']]) {
      Followups.planFollowupSequence.mockResolvedValue({ arms: state === 'autopay_hold', state, cadence: [3, 7, 14, 30] });
      expect(byKey(await effects.planSendEffects(invoice(), customer, {}), 'followups').line).toContain(`(currently: ${text})`);
    }
  });

  test('a review decision of true would say it enrolls the customer in review outreach', async () => {
    const plan = await effects.planSendEffects(invoice(), customer, { requestReview: true });
    expect(byKey(plan, 'review')).toMatchObject({ applies: true, line: 'Sending this invoice also enrolls the customer in review outreach' });
  });

  test('the digest changes when any effect\'s fact changes, and not otherwise', async () => {
    const base = await effects.planSendEffects(invoice(), customer, {});
    expect((await effects.planSendEffects(invoice(), customer, {})).digest).toBe(base.digest);
    LeadLink.invoiceSentConversionTargets.mockResolvedValue({ leadIds: [LEAD] });
    const withLead = await effects.planSendEffects(invoice(), customer, {});
    expect(withLead.digest).not.toBe(base.digest);
    LeadLink.invoiceSentConversionTargets.mockResolvedValue({ leadIds: [] });
    Followups.planFollowupSequence.mockResolvedValue({ arms: true, state: 'autopay_hold', cadence: [3, 7, 14, 30] });
    expect((await effects.planSendEffects(invoice(), customer, {})).digest).not.toBe(base.digest);
    Followups.planFollowupSequence.mockResolvedValue({ arms: true, state: 'active', cadence: [3, 10, 17, 30, 60, 90] });
    // The reminders' step days are pinned (GATE_DUNNING_LADDER_90 changes them), not only worded on the card.
    const ladder = await effects.planSendEffects(invoice(), customer, {});
    expect(ladder.digest).not.toBe(base.digest);
    expect(ladder.effects.find((e) => e.key === 'followups').facts).toEqual({ cadence: [3, 10, 17, 30, 60, 90] });
  });

  test('the digest covers every field of an effect except its wording', () => {
    const one = { key: 'x', applies: true, state: 's', line: 'words', kind: 'comms', facts: { a: 1 } };
    const digest = (e) => effects.effectsDigest([e]);
    expect(digest({ ...one, line: 'other words' })).toBe(digest(one));
    for (const change of [{ key: 'y' }, { applies: false }, { state: 't' }, { kind: 'operational' }, { facts: { a: 2 } }, { later_field: 1 }]) {
      expect(digest({ ...one, ...change })).not.toBe(digest(one));
    }
  });

  test('a source that cannot be read throws, so the card refuses instead of showing the effect as absent', async () => {
    issuedCloseoutTarget.mockRejectedValue(new Error('read failed'));
    await expect(effects.planSendEffects(invoice(), customer, {})).rejects.toThrow('read failed');
  });

  // Round 5 item 1 (the plan half).
  test('the send plan lists the invoice attachments by name and pins their id, name, size and edit time', async () => {
    let plan = await effects.planSendEffects(invoice(), customer, {});
    expect(byKey(plan, 'attachments')).toMatchObject({ applies: false, state: 'none', line: 'No attachments.' });
    const base = plan.digest;
    attachments = [
      { id: 'att-1', file_name: 'before.pdf', file_size_bytes: 1200, updated_at: '2099-01-01T10:00:00Z' },
      { id: 'att-2', file_name: 'after.pdf', file_size_bytes: 3400, updated_at: '2099-01-01T10:00:00Z' },
    ];
    plan = await effects.planSendEffects(invoice(), customer, {});
    expect(byKey(plan, 'attachments').line).toBe('Attachments the customer can open from the online invoice: before.pdf, after.pdf');
    const two = plan.digest;
    expect(two).not.toBe(base);
    // A swapped file (same name, new id), a resized file and a re-saved file each change the pin.
    for (const change of [{ id: 'att-9' }, { file_size_bytes: 9999 }, { updated_at: '2099-01-02T10:00:00Z' }]) {
      attachments = [{ ...attachments[0], ...change }, attachments[1]];
      expect((await effects.planSendEffects(invoice(), customer, {})).digest).not.toBe(two);
      attachments = [
        { id: 'att-1', file_name: 'before.pdf', file_size_bytes: 1200, updated_at: '2099-01-01T10:00:00Z' },
        { id: 'att-2', file_name: 'after.pdf', file_size_bytes: 3400, updated_at: '2099-01-01T10:00:00Z' },
      ];
    }
    expect((await effects.planSendEffects(invoice(), customer, {})).digest).toBe(two);
  });


  test('the approved closeout target is the planned visit id, or none', async () => {
    issuedCloseoutTarget.mockResolvedValue({ visitId: 'visit-1', serviceType: 'Pest', date: '2099-01-02', resuming: true });
    expect(effects.approvedCloseoutTarget((await effects.planSendEffects(invoice(), customer, {})).effects)).toBe('visit-1');
    issuedCloseoutTarget.mockResolvedValue(null);
    expect(effects.approvedCloseoutTarget((await effects.planSendEffects(invoice(), customer, {})).effects)).toBe('none');
  });

  test('round 8: the approved lead targets are an opaque digest of the planned lead set (order-free, no ids), or none', async () => {
    const { leadSetDigest } = require('../services/invoice-helpers');
    const OTHER = '99999999-2222-4333-8444-555555555555';
    LeadLink.invoiceSentConversionTargets.mockResolvedValue({ leadIds: [LEAD, OTHER] });
    const planned = (await effects.planSendEffects(invoice(), customer, {})).effects;
    const pinned = effects.approvedLeadTargets(planned);
    expect(pinned).toBe(leadSetDigest([OTHER, LEAD]));
    expect(pinned).not.toContain(LEAD);
    // A different set pins differently.
    LeadLink.invoiceSentConversionTargets.mockResolvedValue({ leadIds: [LEAD] });
    expect(effects.approvedLeadTargets((await effects.planSendEffects(invoice(), customer, {})).effects)).not.toBe(pinned);
    // No lead, or a resend (no conversion): none.
    LeadLink.invoiceSentConversionTargets.mockResolvedValue({ leadIds: [] });
    expect(effects.approvedLeadTargets((await effects.planSendEffects(invoice(), customer, {})).effects)).toBe('none');
    LeadLink.invoiceSentConversionTargets.mockResolvedValue({ leadIds: [LEAD] });
    expect(effects.approvedLeadTargets((await effects.planSendEffects(invoice({ sent_at: '2099-01-01T00:00:00Z' }), customer, {})).effects)).toBe('none');
  });
});

// ── source contract: the handlers' side-effect calls are all named in the plan ──

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
// Code only: line and block comments out, so a name in prose is not a call.
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
// Names of the calls that can change something outside the handler: send / schedule / enroll / close / stop /
// sync / complete / enqueue / notify / reset / mirror / record / convert / apply / reverse / requeue / resolve / post.
const SIDE_EFFECT_CALL = /\b((?:convert|schedule|closeOut|enroll|stop|sync|complete|enqueue|notify|reset|mirror|record|autoApply|reverse|requeue|resolve|post|void|restore|release)[A-Za-z]*)\(/g;
const callsIn = (text) => [...new Set([...code(text).matchAll(SIDE_EFFECT_CALL)].map((m) => m[1]))].sort();
const invoiceSource = read('../services/invoice.js');
const slice = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));

describe('source contract', () => {
  test('every side-effect call in the Send handler\'s post-delivery block is named by the send plan (an effect, or the reason it cannot apply)', () => {
    const block = slice(invoiceSource, 'ownedDeliveryFinalized = finalized !== 0;', 'const holdLegs = [sms, email].filter(');
    const calls = callsIn(block);
    expect(calls.length).toBeGreaterThan(4);
    const unnamed = calls.filter((name) => !(name in effects.SEND_CALL_COVERAGE));
    expect(unnamed).toEqual([]);
  });

  test('round 9: the planners read through the handle they are given, never the root pool (DB_POOL_MAX=2 deadlocks a pool query inside a held transaction)', () => {
    const text = code(read('../services/intelligence-bar/invoice-action-effects.js'));
    const bodies = [slice(text, 'async function closeoutEffect(', 'async function planSendEffects('), text.slice(text.indexOf('async function planSendEffects('))];
    for (const body of bodies) {
      // The only mention of the root handle is a default parameter.
      const afterSignature = body.slice(body.indexOf('{\n') + 2);
      expect(afterSignature).not.toMatch(/\bdb\b/);
    }
    expect(text).toMatch(/issuedCloseoutTarget\(invoice, \{ trigger, conn: database \}\)/);
    expect(text).toMatch(/closeoutEffect\([^)]*database\)/);
    // The claim's verifyEffects hands the planner the claim's own handle.
    expect(code(read('../services/intelligence-bar/invoice-action-tools.js'))).toMatch(/planSendEffects\(claimed, [^\n]*\{ database, requestReview: false \}\)/);
  });

  test('the coverage tables point at real effects, and each non-applying call states why', () => {
    const sendKeys = new Set(['delivery', 'attachments', 'closeout', 'lead_conversion', 'followups', 'review', 'credit']);
    for (const [name, entry] of Object.entries(effects.SEND_CALL_COVERAGE)) {
      if (entry.effect) expect([name, sendKeys.has(entry.effect)]).toEqual([name, true]);
      else expect([name, String(entry.why || '').length > 10]).toEqual([name, true]);
    }
  });

  test('the handlers call the shared predicates the plan uses (a copy would drift)', () => {
    expect(code(invoiceSource)).toMatch(/leadConversionApplies\(\{ customerId, priorStatus, priorDelivered \}\)/);
    expect(code(invoiceSource)).toMatch(/priorDelivered: priorDeliveredForLeadConversion\(claim\.invoice\)/);
    const followups = code(read('../services/invoice-followups.js'));
    expect(followups).toMatch(/if \(followupArmBlock\(preview\)\) return null;/);
    expect(followups).toMatch(/if \(followupArmBlock\(invoice\)\) return null;/);
    expect(code(read('../services/lead-estimate-link.js'))).toMatch(/const resolved = await resolveConversionLeads\(database, \{/);
  });
});

/**
 * Codex round-19 P1 (PR #5331): with several open invoices the Zelle fact / recheck is about the invoice the
 * customer's message NAMES (number, then a unique amount) — not always the newest — and a reference that
 * can't be tied to exactly one abstains. The resolved id is what the decision persists (zelleInvoiceId).
 */
const { resolveZelleTargetInvoice } = require('../services/zelle-target-invoice');

const inv = (id, invoiceNumber, amountDue) => ({ id, invoiceNumber, amountDue, status: 'sent' });
const NEWEST = inv('inv-3', 'WPC-2026-0303', 95);
const MIDDLE = inv('inv-2', 'WPC-2026-0202', 120);
const OLDEST = inv('inv-1', 'WPC-2026-0101', 120.5);
const billing = (open) => ({ openInvoices: open, openInvoice: open[0] || null });

describe('resolveZelleTargetInvoice', () => {
  test('0 or 1 open invoice: unchanged (none / that one), whatever the message says', () => {
    expect(resolveZelleTargetInvoice(billing([]), 'can I zelle?')).toEqual({ invoiceId: null, reason: 'no_open_invoice' });
    expect(resolveZelleTargetInvoice(billing([NEWEST]), 'can I zelle?').invoiceId).toBe('inv-3');
    expect(resolveZelleTargetInvoice({ openInvoice: { id: 'legacy' } }, 'x').invoiceId).toBe('legacy'); // context without the list
    expect(resolveZelleTargetInvoice({}, 'x').invoiceId).toBeNull();
  });
  test('several open: the invoice NUMBER the customer names wins (full form, lowercase, or "invoice 0101")', () => {
    const open = [NEWEST, MIDDLE, OLDEST];
    expect(resolveZelleTargetInvoice(billing(open), 'Can I Zelle invoice WPC-2026-0101?')).toEqual({ invoiceId: 'inv-1', reason: 'invoice_number' });
    expect(resolveZelleTargetInvoice(billing(open), 'paying wpc-2026-0202 by zelle').invoiceId).toBe('inv-2');
    expect(resolveZelleTargetInvoice(billing(open), 'zelle for invoice #0101?').invoiceId).toBe('inv-1');
    expect(resolveZelleTargetInvoice(billing(open), 'invoice 202 by zelle').invoiceId).toBe('inv-2');
  });
  test('several open: a UNIQUE amount picks the invoice; a shared amount is ambiguous', () => {
    expect(resolveZelleTargetInvoice(billing([NEWEST, MIDDLE, OLDEST]), 'Can I Zelle the $120.50?').invoiceId).toBe('inv-1');
    expect(resolveZelleTargetInvoice(billing([NEWEST, MIDDLE, OLDEST]), 'zelle the $95 one').invoiceId).toBe('inv-3');
    const twins = [inv('a', 'WPC-2026-0001', 120), inv('b', 'WPC-2026-0002', 120)];
    expect(resolveZelleTargetInvoice(billing(twins), 'can I Zelle the $120?')).toEqual({ invoiceId: null, reason: 'ambiguous_amount' });
  });
  test('several open + no reference (or a reference to none of them) ABSTAINS — never defaults to the newest', () => {
    expect(resolveZelleTargetInvoice(billing([NEWEST, MIDDLE]), 'Can I pay with Zelle?')).toEqual({ invoiceId: null, reason: 'multiple_open_unreferenced' });
    expect(resolveZelleTargetInvoice(billing([NEWEST, MIDDLE]), 'Can I Zelle $500?').invoiceId).toBeNull();
    expect(resolveZelleTargetInvoice(billing([NEWEST, MIDDLE]), 'Can I Zelle invoice WPC-2026-0999?').invoiceId).toBeNull();
  });
  test('a number outranks a BARE amount that would point elsewhere (an invoice-tied conflicting amount abstains, below)', () => {
    expect(resolveZelleTargetInvoice(billing([NEWEST, MIDDLE]), 'Zelle invoice WPC-2026-0202. I sent $95 last month').invoiceId).toBe('inv-2');
  });
});

describe('the drafter persists the RESOLVED invoice id (and abstains when it cannot tell)', () => {
  const GATE = 'GATE_SMS_REAL_ANSWERS';
  afterEach(() => {
    delete process.env[GATE]; delete process.env.ZELLE_RECIPIENT; delete process.env.SHADOW_DRAFT_VERIFY; delete process.env.SHADOW_FEWSHOT;
    for (const m of ['../models/db', '../services/logger', '../services/availability', '../services/context-aggregator', '../services/voice-profile-distiller',
      '../services/call-booking-catalog', '../services/llm/call', '@anthropic-ai/sdk', '../services/sms-auto-send', '../services/sms-suggest-mode',
      '../services/comms-lint', '../routes/pay-v2', '../services/estimate-deposits']) jest.dontMock(m);
    jest.resetModules();
  });

  async function draft({ inboundMessage, open, visible = true }) {
    jest.resetModules();
    process.env[GATE] = 'true';
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    process.env.SHADOW_DRAFT_VERIFY = 'false';
    process.env.SHADOW_FEWSHOT = 'false';
    const checked = [];
    const mockDb = jest.fn((table) => {
      if (table === 'message_drafts') return { insert: jest.fn(() => ({ returning: jest.fn(async () => [{ id: 'draft-1' }]) })) };
      if (table === 'invoices') return { where: jest.fn((w) => ({ first: jest.fn(async () => { checked.push(w.id); return { id: w.id, customer_id: 'customer-1', status: 'sent' }; }) })) };
      throw new Error(`unexpected table: ${table}`);
    });
    jest.doMock('../models/db', () => mockDb);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/availability', () => ({ getAvailableSlots: jest.fn(async () => ({ zone: 'z', days: [] })) }));
    jest.doMock('../services/context-aggregator', () => ({
      getContextForCustomer: jest.fn(async () => ({
        summary: 'QA', flags: [], smsHistory: [], customer: { id: 'customer-1', billingLane: null },
        billing: { outstandingBalance: 0, recentPayments: [], openInvoice: open[0], openInvoices: open },
      })),
      authorizedDuesCents: jest.fn(() => []),
    }));
    jest.doMock('../routes/pay-v2', () => ({ payPageZelleVisibility: jest.fn(async () => ({ visible, reason: null })) }));
    jest.doMock('../services/estimate-deposits', () => ({ assertInvoiceDepositSettlementReady: jest.fn(async () => {}) }));
    jest.doMock('../services/voice-profile-distiller', () => ({ getApprovedVoiceProfile: jest.fn(async () => null) }));
    jest.doMock('../services/call-booking-catalog', () => ({ loadBookableCallServices: async () => [] }));
    jest.doMock('../services/llm/call', () => ({
      dispatchWithFallback: jest.fn(async (policy, payload) => (payload?.laneId === 'sms_service_identity'
        ? { ok: true, json: { about: 'none', visit: null, service: null } }
        : { ok: true, text: JSON.stringify({ reply: 'Sure — check your pay link.', intended_actions: [], missing_info: null }), model: 'fixture-model' })),
    }));
    jest.doMock('@anthropic-ai/sdk', () => jest.fn(() => ({ messages: { create: jest.fn() } })));
    jest.doMock('../services/sms-auto-send', () => ({ autoSendActionsSafe: jest.fn(() => true), maybeAutoSend: jest.fn() }));
    jest.doMock('../services/sms-suggest-mode', () => ({
      AUTO_SEND_MODE: 'auto_send', SUGGESTED_STATUS: 'suggested', resolveDeliveryMode: jest.fn(async () => 'auto_send'),
      publishSuggestion: jest.fn(async () => null), supersedeStaleSuggestions: jest.fn(async () => 0),
      hasRedactionPlaceholder: jest.fn(() => false), hasPriceQuote: jest.fn(() => false),
    }));
    jest.doMock('../services/comms-lint', () => ({ lintComms: jest.fn(() => ({ pass: true, failures: [] })), toFlags: jest.fn(() => []) }));
    const { generateGroundedDraft } = require('../services/sms-shadow-drafter');
    const context = await require('../services/context-aggregator').getContextForCustomer({ id: 'customer-1' });
    const result = await generateGroundedDraft({
      client: { messages: { create: jest.fn() } }, context, inboundMessage,
      intent: { intent: 'general_customer_sms_needs_review', confidence: 0.9 }, schedulingIntent: false, city: 'Venice',
    });
    const maybeAutoSendResult = result;
    return { zelleInvoiceId: maybeAutoSendResult.zelleInvoiceId, factsBlock: maybeAutoSendResult.factsBlock, checked };
  }
  const open = [
    { id: 'inv-3', invoiceNumber: 'WPC-2026-0303', status: 'sent', amountDue: 95 },
    { id: 'inv-1', invoiceNumber: 'WPC-2026-0101', status: 'overdue', amountDue: 210 },
  ];

  test('the customer names the OLDER invoice: eligibility is checked on it and ITS id is persisted', async () => {
    const { zelleInvoiceId, checked } = await draft({ inboundMessage: 'Can I pay invoice WPC-2026-0101 by Zelle?', open });
    expect(checked).toEqual(['inv-1']);
    expect(zelleInvoiceId).toBe('inv-1');
  });
  test('a unique amount also resolves it', async () => {
    const { zelleInvoiceId, checked } = await draft({ inboundMessage: 'Can I Zelle the $210?', open });
    expect(checked).toEqual(['inv-1']);
    expect(zelleInvoiceId).toBe('inv-1');
  });
  test('no reference with several open: NO Zelle fact, no invoice checked, nothing persisted', async () => {
    const { zelleInvoiceId, checked, factsBlock } = await draft({ inboundMessage: 'Can I pay by Zelle?', open });
    expect(checked).toEqual([]);
    expect(zelleInvoiceId).toBe(null);
    expect(factsBlock).toContain('Zelle is not available for this account right now, so do not offer it');
    expect(factsBlock).not.toContain('or Zelle to pay@example.com');
  });
  test('one open invoice: unchanged (that invoice)', async () => {
    const { zelleInvoiceId, checked } = await draft({ inboundMessage: 'Can I pay by Zelle?', open: [open[0]] });
    expect(checked).toEqual(['inv-3']);
    expect(zelleInvoiceId).toBe('inv-3');
  });
  test('the named invoice fails the pay page\'s Zelle check: not persisted either', async () => {
    const { zelleInvoiceId, factsBlock } = await draft({ inboundMessage: 'Can I pay invoice WPC-2026-0101 by Zelle?', open, visible: false });
    expect(zelleInvoiceId).toBe(null);
  });
});

// Codex round-20 P1: explicit references are parsed FIRST — the single-open fast path does not swallow them.
describe('resolveZelleTargetInvoice with ONE open invoice', () => {
  const only = billing([MIDDLE]); // WPC-2026-0202, $120
  test('no explicit reference (or one that AGREES): that invoice, as before', () => {
    expect(resolveZelleTargetInvoice(only, 'Can I pay by Zelle?').invoiceId).toBe('inv-2');
    expect(resolveZelleTargetInvoice(only, 'Can I Zelle invoice WPC-2026-0202?').invoiceId).toBe('inv-2');
    expect(resolveZelleTargetInvoice(only, 'Zelle for invoice 202?').invoiceId).toBe('inv-2');
    expect(resolveZelleTargetInvoice(only, 'Can I Zelle the $120 invoice?').invoiceId).toBe('inv-2');
    expect(resolveZelleTargetInvoice(only, 'I paid $50 last time — can I Zelle this time?').invoiceId).toBe('inv-2'); // a bare unrelated amount
  });
  test('a DIFFERENT (or settled) invoice number => abstain', () => {
    expect(resolveZelleTargetInvoice(only, 'Can I Zelle invoice WPC-2026-0101?')).toEqual({ invoiceId: null, reason: 'named_invoice_not_open' });
    expect(resolveZelleTargetInvoice(only, 'zelle for invoice #0999').invoiceId).toBeNull();
    expect(resolveZelleTargetInvoice(only, 'Zelle wpc-2026-0101 please').invoiceId).toBeNull();
  });
  test('a DIFFERENT invoice amount => abstain', () => {
    expect(resolveZelleTargetInvoice(only, 'Can I Zelle the $95 invoice?')).toEqual({ invoiceId: null, reason: 'named_amount_differs' });
    expect(resolveZelleTargetInvoice(only, 'Zelle for the invoice of $210?').invoiceId).toBeNull();
  });
  test('several open: a named number matching NONE abstains even when an amount would pick one', () => {
    expect(resolveZelleTargetInvoice(billing([NEWEST, MIDDLE]), 'Zelle invoice WPC-2026-0999 — the $95 one')).toEqual({ invoiceId: null, reason: 'named_invoice_not_open' });
  });
  test('a number that matches but an invoice-tied amount that contradicts it => abstain', () => {
    expect(resolveZelleTargetInvoice(billing([NEWEST, MIDDLE]), 'Zelle invoice WPC-2026-0202, the $95 invoice')).toEqual({ invoiceId: null, reason: 'reference_conflict' });
  });
});

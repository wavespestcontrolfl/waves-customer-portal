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
    const payPageZelleVisibility = jest.fn(async () => ({ visible, reason: null }));
    jest.doMock('../routes/pay-v2', () => ({ payPageZelleVisibility }));
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
    return { zelleInvoiceId: maybeAutoSendResult.zelleInvoiceId, factsBlock: maybeAutoSendResult.factsBlock, checked, payPageZelleVisibility };
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
  test('drafting runs the pay page Zelle check READ-ONLY (Codex round-26 P1: an inbound question never writes charge-claim state)', async () => {
    const { payPageZelleVisibility } = await draft({ inboundMessage: 'Can I pay invoice WPC-2026-0101 by Zelle?', open });
    expect(payPageZelleVisibility).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
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
    // Codex round-25 P1: NEITHER offered NOR denied — the fact tells the model to ask which invoice
    expect(factsBlock).toContain('SEVERAL open invoices');
    expect(factsBlock).toContain('do not offer Zelle and do not say it is unavailable; ask which invoice');
    expect(factsBlock).not.toContain('Zelle is not available for this account');
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

describe('the Payment options fact for the three Zelle situations (Codex round-25 P1)', () => {
  const { buildFactsBlock } = require('../services/sms-shadow-drafter');
  const GATE = 'GATE_SMS_REAL_ANSWERS';
  const line = (extras) => {
    process.env[GATE] = 'true';
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    try {
      return buildFactsBlock({ summary: 'T', billing: { outstandingBalance: 0, recentPayments: [] } }, { now: new Date('2026-09-29T15:00:00Z'), ...extras })
        .split('\n').find((l) => l.startsWith('- Payment options:'));
    } finally { delete process.env[GATE]; delete process.env.ZELLE_RECIPIENT; }
  };
  test('eligible target => offered; ineligible single target => denied; ambiguous target => ask which invoice (neither)', () => {
    expect(line({ zelleEligible: true })).toContain('or Zelle to pay@example.com');
    expect(line({ zelleEligible: false })).toContain('Zelle is not available for this account right now');
    const ambiguous = line({ zelleEligible: false, zelleTargetAmbiguous: true });
    expect(ambiguous).toContain('ask which invoice they want to pay');
    expect(ambiguous).not.toContain('or Zelle to');
    expect(ambiguous).not.toContain('is not available');
    expect(ambiguous.startsWith('- Payment options:')).toBe(true); // the sealed-eval marker line is unchanged
  });
  test('no recipient configured: the "no Zelle configured" wording wins even if the target is ambiguous', () => {
    process.env[GATE] = 'true';
    delete process.env.ZELLE_RECIPIENT;
    try {
      const l = buildFactsBlock({ summary: 'T', billing: { outstandingBalance: 0, recentPayments: [] } }, { now: new Date('2026-09-29T15:00:00Z'), zelleTargetAmbiguous: true })
        .split('\n').find((x) => x.startsWith('- Payment options:'));
      expect(l).toContain('no Zelle recipient is configured right now');
    } finally { delete process.env[GATE]; }
  });
  test('the drafter marks a named-but-not-open invoice and an ambiguous amount as "ask" too; one open invoice and no open invoice are not', async () => {
    const { resolveZelleTargetInvoice: r } = require('../services/zelle-target-invoice');
    const open2 = [{ id: 'a', invoiceNumber: 'WPC-2026-0001', amountDue: 50 }, { id: 'b', invoiceNumber: 'WPC-2026-0002', amountDue: 50 }];
    for (const msg of ['Can I pay by Zelle?', 'Zelle the $50?', 'Zelle invoice WPC-2026-0999?']) {
      const t = r({ openInvoices: open2 }, msg);
      expect({ msg, ask: !t.invoiceId && t.reason !== 'no_open_invoice' }).toEqual({ msg, ask: true });
    }
    expect(r({ openInvoices: [] }, 'Zelle?').reason).toBe('no_open_invoice');
    expect(r({ openInvoices: [open2[0]] }, 'Zelle?').invoiceId).toBe('a');
  });
});

// Codex round-27 P2: explicit target CONFLICTS get their own fact, never the "several open invoices" wording.
describe('conflict vs ambiguity wording (Codex round-27 P2)', () => {
  const { buildFactsBlock } = require('../services/sms-shadow-drafter');
  const GATE = 'GATE_SMS_REAL_ANSWERS';
  const line = (extras) => {
    process.env[GATE] = 'true';
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    try {
      return buildFactsBlock({ summary: 'T', billing: { outstandingBalance: 0, recentPayments: [] } }, { now: new Date('2026-09-29T15:00:00Z'), zelleEligible: false, ...extras })
        .split('\n').find((l) => l.startsWith('- Payment options:'));
    } finally { delete process.env[GATE]; delete process.env.ZELLE_RECIPIENT; }
  };
  test('conflict: the named invoice is not open — target-specific, not "SEVERAL", not "unavailable"', () => {
    const l = line({ zelleTargetConflict: true });
    expect(l).toContain('does NOT match an open invoice');
    expect(l).toContain('do not offer Zelle for it and do not say Zelle is unavailable in general');
    expect(l).not.toContain('SEVERAL');
    expect(l).not.toContain('ask which invoice');
    expect(l).not.toContain('or Zelle to');
    expect(l.startsWith('- Payment options:')).toBe(true);
  });
  test('genuine multiple-open ambiguity still asks which invoice', () => {
    const l = line({ zelleTargetAmbiguous: true });
    expect(l).toContain('SEVERAL open invoices');
    expect(l).toContain('ask which invoice');
  });
  test('the drafter classifies the resolver reasons: with ONE open invoice a named-but-different invoice / amount is a conflict, never "several"', async () => {
    const draftFacts = async (inboundMessage, open) => {
      jest.resetModules();
      process.env[GATE] = 'true';
      process.env.ZELLE_RECIPIENT = 'pay@example.com';
      process.env.SHADOW_DRAFT_VERIFY = 'false';
      process.env.SHADOW_FEWSHOT = 'false';
      jest.doMock('../models/db', () => jest.fn(() => ({ where: jest.fn(() => ({ first: jest.fn(async () => null) })) })));
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
      jest.doMock('../services/availability', () => ({ getAvailableSlots: jest.fn(async () => ({ zone: 'z', days: [] })) }));
      jest.doMock('../services/context-aggregator', () => ({
        getContextForCustomer: jest.fn(async () => ({ summary: 'QA', flags: [], smsHistory: [], customer: { id: 'customer-1', billingLane: null }, billing: { outstandingBalance: 0, recentPayments: [], openInvoice: open[0], openInvoices: open } })),
        authorizedDuesCents: jest.fn(() => []),
      }));
      jest.doMock('../routes/pay-v2', () => ({ payPageZelleVisibility: jest.fn(async () => ({ visible: true })) }));
      jest.doMock('../services/estimate-deposits', () => ({ assertInvoiceDepositSettlementReady: jest.fn(async () => {}) }));
      jest.doMock('../services/voice-profile-distiller', () => ({ getApprovedVoiceProfile: jest.fn(async () => null) }));
      jest.doMock('../services/call-booking-catalog', () => ({ loadBookableCallServices: async () => [] }));
      jest.doMock('../services/llm/call', () => ({
        dispatchWithFallback: jest.fn(async (policy, payload) => (payload?.laneId === 'sms_service_identity'
          ? { ok: true, json: { about: 'none', visit: null, service: null } }
          : { ok: true, text: JSON.stringify({ reply: 'ok', intended_actions: [], missing_info: null }), model: 'm' })),
      }));
      jest.doMock('../services/sms-suggest-mode', () => ({ hasRedactionPlaceholder: jest.fn(() => false), hasPriceQuote: jest.fn(() => false) }));
      const { generateGroundedDraft } = require('../services/sms-shadow-drafter');
      const context = await require('../services/context-aggregator').getContextForCustomer({ id: 'customer-1' });
      const out = await generateGroundedDraft({ client: {}, context, inboundMessage, intent: { intent: 'general_customer_sms_needs_review', confidence: 0.9 }, schedulingIntent: false, city: 'Venice' });
      delete process.env[GATE]; delete process.env.ZELLE_RECIPIENT; delete process.env.SHADOW_DRAFT_VERIFY; delete process.env.SHADOW_FEWSHOT;
      jest.resetModules();
      return out.factsBlock;
    };
    const one = [{ id: 'inv-1', invoiceNumber: 'WPC-2026-0101', status: 'sent', amountDue: 120 }];
    const two = [...one, { id: 'inv-2', invoiceNumber: 'WPC-2026-0202', status: 'sent', amountDue: 95 }];
    const f1 = await draftFacts('Can I Zelle invoice WPC-2026-0999?', one);
    expect(f1).toContain('does NOT match an open invoice');
    expect(f1).not.toContain('SEVERAL');
    const f2 = await draftFacts('Can I Zelle the $95 invoice?', one);
    expect(f2).toContain('does NOT match an open invoice');
    const f3 = await draftFacts('Can I pay by Zelle?', two);
    expect(f3).toContain('SEVERAL open invoices');
    expect(f3).not.toContain('does NOT match');
    const f4 = await draftFacts('Can I Zelle invoice WPC-2026-0999?', two);
    expect(f4).toContain('does NOT match an open invoice'); // an explicit conflict even with several open
  });
});

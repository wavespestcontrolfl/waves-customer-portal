/**
 * Codex round-19 P1 (PR #5331): with several open invoices the Zelle fact / recheck is about the invoice the
 * customer's message NAMES (number, then a unique amount) — not always the newest — and a reference that
 * can't be tied to exactly one abstains. The resolved id is what the decision persists (zelleInvoiceId). (Owner 2026-10-01 ~23:58Z: the
 * target's live Zelle facts reach the model only as a rendered Zelle sentence; the Payment options line carries guidance, never a contact.)
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

  async function draft({ inboundMessage, open, visible = true, noRecipient = false, gateOff = false }) {
    jest.resetModules();
    if (gateOff) delete process.env[GATE]; else process.env[GATE] = 'true';
    if (noRecipient) delete process.env.ZELLE_RECIPIENT; else process.env.ZELLE_RECIPIENT = 'pay@example.com';
    process.env.SHADOW_DRAFT_VERIFY = 'false';
    process.env.SHADOW_FEWSHOT = 'false';
    const checked = [];
    const mockDb = jest.fn((table) => {
      if (table === 'message_drafts') return { insert: jest.fn(() => ({ returning: jest.fn(async () => [{ id: 'draft-1' }]) })) };
      if (table === 'invoices') return { where: jest.fn((w) => ({ first: jest.fn(async () => { checked.push(w.id); return { id: w.id, customer_id: 'customer-1', status: 'sent', invoice_number: (open.find((i) => i.id === w.id) || {}).invoiceNumber }; }) })) };
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

  const checkedIds = (checked) => [...new Set(checked)]; // (liveZelleFacts reads the invoice row twice: its number, then its eligibility)
  test('the customer names the OLDER invoice: eligibility is checked on it, ITS id is persisted, and ITS Zelle sentence is rendered', async () => {
    const { zelleInvoiceId, checked, factsBlock } = await draft({ inboundMessage: 'Can I pay invoice WPC-2026-0101 by Zelle?', open });
    expect(checkedIds(checked)).toEqual(['inv-1']);
    expect(zelleInvoiceId).toBe('inv-1');
    expect(factsBlock).toContain('  - You can pay invoice WPC-2026-0101 by Zelle to pay@example.com, with your name or the invoice number in the Zelle memo.');
    expect(factsBlock).not.toContain('WPC-2026-0303 by Zelle');
  });
  test('drafting runs the pay page Zelle check READ-ONLY (Codex round-26 P1: an inbound question never writes charge-claim state)', async () => {
    const { payPageZelleVisibility } = await draft({ inboundMessage: 'Can I pay invoice WPC-2026-0101 by Zelle?', open });
    expect(payPageZelleVisibility).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
  });
  test('a unique amount also resolves it', async () => {
    const { zelleInvoiceId, checked } = await draft({ inboundMessage: 'Can I Zelle the $210?', open });
    expect(checkedIds(checked)).toEqual(['inv-1']);
    expect(zelleInvoiceId).toBe('inv-1');
  });
  test('no reference with several open: NO Zelle sentence, no invoice checked, nothing persisted', async () => {
    const { zelleInvoiceId, checked, factsBlock } = await draft({ inboundMessage: 'Can I pay by Zelle?', open });
    expect(checked).toEqual([]);
    expect(zelleInvoiceId).toBe(null);
    // Codex round-25 P1: NEITHER offered NOR denied - the fact tells the model to ask which invoice, and no Zelle sentence is rendered
    expect(factsBlock).toContain('SEVERAL open invoices');
    expect(factsBlock).toContain('ask which invoice they want to pay (its number or amount); do not mention Zelle');
    expect(factsBlock).not.toContain('by Zelle to');
    expect(factsBlock).not.toContain("Zelle isn't available");
    expect(factsBlock).not.toContain("We don't take Zelle");
    expect(factsBlock).not.toContain('pay@example.com');
  });
  test('one open invoice: unchanged (that invoice)', async () => {
    const { zelleInvoiceId, checked } = await draft({ inboundMessage: 'Can I pay by Zelle?', open: [open[0]] });
    expect(checkedIds(checked)).toEqual(['inv-3']);
    expect(zelleInvoiceId).toBe('inv-3');
  });
  test('the named invoice fails the pay page\'s Zelle check: its id is still the persisted target, and the facts carry the unavailability sentence (never an offer)', async () => {
    const { zelleInvoiceId, factsBlock } = await draft({ inboundMessage: 'Can I pay invoice WPC-2026-0101 by Zelle?', open, visible: false });
    expect(zelleInvoiceId).toBe('inv-1');
    expect(factsBlock).toContain("  - Zelle isn't available for invoice WPC-2026-0101 right now.");
    expect(factsBlock).not.toContain('by Zelle to');
  });
  test('gate off (v11): no target resolution, no invoice / Stripe read, no Zelle snapshot - byte-identical to main', async () => {
    const r = await draft({ inboundMessage: 'Can I pay invoice WPC-2026-0101 by Zelle?', open, gateOff: true });
    expect(r.checked).toEqual([]);
    expect(r.payPageZelleVisibility).not.toHaveBeenCalled();
    expect(r.zelleInvoiceId).toBe(null);
    expect(r.factsBlock).not.toContain('Payment options');
    expect(r.factsBlock).not.toContain('by Zelle to');
  });
  test('no Zelle recipient configured: the "we don\'t take Zelle" sentence is rendered and no invoice is read', async () => {
    const r = await draft({ inboundMessage: 'Can I pay by Zelle?', open, noRecipient: true });
    expect(r.checked).toEqual([]);
    expect(r.factsBlock).toContain("  - We don't take Zelle right now.");
    expect(r.factsBlock).not.toContain('pay@example.com');
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

describe('the Payment options fact for the Zelle situations (Codex round-25 P1; owner 2026-10-01: Zelle only as a rendered sentence)', () => {
  const { buildFactsBlock } = require('../services/sms-shadow-drafter');
  const GATE = 'GATE_SMS_REAL_ANSWERS';
  const factsFor = (zelleFacts, extras) => {
    process.env[GATE] = 'true';
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    try {
      return buildFactsBlock({ summary: 'T', billing: { outstandingBalance: 0, recentPayments: [], ...(zelleFacts ? { zelleFacts } : {}) } }, { now: new Date('2026-09-29T15:00:00Z'), ...extras });
    } finally { delete process.env[GATE]; delete process.env.ZELLE_RECIPIENT; }
  };
  const line = (zelleFacts, extras) => factsFor(zelleFacts, extras).split('\n').find((l) => l.startsWith('- Payment options:'));
  const OFFER = { state: 'offer', invoiceId: 'a', invoiceNumber: 'WPC-2026-0001', recipient: 'pay@example.com' };
  const COPY = 'for anything about Zelle, copy the Zelle sentence in Payment status sentences word for word; never write about Zelle any other way';
  test('a rendered Zelle sentence (offer / invoice unavailable / not offered): the line says copy it, and never names the recipient itself', () => {
    for (const facts of [OFFER, { ...OFFER, state: 'invoice_unavailable' }, { state: 'not_offered', invoiceId: null, invoiceNumber: null, recipient: null }]) {
      const l = line(facts);
      expect(l).toContain(COPY);
      expect(l).not.toContain('pay@example.com');
      expect(l.startsWith('- Payment options:')).toBe(true); // the sealed-eval marker line is unchanged
    }
    // the offer itself is a sentence in the block, with the live recipient
    expect(factsFor(OFFER)).toContain('  - You can pay invoice WPC-2026-0001 by Zelle to pay@example.com, with your name or the invoice number in the Zelle memo.');
  });
  test('an ambiguous target (several open invoices): ask which invoice, mention no Zelle', () => {
    const ambiguous = line(null, { zelleTargetAmbiguous: true });
    expect(ambiguous).toContain('SEVERAL open invoices');
    expect(ambiguous).toContain('ask which invoice they want to pay (its number or amount); do not mention Zelle');
    expect(ambiguous).not.toContain(COPY);
    expect(ambiguous).not.toContain('pay@example.com');
  });
  test('no Zelle facts and no ambiguity (an unverifiable state, no target): mention no Zelle, say a teammate will confirm', () => {
    const l = line({ state: null, invoiceId: 'a', invoiceNumber: 'WPC-2026-0001', recipient: 'pay@example.com' });
    expect(l).toContain('do not mention Zelle; if they ask about it, say a teammate will confirm');
    expect(l).not.toContain(COPY);
    expect(factsFor({ state: null, invoiceId: 'a', invoiceNumber: 'WPC-2026-0001', recipient: 'pay@example.com' })).not.toContain('by Zelle to');
  });
  test('the rendered "not offered" sentence wins even if the target is ambiguous (no recipient configured => nothing to ask about)', () => {
    const l = line({ state: 'not_offered', invoiceId: null, invoiceNumber: null, recipient: null }, { zelleTargetAmbiguous: true });
    expect(l).toContain(COPY);
    expect(l).not.toContain('SEVERAL');
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
      return buildFactsBlock({ summary: 'T', billing: { outstandingBalance: 0, recentPayments: [] } }, { now: new Date('2026-09-29T15:00:00Z'), ...extras })
        .split('\n').find((l) => l.startsWith('- Payment options:'));
    } finally { delete process.env[GATE]; delete process.env.ZELLE_RECIPIENT; }
  };
  test('conflict: the named invoice is not open — target-specific, not "SEVERAL", and no Zelle is mentioned', () => {
    const l = line({ zelleTargetConflict: true });
    expect(l).toContain('does NOT match an open invoice');
    expect(l).toContain('tell them that invoice is not open and that the office can confirm which invoice they mean; do not mention Zelle');
    expect(l).not.toContain('SEVERAL');
    expect(l).not.toContain('ask which invoice');
    expect(l).not.toContain('pay@example.com');
    expect(l.startsWith('- Payment options:')).toBe(true);
  });
  test('genuine multiple-open ambiguity still asks which invoice', () => {
    const l = line({ zelleTargetAmbiguous: true });
    expect(l).toContain('SEVERAL open invoices');
    expect(l).toContain('ask which invoice');
    expect(l).toContain('do not mention Zelle');
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

// Codex round-28 P2: a cut open-invoice list proves nothing about a NAMED invoice.
describe('truncated open-invoice list: tail matches (round 37 P2)', () => {
  const list = [inv('a', 'WPC-2026-0123', 100), inv('b', 'WPC-2026-0456', 200)];
  test('a bare tail ("#0123") does not resolve against a TRUNCATED list; only a full number does', () => {
    expect(resolveZelleTargetInvoice({ openInvoices: list, openInvoicesTruncated: true }, 'Zelle invoice #0123?')).toEqual({ invoiceId: null, reason: 'open_list_truncated' });
    expect(resolveZelleTargetInvoice({ openInvoices: list, openInvoicesTruncated: true }, 'Zelle invoice WPC-2026-0123?')).toEqual({ invoiceId: 'a', reason: 'invoice_number' });
    // a tail that is just the tail of the named full number is the same reference
    expect(resolveZelleTargetInvoice({ openInvoices: list, openInvoicesTruncated: true }, 'Zelle invoice WPC-2026-0123 (#0123)?').invoiceId).toBe('a');
  });
  test('the same tail still resolves on a complete list (unchanged)', () => {
    expect(resolveZelleTargetInvoice({ openInvoices: list, openInvoicesTruncated: false }, 'Zelle invoice #0123?')).toEqual({ invoiceId: 'a', reason: 'invoice_number' });
    expect(resolveZelleTargetInvoice({ openInvoices: list }, 'Zelle invoice #0123?').invoiceId).toBe('a');
  });
});

describe('truncated open-invoice list (round 28)', () => {
  const open = [{ id: 'a', invoiceNumber: 'WPC-2026-0001', amountDue: 50 }, { id: 'b', invoiceNumber: 'WPC-2026-0002', amountDue: 60 }];
  test('a named invoice absent from a TRUNCATED list is unresolved (not a "conflict")', () => {
    expect(resolveZelleTargetInvoice({ openInvoices: open, openInvoicesTruncated: true }, 'Can I Zelle invoice WPC-2026-0500?')).toEqual({ invoiceId: null, reason: 'open_list_truncated' });
    expect(resolveZelleTargetInvoice({ openInvoices: open, openInvoicesTruncated: false }, 'Can I Zelle invoice WPC-2026-0500?').reason).toBe('named_invoice_not_open');
  });
  test('a named invoice that IS in the list still resolves when truncated', () => {
    expect(resolveZelleTargetInvoice({ openInvoices: open, openInvoicesTruncated: true }, 'Zelle invoice WPC-2026-0002').invoiceId).toBe('b');
  });
});

// Codex round-31 P2: invoice-scoped amounts identify the target; bare amounts are only a fallback.
describe('invoice-scoped amount vs bare amounts (round 31)', () => {
  const open = [
    { id: 'a', invoiceNumber: 'WPC-2026-0001', amountDue: 200 },
    { id: 'b', invoiceNumber: 'WPC-2026-0002', amountDue: 100 },
    { id: 'c', invoiceNumber: 'WPC-2026-0003', amountDue: 55 },
  ];
  test('the auditor case: "my $200 invoice" + a bare $100 payment question resolves to the $200 invoice', () => {
    expect(resolveZelleTargetInvoice({ openInvoices: open }, 'Can I Zelle my $200 invoice? Did you receive my $100 payment?')).toEqual({ invoiceId: 'a', reason: 'unique_amount' });
    expect(resolveZelleTargetInvoice({ openInvoices: open }, 'Did you receive my $100 payment? Can I Zelle the $200 bill?').invoiceId).toBe('a');
  });
  test('with NO invoice-scoped amount the bare amounts still decide (unique => that invoice, several matches => ambiguous)', () => {
    expect(resolveZelleTargetInvoice({ openInvoices: open }, 'Can I Zelle the $55?').invoiceId).toBe('c');
    expect(resolveZelleTargetInvoice({ openInvoices: open }, 'Can I Zelle $200 or $100?')).toEqual({ invoiceId: null, reason: 'ambiguous_amount' });
  });
  test('a scoped amount that matches no open invoice is an explicit mismatch — never rescued by a bare amount that happens to match', () => {
    expect(resolveZelleTargetInvoice({ openInvoices: open }, 'Can I Zelle my $999 invoice? I also paid $100 before.')).toEqual({ invoiceId: null, reason: 'named_amount_differs' });
  });
  test('two scoped amounts that each match an open invoice are ambiguous', () => {
    expect(resolveZelleTargetInvoice({ openInvoices: open }, 'Zelle for the $200 invoice or the $100 invoice?')).toEqual({ invoiceId: null, reason: 'ambiguous_amount' });
  });
  test('a number still outranks any amount', () => {
    expect(resolveZelleTargetInvoice({ openInvoices: open }, 'Zelle invoice WPC-2026-0003, not my $200 invoice').invoiceId).toBeNull(); // number vs scoped amount conflict => abstain
    expect(resolveZelleTargetInvoice({ openInvoices: open }, 'Zelle invoice WPC-2026-0003. I paid $200 last time.').invoiceId).toBe('c');
  });
});

// Codex round-36 P1: every explicit invoice reference must resolve to the SAME single open invoice.
describe('multiple named invoice references (round 36)', () => {
  const { resolveZelleTargetInvoice } = require('../services/zelle-target-invoice');
  const open = [
    { id: 'a', invoiceNumber: 'WPC-2026-0123', status: 'sent', amountDue: 95 },
    { id: 'b', invoiceNumber: 'WPC-2026-0124', status: 'sent', amountDue: 210 },
  ];
  const only = [open[0]];
  test('one open + a second number that is not open => abstain (the second is never ignored)', () => {
    expect(resolveZelleTargetInvoice({ openInvoices: only }, 'Can I Zelle invoice 0123 and invoice 0999?')).toEqual({ invoiceId: null, reason: 'named_invoice_not_open' });
    expect(resolveZelleTargetInvoice({ openInvoices: only }, 'Zelle for WPC-2026-0123 and WPC-2025-0123?')).toEqual({ invoiceId: null, reason: 'named_invoice_not_open' });
  });
  test('two DIFFERENT open invoices named => a reference conflict, not the first', () => {
    expect(resolveZelleTargetInvoice({ openInvoices: open }, 'Zelle invoices 0123 and 0124?')).toEqual({ invoiceId: null, reason: 'reference_conflict' });
  });
  test('several references to the SAME open invoice (full + its own tail) still resolve', () => {
    expect(resolveZelleTargetInvoice({ openInvoices: open }, 'Zelle WPC-2026-0123 (invoice #0123)?')).toMatchObject({ invoiceId: 'a', reason: 'invoice_number' });
    expect(resolveZelleTargetInvoice({ openInvoices: only }, 'Zelle invoice 0123?')).toMatchObject({ invoiceId: 'a' });
  });
  test('a truncated open list never declares the second number "not open"', () => {
    expect(resolveZelleTargetInvoice({ openInvoices: only, openInvoicesTruncated: true }, 'Zelle invoice 0123 and 0999?')).toEqual({ invoiceId: null, reason: 'open_list_truncated' });
  });
});

// Codex round-39 P2: EVERY invoice-scoped amount must resolve - an unmatched one is an unresolved explicit target.
describe('invoice-scoped amounts that do not all resolve (round 39)', () => {
  const open = [
    { id: 'a', invoiceNumber: 'WPC-2026-0123', status: 'sent', amountDue: 100 },
    { id: 'b', invoiceNumber: 'WPC-2026-0124', status: 'sent', amountDue: 300 },
  ];
  test('two open invoices: "$100 and $200 invoices" abstains - the $200 target is unresolved', () => {
    expect(resolveZelleTargetInvoice({ openInvoices: open }, 'Can I Zelle my $100 and $200 invoices?')).toEqual({ invoiceId: null, reason: 'named_amount_differs' });
    expect(resolveZelleTargetInvoice({ openInvoices: open }, 'Can I Zelle my $100 invoice?')).toMatchObject({ invoiceId: 'a', reason: 'unique_amount' });
  });
  test('a single open invoice: every scoped amount must be its amount due', () => {
    expect(resolveZelleTargetInvoice({ openInvoices: [open[0]] }, 'Zelle my $100 and $200 invoices?')).toEqual({ invoiceId: null, reason: 'named_amount_differs' });
    expect(resolveZelleTargetInvoice({ openInvoices: [open[0]] }, 'Zelle my $100 invoice?').invoiceId).toBe('a');
  });
  test('a named number plus an extra scoped amount that is not its amount conflicts', () => {
    expect(resolveZelleTargetInvoice({ openInvoices: open }, 'Zelle invoice 0123, the $100 invoice and the $200 invoice?')).toEqual({ invoiceId: null, reason: 'reference_conflict' });
    expect(resolveZelleTargetInvoice({ openInvoices: open }, 'Zelle invoice 0123, the $100 invoice?').invoiceId).toBe('a');
  });
});

// Codex round-41 P2: several distinct BARE amounts all have to resolve — one that matches no open invoice is not silently ignored.
describe('several bare amounts (round 41)', () => {
  const open = [{ id: 'a', invoiceNumber: 'WPC-2026-0001', amountDue: 100 }, { id: 'b', invoiceNumber: 'WPC-2026-0002', amountDue: 300 }];
  test('"$100 or $200": the $200 alternative matches nothing, so the target is unresolved — never the $100 invoice', () => {
    expect(resolveZelleTargetInvoice({ openInvoices: open }, 'Can I Zelle $100 or $200?')).toEqual({ invoiceId: null, reason: 'ambiguous_amount' });
    expect(resolveZelleTargetInvoice({ openInvoices: open }, 'Can I Zelle $200 or $100?').invoiceId).toBeNull();
  });
  test('one bare amount that matches still resolves; a repeated amount is one amount; both alternatives matching stays ambiguous', () => {
    expect(resolveZelleTargetInvoice({ openInvoices: open }, 'Can I Zelle $100?')).toEqual({ invoiceId: 'a', reason: 'unique_amount' });
    expect(resolveZelleTargetInvoice({ openInvoices: open }, 'Can I Zelle $100? Yes the $100.')).toEqual({ invoiceId: 'a', reason: 'unique_amount' });
    expect(resolveZelleTargetInvoice({ openInvoices: open }, 'Can I Zelle $100 or $300?')).toEqual({ invoiceId: null, reason: 'ambiguous_amount' });
  });
});

// ---- Codex round-44 ------------------------------------------------------------------------------------------------------------------
describe('round 44: bare amounts are validated before the single-open-invoice shortcut', () => {
  const one = { openInvoices: [{ id: 'a', invoiceNumber: 'WPC-2026-0001', amountDue: 100 }] };
  test('several distinct bare amounts, one of them not this invoice\'s, leave the target unresolved', () => {
    expect(resolveZelleTargetInvoice(one, 'Can I Zelle $100 or $200?')).toEqual({ invoiceId: null, reason: 'ambiguous_amount' });
    expect(resolveZelleTargetInvoice(one, 'Can I Zelle $100 or $100.00?').invoiceId).toBe('a'); // the same amount twice is one amount
    expect(resolveZelleTargetInvoice(one, 'Can I Zelle $100?').invoiceId).toBe('a');
    expect(resolveZelleTargetInvoice(one, 'Can I use Zelle?').invoiceId).toBe('a');
  });
});

describe('round 44 (older threads, judged on 9f0f509): amount-based targets never resolve from a TRUNCATED list', () => {
  const list = [{ id: 'a', invoiceNumber: 'WPC-2026-0001', amountDue: 100 }, { id: 'b', invoiceNumber: 'WPC-2026-0002', amountDue: 200 }];
  test('invoice-scoped and bare amounts abstain when the open list was cut; a full invoice number still resolves', () => {
    expect(resolveZelleTargetInvoice({ openInvoices: list, openInvoicesTruncated: true }, 'Zelle the $100 invoice?')).toEqual({ invoiceId: null, reason: 'open_list_truncated' });
    expect(resolveZelleTargetInvoice({ openInvoices: list, openInvoicesTruncated: true }, 'did you get my $100?')).toEqual({ invoiceId: null, reason: 'open_list_truncated' });
    expect(resolveZelleTargetInvoice({ openInvoices: list, openInvoicesTruncated: false }, 'Zelle the $100 invoice?')).toEqual({ invoiceId: 'a', reason: 'unique_amount' });
    expect(resolveZelleTargetInvoice({ openInvoices: list, openInvoicesTruncated: true }, 'Zelle invoice WPC-2026-0001?').invoiceId).toBe('a');
  });
});

describe('round 44 P2: a partially paid invoice (amount due unknowable) is never a target and is never "no open invoice"', () => {
  const sent = { id: 'a', invoiceNumber: 'WPC-2026-0001', amountDue: 100 };
  test('nothing else open: unresolved, not no_open_invoice', () => {
    expect(resolveZelleTargetInvoice({ openInvoices: [], hasUncountedPartialDue: true }, 'Can I pay by Zelle?')).toEqual({ invoiceId: null, reason: 'partially_paid_invoice' });
    expect(resolveZelleTargetInvoice({ openInvoices: [], hasUncountedPartialDue: false }, 'Can I pay by Zelle?')).toEqual({ invoiceId: null, reason: 'no_open_invoice' });
  });
  test('one other invoice open: it is not assumed to be the one meant; naming it (number or amount) still resolves it', () => {
    expect(resolveZelleTargetInvoice({ openInvoices: [sent], hasUncountedPartialDue: true }, 'Can I pay by Zelle?')).toEqual({ invoiceId: null, reason: 'multiple_open_unreferenced' });
    expect(resolveZelleTargetInvoice({ openInvoices: [sent], hasUncountedPartialDue: true }, 'Zelle invoice WPC-2026-0001?').invoiceId).toBe('a');
    expect(resolveZelleTargetInvoice({ openInvoices: [sent], hasUncountedPartialDue: true }, 'Zelle the $100 invoice?').invoiceId).toBe('a');
    expect(resolveZelleTargetInvoice({ openInvoices: [sent] }, 'Can I pay by Zelle?').invoiceId).toBe('a'); // unchanged without a partial
  });
});

describe('round 45 (older thread): two full references with the same tail are never collapsed by a bare tail', () => {
  const both = { openInvoices: [{ id: 'a', invoiceNumber: 'WPC-2025-0123', amountDue: 50 }, { id: 'b', invoiceNumber: 'WPC-2026-0123', amountDue: 60 }] };
  test('both open: the two full numbers name different invoices => conflict, whatever the tail says', () => {
    expect(resolveZelleTargetInvoice(both, 'Zelle WPC-2025-0123 and WPC-2026-0123 (#0123)?')).toEqual({ invoiceId: null, reason: 'reference_conflict' });
  });
  test('a bare tail that matches two open invoices is ambiguous, never the first', () => {
    expect(resolveZelleTargetInvoice(both, 'Zelle invoice #0123?')).toEqual({ invoiceId: null, reason: 'ambiguous_invoice_number' });
  });
  test('one of the two is open: the other full reference is "not open" (never silently dropped)', () => {
    expect(resolveZelleTargetInvoice({ openInvoices: [both.openInvoices[1]] }, 'Zelle WPC-2025-0123 and WPC-2026-0123?')).toEqual({ invoiceId: null, reason: 'named_invoice_not_open' });
  });
});

// Codex round-48 P1: the bare "#0002" shorthand is an invoice reference (an edited Zelle reply is retargeted and rechecked)
describe('"#NNNN" shorthand', () => {
  const { invoiceNumbersNamed: named, explicitInvoiceReference: explicit, resolveZelleTargetInvoice: resolve } = require('../services/zelle-target-invoice');
  test.each(['You can Zelle for #0002', 'Zelle works for #0002.', 'pay #0002 by Zelle'])('names invoice 0002: %s', (t) => {
    expect(named(t).tail).toEqual(['0002']);
    expect(explicit(t)).toBe(true);
  });
  test.each(['Apt #204', 'order #12345', 'Ticket #555', 'account #1234', 'check #1001'])('a non-invoice "#" number is not an invoice: %s', (t) => {
    expect(explicit(t)).toBe(false);
  });
  test('the shorthand retargets: a paid #0002 is not the open invoice', () => {
    const billing = { openInvoices: [{ id: 'i1', invoiceNumber: 'WPC-2026-0001', amountDue: 95 }] };
    expect(resolve(billing, 'You can Zelle for #0002').invoiceId).toBeNull();
    expect(resolve(billing, 'You can Zelle for #0001').invoiceId).toBe('i1');
  });
});

// Codex round-50 P2: a legacy collectible status the context cannot model never proves "no open invoice"
describe('an unmodeled own invoice (legacy unpaid) leaves the Zelle target unresolved', () => {
  const { resolveZelleTargetInvoice: r } = require('../services/zelle-target-invoice');
  test('no open invoice + an unmodeled one => unmodeled_invoice (a denial cannot stand on it); none at all => no_open_invoice', () => {
    expect(r({ openInvoices: [], hasUnmodeledInvoice: true }, 'Can I pay by Zelle?')).toEqual({ invoiceId: null, reason: 'unmodeled_invoice' });
    expect(r({ openInvoices: [] }, 'Can I pay by Zelle?')).toEqual({ invoiceId: null, reason: 'no_open_invoice' });
  });
  test('the facts mention no Zelle for it (no sentence, "do not mention Zelle"), and never say "several open invoices"', () => {
    const GATE = 'GATE_SMS_REAL_ANSWERS';
    process.env[GATE] = 'true';
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    try {
      const { buildFactsBlock } = require('../services/sms-shadow-drafter');
      const l = buildFactsBlock({ summary: 'T', billing: { outstandingBalance: 0, recentPayments: [] } }, { now: new Date('2026-09-29T15:00:00Z'), zelleTargetUnknown: true })
        .split('\n').find((x) => x.startsWith('- Payment options:'));
      expect(l).toContain('do not mention Zelle; if they ask about it, say a teammate will confirm');
      expect(l).not.toContain('or Zelle to');
      expect(l).not.toContain('copy the Zelle sentence');
      expect(l).not.toContain('SEVERAL');
    } finally { delete process.env[GATE]; delete process.env.ZELLE_RECIPIENT; }
  });
});

// Codex round-64 P2: an unmodeled own invoice may be payable too - only an explicit identification selects the lone modeled row
test('one modeled open invoice + an unmodeled one: unreferenced => unresolved; an invoice number or invoice-tied amount => that row', () => {
  const both = { ...billing([MIDDLE]), hasUnmodeledInvoice: true };
  expect(resolveZelleTargetInvoice(both, 'Can I pay by Zelle?')).toEqual({ invoiceId: null, reason: 'unmodeled_invoice' });
  expect(resolveZelleTargetInvoice(both, 'I paid $50 last time — can I Zelle this time?').invoiceId).toBeNull();
  expect(resolveZelleTargetInvoice(both, 'Can I Zelle invoice WPC-2026-0202?').invoiceId).toBe('inv-2');
  expect(resolveZelleTargetInvoice(both, 'Can I Zelle the $120 invoice?').invoiceId).toBe('inv-2');
});

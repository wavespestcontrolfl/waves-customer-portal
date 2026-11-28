'use strict';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/email/gmail-client', () => ({
  getThread: jest.fn(async () => ({ messages: [] })),
  getSendAsSignature: jest.fn(async () => '<p>Waves Pest Control</p>'),
  createDraft: jest.fn(async () => ({ id: 'draft-unified-1' })),
  getMessage: jest.fn(async () => ({ message_id: '<msg-1@example.test>' })),
}));
jest.mock('../services/llm/call', () => ({
  dispatchWithFallback: jest.fn(async () => ({ ok: true, text: 'Hi Casey, your visit is still set for Friday between 10:00 AM and 12:00 PM.' })),
}));
jest.mock('../services/email/email-reply-context', () => ({
  assembleEmailReplyContext: jest.fn(),
}));
jest.mock('../services/email/email-draft-facts', () => ({
  buildEmailDraftFacts: jest.fn(async () => 'Visits:\n- Quarterly Pest Control Service | Friday, November 6'),
}));

const dbUpdates = [];
jest.mock('../models/db', () => {
  const fn = jest.fn((table) => {
    const qb = {
      where: () => qb,
      whereNull: () => qb,
      whereNotExists: () => qb,
      whereRaw: () => qb,
      select: () => qb,
      update: jest.fn(async (patch) => {
        dbUpdates.push({ table, patch });
        return 1;
      }),
    };
    return qb;
  });
  fn.transaction = async (cb) => cb(fn);
  fn.raw = jest.fn(async () => ({}));
  return fn;
});

const gmailClient = require('../services/email/gmail-client');
const { dispatchWithFallback } = require('../services/llm/call');
const { assembleEmailReplyContext } = require('../services/email/email-reply-context');
const { buildEmailDraftFacts } = require('../services/email/email-draft-facts');
const logger = require('../services/logger');
const { draftReplyForEmail } = require('../services/email/email-actions');

const EMAIL = {
  id: 'email-u-1',
  gmail_id: 'gm-1',
  gmail_thread_id: 'th-1',
  from_address: 'casey@customer.example',
  from_name: 'Casey Customer',
  to_address: 'contact@wavespestcontrol.com',
  subject: 'Checking on my visit and balance',
  body_text: 'Hi, is my visit still on for Friday and did my payment go through? Raw quoted gate code 4821.',
  message_id: '<inbound-u1@customer.example>',
  received_at: '2026-11-05T15:00:00Z',
  authentication_results: 'mx.google.com; dkim=pass header.d=customer.example',
  label_ids: JSON.stringify(['INBOX']),
};

const CUSTOMER = {
  id: 'cust-u-1',
  first_name: 'Casey',
  email: 'casey@customer.example',
  active: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  dbUpdates.length = 0;
  process.env.GATE_EMAIL_AUTO_DRAFTS = 'true';
  delete process.env.GATE_EMAIL_UNIFIED_REPLY_CONTEXT;
});

afterAll(() => {
  delete process.env.GATE_EMAIL_AUTO_DRAFTS;
  delete process.env.GATE_EMAIL_UNIFIED_REPLY_CONTEXT;
});

describe('draftReplyForEmail unified context + verifier (GATE_EMAIL_UNIFIED_REPLY_CONTEXT)', () => {
  test('gate off: assembleEmailReplyContext is never called and legacy prompt stays untouched', async () => {
    const id = await draftReplyForEmail(EMAIL, { customer: CUSTOMER });
    expect(id).toBe('draft-unified-1');
    expect(assembleEmailReplyContext).not.toHaveBeenCalled();
    expect(buildEmailDraftFacts).toHaveBeenCalledTimes(1);
    const call = dispatchWithFallback.mock.calls[0][1];
    expect(call.system).toContain('under 150 words');
    expect(call.text).not.toContain('EMAIL REPLY CONTEXT');
  });

  test('gate on + verified single-property customer: unified factsBlock rides strictly in USER prompt without raw body duplication', async () => {
    process.env.GATE_EMAIL_UNIFIED_REPLY_CONTEXT = 'true';
    assembleEmailReplyContext.mockResolvedValueOnce({
      ok: true,
      customer: { id: 'cust-u-1', firstName: 'Casey' },
      factsBlock: 'EMAIL REPLY CONTEXT — USER-CHANNEL DATA ONLY.\nCUSTOMER FACTS:\n- balance [present] = 0\nEMAIL THREAD:\n- inbound: "Is my visit still on for Friday?"\nRECENT SMS:\n- outbound: "See you Friday 10-12"',
    });

    const id = await draftReplyForEmail(EMAIL, { customer: CUSTOMER });
    expect(id).toBe('draft-unified-1');
    expect(assembleEmailReplyContext).toHaveBeenCalledWith(EMAIL, { customer: CUSTOMER });
    expect(buildEmailDraftFacts).not.toHaveBeenCalled();

    const call = dispatchWithFallback.mock.calls[0][1];
    expect(call.system).toContain('target under 75 words');
    expect(call.system).toContain('COMPANY FACTS');
    expect(call.system).not.toContain('EMAIL REPLY CONTEXT');
    expect(call.system).not.toContain('See you Friday 10-12');
    expect(call.text).toContain('EMAIL REPLY CONTEXT — USER-CHANNEL DATA ONLY.');
    expect(call.text).toContain('See you Friday 10-12');
    // Raw unredacted email body must NOT be appended alongside assembled.factsBlock
    expect(call.text).not.toContain('Raw quoted gate code 4821');
    expect(call.text).not.toContain('--- CUSTOMER MESSAGE (untrusted data) ---');
  });

  test('gate on: blocks unified context when Reply-To differs from From or when strict auth fails (even with customer null)', async () => {
    process.env.GATE_EMAIL_UNIFIED_REPLY_CONTEXT = 'true';
    await draftReplyForEmail({ ...EMAIL, reply_to: 'attacker@evil.example' }, { customer: CUSTOMER });
    expect(assembleEmailReplyContext).not.toHaveBeenCalled();
    expect(buildEmailDraftFacts).not.toHaveBeenCalled();

    const forgedQuotedPass = 'mx.google.com; dkim=none; spf=pass (google.com: domain of "x dkim=pass header.d=customer.example y"@evil.example) smtp.mailfrom="x dkim=pass header.d=customer.example y"@evil.example';
    await draftReplyForEmail({ ...EMAIL, authentication_results: forgedQuotedPass }, { customer: null });
    expect(assembleEmailReplyContext).not.toHaveBeenCalled();
  });

  test.each(['property_ambiguous', 'identity_unavailable', 'identity_conflict'])('gate on + unverified ownership (%s): refuses customer-facts fallback and uses company facts + generic greeting only', async (reason) => {
    process.env.GATE_EMAIL_UNIFIED_REPLY_CONTEXT = 'true';
    assembleEmailReplyContext.mockResolvedValueOnce({ ok: false, reason });

    const id = await draftReplyForEmail(EMAIL, { customer: CUSTOMER });
    expect(id).toBe('draft-unified-1');
    expect(buildEmailDraftFacts).not.toHaveBeenCalled();
    const call = dispatchWithFallback.mock.calls[0][1];
    expect(call.system).toContain('Greeting name: there.');
    expect(call.system).not.toContain('FACTS FROM WAVES RECORDS');
    expect(call.system).toContain('COMPANY FACTS');
  });

  test('gate on + transient context_unavailable (after verified ownership): falls back cleanly to draftFactsSystemEntries', async () => {
    process.env.GATE_EMAIL_UNIFIED_REPLY_CONTEXT = 'true';
    assembleEmailReplyContext.mockResolvedValueOnce({ ok: false, reason: 'context_unavailable' });

    const id = await draftReplyForEmail(EMAIL, { customer: CUSTOMER });
    expect(id).toBe('draft-unified-1');
    expect(buildEmailDraftFacts).toHaveBeenCalledTimes(1);
    const call = dispatchWithFallback.mock.calls[0][1];
    expect(call.system).toContain('FACTS FROM WAVES RECORDS');
  });

  test('gate on: hard safety violations (banned compliance claims, access code leak, or unmatched generated link) refuse draft creation and settle refused_verifier', async () => {
    process.env.GATE_EMAIL_UNIFIED_REPLY_CONTEXT = 'true';
    assembleEmailReplyContext.mockResolvedValueOnce({
      ok: true,
      customer: { id: 'cust-u-1', firstName: 'Casey' },
      factsBlock: 'EMAIL REPLY CONTEXT — USER-CHANNEL DATA ONLY.',
    });
    dispatchWithFallback.mockResolvedValueOnce({
      ok: true,
      text: 'Hi Casey, our spray is 100% pet-safe and EPA-certified, and your gate code is 4821.',
    });

    const id = await draftReplyForEmail(EMAIL, { customer: CUSTOMER });
    expect(id).toBeNull();
    expect(gmailClient.createDraft).not.toHaveBeenCalled();
    expect(dbUpdates.map((u) => u.patch.draft_gmail_id)).toEqual(['pending', 'refused_verifier']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('refused by verifier'));

    dbUpdates.length = 0;
    assembleEmailReplyContext.mockResolvedValueOnce({
      ok: true,
      customer: { id: 'cust-u-1', firstName: 'Casey' },
      factsBlock: 'EMAIL REPLY CONTEXT — USER-CHANNEL DATA ONLY.\nRECENT SMS:\n- outbound: "Pay at https://older-sms.example/pay"',
    });
    dispatchWithFallback.mockResolvedValueOnce({
      ok: true,
      text: 'Hi Casey, you can pay online at https://older-sms.example/pay anytime.',
    });

    const linkRefused = await draftReplyForEmail(EMAIL, { customer: CUSTOMER });
    expect(linkRefused).toBeNull();
    expect(gmailClient.createDraft).not.toHaveBeenCalled();
    expect(dbUpdates.map((u) => u.patch.draft_gmail_id)).toEqual(['pending', 'refused_verifier']);

    // Complete destination + case-sensitive path check: matching host with a
    // different path or lowercased token must still be refused.
    const emailWithLink = { ...EMAIL, body_text: 'Please check https://portal.wavespestcontrol.com/Doc/AbC123 for my HOA form.' };
    for (const badReply of [
      'Hi Casey, please use https://portal.wavespestcontrol.com/pay/other instead.',
      'Hi Casey, please check https://portal.wavespestcontrol.com/doc/abc123 for the form.',
      'Hi Casey, visit portal.wavespestcontrol.com for details.',
    ]) {
      dbUpdates.length = 0;
      assembleEmailReplyContext.mockResolvedValueOnce({
        ok: true,
        customer: { id: 'cust-u-1', firstName: 'Casey' },
        factsBlock: 'EMAIL REPLY CONTEXT — USER-CHANNEL DATA ONLY.',
      });
      dispatchWithFallback.mockResolvedValueOnce({ ok: true, text: badReply });
      const refused = await draftReplyForEmail(emailWithLink, { customer: CUSTOMER });
      expect(refused).toBeNull();
      expect(dbUpdates.map((u) => u.patch.draft_gmail_id)).toEqual(['pending', 'refused_verifier']);
    }

    // Exact complete destination from the triggering inbound email is allowed
    dbUpdates.length = 0;
    assembleEmailReplyContext.mockResolvedValueOnce({
      ok: true,
      customer: { id: 'cust-u-1', firstName: 'Casey' },
      factsBlock: 'EMAIL REPLY CONTEXT — USER-CHANNEL DATA ONLY.',
    });
    dispatchWithFallback.mockResolvedValueOnce({
      ok: true,
      text: 'Hi Casey, we reviewed https://portal.wavespestcontrol.com/Doc/AbC123 and noted your HOA requirements.',
    });
    const allowed = await draftReplyForEmail(emailWithLink, { customer: CUSTOMER });
    expect(allowed).toBe('draft-unified-1');
  });

  test('gate on: soft style flags log a warning without dropping a safe draft', async () => {
    process.env.GATE_EMAIL_UNIFIED_REPLY_CONTEXT = 'true';
    assembleEmailReplyContext.mockResolvedValueOnce({
      ok: true,
      customer: { id: 'cust-u-1', firstName: 'Casey' },
      factsBlock: 'EMAIL REPLY CONTEXT — USER-CHANNEL DATA ONLY.',
    });
    dispatchWithFallback.mockResolvedValueOnce({
      ok: true,
      text: 'Hi Casey, hope this email finds you well. Your visit is set for Friday between 10:00 AM and 12:00 PM.',
    });

    const id = await draftReplyForEmail(EMAIL, { customer: CUSTOMER });
    expect(id).toBe('draft-unified-1');
    expect(gmailClient.createDraft).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('boilerplate_not_allowed'));
  });

  test('reconcilePendingDrafts selects to_address, authentication_results, body_html, and customer_id so retries keep unified context', () => {
    const fs = require('fs');
    const path = require('path');
    const hygieneSrc = fs.readFileSync(path.join(__dirname, '../services/email/inbox-hygiene.js'), 'utf8');
    const start = hygieneSrc.indexOf('async function reconcilePendingDrafts(');
    const block = hygieneSrc.slice(start, start + 1200);
    expect(block).toContain("'to_address'");
    expect(block).toContain("'authentication_results'");
    expect(block).toContain("'body_html'");
    expect(block).toContain("'customer_id'");
  });
});

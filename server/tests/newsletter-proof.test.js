/**
 * Newsletter proof-approval flow (GATE_NEWSLETTER_PROOF_APPROVAL).
 *
 * Pins the trust boundary:
 *   1. Everything is inert with the gate off — no proofs, no approvals.
 *   2. Only an allowlisted owner address can approve, only with an
 *      un-negated "approved" in the freshly-typed (un-quoted) reply text.
 *   3. Approval re-runs the manual Send button's validation gate and
 *      claims proof_approved_at atomically before dispatching.
 *   4. sendNewsletterProof is idempotent (proof_sent_at) and never proofs
 *      a draft the Send button would reject.
 */

const mockSendOne = jest.fn(async () => ({ messageId: 'sg-proof-1' }));
const mockSendCampaign = jest.fn(async () => ({ ok: true }));
const mockValidate = jest.fn(() => ({ errors: [], warnings: [] }));
const mockTrigger = jest.fn(async () => ({ ok: true }));

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: () => true,
  sendOne: mockSendOne,
  unsubscribeUrl: jest.fn((t) => `https://portal/unsub/${t}`),
  newsletterGroupId: jest.fn(() => 28768),
}));
jest.mock('../services/newsletter-sender', () => ({
  sendCampaign: mockSendCampaign,
  resolveSegmentCustomerIds: jest.fn(async () => null),
  buildSubscriberQuery: jest.fn(() => ({
    count: () => ({ first: async () => ({ c: 606 }) }),
  })),
  loadPersonalizationContext: jest.fn(async () => new Map()),
}));
jest.mock('../services/newsletter-validator', () => ({
  validateNewsletterDraft: mockValidate,
}));
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: mockTrigger,
}));
jest.mock('../services/email-template', () => ({
  wrapNewsletter: ({ body }) => `<wrapped>${body}</wrapped>`,
}));

const db = require('../models/db');
const {
  parseProofToken,
  extractTopReplyText,
  htmlReplyToText,
  isApprovalReply,
  maskEmail,
  sendNewsletterProof,
  maybeHandleProofApproval,
  approvalSenders,
} = require('../services/newsletter-proof');

function chain(overrides = {}) {
  const q = {};
  ['where', 'whereRaw', 'whereNull', 'whereIn', 'select', 'orderBy', 'limit']
    .forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => overrides.first);
  q.update = jest.fn(async () => (overrides.update !== undefined ? overrides.update : 1));
  q.count = jest.fn(() => q);
  Object.assign(q, overrides.extra || {});
  return q;
}

const FLAGSHIP_DRAFT = {
  id: 'send-1',
  subject: 'Bubbles & Sea Lions',
  status: 'draft',
  newsletter_type: 'local-weekly-fresh-events',
  html_body: '<p>events</p>',
  text_body: 'events',
  segment_filter: null,
  from_email: 'newsletter@wavespestcontrol.com',
  from_name: 'Waves',
  proof_token: 'ab12cd34',
  proof_sent_at: null,
  proof_approved_at: null,
};

// Approval-ready fixture: proof stamped, no edits since (the proof write
// sets proof_sent_at === updated_at in one update).
const PROOF_STAMP = new Date('2026-07-09T18:00:00Z');
const PROOFED_DRAFT = { ...FLAGSHIP_DRAFT, proof_sent_at: PROOF_STAMP, updated_at: PROOF_STAMP };

function wireDb({ sends, subscribers } = {}) {
  const sendsChain = chain(sends || {});
  const subsChain = chain(subscribers || { first: undefined });
  db.mockImplementation((table) => (table === 'newsletter_sends' ? sendsChain : subsChain));
  return { sendsChain, subsChain };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_NEWSLETTER_PROOF_APPROVAL = 'true';
  // Approvers are fail-closed (no default) — tests opt in explicitly.
  process.env.NEWSLETTER_PROOF_APPROVERS = 'contact@wavespestcontrol.com';
  delete process.env.NEWSLETTER_PROOF_EMAIL;
  delete process.env.GMAIL_USER_EMAIL;
  mockValidate.mockReturnValue({ errors: [], warnings: [] });
  mockSendOne.mockImplementation(async () => ({ messageId: 'sg-proof-1' }));
});

afterAll(() => {
  delete process.env.GATE_NEWSLETTER_PROOF_APPROVAL;
  delete process.env.NEWSLETTER_PROOF_APPROVERS;
});

describe('parseProofToken', () => {
  test('extracts and lowercases the token, including on replies', () => {
    expect(parseProofToken('[PROOF-ab12cd34] Hello')).toBe('ab12cd34');
    expect(parseProofToken('Re: [PROOF-AB12CD34] Hello')).toBe('ab12cd34');
    expect(parseProofToken('Fwd: re: [proof-ab12cd34] x')).toBe('ab12cd34');
  });
  test('returns null when absent or malformed', () => {
    expect(parseProofToken('Weekly newsletter')).toBeNull();
    expect(parseProofToken('[PROOF-xyz] nope')).toBeNull();
    expect(parseProofToken(undefined)).toBeNull();
  });
});

describe('extractTopReplyText', () => {
  test('keeps typed text, drops quoted lines and everything below the separator', () => {
    const body = [
      'approved',
      '',
      'On Thu, Jul 9, 2026 at 8:00 PM Waves <newsletter@wavespestcontrol.com> wrote:',
      '> Reply APPROVED to this email',
      '> and it goes out',
    ].join('\n');
    expect(extractTopReplyText(body)).toBe('approved');
  });
  test('quoted "APPROVED" from the proof banner alone is not typed text', () => {
    const body = ['> Reply APPROVED to this email and it goes out'].join('\n');
    expect(extractTopReplyText(body)).toBe('');
  });
  test('stops at From:-style forwards', () => {
    const body = ['looks wrong', 'From: someone', 'approved'].join('\n');
    expect(extractTopReplyText(body)).toBe('looks wrong');
  });
});

describe('isApprovalReply', () => {
  test.each(['approved', 'Approved!', 'APPROVED 🚀', 'approve', 'yes — approved'])(
    'accepts %j', (t) => expect(isApprovalReply(t)).toBe(true),
  );
  test.each([
    'not approved', "don't approve", 'do not approve yet', 'never approve this',
    "can't approve this yet", 'cannot approve', "won't approve",
    'hold off on approving', 'wait to approve', 'no, do not approve',
    'looks good', 'send it', '', undefined,
  ])('rejects %j', (t) => expect(isApprovalReply(t)).toBe(false));
});

describe('htmlReplyToText — quote-aware HTML conversion', () => {
  test('drops blockquoted proof banner; typed text survives with line structure', () => {
    const html = '<div>needs changes</div><blockquote>Reply <strong>APPROVED</strong> to this email and it goes out</blockquote>';
    const text = htmlReplyToText(html);
    expect(text).toContain('needs changes');
    expect(text).not.toMatch(/APPROVED/);
  });
  test('drops gmail_quote container through end of message', () => {
    const html = '<div dir="ltr">approved<br></div><div class="gmail_quote gmail_quote_container">On Thu wrote: Reply APPROVED to this email</div>';
    const text = htmlReplyToText(html);
    expect(text.trim()).toBe('approved');
  });
  test('nested blockquotes all removed', () => {
    const html = '<p>hold off</p><blockquote>outer APPROVED <blockquote>inner APPROVED</blockquote></blockquote>';
    expect(htmlReplyToText(html)).not.toMatch(/APPROVED/);
  });
});

describe('maskEmail', () => {
  test('masks the local part, keeps the domain', () => {
    expect(maskEmail('contact@wavespestcontrol.com')).toBe('co***@wavespestcontrol.com');
    expect(maskEmail('not-an-email')).toBe('(invalid)');
  });
});

describe('approvalSenders', () => {
  test('FAIL CLOSED by default; env sets the explicit allowlist', () => {
    delete process.env.NEWSLETTER_PROOF_APPROVERS;
    expect(approvalSenders()).toEqual([]);
    process.env.NEWSLETTER_PROOF_APPROVERS = 'A@x.com, b@y.com';
    expect(approvalSenders()).toEqual(['a@x.com', 'b@y.com']);
  });
});

describe('sendNewsletterProof', () => {
  test('inert when the gate is off', async () => {
    process.env.GATE_NEWSLETTER_PROOF_APPROVAL = 'false';
    wireDb();
    const r = await sendNewsletterProof('send-1');
    expect(r).toEqual({ skipped: true, reason: 'gate_off' });
    expect(mockSendOne).not.toHaveBeenCalled();
  });

  test('idempotent — already-proofed draft is skipped', async () => {
    wireDb({ sends: { first: { ...FLAGSHIP_DRAFT, proof_sent_at: new Date() } } });
    const r = await sendNewsletterProof('send-1');
    expect(r.reason).toBe('proof_already_sent');
    expect(mockSendOne).not.toHaveBeenCalled();
  });

  test('non-draft statuses are skipped', async () => {
    wireDb({ sends: { first: { ...FLAGSHIP_DRAFT, status: 'sent' } } });
    const r = await sendNewsletterProof('send-1');
    expect(r.reason).toBe('status_sent');
    expect(mockSendOne).not.toHaveBeenCalled();
  });

  test('validation failure blocks the proof and notifies instead', async () => {
    mockValidate.mockReturnValue({ errors: ['hallucinated claim'], warnings: [] });
    wireDb({ sends: { first: { ...FLAGSHIP_DRAFT, proof_token: null } } });
    const r = await sendNewsletterProof('send-1');
    expect(r.reason).toBe('validation_failed');
    expect(mockSendOne).not.toHaveBeenCalled();
    expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_blocked', expect.objectContaining({
      errors: ['hallucinated claim'],
    }));
  });

  test('no approvers configured → fail closed, no proof at all', async () => {
    delete process.env.NEWSLETTER_PROOF_APPROVERS;
    wireDb({ sends: { first: { ...FLAGSHIP_DRAFT, proof_token: null } } });
    const r = await sendNewsletterProof('send-1');
    expect(r.reason).toBe('no_approvers_configured');
    expect(mockSendOne).not.toHaveBeenCalled();
  });

  test('happy path: atomic claim BEFORE SendGrid, token subject + banner, no ASM group, synced reply-to', async () => {
    const { sendsChain } = wireDb({ sends: { first: { ...FLAGSHIP_DRAFT, proof_token: null } } });
    const r = await sendNewsletterProof('send-1');
    expect(r.sent).toBe(true);
    expect(r.token).toMatch(/^[0-9a-f]{8}$/);
    expect(mockSendOne).toHaveBeenCalledTimes(1);
    const args = mockSendOne.mock.calls[0][0];
    expect(args.to).toBe('contact@wavespestcontrol.com');
    expect(args.subject).toBe(`[PROOF-${r.token}] Bubbles & Sea Lions`);
    // Reply must come back to the mailbox the Gmail sync watches
    expect(args.replyTo).toBe('contact@wavespestcontrol.com');
    // Internal control message — newsletter suppression must not apply
    expect(args.asmGroupId).toBeUndefined();
    expect(args.html).toContain('Reply <strong>APPROVED</strong>');
    expect(args.html).toContain('606');
    // Claim is whereNull-guarded and stamps token+sent_at+updated_at together
    expect(sendsChain.whereNull).toHaveBeenCalledWith('proof_sent_at');
    const claim = sendsChain.update.mock.calls[0][0];
    expect(claim.proof_token).toBe(r.token);
    expect(claim.proof_sent_at).toBeInstanceOf(Date);
    expect(claim.updated_at).toBe(claim.proof_sent_at);
    expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_sent', expect.objectContaining({
      recipientCount: 606,
      recipient: 'co***@wavespestcontrol.com',
    }));
  });

  test('lost the atomic proof claim (concurrent worker) → no email', async () => {
    wireDb({ sends: { first: { ...FLAGSHIP_DRAFT, proof_token: null }, update: 0 } });
    const r = await sendNewsletterProof('send-1');
    expect(r.reason).toBe('proof_claimed_elsewhere');
    expect(mockSendOne).not.toHaveBeenCalled();
  });

  test('SendGrid failure releases the claim so the catch-up tick can retry', async () => {
    mockSendOne.mockImplementation(async () => { throw new Error('sendgrid 503'); });
    const { sendsChain } = wireDb({ sends: { first: { ...FLAGSHIP_DRAFT, proof_token: null } } });
    const r = await sendNewsletterProof('send-1');
    expect(r.reason).toBe('proof_send_failed');
    // second update clears the claim
    const lastUpdate = sendsChain.update.mock.calls.at(-1)[0];
    expect(lastUpdate.proof_token).toBeNull();
    expect(lastUpdate.proof_sent_at).toBeNull();
  });
});

describe('maybeHandleProofApproval', () => {
  const APPROVAL_EMAIL = {
    id: 'email-1',
    subject: 'Re: [PROOF-ab12cd34] Bubbles & Sea Lions',
    from_address: 'contact@wavespestcontrol.com',
    body_text: 'approved\n\nOn Thu wrote:\n> Reply APPROVED to this email',
  };

  test('inert when the gate is off', async () => {
    process.env.GATE_NEWSLETTER_PROOF_APPROVAL = 'false';
    wireDb();
    expect(await maybeHandleProofApproval(APPROVAL_EMAIL)).toBe(false);
    expect(mockSendCampaign).not.toHaveBeenCalled();
  });

  test('not ours: subject without a proof token', async () => {
    wireDb();
    expect(await maybeHandleProofApproval({ ...APPROVAL_EMAIL, subject: 'Re: invoice' })).toBe(false);
  });

  test('non-allowlisted sender cannot approve', async () => {
    wireDb({ sends: { first: PROOFED_DRAFT } });
    const r = await maybeHandleProofApproval({ ...APPROVAL_EMAIL, from_address: 'attacker@evil.com' });
    expect(r).toBe(false);
    expect(mockSendCampaign).not.toHaveBeenCalled();
  });

  test('no approvers configured → nobody can approve (fail closed)', async () => {
    delete process.env.NEWSLETTER_PROOF_APPROVERS;
    wireDb({ sends: { first: PROOFED_DRAFT } });
    const r = await maybeHandleProofApproval(APPROVAL_EMAIL);
    expect(r).toBe(false);
    expect(mockSendCampaign).not.toHaveBeenCalled();
  });

  test('reply that does not say approved leaves the draft untouched', async () => {
    const { sendsChain } = wireDb({ sends: { first: PROOFED_DRAFT } });
    const r = await maybeHandleProofApproval({ ...APPROVAL_EMAIL, body_text: 'hold off, fix the second event' });
    expect(r).toBe(true);
    expect(sendsChain.update).not.toHaveBeenCalled();
    expect(mockSendCampaign).not.toHaveBeenCalled();
  });

  test('quoted APPROVED from the banner alone does not approve', async () => {
    wireDb({ sends: { first: PROOFED_DRAFT } });
    const r = await maybeHandleProofApproval({
      ...APPROVAL_EMAIL,
      body_text: '> Reply APPROVED to this email and it goes out to 606 subscribers.',
    });
    expect(r).toBe(true);
    expect(mockSendCampaign).not.toHaveBeenCalled();
  });

  test('HTML-only reply: quoted banner ignored, typed non-approval does NOT dispatch', async () => {
    wireDb({ sends: { first: PROOFED_DRAFT } });
    const r = await maybeHandleProofApproval({
      ...APPROVAL_EMAIL,
      body_text: null,
      body_html: '<div dir="ltr">needs changes</div><blockquote>Reply <strong>APPROVED</strong> to this email and it goes out.</blockquote>',
    });
    expect(r).toBe(true);
    expect(mockSendCampaign).not.toHaveBeenCalled();
  });

  test('HTML-only reply: typed approved dispatches', async () => {
    wireDb({ sends: { first: PROOFED_DRAFT } });
    const r = await maybeHandleProofApproval({
      ...APPROVAL_EMAIL,
      body_text: null,
      body_html: '<div dir="ltr">approved<br></div><div class="gmail_quote">On Thu wrote: Reply APPROVED…</div>',
    });
    expect(r).toBe(true);
    expect(mockSendCampaign).toHaveBeenCalledWith('send-1');
  });

  test('duplicate approval reply is a no-op', async () => {
    wireDb({ sends: { first: { ...PROOFED_DRAFT, proof_approved_at: new Date() } } });
    const r = await maybeHandleProofApproval(APPROVAL_EMAIL);
    expect(r).toBe(true);
    expect(mockSendCampaign).not.toHaveBeenCalled();
  });

  test('already-sent campaign cannot be re-approved', async () => {
    wireDb({ sends: { first: { ...PROOFED_DRAFT, status: 'sent' } } });
    const r = await maybeHandleProofApproval(APPROVAL_EMAIL);
    expect(r).toBe(true);
    expect(mockSendCampaign).not.toHaveBeenCalled();
  });

  test('draft edited AFTER the proof → approval refused, proof invalidated + reissued', async () => {
    const edited = { ...PROOFED_DRAFT, updated_at: new Date(PROOF_STAMP.getTime() + 60_000) };
    const { sendsChain } = wireDb({ sends: { first: edited } });
    const r = await maybeHandleProofApproval(APPROVAL_EMAIL);
    expect(r).toBe(true);
    expect(mockSendCampaign).not.toHaveBeenCalled();
    expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_blocked', expect.objectContaining({
      errors: expect.arrayContaining([expect.stringContaining('edited after the proof')]),
    }));
    // stale proof invalidated (token-scoped clear)
    expect(sendsChain.update).toHaveBeenCalledWith(expect.objectContaining({ proof_token: null, proof_sent_at: null }));
  });

  test('validation failure at approval time blocks the send and notifies', async () => {
    mockValidate.mockReturnValue({ errors: ['claim gate'], warnings: [] });
    wireDb({ sends: { first: PROOFED_DRAFT } });
    const r = await maybeHandleProofApproval(APPROVAL_EMAIL);
    expect(r).toBe(true);
    expect(mockSendCampaign).not.toHaveBeenCalled();
    expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_blocked', expect.anything());
  });

  test('lost the atomic approval claim → no dispatch', async () => {
    wireDb({ sends: { first: PROOFED_DRAFT, update: 0 } });
    const r = await maybeHandleProofApproval(APPROVAL_EMAIL);
    expect(r).toBe(true);
    expect(mockSendCampaign).not.toHaveBeenCalled();
  });

  test('happy path: owner replies approved → claim + dispatch + notification (masked address)', async () => {
    const { sendsChain } = wireDb({ sends: { first: PROOFED_DRAFT } });
    const r = await maybeHandleProofApproval(APPROVAL_EMAIL);
    expect(r).toBe(true);
    expect(sendsChain.whereNull).toHaveBeenCalledWith('proof_approved_at');
    expect(sendsChain.update).toHaveBeenCalledWith(expect.objectContaining({
      proof_approved_at: expect.any(Date),
      proof_approval_email_id: 'email-1',
    }));
    expect(mockSendCampaign).toHaveBeenCalledWith('send-1');
    expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_approved', expect.objectContaining({
      approvedBy: 'co***@wavespestcontrol.com',
      recipientCount: 606,
    }));
  });
});

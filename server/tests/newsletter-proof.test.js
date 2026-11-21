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
const mockValidateEventSelection = jest.fn(async () => ({ valid: true, errors: [], flagship: true }));
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
  // Shared sweep-first preflight — countRecipients delegates here now.
  countSegmentRecipients: jest.fn(async () => 606),
  loadPersonalizationContext: jest.fn(async () => new Map()),
}));
jest.mock('../services/newsletter-validator', () => ({
  validateNewsletterDraft: mockValidate,
  lockedPricesForSend: jest.fn(async () => []),
}));
jest.mock('../services/newsletter-event-selection', () => ({
  validateFlagshipEventSelection: mockValidateEventSelection,
}));
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: mockTrigger,
}));
// The mailbox itself: the send-time HOLD check searches it for the FYI copy's token.
const mockListAllMessages = jest.fn(async () => ({ messages: [], truncated: false, nextPageToken: null }));
const mockGetMessage = jest.fn();
jest.mock('../services/email/gmail-client', () => ({
  listAllMessages: (...args) => mockListAllMessages(...args),
  getMessage: (...args) => mockGetMessage(...args),
}));
jest.mock('../services/email-template', () => ({
  wrapNewsletter: ({ body }) => `<wrapped>${body}</wrapped>`,
  bodyIsDarkAware: () => true,
  // The reaction footer is ensured on every proof body and neutralized by
  // applyTokens; its neutral render resolves colors through this palette.
  newsletterPalette: () => ({
    navy: '#04395E', blue: '#0A7EC2', gold: '#F4B014', muted: '#4F5B70',
    rule: '#D8E4EF', cardBg: '#F4F9FD', homeownerBg: '#E9F3FB',
  }),
}));

const db = require('../models/db');
const {
  parseProofToken,
  extractTopReplyText,
  htmlReplyToText,
  isApprovalReply,
  isHoldReply,
  maskEmail,
  sendNewsletterProof,
  maybeHandleProofApproval,
  approvalSenders,
  holdReplyOnRecord,
  fyiCopyDigest,
} = require('../services/newsletter-proof');

function chain(overrides = {}) {
  const q = {};
  ['where', 'whereRaw', 'whereNull', 'whereNotNull', 'whereIn', 'select', 'orderBy', 'limit', 'forUpdate']
    .forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => overrides.first);
  q.update = jest.fn(async () => (overrides.update !== undefined ? overrides.update : 1));
  q.count = jest.fn(() => q);
  Object.assign(q, overrides.extra || {});
  return q;
}

const DRAFT_VERSION = new Date('2026-07-09T17:00:00Z');
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
  updated_at: DRAFT_VERSION,
};

// Approval-ready fixture: proof stamped, no edits since (the proof write
// sets proof_sent_at === updated_at in one update).
const PROOF_STAMP = new Date('2026-07-09T18:00:00Z');
const PROOFED_DRAFT = { ...FLAGSHIP_DRAFT, proof_sent_at: PROOF_STAMP, updated_at: PROOF_STAMP };
const TARGET_SEND_AT = new Date('2026-07-21T10:00:00Z'); // Tuesday 6:00 AM EDT

function wireDb({ sends, subscribers, calendar, issues } = {}) {
  const sendsChain = chain(sends || {});
  const subsChain = chain(subscribers || { first: undefined });
  const calendarChain = chain(calendar || {
    first: { id: 'cal-1', week_of: '2026-07-21', target_send_at: TARGET_SEND_AT },
  });
  // pest_insider_issues: no planned issue unless a test links one.
  const issuesChain = chain(issues || { first: undefined });
  db.mockImplementation((table) => {
    if (table === 'newsletter_sends') return sendsChain;
    if (table === 'newsletter_calendar') return calendarChain;
    if (table === 'pest_insider_issues') return issuesChain;
    return subsChain;
  });
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  // A transaction reaches the same tables; a throw inside it rejects, as knex's does.
  db.transaction = jest.fn(async (work) => {
    const trx = (table) => db(table);
    trx.raw = (sql, bindings) => ({ sql, bindings });
    return work(trx);
  });
  return { sendsChain, subsChain, calendarChain, issuesChain };
}

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-07-20T12:00:00Z'));
  jest.clearAllMocks();
  process.env.GATE_NEWSLETTER_PROOF_APPROVAL = 'true';
  // Approvers are fail-closed (no default) — tests opt in explicitly.
  process.env.NEWSLETTER_PROOF_APPROVERS = 'contact@wavespestcontrol.com';
  delete process.env.NEWSLETTER_PROOF_EMAIL;
  delete process.env.GMAIL_USER_EMAIL;
  mockValidate.mockReturnValue({ errors: [], warnings: [] });
  mockValidateEventSelection.mockResolvedValue({ valid: true, errors: [], flagship: true });
  mockSendOne.mockImplementation(async () => ({ messageId: 'sg-proof-1' }));
});

afterEach(() => jest.useRealTimers());

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
    'approved? no', "approved — wait, don't send", 'approved... actually hold off',
    'approved but stop the send',
    'approved — actually cancel that', 'approved, abort',
    'approved. Nevermind.', 'approved; never mind',
    'approved — disregard that', 'approved, revoke it',
    'approved — don’t send yet', 'can’t approve yet', // smart apostrophes (iOS/macOS)
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
  test('drops single-quoted and bare class quote containers too', () => {
    const single = "<div dir='ltr'>needs changes</div><div class='gmail_quote'>On Thu wrote: Reply APPROVED to this email</div>";
    expect(htmlReplyToText(single)).not.toMatch(/APPROVED/);
    const bare = '<div>hold off</div><div class=yahoo_quoted>Reply APPROVED to this email</div>';
    expect(htmlReplyToText(bare)).not.toMatch(/APPROVED/);
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
    expect(args.subject).toBe(`ACT: [PROOF-${r.token}] Bubbles & Sea Lions`);
    // Reply must come back to the mailbox the Gmail sync watches
    expect(args.replyTo).toBe('contact@wavespestcontrol.com');
    // Internal control message — newsletter suppression must not apply
    expect(args.asmGroupId).toBeUndefined();
    expect(args.html).toContain('Reply <strong>APPROVED</strong>');
    expect(args.html).toContain('Tuesday at 6:00 AM ET');
    expect(args.html).toContain('606');
    // Claim is whereNull-guarded, version-guarded on the fetched row's
    // updated_at (ms-truncated raw compare — node-pg precision), and
    // stamps token+sent_at+updated_at together
    expect(sendsChain.whereNull).toHaveBeenCalledWith('proof_sent_at');
    expect(sendsChain.whereRaw).toHaveBeenCalledWith(
      expect.stringContaining("date_trunc('milliseconds', updated_at)"),
      [DRAFT_VERSION],
    );
    const claim = sendsChain.update.mock.calls[0][0];
    expect(claim.proof_token).toBe(r.token);
    expect(claim.proof_sent_at).toBeInstanceOf(Date);
    expect(claim.updated_at).toBe(claim.proof_sent_at);
    expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_sent', expect.objectContaining({
      recipientCount: 606,
      recipient: 'co***@wavespestcontrol.com',
    }));
  });

  test('a non-flagship (Pest Insider) proof discloses immediate delivery, never the Tuesday target', async () => {
    const pestInsiderDraft = {
      ...FLAGSHIP_DRAFT,
      newsletter_type: 'pest-insider-monthly',
      proof_token: null,
    };
    wireDb({ sends: { first: pestInsiderDraft } });
    const r = await sendNewsletterProof('send-1');
    expect(r.sent).toBe(true);
    const args = mockSendOne.mock.calls[0][0];
    expect(args.html).toContain('immediately');
    expect(args.html).not.toContain('Tuesday at 6:00 AM ET');
  });

  test('future-issue proof validates its lineup against the linked issue Tuesday', async () => {
    const futureTarget = new Date('2026-07-28T10:00:00Z');
    wireDb({
      sends: { first: { ...FLAGSHIP_DRAFT, proof_token: null } },
      calendar: { first: { id: 'cal-future', week_of: '2026-07-28', target_send_at: futureTarget } },
    });
    const result = await sendNewsletterProof('send-1');
    expect(result.sent).toBe(true);
    expect(mockValidateEventSelection).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'send-1' }),
      { reference: futureTarget },
    );
  });

  test('proof blocks a future Tuesday target that does not match its calendar week', async () => {
    wireDb({
      sends: { first: { ...FLAGSHIP_DRAFT, proof_token: null } },
      calendar: {
        first: {
          id: 'cal-mismatch',
          week_of: '2026-07-21',
          target_send_at: new Date('2026-07-28T10:00:00Z'),
        },
      },
    });
    const result = await sendNewsletterProof('send-1');
    expect(result.reason).toBe('calendar_target_invalid');
    expect(mockValidateEventSelection).not.toHaveBeenCalled();
    expect(mockSendOne).not.toHaveBeenCalled();
  });

  test('legacy draft with an ineligible locked lineup gets no proof', async () => {
    mockValidateEventSelection.mockResolvedValue({ valid: false, errors: ['Locked event is no longer eligible: Weekly Yoga.'], flagship: true });
    wireDb({ sends: { first: { ...FLAGSHIP_DRAFT, proof_token: null } } });
    const r = await sendNewsletterProof('send-1');
    expect(r.reason).toBe('event_selection_invalid');
    expect(mockSendOne).not.toHaveBeenCalled();
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

  test('an approval whose validation now fails releases the proof claim so the corrected draft gets a fresh proof (codex round 17 P2)', async () => {
    const stale = {
      ...PROOFED_DRAFT,
      newsletter_type: 'pest-insider-monthly',
      html_body: '<p>Termites swarm again after storms.</p>',
      text_body: 'Termites swarm again after storms.',
    };
    const { sendsChain } = wireDb({ sends: { first: stale }, subscribers: { count: 5 } });
    mockValidate.mockReturnValue({ errors: ['Unverified claim (termite_second_swarm): "Termites swarm again after storms"'], warnings: [] });
    const previousGate = process.env.GATE_PEST_INSIDER_PROOF;
    process.env.GATE_PEST_INSIDER_PROOF = 'true'; // the Pest Insider proof switch is on: the approval reaches validation
    let r;
    try {
      r = await maybeHandleProofApproval(APPROVAL_EMAIL);
    } finally {
      if (previousGate === undefined) delete process.env.GATE_PEST_INSIDER_PROOF; else process.env.GATE_PEST_INSIDER_PROOF = previousGate;
    }
    expect(r).toBe(true);
    expect(mockSendCampaign).not.toHaveBeenCalled();
    expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_blocked', expect.objectContaining({
      sendId: 'send-1', errors: expect.arrayContaining(['Approved, but validation now fails — nothing sent']),
    }));
    expect(sendsChain.where).toHaveBeenCalledWith({ id: 'send-1', proof_token: 'ab12cd34' });
    const release = sendsChain.update.mock.calls.find(([patch]) => patch && patch.proof_token === null && patch.proof_sent_at === null);
    expect(release).toBeTruthy();
    // a distinct durable refusal marker (proof_approval_email_id is not it: it survives a cancel)
    expect(release[0].proof_refused_at).toEqual(expect.any(Date));
    expect(release[0].proof_approval_email_id).toBeUndefined();
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

  test('HTML-only reply: typed approved schedules Tuesday 6 AM without immediate dispatch', async () => {
    const { sendsChain } = wireDb({ sends: { first: PROOFED_DRAFT } });
    const r = await maybeHandleProofApproval({
      ...APPROVAL_EMAIL,
      body_text: null,
      body_html: '<div dir="ltr">approved<br></div><div class="gmail_quote">On Thu wrote: Reply APPROVED…</div>',
    });
    expect(r).toBe(true);
    expect(sendsChain.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'scheduled',
      scheduled_for: TARGET_SEND_AT,
    }));
    expect(mockSendCampaign).not.toHaveBeenCalled();
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

  test('operator-scheduled future send is preserved — approval reply is a no-op', async () => {
    const { sendsChain } = wireDb({ sends: { first: { ...PROOFED_DRAFT, status: 'scheduled', scheduled_for: new Date('2026-07-12T12:00:00Z') } } });
    const r = await maybeHandleProofApproval(APPROVAL_EMAIL);
    expect(r).toBe(true);
    expect(sendsChain.update).not.toHaveBeenCalled();
    expect(mockSendCampaign).not.toHaveBeenCalled();
  });

  test('HTML entity apostrophes decode before negation matching', async () => {
    wireDb({ sends: { first: PROOFED_DRAFT } });
    const r = await maybeHandleProofApproval({
      ...APPROVAL_EMAIL,
      body_text: null,
      body_html: '<div dir="ltr">don&rsquo;t approve &#8212; can&#8217;t send yet</div>',
    });
    expect(r).toBe(true);
    expect(mockSendCampaign).not.toHaveBeenCalled();
  });

  describe('Pest Insider kill switch at approval time', () => {
    const INSIDER = { ...PROOFED_DRAFT, id: 'send-pi-1', newsletter_type: 'pest-insider-monthly', subject: 'Pest Insider — September' };

    afterEach(() => { delete process.env.GATE_PEST_INSIDER_PROOF; });

    test('gate off: an APPROVED reply is refused, nothing is claimed or sent, and the draft is untouched', async () => {
      delete process.env.GATE_PEST_INSIDER_PROOF;
      const { sendsChain } = wireDb({ sends: { first: INSIDER } });

      const r = await maybeHandleProofApproval(APPROVAL_EMAIL);

      expect(r).toBe(true);
      expect(sendsChain.update).not.toHaveBeenCalled();
      expect(mockSendCampaign).not.toHaveBeenCalled();
      expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_blocked', expect.objectContaining({
        errors: expect.arrayContaining([expect.stringContaining('Pest Insider proof approval is switched off')]),
      }));
    });

    test('gate off does not touch the weekly flagship', async () => {
      delete process.env.GATE_PEST_INSIDER_PROOF;
      const { sendsChain } = wireDb({ sends: { first: PROOFED_DRAFT } });

      await maybeHandleProofApproval(APPROVAL_EMAIL);

      expect(sendsChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'scheduled' }));
    });

    test('gate on: the approval is claimed and the issue dispatched', async () => {
      process.env.GATE_PEST_INSIDER_PROOF = 'true';
      mockValidateEventSelection.mockResolvedValue({ valid: true, errors: [], flagship: false });
      const { sendsChain } = wireDb({ sends: { first: INSIDER }, subscribers: { first: { count: 5 } } });

      const r = await maybeHandleProofApproval(APPROVAL_EMAIL);

      expect(r).toBe(true);
      expect(sendsChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'scheduled', proof_approved_at: expect.any(Date) }));
      // A Pest Insider approval never dispatches straight from here: the
      // scheduler tick re-reads the row, re-runs the gates and the validator
      // and only then hands it to the sender — a PATCH that lands right
      // after this approval has already returned the row to draft.
      expect(sendsChain.update).toHaveBeenCalledWith(expect.objectContaining({ scheduled_for: expect.any(Date) }));
      expect(mockSendCampaign).not.toHaveBeenCalled();
    });

    test('a reply that does not say approved is handled before the gate, with no blocked notice', async () => {
      delete process.env.GATE_PEST_INSIDER_PROOF;
      wireDb({ sends: { first: INSIDER } });

      await maybeHandleProofApproval({ ...APPROVAL_EMAIL, body_text: 'hold this one' });

      expect(mockTrigger).not.toHaveBeenCalledWith('newsletter_proof_blocked', expect.anything());
    });
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
    // the refusal marker is stamped here too, like every other refusal release
    expect(sendsChain.update).toHaveBeenCalledWith(expect.objectContaining({ proof_token: null, proof_refused_at: expect.any(Date) }));
  });

  test('validation failure at approval time blocks the send and notifies', async () => {
    mockValidate.mockReturnValue({ errors: ['claim gate'], warnings: [] });
    wireDb({ sends: { first: PROOFED_DRAFT } });
    const r = await maybeHandleProofApproval(APPROVAL_EMAIL);
    expect(r).toBe(true);
    expect(mockSendCampaign).not.toHaveBeenCalled();
    expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_blocked', expect.anything());
  });

  test('invalid or past calendar target leaves an approved draft unscheduled', async () => {
    const { sendsChain } = wireDb({
      sends: { first: PROOFED_DRAFT },
      calendar: { first: { id: 'cal-1', week_of: '2026-07-21', target_send_at: '2026-07-14T10:00:00Z' } },
    });
    const r = await maybeHandleProofApproval(APPROVAL_EMAIL);
    expect(r).toBe(true);
    expect(sendsChain.update).not.toHaveBeenCalled();
    expect(mockSendCampaign).not.toHaveBeenCalled();
    expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_blocked', expect.objectContaining({
      errors: expect.arrayContaining([expect.stringContaining('future issue Tuesday')]),
    }));
  });

  test('legacy recurring lineup is rechecked at approval, never scheduled, and its proof claim is released', async () => {
    mockValidateEventSelection.mockResolvedValue({ valid: false, errors: ['Locked event is no longer eligible: Weekly Yoga.'], flagship: true });
    const { sendsChain } = wireDb({ sends: { first: PROOFED_DRAFT } });
    expect(await maybeHandleProofApproval(APPROVAL_EMAIL)).toBe(true);
    expect(mockSendCampaign).not.toHaveBeenCalled();
    // The only write is the token-scoped claim release: nothing scheduled.
    expect(sendsChain.update).toHaveBeenCalledTimes(1);
    expect(sendsChain.where).toHaveBeenCalledWith({ id: 'send-1', proof_token: 'ab12cd34' });
    const [patch] = sendsChain.update.mock.calls[0];
    expect(patch).toEqual(expect.objectContaining({ proof_token: null, proof_sent_at: null, proof_refused_at: expect.any(Date) }));
    expect(patch).not.toHaveProperty('status');
    expect(patch).not.toHaveProperty('proof_approved_at');
  });

  test('a corrected lineup gets one fresh proof after an ineligible-lineup refusal (audit NEWS-07)', async () => {
    const row = { ...PROOFED_DRAFT };
    const { sendsChain } = wireDb({ sends: { first: row } });
    sendsChain.update.mockImplementation(async (patch) => { Object.assign(row, patch); return 1; });
    mockValidateEventSelection.mockResolvedValue({ valid: false, errors: ['Locked event is no longer eligible: Weekly Yoga.'], flagship: true });
    expect(await maybeHandleProofApproval(APPROVAL_EMAIL)).toBe(true);
    expect(row.proof_sent_at).toBeNull();
    expect(row.status).toBe('draft');

    // The lineup is corrected; the catch-up's proof retry now proofs it again.
    row.event_ids = ['replacement-event'];
    row.updated_at = new Date(PROOF_STAMP.getTime() + 60_000);
    mockValidateEventSelection.mockResolvedValue({ valid: true, errors: [], flagship: true });
    const retry = await sendNewsletterProof(row.id);
    expect(retry).toEqual(expect.objectContaining({ sent: true }));
    expect(mockSendOne).toHaveBeenCalledTimes(1);
  });

  test('lost the atomic approval claim → no dispatch', async () => {
    wireDb({ sends: { first: PROOFED_DRAFT, update: 0 } });
    const r = await maybeHandleProofApproval(APPROVAL_EMAIL);
    expect(r).toBe(true);
    expect(mockSendCampaign).not.toHaveBeenCalled();
  });

  test('happy path: owner approval queues the linked Tuesday 6 AM target', async () => {
    const { sendsChain, calendarChain } = wireDb({ sends: { first: PROOFED_DRAFT } });
    const r = await maybeHandleProofApproval(APPROVAL_EMAIL);
    expect(r).toBe(true);
    expect(sendsChain.whereNull).toHaveBeenCalledWith('proof_approved_at');
    expect(mockValidateEventSelection).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'send-1' }),
      { reference: TARGET_SEND_AT },
    );
    // Approval claim is version-guarded: token + status + updated_at
    expect(sendsChain.where).toHaveBeenCalledWith({
      id: 'send-1', proof_token: 'ab12cd34', status: 'draft',
    });
    expect(sendsChain.whereRaw).toHaveBeenCalledWith(
      expect.stringContaining("date_trunc('milliseconds', updated_at)"),
      [PROOF_STAMP],
    );
    // Crash-safe: the claim itself schedules the send at the calendar target.
    expect(sendsChain.update).toHaveBeenCalledWith(expect.objectContaining({
      proof_approved_at: expect.any(Date),
      proof_approval_email_id: 'email-1',
      proof_refused_at: null, // an approval clears any earlier refusal
      status: 'scheduled',
      scheduled_for: TARGET_SEND_AT,
    }));
    expect(calendarChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'scheduled' }));
    expect(mockSendCampaign).not.toHaveBeenCalled();
    expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_approved', expect.objectContaining({
      approvedBy: 'co***@wavespestcontrol.com',
      recipientCount: 606,
      scheduledFor: TARGET_SEND_AT.toISOString(),
    }));
  });
});

describe('GATE_NEWSLETTER_AUTO_SEND — the weekly issue sends itself (owner 2026-10-30, option A)', () => {
  const AUTO_QUEUED = {
    ...PROOFED_DRAFT,
    status: 'scheduled',
    scheduled_for: TARGET_SEND_AT,
    proof_approved_at: PROOF_STAMP,
    proof_approval_email_id: null,
  };
  const REPLY = {
    id: 'email-2',
    subject: 'Re: FYI: [PROOF-ab12cd34] Bubbles & Sea Lions',
    from_address: 'contact@wavespestcontrol.com',
    body_text: 'HOLD\n\nOn Mon wrote:\n> To skip this week, reply HOLD',
  };
  const SKIPPED_WEEK = { first: { id: 'cal-1', week_of: '2026-07-21', target_send_at: TARGET_SEND_AT, status: 'skipped' } };

  beforeEach(() => { process.env.GATE_NEWSLETTER_AUTO_SEND = 'true'; });
  afterAll(() => { delete process.env.GATE_NEWSLETTER_AUTO_SEND; });

  test('an issue that passes every check gets an FYI copy and is queued once the copy went out', async () => {
    const { sendsChain, calendarChain } = wireDb({ sends: { first: { ...FLAGSHIP_DRAFT, proof_token: null } } });
    const r = await sendNewsletterProof('send-1');
    expect(r).toEqual(expect.objectContaining({ sent: true, queued: true }));
    expect(sendsChain.where).toHaveBeenCalledWith({ id: 'send-1', status: 'draft' });
    // The claim stays a draft the dispatcher never picks up...
    const [[claim], [queue]] = sendsChain.update.mock.calls;
    expect(claim.proof_token).toBe(r.token);
    expect(claim.status).toBeUndefined();
    // ...and the issue is queued only after the copy went out, bound to the claim.
    expect(mockSendOne.mock.invocationCallOrder[0]).toBeLessThan(sendsChain.update.mock.invocationCallOrder[1]);
    expect(sendsChain.where).toHaveBeenCalledWith({ id: 'send-1', proof_token: r.token, status: 'draft' });
    expect(sendsChain.whereNull).toHaveBeenCalledWith('proof_approved_at');
    expect(sendsChain.whereRaw).toHaveBeenCalledWith(expect.stringContaining("date_trunc('milliseconds', updated_at)"), [claim.proof_sent_at]);
    expect(queue).toEqual(expect.objectContaining({
      status: 'scheduled',
      scheduled_for: TARGET_SEND_AT,
      proof_approved_at: expect.any(Date),
      proof_approval_email_id: null,
      proof_refused_at: null,
    }));
    expect(calendarChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'scheduled' }));
    const args = mockSendOne.mock.calls[0][0];
    expect(args.subject).toBe(`FYI: [PROOF-${r.token}] Bubbles & Sea Lions`);
    expect(args.html).toContain('Sends by itself');
    expect(args.html).toContain('reply <strong>HOLD</strong>');
    expect(args.html).not.toContain('Reply <strong>APPROVED</strong>');
    expect(args.text).toContain('reply HOLD');
    // No "reply APPROVED" bell: a queued issue needs no one.
    expect(mockTrigger).not.toHaveBeenCalledWith('newsletter_proof_sent', expect.anything());
  });

  test('a failed copy never queues the issue, and the claim is released so the catch-up retries', async () => {
    mockSendOne.mockImplementation(async () => { throw new Error('sendgrid 503'); });
    const { sendsChain, calendarChain } = wireDb({ sends: { first: { ...FLAGSHIP_DRAFT, proof_token: null } } });
    const r = await sendNewsletterProof('send-1');
    expect(r.reason).toBe('proof_send_failed');
    expect(sendsChain.update.mock.calls.some(([patch]) => patch.status === 'scheduled')).toBe(false);
    expect(sendsChain.update.mock.calls.at(-1)[0]).toEqual(expect.objectContaining({ proof_token: null, proof_sent_at: null }));
    expect(calendarChain.update).not.toHaveBeenCalled();
  });

  test('an issue that changed before it could be queued stays unqueued and the owner is told', async () => {
    const { sendsChain, calendarChain } = wireDb({ sends: { first: { ...FLAGSHIP_DRAFT, proof_token: null } } });
    sendsChain.update.mockResolvedValueOnce(1).mockResolvedValueOnce(0); // claim lands, queue finds the row changed
    const r = await sendNewsletterProof('send-1');
    expect(r).toEqual(expect.objectContaining({ sent: true, queued: false }));
    expect(calendarChain.update).not.toHaveBeenCalled();
    expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_blocked', expect.objectContaining({
      sendId: 'send-1',
      errors: ['The FYI copy went out, but the issue changed before it could be queued, so it will not send this week.'],
    }));
  });

  test('a failed check queues nothing and raises the alert that says why', async () => {
    mockValidate.mockReturnValue({ errors: ['hallucinated claim'], warnings: [] });
    const { sendsChain } = wireDb({ sends: { first: { ...FLAGSHIP_DRAFT, proof_token: null } } });
    const r = await sendNewsletterProof('send-1');
    expect(r.reason).toBe('validation_failed');
    expect(sendsChain.update).not.toHaveBeenCalled();
    expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_blocked', expect.objectContaining({ errors: ['hallucinated claim'] }));
  });

  test('a Pest Insider proof still waits for an APPROVED reply', async () => {
    const { sendsChain } = wireDb({ sends: { first: { ...FLAGSHIP_DRAFT, newsletter_type: 'pest-insider-monthly', proof_token: null } } });
    const r = await sendNewsletterProof('send-1');
    expect(r.queued).toBe(false);
    expect(sendsChain.update.mock.calls[0][0].status).toBeUndefined();
    expect(mockSendOne.mock.calls[0][0].subject).toMatch(/^ACT: /);
  });

  test('switch off: the weekly issue waits for APPROVED, as before', async () => {
    delete process.env.GATE_NEWSLETTER_AUTO_SEND;
    const { sendsChain } = wireDb({ sends: { first: { ...FLAGSHIP_DRAFT, proof_token: null } } });
    const r = await sendNewsletterProof('send-1');
    expect(r.queued).toBe(false);
    expect(sendsChain.update.mock.calls[0][0].status).toBeUndefined();
    expect(mockSendOne.mock.calls[0][0].subject).toMatch(/^ACT: /);
    expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_sent', expect.anything());
  });

  test('a skipped week gets no proof', async () => {
    wireDb({ sends: { first: { ...FLAGSHIP_DRAFT, proof_token: null } }, calendar: SKIPPED_WEEK });
    expect(await sendNewsletterProof('send-1')).toEqual({ skipped: true, reason: 'week_skipped' });
    expect(mockSendOne).not.toHaveBeenCalled();
  });

  test('HOLD stops an auto-queued issue and skips its week', async () => {
    const { sendsChain, calendarChain } = wireDb({ sends: { first: AUTO_QUEUED } });
    expect(await maybeHandleProofApproval(REPLY)).toBe(true);
    expect(sendsChain.where).toHaveBeenCalledWith({ id: 'send-1', proof_token: 'ab12cd34', status: 'scheduled' });
    expect(sendsChain.whereNull).toHaveBeenCalledWith('proof_approval_email_id');
    const hold = sendsChain.update.mock.calls[0][0];
    expect(hold).toEqual(expect.objectContaining({ status: 'draft', scheduled_for: null, proof_approved_at: null }));
    // The token goes, so a later reply on the thread can never approve the held issue.
    expect(hold.proof_token).toBeNull();
    // proof_sent_at stays: no catch-up proofs the held issue again.
    expect(hold).not.toHaveProperty('proof_sent_at');
    expect(calendarChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped' }));
    expect(mockSendCampaign).not.toHaveBeenCalled();
  });

  test('a reply with no hold word leaves the queued issue alone', async () => {
    const { sendsChain } = wireDb({ sends: { first: AUTO_QUEUED } });
    expect(await maybeHandleProofApproval({ ...REPLY, body_text: "Looks great, can't wait" })).toBe(true);
    expect(sendsChain.update).not.toHaveBeenCalled();
  });

  test('HOLD after the send was claimed changes nothing', async () => {
    const { sendsChain } = wireDb({ sends: { first: { ...AUTO_QUEUED, status: 'sending' } } });
    expect(await maybeHandleProofApproval(REPLY)).toBe(true);
    expect(sendsChain.update).not.toHaveBeenCalled();
  });

  test('HOLD does not touch an issue approved by an APPROVED reply', async () => {
    const { sendsChain } = wireDb({ sends: { first: { ...AUTO_QUEUED, proof_approval_email_id: 'email-1' } } });
    expect(await maybeHandleProofApproval(REPLY)).toBe(true);
    expect(sendsChain.update).not.toHaveBeenCalled();
  });

  test.each(['HOLD', 'hold please', 'Stop this one', 'skip this week', "don't send", 'don’t send', 'do not send it', 'cancel', 'pause'])(
    'isHoldReply accepts %j', (t) => expect(isHoldReply(t)).toBe(true),
  );
  test.each(['Looks great', "can't wait", 'approved', '', undefined])(
    'isHoldReply rejects %j', (t) => expect(isHoldReply(t)).toBe(false),
  );
});

describe('GATE_PEST_INSIDER_AUTO_SEND — a planned Waves Pest Insider issue sends itself', () => {
  // The clock is Mon Jul 20 2026; the next issue is Thursday Aug 6, 7:00 AM EDT.
  const ISSUE_SEND_AT = new Date('2026-08-06T11:00:00Z');
  const PI_DRAFT = { ...FLAGSHIP_DRAFT, newsletter_type: 'pest-insider-monthly', proof_token: null };
  const ISSUE = {
    id: 'issue-1', issue_date: '2026-08-06', status: 'drafted', send_id: 'send-1',
    fact_id: 'T03', species_slug: 'brown-widow', tool_id: null,
    diagnostics: { audience: { warm: 92, heldOut: 7, recipients: 85 } },
  };
  const PI_QUEUED = {
    ...PROOFED_DRAFT, newsletter_type: 'pest-insider-monthly', status: 'scheduled',
    scheduled_for: ISSUE_SEND_AT, proof_approved_at: PROOF_STAMP, proof_approval_email_id: null,
  };
  // The owner's reply from the synced mailbox itself, to its Reply-To (this mailbox): Gmail labels it SENT.
  const HOLD = {
    id: 'email-3',
    subject: 'Re: FYI: [PROOF-ab12cd34] Native termites can swarm in winter',
    from_address: 'contact@wavespestcontrol.com',
    to_address: 'contact@wavespestcontrol.com',
    body_text: 'hold',
    label_ids: ['SENT', 'INBOX'],
    authentication_results: null,
  };

  // A planned issue's FYI copy, as its text part went out (pestInsiderBannerText first).
  const COPY = 'SENDS BY ITSELF — NO REPLY NEEDED\nThis Waves Pest Insider issue goes to 85 readers. To skip this issue, reply HOLD by 6:30 AM ET that day.';

  // The write that records an address a copy of the FYI goes to, and the copy's text by digest (the
  // text it went out with), with its row, before the copy goes out.
  const recordedFyi = (address) => ({
    diagnostics: {
      sql: "coalesce(diagnostics, '{}'::jsonb) || jsonb_build_object("
        + "'fyiTo', coalesce(diagnostics->'fyiTo', '{}'::jsonb) || jsonb_build_object(?::text, true), "
        + "'fyiCopies', coalesce(diagnostics->'fyiCopies', '{}'::jsonb) || jsonb_build_object(?::text, true))",
      bindings: [address, fyiCopyDigest(mockSendOne.mock.calls.at(-1)[0].text)],
    },
  });

  beforeEach(() => { process.env.GATE_PEST_INSIDER_AUTO_SEND = 'true'; });
  afterAll(() => { delete process.env.GATE_PEST_INSIDER_AUTO_SEND; });

  test('a planned issue with no text body still sends its copy a text part, its banner, and records that part', async () => {
    const { issuesChain } = wireDb({ sends: { first: { ...PI_DRAFT, text_body: null } }, issues: { first: ISSUE } });
    expect(await sendNewsletterProof('send-1')).toEqual(expect.objectContaining({ sent: true }));
    const { text } = mockSendOne.mock.calls[0][0];
    expect(text).toMatch(/^SENDS BY ITSELF — NO REPLY NEEDED\n/);
    expect(issuesChain.update).toHaveBeenCalledWith(recordedFyi('contact@wavespestcontrol.com'));
  });

  test('its FYI copy goes out, and it is queued for its own Thursday 7:00 AM ET with its issue row', async () => {
    const { sendsChain, calendarChain, issuesChain } = wireDb({ sends: { first: PI_DRAFT }, issues: { first: ISSUE } });
    const r = await sendNewsletterProof('send-1');

    expect(r).toEqual(expect.objectContaining({ sent: true, queued: true }));
    expect(issuesChain.where).toHaveBeenCalledWith({ send_id: 'send-1' });
    const [, queue] = sendsChain.update.mock.calls.map(([patch]) => patch);
    expect(queue).toEqual(expect.objectContaining({ status: 'scheduled', scheduled_for: ISSUE_SEND_AT, proof_approval_email_id: null }));
    expect(issuesChain.whereIn).toHaveBeenCalledWith('status', ['drafted']);
    expect(issuesChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'scheduled' }));
    // The address the copy goes to is recorded with the row, while it is drafted and linked, before
    // the copy goes out: it may HOLD the issue.
    expect(issuesChain.where).toHaveBeenCalledWith({ send_id: 'send-1', status: 'drafted' });
    expect(issuesChain.update).toHaveBeenCalledWith(recordedFyi('contact@wavespestcontrol.com'));
    expect(issuesChain.update.mock.invocationCallOrder[0]).toBeLessThan(mockSendOne.mock.invocationCallOrder[0]);
    // The send and its issue row are queued in one transaction.
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(calendarChain.update).not.toHaveBeenCalled();

    const args = mockSendOne.mock.calls[0][0];
    expect(args.subject).toBe(`FYI: [PROOF-${r.token}] Bubbles & Sea Lions`);
    expect(args.html).toContain('This Waves Pest Insider issue goes to <strong>606</strong> readers <strong>Thursday, August 6 at 7:00 AM ET</strong>');
    // The HOLD deadline is half an hour before the send, so the send-time check can read the reply.
    expect(args.html).toContain('reply <strong>HOLD</strong> by 6:30 AM ET that day');
    expect(args.html).not.toContain('immediately');
    expect(args.text).toContain('This Waves Pest Insider issue goes to 606 readers Thursday, August 6 at 7:00 AM ET. To skip this issue, reply HOLD by 6:30 AM ET that day');
    // The internal panel says what the planner picked and who it goes to.
    expect(args.html).toContain('INTERNAL DIAGNOSTICS');
    expect(args.html).toContain('Fact T03 · What&#39;s this? brown-widow · Tool none'.replace('&#39;', "'"));
    expect(args.html).toContain('Readers: 85 (92 opened a Waves email in the last 90 days; 7 customers held out to measure the issue)');
    expect(mockTrigger).not.toHaveBeenCalledWith('newsletter_proof_sent', expect.anything());
  });

  test('a SendGrid error releases the claim but keeps its token: SendGrid may have accepted the copy, so a HOLD reply to it still names the issue', async () => {
    mockSendOne.mockImplementation(async () => { throw new Error('ETIMEDOUT'); });
    const { sendsChain } = wireDb({ sends: { first: PI_DRAFT }, issues: { first: ISSUE } });
    const r = await sendNewsletterProof('send-1');

    expect(r.reason).toBe('proof_send_failed');
    const release = sendsChain.update.mock.calls.at(-1)[0];
    expect(release).toEqual({ proof_sent_at: null, updated_at: expect.any(Date) });
  });

  test('a recipient record that fails sends nothing: the claim is released, its token kept', async () => {
    const { sendsChain, issuesChain } = wireDb({ sends: { first: PI_DRAFT }, issues: { first: ISSUE } });
    issuesChain.update.mockImplementationOnce(async () => { throw new Error('connection reset'); });
    const r = await sendNewsletterProof('send-1');

    expect(r.reason).toBe('proof_send_failed');
    expect(mockSendOne).not.toHaveBeenCalled();
    expect(sendsChain.update.mock.calls.at(-1)[0]).toEqual({ proof_sent_at: null, updated_at: expect.any(Date) });
  });

  test('an issue no longer drafted when its copy is about to go out (its draft deleted in History meanwhile, which holds it and clears its link) gets no copy: the record writes only a drafted issue linked to the send, finds none, and nothing goes out', async () => {
    const { sendsChain, issuesChain } = wireDb({ sends: { first: PI_DRAFT }, issues: { first: ISSUE, update: 0 } });
    const r = await sendNewsletterProof('send-1');

    expect(issuesChain.where).toHaveBeenCalledWith({ send_id: 'send-1', status: 'drafted' });
    expect(r.reason).toBe('proof_send_failed');
    expect(mockSendOne).not.toHaveBeenCalled();
    expect(sendsChain.update.mock.calls.at(-1)[0]).toEqual({ proof_sent_at: null, updated_at: expect.any(Date) });
  });

  test('its retry sends the token the failed attempt kept, so every copy of its FYI carries one token', async () => {
    const { sendsChain } = wireDb({ sends: { first: { ...PI_DRAFT, proof_token: 'AB12CD34' } }, issues: { first: ISSUE } });
    const r = await sendNewsletterProof('send-1');

    expect(r).toEqual(expect.objectContaining({ sent: true, token: 'ab12cd34', queued: true }));
    expect(sendsChain.update.mock.calls[0][0]).toEqual(expect.objectContaining({ proof_token: 'ab12cd34' }));
    expect(mockSendOne.mock.calls[0][0].subject).toBe('FYI: [PROOF-ab12cd34] Bubbles & Sea Lions');
  });

  test('an issue row that is no longer drafted rolls the queueing back, and the owner is told', async () => {
    // The send's queue update matches, but its issue row does not move: the transaction fails. (The
    // row was still drafted when the copy went out: its record, the first write, found it.)
    const { issuesChain } = wireDb({ sends: { first: PI_DRAFT }, issues: { first: ISSUE, update: 0 } });
    issuesChain.update.mockImplementationOnce(async () => 1);
    mockTrigger.mockResolvedValueOnce({ bellWritten: true });
    const r = await sendNewsletterProof('send-1');

    // `notified`: the alert about it reached the owner (the planner's last tick reads it).
    expect(r).toEqual(expect.objectContaining({ sent: true, queued: false, notified: true }));
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_blocked', expect.objectContaining({
      errors: ['The FYI copy went out, but the issue changed before it could be queued, so it will not send by itself.'],
    }));
  });

  test('switch off: a planned issue gets no proof at all (only ever an FYI copy), so the weekly switch cannot queue it either', async () => {
    delete process.env.GATE_PEST_INSIDER_AUTO_SEND;
    process.env.GATE_NEWSLETTER_AUTO_SEND = 'true';
    try {
      const { sendsChain, issuesChain } = wireDb({ sends: { first: PI_DRAFT }, issues: { first: ISSUE } });
      expect(await sendNewsletterProof('send-1')).toEqual({ skipped: true, reason: 'auto_send_off' });
      expect(mockSendOne).not.toHaveBeenCalled();
      expect(sendsChain.update).not.toHaveBeenCalled();
      expect(issuesChain.update).not.toHaveBeenCalled();
    } finally {
      delete process.env.GATE_NEWSLETTER_AUTO_SEND;
    }
  });

  test('a held issue gets no proof', async () => {
    wireDb({ sends: { first: PI_DRAFT }, issues: { first: { ...ISSUE, status: 'held' } } });
    expect(await sendNewsletterProof('send-1')).toEqual({ skipped: true, reason: 'issue_held' });
    expect(mockSendOne).not.toHaveBeenCalled();
  });

  test('an issue whose Thursday 7:00 AM ET has passed gets no proof, and the owner is told', async () => {
    wireDb({ sends: { first: PI_DRAFT }, issues: { first: { ...ISSUE, issue_date: '2026-07-16' } } });
    const r = await sendNewsletterProof('send-1');
    expect(r).toEqual(expect.objectContaining({ skipped: true, reason: 'issue_target_invalid' }));
    expect(mockSendOne).not.toHaveBeenCalled();
    expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_blocked', expect.objectContaining({
      errors: ['This Waves Pest Insider issue must go out on its own issue Thursday at 7:00 AM ET, and that time has passed.'],
    }));
  });

  test('a Pest Insider draft made by hand (no planned issue) keeps the old APPROVED path', async () => {
    const { issuesChain } = wireDb({ sends: { first: PI_DRAFT } });
    const r = await sendNewsletterProof('send-1');
    expect(r.queued).toBe(false);
    expect(mockSendOne.mock.calls[0][0].subject).toMatch(/^ACT: /);
    expect(issuesChain.update).not.toHaveBeenCalled();
  });

  // An FYI copy went out, but its queueing has not landed (or failed): a draft with a live token.
  const PI_FYI_DRAFT = { ...PI_DRAFT, proof_token: 'ab12cd34', proof_sent_at: PROOF_STAMP, updated_at: PROOF_STAMP };
  const APPROVED = { ...HOLD, id: 'email-4', body_text: 'approved' };

  test('an FYI address outside NEWSLETTER_PROOF_APPROVERS still gets its copy and queues the issue: the send-time check reads its HOLD', async () => {
    process.env.NEWSLETTER_PROOF_EMAIL = 'proofs@wavespestcontrol.com';
    const { issuesChain } = wireDb({ sends: { first: PI_DRAFT }, issues: { first: ISSUE } });

    expect(await sendNewsletterProof('send-1')).toEqual(expect.objectContaining({ sent: true, queued: true }));
    expect(mockSendOne.mock.calls[0][0].to).toBe('proofs@wavespestcontrol.com');
    expect(issuesChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'scheduled' }));
    expect(issuesChain.update).toHaveBeenCalledWith(recordedFyi('proofs@wavespestcontrol.com'));
  });

  test('HOLD before its queueing landed holds the planned row, and a send queued in between goes back to draft', async () => {
    const { sendsChain, issuesChain } = wireDb({ sends: { first: PI_FYI_DRAFT }, issues: { first: ISSUE } });
    expect(await maybeHandleProofApproval(HOLD)).toBe(true);

    // One transaction, the send row locked before the issue row: the queueing's order.
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(sendsChain.forUpdate.mock.invocationCallOrder[0]).toBeLessThan(issuesChain.update.mock.invocationCallOrder[0]);

    expect(issuesChain.whereIn).toHaveBeenCalledWith('status', ['drafted', 'scheduled']);
    expect(issuesChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'held', reason: 'HOLD reply from the owner' }));
    // Only a send the switch queued in between is touched: back to draft.
    expect(sendsChain.where).toHaveBeenCalledWith({ id: 'send-1', proof_token: 'ab12cd34', status: 'scheduled' });
    expect(sendsChain.whereNull).toHaveBeenCalledWith('proof_approval_email_id');
    expect(sendsChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft', scheduled_for: null, proof_approved_at: null }));
  });

  test('APPROVED never sends a planned issue at another time, and the owner is told the reply changed nothing', async () => {
    process.env.GATE_PEST_INSIDER_PROOF = 'true';
    try {
      const { sendsChain, issuesChain } = wireDb({ sends: { first: PI_FYI_DRAFT }, issues: { first: ISSUE } });
      expect(await maybeHandleProofApproval(APPROVED)).toBe(true);

      expect(sendsChain.update).not.toHaveBeenCalled();
      expect(issuesChain.update).not.toHaveBeenCalled();
      expect(mockSendCampaign).not.toHaveBeenCalled();
      expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_blocked', expect.objectContaining({
        errors: ['Approved, but an APPROVED reply does not send a Waves Pest Insider issue: it sends only by itself, on its Thursday at 7:00 AM ET, once it is queued. Nothing changed.'],
      }));
    } finally {
      delete process.env.GATE_PEST_INSIDER_PROOF;
    }
  });

  test.each([
    ['queued', () => PI_QUEUED],
    ['not queued yet', () => PI_FYI_DRAFT],
  ])('a HOLD whose writes fail (%s) changes nothing, and the owner is told to stop the issue by hand', async (_label, sendRow) => {
    // The reply is read once: the alert is the owner's only sign that the HOLD did not apply.
    const failing = jest.fn(async () => { throw new Error('connection reset'); });
    wireDb({ sends: { first: sendRow() }, issues: { first: ISSUE, extra: { update: failing } } });
    expect(await maybeHandleProofApproval(HOLD)).toBe(true);

    expect(failing).toHaveBeenCalledTimes(1);
    expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_blocked', expect.objectContaining({
      errors: ['The HOLD reply could not be applied (connection reset), so this issue may still send. To stop it, press Cancel schedule in Newsletter → History, or Delete if it shows as a draft.'],
    }));
  });

  test('a HOLD whose sender Gmail cannot verify (an approver address typed into a From line) holds nothing, and the owner is told once per send', async () => {
    const { sendsChain, issuesChain } = wireDb({ sends: { first: PI_QUEUED }, issues: { first: { ...ISSUE, status: 'scheduled' } } });
    expect(await maybeHandleProofApproval({ ...HOLD, label_ids: ['INBOX'], authentication_results: null })).toBe(true);

    expect(db.transaction).not.toHaveBeenCalled();
    expect(sendsChain.update).not.toHaveBeenCalled();
    expect(issuesChain.update).not.toHaveBeenCalled();
    expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_blocked', {
      sendId: 'send-1',
      subject: PI_QUEUED.subject,
      errors: ['A HOLD reply from co***@wavespestcontrol.com was ignored: Gmail could not verify that this address sent it, so this issue still sends. If you sent it, reply HOLD from the inbox the FYI copy reached, or press Cancel schedule in Newsletter → History'],
      outcome: true,
    }, { dedupeKey: 'pest-insider-unverified-hold:send-1' });
  });

  test("a HOLD from an approver's own mail server, which Gmail authenticated for its domain, holds the queued issue", async () => {
    process.env.NEWSLETTER_PROOF_APPROVERS = 'owner@example.com';
    const { issuesChain } = wireDb({ sends: { first: PI_QUEUED }, issues: { first: { ...ISSUE, status: 'scheduled' } } });
    expect(await maybeHandleProofApproval({
      ...HOLD, from_address: 'owner@example.com', label_ids: ['INBOX'],
      authentication_results: 'mx.google.com; dkim=pass header.i=@example.com header.s=s1 header.b=abc',
    })).toBe(true);
    expect(issuesChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'held', reason: 'HOLD reply from the owner' }));
  });

  test('an FYI address outside the approvers may HOLD the issue when Gmail verifies it, and is warned when not; its APPROVED stays ignored', async () => {
    process.env.NEWSLETTER_PROOF_APPROVERS = 'owner@example.com';
    const recorded = { ...ISSUE, status: 'scheduled', diagnostics: { fyiTo: { 'proofs@wavespestcontrol.com': true } } };
    const fromFyi = { ...HOLD, from_address: 'proofs@wavespestcontrol.com', label_ids: ['INBOX'] };
    const signed = 'mx.google.com; dkim=pass header.i=@wavespestcontrol.com header.s=s1 header.b=abc';

    let { issuesChain } = wireDb({ sends: { first: PI_QUEUED }, issues: { first: recorded } });
    expect(await maybeHandleProofApproval({ ...fromFyi, authentication_results: signed })).toBe(true);
    expect(issuesChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'held', reason: 'HOLD reply from the owner' }));

    ({ issuesChain } = wireDb({ sends: { first: PI_QUEUED }, issues: { first: recorded } }));
    expect(await maybeHandleProofApproval({ ...fromFyi, authentication_results: null })).toBe(true);
    expect(issuesChain.update).not.toHaveBeenCalled();
    expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_blocked', expect.objectContaining({ outcome: true }), { dedupeKey: 'pest-insider-unverified-hold:send-1' });

    ({ issuesChain } = wireDb({ sends: { first: PI_QUEUED }, issues: { first: recorded } }));
    expect(await maybeHandleProofApproval({ ...fromFyi, body_text: 'approved', authentication_results: signed })).toBe(false);
    expect(issuesChain.update).not.toHaveBeenCalled();
  });

  test('a HOLD from someone who may not hold it (a reader the copy was forwarded to) is ignored, with no warning', async () => {
    const { issuesChain } = wireDb({ sends: { first: PI_QUEUED }, issues: { first: { ...ISSUE, status: 'scheduled' } } });
    expect(await maybeHandleProofApproval({
      ...HOLD, from_address: 'neighbor@example.com', label_ids: ['INBOX'],
      authentication_results: 'mx.google.com; dkim=pass header.i=@example.com header.s=s1 header.b=abc',
    })).toBe(false);
    expect(issuesChain.update).not.toHaveBeenCalled();
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  test("the FYI copy itself, back in the synced inbox, holds nothing, also when its sender is set as an approver: it carries the token and the HOLD line", async () => {
    process.env.NEWSLETTER_PROOF_APPROVERS = `owner@example.com, ${PI_QUEUED.from_email}`;
    const { issuesChain } = wireDb({ sends: { first: PI_QUEUED }, issues: { first: { ...ISSUE, status: 'scheduled', diagnostics: { fyiCopies: { [fyiCopyDigest(COPY)]: true } } } } });
    expect(await maybeHandleProofApproval({
      ...HOLD, subject: HOLD.subject.slice(4), from_address: PI_QUEUED.from_email, label_ids: ['INBOX'],
      authentication_results: 'mx.google.com; dkim=pass header.i=@wavespestcontrol.com header.s=s1 header.b=abc',
      // As it arrives: the same words, its own line breaks, and a long line wrapped again mid-word.
      body_text: COPY.replace(/\n/g, '\r\n').replace('readers', 'read\r\ners'),
    })).toBe(true); // proof traffic: the sync skips classification and auto-actions for it
    expect(issuesChain.update).not.toHaveBeenCalled();
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  test("a reply that kept the copy's own subject, with HOLD typed inside the unquoted copy, holds the issue: it reads differently from the copy", async () => {
    const { issuesChain } = wireDb({ sends: { first: PI_QUEUED }, issues: { first: { ...ISSUE, status: 'scheduled', diagnostics: { fyiCopies: { [fyiCopyDigest(COPY)]: true } } } } });
    expect(await maybeHandleProofApproval({
      ...HOLD, subject: HOLD.subject.slice(4), body_text: COPY.replace('\n', '\nHOLD\n'),
    })).toBe(true);
    expect(issuesChain.update).toHaveBeenCalled();
  });

  test("a reply from the FYI copy's own sender, set as an approver, still holds the issue: only the copy itself is left out", async () => {
    process.env.NEWSLETTER_PROOF_APPROVERS = `owner@example.com, ${PI_QUEUED.from_email}`;
    const { issuesChain } = wireDb({ sends: { first: PI_QUEUED }, issues: { first: { ...ISSUE, status: 'scheduled' } } });
    expect(await maybeHandleProofApproval({
      ...HOLD, from_address: PI_QUEUED.from_email, label_ids: ['INBOX'],
      authentication_results: 'mx.google.com; dkim=pass header.i=@wavespestcontrol.com header.s=s1 header.b=abc',
    })).toBe(true);
    expect(issuesChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'held', reason: 'HOLD reply from the owner' }));
  });

  test('a forward of its FYI copy holds nothing, even from a verified sender with a hold word in its note: the owner is told once that only a reply holds', async () => {
    const { issuesChain } = wireDb({ sends: { first: PI_QUEUED }, issues: { first: { ...ISSUE, status: 'scheduled' } } });
    expect(await maybeHandleProofApproval({ ...HOLD, subject: `Fwd: ${HOLD.subject.slice(4)}`, body_text: 'please hold this for review' })).toBe(true);
    expect(issuesChain.update).not.toHaveBeenCalled();
    expect(mockTrigger).toHaveBeenCalledWith('newsletter_proof_blocked', expect.objectContaining({
      outcome: true, errors: [expect.stringContaining('only a reply to the FYI copy holds it, so this issue still sends')],
    }), { dedupeKey: 'pest-insider-forwarded-hold:send-1' });
  });

  test('a reply to a forwarded copy of its FYI (Re: Fwd:) is a reply, and holds the issue', async () => {
    const { issuesChain } = wireDb({ sends: { first: PI_QUEUED }, issues: { first: { ...ISSUE, status: 'scheduled' } } });
    expect(await maybeHandleProofApproval({ ...HOLD, subject: `Re: Fwd: ${HOLD.subject.slice(4)}` })).toBe(true);
    expect(issuesChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'held', reason: 'HOLD reply from the owner' }));
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  test('HOLD holds the queued issue and its planned row, in one transaction', async () => {
    const { sendsChain, issuesChain } = wireDb({ sends: { first: PI_QUEUED } });
    expect(await maybeHandleProofApproval(HOLD)).toBe(true);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(sendsChain.update.mock.calls[0][0]).toEqual(expect.objectContaining({ status: 'draft', scheduled_for: null }));
    expect(issuesChain.where).toHaveBeenCalledWith({ send_id: 'send-1' });
    expect(issuesChain.whereIn).toHaveBeenCalledWith('status', ['drafted', 'scheduled']);
    expect(issuesChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'held', reason: 'HOLD reply from the owner' }));
  });
});

describe('the send-time HOLD check (a planned issue at 7:00 AM ET)', () => {
  // Drafted by the 7:00 AM planner tick; its FYI copy went out again at 1:05 PM (a retry keeps the token).
  const SEND = {
    id: 'send-1', proof_token: 'ab12cd34', created_at: new Date('2026-08-05T11:00:00Z'), proof_sent_at: new Date('2026-08-05T17:05:00Z'),
    from_email: 'newsletter@news.wavespestcontrol.com',
  };
  const FYI_SUBJECT = 'FYI: [PROOF-ab12cd34] Native termites can swarm in winter';
  // The owner's reply from the synced mailbox itself, to its Reply-To (this mailbox): Gmail labels it SENT.
  const reply = (fields) => ({
    from_address: 'contact@wavespestcontrol.com', to_address: 'Waves Pest Control <contact@wavespestcontrol.com>', cc_address: '', bcc_address: '',
    subject: `Re: ${FYI_SUBJECT}`, body_text: 'hold', body_html: null, label_ids: ['SENT', 'INBOX'], authentication_results: null, ...fields,
  });
  // A reply that arrived from another mail server, with Gmail's own verdict on it.
  const received = (from, authentication_results, fields = {}) => reply({ from_address: from, label_ids: ['INBOX'], authentication_results, ...fields });
  const signedBy = (domain) => `mx.google.com; dkim=pass header.i=@${domain} header.s=s1 header.b=abc; spf=pass smtp.mailfrom=bounce@${domain}`;
  // The search starts an hour before the draft, not at the latest copy: a HOLD to an earlier copy counts.
  const SINCE = new Date('2026-08-05T10:00:00Z');

  // Two witnesses: the stored inbox (emails) and the mailbox itself (a Gmail search, then each message).
  function wireMailbox({ stored = [], searched = [], truncated = false } = {}) {
    const emails = { where: jest.fn(() => emails), select: jest.fn(async () => stored) };
    db.mockImplementation(() => emails);
    mockListAllMessages.mockImplementation(async () => ({ messages: searched.map((_, i) => ({ id: `gm-${i}` })), truncated, nextPageToken: null }));
    mockGetMessage.mockImplementation(async (id) => searched[Number(id.slice(3))]);
    return { emails };
  }

  test('a HOLD the inbox sync stored stops the issue, read from mail since about the draft (every copy of its FYI), with no mailbox search', async () => {
    const { emails } = wireMailbox({ stored: [reply({ body_text: 'HOLD' })] });
    expect(await holdReplyOnRecord(SEND)).toBe(true);
    expect(emails.where).toHaveBeenCalledWith('subject', 'ilike', '%[PROOF-ab12cd34]%');
    expect(emails.where).toHaveBeenCalledWith('received_at', '>=', SINCE);
    expect(mockListAllMessages).not.toHaveBeenCalled();
  });

  test('a HOLD the inbox sync never stored is found in the mailbox itself: a Gmail search for the token since the draft', async () => {
    wireMailbox({ searched: [received('newsletter@news.wavespestcontrol.com', null, { subject: FYI_SUBJECT }), reply({ body_text: 'HOLD please' })] });
    expect(await holdReplyOnRecord(SEND)).toBe(true);
    // Spam and Trash too: a HOLD the spam filter moved, or one deleted after it was sent, still holds.
    expect(mockListAllMessages).toHaveBeenCalledWith(`subject:"PROOF-ab12cd34" after:${SINCE.getTime() / 1000}`, 50, { includeSpamTrash: true });
    expect(mockGetMessage.mock.calls.map(([id]) => id)).toEqual(['gm-0', 'gm-1']);
  });

  test.each([
    ['Gmail is not connected', () => mockListAllMessages.mockImplementation(async () => { throw new Error('Gmail not connected. Please authorize via OAuth.'); }), 'Gmail not connected'],
    ['more messages carry the token than the search reads', () => mockListAllMessages.mockImplementation(async () => ({ messages: [], truncated: true })), 'more than 50 messages'],
  ])('a mailbox it cannot read in full throws, so the send waits for the next tick: %s', async (_label, fail, message) => {
    wireMailbox();
    fail();
    await expect(holdReplyOnRecord(SEND)).rejects.toThrow(message);
  });

  test("the owner's own HOLD archived before the sync read it (Send & Archive: SENT, no INBOX) still counts, stored as outbound or found by the search", async () => {
    const archived = reply({ label_ids: ['SENT'] });
    wireMailbox({ stored: [{ ...archived, auto_action: 'outbound_skipped' }] });
    expect(await holdReplyOnRecord(SEND)).toBe(true);
    wireMailbox({ searched: [archived] });
    expect(await holdReplyOnRecord(SEND)).toBe(true);
  });

  test("a HOLD from an approver counts when Gmail authenticated it for the approver's domain", async () => {
    process.env.NEWSLETTER_PROOF_APPROVERS = 'owner@example.com';
    wireMailbox({ searched: [received('Owner@Example.com', signedBy('example.com'))] });
    expect(await holdReplyOnRecord(SEND)).toBe(true);
  });

  test.each(['proofs@wavespestcontrol.com', 'office@wavespestcontrol.com'])('every address a copy of its FYI went to may HOLD it, as recorded with the issue, also after the proof address changed: %s', async (address) => {
    process.env.NEWSLETTER_PROOF_APPROVERS = 'owner@example.com';
    process.env.NEWSLETTER_PROOF_EMAIL = 'new-proofs@wavespestcontrol.com';
    // Its first copy went to proofs@; the retry, after the proof address changed, to office@.
    const issue = { diagnostics: { fyiTo: { 'proofs@wavespestcontrol.com': true, 'office@wavespestcontrol.com': true } } };
    wireMailbox({ searched: [received(address, signedBy('wavespestcontrol.com'))] });
    expect(await holdReplyOnRecord(SEND, issue)).toBe(true);
    // With no recorded address, only the current proof address may HOLD.
    expect(await holdReplyOnRecord(SEND, null)).toBe(false);
  });

  test.each([
    ['an approver address typed into the From line of mail Gmail did not authenticate', received('contact@wavespestcontrol.com', null)],
    ["an approver address on mail Gmail authenticated for another domain", received('contact@wavespestcontrol.com', signedBy('evil.example'))],
    ['someone the FYI copy was forwarded to (neither an approver nor the FYI address)', received('neighbor@example.com', signedBy('example.com'))],
    ['a Gmail draft (never sent)', reply({ label_ids: ['DRAFT'] })],
    ['a forward this mailbox sent to someone else (this mailbox only in its display name)', reply({ label_ids: ['SENT'], to_address: '"contact@wavespestcontrol.com" <neighbor@example.com>' })],
    ['the FYI copy itself (it quotes the HOLD line, and the newsletter address cannot HOLD)', received('newsletter@news.wavespestcontrol.com', signedBy('news.wavespestcontrol.com'), { subject: FYI_SUBJECT, body_text: 'To skip this issue, reply HOLD by 6:30 AM ET that day' })],
    ['an APPROVED reply that only quotes the HOLD line', reply({ body_text: 'approved\n\nOn Wed, Aug 5 wrote:\n> To skip this issue, reply HOLD by 6:30 AM ET that day' })],
    ['a reply whose subject carries a different token that only starts the same', reply({ subject: 'Re: FYI: [PROOF-ab12cd34x] other' })],
    ['a forward of the FYI copy this mailbox sent to itself, with a note that says hold', reply({ subject: `Fwd: ${FYI_SUBJECT}`, body_text: 'please hold this for review' })],
    ['a forward of the FYI copy from an approver Gmail authenticated', received('contact@wavespestcontrol.com', signedBy('wavespestcontrol.com'), { subject: `FW: ${FYI_SUBJECT}`, body_text: 'hold for review' })],
  ])('not a HOLD, in either witness: %s', async (_label, email) => {
    wireMailbox({ stored: [email], searched: [email] });
    expect(await holdReplyOnRecord(SEND)).toBe(false);
  });

  // The copy's own text opens with its banner (pestInsiderBannerText); its row records it as it goes out.
  const FYI_COPY_TEXT = 'SENDS BY ITSELF — NO REPLY NEEDED\nThis Waves Pest Insider issue goes to 85 readers Thursday, August 6 at 7:00 AM ET. To skip this issue, reply HOLD by 6:30 AM ET that day, or press Cancel schedule in Newsletter → History.';
  const RECORDED_COPY = { diagnostics: { fyiCopies: { [fyiCopyDigest(FYI_COPY_TEXT)]: true } } };
  test.each([
    ['its sender set as an approver', () => { process.env.NEWSLETTER_PROOF_APPROVERS = 'owner@example.com, Newsletter@news.wavespestcontrol.com'; }, null, 'newsletter@news.wavespestcontrol.com', 'news.wavespestcontrol.com'],
    ['its sender set as the proof address', () => { process.env.NEWSLETTER_PROOF_EMAIL = 'newsletter@news.wavespestcontrol.com'; }, null, 'newsletter@news.wavespestcontrol.com', 'news.wavespestcontrol.com'],
    ['its sender recorded as an address a copy went to', () => {}, { diagnostics: { fyiTo: { 'newsletter@news.wavespestcontrol.com': true } } }, 'newsletter@news.wavespestcontrol.com', 'news.wavespestcontrol.com'],
    ['relayed by a group at the address it went to, under that address', () => {}, { diagnostics: { fyiTo: { 'proofs@wavespestcontrol.com': true } } }, 'proofs@wavespestcontrol.com', 'wavespestcontrol.com'],
  ])("the FYI copy itself is not a HOLD, in either witness, also with %s: it carries the token and the HOLD line", async (_label, configure, issue, from, domain) => {
    configure();
    // As stored (the emails row has no In-Reply-To column) and as the Gmail search parses it (null: absent).
    const copy = received(from, signedBy(domain), { subject: FYI_SUBJECT, body_text: FYI_COPY_TEXT });
    wireMailbox({ stored: [copy], searched: [{ ...copy, in_reply_to: null }] });
    const recorded = { ...issue, diagnostics: { ...issue?.diagnostics, fyiCopies: { [fyiCopyDigest(FYI_COPY_TEXT)]: true } } };
    expect(await holdReplyOnRecord(SEND, recorded)).toBe(false);
  });

  test("a reply from the FYI copy's own sender, set as an approver, still holds: only the copy itself is left out", async () => {
    process.env.NEWSLETTER_PROOF_APPROVERS = 'owner@example.com, newsletter@news.wavespestcontrol.com';
    wireMailbox({ searched: [received('newsletter@news.wavespestcontrol.com', signedBy('news.wavespestcontrol.com'), { body_text: `HOLD\n\n> ${FYI_COPY_TEXT}` })] });
    expect(await holdReplyOnRecord(SEND)).toBe(true);
  });

  test("a reply whose sender removed the reply prefix still holds: its own words are on top, the copy quoted below", async () => {
    process.env.NEWSLETTER_PROOF_APPROVERS = 'owner@example.com';
    const quoted = `HOLD please\n\nOn Wed, Aug 5, 2026 at 1:05 PM Waves <newsletter@news.wavespestcontrol.com> wrote:\n> ${FYI_COPY_TEXT.split('\n').join('\n> ')}`;
    wireMailbox({ searched: [received('owner@example.com', signedBy('example.com'), { subject: FYI_SUBJECT, body_text: quoted })] });
    expect(await holdReplyOnRecord(SEND)).toBe(true);
  });

  test.each([
    ['the copy pasted under it with no quote marks', (copy) => `HOLD\n\n${copy}`],
    ['the copy under an attribution line in another language', (copy) => `HOLD\n\nAm Mi., 5. Aug. 2026 um 13:05 schrieb Waves <newsletter@news.wavespestcontrol.com>:\n${copy}`],
  ])("a reply that kept the copy's own subject holds when its sender's words open it, with %s", async (_shape, body) => {
    process.env.NEWSLETTER_PROOF_APPROVERS = 'owner@example.com';
    wireMailbox({ searched: [received('owner@example.com', signedBy('example.com'), { subject: FYI_SUBJECT, body_text: body(FYI_COPY_TEXT) })] });
    expect(await holdReplyOnRecord(SEND)).toBe(true);
  });

  test.each([
    ['as stored', (reply) => ({ stored: [reply] })],
    ['as the Gmail search parses it, with no In-Reply-To', (reply) => ({ searched: [{ ...reply, in_reply_to: null }] })],
  ])("a reply that kept the copy's own subject, with HOLD typed under the banner heading in an unquoted copy, holds %s: it reads differently from the copy", async (_witness, mailbox) => {
    process.env.NEWSLETTER_PROOF_APPROVERS = 'owner@example.com';
    const [heading, ...rest] = FYI_COPY_TEXT.split('\n');
    const inline = [heading, 'HOLD', ...rest].join('\n');
    wireMailbox(mailbox(received('owner@example.com', signedBy('example.com'), { subject: FYI_SUBJECT, body_text: inline })));
    expect(await holdReplyOnRecord(SEND, RECORDED_COPY)).toBe(true);
  });

  test.each([
    ['changed on its way (a relay footer)', `${FYI_COPY_TEXT}\n\n--\nYou received this message because you are subscribed to a group.`, () => RECORDED_COPY],
    ['that its row never recorded', FYI_COPY_TEXT, () => null],
  ])('a copy %s is read for a HOLD: that can only hold the issue, never send it', async (_label, text, issue) => {
    process.env.NEWSLETTER_PROOF_APPROVERS = 'owner@example.com, newsletter@news.wavespestcontrol.com';
    wireMailbox({ searched: [received('newsletter@news.wavespestcontrol.com', signedBy('news.wavespestcontrol.com'), { subject: FYI_SUBJECT, body_text: text })] });
    expect(await holdReplyOnRecord(SEND, issue())).toBe(true);
  });

  test('a reply to a forwarded copy of the FYI (Re: Fwd:) is a reply: its HOLD stops the issue', async () => {
    wireMailbox({ searched: [reply({ subject: `Re: Fwd: ${FYI_SUBJECT}`, body_text: 'HOLD' })] });
    expect(await holdReplyOnRecord(SEND)).toBe(true);
  });

  test.each([null, '', 'ab12cd34" OR in:anywhere'])('a send with no valid FYI token (%p) throws before it reads anything: it never answers "no HOLD" unread', async (token) => {
    const { emails } = wireMailbox();
    await expect(holdReplyOnRecord({ ...SEND, proof_token: token })).rejects.toThrow('its FYI copy has no valid token');
    expect(emails.select).not.toHaveBeenCalled();
    expect(mockListAllMessages).not.toHaveBeenCalled();
  });
});

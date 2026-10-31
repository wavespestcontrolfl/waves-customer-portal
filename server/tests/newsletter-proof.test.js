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
} = require('../services/newsletter-proof');

function chain(overrides = {}) {
  const q = {};
  ['where', 'whereRaw', 'whereNull', 'whereNotNull', 'whereIn', 'select', 'orderBy', 'limit']
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

function wireDb({ sends, subscribers, calendar } = {}) {
  const sendsChain = chain(sends || {});
  const subsChain = chain(subscribers || { first: undefined });
  const calendarChain = chain(calendar || {
    first: { id: 'cal-1', week_of: '2026-07-21', target_send_at: TARGET_SEND_AT },
  });
  db.mockImplementation((table) => {
    if (table === 'newsletter_sends') return sendsChain;
    if (table === 'newsletter_calendar') return calendarChain;
    return subsChain;
  });
  return { sendsChain, subsChain, calendarChain };
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

  test('an issue that passes every check is queued in the proof claim and the copy is FYI', async () => {
    const { sendsChain, calendarChain } = wireDb({ sends: { first: { ...FLAGSHIP_DRAFT, proof_token: null } } });
    const r = await sendNewsletterProof('send-1');
    expect(r).toEqual(expect.objectContaining({ sent: true, queued: true }));
    expect(sendsChain.where).toHaveBeenCalledWith({ id: 'send-1', status: 'draft' });
    const claim = sendsChain.update.mock.calls[0][0];
    expect(claim).toEqual(expect.objectContaining({
      proof_token: r.token,
      status: 'scheduled',
      scheduled_for: TARGET_SEND_AT,
      proof_approval_email_id: null,
      proof_refused_at: null,
    }));
    expect(claim.proof_approved_at).toBe(claim.proof_sent_at);
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

  test('a failed copy takes the issue off the queue so the catch-up retries', async () => {
    mockSendOne.mockImplementation(async () => { throw new Error('sendgrid 503'); });
    const { sendsChain, calendarChain } = wireDb({ sends: { first: { ...FLAGSHIP_DRAFT, proof_token: null } } });
    const r = await sendNewsletterProof('send-1');
    expect(r.reason).toBe('proof_send_failed');
    expect(sendsChain.where).toHaveBeenCalledWith(expect.objectContaining({ id: 'send-1', status: 'scheduled' }));
    expect(sendsChain.update.mock.calls.at(-1)[0]).toEqual(expect.objectContaining({
      proof_token: null, proof_sent_at: null, status: 'draft', scheduled_for: null, proof_approved_at: null,
    }));
    expect(calendarChain.update.mock.calls.at(-1)[0]).toEqual(expect.objectContaining({ status: 'drafted' }));
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

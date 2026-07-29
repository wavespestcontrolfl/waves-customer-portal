/**
 * Email-reply approval loop for parked autonomous content runs
 * (owner directive 2026-07-28: approvals via contact@ inbox replies).
 *
 * Trust boundary under test: token in subject × sender allowlist ×
 * unambiguous first-line decision — everything else fails closed.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

jest.mock('../services/content/autonomous-review-queue', () => ({ decideReviewItem: jest.fn() }));

const approvals = require('../services/content/email-approvals');
const { parseDecision, extractReplyText, isApprovableKind, newToken, allowedSenders, approvalRecipient, imapMailbox, TOKEN_RE, SAFE_RETRY_ERROR_RE, AMBIGUOUS_ERROR_RE } = approvals._internals;

describe('parseDecision — first non-quoted line decides, fail-closed otherwise', () => {
  test('plain approvals and rejections', () => {
    expect(parseDecision('approved')).toBe('approved');
    expect(parseDecision('Approved!')).toBe('approved');
    expect(parseDecision('  APPROVED — looks good')).toBe('approved');
    expect(parseDecision('not approved')).toBe('rejected');
    expect(parseDecision('Not Approved - competitor angle too aggressive')).toBe('rejected');
    expect(parseDecision('not-approved')).toBe('rejected');
  });

  test('"not approved" is never misread as "approved"', () => {
    expect(parseDecision('not approved')).toBe('rejected');
    expect(parseDecision('NOT  APPROVED')).toBe('rejected');
  });

  test('quoted trails and signatures never decide', () => {
    // The quoted original contains the instructions — must not self-approve.
    expect(parseDecision('> Reply with exactly one of:\n> approved\n> not approved')).toBe(null);
    expect(parseDecision('\n\n> approved')).toBe(null);
    // Owner text first, quote after: owner line wins.
    expect(parseDecision('approved\n\n> Reply with exactly one of: approved')).toBe('approved');
  });

  test('ambiguous first lines fail closed', () => {
    expect(parseDecision('looks good to me')).toBe(null);
    expect(parseDecision('is this the TruGreen one? approved')).toBe(null);
    expect(parseDecision('please approve')).toBe(null);
    expect(parseDecision('')).toBe(null);
    expect(parseDecision('approval pending')).toBe(null); // approved\b — "approval" must not match
  });

  test('conditional approvals fail closed — only benign trailers approve (Codex r5 P1)', () => {
    expect(parseDecision('approved, but fix the price first')).toBe(null);
    expect(parseDecision('approved with one change')).toBe(null);
    expect(parseDecision('approved — don’t publish yet')).toBe(null); // curly apostrophe
    expect(parseDecision('approved if the guarantee wording is fixed')).toBe(null);
    expect(parseDecision('approved for now')).toBe(null);
    // Benign trailers still approve.
    expect(parseDecision('approved, thanks!')).toBe('approved');
    expect(parseDecision('Approved — looks good to me')).toBe('approved');
    expect(parseDecision('approved 👍')).toBe('approved');
  });

  test('a contradicted approval prefix never approves (Codex r4 P1)', () => {
    expect(parseDecision('approved? no')).toBe(null);
    expect(parseDecision('approved — actually not approved')).toBe(null);
    expect(parseDecision('approved… wait, hold on')).toBe(null);
    expect(parseDecision('approved unless the price changed')).toBe(null);
    expect(parseDecision('Approved, do not delay')).toBe(null);
    // Clean approvals still work.
    expect(parseDecision('approved')).toBe('approved');
    expect(parseDecision('Approved — looks good')).toBe('approved');
    expect(parseDecision('APPROVED, ship it')).toBe('approved');
  });

  test('the "On … wrote:" quote header stops the scan', () => {
    expect(parseDecision('On Mon, Jul 28, 2026 Waves wrote:\napproved')).toBe(null);
  });
});

describe('extractReplyText — MIME decoding', () => {
  test('multipart: prefers the text/plain part and decodes quoted-printable', () => {
    const raw = [
      'Content-Type: multipart/alternative; boundary="b1"', '',
      '--b1', 'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: quoted-printable', '',
      'approved =E2=80=94 ship it', '',
      '--b1', 'Content-Type: text/html; charset=UTF-8', '',
      '<div><b>approved</b></div>', '--b1--',
    ].join('\r\n');
    expect(parseDecision(extractReplyText(raw))).toBe('approved');
  });

  test('multipart: decodes a base64 text/plain part', () => {
    const b64 = Buffer.from('not approved\n', 'utf8').toString('base64');
    const raw = [
      'Content-Type: multipart/alternative; boundary="xYz"', '',
      '--xYz', 'Content-Type: text/plain', 'Content-Transfer-Encoding: base64', '',
      b64, '--xYz--',
    ].join('\r\n');
    expect(parseDecision(extractReplyText(raw))).toBe('rejected');
  });

  test('single-part HTML falls back to tag-stripped text', () => {
    const raw = 'Content-Type: text/html\r\n\r\n<div>approved</div>';
    expect(parseDecision(extractReplyText(raw))).toBe('approved');
  });

  test('single-part base64 body decodes before parsing (Codex r1)', () => {
    const b64 = Buffer.from('approved\n', 'utf8').toString('base64');
    const raw = `Content-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64}`;
    expect(parseDecision(extractReplyText(raw))).toBe('approved');
  });

  test('nested multipart/mixed wrapping multipart/alternative resolves the text/plain leaf (Codex r1)', () => {
    // Normal shape for a reply carrying an inline signature image.
    const raw = [
      'Content-Type: multipart/mixed; boundary="outer"', '',
      '--outer', 'Content-Type: multipart/alternative; boundary="inner"', '',
      '--inner', 'Content-Type: text/plain; charset=UTF-8', '',
      'not approved', '',
      '--inner', 'Content-Type: text/html', '',
      '<b>not approved</b>', '--inner--', '',
      '--outer', 'Content-Type: image/png; name="sig.png"', 'Content-Transfer-Encoding: base64', '',
      'iVBORw0KGgo=', '--outer--',
    ].join('\r\n');
    expect(parseDecision(extractReplyText(raw))).toBe('rejected');
  });
});

describe('token + kind + sender guards', () => {
  test('tokens are EA-8hex and the subject matcher finds them anywhere in a Re: chain', () => {
    const t = newToken();
    expect(t).toMatch(/^EA-[0-9a-f]{8}$/);
    expect(`Re: [${t}] Approve? Some Title`.match(TOKEN_RE)[0]).toBe(t);
    expect('Re: no token here'.match(TOKEN_RE)).toBe(null);
  });

  test('only the two scripted-approve kinds are emailable', () => {
    expect(isApprovableKind('named_competitor_review')).toBe(true);
    expect(isApprovableKind('trust_build_2_of_5')).toBe(true);
    expect(isApprovableKind('gate_fail')).toBe(false);
    expect(isApprovableKind('publisher_adapter_unavailable')).toBe(false);
    expect(isApprovableKind('brief_requires_human_review')).toBe(false);
    expect(isApprovableKind('')).toBe(false);
  });

  test('the sender allowlist FAILS CLOSED — no default approver (contact@ is a shared staff inbox)', () => {
    const prev = process.env.APPROVAL_ALLOWED_SENDERS;
    delete process.env.APPROVAL_ALLOWED_SENDERS;
    try {
      expect(allowedSenders()).toEqual([]); // nobody can approve until configured
    } finally {
      if (prev !== undefined) process.env.APPROVAL_ALLOWED_SENDERS = prev;
    }
  });

  test('recipient defaults to the owner inbox; allowlist is env-set and normalized', () => {
    expect(approvalRecipient()).toBe('contact@wavespestcontrol.com');
    const prevA = process.env.APPROVAL_ALLOWED_SENDERS;
    const prevT = process.env.APPROVAL_EMAIL_TO;
    process.env.APPROVAL_ALLOWED_SENDERS = 'Adam@Example.com , second@example.com';
    process.env.APPROVAL_EMAIL_TO = 'inbox@example.com';
    try {
      expect(allowedSenders()).toEqual(['adam@example.com', 'second@example.com']);
      expect(approvalRecipient()).toBe('inbox@example.com');
    } finally {
      if (prevA === undefined) delete process.env.APPROVAL_ALLOWED_SENDERS; else process.env.APPROVAL_ALLOWED_SENDERS = prevA;
      if (prevT === undefined) delete process.env.APPROVAL_EMAIL_TO; else process.env.APPROVAL_EMAIL_TO = prevT;
    }
  });

  test('the IMAP mailbox is the fixed reply inbox, decoupled from APPROVAL_EMAIL_TO (Codex r1)', () => {
    const prevT = process.env.APPROVAL_EMAIL_TO;
    process.env.APPROVAL_EMAIL_TO = 'somewhere-else@example.com';
    try {
      // email.js always sends FROM contact@ with no Reply-To — replies land
      // in the contact account regardless of the destination override.
      expect(imapMailbox().user).toBe(process.env.GMAIL_USER_EMAIL || 'contact@wavespestcontrol.com');
    } finally {
      if (prevT === undefined) delete process.env.APPROVAL_EMAIL_TO; else process.env.APPROVAL_EMAIL_TO = prevT;
    }
  });
});

describe('executeDecision / finishExecution — recoverable claim state machine', () => {
  const ROW = { id: 'x', token: 'EA-deadbeef', run_id: 'r', opportunity_id: 'o', kind: 'named_competitor_review' };

  function mockDb({ claim = 1 } = {}) {
    const db = require('../models/db');
    const updates = [];
    db.mockImplementation(() => ({
      where: jest.fn().mockReturnValue({
        update: jest.fn().mockImplementation((payload) => { updates.push(payload); return Promise.resolve(updates.length === 1 ? claim : 1); }),
        first: jest.fn().mockResolvedValue(null),
        orderBy: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue(null) }),
      }),
    }));
    return updates;
  }

  test('an already-decided row is never executed twice', async () => {
    const updates = mockDb({ claim: 0 });
    const result = await approvals._internals.executeDecision(ROW, 'approved', 'owner@example.com');
    expect(result).toEqual({ skipped: 'already_decided' });
    expect(updates).toHaveLength(1); // only the claim attempt
  });

  test('the claim persists decision + sender in a recoverable executing state (Codex r1)', async () => {
    const reviewQueue = require('../services/content/autonomous-review-queue');
    reviewQueue.decideReviewItem.mockResolvedValue({});
    const updates = mockDb();
    const result = await approvals._internals.executeDecision(ROW, 'approved', 'owner@example.com');
    expect(updates[0]).toMatchObject({ status: 'executing', decision: 'approved', decided_by: 'email:owner@example.com' });
    expect(reviewQueue.decideReviewItem).toHaveBeenCalledWith('o', expect.objectContaining({
      decision: 'approve_named_competitor',
      expectedRunId: 'r',
    }));
    expect(updates[1]).toMatchObject({ status: 'approved' });
    expect(result.executed).toBe('approve_named_competitor');
  });

  test('a transient failure releases the claim so the inbox reply retries (Codex r1)', async () => {
    const reviewQueue = require('../services/content/autonomous-review-queue');
    reviewQueue.decideReviewItem.mockRejectedValue(new Error('engine lock held: another run is in progress'));
    const updates = mockDb();
    await expect(approvals._internals.executeDecision(ROW, 'approved', 'owner@example.com'))
      .rejects.toMatchObject({ transient: true });
    expect(updates[1]).toMatchObject({ status: 'awaiting_reply', decision: null, decided_by: null });
  });

  test('a stale-run 409 supersedes instead of applying to the newer draft (Codex r1)', async () => {
    const reviewQueue = require('../services/content/autonomous-review-queue');
    const err = new Error('This item changed since you opened it (a newer run replaced the reviewed one)');
    err.statusCode = 409;
    reviewQueue.decideReviewItem.mockRejectedValue(err);
    const updates = mockDb();
    const result = await approvals._internals.executeDecision(ROW, 'rejected', 'owner@example.com');
    expect(result).toEqual({ skipped: 'superseded' });
    expect(updates[1]).toMatchObject({ status: 'superseded' });
  });

  test('rejection maps to the review queue dismiss decision', async () => {
    const reviewQueue = require('../services/content/autonomous-review-queue');
    reviewQueue.decideReviewItem.mockResolvedValue({});
    mockDb();
    await approvals._internals.executeDecision(ROW, 'rejected', 'owner@example.com');
    expect(reviewQueue.decideReviewItem).toHaveBeenCalledWith('o', expect.objectContaining({ decision: 'dismiss' }));
  });

  test('failure classifiers: lock/busy is safely retryable, timeouts are ambiguous, gate failures are neither (Codex r4)', () => {
    expect(SAFE_RETRY_ERROR_RE.test('engine lock held')).toBe(true);
    expect(SAFE_RETRY_ERROR_RE.test('Autonomous publisher is busy; retry in a moment')).toBe(true);
    expect(SAFE_RETRY_ERROR_RE.test('deadlock detected')).toBe(true);
    expect(SAFE_RETRY_ERROR_RE.test('Request timed out')).toBe(false); // may be post-side-effect
    expect(AMBIGUOUS_ERROR_RE.test('Request timed out')).toBe(true);
    expect(AMBIGUOUS_ERROR_RE.test('ECONNRESET')).toBe(true);
    expect(SAFE_RETRY_ERROR_RE.test('draft failed the comparison gate')).toBe(false);
    expect(AMBIGUOUS_ERROR_RE.test('draft failed the comparison gate')).toBe(false);
  });

  test('an ambiguous failure keeps the row executing for recovery — a publish is never blind-replayed (Codex r4)', async () => {
    const reviewQueue = require('../services/content/autonomous-review-queue');
    reviewQueue.decideReviewItem.mockRejectedValue(new Error('Request timed out'));
    const db = require('../models/db');
    const updates = [];
    db.mockImplementation(() => ({
      where: jest.fn().mockReturnValue({
        update: jest.fn().mockImplementation((p) => { updates.push(p); return Promise.resolve(1); }),
        first: jest.fn().mockResolvedValue(null),
        orderBy: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue(null) }),
      }),
    }));
    const result = await approvals._internals.executeDecision(ROW, 'approved', 'owner@example.com');
    expect(result).toEqual({ skipped: 'ambiguous_failure_pending_recovery' });
    // No status reset to awaiting_reply — the executing claim stands.
    expect(updates.some((u) => u.status === 'awaiting_reply')).toBe(false);
    expect(updates.some((u) => u.status === 'failed')).toBe(false);
  });

  test('crash recovery reconciles an already-committed decision instead of reporting failure (Codex r2)', async () => {
    const reviewQueue = require('../services/content/autonomous-review-queue');
    const err = new Error('Opportunity is no longer pending_review');
    reviewQueue.decideReviewItem.mockRejectedValue(err);
    const db = require('../models/db');
    const updates = [];
    db.mockImplementation((table) => ({
      where: jest.fn().mockReturnValue({
        update: jest.fn().mockImplementation((p) => { updates.push(p); return Promise.resolve(1); }),
        first: jest.fn().mockResolvedValue(table === 'opportunity_queue' ? { status: 'done' } : null),
        orderBy: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue(null) }),
      }),
    }));
    const result = await approvals._internals.finishExecution(ROW, 'approved', 'owner@example.com', { recovery: true });
    expect(result).toEqual({ executed: 'reconciled' });
    expect(updates.at(-1)).toMatchObject({ status: 'approved' });
  });

  test('crash recovery with an in-flight publish stays executing (Codex r2)', async () => {
    const reviewQueue = require('../services/content/autonomous-review-queue');
    reviewQueue.decideReviewItem.mockRejectedValue(new Error('Opportunity is no longer pending_review'));
    const db = require('../models/db');
    db.mockImplementation((table) => ({
      where: jest.fn().mockReturnValue({
        update: jest.fn().mockResolvedValue(1),
        first: jest.fn().mockResolvedValue(table === 'opportunity_queue' ? { status: 'claimed' } : null),
        orderBy: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue(null) }),
      }),
    }));
    const result = await approvals._internals.finishExecution(ROW, 'approved', 'owner@example.com', { recovery: true });
    expect(result).toEqual({ skipped: 'in_flight' });
  });
});

describe('round-5 hardening (Codex r5)', () => {
  const ROW5 = { id: 'x', token: 'EA-deadbeef', run_id: 'r', opportunity_id: 'o', kind: 'named_competitor_review', last_error: null };

  test('an emailed "approved" on an oversized draft is refused and routed to the portal', async () => {
    const db = require('../models/db');
    const updates = [];
    const bigMeta = { frontmatter: { blob: 'y'.repeat(30000) }, title: 'T', body: 'ok' };
    db.mockImplementation((table) => ({
      where: jest.fn().mockReturnValue({
        update: jest.fn().mockImplementation((p) => { updates.push(p); return Promise.resolve(1); }),
        first: jest.fn().mockResolvedValue(table === 'autonomous_runs' ? { id: 'r', draft_payload: JSON.stringify(bigMeta) } : null),
        orderBy: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue(null) }),
      }),
    }));
    const result = await approvals._internals.executeDecision(ROW5, 'approved', 'owner@example.com');
    expect(result).toEqual({ skipped: 'requires_portal_review' });
    expect(updates.every((u) => u.status === undefined)).toBe(true); // never claimed/executed
  });

  test('an unknown execution error reconciles from persisted state before failing', async () => {
    const reviewQueue = require('../services/content/autonomous-review-queue');
    reviewQueue.decideReviewItem.mockRejectedValue(new Error('unexpected column drift'));
    const db = require('../models/db');
    const updates = [];
    db.mockImplementation((table) => ({
      where: jest.fn().mockReturnValue({
        update: jest.fn().mockImplementation((p) => { updates.push(p); return Promise.resolve(1); }),
        first: jest.fn().mockResolvedValue(
          table === 'autonomous_runs' ? { outcome: 'completed_pending_review', skip_reason: 'astro_pr_pending_merge' }
            : table === 'opportunity_queue' ? { status: 'pending_review' } : null
        ),
        orderBy: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue(null) }),
      }),
    }));
    const result = await approvals._internals.finishExecution(ROW5, 'approved', 'owner@example.com');
    expect(result).toEqual({ executed: 'reconciled' });
    expect(updates.some((u) => u.status === 'failed')).toBe(false);
  });

  test('approval-token subjects are control messages for email-sync', () => {
    expect(approvals.isApprovalControlMessage({ subject: 'Re: [EA-1a2b3c4d] Approve? Post' })).toBe(true);
    expect(approvals.isApprovalControlMessage({ subject: 'Quarterly service question' })).toBe(false);
  });

  test('metadata truncation marks the whole preview truncated', () => {
    const { truncated } = approvals._internals.draftPreview({
      draft_payload: JSON.stringify({ title: 'T', body: 'short', frontmatter: { blob: 'z'.repeat(30000) } }),
    });
    expect(truncated).toBe(true);
  });
});

describe('gate + full-draft rules (Codex r2)', () => {
  test('the feature gate requires explicit opt-in in EVERY environment', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../config/feature-gates.js'), 'utf8');
    const line = src.split('\n').find((l) => l.includes('contentEmailApprovals:'));
    expect(line).toContain("process.env.GATE_CONTENT_EMAIL_APPROVALS === 'true'");
    expect(line).not.toContain('isProd ?'); // no dev auto-on with real creds
  });

  test('draftPreview returns the COMPLETE body — approving publishes everything shown', () => {
    const body = 'x'.repeat(5000);
    const { body: shown, truncated } = approvals._internals.draftPreview({ draft_payload: JSON.stringify({ title: 'T', body }) });
    expect(shown).toHaveLength(5000); // no 1,200-char excerpt
    expect(truncated).toBe(false);
  });
});

describe('round-3 hardening (Codex r3)', () => {
  test('HTML-only replies keep reply boundaries — quoted instructions never force ambiguity (Codex r5 P1)', () => {
    const raw = [
      'Content-Type: text/html; charset=UTF-8', '',
      '<div dir="ltr">approved</div><br><div class="gmail_quote">On Tue wrote:<blockquote>Reply with exactly one of: approved — or — not approved</blockquote></div>',
    ].join('\r\n');
    expect(parseDecision(extractReplyText(raw))).toBe('approved');
    const rejectRaw = [
      'Content-Type: text/html; charset=UTF-8', '',
      '<div>not approved</div><blockquote>approved — or — not approved</blockquote>',
    ].join('\r\n');
    expect(parseDecision(extractReplyText(rejectRaw))).toBe('rejected');
  });

  test('a Content-Type name= part is an attachment even with inline/omitted disposition (Codex r5)', () => {
    const raw = [
      'Content-Type: multipart/mixed; boundary="o"', '',
      '--o', 'Content-Type: text/plain; name="notes.txt"', '',
      'approved — attachment must not decide', '',
      '--o', 'Content-Type: multipart/alternative; boundary="i"', '',
      '--i', 'Content-Type: text/plain', '', 'not approved', '--i--', '--o--',
    ].join('\r\n');
    expect(parseDecision(extractReplyText(raw))).toBe('rejected');
  });

  test('an explicit dmarc=fail is authoritative — no DKIM fallback (Codex r5 P1)', () => {
    const verify = approvals._internals.verifySenderAuthentication;
    const raw = 'Authentication-Results: mx.google.com; dkim=pass header.i=@mailer.example.com; dmarc=fail header.from=example.com\r\nFrom: o <o@example.com>\r\n\r\napproved\r\n';
    expect(verify(raw, 'o@example.com')).toBe(false);
  });

  test('a text/plain ATTACHMENT never decides — the nested body wins', () => {
    const raw = [
      'Content-Type: multipart/mixed; boundary="outer"', '',
      '--outer', 'Content-Type: multipart/alternative; boundary="inner"', '',
      '--inner', 'Content-Type: text/plain; charset=UTF-8', '',
      'not approved', '',
      '--inner--', '',
      '--outer', 'Content-Type: text/plain; name="notes.txt"',
      'Content-Disposition: attachment; filename="notes.txt"', '',
      'approved — attachment text must not decide', '--outer--',
    ].join('\r\n');
    expect(parseDecision(extractReplyText(raw))).toBe('rejected');
  });

  test('crash recovery recognizes an opened Astro PR as approved-complete (real persisted shape)', async () => {
    const reviewQueue = require('../services/content/autonomous-review-queue');
    reviewQueue.decideReviewItem.mockRejectedValue(new Error('run is no longer named_competitor_review'));
    const db = require('../models/db');
    const updates = [];
    db.mockImplementation((table) => ({
      where: jest.fn().mockReturnValue({
        update: jest.fn().mockImplementation((p) => { updates.push(p); return Promise.resolve(1); }),
        first: jest.fn().mockResolvedValue(
          // The runner persists an opened PR as outcome=completed_pending_review
          // with skip_reason=astro_pr_pending_merge — NOT as an outcome value.
          table === 'autonomous_runs' ? { outcome: 'completed_pending_review', skip_reason: 'astro_pr_pending_merge' }
            : table === 'opportunity_queue' ? { status: 'pending_review' } : null
        ),
        orderBy: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue(null) }),
      }),
    }));
    const row = { id: 'x', token: 'EA-deadbeef', run_id: 'r', opportunity_id: 'o', kind: 'named_competitor_review' };
    const result = await approvals._internals.finishExecution(row, 'approved', 'owner@example.com', { recovery: true });
    expect(result).toEqual({ executed: 'reconciled' });
    expect(updates.at(-1)).toMatchObject({ status: 'approved' });
  });

  test('sender authentication requires the trusted receiver\'s DMARC/DKIM verdict (P0: From is spoofable)', () => {
    const verify = approvals._internals.verifySenderAuthentication;
    const base = (auth) => `Delivered-To: contact@wavespestcontrol.com\r\n${auth}From: Owner <owner@gmail.com>\r\nSubject: Re: [EA-deadbeef] Approve?\r\n\r\napproved\r\n`;
    // DMARC pass aligned to the sender domain → authorized.
    expect(verify(base('Authentication-Results: mx.google.com; spf=pass; dkim=pass header.i=@gmail.com; dmarc=pass (p=NONE) header.from=gmail.com\r\n'), 'owner@gmail.com')).toBe(true);
    // Aligned DKIM pass alone (folded header) → authorized.
    expect(verify(base('Authentication-Results: mx.google.com;\r\n dkim=pass header.i=@gmail.com header.s=x\r\n'), 'owner@gmail.com')).toBe(true);
    // No Authentication-Results at all → fail closed.
    expect(verify(base(''), 'owner@gmail.com')).toBe(false);
    // DMARC fail → rejected.
    expect(verify(base('Authentication-Results: mx.google.com; dmarc=fail header.from=gmail.com\r\n'), 'owner@gmail.com')).toBe(false);
    // Pass for a DIFFERENT domain (spoofed From) → rejected.
    expect(verify(base('Authentication-Results: mx.google.com; dmarc=pass header.from=attacker.com\r\n'), 'owner@gmail.com')).toBe(false);
    // Attacker-embedded header with a foreign authserv-id → not trusted.
    expect(verify(base('Authentication-Results: evil.example; dmarc=pass header.from=gmail.com\r\n'), 'owner@gmail.com')).toBe(false);
    // Suffix-abuse: notgmail.com must not satisfy gmail.com alignment.
    expect(verify(base('Authentication-Results: mx.google.com; dmarc=pass header.from=notgmail.com\r\n'), 'owner@gmail.com')).toBe(false);
  });
});

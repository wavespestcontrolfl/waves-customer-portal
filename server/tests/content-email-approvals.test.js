/**
 * Email-reply approval loop for parked autonomous content runs
 * (owner directive 2026-07-28: approvals via contact@ inbox replies).
 *
 * Trust boundary under test: token in subject × sender allowlist ×
 * unambiguous first-line decision — everything else fails closed.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const approvals = require('../services/content/email-approvals');
const { parseDecision, extractReplyText, isApprovableKind, newToken, allowedSenders, approvalRecipient, TOKEN_RE } = approvals._internals;

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

  test('sender allowlist and recipient default to the owner inbox and are env-overridable', () => {
    expect(approvalRecipient()).toBe('contact@wavespestcontrol.com');
    expect(allowedSenders()).toContain('contact@wavespestcontrol.com');
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
});

describe('executeDecision — at-most-once claim', () => {
  test('an already-decided row is never executed twice', async () => {
    const db = require('../models/db');
    const update = jest.fn().mockResolvedValue(0); // claim misses: not awaiting
    db.mockReturnValue({ where: jest.fn().mockReturnValue({ update }) });
    const result = await approvals._internals.executeDecision(
      { id: 'x', run_id: 'r', opportunity_id: 'o', kind: 'named_competitor_review', status: 'approved' },
      'approved', 'contact@wavespestcontrol.com'
    );
    expect(result).toEqual({ skipped: 'already_decided' });
    expect(update).toHaveBeenCalledTimes(1); // only the claim attempt, no execution
  });
});

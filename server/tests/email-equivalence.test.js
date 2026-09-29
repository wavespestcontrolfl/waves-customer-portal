const { collapseGmailDotEquivalent, emailsEquivalent, emailEquivalenceKey } = require('../utils/email-equivalence');
const { adoptV2PrimaryFields } = require('../utils/extraction-compat');
const { applyEmailDisagreementHold } = require('../services/call-triage-flags');
const { applyEmailDictationPolicy, sanitizeEmailCandidates } = require('../services/contact-dictation');

function v2With(email) {
  return {
    meta: { schema_version: '1.13.0' },
    caller: { email, name_full: null, phone_source: 'caller_id' },
    scheduling: {},
    service_request: {},
  };
}
const adopt = (v1Email, v2Email) => adoptV2PrimaryFields({ email: v1Email }, v2With(v2Email));

describe('collapseGmailDotEquivalent', () => {
  test('dot-only Gmail pair collapses to the undotted address', () => {
    expect(collapseGmailDotEquivalent(['j.q.sample1990@gmail.com', 'jqsample1990@gmail.com'])).toBe('jqsample1990@gmail.com');
    expect(collapseGmailDotEquivalent(['JQSample1990@GMAIL.com', 'j.q.sample1990@gmail.com'])).toBe('jqsample1990@gmail.com');
  });
  test('googlemail dot-only pair collapses at googlemail.com', () => {
    expect(collapseGmailDotEquivalent(['j.q.sample1990@googlemail.com', 'jqsample1990@googlemail.com'])).toBe('jqsample1990@googlemail.com');
  });
  test('three candidates collapse only when every one is dot-equivalent', () => {
    expect(collapseGmailDotEquivalent(['j.qsample1990@gmail.com', 'jq.sample1990@gmail.com', 'jqsample1990@gmail.com'])).toBe('jqsample1990@gmail.com');
    expect(collapseGmailDotEquivalent(['j.qsample1990@gmail.com', 'jqsample1990@gmail.com', 'jqsample1991@gmail.com'])).toBeNull();
  });
  test('negatives', () => {
    expect(collapseGmailDotEquivalent(['jqsample1990@gmail.com', 'jqsample1990@googlemail.com'])).toBeNull();
    expect(collapseGmailDotEquivalent(['jqsample1990+a@gmail.com', 'jqsample1990@gmail.com'])).toBeNull();
    expect(collapseGmailDotEquivalent(['j.q.sample1990@example.com', 'jqsample1990@example.com'])).toBeNull();
    expect(collapseGmailDotEquivalent(['j.q.sample1990@gmail.com', 'j.q.sample1991@gmail.com'])).toBeNull();
    expect(collapseGmailDotEquivalent([])).toBeNull();
  });
  test('emailsEquivalent / emailEquivalenceKey', () => {
    expect(emailsEquivalent(' A@x.com', 'a@X.com')).toBe(true);
    expect(emailsEquivalent('j.q@gmail.com', 'jq@gmail.com')).toBe(true);
    expect(emailsEquivalent('j.q@x.com', 'jq@x.com')).toBe(false);
    expect(emailEquivalenceKey('J.Q@Gmail.com')).toBe('jq@gmail.com');
    expect(emailEquivalenceKey('J.Q@X.com')).toBe('j.q@x.com');
  });
});

describe('adoptV2PrimaryFields — Gmail dot-only equivalence (2026-09-29)', () => {
  test('dotted V1 vs undotted V2 saves the undotted address, no hold', () => {
    const { merged, adoptedFields } = adopt('j.q.sample1990@gmail.com', 'jqsample1990@gmail.com');
    expect(merged.email).toBe('jqsample1990@gmail.com');
    expect(merged.email_candidates).toBeUndefined();
    expect(adoptedFields).not.toContain('email_disagreement');
    expect(adoptedFields).toContain('email_gmail_dot_equivalent');
  });
  test('reverse order also collapses', () => {
    const { merged } = adopt('jqsample1990@gmail.com', 'j.q.sample1990@gmail.com');
    expect(merged.email).toBe('jqsample1990@gmail.com');
    expect(merged.email_candidates).toBeUndefined();
  });
  test.each([
    ['gmail vs googlemail', 'jqsample1990@gmail.com', 'j.q.sample1990@googlemail.com'],
    ['+tag difference', 'jqsample1990+a@gmail.com', 'jqsample1990@gmail.com'],
    ['non-Gmail dot difference', 'j.q.sample1990@example.com', 'jqsample1990@example.com'],
    ['letter difference', 'j.q.sample1990@gmail.com', 'j.q.sample1991@gmail.com'],
  ])('stays held: %s', (_label, a, b) => {
    const { merged, adoptedFields } = adopt(a, b);
    expect(merged.email).toBeNull();
    expect(merged.email_candidates).toEqual([a, b]);
    expect(adoptedFields).toContain('email_disagreement');
  });
});

describe('downstream consumers do not re-open the hold', () => {
  test('applyEmailDisagreementHold is a no-op on a dot-only Gmail pair, still holds a real disagreement', () => {
    const same = { email: null, email_candidates: ['j.q.sample1990@gmail.com', 'jqsample1990@gmail.com'] };
    const out = applyEmailDisagreementHold(same, null);
    expect(out.extracted).toBe(same);
    expect(out.dictationEmailPayload).toBeNull();
    const diff = applyEmailDisagreementHold({ email: null, email_candidates: ['a@gmail.com', 'b@gmail.com'] }, null);
    expect(diff.dictationEmailPayload.email_disagreement).toEqual({ v1: 'a@gmail.com', v2: 'b@gmail.com' });
  });
  test('decoder: dotted + undotted candidates dedupe to one candidate', () => {
    const out = sanitizeEmailCandidates([
      { value: 'j.q.sample1990@gmail.com', confidence: 0.7 },
      { value: 'jqsample1990@gmail.com', confidence: 0.9 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].value).toBe('jqsample1990@gmail.com');
  });
  test('decoder policy: dot-variant of the saved Gmail address is agreement, not a conflict', () => {
    const dictation = { emails: [{ raw_spoken: 'j q sample 1990 at gmail', confirmation_question: '', candidates: [
      { value: 'j.q.sample1990@gmail.com', confidence: 0.9, risks: [], basis: [] },
    ] }] };
    const res = applyEmailDictationPolicy({ extracted: { email: 'jqsample1990@gmail.com' }, dictation });
    expect(res.hold).toBe(false);
    expect(res.adopt).toBeNull();
  });
  test('decoder policy: non-Gmail dot difference is still a conflict', () => {
    const dictation = { emails: [{ raw_spoken: 'x', confirmation_question: '', candidates: [
      { value: 'j.q.sample1990@example.com', confidence: 0.9, risks: [], basis: [] },
    ] }] };
    const res = applyEmailDictationPolicy({ extracted: { email: 'jqsample1990@example.com' }, dictation });
    expect(res.hold).toBe(true);
    expect(res.adopt).toBeNull();
  });
});

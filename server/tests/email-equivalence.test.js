const fs = require('fs');
const path = require('path');
const { collapseGmailDotEquivalent } = require('../utils/email-equivalence');
const { adoptV2PrimaryFields } = require('../utils/extraction-compat');
const { applyEmailDisagreementHold } = require('../services/call-triage-flags');

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
  test('dots before a +tag collapse; the tag is kept verbatim', () => {
    expect(collapseGmailDotEquivalent(['j.q.sample1990+home@gmail.com', 'jqsample1990+home@gmail.com'])).toBe('jqsample1990+home@gmail.com');
  });
  test('three candidates collapse only when every one is dot-equivalent', () => {
    expect(collapseGmailDotEquivalent(['j.qsample1990@gmail.com', 'jq.sample1990@gmail.com', 'jqsample1990@gmail.com'])).toBe('jqsample1990@gmail.com');
    expect(collapseGmailDotEquivalent(['j.qsample1990@gmail.com', 'jqsample1990@gmail.com', 'jqsample1991@gmail.com'])).toBeNull();
  });
  test('negatives', () => {
    expect(collapseGmailDotEquivalent(['jqsample1990@gmail.com', 'jqsample1990@googlemail.com'])).toBeNull();
    expect(collapseGmailDotEquivalent(['jqsample1990+a@gmail.com', 'jqsample1990@gmail.com'])).toBeNull();
    // A dot INSIDE the tag is deliberate (codex #5323 r1 P2): never collapsed.
    expect(collapseGmailDotEquivalent(['jane+lead.1@gmail.com', 'jane+lead1@gmail.com'])).toBeNull();
    expect(collapseGmailDotEquivalent(['j.q.sample1990@example.com', 'jqsample1990@example.com'])).toBeNull();
    expect(collapseGmailDotEquivalent(['j.q.sample1990@gmail.com', 'j.q.sample1991@gmail.com'])).toBeNull();
    expect(collapseGmailDotEquivalent(['jqsample1990@gmail.com'])).toBeNull();
    expect(collapseGmailDotEquivalent([])).toBeNull();
  });
});

describe('adoptV2PrimaryFields — Gmail dot-only equivalence (2026-09-29)', () => {
  test('dotted V1 vs undotted V2 saves the undotted address, no hold, both readings kept for the processor check', () => {
    const { merged, adoptedFields } = adopt('j.q.sample1990@gmail.com', 'jqsample1990@gmail.com');
    expect(merged.email).toBe('jqsample1990@gmail.com');
    expect(merged.email_candidates).toBeUndefined();
    expect(merged.email_gmail_variants).toEqual(['j.q.sample1990@gmail.com', 'jqsample1990@gmail.com']);
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
    ['dot inside the tag', 'jane+lead.1@gmail.com', 'jane+lead1@gmail.com'],
    ['non-Gmail dot difference', 'j.q.sample1990@example.com', 'jqsample1990@example.com'],
    ['letter difference', 'j.q.sample1990@gmail.com', 'j.q.sample1991@gmail.com'],
  ])('stays held: %s', (_label, a, b) => {
    const { merged, adoptedFields } = adopt(a, b);
    expect(merged.email).toBeNull();
    expect(merged.email_candidates).toEqual([a, b]);
    expect(merged.email_gmail_variants).toBeUndefined();
    expect(adoptedFields).toContain('email_disagreement');
  });
});

describe('a re-held dot-equivalent pair (suppressed / owned elsewhere) takes the normal disagreement hold', () => {
  test('applyEmailDisagreementHold holds a dot-only pair like any other pair', () => {
    const out = applyEmailDisagreementHold({ email: null, email_candidates: ['j.q.sample1990@gmail.com', 'jqsample1990@gmail.com'] }, null);
    expect(out.extracted.email).toBeNull();
    expect(out.dictationEmailPayload.email_disagreement).toEqual({ v1: 'j.q.sample1990@gmail.com', v2: 'jqsample1990@gmail.com' });
  });
});

// The processor's post-adoption check is DB-backed; pin its contract in the
// source so a refactor cannot silently drop the suppression/ownership re-hold.
describe('call processor re-holds a collapsed Gmail pair on suppression or foreign ownership', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
  const start = src.indexOf('if (Array.isArray(extracted.email_gmail_variants))');
  const block = src.slice(start, src.indexOf('if (adoption.adoptedFields.length)', start));
  test('the check exists right after adoption', () => {
    expect(start).toBeGreaterThan(-1);
    expect(block).toContain('delete extracted.email_gmail_variants');
  });
  test('suppressions are matched by Google mailbox identity, active only, failing closed', () => {
    expect(block).toContain("db('email_suppressions')");
    expect(block).toContain('GOOGLE_MAILBOX_SQL.mailbox');
    expect(block).toContain("where({ status: 'active' })");
    expect(block).toContain('() => true');
  });
  test('ownership uses the shared Gmail mailbox check, failing closed', () => {
    expect(block).toContain('gmailMailboxOwnedByOther(extracted.email, ownCustomerId)');
    expect(block).toContain('.catch(() => true)');
  });
  test('a hit restores the pair for the read-back hold', () => {
    expect(block).toContain('extracted.email = null');
    expect(block).toContain('extracted.email_candidates = variants');
  });
});

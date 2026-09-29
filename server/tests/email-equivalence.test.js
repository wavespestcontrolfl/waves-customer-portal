const { sameGmailInbox, gmailCanonicalMailbox } = require('../utils/email-equivalence');
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

describe('sameGmailInbox (built on the shared gmailCanonicalMailbox)', () => {
  test('dot-only Gmail pair is one inbox', () => {
    expect(sameGmailInbox(['j.q.sample1990@gmail.com', 'jqsample1990@gmail.com'])).toBe('jqsample1990@gmail.com');
    expect(sameGmailInbox(['JQSample1990@GMAIL.com', 'j.q.sample1990@gmail.com'])).toBe('jqsample1990@gmail.com');
    expect(sameGmailInbox(['j.q.sample1990@googlemail.com', 'jqsample1990@googlemail.com'])).toBe('jqsample1990@gmail.com');
  });
  test('dots before a +tag count; the tag must match exactly', () => {
    expect(sameGmailInbox(['j.q.sample1990+home@gmail.com', 'jqsample1990+home@gmail.com'])).toBe('jqsample1990+home@gmail.com');
  });
  test('three readings are one inbox only when all are', () => {
    expect(sameGmailInbox(['j.qsample1990@gmail.com', 'jq.sample1990@gmail.com', 'jqsample1990@gmail.com'])).toBe('jqsample1990@gmail.com');
    expect(sameGmailInbox(['j.qsample1990@gmail.com', 'jqsample1990@gmail.com', 'jqsample1991@gmail.com'])).toBeNull();
  });
  test('negatives', () => {
    expect(sameGmailInbox(['jqsample1990@gmail.com', 'jqsample1990@googlemail.com'])).toBeNull();
    expect(sameGmailInbox(['jqsample1990+a@gmail.com', 'jqsample1990@gmail.com'])).toBeNull();
    expect(sameGmailInbox(['jane+lead.1@gmail.com', 'jane+lead1@gmail.com'])).toBeNull();
    expect(sameGmailInbox(['j.q.sample1990@example.com', 'jqsample1990@example.com'])).toBeNull();
    expect(sameGmailInbox(['j.q.sample1990@gmail.com', 'j.q.sample1991@gmail.com'])).toBeNull();
    expect(sameGmailInbox(['jqsample1990@gmail.com'])).toBeNull();
    expect(sameGmailInbox([])).toBeNull();
  });
  test.each([
    ['leading dot', '.jqsample1990@gmail.com'],
    ['trailing dot', 'jqsample1990.@gmail.com'],
    ['consecutive dots', 'jq..sample1990@gmail.com'],
  ])('invalid dot placement is never "the same inbox" (codex #5323 r4): %s', (_l, bad) => {
    expect(sameGmailInbox([bad, 'jqsample1990@gmail.com'])).toBeNull();
  });
  test('the arbiter re-exports the same shared function', () => {
    expect(require('../services/contact-quarantine-arbiter').gmailCanonicalMailbox).toBe(gmailCanonicalMailbox);
  });
});

describe('adoptV2PrimaryFields still holds a dot-only Gmail pair (no automatic save)', () => {
  test('dotted V1 vs undotted V2 is held for read-back like any disagreement', () => {
    const { merged, adoptedFields } = adopt('j.q.sample1990@gmail.com', 'jqsample1990@gmail.com');
    expect(merged.email).toBeNull();
    expect(merged.email_candidates).toEqual(['j.q.sample1990@gmail.com', 'jqsample1990@gmail.com']);
    expect(adoptedFields).toContain('email_disagreement');
  });
});

describe('the read-back card says a dot-only Gmail pair is one inbox (owner ruling 2026-09-29)', () => {
  test('same-inbox wording, flag set, still held', () => {
    const out = applyEmailDisagreementHold({ email: null, email_candidates: ['j.q.sample1990@gmail.com', 'jqsample1990@gmail.com'] }, null);
    expect(out.extracted.email).toBeNull();
    expect(out.dictationEmailPayload.email_disagreement).toEqual({ v1: 'j.q.sample1990@gmail.com', v2: 'jqsample1990@gmail.com' });
    expect(out.dictationEmailPayload.gmail_same_inbox).toBe('jqsample1990@gmail.com');
    expect(out.dictationEmailPayload.confirmation_question).toContain('Both spellings are the same Gmail inbox');
  });
  test('the same-inbox wording replaces a decoder question already on the payload', () => {
    const out = applyEmailDisagreementHold(
      { email: null, email_candidates: ['j.q.sample1990@gmail.com', 'jqsample1990@gmail.com'] },
      { confirmation_question: 'Is it j q sample?' },
    );
    expect(out.dictationEmailPayload.confirmation_question).toContain('Both spellings are the same Gmail inbox');
  });
  test('a genuinely different decoder candidate keeps the decoder question (codex #5323 r4)', () => {
    const out = applyEmailDisagreementHold(
      { email: null, email_candidates: ['j.q.sample1990@gmail.com', 'jqsample1990@gmail.com'] },
      { confirmation_question: 'Is it j q sample or j k sample?', email_candidates: [{ value: 'jksample1990@gmail.com' }] },
    );
    expect(out.dictationEmailPayload.gmail_same_inbox).toBeUndefined();
    expect(out.dictationEmailPayload.confirmation_question).toBe('Is it j q sample or j k sample?');
  });
  test.each([
    ['letter difference', 'j.q.sample1990@gmail.com', 'j.q.sample1991@gmail.com'],
    ['dot inside the tag', 'jane+lead.1@gmail.com', 'jane+lead1@gmail.com'],
    ['non-Gmail dots', 'j.q.sample1990@example.com', 'jqsample1990@example.com'],
  ])('a real disagreement keeps the old wording: %s', (_l, a, b) => {
    const out = applyEmailDisagreementHold({ email: null, email_candidates: [a, b] }, null);
    expect(out.dictationEmailPayload.gmail_same_inbox).toBeUndefined();
    expect(out.dictationEmailPayload.confirmation_question).toContain('heard different emails');
  });
});

// Codex #5323 r2 P1: confirming the undotted spelling on the read-back card
// must not release a first touch to an inbox suppressed under a dotted one.
describe('first-touch release suppression check matches the Google mailbox under any spelling', () => {
  const { emailSuppressedForNewLead } = require('../services/lead-first-touch-resume');
  function fakeDb(rows) {
    const calls = { raw: [] };
    const chain = {
      where(arg) {
        if (typeof arg === 'function') {
          const sub = {
            whereRaw: (sql, b) => { calls.raw.push({ sql, b }); return sub; },
            orWhereRaw: (sql, b) => { calls.raw.push({ sql, b, or: true }); return sub; },
          };
          arg(sub);
        }
        return chain;
      },
      then: (resolve) => resolve(rows),
    };
    const dbh = (table) => (table === 'automation_templates'
      ? { where: () => ({ first: async () => ({ key: 'new_lead' }) }) }
      : chain);
    dbh.schema = { hasTable: async () => true };
    return { dbh, calls };
  }
  test('a Gmail address adds the mailbox-identity match next to the exact one', async () => {
    const { dbh, calls } = fakeDb([]);
    await emailSuppressedForNewLead('JQSample1990@gmail.com', dbh);
    expect(calls.raw[0].b).toEqual(['jqsample1990@gmail.com']);
    expect(calls.raw[1].or).toBe(true);
    expect(calls.raw[1].sql).toContain("REPLACE(SPLIT_PART(SPLIT_PART(LOWER(email), '@', 1), '+', 1), '.', '')");
    expect(calls.raw[1].b).toEqual(['jqsample1990']);
  });
  test('a non-Google address keeps the exact match only', async () => {
    const { dbh, calls } = fakeDb([]);
    await emailSuppressedForNewLead('j.q.sample1990@example.com', dbh);
    expect(calls.raw).toHaveLength(1);
  });
  test('a matching active suppression row blocks the release', async () => {
    const { dbh } = fakeDb([{ email: 'j.q.sample1990@gmail.com', status: 'active', suppression_type: 'unsubscribe', group_key: null }]);
    await expect(emailSuppressedForNewLead('jqsample1990@gmail.com', dbh)).resolves.toBe(true);
  });
});

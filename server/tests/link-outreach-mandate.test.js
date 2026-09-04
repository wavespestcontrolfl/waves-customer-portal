/**
 * Backlink Manager v2 step 4 (PR 3a) — the bounded outreach mandate inputs
 * (plan §6.4 / §13): the deterministic draft classifier, the lint pass for a
 * business email, the §3.6b draft hash, and the fail-closed customer-recipient
 * exclusion built from SERVICE_CONTACT_SLOTS (every slot covered, slot 3
 * included, without a hand-written column list).
 */
const M = require('../services/seo/link-outreach-mandate');
const { SERVICE_CONTACT_SLOTS } = require('../services/customer-contact');
const { makeDb } = require('./helpers/link-authority-store');

const CLEAN_BODY = 'Hi Dana,\n\nWe publish a seasonal pest-pressure calendar for the Gulf Coast that your readers in Bradenton may find useful. Happy to share the data behind it.\n\nAdam, Waves Pest Control';
const drafted = (over = {}) => ({ outreach_status: 'drafted', outreach_to_email: 'editor@bradentonherald.com', outreach_subject: 'Local pest-pressure data for your readers', outreach_body: CLEAN_BODY, ...over });

describe('classifyDraft', () => {
  test.each([
    ['a reciprocal promise', "we'll link back to your guide from our resources page", ['reciprocal_promise']],
    ['a link swap', 'happy to do a link exchange', ['reciprocal_promise']],
    ['an offer phrased as capability', 'We can add a link to your website too', ['reciprocal_promise']],
    ['an offer phrased as willingness', "we'd be happy to include a link to your guide", ['reciprocal_promise']],
    ['a link for you', 'a link for your readers from our resources page', ['reciprocal_promise']],
    ['payment', 'we can pay a $150 placement fee', ['payment']],
    ['sponsorship', 'open to a sponsored post', ['payment']],
    ['purchase offer', 'We would purchase this placement from you', ['payment']],
    ['buy / price', 'happy to buy a listing at your price', ['payment']],
    ['a placement charge', 'We can cover the placement charge', ['payment']],
    ['a discounted rate', 'We can offer you a discounted rate for the placement', ['discount']],
    ['a reduced rate', 'a reduced rate for your readers', ['discount']],
    ['reciprocity without the word link', "If you include us, we'll promote your website on ours", ['reciprocal_promise']],
    ['a mention in return', 'we will mention you in our newsletter', ['reciprocal_promise']],
    ['a contracted add', "If you include us, we'll add your website to our directory", ['reciprocal_promise']],
    ['a link swap phrased as add', "We'll add your link to ours", ['reciprocal_promise']],
    ['hosting their content in return', "If you include Waves Pest Control in your guide, we'll publish your guest post on our blog", ['reciprocal_promise']],
    ['a discount', 'your readers get 20% off their first treatment', ['discount']],
    ['a free service', 'a free inspection for your staff', ['discount']],
    ['a guarantee', 'we guarantee results', ['guarantee']],
    ['a standalone 100%', 'We offer 100% placement', ['guarantee']],
    ['100% at the end of the text', 'we deliver 100%', ['guarantee']],
    ['an unusual commitment', 'an exclusive partnership deal', ['commitment']],
  ])('flags %s', (_label, text, flags) => {
    for (const f of flags) expect(M.classifyDraft(text)).toContain(f);
  });
  test('a plain editorial pitch carries no flag', () => {
    expect(M.classifyDraft(CLEAN_BODY)).toEqual([]);
    expect(M.classifyDraft('')).toEqual([]);
    expect(M.classifyDraft(null)).toEqual([]);
  });
});

describe('draftReview', () => {
  test('a complete, addressed, lint-clean, commitment-free draft is clean', () => {
    expect(M.draftReview(drafted())).toMatchObject({ clean: true, flags: [], lint: [], reason: null });
  });
  test('no draft / an ambiguous send / a sent row / a bad recipient / an incomplete draft are never clean', () => {
    expect(M.draftReview(drafted({ outreach_status: 'none' }))).toMatchObject({ clean: false, reason: 'no draft' });
    expect(M.draftReview(drafted({ outreach_status: 'send_error' }))).toMatchObject({ clean: false, reason: 'no draft' });
    expect(M.draftReview(drafted({ outreach_status: 'sent' }))).toMatchObject({ clean: false });
    expect(M.draftReview(drafted({ outreach_to_email: 'not-an-address' }))).toMatchObject({ clean: false, reason: 'invalid recipient' });
    expect(M.draftReview(drafted({ outreach_body: '' }))).toMatchObject({ clean: false, reason: 'incomplete draft' });
    expect(M.draftReview(null)).toMatchObject({ clean: false });
  });
  test('a classifier hit in the subject or body routes to the owner', () => {
    expect(M.draftReview(drafted({ outreach_subject: 'A link exchange for your resources page' }))).toMatchObject({ clean: false, flags: ['reciprocal_promise'] });
    expect(M.draftReview(drafted({ outreach_body: `${CLEAN_BODY}\nWe can pay a fee.` }))).toMatchObject({ clean: false, flags: ['payment'] });
  });
  test('a comms-lint failure (the company name, a URL shortener) routes to the owner', () => {
    const r = M.draftReview(drafted({ outreach_body: 'Hi — Waves Lawn & Pest here, see bit.ly/abc' }));
    expect(r.clean).toBe(false);
    expect(r.lint.map((l) => l.rule).sort()).toEqual(['company-name', 'no-url-shortener']);
    expect(r.reason).toMatch(/lint:company-name/);
  });
});

describe('draftHash', () => {
  test('binds recipient (case / whitespace normalized), subject and body; any edit changes it', () => {
    const a = M.draftHash(drafted());
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(M.draftHash(drafted({ outreach_to_email: '  Editor@BradentonHerald.com ' }))).toBe(a);
    expect(M.draftHash(drafted({ outreach_body: `${CLEAN_BODY} ` }))).not.toBe(a);
    expect(M.draftHash(drafted({ outreach_subject: 'x' }))).not.toBe(a);
    expect(M.draftHash(drafted({ outreach_to_email: 'other@bradentonherald.com' }))).not.toBe(a);
  });
});

describe('recipientReview (§13)', () => {
  const customer = (over = {}) => ({ id: `c-${Math.random()}`, email: null, service_contact_email: null, service_contact2_email: null, service_contact3_email: null, ...over });
  const seed = (over = {}) => makeDb({ customers: [], notification_prefs: [], leads: [], ...over });

  test('a contact re-addressed to the recipient between the exact and the shared-domain statements is a customer, never an ambiguous match', async () => {
    const c = customer({ email: 'other@bradentonherald.com' });
    const db = seed({ customers: [c] });
    let statements = 0;
    // the exact statement ran first and saw `other@`; the shared-domain statement (the second on customers.email) sees the change
    db._beforeResolve = (table) => { if (table === 'customers' && ++statements === 2) db._tables.customers[0].email = 'editor@bradentonherald.com'; };
    const r = await M.recipientReview(db, 'editor@bradentonherald.com');
    expect(r).toMatchObject({ kind: 'customer', matched: [{ source: 'customers.email', id: c.id }] });
    // the promoted hit is the same contact the exact statement would have found — hashed as the customer block it is
    expect(r.lookup_hash).toBe((await M.recipientReview(seed({ customers: [customer({ id: c.id, email: 'editor@bradentonherald.com' })] }), 'editor@bradentonherald.com')).lookup_hash);
  });
  test('a clear recipient', async () => {
    const r = await M.recipientReview(seed({ customers: [customer({ email: 'someone@else.com' })] }), 'editor@bradentonherald.com');
    expect(r).toMatchObject({ kind: 'clear', recipient: 'editor@bradentonherald.com', matched: [] });
    expect(r.lookup_hash).toMatch(/^[0-9a-f]{64}$/);
  });
  test('customers.email — an exact match (case-insensitive) is a customer', async () => {
    const c = customer({ email: '  Editor@Bradenton Herald.com ' }); // stored with the case and whitespace it was typed with — inside too
    const r = await M.recipientReview(seed({ customers: [c] }), 'editor@bradentonherald.com');
    expect(r).toMatchObject({ kind: 'customer', matched: [{ source: 'customers.email', id: c.id }] });
  });
  test.each(SERVICE_CONTACT_SLOTS.map((s) => [s.email]))('%s — every service-contact slot is a contact source (built from the export)', async (col) => {
    const c = customer({ [col]: 'editor@bradentonherald.com' });
    const r = await M.recipientReview(seed({ customers: [c] }), 'editor@bradentonherald.com');
    expect(r).toMatchObject({ kind: 'customer', matched: [{ source: `customers.${col}`, id: c.id }] });
  });
  test('notification_prefs.billing_email and leads.email are contact sources', async () => {
    const billing = await M.recipientReview(seed({ notification_prefs: [{ customer_id: 'cust-9', billing_email: 'editor@bradentonherald.com' }] }), 'editor@bradentonherald.com');
    expect(billing).toMatchObject({ kind: 'customer', matched: [{ source: 'notification_prefs.billing_email', id: 'cust-9' }] });
    const lead = await M.recipientReview(seed({ leads: [{ id: 'lead-3', email: 'editor@bradentonherald.com' }] }), 'editor@bradentonherald.com');
    expect(lead).toMatchObject({ kind: 'customer', matched: [{ source: 'leads.email', id: 'lead-3' }] });
  });
  test('the shared domain is the ORGANIZATION (registrable domain): a customer mailbox on a mail subdomain, or the reverse, is the same business; consumer mail stays exempt on either side', async () => {
    const sub = customer({ email: 'accounts@mail.bradentonherald.com' });
    expect(await M.recipientReview(seed({ customers: [sub] }), 'editor@bradentonherald.com')).toMatchObject({ kind: 'ambiguous', matched: [{ source: 'customers.email', id: sub.id }] });
    const apex = customer({ email: 'accounts@bradentonherald.com' });
    expect(await M.recipientReview(seed({ customers: [apex] }), 'editor@news.bradentonherald.com')).toMatchObject({ kind: 'ambiguous', matched: [{ source: 'customers.email', id: apex.id }] });
    expect((await M.recipientReview(seed({ customers: [customer({ email: 'other@tampabay.rr.com' })] }), 'editor@tampabay.rr.com')).kind).toBe('clear');
    expect((await M.recipientReview(seed({ customers: [customer({ email: 'other@bradentonherald.com' })] }), 'editor@bradentonherald.co.uk')).kind).toBe('clear'); // a different registrable domain
  });
  test('a shared BUSINESS domain is ambiguous (the owner reviews it); a shared consumer-mail domain is not', async () => {
    const c = customer({ email: 'accounts@bradentonherald.com' });
    const amb = await M.recipientReview(seed({ customers: [c] }), 'editor@bradentonherald.com');
    expect(amb).toMatchObject({ kind: 'ambiguous', matched: [{ source: 'customers.email', id: c.id }] });
    const gmail = await M.recipientReview(seed({ customers: [customer({ email: 'someone@gmail.com' })] }), 'editor@gmail.com');
    expect(gmail.kind).toBe('clear');
  });
  test('an exact match outranks a domain match, and the lookup hash follows the verdict', async () => {
    const exact = customer({ email: 'editor@bradentonherald.com' });
    const shared = customer({ email: 'ads@bradentonherald.com' });
    const r = await M.recipientReview(seed({ customers: [exact, shared] }), 'editor@bradentonherald.com');
    expect(r.kind).toBe('customer');
    expect(r.matched).toEqual([{ source: 'customers.email', id: exact.id }]);
    const again = await M.recipientReview(seed({ customers: [exact, shared] }), 'editor@bradentonherald.com');
    expect(again.lookup_hash).toBe(r.lookup_hash);
    const other = await M.recipientReview(seed({ customers: [shared] }), 'editor@bradentonherald.com');
    expect(other.lookup_hash).not.toBe(r.lookup_hash);
  });
  test('the lookup hash is independent of the row order the queries return', async () => {
    const a = customer({ id: 'c-a', email: 'ads@bradentonherald.com' });
    const b = customer({ id: 'c-b', email: 'sales@bradentonherald.com' });
    const one = await M.recipientReview(seed({ customers: [a, b] }), 'editor@bradentonherald.com');
    const two = await M.recipientReview(seed({ customers: [b, a] }), 'editor@bradentonherald.com');
    expect(one.lookup_hash).toBe(two.lookup_hash);
    expect(one.matched.map((m) => m.id)).toEqual(['c-a', 'c-b']);
  });
  test('gmail / googlemail: dots and +tags in the local part are the same mailbox (stored or drafted)', async () => {
    const c = customer({ email: 'First.Last+promo@googlemail.com' });
    const r = await M.recipientReview(seed({ customers: [c] }), 'firstlast@gmail.com');
    expect(r).toMatchObject({ kind: 'customer', recipient: 'firstlast@gmail.com', matched: [{ source: 'customers.email', id: c.id }] });
    const back = await M.recipientReview(seed({ customers: [customer({ email: 'firstlast@gmail.com' })] }), 'f.i.r.s.t.last+x@gmail.com');
    expect(back.kind).toBe('customer');
    // an ordinary host keeps its dots: a different address
    expect((await M.recipientReview(seed({ customers: [customer({ email: 'first.last@bradentonherald.com' })] }), 'firstlast@bradentonherald.com')).kind).toBe('ambiguous');
  });
  test('recipientReviews batches a list and agrees with the single review; reviewByEmail keys by the address as given', async () => {
    const db = seed({ customers: [customer({ email: 'editor@bradentonherald.com' }), customer({ email: 'ads@sarasotamagazine.com' })], leads: [{ id: 'l1', email: 'jane@gulfcoastliving.org' }] });
    const list = ['Editor@BradentonHerald.com', 'features@sarasotamagazine.com', 'someone@gulfcoastliving.org', 'clear@venicechamber.com'];
    const batch = await M.recipientReviews(db, list);
    expect(batch.map((r) => r.kind)).toEqual(['customer', 'ambiguous', 'ambiguous', 'clear']);
    for (const [i, e] of list.entries()) expect(batch[i]).toEqual(await M.recipientReview(db, e));
    const map = await M.reviewByEmail(db, list);
    expect(map.get('Editor@BradentonHerald.com').kind).toBe('customer');
    expect(map.get('clear@venicechamber.com').kind).toBe('clear');
    expect(await M.recipientReviews(db, [])).toEqual([]);
  });
  test('a lookup failure throws — the caller fails closed', async () => {
    const db = seed();
    db._beforeResolve = (table) => { if (table === 'leads') throw new Error('connection reset'); };
    await expect(M.recipientReview(db, 'editor@bradentonherald.com')).rejects.toThrow('connection reset');
  });
});

describe('the follow-up (§6.4)', () => {
  const sent = { outreach_status: 'sent', outreach_to_email: 'Editor@Example.org', outreach_subject: 'A resource', outreach_body: 'Hi', follow_up_status: 'drafted', follow_up_subject: 'Re: A resource', follow_up_body: 'A quick nudge — happy to send anything that helps.' };
  test('followUpReview judges the follow-up draft on the thread\'s recipient; only a drafted follow-up can be clean', () => {
    expect(M.followUpReview(sent).clean).toBe(true);
    expect(M.followUpReview({ ...sent, follow_up_status: 'none' })).toMatchObject({ clean: false, reason: 'no follow-up draft' });
    expect(M.followUpReview({ ...sent, follow_up_body: 'We can pay a fee.' })).toMatchObject({ clean: false, flags: ['payment'] });
    expect(M.followUpReview({ ...sent, outreach_to_email: 'nope' })).toMatchObject({ clean: false, reason: 'invalid recipient' });
    expect(M.draftReview(sent).clean).toBe(false); // the pitch is sent — not a draft
  });
  test('the follow-up\'s own shape is deterministic: the subject is exactly "Re: <the pitch\'s subject>", the body is bounded; a failed automatic reply check routes it to the owner', () => {
    expect(M.followUpReview({ ...sent, follow_up_subject: 'Re: A Resource' })).toMatchObject({ clean: false, flags: ['follow_up_subject'], reason: 'follow_up_subject' });
    expect(M.followUpReview({ ...sent, follow_up_subject: 'A resource' })).toMatchObject({ clean: false, flags: ['follow_up_subject'] });
    expect(M.followUpReview({ ...sent, follow_up_subject: '  Re: A resource  ' }).clean).toBe(true);
    expect(M.followUpReview({ ...sent, follow_up_body: Array(M.FOLLOW_UP_MAX_WORDS + 1).fill('word').join(' ') })).toMatchObject({ clean: false, flags: ['follow_up_length'] });
    expect(M.followUpReview({ ...sent, follow_up_body: 'We can pay a fee.', follow_up_subject: 'x' })).toMatchObject({ clean: false, flags: ['payment', 'follow_up_subject'], reason: 'payment, follow_up_subject' });
    expect(M.followUpReview({ ...sent, follow_up_skipped_reason: 'reply_check_failed' })).toMatchObject({ clean: false, flags: [], reason: expect.stringMatching(/owner sends it/) });
  });
  test('followUpHash binds the recipient, the follow-up subject and body — never the pitch\'s text', () => {
    expect(M.followUpHash(sent)).toBe(M.draftHash({ outreach_to_email: 'editor@example.org', outreach_subject: 'Re: A resource', outreach_body: sent.follow_up_body }));
    expect(M.followUpHash(sent)).not.toBe(M.draftHash(sent));
    expect(M.followUpHash({ ...sent, follow_up_body: 'x' })).not.toBe(M.followUpHash(sent));
  });
  test('draftOf picks the send\'s columns in the sender\'s shape', () => {
    expect(M.draftOf(sent, true)).toEqual({ outreach_to_email: 'Editor@Example.org', outreach_subject: 'Re: A resource', outreach_body: sent.follow_up_body });
    expect(M.draftOf(sent)).toEqual({ outreach_to_email: 'Editor@Example.org', outreach_subject: 'A resource', outreach_body: 'Hi' });
  });
  test('FOLLOW_UP_STATUSES: contacted, plus the Judge-owned statuses on a submit-first path only', () => {
    expect([...M.FOLLOW_UP_STATUSES({ execution_after_send: true })]).toEqual(['contacted']);
    expect([...M.FOLLOW_UP_STATUSES(null)]).toEqual(['contacted']);
    expect([...M.FOLLOW_UP_STATUSES({ execution_after_send: false })]).toEqual(['contacted', 'placed', 'live', 'indexed']);
  });
  test('followUpDueAt is ten days after the send; followUpPending = sent pitch with a drafted / in-flight / errored follow-up', () => {
    expect(M.followUpDueAt('2026-09-03T00:00:00Z').toISOString()).toBe('2026-09-13T00:00:00.000Z');
    // ten ET CALENDAR days at the pitch's ET wall-clock time, across the DST seam (2026-11-01): 08:00 EDT → 08:00 EST, not 240 elapsed hours (07:00 EST)
    expect(M.followUpDueAt('2026-10-28T12:00:00Z').toISOString()).toBe('2026-11-07T13:00:00.000Z');
    expect(M.followUpDueAt(new Date('2026-03-05T13:30:00Z')).toISOString()).toBe('2026-03-15T12:30:00.000Z'); // 08:30 EST → 08:30 EDT
    expect(M.followUpDueAt('2026-09-03T00:00:00.250Z').getMilliseconds()).toBe(250);
    // pending is PATH-aware for a drafted follow-up (Codex r4): the placement must still be in FOLLOW_UP_STATUSES(path)
    const sendFirst = { execution_after_send: true }, submitFirst = { execution_after_send: false };
    const contacted = { ...sent, status: 'contacted' };
    expect(M.followUpPending(contacted, sendFirst)).toBe(true);
    expect(M.followUpPending({ ...contacted, follow_up_status: 'sending' }, sendFirst)).toBe(true);
    expect(M.followUpPending({ ...contacted, follow_up_status: 'send_error' }, sendFirst)).toBe(true);
    for (const st of ['none', 'due', 'sent', 'skipped']) expect(M.followUpPending({ ...contacted, follow_up_status: st }, sendFirst)).toBe(false);
    expect(M.followUpPending({ ...contacted, outreach_status: 'drafted' }, sendFirst)).toBe(false);
    expect(M.followUpPending(null, sendFirst)).toBe(false);
    // a send-first row promoted to live has left the follow-up lifecycle: the draft is no longer pending (the sender refuses it by the same rule) — an ambiguous send stays pinned
    expect(M.followUpPending({ ...contacted, status: 'live' }, sendFirst)).toBe(false);
    expect(M.followUpPending({ ...contacted, status: 'live', follow_up_status: 'sending' }, sendFirst)).toBe(true);
    // the Judge-owned statuses follow up on a submit-first path
    for (const st of ['placed', 'live', 'indexed']) expect(M.followUpPending({ ...contacted, status: st }, submitFirst)).toBe(true);
    expect(M.followUpPending({ ...contacted, status: 'placed' }, sendFirst)).toBe(false);
  });
});

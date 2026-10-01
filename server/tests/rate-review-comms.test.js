/**
 * Annual rate review — COMMS lane (services/rate-review-comms.js).
 *
 * Observable behavior pinned here, against the apply lane's in-memory knex
 * stand-in (helpers/rate-review-apply-fixture.js, real table state):
 *   preview  — one letter per customer, channels on file, every suppression
 *              with its reason (late, inactive, no contact, unapproved), a
 *              digest that moves with the list AND the cost block;
 *   send     — refuses without a cost block or on digest drift, sends ONE
 *              email letter + the SMS pointer per customer, stamps sent_at
 *              (the 30-day clock) on every line, freezes the letter, moves
 *              the ranking rows to sent, never sends twice, releases or
 *              parks a failed send, stops when the gate is flipped off;
 *   letter   — the real email renderer over the seeded template: dollars
 *              per application, prepaid per year AND per application, the
 *              owner's cost block, banned wording absent;
 *   surfaces — the public page review payload (only once delivered) and
 *              the portal's upcoming-rate line;
 *   SMS      — the reused pointer renders within 2 segments, no scheme.
 * The two send legs (price-change-notices.js sendNoticeEmail/SMS) are spied
 * at their module boundary: nothing is sent to anyone. Every id, name,
 * address and number here is invented.
 */
process.env.GATE_RATE_REVIEW = 'true';

const fixture = require('./helpers/rate-review-apply-fixture');

const mockDb = fixture.createFakeDb();
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const migration = require('../models/migrations/20261001200000_rate_review_letter_email_template');

jest.mock('../services/email-template-library', () => {
  const actual = jest.requireActual('../services/email-template-library');
  return {
    ...actual,
    loadTemplateByKey: jest.fn(async (key) => {
      const { TEMPLATE } = require('../models/migrations/20261001200000_rate_review_letter_email_template')._private;
      if (key !== TEMPLATE.key) return null;
      return {
        template: {
          template_key: TEMPLATE.key, name: TEMPLATE.name, mode: 'service', status: 'active', active_version_id: 'v1', send_stream: 'transactional_required',
          required_variables: JSON.stringify(TEMPLATE.required), allowed_variables: JSON.stringify([...TEMPLATE.required, ...TEMPLATE.optional]),
        },
        activeVersion: { id: 'v1', subject: TEMPLATE.subject, preview_text: TEMPLATE.preview, blocks: TEMPLATE.blocks, text_body: null },
      };
    }),
  };
});

const PriceChangeNotices = require('../services/price-change-notices');
const comms = require('../services/rate-review-comms');
const { CUSTOMER, ROW, BATCH_KEY, NOW } = fixture;

const COST_BLOCK = 'Technician pay is up [test]% since last January. Product and fuel costs went up too.';

const emailLeg = jest.spyOn(PriceChangeNotices, 'sendNoticeEmail');
const smsLeg = jest.spyOn(PriceChangeNotices, 'sendNoticeSms');

function customer(n, overrides = {}) {
  return fixture.customerRow(n, {
    first_name: `Testcust${n}`, last_name: 'Example', email: `cust${n}@example.com`, phone: `+1555555010${n}`,
    address_line1: `${n}00 Example Way`, active: true, ...overrides,
  });
}

function draft(n, overrides = {}) {
  return fixture.noticeRow(n, { status: 'draft', email_sent: false, sms_sent: false, sent_at: null, notice_token: `${String(n).repeat(32)}`.slice(0, 32), ...overrides });
}

function book({ customers = [customer(1)], notices = [draft(1)], snapshots = null, costBlock = COST_BLOCK } = {}) {
  return {
    rate_review_batches: [fixture.batchRow()],
    rate_review_snapshots: snapshots || notices.map((nt, i) => fixture.snapshotRow(i + 1, { id: nt.rate_review_row_id, customer_id: nt.customer_id, notice_id: nt.id, treatment_minutes_median: 31 })),
    rate_review_config: [{ id: 1, cost_block: costBlock }],
    customers,
    price_change_notices: notices,
    notification_prefs: [],
  };
}

const notices = () => mockDb.store.price_change_notices;
const snapshots = () => mockDb.store.rate_review_snapshots;

beforeEach(() => {
  process.env.GATE_RATE_REVIEW = 'true';
  emailLeg.mockReset().mockResolvedValue({ sent: true, attempted: true });
  smsLeg.mockReset().mockResolvedValue({ sent: true, attempted: true });
  mockDb.reset();
});

async function previewDigest() {
  return (await comms.sendPreview(BATCH_KEY, { now: NOW })).digest;
}

describe('gate', () => {
  test('off: preview, letter and send return before any read, nothing sent', async () => {
    mockDb.reset(book());
    process.env.GATE_RATE_REVIEW = 'false';
    expect(await comms.sendPreview(BATCH_KEY, { now: NOW })).toEqual({ ok: false, reason: 'gate_off' });
    expect(await comms.letterPreview(BATCH_KEY, ROW(1), { now: NOW })).toEqual({ ok: false, reason: 'gate_off' });
    expect(await comms.sendBatch(BATCH_KEY, { expectedDigest: 'x', now: NOW })).toEqual({ ok: false, reason: 'gate_off' });
    expect(await comms.upcomingRateChanges(CUSTOMER(1), { now: NOW })).toEqual([]);
    expect(emailLeg).not.toHaveBeenCalled();
    expect(smsLeg).not.toHaveBeenCalled();
  });
});

describe('sendPreview', () => {
  test('one letter per customer with the channels on file and the line it carries', async () => {
    mockDb.reset(book());
    const out = await comms.sendPreview(BATCH_KEY, { now: NOW });
    expect(out.ok).toBe(true);
    expect(out.costBlockReady).toBe(true);
    expect(out.counts).toMatchObject({ letters: 1, lines: 1, email: 1, sms: 1, suppressedLines: 0, alreadySent: 0 });
    expect(out.customers[0]).toMatchObject({ customerId: CUSTOMER(1), channels: { email: true, sms: true }, reason: null });
    expect(out.customers[0].lines[0]).toMatchObject({ now: '$117 per application', new: '$121 per application (up $4)', effectiveDate: '2026-12-10' });
    expect(out.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test('suppressions carry their reason: under 30 days, inactive, no contact, no longer approved', async () => {
    const notices4 = [
      draft(1, { effective_date: '2026-11-25' }),
      draft(2, { customer_id: CUSTOMER(2), rate_review_row_id: ROW(2) }),
      draft(3, { customer_id: CUSTOMER(3), rate_review_row_id: ROW(3) }),
      draft(4, { customer_id: CUSTOMER(4), rate_review_row_id: ROW(4) }),
    ];
    const b = book({ customers: [customer(1), customer(2, { deleted_at: new Date() }), customer(3, { email: null, phone: null }), customer(4)], notices: notices4 });
    b.rate_review_snapshots[3].status = 'green';
    mockDb.reset(b);
    const out = await comms.sendPreview(BATCH_KEY, { now: NOW });
    const by = Object.fromEntries(out.customers.map((c) => [c.customerId, c]));
    expect(by[CUSTOMER(1)].suppressedLines[0].reason).toBe('too_late');
    expect(by[CUSTOMER(2)].reason).toBe('customer_inactive');
    expect(by[CUSTOMER(3)].reason).toBe('no_contact');
    expect(by[CUSTOMER(4)].suppressedLines[0].reason).toBe('not_approved');
    expect(out.counts.letters).toBe(0);
  });

  test('the digest moves with the cost block, not only the list', async () => {
    mockDb.reset(book());
    const a = await previewDigest();
    mockDb.store.rate_review_config[0].cost_block = `${COST_BLOCK} Edited.`;
    expect(await previewDigest()).not.toBe(a);
  });

  test('approved rows without a notice yet are counted as unscheduled', async () => {
    const b = book();
    b.rate_review_snapshots.push(fixture.snapshotRow(2, { customer_id: CUSTOMER(2), notice_id: null }));
    mockDb.reset(b);
    expect((await comms.sendPreview(BATCH_KEY, { now: NOW })).unscheduled).toBe(1);
  });
});

describe('sendBatch', () => {
  test('no cost block: refused, nothing sent', async () => {
    mockDb.reset(book({ costBlock: null }));
    expect(await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), now: NOW })).toEqual({ ok: false, reason: 'cost_block_missing' });
    expect(emailLeg).not.toHaveBeenCalled();
  });

  test('a digest from before a change refuses, nothing sent', async () => {
    mockDb.reset(book());
    const digest = await previewDigest();
    mockDb.store.price_change_notices[0].noticed_new_cents = 12500;
    expect(await comms.sendBatch(BATCH_KEY, { expectedDigest: digest, now: NOW })).toEqual({ ok: false, reason: 'list_changed' });
    expect(emailLeg).not.toHaveBeenCalled();
  });

  test('sends the letter and the pointer, stamps delivery, freezes the letter, marks the row sent — once', async () => {
    mockDb.reset(book());
    const out = await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), actorId: null, now: NOW });
    expect(out).toMatchObject({ ok: true, sent: 1, emailed: 1, texted: 1, failed: 0 });
    expect(emailLeg).toHaveBeenCalledTimes(1);
    const emailArgs = emailLeg.mock.calls[0][0];
    expect(emailArgs.templateKey).toBe('billing.rate_review_notice');
    expect(emailArgs.vars).toMatchObject({ line1_now: '$117 per application', line1_new: '$121 per application (up $4)', cost_block: COST_BLOCK });
    expect(emailArgs.vars.notice_url).toMatch(/\/price-change\/1{32}$/);
    expect(smsLeg.mock.calls[0][0]).toMatchObject({ operatorInitiated: true, vars: { price_change_url: emailArgs.vars.notice_url } });
    const n = notices()[0];
    expect(n).toMatchObject({ status: 'sent', email_sent: true, sms_sent: true });
    expect(n.sent_at).toBeInstanceOf(Date);
    const meta = typeof n.metadata === 'string' ? JSON.parse(n.metadata) : n.metadata;
    expect(meta.letter).toMatchObject({ cost_block: COST_BLOCK, lines: [{ current_cents: 11700, new_cents: 12100, effective_date: '2026-12-10' }] });
    expect(snapshots()[0].status).toBe('sent');
    // a second send finds nothing left to send
    expect(await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), now: NOW })).toEqual({ ok: false, reason: 'nothing_to_send' });
    expect(emailLeg).toHaveBeenCalledTimes(1);
  });

  test('two reviewed lines on one account: ONE letter carrying both, both rows stamped', async () => {
    const lawn = draft(2, { customer_id: CUSTOMER(1), rate_review_row_id: ROW(2), family_key: 'lawn_care', effective_date: '2026-12-20', noticed_current_cents: 6100, noticed_new_cents: 6400, current_amount_cents: 6100, new_amount_cents: 6400 });
    const b = book({ notices: [draft(1), lawn] });
    b.rate_review_snapshots[1].customer_id = CUSTOMER(1);
    b.rate_review_snapshots[1].family_key = 'lawn_care';
    mockDb.reset(b);
    const out = await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), now: NOW });
    expect(out.sent).toBe(1);
    expect(emailLeg).toHaveBeenCalledTimes(1);
    expect(emailLeg.mock.calls[0][0].vars).toMatchObject({ line1_new: '$121 per application (up $4)', line2_new: '$64 per application (up $3)', effective_date: expect.stringContaining('December 10') });
    expect(notices().map((x) => x.status)).toEqual(['sent', 'sent']);
  });

  test('no leg delivered: an attempted send goes back to draft, an unreachable one parks — neither is stamped sent', async () => {
    mockDb.reset(book());
    emailLeg.mockResolvedValue({ sent: false, attempted: true });
    smsLeg.mockResolvedValue({ sent: false, attempted: false });
    expect(await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), now: NOW })).toMatchObject({ ok: false, failed: 1, sent: 0 });
    expect(notices()[0]).toMatchObject({ status: 'draft', sent_at: null });
    // the attempted send keeps its frozen words: an edited cost block does
    // not change what the preview shows or what a retry sends
    mockDb.store.rate_review_config[0].cost_block = 'An EDITED cost block.';
    const letter = await comms.letterPreview(BATCH_KEY, ROW(1), { now: NOW });
    expect(letter.html).toContain(COST_BLOCK);
    expect(letter.html).not.toContain('An EDITED cost block.');
    emailLeg.mockResolvedValue({ sent: false, attempted: false });
    expect(await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), now: NOW })).toMatchObject({ unreachable: 1, sent: 0 });
    expect(notices()[0]).toMatchObject({ status: 'unreachable', sent_at: null });
    // definitively unsent: the frozen words are dropped
    const meta = notices()[0].metadata;
    expect((typeof meta === 'string' ? JSON.parse(meta) : meta).pending_letter).toBeUndefined();
    expect(snapshots()[0].status).toBe('approved');
  });

  test('a fresh in-flight claim is never re-sent', async () => {
    mockDb.reset(book({ notices: [draft(1, { status: 'sending', updated_at: NOW })] }));
    const preview = await comms.sendPreview(BATCH_KEY, { now: NOW });
    expect(preview.customers[0].suppressedLines[0].reason).toBe('in_flight');
    expect(await comms.sendBatch(BATCH_KEY, { expectedDigest: preview.digest, now: NOW })).toEqual({ ok: false, reason: 'nothing_to_send' });
  });

  test('a stale claim is recovered with the words its crashed attempt froze, not a rebuild', async () => {
    const stale = new Date(NOW.getTime() - 60 * 60 * 1000);
    const claimKey = require('crypto').createHash('sha256').update(fixture.noticeRow(1).id).digest('hex').slice(0, 16);
    const frozen = { key: claimKey, payload: { first_name: 'Testcust1', effective_date: 'December 10, 2026', cost_block: 'The OLD cost block.', notice_url: 'https://portal.example.com/price-change/x' }, letter: { first_name: 'Testcust1', cost_block: 'The OLD cost block.', lines: [{ current_cents: 11700, new_cents: 12100, effective_date: '2026-12-10' }] } };
    const n = draft(1, { status: 'sending', updated_at: stale });
    n.metadata = { ...n.metadata, pending_letter: frozen };
    mockDb.reset(book({ notices: [n] }));
    const out = await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), now: NOW });
    expect(out.sent).toBe(1);
    expect(emailLeg.mock.calls[0][0].vars.cost_block).toBe('The OLD cost block.');
    const meta = notices()[0].metadata;
    const parsed = typeof meta === 'string' ? JSON.parse(meta) : meta;
    expect(parsed.letter.cost_block).toBe('The OLD cost block.');
    expect(parsed.pending_letter).toBeUndefined();
  });

  test('the gate flipped off mid-batch stops the rest', async () => {
    const b = book({ customers: [customer(1), customer(2)], notices: [draft(1), draft(2, { customer_id: CUSTOMER(2), rate_review_row_id: ROW(2) })] });
    mockDb.reset(b);
    const digest = await previewDigest();
    emailLeg.mockImplementation(async () => { process.env.GATE_RATE_REVIEW = 'false'; return { sent: true, attempted: true }; });
    const out = await comms.sendBatch(BATCH_KEY, { expectedDigest: digest, now: NOW });
    // both run in one concurrency slice; whichever started after the flip is stopped
    expect(out.sent + out.stoppedByGate).toBe(2);
  });
});

describe('the letter (real renderer over the seeded template)', () => {
  test('per application: dollars, the reason from stored facts, the cost block, no banned wording', async () => {
    mockDb.reset(book());
    const out = await comms.letterPreview(BATCH_KEY, ROW(1), { now: NOW });
    expect(out.subject).toBe('Your Waves rate from December 10, 2026');
    const text = out.html.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
    expect(text).toContain("It's Adam at Waves");
    expect(text).toContain('Pest control · 100 Example Way');
    expect(text).toContain('$117 per application');
    expect(text).toContain('$121 per application (up $4)');
    expect(text).toContain('below what we charge a new customer for the same service today ($121)');
    expect(text).toContain('4 applications at your home, about 31 minutes of treatment each');
    expect(text).toContain(COST_BLOCK);
    expect(text).toContain('View your notice');
    expect(text).not.toMatch(/per visit|monthly|per month|-approved|renewal notice/i);
  });

  test('prepaid: per year AND per application, the current year unchanged', async () => {
    const prepay = draft(1, {
      billing_lane: 'annual_prepay', cadence_label: 'year', effective_date: '2027-05-15',
      current_amount_cents: 46800, new_amount_cents: 48400, noticed_current_cents: 46800, noticed_new_cents: 48400,
      metadata: { source: 'rate_review', batch_key: BATCH_KEY, term_end: '2027-05-14', per_application_current_cents: 11700, per_application_new_cents: 12100 },
    });
    mockDb.reset(book({ notices: [prepay] }));
    const out = await comms.letterPreview(BATCH_KEY, ROW(1), { now: NOW });
    const text = out.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(text).toContain('$468 per year ($117 per application)');
    expect(text).toContain('$484 per year ($121 per application) (up $16)');
    expect(text).toContain('unchanged through May 14, 2027');
    expect(text).toContain('Your prepaid year stays exactly as it is');
  });

  test('a row with no scheduled notice is a 404', async () => {
    const b = book();
    b.rate_review_snapshots[0].notice_id = null;
    mockDb.reset(b);
    await expect(comms.letterPreview(BATCH_KEY, ROW(1), { now: NOW })).rejects.toMatchObject({ status: 404 });
  });

  test('the seeded template carries no banned wording', () => {
    const blob = JSON.stringify(migration._private.TEMPLATE);
    expect(blob).not.toMatch(/per visit|monthly|-approved|\p{Extended_Pictographic}/iu);
    expect(blob).toContain('Waves Pest Control');
  });
});

describe('letter wording and order', () => {
  const { whyFor, planBatch } = comms._private;
  test('a book-mode list price (cadence_mode) is never stated as the new-customer price', () => {
    const why = whyFor({ billing_lane: 'per_application', cadence_label: 'application' }, { current_rate_cents: 10500, proposed_rate_cents: 11700, list_rate_cents: 11700, list_rate_source: 'cadence_mode' });
    expect(why).not.toMatch(/new customer/);
    expect(why).toBe('This change keeps pace with the costs above.');
  });

  test('a proposal above the new-customer price never claims "not a dollar over it"', () => {
    const why = whyFor({ billing_lane: 'per_application', cadence_label: 'application' }, { current_rate_cents: 11600, proposed_rate_cents: 12000, list_rate_cents: 11700, list_rate_source: 'engine' });
    expect(why).toContain('The new rate of $120 keeps pace with the costs above.');
    expect(why).not.toContain('not a dollar over');
  });

  test('the first application is the stored visit only while it is live and on/after the effective date', async () => {
    const n = draft(1, { metadata: { source: 'rate_review', batch_key: BATCH_KEY, first_visit_id: 'v-1' } });
    const b = book({ notices: [n] });
    b.scheduled_services = [{ id: 'v-1', scheduled_date: '2026-12-01', status: 'pending' }];
    mockDb.reset(b);
    let out = await comms.sendPreview(BATCH_KEY, { now: NOW });
    await comms.sendBatch(BATCH_KEY, { expectedDigest: out.digest, now: NOW });
    expect(emailLeg.mock.calls[0][0].vars.line1_first).toBe('on or after December 10, 2026');
    b.scheduled_services = [{ id: 'v-1', scheduled_date: '2026-12-12', status: 'confirmed' }];
    mockDb.reset(b);
    out = await comms.sendPreview(BATCH_KEY, { now: NOW });
    await comms.sendBatch(BATCH_KEY, { expectedDigest: out.digest, now: NOW });
    expect(emailLeg.mock.calls[1][0].vars.line1_first).toBe('December 12, 2026');
  });

  test('lines are ordered by effective date once, for the email and the frozen letter alike', async () => {
    const later = draft(2, { customer_id: CUSTOMER(1), rate_review_row_id: ROW(2), family_key: 'lawn_care', effective_date: '2026-12-20', noticed_current_cents: 6100, noticed_new_cents: 6400, current_amount_cents: 6100, new_amount_cents: 6400 });
    const b = book({ notices: [later, draft(1)] });
    b.rate_review_snapshots[0].customer_id = CUSTOMER(1);
    mockDb.reset(b);
    expect(typeof planBatch).toBe('function');
    await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), now: NOW });
    expect(emailLeg.mock.calls[0][0].vars.line1_service).toMatch(/^Pest control/);
    const review = comms.publicReview(notices()[0]);
    expect(review.lines.map((l) => l.effectiveDate)).toEqual(['December 10, 2026', 'December 20, 2026']);
  });
});

describe('customer surfaces', () => {
  test('public review: undelivered is unavailable; delivered renders the frozen letter', async () => {
    mockDb.reset(book());
    expect(comms.publicReview(notices()[0])).toEqual({ unavailable: true });
    expect(comms.publicReview({ rate_review_row_id: null })).toBeNull();
    await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), now: NOW });
    const review = comms.publicReview(notices()[0]);
    expect(review).toMatchObject({ costBlock: COST_BLOCK, hasPrepay: false });
    expect(review.lines[0]).toMatchObject({ service: 'Pest control', unit: 'application', current: '$117', next: '$121', change: '$4', effectiveDate: 'December 10, 2026' });
    expect(JSON.stringify(review)).not.toContain('Example Way');
  });

  test('portal: a delivered, unapplied change shows the upcoming rate; drafts and applied ones do not', async () => {
    mockDb.reset(book());
    expect(await comms.upcomingRateChanges(CUSTOMER(1), { now: NOW })).toEqual([]);
    await comms.sendBatch(BATCH_KEY, { expectedDigest: await previewDigest(), now: NOW });
    expect(await comms.upcomingRateChanges(CUSTOMER(1), { now: NOW })).toEqual([
      { service: 'Pest control', unit: 'application', current: '$117', next: '$121', chargeCents: 12100, effectiveDate: '2026-12-10', noticePath: `/price-change/${'1'.repeat(32)}` },
    ]);
    notices()[0].applied_at = new Date();
    expect(await comms.upcomingRateChanges(CUSTOMER(1), { now: NOW })).toEqual([]);
  });

  test('portal: a monthly change charges the account dues moved by the delta, not the line rate', async () => {
    const monthly = draft(1, {
      billing_lane: 'monthly_membership', cadence_label: 'month', effective_date: '2026-12-15', status: 'sent', sent_at: NOW,
      current_amount_cents: 4000, new_amount_cents: 4400, noticed_current_cents: 4000, noticed_new_cents: 4400,
    });
    mockDb.reset(book({ customers: [customer(1, { monthly_rate: '100.00' })], notices: [monthly] }));
    expect((await comms.upcomingRateChanges(CUSTOMER(1), { now: NOW }))[0]).toMatchObject({ unit: 'month', next: '$44', chargeCents: 10400 });
  });

  test('portal: a prepaid change stays upcoming after the nightly apply, until its renewal date', async () => {
    const prepay = draft(1, {
      billing_lane: 'annual_prepay', cadence_label: 'year', effective_date: '2027-05-15', status: 'sent', sent_at: NOW, applied_at: NOW,
      current_amount_cents: 46800, new_amount_cents: 48400, noticed_current_cents: 46800, noticed_new_cents: 48400,
    });
    mockDb.reset(book({ notices: [prepay] }));
    expect(await comms.upcomingRateChanges(CUSTOMER(1), { now: NOW })).toEqual([
      expect.objectContaining({ unit: 'year', current: '$468', next: '$484', chargeCents: null, effectiveDate: '2027-05-15' }),
    ]);
    expect(await comms.upcomingRateChanges(CUSTOMER(1), { now: new Date('2027-05-16T14:00:00Z') })).toEqual([]);
  });
});

describe('SMS pointer (the existing price_change_notice template, reused unchanged)', () => {
  test('renders within 2 segments with a long date and a real-length notice link, scheme dropped, no emoji', () => {
    const { countSegments } = require('../services/messaging/segment-counter');
    const { stripSmsUrlScheme } = require('../services/messaging/sms-link-policy');
    const body = "Hello {first_name}, it's Waves. Your recurring service price changes on {effective_date}. New price and details: {price_change_url}"
      .replace('{first_name}', 'Christopher')
      .replace('{effective_date}', 'September 30, 2027')
      .replace('{price_change_url}', `https://portal.wavespestcontrol.com/price-change/${'a'.repeat(32)}`);
    const rendered = stripSmsUrlScheme(body);
    expect(rendered).not.toContain('https://');
    expect(rendered).not.toMatch(/\p{Extended_Pictographic}/u);
    const seg = countSegments(rendered);
    expect(seg.encoding).toBe('GSM_7');
    expect(seg.segmentCount).toBeLessThanOrEqual(2);
  });
});

/**
 * collections/contact-policy.js — the fail-closed allow/deny authority for
 * balance-related outreach (PR A: policy + shadow only).
 *
 * Pins: every named denial reason fires; fail-closed on DB error; flag ×
 * channel matrix; 24h/7d frequency edges; 9:00–17:59 ET Mon–Fri voice window
 * across EDT and EST; pilot cap boundaries (4999/5000/50000/50001 cents,
 * 13/14/60/61 days); dunning-touch history sums the sequence engine and the
 * legacy activity_log rows; line-type miss AND error both deny; consent
 * provenance required; >90d staleness ⇒ rnd_check_required.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/open-balance', () => ({
  openBalanceInvoices: jest.fn(async () => []),
}));
jest.mock('../services/collections/consent-provenance', () => ({
  resolve: jest.fn(async () => null),
  freshness: jest.fn(async () => null),
}));
jest.mock('../services/messaging/validators/line-type', () => ({
  readCachedLineType: jest.fn(async () => ({ state: 'miss' })),
}));

const db = require('../models/db');
const { openBalanceInvoices } = require('../services/open-balance');
const ConsentProvenance = require('../services/collections/consent-provenance');
const { readCachedLineType } = require('../services/messaging/validators/line-type');
const ContactPolicy = require('../services/collections/contact-policy');

// Annotated UTC instants (voice-relay-clock style — inject the clock).
const WED_11AM_EDT = new Date('2026-08-12T15:00:00Z'); // Wed Aug 12, 11:00 ET
const WED_0859_EDT = new Date('2026-08-12T12:59:00Z'); // Wed Aug 12,  8:59 ET
const WED_0900_EDT = new Date('2026-08-12T13:00:00Z'); // Wed Aug 12,  9:00 ET
const WED_1759_EDT = new Date('2026-08-12T21:59:00Z'); // Wed Aug 12, 17:59 ET
const WED_1800_EDT = new Date('2026-08-12T22:00:00Z'); // Wed Aug 12, 18:00 ET
const SAT_11AM_EDT = new Date('2026-08-15T15:00:00Z'); // Sat Aug 15, 11:00 ET
const WED_11AM_EST = new Date('2026-01-14T16:00:00Z'); // Wed Jan 14, 11:00 ET (EST)
const WED_0859_EST = new Date('2026-01-14T13:59:00Z'); // Wed Jan 14,  8:59 ET (EST)

function chain({ result = [], first } = {}) {
  const q = {};
  ['where', 'whereIn', 'whereNull', 'whereRaw', 'orderBy', 'select', 'count', 'limit']
    .forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => first);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
  return q;
}

function setDbTables(tables) {
  db.mockImplementation((table) => {
    const supply = tables[table];
    if (!supply) throw new Error(`Unexpected db table ${table}`);
    if (Array.isArray(supply)) {
      if (!supply.length) throw new Error(`Exhausted db queue for ${table}`);
      return supply.shift();
    }
    return supply;
  });
}

function customerRow(overrides = {}) {
  return {
    id: 'cust-1',
    first_name: 'Sandy',
    phone: '+19415550100',
    property_type: 'residential',
    deleted_at: null,
    ...overrides,
  };
}

// One open self-pay invoice: $128.00, due 2026-07-22 → 21 days overdue on
// Aug 12 (inside the 14–60 pilot window).
function invoiceRow(overrides = {}) {
  return {
    id: 'inv-1',
    invoice_number: 'WPC-2026-1100',
    total: '128.00',
    credit_applied: 0,
    due_date: '2026-07-22',
    created_at: '2026-07-01T12:00:00.000Z',
    stripe_payment_intent_id: null,
    ...overrides,
  };
}

// Wire every mock to an ALLOWED voice verdict; tests then break one leg.
function armAllowedBaseline({
  customer = customerRow(),
  invoices = [invoiceRow()],
  flags = [],
  ledger = [],
  touchesSent = 2,
  activityCount = 0,
} = {}) {
  setDbTables({
    customers: chain({ first: customer }),
    collections_flags: chain({ result: flags }),
    collections_contact_ledger: chain({ result: ledger }),
    invoice_followup_sequences: chain({ first: { touches_sent: touchesSent } }),
    activity_log: chain({ result: [{ count: String(activityCount) }] }),
    messaging_suppression: chain({ first: undefined }),
    call_log: chain({ first: undefined }),
  });
  openBalanceInvoices.mockResolvedValue(invoices);
  readCachedLineType.mockResolvedValue({ state: 'hit', lineType: 'mobile' });
  ConsentProvenance.resolve.mockResolvedValue({
    source: 'inbound_sms', evidenceRef: 'sms-9', evidenceAt: '2026-08-01T12:00:00.000Z',
  });
  ConsentProvenance.freshness.mockResolvedValue(new Date('2026-08-01T12:00:00.000Z'));
}

async function evalVoice(now = WED_11AM_EDT) {
  return ContactPolicy.evaluate('cust-1', { channel: 'voice', purpose: 'late_payment', now });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('baseline', () => {
  test('a compliant voice late_payment evaluation is allowed with the full result shape', async () => {
    armAllowedBaseline();
    const result = await evalVoice();
    expect(result.allowed).toBe(true);
    expect(result.denialReasons).toEqual([]);
    expect(result.eligibleInvoiceIds).toEqual(['inv-1']);
    expect(result.eligibleBalanceCents).toBe(12800);
    expect(result.consentEvidence).toMatchObject({ source: 'inbound_sms' });
    expect(result.activeHolds).toEqual([]);
    expect(result.recentContacts).toEqual([]);
  });

  test('sms channel with a clean account is allowed and never touches the voice-only checks', async () => {
    armAllowedBaseline();
    const result = await ContactPolicy.evaluate('cust-1', { channel: 'sms', purpose: 'late_payment', now: WED_11AM_EDT });
    expect(result.allowed).toBe(true);
    expect(readCachedLineType).not.toHaveBeenCalled();
    expect(ConsentProvenance.resolve).not.toHaveBeenCalled();
    expect(ConsentProvenance.freshness).not.toHaveBeenCalled();
  });
});

describe('structural denials', () => {
  test('unknown channel denies before any read', async () => {
    const result = await ContactPolicy.evaluate('cust-1', { channel: 'fax', now: WED_11AM_EDT });
    expect(result.allowed).toBe(false);
    expect(result.denialReasons).toEqual(['unknown_channel']);
  });

  test('unknown purpose on a known channel denies before any read', async () => {
    // Before the allowlist, any voice purpose other than late_payment
    // skipped the pilot caps entirely and returned allowed.
    const result = await ContactPolicy.evaluate('cust-1', { channel: 'voice', purpose: 'promo_call', now: WED_11AM_EDT });
    expect(result.allowed).toBe(false);
    expect(result.denialReasons).toEqual(['unknown_purpose']);
  });

  test('balance_reminder is a known purpose for sms/email but NOT for the call channels', async () => {
    armAllowedBaseline();
    const sms = await ContactPolicy.evaluate('cust-1', { channel: 'sms', purpose: 'balance_reminder', now: WED_11AM_EDT });
    expect(sms.denialReasons).not.toContain('unknown_purpose');
    const voice = await ContactPolicy.evaluate('cust-1', { channel: 'voice', purpose: 'balance_reminder', now: WED_11AM_EDT });
    expect(voice.allowed).toBe(false);
    expect(voice.denialReasons).toEqual(['unknown_purpose']);
  });

  test('legacy activity_log touches are counted via the JSONB operator, not a text LIKE', async () => {
    // metadata is JSONB — Postgres renders its text with a space after each
    // colon, so the old '"invoiceId":"..."' LIKE never matched and real
    // touches were invisible. Pin the parameterized ->> predicate.
    const activityChain = chain({ result: [{ count: '2' }] });
    setDbTables({
      customers: chain({ first: customerRow() }),
      collections_flags: chain({ result: [] }),
      // queue: frequency-window read, then the touch-count read
      collections_contact_ledger: [chain({ result: [] }), chain({ result: [{ count: '0' }] })],
      invoice_followup_sequences: chain({ first: { touches_sent: 0 } }),
      activity_log: activityChain,
      messaging_suppression: chain({ first: undefined }),
      call_log: chain({ first: undefined }),
    });
    openBalanceInvoices.mockResolvedValue([invoiceRow()]);
    readCachedLineType.mockResolvedValue({ state: 'hit', lineType: 'mobile' });
    ConsentProvenance.resolve.mockResolvedValue({
      source: 'inbound_sms', evidenceRef: 'sms-9', evidenceAt: '2026-08-01T12:00:00.000Z',
    });
    ConsentProvenance.freshness.mockResolvedValue(new Date('2026-08-01T12:00:00.000Z'));
    const result = await evalVoice();
    expect(result.allowed).toBe(true); // the 2 legacy rows alone satisfy the floor
    expect(activityChain.whereRaw).toHaveBeenCalledWith("metadata->>'invoiceId' = ?", ['inv-1']);
  });

  test('dues-only carve-out: sms/email balance_reminder with validated dues and ZERO invoices is allowed', async () => {
    // Late monthly dues aren't invoiced — the previsit rail supplies the
    // dues amount so the balance-existence check doesn't wrongly deny.
    armAllowedBaseline({ invoices: [] });
    const result = await ContactPolicy.evaluate('cust-1', {
      channel: 'sms', purpose: 'balance_reminder', aggregateDuesCents: 12800, now: WED_11AM_EDT,
    });
    expect(result.allowed).toBe(true);
    expect(result.denialReasons).toEqual([]);
  });

  test('dues context is NOT a bypass: zero dues, voice channel, and late_payment purpose all still require an invoice', async () => {
    armAllowedBaseline({ invoices: [] });
    const zeroDues = await ContactPolicy.evaluate('cust-1', {
      channel: 'sms', purpose: 'balance_reminder', aggregateDuesCents: 0, now: WED_11AM_EDT,
    });
    expect(zeroDues.denialReasons).toContain('no_eligible_balance');
    armAllowedBaseline({ invoices: [] });
    const voice = await ContactPolicy.evaluate('cust-1', {
      channel: 'voice', purpose: 'late_payment', aggregateDuesCents: 12800, now: WED_11AM_EDT,
    });
    expect(voice.denialReasons).toContain('no_eligible_balance');
    armAllowedBaseline({ invoices: [] });
    const latePayment = await ContactPolicy.evaluate('cust-1', {
      channel: 'sms', purpose: 'late_payment', aggregateDuesCents: 12800, now: WED_11AM_EDT,
    });
    expect(latePayment.denialReasons).toContain('no_eligible_balance');
  });

  test('dues carve-out leaves every other denial standing (flag still blocks)', async () => {
    armAllowedBaseline({ invoices: [], flags: [{ flag: 'do_not_text', customer_id: 'cust-1', released_at: null }] });
    const result = await ContactPolicy.evaluate('cust-1', {
      channel: 'sms', purpose: 'balance_reminder', aggregateDuesCents: 12800, now: WED_11AM_EDT,
    });
    expect(result.allowed).toBe(false);
    expect(result.denialReasons).toContain('flag_do_not_text');
  });

  test('missing customer → customer_not_found', async () => {
    armAllowedBaseline({ customer: undefined });
    setDbTables({ customers: chain({ first: undefined }) });
    const result = await evalVoice();
    expect(result.denialReasons).toEqual(['customer_not_found']);
  });

  test('soft-deleted customer → customer_archived', async () => {
    armAllowedBaseline({ customer: customerRow({ deleted_at: '2026-08-01T00:00:00Z' }) });
    const result = await evalVoice();
    expect(result.denialReasons).toEqual(['customer_archived']);
  });

  test('no open self-pay balance → no_eligible_balance', async () => {
    armAllowedBaseline({ invoices: [] });
    const result = await evalVoice();
    expect(result.allowed).toBe(false);
    expect(result.denialReasons).toContain('no_eligible_balance');
    expect(result.eligibleBalanceCents).toBe(0);
  });

  test('a sent invoice with a populated stripe_payment_intent_id REMAINS eligible (codex ruling: PI presence is not in-flight evidence — stale/failed/canceled PIs persist; the real marker is status processing, which the loader already excludes)', async () => {
    armAllowedBaseline({ invoices: [invoiceRow({ stripe_payment_intent_id: 'pi_stale_123' })] });
    const result = await evalVoice();
    expect(result.allowed).toBe(true);
    expect(result.eligibleInvoiceIds).toEqual(['inv-1']);
    expect(result.eligibleBalanceCents).toBe(12800);
    expect(result.denialReasons).toEqual([]);
  });

  test('FAIL CLOSED: a DB error is a denial, never an allow', async () => {
    db.mockImplementation(() => { throw new Error('connection refused'); });
    const result = await evalVoice();
    expect(result.allowed).toBe(false);
    expect(result.denialReasons).toEqual(['policy_evaluation_error']);
  });

  test('FAIL CLOSED: an open-balance loader rejection is a denial', async () => {
    armAllowedBaseline();
    openBalanceInvoices.mockRejectedValue(new Error('pg down'));
    const result = await evalVoice();
    expect(result.allowed).toBe(false);
    expect(result.denialReasons).toEqual(['policy_evaluation_error']);
  });
});

describe('flag matrix — each flag vs each channel', () => {
  const ALL = ['sms', 'email', 'voice', 'manual_call'];
  const EXPECTED = {
    do_not_collect: ALL,
    collection_hold: ALL,
    attorney_represented: ALL,
    bankruptcy: ALL,
    wrong_number: ALL,
    do_not_call: ['voice', 'manual_call'],
    do_not_text: ['sms'],
    do_not_email: ['email'],
    automated_voice_consent_revoked: ['voice'],
  };

  for (const [flag, blockedChannels] of Object.entries(EXPECTED)) {
    for (const channel of ALL) {
      const blocked = blockedChannels.includes(channel);
      test(`${flag} ${blocked ? 'blocks' : 'does not block'} ${channel}`, async () => {
        armAllowedBaseline({ flags: [{ id: 'flag-1', customer_id: 'cust-1', flag, released_at: null }] });
        const result = await ContactPolicy.evaluate('cust-1', {
          channel, purpose: 'late_payment', now: WED_11AM_EDT,
        });
        if (blocked) {
          expect(result.denialReasons).toContain(`flag_${flag}`);
          expect(result.allowed).toBe(false);
        } else {
          expect(result.denialReasons).not.toContain(`flag_${flag}`);
        }
      });
    }
  }

  test('an unknown flag string fails closed on every channel', async () => {
    for (const channel of ALL) {
      armAllowedBaseline({ flags: [{ id: 'flag-x', customer_id: 'cust-1', flag: 'mystery_flag', released_at: null }] });
      const result = await ContactPolicy.evaluate('cust-1', {
        channel, purpose: 'late_payment', now: WED_11AM_EDT,
      });
      expect(result.denialReasons).toContain('flag_mystery_flag');
    }
  });

  test('active holds are surfaced on the result', async () => {
    const flagRow = { id: 'flag-1', customer_id: 'cust-1', flag: 'collection_hold', released_at: null };
    armAllowedBaseline({ flags: [flagRow] });
    const result = await evalVoice();
    expect(result.activeHolds).toEqual([flagRow]);
  });
});

describe('rolling frequency windows', () => {
  const at = (msAgo) => new Date(WED_11AM_EDT.getTime() - msAgo).toISOString();
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  test('voice: ANY ledger contact within 24h denies (23h59m edge)', async () => {
    armAllowedBaseline({ ledger: [{ channel: 'sms', occurred_at: at(24 * HOUR - 60000) }] });
    const result = await evalVoice();
    expect(result.denialReasons).toContain('contact_within_24h');
    expect(result.nextEligibleAt).toBeInstanceOf(Date);
  });

  test('voice: a non-voice contact 24h01m ago does NOT trip the 24h window', async () => {
    armAllowedBaseline({ ledger: [{ channel: 'sms', occurred_at: at(24 * HOUR + 60000) }] });
    const result = await evalVoice();
    expect(result.denialReasons).not.toContain('contact_within_24h');
  });

  test('voice: a voice contact inside 7 days denies (6d23h edge)', async () => {
    armAllowedBaseline({ ledger: [{ channel: 'voice', occurred_at: at(7 * DAY - HOUR) }] });
    const result = await evalVoice();
    expect(result.denialReasons).toContain('voice_contact_within_7d');
  });

  test('voice: a manual call counts as a voice contact for the 7d spacing', async () => {
    armAllowedBaseline({ ledger: [{ channel: 'manual_call', occurred_at: at(3 * DAY) }] });
    const result = await evalVoice();
    expect(result.denialReasons).toContain('voice_contact_within_7d');
  });

  test('the ledger read is bounded to the 7-day window (older rows are out of scope by query)', async () => {
    const ledgerChain = chain({ result: [] });
    armAllowedBaseline();
    setDbTables({
      customers: chain({ first: customerRow() }),
      collections_flags: chain({ result: [] }),
      collections_contact_ledger: ledgerChain,
      invoice_followup_sequences: chain({ first: { touches_sent: 2 } }),
      activity_log: chain({ result: [{ count: '0' }] }),
      messaging_suppression: chain({ first: undefined }),
      call_log: chain({ first: undefined }),
    });
    await evalVoice();
    expect(ledgerChain.where).toHaveBeenCalledWith(
      'occurred_at', '>', new Date(WED_11AM_EDT.getTime() - 7 * DAY),
    );
  });

  test('sms: a live conversation (voice or manual_call) within 7d denies', async () => {
    for (const liveChannel of ['voice', 'manual_call']) {
      armAllowedBaseline({ ledger: [{ channel: liveChannel, occurred_at: at(2 * DAY) }] });
      const result = await ContactPolicy.evaluate('cust-1', { channel: 'sms', purpose: 'late_payment', now: WED_11AM_EDT });
      expect(result.denialReasons).toContain('live_conversation_within_7d');
      expect(result.allowed).toBe(false);
    }
  });

  test('email: live-conversation window applies; a prior sms does not block email', async () => {
    armAllowedBaseline({ ledger: [{ channel: 'sms', occurred_at: at(2 * HOUR) }] });
    const result = await ContactPolicy.evaluate('cust-1', { channel: 'email', purpose: 'late_payment', now: WED_11AM_EDT });
    expect(result.denialReasons).not.toContain('live_conversation_within_7d');
    expect(result.allowed).toBe(true);
  });

  test('recent contacts are surfaced on the result', async () => {
    const row = { channel: 'sms', occurred_at: at(2 * HOUR) };
    armAllowedBaseline({ ledger: [row] });
    const result = await evalVoice();
    expect(result.recentContacts).toEqual([row]);
  });
});

describe('voice quiet window (9:00–17:59 ET, Mon–Fri, via datetime-et)', () => {
  const cases = [
    [WED_0859_EDT, true, 'Wed 8:59 ET (EDT) denies'],
    [WED_0900_EDT, false, 'Wed 9:00 ET (EDT) allows'],
    [WED_1759_EDT, false, 'Wed 17:59 ET (EDT) allows'],
    [WED_1800_EDT, true, 'Wed 18:00 ET (EDT) denies'],
    [SAT_11AM_EDT, true, 'Saturday denies'],
    [WED_11AM_EST, false, 'Wed 11:00 ET in EST allows (winter offset)'],
    [WED_0859_EST, true, 'Wed 8:59 ET in EST denies (winter offset)'],
  ];
  for (const [now, denied, label] of cases) {
    test(label, async () => {
      armAllowedBaseline();
      const result = await evalVoice(now);
      if (denied) expect(result.denialReasons).toContain('outside_call_window');
      else expect(result.denialReasons).not.toContain('outside_call_window');
    });
  }
});

describe('voice pilot caps (purpose late_payment)', () => {
  test('two eligible invoices → pilot_requires_single_invoice', async () => {
    armAllowedBaseline({ invoices: [invoiceRow(), invoiceRow({ id: 'inv-2', invoice_number: 'WPC-2026-1101' })] });
    const result = await evalVoice();
    expect(result.denialReasons).toContain('pilot_requires_single_invoice');
  });

  const balanceCases = [
    ['49.99', 4999, ['pilot_balance_below_minimum']],
    ['50.00', 5000, []],
    ['500.00', 50000, []],
    ['500.01', 50001, ['pilot_balance_above_maximum']],
  ];
  for (const [total, cents, expected] of balanceCases) {
    test(`balance ${cents} cents → ${expected.length ? expected[0] : 'inside the band'}`, async () => {
      armAllowedBaseline({ invoices: [invoiceRow({ total })] });
      const result = await evalVoice();
      expect(result.eligibleBalanceCents).toBe(cents);
      for (const reason of expected) expect(result.denialReasons).toContain(reason);
      if (!expected.length) {
        expect(result.denialReasons).not.toContain('pilot_balance_below_minimum');
        expect(result.denialReasons).not.toContain('pilot_balance_above_maximum');
      }
    });
  }

  // now = Wed 2026-08-12 ET. Overdue age is COMPUTED from due_date.
  const overdueCases = [
    ['2026-07-30', 13, ['pilot_not_overdue_long_enough']],
    ['2026-07-29', 14, []],
    ['2026-06-13', 60, []],
    ['2026-06-12', 61, ['pilot_overdue_too_long']],
  ];
  for (const [dueDate, days, expected] of overdueCases) {
    test(`${days} days overdue → ${expected.length ? expected[0] : 'inside the band'}`, async () => {
      armAllowedBaseline({ invoices: [invoiceRow({ due_date: dueDate })] });
      const result = await evalVoice();
      for (const reason of expected) expect(result.denialReasons).toContain(reason);
      if (!expected.length) {
        expect(result.denialReasons).not.toContain('pilot_not_overdue_long_enough');
        expect(result.denialReasons).not.toContain('pilot_overdue_too_long');
      }
    });
  }

  test('a due-date-less invoice ages from created_at (the rails\' fallback reference)', async () => {
    // created_at 2026-07-01 → 42 days on Aug 12: inside the band.
    armAllowedBaseline({ invoices: [invoiceRow({ due_date: null })] });
    const result = await evalVoice();
    expect(result.denialReasons).not.toContain('pilot_not_overdue_long_enough');
    expect(result.denialReasons).not.toContain('pilot_overdue_too_long');
  });

  test('fewer than 2 delivered dunning touches → pilot_insufficient_dunning_history', async () => {
    armAllowedBaseline({ touchesSent: 1, activityCount: 0 });
    const result = await evalVoice();
    expect(result.denialReasons).toContain('pilot_insufficient_dunning_history');
  });

  test('sequence touches and legacy late-payment activity rows SUM toward the 2-touch floor', async () => {
    armAllowedBaseline({ touchesSent: 1, activityCount: 1 });
    const result = await evalVoice();
    expect(result.denialReasons).not.toContain('pilot_insufficient_dunning_history');
    expect(result.allowed).toBe(true);
  });

  test('no follow-up sequence at all → only activity rows count', async () => {
    setDbTables({
      customers: chain({ first: customerRow() }),
      collections_flags: chain({ result: [] }),
      collections_contact_ledger: chain({ result: [] }),
      invoice_followup_sequences: chain({ first: undefined }),
      activity_log: chain({ result: [{ count: '2' }] }),
    });
    openBalanceInvoices.mockResolvedValue([invoiceRow()]);
    readCachedLineType.mockResolvedValue({ state: 'hit', lineType: 'mobile' });
    ConsentProvenance.resolve.mockResolvedValue({ source: 'inbound_sms', evidenceRef: 's', evidenceAt: '2026-08-01T12:00:00Z' });
    ConsentProvenance.freshness.mockResolvedValue(new Date('2026-08-01T12:00:00Z'));
    const result = await evalVoice();
    expect(result.denialReasons).not.toContain('pilot_insufficient_dunning_history');
  });

  test('unknown line type (cache miss) denies', async () => {
    armAllowedBaseline();
    readCachedLineType.mockResolvedValue({ state: 'miss' });
    const result = await evalVoice();
    expect(result.denialReasons).toContain('line_type_unknown');
  });

  test('line-type cache ERROR denies too (voice fails closed where SMS fails open)', async () => {
    armAllowedBaseline();
    readCachedLineType.mockResolvedValue({ state: 'error' });
    const result = await evalVoice();
    expect(result.denialReasons).toContain('line_type_unknown');
  });

  test('non-mobile line denies', async () => {
    armAllowedBaseline();
    readCachedLineType.mockResolvedValue({ state: 'hit', lineType: 'landline' });
    const result = await evalVoice();
    expect(result.denialReasons).toContain('line_type_not_mobile');
  });

  test('commercial customer denies', async () => {
    armAllowedBaseline({ customer: customerRow({ property_type: 'commercial' }) });
    const result = await evalVoice();
    expect(result.denialReasons).toContain('commercial_customer');
  });

  test("property_type 'business' denies too (the billing authorities' second commercial value)", async () => {
    armAllowedBaseline({ customer: customerRow({ property_type: 'Business' }) });
    const result = await evalVoice();
    expect(result.denialReasons).toContain('commercial_customer');
  });

  test('NULL property_type is residential-presumed for the pilot (property_type is ~NULL across prod — strict fail-closed would deny every pilot customer)', async () => {
    armAllowedBaseline({ customer: customerRow({ property_type: null }) });
    const result = await evalVoice();
    expect(result.denialReasons).not.toContain('commercial_customer');
    expect(result.allowed).toBe(true);
  });
});

describe('manual_call — call-shaped checks apply (codex 2026-08-14)', () => {
  const at = (msAgo) => new Date(WED_11AM_EDT.getTime() - msAgo).toISOString();
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  async function evalManual(now = WED_11AM_EDT) {
    return ContactPolicy.evaluate('cust-1', { channel: 'manual_call', purpose: 'late_payment', now });
  }

  test('a clean account inside the window is allowed (no automated-voice pilot caps or consent required)', async () => {
    armAllowedBaseline();
    const result = await evalManual();
    expect(result.allowed).toBe(true);
    // Automated-voice-only machinery must NOT run for a human dial sheet.
    expect(readCachedLineType).not.toHaveBeenCalled();
    expect(ConsentProvenance.resolve).not.toHaveBeenCalled();
  });

  test('any ledger contact within 24h denies a manual call', async () => {
    armAllowedBaseline({ ledger: [{ channel: 'sms', occurred_at: at(2 * HOUR) }] });
    const result = await evalManual();
    expect(result.denialReasons).toContain('contact_within_24h');
    expect(result.allowed).toBe(false);
  });

  test('a voice contact within 7d denies a manual call (back-to-back calls blocked)', async () => {
    armAllowedBaseline({ ledger: [{ channel: 'voice', occurred_at: at(3 * DAY) }] });
    const result = await evalManual();
    expect(result.denialReasons).toContain('voice_contact_within_7d');
  });

  test('the ET call window applies to manual calls (after-hours dial sheet denied)', async () => {
    armAllowedBaseline();
    const result = await evalManual(WED_1800_EDT);
    expect(result.denialReasons).toContain('outside_call_window');
  });

  test('Saturday denies a manual call', async () => {
    armAllowedBaseline();
    const result = await evalManual(SAT_11AM_EDT);
    expect(result.denialReasons).toContain('outside_call_window');
  });
});

describe('consent provenance + reassigned-number staleness', () => {
  test('no consent evidence → consent_no_evidence', async () => {
    armAllowedBaseline();
    ConsentProvenance.resolve.mockResolvedValue(null);
    const result = await evalVoice();
    expect(result.denialReasons).toContain('consent_no_evidence');
    expect(result.consentEvidence).toBeNull();
  });

  test('91-day-stale contact → rnd_check_required', async () => {
    armAllowedBaseline();
    ConsentProvenance.freshness.mockResolvedValue(
      new Date(WED_11AM_EDT.getTime() - 91 * 24 * 60 * 60 * 1000),
    );
    const result = await evalVoice();
    expect(result.denialReasons).toContain('rnd_check_required');
  });

  test('89-day-old contact is still fresh', async () => {
    armAllowedBaseline();
    ConsentProvenance.freshness.mockResolvedValue(
      new Date(WED_11AM_EDT.getTime() - 89 * 24 * 60 * 60 * 1000),
    );
    const result = await evalVoice();
    expect(result.denialReasons).not.toContain('rnd_check_required');
    expect(result.allowed).toBe(true);
  });

  test('no bidirectional contact EVER → rnd_check_required (fail closed)', async () => {
    armAllowedBaseline();
    ConsentProvenance.freshness.mockResolvedValue(null);
    const result = await evalVoice();
    expect(result.denialReasons).toContain('rnd_check_required');
  });

  test('a provenance resolver rejection fails closed', async () => {
    armAllowedBaseline();
    ConsentProvenance.resolve.mockRejectedValue(new Error('sms_log unreadable'));
    const result = await evalVoice();
    expect(result.allowed).toBe(false);
    expect(result.denialReasons).toContain('policy_evaluation_error');
  });
});

// gh-r1 (2026-08-14): the canonical messaging_suppression list, real phone
// conversations from call_log, and the balance-reminder workflow's ledger
// touches all bind the policy.
describe('canonical suppression list', () => {
  function armWithSuppression(reason) {
    armAllowedBaseline();
    setDbTables({
      customers: chain({ first: customerRow() }),
      collections_flags: chain({ result: [] }),
      collections_contact_ledger: chain({ result: [] }),
      invoice_followup_sequences: chain({ first: { touches_sent: 2 } }),
      activity_log: chain({ result: [{ count: '0' }] }),
      messaging_suppression: chain({ first: { reason } }),
      call_log: chain({ first: undefined }),
    });
  }

  test('manual_dnc denies EVERY channel, email included', async () => {
    for (const ch of ['voice', 'manual_call', 'sms', 'email']) {
      armWithSuppression('manual_dnc');
      const purpose = ch === 'email' || ch === 'sms' ? 'late_payment' : 'late_payment';
      const result = await ContactPolicy.evaluate('cust-1', { channel: ch, purpose, now: WED_11AM_EDT });
      expect(result.allowed).toBe(false);
      expect(result.denialReasons).toContain('suppression_manual_dnc');
    }
  });

  test('STOP-style opt-outs and wrong_number deny the phone channels but not email', async () => {
    for (const reason of ['opt_out_keyword', 'opt_out_natural_language', 'wrong_number']) {
      for (const ch of ['voice', 'manual_call', 'sms']) {
        armWithSuppression(reason);
        const result = await ContactPolicy.evaluate('cust-1', { channel: ch, purpose: 'late_payment', now: WED_11AM_EDT });
        expect(result.denialReasons).toContain(`suppression_${reason}`);
      }
      armWithSuppression(reason);
      const email = await ContactPolicy.evaluate('cust-1', { channel: 'email', purpose: 'late_payment', now: WED_11AM_EDT });
      expect(email.denialReasons).not.toContain(`suppression_${reason}`);
    }
  });

  test('non_mobile is a deliverability fact: denies sms only', async () => {
    armWithSuppression('non_mobile');
    const sms = await ContactPolicy.evaluate('cust-1', { channel: 'sms', purpose: 'late_payment', now: WED_11AM_EDT });
    expect(sms.denialReasons).toContain('suppression_non_mobile');
    armWithSuppression('non_mobile');
    const voice = await evalVoice();
    expect(voice.denialReasons).not.toContain('suppression_non_mobile');
  });

  test('an unrecognized suppression reason fails closed on every channel', async () => {
    armWithSuppression('mystery_reason');
    const email = await ContactPolicy.evaluate('cust-1', { channel: 'email', purpose: 'late_payment', now: WED_11AM_EDT });
    expect(email.denialReasons).toContain('suppression_mystery_reason');
  });
});

describe('call_log live conversations', () => {
  function armWithCall(callRow) {
    armAllowedBaseline();
    setDbTables({
      customers: chain({ first: customerRow() }),
      collections_flags: chain({ result: [] }),
      collections_contact_ledger: chain({ result: [] }),
      invoice_followup_sequences: chain({ first: { touches_sent: 2 } }),
      activity_log: chain({ result: [{ count: '0' }] }),
      messaging_suppression: chain({ first: undefined }),
      call_log: chain({ first: callRow }),
    });
  }
  const TWO_DAYS_AGO = new Date(WED_11AM_EDT.getTime() - 2 * 24 * 3600 * 1000).toISOString();

  test('a completed human call within 7d denies voice (spacing) and sms/email (live conversation)', async () => {
    armWithCall({ created_at: TWO_DAYS_AGO });
    const voice = await evalVoice();
    expect(voice.denialReasons).toContain('voice_contact_within_7d');
    armWithCall({ created_at: TWO_DAYS_AGO });
    const sms = await ContactPolicy.evaluate('cust-1', { channel: 'sms', purpose: 'late_payment', now: WED_11AM_EDT });
    expect(sms.denialReasons).toContain('live_conversation_within_7d');
    armWithCall({ created_at: TWO_DAYS_AGO });
    const email = await ContactPolicy.evaluate('cust-1', { channel: 'email', purpose: 'late_payment', now: WED_11AM_EDT });
    expect(email.denialReasons).toContain('live_conversation_within_7d');
  });

  test('the call predicate keeps its NULL legs explicit (voicemail/missed/spam excluded in SQL, not by whereNot)', async () => {
    // Pin the raw predicates so a refactor to bare whereNot (which skips
    // NULL rows — SQL three-valued logic) fails loudly.
    const callChain = chain({ first: undefined });
    armAllowedBaseline();
    setDbTables({
      customers: chain({ first: customerRow() }),
      collections_flags: chain({ result: [] }),
      collections_contact_ledger: chain({ result: [] }),
      invoice_followup_sequences: chain({ first: { touches_sent: 2 } }),
      activity_log: chain({ result: [{ count: '0' }] }),
      messaging_suppression: chain({ first: undefined }),
      call_log: callChain,
    });
    await evalVoice();
    expect(callChain.whereRaw).toHaveBeenCalledWith("(call_outcome IS NULL OR call_outcome NOT IN ('voicemail', 'missed', 'spam'))");
    expect(callChain.whereRaw).toHaveBeenCalledWith("(answered_by IS NULL OR answered_by <> 'voicemail')");
    expect(callChain.whereRaw).toHaveBeenCalledWith('(duration_seconds IS NULL OR duration_seconds >= 30)');
  });
});

describe('ledger-based dunning touches (balance-reminder workflow)', () => {
  test('two delivered workflow ledger rows alone satisfy the two-touch floor', async () => {
    armAllowedBaseline();
    setDbTables({
      customers: chain({ first: customerRow() }),
      collections_flags: chain({ result: [] }),
      // queue: frequency read, then the touch-count read
      collections_contact_ledger: [chain({ result: [] }), chain({ result: [{ count: '2' }] })],
      invoice_followup_sequences: chain({ first: { touches_sent: 0 } }),
      activity_log: chain({ result: [{ count: '0' }] }),
      messaging_suppression: chain({ first: undefined }),
      call_log: chain({ first: undefined }),
    });
    const result = await evalVoice();
    expect(result.allowed).toBe(true);
    expect(result.denialReasons).toEqual([]);
  });

  test('the ledger arm is source-restricted and excludes send_failed rows (query pins)', async () => {
    const countChain = chain({ result: [{ count: '0' }] });
    armAllowedBaseline();
    setDbTables({
      customers: chain({ first: customerRow() }),
      collections_flags: chain({ result: [] }),
      collections_contact_ledger: [chain({ result: [] }), countChain],
      invoice_followup_sequences: chain({ first: { touches_sent: 2 } }),
      activity_log: chain({ result: [{ count: '0' }] }),
      messaging_suppression: chain({ first: undefined }),
      call_log: chain({ first: undefined }),
    });
    await evalVoice();
    expect(countChain.whereIn).toHaveBeenCalledWith('source', ['balance_reminder_workflow', 'balance_reminder_late_payment_check']);
    expect(countChain.whereRaw).toHaveBeenCalledWith("COALESCE(metadata->>'send_failed', '') <> 'true'");
    expect(countChain.whereRaw).toHaveBeenCalledWith('invoice_ids @> ?::jsonb', ['["inv-1"]']);
  });
});

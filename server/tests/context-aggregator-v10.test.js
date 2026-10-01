/**
 * ContextAggregator v10 pure helpers — the egress guards the SMS facts
 * depend on (codex r1-r5, PR #3076). No DB.
 */
const { redactAccessCodes, customerSafeVisitNotes, lawnOverall } = require('../services/context-aggregator');

describe('redactAccessCodes — deterministic code masking', () => {
  test('keyword-before-value: "front gate code is 4545" masks the digits', () => {
    const out = redactAccessCodes('front gate code is 4545, use the side door');
    expect(out).not.toContain('4545');
    expect(out).toContain('[redacted]');
  });

  test('value-before-keyword (codex r5): "4545 is the gate code" masks too', () => {
    const out = redactAccessCodes('4545 is the gate code');
    expect(out).not.toContain('4545');
    expect(out).toContain('gate code');
  });

  test('alphanumeric credentials mask too (codex r6: "gate code BLUE")', () => {
    const out = redactAccessCodes('TECH ONLY: gate code BLUE 1234');
    expect(out).not.toContain('BLUE');
    expect(out).not.toContain('1234');
    expect(redactAccessCodes('door code Sunset22')).not.toContain('Sunset22');
    // no code noun in the segment → no alphanumeric pass, prose survives
    expect(redactAccessCodes('close the gate so the dog stays in')).toContain('dog stays in');
  });

  test('CVV/CVC values mask (codex r12)', () => {
    expect(redactAccessCodes('my CVV is 123 on the visa')).not.toMatch(/\b123\b/);
    expect(redactAccessCodes('security code 4321')).not.toContain('4321');
  });

  test('reverse multiword + password nouns + structured identifiers (codex r11)', () => {
    expect(redactAccessCodes('four five four five is the gate code')).not.toMatch(/four|five/);
    expect(redactAccessCodes('waves is the gate password')).not.toContain('waves');
    const ids = redactAccessCodes('my social is 123-45-6789 and card 4242 4242 4242 4242');
    expect(ids).not.toContain('123-45-6789');
    expect(ids).not.toContain('4242');
    // phone numbers and dates survive
    expect(redactAccessCodes('call me at 941-555-1234 about July 15')).toContain('941-555-1234');
  });

  test('multiword spoken credentials mask fully (codex r10)', () => {
    const out = redactAccessCodes('the gate code is four five four five');
    expect(out).not.toMatch(/four|five/);
  });

  test('quoted credentials mask (codex r9)', () => {
    expect(redactAccessCodes('gate password is "waves"')).not.toContain('waves');
  });

  test('password-labeled credentials mask (codex r8)', () => {
    expect(redactAccessCodes('gate password is waves')).not.toContain('waves');
    expect(redactAccessCodes('the wifi passphrase is sunshine1')).not.toContain('sunshine1');
  });

  test('lowercase credentials mask positionally (codex r7)', () => {
    expect(redactAccessCodes('gate code blue')).not.toContain('blue');
    expect(redactAccessCodes('the gate code is waves')).not.toContain('waves');
    expect(redactAccessCodes('door pin beach')).not.toContain('beach');
  });

  test('multiple codes in one string all mask; benign digits survive', () => {
    const out = redactAccessCodes('gate code 1234 and garage 5678; visit on July 15');
    expect(out).not.toContain('1234');
    expect(out).not.toContain('5678');
    expect(out).toContain('July 15');
  });
});

describe('customerSafeVisitNotes — the ONLY sanctioned tech-notes egress', () => {
  // One rule for every customer render of the note (owner ruling
  // 2026-10-01: customers see only the report text, never the tech's raw
  // note): it reads the service record, not the note alone.
  const REVIEWED = 'WHAT WE DID:\nTreated the exterior perimeter and swept eaves.\nWHAT WE FOUND:\nLight ant activity near the lanai.';
  const record = (overrides = {}) => ({
    technician_notes: REVIEWED, structured_notes: null, service_data: null, completion_source: null, ...overrides,
  });
  const gate = process.env.GATE_REPORT_WRITER_RULES;
  afterEach(() => {
    if (gate === undefined) delete process.env.GATE_REPORT_WRITER_RULES;
    else process.env.GATE_REPORT_WRITER_RULES = gate;
  });

  test('a valid WHAT WE DID / WHAT WE FOUND note returns the vetted body (codex r5 — did/found read discarded every note)', () => {
    const out = customerSafeVisitNotes(record());
    expect(out).toBe('Treated the exterior perimeter and swept eaves. Light ant activity near the lanai.');
  });

  test('free-text notes (access codes, candid remarks) return null — never raw', () => {
    expect(customerSafeVisitNotes(record({ technician_notes: 'gate code 4545, customer grumpy, treated exterior' }))).toBeNull();
    // A note typed under the reviewed report is not reviewed copy either.
    expect(customerSafeVisitNotes(record({ technician_notes: `${REVIEWED}\ngate code 4545` }))).toBeNull();
    expect(customerSafeVisitNotes(record({ technician_notes: '' }))).toBeNull();
    expect(customerSafeVisitNotes(record({ technician_notes: null }))).toBeNull();
  });

  test('a bare note with no record is no notes (fails closed)', () => {
    expect(customerSafeVisitNotes(REVIEWED)).toBeNull();
    expect(customerSafeVisitNotes(null)).toBeNull();
  });

  test('a code inside the reviewed text is never shown', () => {
    const notes = REVIEWED.replace('near the lanai.', 'near the lanai, gate code 4545.');
    expect(customerSafeVisitNotes(record({ technician_notes: notes })) || '').not.toContain('4545');
  });

  test('a body the completion rejected, or service data that cannot be read, shows nothing', () => {
    expect(customerSafeVisitNotes(record({ service_data: { technicianReportBodyRejected: 'trade_name' } }))).toBeNull();
    expect(customerSafeVisitNotes(record({ service_data: '{not json' }))).toBeNull();
  });

  test('a typed report held from customers shows nothing', () => {
    expect(customerSafeVisitNotes(record({ structured_notes: { typedReportDelivery: 'internal_only' } }))).toBeNull();
    expect(customerSafeVisitNotes(record({ structured_notes: JSON.stringify({ typedReportDelivery: 'disabled' }) }))).toBeNull();
  });

  test("the trapping screens hold, as on the web report: a declared trap setup refuses a body claiming traps were checked", () => {
    const trapping = (overrides = {}) => ({
      service_data: {
        companionReportSnapshots: [{
          type: 'rodent_trapping', delivery: 'auto_send', visitSequence: 1,
          values: { trap_visit_type: 'Initial setup' },
          todaysResult: { bodySource: 'technician_report', ...overrides },
        }],
      },
    });
    const checked = 'WHAT WE DID:\nWe set traps in the attic and garage.\nWHAT WE FOUND:\nWe checked 8 traps and found no captures.';
    const set = 'WHAT WE DID:\nWe set traps in the attic and garage.\nWHAT WE FOUND:\nWe saw droppings near the water heater.';
    expect(customerSafeVisitNotes(record({ technician_notes: checked, ...trapping() }))).toBeNull();
    expect(customerSafeVisitNotes(record({ technician_notes: set, ...trapping() }))).toBe(
      'We set traps in the attic and garage. We saw droppings near the water heater.',
    );
    // A person who confirmed the reconciliation prompt keeps the body.
    expect(customerSafeVisitNotes(record({ technician_notes: checked, ...trapping({ reconcileConfirmed: true }) }))).toContain('We checked 8 traps');
  });

  test("projectLine keeps a project completion's line: it is the project's own title and recommendations", () => {
    const notes = 'Project completed: Rodent exclusion\n\nSeal the gap under the garage door.';
    expect(customerSafeVisitNotes(record({ technician_notes: notes, completion_source: 'project_completion' }), { projectLine: true })).toBe(notes);
    expect(customerSafeVisitNotes(record({ technician_notes: notes, structured_notes: { projectCompletion: true } }), { projectLine: true })).toBe(notes);
    // Without it (the AI contexts and the voice agent), the reviewed parse alone.
    expect(customerSafeVisitNotes(record({ technician_notes: notes, completion_source: 'project_completion' }))).toBeNull();
  });

  test('a four-section report shows only while the writer rules are on, like the web report', () => {
    const fourSection = [
      'WHAT WE FOUND', 'Ghost ants were trailing at the kitchen counter.',
      'WHAT WE DID AND WHY', 'We placed bait along the counter edge.',
      'WHAT TO EXPECT', 'You may see more ants for a few days.',
      "WHAT'S NEXT", 'If ants are still trailing, let us know.',
    ].join('\n');
    delete process.env.GATE_REPORT_WRITER_RULES;
    expect(customerSafeVisitNotes(record({ technician_notes: fourSection }))).toBeNull();
    process.env.GATE_REPORT_WRITER_RULES = 'true';
    expect(customerSafeVisitNotes(record({ technician_notes: fourSection }))).toBe(
      'Ghost ants were trailing at the kitchen counter. We placed bait along the counter edge. You may see more ants for a few days. If ants are still trailing, let us know.',
    );
  });
});

describe('lawnOverall — canonical scoring mirror', () => {
  test('modern rows trust the stored overall; legacy rows recompute 30/25/25/20', () => {
    expect(lawnOverall({ overall_score: 81, stress_damage: 70 })).toBe(81);
    // legacy row (no stress_damage): 30% density + 25% weed + 25% color + 20% worst(fungus, thatch)
    expect(lawnOverall({ turf_density: 80, weed_suppression: 60, color_health: 80, fungus_control: 50, thatch_level: 70 }))
      .toBe(Math.round(80 * 0.30 + 60 * 0.25 + 80 * 0.25 + 50 * 0.20));
  });
});

// The billing lane travels into the managed agent's context snapshot verbatim
// (managed-assistant.js stores ctx.summary), so what buildSummary writes is
// authoritative grounding — codex #3128 r9.
describe('buildSummary billing-lane fact', () => {
  const ContextAggregator = require('../services/context-aggregator');
  const { resolveBillingLaneFacts, resolveMonthlyDuesFact } = ContextAggregator;
  // The real production shape: getContextForCustomer resolves the lane, then
  // prices the dues against the method the charge will actually run on.
  const summaryFor = (customer, { collection = 'autopay_off', methods = null, annualCoverage } = {}) => {
    const c = { first_name: 'Pat', last_name: 'Tester', pipeline_stage: 'active_customer', ...customer };
    const lane = resolveBillingLaneFacts(c, annualCoverage);
    if (lane.monthlyBilled) {
      lane.monthlyDues = resolveMonthlyDuesFact({ monthlyRate: c.monthly_rate, collection, methods });
    }
    return ContextAggregator.buildSummary(c, [], null, [], 0, lane);
  };

  test('an invoice-on-complete customer is described per application, never "per visit"', () => {
    // per_visit is an internal billing mechanism; the house voice forbids the
    // phrase, so the raw mode must never reach the snapshot.
    const s = summaryFor({ billing_mode: 'per_visit', waveguard_tier: 'None', monthly_rate: 0 });
    expect(s).toContain('Billing lane: per application');
    expect(s).not.toMatch(/per visit/i);
  });

  test('a monthly member carries the dues amount — the lane alone cannot be quoted', () => {
    // The house voice forbids computing or inventing figures, so "state it
    // plainly" without the number just produces a deferral.
    const s = summaryFor({ billing_mode: 'monthly_membership', waveguard_tier: 'Gold', monthly_rate: 98.5 });
    expect(s).toContain('Billing lane: monthly membership');
    expect(s).toContain('$98.50/mo dues');
  });

  test('the exact surcharged charge stays OUT of the long-lived snapshot', () => {
    // This string is sent once, at session creation, and the session lives
    // ~30 minutes — long enough for the customer to switch between a debit
    // and a credit method, at which point a frozen total is the wrong number
    // (codex #3141 r4). The dues stay; the exact charge belongs to the
    // drafter's facts block, which is rebuilt for every message.
    const s = summaryFor(
      { billing_mode: 'monthly_membership', waveguard_tier: 'Gold', monthly_rate: 98.5 },
      { collection: 'active', methods: [{ method_type: 'card', card_funding: 'credit' }] },
    );
    expect(s).toContain('$98.50/mo dues');
    expect(s).not.toContain('101.35');
    expect(s).toMatch(/card fee applies at charge — state dues only/);
  });

  test('a suppressed collection carries its reason into the snapshot', () => {
    // The managed agent gets ONLY this string — never the drafter's facts
    // block — so "monthly membership, $98.50" with the reason dropped let it
    // answer a current-charge question from a rate alone (codex #3141 r3).
    for (const [collection, phrase] of [
      ['autopay_paused', /autopay paused, not collecting/],
      ['service_paused', /billing paused, not collecting/],
      ['account_inactive', /account not active, not collecting/],
      ['annual_prepay_pending', /annual prepay invoice open, not collecting/],
      ['unknown', /collection state unconfirmed/],
    ]) {
      const s = summaryFor(
        { billing_mode: 'monthly_membership', waveguard_tier: 'Gold', monthly_rate: 98.5 },
        { collection },
      );
      expect(s).toContain('$98.50/mo dues');
      expect(s).toMatch(phrase);
    }
  });

  test('a collecting lane with no card fee carries the amount with no caveat', () => {
    const s = summaryFor(
      { billing_mode: 'monthly_membership', waveguard_tier: 'Gold', monthly_rate: 98.5 },
      { collection: 'active', methods: [{ method_type: 'us_bank_account', card_funding: null }] },
    );
    expect(s).toContain('($98.50/mo dues)');
  });

  test('an UNPRICED membership carries no amount and is not called monthly-billed', () => {
    // No rate = the dues cron never selects the row and chargeMonthly refuses
    // it, so nothing is charged monthly at all.
    const s = summaryFor({ billing_mode: 'monthly_membership', waveguard_tier: 'Gold', monthly_rate: 0 });
    expect(s).toContain('no rate set');
    expect(s).not.toMatch(/dues|\$/);
  });

  test('an INFERRED monthly member is marked inferred but still quotable', () => {
    // NULL mode + real tier + rate is what MONTHLY_LANE_SQL bills, so this
    // account genuinely is charged monthly (codex #3128 r8).
    const s = summaryFor({ billing_mode: null, waveguard_tier: 'Bronze', monthly_rate: 45 });
    expect(s).toContain('Billing lane: monthly membership (inferred)');
    expect(s).toContain('$45.00/mo dues');
  });

  test('a per-application customer never carries a monthly figure', () => {
    const s = summaryFor({ billing_mode: 'per_application', waveguard_tier: 'Silver', monthly_rate: 117 });
    expect(s).toContain('Billing lane: per application');
    expect(s).not.toMatch(/dues|117/);
  });

  test('an annual-prepay customer with live coverage is named as prepaid', () => {
    const s = summaryFor(
      { billing_mode: 'annual_prepay', waveguard_tier: 'Gold', monthly_rate: 90 },
      { annualCoverage: 'covered' },
    );
    expect(s).toContain('paid for the year');
    expect(s).not.toMatch(/dues/);
  });

  test('an annual-prepay customer without live coverage is never named as paid up', () => {
    // A naturally expired term keeps billing_mode 'annual_prepay' while the
    // renewal flow owns collection (codex #3141 r4).
    expect(summaryFor(
      { billing_mode: 'annual_prepay', waveguard_tier: 'Gold', monthly_rate: 90 },
      { annualCoverage: 'not_covered' },
    )).toContain('coverage not current');
    // Unresolved coverage fails closed the same way.
    expect(summaryFor({ billing_mode: 'annual_prepay', waveguard_tier: 'Gold', monthly_rate: 90 }))
      .toContain('coverage unconfirmed');
  });

  test('a direct caller that resolves no lane fact states no amount', () => {
    // buildSummary's own fallback cannot price dues (no DB), so it must not
    // reach for the raw rate — no amount is the fail-closed answer.
    const s = ContextAggregator.buildSummary(
      { first_name: 'Pat', last_name: 'Tester', pipeline_stage: 'active_customer', billing_mode: 'monthly_membership', waveguard_tier: 'Gold', monthly_rate: 98.5 },
      [], null, [], 0,
    );
    expect(s).toContain('Billing lane: monthly membership');
    expect(s).not.toContain('98.50');
  });
});

// pg hands DATE columns over as local-midnight Dates. On the UTC prod host
// that is 00:00Z, which an ET toLocaleDateString shows as the day before: a
// Thu Oct 1 visit read "Next: WDO Inspection Service 9/30/2026".
describe('buildSummary visit dates', () => {
  const ContextAggregator = require('../services/context-aggregator');
  const c = { first_name: 'Pat', last_name: 'Tester', pipeline_stage: 'active_customer' };

  // Built the way pg builds them (local midnight). CI runs in UTC, so this
  // case catches the shift there; the string case catches it in any zone.
  test('Next and Last keep the stored calendar day on a UTC host', () => {
    const s = ContextAggregator.buildSummary(
      c, [],
      { service_type: 'Pest Control', service_date: new Date(2026, 8, 1) },
      [{ service_type: 'WDO Inspection Service', scheduled_date: new Date(2026, 9, 1) }],
      0, null,
    );
    expect(s).toContain('Next: WDO Inspection Service 10/1/2026');
    expect(s).toContain('Last: Pest Control 9/1/2026');
  });

  test('a YYYY-MM-DD string keeps its day too', () => {
    const s = ContextAggregator.buildSummary(
      c, [], null, [{ service_type: 'WDO Inspection Service', scheduled_date: '2026-10-01' }], 0, null,
    );
    expect(s).toContain('Next: WDO Inspection Service 10/1/2026');
  });
});

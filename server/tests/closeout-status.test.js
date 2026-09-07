/**
 * Closeout status service — the ten-fact read-only contract.
 *
 * Two layers under test:
 *  - deriveCloseoutFacts(inputs): pure. Every state (not_required / pending /
 *    done / failed / unknown) per fact, the contradictions list, and the
 *    "unknown is never rendered as missing" discipline.
 *  - loadCloseoutInputs / getCloseoutStatus against a fake knex: one failing
 *    table lands in `unavailable` + an `unknown` fact instead of throwing or
 *    silently reading as "missing" (the command-center `.catch(() => [])`
 *    bug this service exists to retire).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/invoice', () => ({
  CANCELLED_SERVICE_RESOLVED_STATUSES: ['void', 'refunded', 'canceled', 'cancelled'],
}));
jest.mock('../services/autopay-eligibility', () => ({
  customerOnAutopay: jest.fn(async (customer) => customer?.autopay_enabled === true),
}));
jest.mock('../services/typed-followup-obligation', () => ({
  typedFollowupObligationForCompletedSource: jest.fn(async () => null),
  FOLLOWUP_CHILD_INACTIVE_STATUSES: ['cancelled', 'skipped', 'no_show'],
}));
jest.mock('../services/estimate-first-application-invoice', () => ({
  findFirstApplicationInvoiceForEstimateService: jest.fn(async () => ({ invoice: null, liveBeside: null })),
}));
jest.mock('../services/annual-prepay-renewals', () => ({
  annualPrepayCoversVisit: jest.fn(async () => true),
}));
jest.mock('../config/feature-gates', () => ({ gates: { completionAutopayCharge: false }, isEnabled: () => false }));
jest.mock('../services/billing-lane', () => {
  const actual = jest.requireActual('../services/billing-lane');
  return { ...actual, monthlyDuesCollected: jest.fn(async () => false) };
});
// The catalog resolver reaches for the module-level db; give it a knex-shaped
// stub that returns the catalog rows the test installs.
const catalogRows = [];
jest.mock('../services/service-closeout-requirements', () => {
  const actual = jest.requireActual('../services/service-closeout-requirements');
  return {
    ...actual,
    resolveCloseoutRequirementsForJobs: jest.fn(async (jobs) => {
      const map = new Map();
      for (const job of jobs) {
        const row = catalogRows.find((r) => r.id === job.service_id) || {};
        map.set(job.id, actual.normalizeRequirements(row, job.service_type));
      }
      return map;
    }),
  };
});

const {
  deriveCloseoutFacts,
  deriveBillingExpectation,
  summarizeCloseout,
  getCloseoutStatus,
  FACT_STATES,
  FACT_NAMES,
} = require('../services/closeout-status');

// Captured BEFORE any jest.resetModules() so it is the same instance the
// service under test destructured at load.
const followupMock = require('../services/typed-followup-obligation').typedFollowupObligationForCompletedSource;

const NOW = new Date('2026-08-31T15:00:00Z');
const SVC = 'svc-1';
const REC = 'rec-1';

function baseRequirements(overrides = {}) {
  return {
    serviceId: 'cat-pest', serviceName: 'Quarterly Pest Control', category: 'pest_control',
    requiresServiceReport: true, requiresApplicationLog: true, requiredPhotoCount: 0,
    requiresCustomerSignature: false, requiresCustomerNotice: true, requiresLicense: false,
    licenseCategory: null, source: 'catalog_v2', ...overrides,
  };
}

// A fully closed-out recurring pest visit for a per_visit customer.
function closedOutInputs(overrides = {}) {
  return {
    serviceId: SVC,
    now: NOW,
    unavailable: [],
    visit: {
      id: SVC, customer_id: 'cust-1', status: 'completed', scheduled_date: '2026-08-30',
      completed_at: '2026-08-30T18:00:00Z', service_type: 'Quarterly Pest Control', service_id: 'cat-pest',
      is_callback: false, is_recurring: true, estimated_price: 120, prepaid_method: null, prepaid_amount: null,
    },
    customer: { id: 'cust-1', billing_mode: 'per_visit', waveguard_tier: null, monthly_rate: null, per_application_fee: null, autopay_enabled: false },
    lane: { mode: 'per_visit', source: 'explicit' },
    autopayActive: false,
    duesCollectedThisMonth: false,
    annualCoverageValidated: null,
    completionAutopayChargeEnabled: false,
    payerBilled: false,
    record: {
      id: REC, status: 'completed', completion_source: 'detailed_form',
      report_view_token: 'a'.repeat(32), report_generated_at: '2026-08-30T18:05:00Z',
      structured_notes: { completionSmsStatus: 'sent' }, field_flags: {},
    },
    attempt: { state: 'succeeded_other_key', serviceRecordId: REC },
    requirements: baseRequirements(),
    completedFormCount: 1,
    activeApplicationCount: 2,
    retractedApplicationCount: 0,
    photoCount: 0,
    delivery: { channel: 'email', status: 'sent', attempts: 1, max_attempts: 5, sent_at: '2026-08-30T18:06:00Z' },
    liveInvoice: { id: 'inv-1', invoice_number: 'INV-1', status: 'sent', total: 120, sent_at: '2026-08-30T18:06:00Z', payer_id: null },
    terminalInvoice: null,
    followup: null,
    followupChild: null,
    packets: [],
    packetMemberIds: [],
    ...overrides,
  };
}

function states(facts) {
  return Object.fromEntries(FACT_NAMES.map((n) => [n, facts[n].state]));
}

describe('closeout-status: contract shape', () => {
  test('every fact carries a legal state and a reason; nothing collapses to a boolean', () => {
    const { facts } = deriveCloseoutFacts(closedOutInputs());
    for (const name of FACT_NAMES) {
      expect(FACT_STATES).toContain(facts[name].state);
      expect(typeof facts[name].reason).toBe('string');
      expect(typeof facts[name]).not.toBe('boolean');
    }
  });

  test('a fully closed-out visit reads done/not_required everywhere and summary.closedOut = true', () => {
    const { facts, contradictions } = deriveCloseoutFacts(closedOutInputs());
    expect(states(facts)).toEqual({
      completion: 'done', application: 'done', photos: 'not_required', report: 'done', reportDelivery: 'done',
      invoice: 'done', invoiceDelivery: 'done', comms: 'done', followUp: 'not_required', license: 'not_required',
    });
    expect(contradictions).toEqual([]);
    expect(summarizeCloseout(facts, contradictions)).toEqual({ open: [], failed: [], unknown: [], contradictions: [], unevaluated: [], closedOut: true });
  });
});

describe('closeout-status: completion fact', () => {
  test('visit not yet completed → completion pending; every downstream fact waits (never "missing")', () => {
    const { facts } = deriveCloseoutFacts(closedOutInputs({
      visit: { ...closedOutInputs().visit, status: 'confirmed', completed_at: null },
      record: null, attempt: { state: 'none' }, liveInvoice: null, delivery: null,
    }));
    expect(facts.completion).toMatchObject({ state: 'pending', reason: 'visit_not_completed' });
    for (const name of FACT_NAMES.filter((n) => n !== 'completion')) {
      expect(facts[name]).toMatchObject({ state: 'pending', reason: 'awaiting_completion' });
    }
  });

  test('cancelled visit with no record → everything not_required (nothing is owed)', () => {
    const { facts } = deriveCloseoutFacts(closedOutInputs({
      visit: { ...closedOutInputs().visit, status: 'cancelled' }, record: null, attempt: { state: 'none' }, liveInvoice: null, delivery: null,
    }));
    for (const name of FACT_NAMES) expect(facts[name].state).toBe('not_required');
    expect(facts.completion.reason).toBe('visit_cancelled');
  });

  test('completed visit with NO service_records row → pending + contradiction', () => {
    const { facts, contradictions } = deriveCloseoutFacts(closedOutInputs({ record: null, attempt: { state: 'none' } }));
    expect(facts.completion).toMatchObject({ state: 'pending', reason: 'completed_visit_without_record' });
    expect(contradictions.map((c) => c.code)).toEqual(['completed_visit_without_record']);
  });

  test('record exists while the visit is still on_site → done + record_without_completed_visit contradiction', () => {
    const { facts, contradictions } = deriveCloseoutFacts(closedOutInputs({
      visit: { ...closedOutInputs().visit, status: 'on_site' },
    }));
    expect(facts.completion.state).toBe('done');
    expect(contradictions.map((c) => c.code)).toEqual(['record_without_completed_visit']);
  });

  test('claim in flight (running / resumable) → pending, not missing; failed claim → failed', () => {
    const running = deriveCloseoutFacts(closedOutInputs({ record: null, attempt: { state: 'running' }, visit: { ...closedOutInputs().visit, status: 'on_site' } }));
    expect(running.facts.completion).toMatchObject({ state: 'pending', reason: 'completion_running' });
    const resumable = deriveCloseoutFacts(closedOutInputs({ record: null, attempt: { state: 'resumable' }, visit: { ...closedOutInputs().visit, status: 'on_site' } }));
    expect(resumable.facts.completion.reason).toBe('completion_resumable');
    const failed = deriveCloseoutFacts(closedOutInputs({ record: null, attempt: { state: 'failed', error: 'boom' }, visit: { ...closedOutInputs().visit, status: 'on_site' } }));
    expect(failed.facts.completion).toMatchObject({ state: 'failed', error: 'boom' });
  });

  test('record exists but the attempt is still running/resumable → pending side effects, not closed (codex r12)', () => {
    expect(deriveCloseoutFacts(closedOutInputs({ attempt: { state: 'resumable' } })).facts.completion)
      .toMatchObject({ state: 'pending', reason: 'completion_side_effects_resumable', recordId: REC });
    expect(deriveCloseoutFacts(closedOutInputs({ attempt: { state: 'running' } })).facts.completion.state).toBe('pending');
  });

  test('record marked incomplete → pending', () => {
    const { facts } = deriveCloseoutFacts(closedOutInputs({ record: { ...closedOutInputs().record, status: 'incomplete' } }));
    expect(facts.completion).toMatchObject({ state: 'pending', reason: 'record_marked_incomplete' });
  });

  test('completion-attempt lookup failure with no record → unknown, not a closeout gap (GH r1)', () => {
    const { facts } = deriveCloseoutFacts(closedOutInputs({ record: null, attempt: null, attemptLookupFailed: true }));
    expect(facts.completion).toMatchObject({ state: 'unknown', reason: 'completion_attempts_lookup_failed' });
    // Even with a record, an unreadable attempt row means side effects are unknowable.
    const withRecord = deriveCloseoutFacts(closedOutInputs({ attempt: null, attemptLookupFailed: true }));
    expect(withRecord.facts.completion).toMatchObject({ state: 'unknown', recordId: REC });
  });

  test('service_records lookup failure → unknown, never pending — and every downstream fact is unknown, not open (GH r3)', () => {
    const { facts } = deriveCloseoutFacts(closedOutInputs({ record: null, recordLookupFailed: true }));
    expect(facts.completion).toMatchObject({ state: 'unknown', reason: 'service_records_lookup_failed' });
    for (const name of FACT_NAMES.filter((n) => n !== 'completion')) {
      expect(facts[name]).toMatchObject({ state: 'unknown', reason: 'completion_unknown' });
    }
    const summary = summarizeCloseout(facts, []);
    expect(summary.open).toEqual([]);
    expect(summary.unknown).toEqual([...FACT_NAMES]);
  });
});

describe('closeout-status: application + photos', () => {
  test('catalog says no application log → not_required with ruleSource catalog', () => {
    const { facts } = deriveCloseoutFacts(closedOutInputs({ requirements: baseRequirements({ requiresApplicationLog: false }), activeApplicationCount: 0 }));
    expect(facts.application).toMatchObject({ state: 'not_required', ruleSource: 'catalog' });
  });

  test('all application rows retracted (recap correction) → failed, not done and not pending', () => {
    const { facts } = deriveCloseoutFacts(closedOutInputs({ activeApplicationCount: 0, retractedApplicationCount: 3 }));
    expect(facts.application).toMatchObject({ state: 'failed', reason: 'all_application_rows_retracted', retractedCount: 3 });
  });

  test('no application rows at all on a required lane → pending', () => {
    const { facts } = deriveCloseoutFacts(closedOutInputs({ activeApplicationCount: 0, retractedApplicationCount: 0 }));
    expect(facts.application.state).toBe('pending');
  });

  test('application lookup failed → unknown', () => {
    const { facts } = deriveCloseoutFacts(closedOutInputs({ activeApplicationCount: null }));
    expect(facts.application.state).toBe('unknown');
  });

  test('photos: short → pending with counts; met → done; zero required → not_required; lookup failed → unknown', () => {
    const req = baseRequirements({ requiredPhotoCount: 2 });
    expect(deriveCloseoutFacts(closedOutInputs({ requirements: req, photoCount: 1 })).facts.photos)
      .toMatchObject({ state: 'pending', required: 2, actual: 1 });
    expect(deriveCloseoutFacts(closedOutInputs({ requirements: req, photoCount: 2 })).facts.photos.state).toBe('done');
    expect(deriveCloseoutFacts(closedOutInputs({ photoCount: 0 })).facts.photos.state).toBe('not_required');
    expect(deriveCloseoutFacts(closedOutInputs({ requirements: req, photoCount: null })).facts.photos.state).toBe('unknown');
  });

  test('requirements unavailable → application/photos unknown (catalog outage is not a compliance gap)', () => {
    const { facts } = deriveCloseoutFacts(closedOutInputs({ requirements: null }));
    expect(facts.application.state).toBe('unknown');
    expect(facts.photos.state).toBe('unknown');
  });
});

describe('closeout-status: report + report delivery', () => {
  test('published report + sent delivery → done/done with evidence', () => {
    const { facts } = deriveCloseoutFacts(closedOutInputs());
    expect(facts.report).toMatchObject({ state: 'done', hasToken: true, audience: 'customer', posture: 'auto_send' });
    expect(facts.reportDelivery).toMatchObject({ state: 'done', status: 'sent', attempts: 1, maxAttempts: 5 });
  });

  test('frozen internal_only posture: report done for staff, delivery + comms not_required (designed state, not a gap)', () => {
    const { facts } = deriveCloseoutFacts(closedOutInputs({
      record: { ...closedOutInputs().record, structured_notes: { typedReportDelivery: 'internal_only' } },
      delivery: null,
    }));
    expect(facts.report).toMatchObject({ state: 'done', audience: 'internal' });
    expect(facts.reportDelivery).toMatchObject({ state: 'not_required', reason: 'frozen_posture_internal_only', ruleSource: 'frozen_record' });
    expect(facts.comms).toMatchObject({ state: 'not_required', reason: 'frozen_posture_internal_only' });
  });

  test('frozen disabled posture: no report artifact is owed at all', () => {
    const { facts } = deriveCloseoutFacts(closedOutInputs({
      record: { ...closedOutInputs().record, report_view_token: null, report_generated_at: null, structured_notes: { typedReportDelivery: 'disabled' } },
      delivery: null,
    }));
    expect(facts.report).toMatchObject({ state: 'not_required', reason: 'frozen_posture_disabled' });
    expect(facts.reportDelivery.state).toBe('not_required');
  });

  test('form submitted but never published → pending form_submitted_not_published; nothing at all → pending no_report_artifact', () => {
    const noToken = { ...closedOutInputs().record, report_view_token: null, report_generated_at: null };
    expect(deriveCloseoutFacts(closedOutInputs({ record: noToken, completedFormCount: 1, delivery: null })).facts.report)
      .toMatchObject({ state: 'pending', reason: 'form_submitted_not_published' });
    expect(deriveCloseoutFacts(closedOutInputs({ record: noToken, completedFormCount: 0, delivery: null })).facts.report)
      .toMatchObject({ state: 'pending', reason: 'no_report_artifact' });
  });

  test('delivery queue: mid-ladder queued → pending; exhausted failed → failed; skipped → not_required; no row → pending not_enqueued', () => {
    const queued = { channel: 'email', status: 'queued', attempts: 2, max_attempts: 5, next_attempt_at: '2026-08-31T16:00:00Z' };
    expect(deriveCloseoutFacts(closedOutInputs({ delivery: queued })).facts.reportDelivery)
      .toMatchObject({ state: 'pending', reason: 'delivery_queued', attempts: 2 });
    expect(deriveCloseoutFacts(closedOutInputs({ delivery: { ...queued, status: 'failed', attempts: 5, last_error: 'smtp 550' } })).facts.reportDelivery)
      .toMatchObject({ state: 'failed', reason: 'delivery_exhausted', lastError: 'smtp 550' });
    // 'skipped' is classified by its reason: suppression = policy; no recipient = gap; ineligible/blank = unknown.
    expect(deriveCloseoutFacts(closedOutInputs({ delivery: { ...queued, status: 'skipped', last_error: 'Suppressed: bounce (service_operational)' } })).facts.reportDelivery)
      .toMatchObject({ state: 'not_required', reason: 'delivery_skipped_suppressed', ruleSource: 'email_suppression' });
    expect(deriveCloseoutFacts(closedOutInputs({ delivery: { ...queued, status: 'skipped', last_error: 'No service report recipient email' } })).facts.reportDelivery)
      .toMatchObject({ state: 'failed', reason: 'delivery_skipped_no_recipient' });
    expect(deriveCloseoutFacts(closedOutInputs({ delivery: { ...queued, status: 'skipped', last_error: 'Not a completed service report v1 record' } })).facts.reportDelivery)
      .toMatchObject({ state: 'unknown', reason: 'delivery_skipped_ineligible' });
    expect(deriveCloseoutFacts(closedOutInputs({ delivery: { ...queued, status: 'skipped' } })).facts.reportDelivery)
      .toMatchObject({ state: 'unknown', reason: 'delivery_skipped_unclassified' });
    expect(deriveCloseoutFacts(closedOutInputs({ delivery: null })).facts.reportDelivery)
      .toMatchObject({ state: 'pending', reason: 'not_enqueued' });
  });

  test('delivery lookup failed → unknown; catalog says no report → not_required', () => {
    expect(deriveCloseoutFacts(closedOutInputs({ delivery: null, deliveryLookupFailed: true })).facts.reportDelivery.state).toBe('unknown');
    const noReport = deriveCloseoutFacts(closedOutInputs({
      requirements: baseRequirements({ requiresServiceReport: false }),
      record: { ...closedOutInputs().record, report_view_token: null, report_generated_at: null }, delivery: null,
    }));
    expect(noReport.facts.report).toMatchObject({ state: 'not_required', reason: 'catalog_no_service_report' });
    expect(noReport.facts.reportDelivery.state).toBe('not_required');
  });
});

describe('closeout-status: invoice + invoice delivery', () => {
  test('refunded invoice beside a live one → PARKED (pending, manual), never "invoiced"', () => {
    const { facts } = deriveCloseoutFacts(closedOutInputs({
      terminalInvoice: { id: 'inv-refunded', status: 'refunded' },
    }));
    expect(facts.invoice).toMatchObject({
      state: 'pending', reason: 'parked_manual_refunded_invoice', refundedInvoiceId: 'inv-refunded', liveBesideInvoiceId: 'inv-1',
    });
    expect(facts.invoiceDelivery.state).toBe('pending');
  });

  test('callback visit → invoice not_required (re-services are never priced)', () => {
    const { facts } = deriveCloseoutFacts(closedOutInputs({
      visit: { ...closedOutInputs().visit, is_callback: true }, liveInvoice: null,
    }));
    expect(facts.invoice).toMatchObject({ state: 'not_required', reason: 'lane_no_charge', why: 'callback', ruleSource: 'visit_flag' });
    expect(facts.invoiceDelivery.state).toBe('not_required');
  });

  test('always-free service type (estimate / re-service) → not_required', () => {
    const { facts } = deriveCloseoutFacts(closedOutInputs({
      visit: { ...closedOutInputs().visit, service_type: 'Pest Control Re-Service', is_callback: false }, liveInvoice: null,
    }));
    expect(facts.invoice).toMatchObject({ state: 'not_required', why: 'always_free_service_type' });
  });

  test('monthly member with active autopay on a recurring visit → covered_membership, not_required', () => {
    const member = closedOutInputs({
      customer: { id: 'cust-1', billing_mode: 'monthly_membership', waveguard_tier: 'Silver', monthly_rate: 89, autopay_enabled: true },
      lane: { mode: 'monthly_membership', source: 'explicit' }, autopayActive: true,
      visit: { ...closedOutInputs().visit, estimated_price: null }, liveInvoice: null,
    });
    const { facts, billing } = deriveCloseoutFacts(member);
    expect(facts.invoice).toMatchObject({ state: 'not_required', reason: 'lane_covered_membership', ruleSource: 'lane' });
    expect(billing.expectation.kind).toBe('covered_membership');
  });

  test('invoice minted on a dues-covered visit → done BUT flagged as a contradiction (double-bill signal)', () => {
    const member = closedOutInputs({
      customer: { id: 'cust-1', billing_mode: 'monthly_membership', waveguard_tier: 'Silver', monthly_rate: 89, autopay_enabled: true },
      lane: { mode: 'monthly_membership', source: 'explicit' }, autopayActive: true,
      visit: { ...closedOutInputs().visit, estimated_price: null },
    });
    const { facts, contradictions } = deriveCloseoutFacts(member);
    expect(facts.invoice.state).toBe('done');
    expect(contradictions.map((c) => c.code)).toContain('invoice_on_covered_visit');
    // The rollup never hides a contradiction behind all-green facts.
    expect(summarizeCloseout(facts, contradictions)).toMatchObject({ open: [], contradictions: ['invoice_on_covered_visit'], closedOut: false });
  });

  test('per_visit priced visit with no invoice → pending expected_invoice_not_minted with the amount', () => {
    const { facts } = deriveCloseoutFacts(closedOutInputs({ liveInvoice: null }));
    expect(facts.invoice).toMatchObject({ state: 'pending', reason: 'expected_invoice_not_minted', amount: 120 });
  });

  test('validated annual-prepay coverage → not_required covered_annual', () => {
    const annual = closedOutInputs({
      customer: { id: 'cust-1', billing_mode: 'annual_prepay', waveguard_tier: 'Gold', monthly_rate: 100, autopay_enabled: false },
      lane: { mode: 'annual_prepay', source: 'explicit' },
      visit: { ...closedOutInputs().visit, prepaid_method: 'annual_prepay_invoice', estimated_price: null },
      annualCoverageValidated: true, liveInvoice: null,
    });
    expect(deriveCloseoutFacts(annual).facts.invoice).toMatchObject({ state: 'not_required', reason: 'lane_covered_annual' });
  });

  test('invoice lookup failed → unknown; no customer row → unknown (expectation unavailable)', () => {
    expect(deriveCloseoutFacts(closedOutInputs({ liveInvoice: null, liveInvoiceLookupFailed: true })).facts.invoice.state).toBe('unknown');
    // A live row is NOT enough when the refunded-sibling probe failed (codex r3).
    expect(deriveCloseoutFacts(closedOutInputs({ terminalInvoiceLookupFailed: true })).facts.invoice)
      .toMatchObject({ state: 'unknown', reason: 'invoice_lookup_failed', failed: ['refunded'] });
    expect(deriveCloseoutFacts(closedOutInputs({ liveInvoice: null, customer: null, lane: null })).facts.invoice)
      .toMatchObject({ state: 'unknown', reason: 'billing_expectation_unavailable' });
  });

  test('invoice delivery: draft held by the send window → pending deferred; paid → done; draft with no marker → pending', () => {
    const draft = { id: 'inv-1', status: 'draft', total: 120, sent_at: null, sms_sent_at: null, payer_id: null };
    expect(deriveCloseoutFacts(closedOutInputs({
      liveInvoice: draft, record: { ...closedOutInputs().record, structured_notes: { completionSmsStatus: 'deferred' } },
    })).facts.invoiceDelivery).toMatchObject({ state: 'pending', reason: 'deferred_send_window' });
    expect(deriveCloseoutFacts(closedOutInputs({ liveInvoice: { ...draft, status: 'paid', receipt_sent_at: '2026-08-30T18:10:00Z' } })).facts.invoiceDelivery)
      .toMatchObject({ state: 'done', reason: 'paid_receipt_sent' });
    expect(deriveCloseoutFacts(closedOutInputs({ liveInvoice: draft })).facts.invoiceDelivery)
      .toMatchObject({ state: 'pending', reason: 'invoice_draft_unsent' });
  });

  test('human intentionally_free disposition outranks the live prediction AND a frozen required mint', () => {
    const { facts } = deriveCloseoutFacts(closedOutInputs({
      liveInvoice: null,
      record: { ...closedOutInputs().record, structured_notes: { backfillMintRequired: true, backfillMintAmountCents: 12000, completionSmsStatus: 'sent' } },
      disposition: { id: 'disp-1', disposition: 'intentionally_free', reason: 'goodwill re-treat', created_at: '2026-08-30T20:00:00Z' },
    }));
    expect(facts.invoice).toMatchObject({ state: 'not_required', reason: 'disposition_intentionally_free', ruleSource: 'billing_disposition', dispositionReason: 'goodwill re-treat' });
    expect(deriveCloseoutFacts(closedOutInputs({ liveInvoice: null, dispositionLookupFailed: true })).facts.invoice.state).toBe('unknown');
  });

  test('paid ≠ receipted: unstamped paid invoice follows the receipt job (queued → pending, failed → failed, completed → done, none → pending)', () => {
    const paid = { id: 'inv-1', status: 'paid', total: 120, sent_at: null, sms_sent_at: null, receipt_sent_at: null, payer_id: null };
    const run = (o) => deriveCloseoutFacts(closedOutInputs({ liveInvoice: paid, ...o })).facts.invoiceDelivery;
    expect(run({ receiptJob: { id: 'rj', status: 'retry_scheduled', attempts: 2, next_attempt_at: '2026-08-31T16:00:00Z' } })).toMatchObject({ state: 'pending', reason: 'receipt_retry_scheduled' });
    expect(run({ receiptJob: { id: 'rj', status: 'failed', attempts: 5, last_error: 'to bob@example.com' } })).toMatchObject({ state: 'failed', reason: 'receipt_delivery_exhausted', lastError: 'to [email]' });
    expect(run({ receiptJob: { id: 'rj', status: 'completed', sms_result: { sent: true } } })).toMatchObject({ state: 'done', reason: 'paid_receipt_delivered' });
    expect(run({})).toMatchObject({ state: 'pending', reason: 'paid_receipt_not_sent' });
    // Enqueue grace (#3776 follow-up): paid_at inside 5 min of NOW with no job is the webhook's own window, not a gap.
    expect(run({ liveInvoice: { ...paid, paid_at: '2026-08-31T14:58:00Z' } })).toMatchObject({ state: 'pending', reason: 'paid_receipt_pending_enqueue', paidAt: '2026-08-31T14:58:00.000Z' });
    expect(run({ liveInvoice: { ...paid, paid_at: '2026-08-31T14:50:00Z' } })).toMatchObject({ state: 'pending', reason: 'paid_receipt_not_sent' });
    // A future paid_at never qualifies for the grace (clock skew must not hide a gap).
    expect(run({ liveInvoice: { ...paid, paid_at: '2026-08-31T15:02:00Z' } })).toMatchObject({ state: 'pending', reason: 'paid_receipt_not_sent' });
    // A queued job inside the window still reports the queue state, not the grace.
    expect(run({ liveInvoice: { ...paid, paid_at: '2026-08-31T14:58:00Z' }, receiptJob: { id: 'rj', status: 'queued' } })).toMatchObject({ state: 'pending', reason: 'receipt_queued' });
    expect(run({ receiptJobLookupFailed: true })).toMatchObject({ state: 'unknown' });
    expect(run({ liveInvoice: { ...paid, receipt_sent_at: '2026-08-30T18:10:00Z' } })).toMatchObject({ state: 'done', reason: 'paid_receipt_sent' });
  });

  test('requiresCustomerNotice rides on the comms fact; an unevaluated required signature blocks the rollup', async () => {
    const { facts, contradictions } = deriveCloseoutFacts(closedOutInputs({ requirements: baseRequirements({ requiresCustomerNotice: true }) }));
    expect(facts.comms.customerNoticeRequired).toBe(true);
    expect(summarizeCloseout(facts, contradictions, ['requiresCustomerSignature'])).toMatchObject({ unevaluated: ['requiresCustomerSignature'], closedOut: false });
    expect(summarizeCloseout(facts, contradictions, []).closedOut).toBe(true);
  });

  test('projects lookup failure → photos unknown (evidence source undecidable) (GH r1)', () => {
    const { facts } = deriveCloseoutFacts(closedOutInputs({ requirements: baseRequirements({ requiredPhotoCount: 2 }), photoCount: 2, projectLookupFailed: true }));
    expect(facts.photos).toMatchObject({ state: 'unknown', reason: 'projects_lookup_failed_photo_source_undecidable' });
  });

  test('live invoice + failed billing input → invoice unknown but the row stays as evidence (GH r1)', () => {
    const { facts } = deriveCloseoutFacts(closedOutInputs({ autopayActive: null }));
    expect(facts.invoice).toMatchObject({ state: 'unknown', reason: 'billing_inputs_unavailable', failed: ['autopay'], invoiceId: 'inv-1' });
  });

  test('sibling first-application invoice (same estimate + date) counts as the visit invoice; a refunded sibling parks (codex r12)', () => {
    const sib = { id: 'inv-sib', invoice_number: 'INV-S', status: 'sent', total: 240, sent_at: '2026-08-30T10:00:00Z', payer_id: null };
    const done = deriveCloseoutFacts(closedOutInputs({ liveInvoice: null, siblingInvoice: { invoice: sib, liveBeside: null } }));
    expect(done.facts.invoice).toMatchObject({ state: 'done', reason: 'invoice_exists', invoiceId: 'inv-sib', source: 'sibling_first_application' });
    expect(done.facts.invoiceDelivery).toMatchObject({ state: 'done', reason: 'invoice_delivered', source: 'sibling_first_application' });
    const parked = deriveCloseoutFacts(closedOutInputs({ liveInvoice: null, siblingInvoice: { invoice: { ...sib, status: 'refunded' }, liveBeside: { id: 'inv-live', status: 'sent' } } }));
    expect(parked.facts.invoice).toMatchObject({ state: 'pending', reason: 'parked_manual_refunded_invoice', refundedInvoiceId: 'inv-sib', liveBesideInvoiceId: 'inv-live' });
    // A canceled acceptance invoice that carried the SETUP FEE parks the visit even on a covered lane (codex r13 P0).
    const member = closedOutInputs({
      customer: { id: 'cust-1', billing_mode: 'monthly_membership', waveguard_tier: 'Silver', monthly_rate: 89, autopay_enabled: true },
      lane: { mode: 'monthly_membership', source: 'explicit' }, autopayActive: true,
      visit: { ...closedOutInputs().visit, estimated_price: null }, liveInvoice: null,
      siblingInvoice: { invoice: null, liveBeside: null, canceledSetupFee: { id: 'inv-c', invoice_number: 'INV-C', status: 'canceled' } },
    });
    expect(deriveCloseoutFacts(member).facts.invoice).toMatchObject({ state: 'pending', reason: 'parked_manual_canceled_setup_fee', canceledInvoiceId: 'inv-c', includedSetupFee: true });
    // A canceled sibling is dropped from reuse — the lane expectation decides.
    expect(deriveCloseoutFacts(closedOutInputs({ liveInvoice: null, siblingInvoice: { invoice: { ...sib, status: 'canceled' }, liveBeside: null } })).facts.invoice.state).toBe('pending');
    expect(deriveCloseoutFacts(closedOutInputs({ liveInvoice: null, siblingInvoiceLookupFailed: true })).facts.invoice).toMatchObject({ state: 'unknown', failed: ['sibling_first_application'] });
  });

  test('receipt job completed is classified by channel legs (codex r12)', () => {
    const paid = { id: 'inv-1', status: 'paid', total: 120, sent_at: null, sms_sent_at: null, receipt_sent_at: null, payer_id: null };
    const run = (sms_result, email_result) => deriveCloseoutFacts(closedOutInputs({ liveInvoice: paid, receiptJob: { id: 'rj', status: 'completed', sms_result, email_result } })).facts.invoiceDelivery;
    expect(run({ sent: true }, { ok: false, error: 'No receipt recipient email' })).toMatchObject({ state: 'done', reason: 'paid_receipt_delivered' });
    expect(run({ sent: false, reason: 'no-phone' }, { ok: false, error: 'No receipt recipient email' })).toMatchObject({ state: 'failed', reason: 'receipt_no_recipient' });
    expect(run({ sent: false, reason: 'receipt_texts_opted_out' }, { ok: false, error: 'receipt_opted_out' })).toMatchObject({ state: 'not_required', reason: 'receipt_opted_out', ruleSource: 'consent' });
    expect(run({ sent: false, reason: 'channel_email_only' }, { ok: true })).toMatchObject({ state: 'done' });
    expect(run(null, null)).toMatchObject({ state: 'unknown', reason: 'receipt_job_result_unclassified' });
  });

  test('prepaid (account-credit) invoice with no send timestamps is settled — nothing to deliver', () => {
    const prepaid = { id: 'inv-pp', status: 'prepaid', total: 120, sent_at: null, sms_sent_at: null, payer_id: null };
    const { facts } = deriveCloseoutFacts(closedOutInputs({ liveInvoice: prepaid }));
    expect(facts.invoice).toMatchObject({ state: 'done', reason: 'invoice_paid' });
    expect(facts.invoiceDelivery).toMatchObject({ state: 'done', reason: 'prepaid' });
    expect(summarizeCloseout(facts, []).closedOut).toBe(true);
  });

  test('payer-billed invoice: sent → done payer_invoice_sent; unsent → pending', () => {
    const payer = { id: 'inv-ap', status: 'draft', total: 300, sent_at: null, payer_id: 'payer-1' };
    expect(deriveCloseoutFacts(closedOutInputs({ liveInvoice: payer })).facts.invoiceDelivery)
      .toMatchObject({ state: 'pending', reason: 'payer_invoice_unsent' });
    expect(deriveCloseoutFacts(closedOutInputs({ liveInvoice: { ...payer, sent_at: '2026-08-30T19:00:00Z' } })).facts.invoiceDelivery)
      .toMatchObject({ state: 'done', reason: 'payer_invoice_sent' });
    // Provider-accepted email stamp is delivery evidence even when the later markDeliverySent failed (#3776 r4 P2).
    expect(deriveCloseoutFacts(closedOutInputs({ liveInvoice: { ...payer, email_sent_at: '2026-08-30T19:00:00Z' } })).facts.invoiceDelivery)
      .toMatchObject({ state: 'done', reason: 'payer_invoice_sent', emailSentAt: '2026-08-30T19:00:00.000Z' });
    // Statement-accrued child: never sent individually, in any status — the statement owns delivery (#3776 r2 P2).
    for (const status of ['draft', 'sent', 'paid', 'prepaid']) {
      expect(deriveCloseoutFacts(closedOutInputs({ liveInvoice: { ...payer, status, payer_statement_id: 'stmt-1' } })).facts.invoiceDelivery)
        .toMatchObject({ state: 'not_required', reason: 'statement_accrued', ruleSource: 'payer_statement', payerStatementId: 'stmt-1' });
    }
  });
});

describe('closeout-status: grouped summary evidence', () => {
  test.each([
    [['sent', 'suppressed'], 'done'],
    [['unknown_delivery', 'suppressed'], 'unknown'],
    [['suppressed', 'suppressed'], 'not_required'],
    [['failed', 'claimed'], 'pending'],
  ])('uses the packet delivery outcomes %j for the member report', (statuses, expected) => {
    const { facts } = deriveCloseoutFacts(closedOutInputs({ delivery: null,
      visitSummaryEffects: statuses.map((status, index) => ({ effect_type: index ? 'completion_email' : 'completion_sms', status })),
    }));
    expect(facts.reportDelivery.state).toBe(expected);
    expect(facts.comms.state).toBe(expected);
  });
  test('an unavailable grouped delivery lookup stays unknown', () => {
    const { facts } = deriveCloseoutFacts(closedOutInputs({ delivery: null, visitSummaryLookupFailed: true }));
    expect(facts.reportDelivery).toMatchObject({ state: 'unknown', reason: 'visit_summary_lookup_failed' });
  });
});

describe('closeout-status: comms + follow-up', () => {
  test('completionSmsStatus sent → done; deferred → pending; failed → failed', () => {
    const rec = (status) => ({ ...closedOutInputs().record, structured_notes: { completionSmsStatus: status } });
    expect(deriveCloseoutFacts(closedOutInputs({ record: rec('sent') })).facts.comms.state).toBe('done');
    expect(deriveCloseoutFacts(closedOutInputs({ record: rec('deferred') })).facts.comms).toMatchObject({ state: 'pending', reason: 'deferred_send_window' });
    expect(deriveCloseoutFacts(closedOutInputs({ record: rec('failed') })).facts.comms.state).toBe('failed');
  });

  test('recap claim: aged -> done; fresh (< 10 min) -> pending in-flight (codex r17)', () => {
    // An aged claim ALONE is unverified (stamp precedes the send — GH r4); the
    // explicit skipped_recap stamp remains real evidence.
    const aged = deriveCloseoutFacts(closedOutInputs({
      record: { ...closedOutInputs().record, structured_notes: {}, recap_sms_sent_at: '2026-08-30T18:10:00Z', field_flags: { recap: true } },
      delivery: null,
    }));
    expect(aged.facts.comms).toMatchObject({ state: 'unknown', reason: 'recap_claim_unverified' });
    expect(aged.facts.completion.recapLane).toBe(true);
    const stamped = deriveCloseoutFacts(closedOutInputs({
      record: { ...closedOutInputs().record, structured_notes: { completionSmsStatus: 'skipped_recap_sms_already_sent' } },
    }));
    expect(stamped.facts.comms).toMatchObject({ state: 'done', reason: 'recap_sms_sent' });
    const fresh = deriveCloseoutFacts(closedOutInputs({
      record: { ...closedOutInputs().record, structured_notes: {}, recap_sms_sent_at: new Date(NOW.getTime() - 60 * 1000).toISOString() },
      delivery: null,
    }));
    expect(fresh.facts.comms).toMatchObject({ state: 'pending', reason: 'recap_sms_in_flight' });
    expect(fresh.facts.reportDelivery).toMatchObject({ state: 'pending', reason: 'recap_sms_in_flight' });
  });

  test('evidence on a sibling service_records row counts: token on the older record (codex r17)', () => {
    const rec1 = { ...closedOutInputs().record, id: 'rec-new', report_view_token: null, report_generated_at: null };
    const rec2 = { ...closedOutInputs().record, id: 'rec-old', report_view_token: 't'.repeat(32), report_generated_at: '2026-08-30T18:05:00Z' };
    const { facts } = deriveCloseoutFacts(closedOutInputs({ record: rec1, records: [rec1, rec2] }));
    expect(facts.report).toMatchObject({ state: 'done', reason: 'report_published', hasToken: true });
  });

  test('GH r4: sibling invoice + billing outage → unknown; sibling posture never relabels the token record; non-performed invoice → contradiction; inactive visit beats failed attempt', () => {
    const sib = { id: 'inv-sib', status: 'sent', total: 240, sent_at: '2026-08-30T10:00:00Z', payer_id: null };
    expect(deriveCloseoutFacts(closedOutInputs({ liveInvoice: null, siblingInvoice: { invoice: sib, liveBeside: null }, autopayActive: null })).facts.invoice)
      .toMatchObject({ state: 'unknown', reason: 'billing_inputs_unavailable', invoiceId: 'inv-sib' });
    const rec1 = { ...closedOutInputs().record, id: 'rec-new', report_view_token: null, report_generated_at: null };
    const rec2 = { ...closedOutInputs().record, id: 'rec-old', structured_notes: { typedReportDelivery: 'internal_only' } };
    const posture = deriveCloseoutFacts(closedOutInputs({ record: rec1, records: [rec1, rec2], delivery: null }));
    expect(posture.facts.report).toMatchObject({ state: 'done', audience: 'internal' });
    expect(posture.facts.reportDelivery).toMatchObject({ state: 'not_required', reason: 'frozen_posture_internal_only' });
    const nonPerf = deriveCloseoutFacts(closedOutInputs({
      record: { ...closedOutInputs().record, structured_notes: { visitOutcome: 'inspection_only', completionSmsStatus: 'sent' } },
    }));
    expect(nonPerf.contradictions.map((c) => c.code)).toContain('invoice_on_non_performed_visit');
    expect(summarizeCloseout(nonPerf.facts, nonPerf.contradictions).closedOut).toBe(false);
    const inactive = deriveCloseoutFacts(closedOutInputs({
      visit: { ...closedOutInputs().visit, status: 'cancelled' }, record: null, attempt: { state: 'failed', error: 'x' }, liveInvoice: null, delivery: null,
    }));
    expect(inactive.facts.completion).toMatchObject({ state: 'not_required', reason: 'visit_cancelled', attemptState: 'failed' });
  });

  test('an older sibling report\'s sent delivery does not deliver the newer report (codex r19)', () => {
    const newRec = { ...closedOutInputs().record, id: 'rec-new' };
    const oldRec = { ...closedOutInputs().record, id: 'rec-old' };
    const { facts } = deriveCloseoutFacts(closedOutInputs({
      record: newRec, records: [newRec, oldRec], delivery: null,
      deliveries: [
        { service_record_id: 'rec-new', channel: 'email', status: 'failed', attempts: 5, max_attempts: 5, last_error: 'bounce' },
        { service_record_id: 'rec-old', channel: 'email', status: 'sent', attempts: 1, max_attempts: 5, sent_at: '2026-08-29T18:00:00Z' },
      ],
    }));
    expect(facts.reportDelivery).toMatchObject({ state: 'failed', reason: 'delivery_exhausted' });
    // And within the SAME record, sent still beats a newer failure.
    const same = deriveCloseoutFacts(closedOutInputs({
      record: newRec, records: [newRec], delivery: null,
      deliveries: [
        { service_record_id: 'rec-new', channel: 'sms', status: 'failed', attempts: 5, max_attempts: 5 },
        { service_record_id: 'rec-new', channel: 'email', status: 'sent', attempts: 1, max_attempts: 5, sent_at: '2026-08-30T18:06:00Z' },
      ],
    }));
    expect(same.facts.reportDelivery.state).toBe('done');
  });

  test('GH r5: applications on a non-performed outcome contradict; findings-only applicator counts; tokenNotes mirror scoping', () => {
    const nonPerf = deriveCloseoutFacts(closedOutInputs({
      activeApplicationCount: 2,
      record: { ...closedOutInputs().record, structured_notes: { visitOutcome: 'inspection_only', completionSmsStatus: 'sent' } },
    }));
    expect(nonPerf.facts.application).toMatchObject({ state: 'done', reason: 'applications_despite_non_performed_outcome' });
    expect(nonPerf.contradictions.map((c) => c.code)).toContain('applications_on_non_performed_visit');
    const findingsOnly = deriveCloseoutFacts(closedOutInputs({
      requirements: baseRequirements({ requiresLicense: true, licenseCategory: null }), technician: null, applicatorFindingsId: 'JE362022',
    }));
    expect(findingsOnly.facts.license).toMatchObject({ state: 'done', reason: 'project_applicator_on_findings', applicatorFdacsId: 'JE362022' });
    // A required category cannot be proven from a findings-only id (codex r21).
    const findingsWithCategory = deriveCloseoutFacts(closedOutInputs({
      requirements: baseRequirements({ requiresLicense: true, licenseCategory: 'WDO' }), technician: null, applicatorFindingsId: 'JE362022',
    }));
    expect(findingsWithCategory.facts.license).toMatchObject({ state: 'unknown', reason: 'applicator_category_unverifiable' });
    // Mirror fallback reads the TOKEN record's notes, not the primary's.
    const rec1 = { ...closedOutInputs().record, id: 'rec-new', report_view_token: null, report_generated_at: null, structured_notes: { completionSmsStatus: 'sent' } };
    const rec2 = { ...closedOutInputs().record, id: 'rec-old', structured_notes: { serviceReportV1EmailStatus: 'sent', serviceReportV1EmailSentAt: '2026-08-30T18:06:00Z' } };
    const mirrored = deriveCloseoutFacts(closedOutInputs({ record: rec1, records: [rec1, rec2], delivery: null, deliveries: [] }));
    expect(mirrored.facts.reportDelivery).toMatchObject({ state: 'done', reason: 'delivery_sent_per_record_notes', sentAt: '2026-08-30T18:06:00.000Z' });
  });

  test('license without a recorded expiry stays done (applicator-picker semantics) with expiryUnrecorded surfaced', () => {
    const req = baseRequirements({ requiresLicense: true, licenseCategory: null });
    const { facts } = deriveCloseoutFacts(closedOutInputs({ requirements: req, visit: { ...closedOutInputs().visit, technician_id: 'tech-1' }, technician: { id: 'tech-1', fl_applicator_license: 'JE362022', license_expiry: null, license_categories: null } }));
    expect(facts.license).toMatchObject({ state: 'done', expiryUnrecorded: true });
  });

  test('no comms marker: delivered report email counts; otherwise UNKNOWN, never pending; explicit catalog no-notice → not_required', () => {
    const bare = { ...closedOutInputs().record, structured_notes: {} };
    expect(deriveCloseoutFacts(closedOutInputs({ record: bare })).facts.comms).toMatchObject({ state: 'done', reason: 'report_email_delivered' });
    expect(deriveCloseoutFacts(closedOutInputs({ record: bare, delivery: null })).facts.comms)
      .toMatchObject({ state: 'unknown', reason: 'no_comms_marker_on_record' });
    expect(deriveCloseoutFacts(closedOutInputs({ record: bare, delivery: null, requirements: baseRequirements({ requiresCustomerNotice: false }) })).facts.comms)
      .toMatchObject({ state: 'not_required', reason: 'catalog_no_customer_notice', ruleSource: 'catalog' });
  });

  test('backfill completion: invoice, comms, report (when absent) are not_required, sourced from the frozen record', () => {
    const { facts } = deriveCloseoutFacts(closedOutInputs({
      record: { ...closedOutInputs().record, structured_notes: { backfill: true }, report_view_token: null, report_generated_at: null },
      completedFormCount: 0, delivery: null, liveInvoice: null,
    }));
    expect(facts.invoice).toMatchObject({ state: 'not_required', reason: 'backfill_completion', ruleSource: 'frozen_record' });
    expect(facts.comms).toMatchObject({ state: 'not_required', reason: 'backfill_completion' });
    expect(facts.report).toMatchObject({ state: 'not_required', reason: 'backfill_completion' });
  });

  test('follow-up: frozen required + live child → done; required + no child → pending; verdict not required → not_required; lookup failed → unknown', () => {
    // typedFollowupVerdict names the window `days` (projectFollowupSuggestion).
    const required = { suggestion: { required: true, days: 14, reason: 'knockdown' }, frozen: true, serviceRecordId: REC };
    expect(deriveCloseoutFacts(closedOutInputs({ followup: required, followupChild: { id: 'svc-2', status: 'confirmed', scheduled_date: '2026-09-12' } })).facts.followUp)
      .toMatchObject({ state: 'done', childServiceId: 'svc-2', childScheduledDate: '2026-09-12' });
    expect(deriveCloseoutFacts(closedOutInputs({ followup: required })).facts.followUp)
      .toMatchObject({ state: 'pending', reason: 'followup_required_not_booked', windowDays: 14, verdictReason: 'knockdown' });
    expect(deriveCloseoutFacts(closedOutInputs({ followup: { suggestion: { required: false }, frozen: true } })).facts.followUp)
      .toMatchObject({ state: 'not_required', reason: 'typed_verdict_not_required', frozen: true });
    expect(deriveCloseoutFacts(closedOutInputs({ followup: undefined })).facts.followUp.state).toBe('unknown');
    expect(deriveCloseoutFacts(closedOutInputs({ followup: required, followupChildLookupFailed: true })).facts.followUp.state).toBe('unknown');
  });
});

describe('closeout-status: grouped stops + summary', () => {
  test('a visit inside a service_visits group reports the packet, per-service facts stay per-service', () => {
    const { packet } = deriveCloseoutFacts(closedOutInputs({
      visit: { ...closedOutInputs().visit, visit_id: 'grp-1' },
      packets: [{ id: 'pk-1', status: 'processing' }], packetMemberIds: ['svc-1', 'svc-9'],
    }));
    expect(packet).toMatchObject({ visitId: 'grp-1', activePacket: true, memberServiceIds: ['svc-1', 'svc-9'], packetStatuses: ['processing'] });
  });

  test('summarizeCloseout keeps unknown separate from open so an outage never reads as a compliance gap', () => {
    const { facts } = deriveCloseoutFacts(closedOutInputs({ photoCount: null, requirements: baseRequirements({ requiredPhotoCount: 2 }), liveInvoice: null }));
    const summary = summarizeCloseout(facts);
    expect(summary.unknown).toEqual(['photos']);
    expect(summary.open).toEqual(['invoice', 'invoiceDelivery']);
    expect(summary.closedOut).toBe(false);
  });

  test('deriveBillingExpectation returns null without a customer/lane instead of guessing', () => {
    expect(deriveBillingExpectation({ visit: closedOutInputs().visit, customer: null, lane: null })).toBeNull();
  });
});

describe('closeout-status: Agent D findings', () => {
  test('P0 project/WDO visit: report lives on projects.report_token, delivery on projects.delivery_status', () => {
    const projectVisit = closedOutInputs({
      visit: { ...closedOutInputs().visit, service_type: 'WDO Inspection' },
      record: { ...closedOutInputs().record, completion_source: 'project_completion', report_view_token: null, report_generated_at: null, structured_notes: {} },
      completedFormCount: 0, delivery: null,
      project: { id: 'proj-1', status: 'closed', report_token: 'c'.repeat(32), delivery_status: 'sent', last_delivery_at: '2026-08-30T19:00:00Z' },
    });
    const { facts } = deriveCloseoutFacts(projectVisit);
    expect(facts.report).toMatchObject({ state: 'done', reason: 'project_report_published', projectId: 'proj-1', source: 'projects.report_token' });
    expect(facts.reportDelivery).toMatchObject({ state: 'done', reason: 'project_delivery_sent', deliveryStatus: 'sent' });
    expect(facts.comms).toMatchObject({ state: 'done', reason: 'project_report_delivered' });
  });

  test('project report on payment hold → pending on_hold; failed delivery → failed; legacy_sent → done; no token → pending', () => {
    const base = closedOutInputs({
      record: { ...closedOutInputs().record, completion_source: 'project_completion', report_view_token: null, report_generated_at: null, structured_notes: {} },
      delivery: null,
    });
    const proj = (o) => ({ id: 'proj-1', status: 'closed', report_token: 'c'.repeat(32), delivery_status: 'not_sent', ...o });
    expect(deriveCloseoutFacts({ ...base, project: proj({ report_hold_status: 'held' }) }).facts.reportDelivery)
      .toMatchObject({ state: 'pending', reason: 'project_report_on_hold', reportHoldStatus: 'held' });
    expect(deriveCloseoutFacts({ ...base, project: proj({ delivery_status: 'failed' }) }).facts.reportDelivery.state).toBe('failed');
    expect(deriveCloseoutFacts({ ...base, project: proj({ delivery_status: 'legacy_sent' }) }).facts.reportDelivery.state).toBe('done');
    expect(deriveCloseoutFacts({ ...base, project: proj({ report_token: null }) }).facts.report)
      .toMatchObject({ state: 'pending', reason: 'project_closed_without_report' });
    expect(deriveCloseoutFacts({ ...base, project: null, projectLookupFailed: true }).facts.report.state).toBe('unknown');
  });

  test('project-backed photos are counted from project_photos (source surfaced); WDO 2-photo rule then passes', () => {
    const { facts } = deriveCloseoutFacts(closedOutInputs({
      requirements: baseRequirements({ requiredPhotoCount: 2 }),
      record: { ...closedOutInputs().record, completion_source: 'project_completion' },
      project: { id: 'proj-1', status: 'closed', report_token: 'c'.repeat(32), delivery_status: 'sent' },
      photoCount: 2, photoSource: 'project_photos',
    }));
    expect(facts.photos).toMatchObject({ state: 'done', source: 'project_photos', actual: 2 });
  });

  test('annual-coverage authority outage → invoice unknown, never "covered" via the stale stamp', () => {
    const { facts, contradictions } = deriveCloseoutFacts(closedOutInputs({
      customer: { id: 'cust-1', billing_mode: 'annual_prepay', autopay_enabled: false },
      lane: { mode: 'annual_prepay', source: 'explicit' },
      visit: { ...closedOutInputs().visit, prepaid_method: 'annual_prepay_invoice', estimated_price: null },
      annualCoverageValidated: null, annualCoverageLookupFailed: true, liveInvoice: null,
    }));
    expect(facts.invoice).toMatchObject({ state: 'unknown', reason: 'billing_inputs_unavailable', failed: ['annual_coverage'] });
    expect(summarizeCloseout(facts).closedOut).toBe(false);
    expect(contradictions).toEqual([]);
  });

  test('active rows = 0 but the retracted-row lookup failed → unknown (cannot tell empty from all-retracted)', () => {
    const { facts } = deriveCloseoutFacts(closedOutInputs({ activeApplicationCount: 0, retractedApplicationCount: null }));
    expect(facts.application).toMatchObject({ state: 'unknown', reason: 'application_history_lookup_failed' });
  });

  test('frozen backfillMintRequired posture overrides a now-covered lane AND the backfill not_required shortcut', () => {
    const member = closedOutInputs({
      customer: { id: 'cust-1', billing_mode: 'monthly_membership', waveguard_tier: 'Silver', monthly_rate: 89, autopay_enabled: true },
      lane: { mode: 'monthly_membership', source: 'explicit' }, autopayActive: true,
      visit: { ...closedOutInputs().visit, estimated_price: null }, liveInvoice: null,
      record: { ...closedOutInputs().record, structured_notes: { backfill: true, backfillMintRequired: true, backfillMintAmountCents: 12000, completionSmsStatus: 'sent' } },
    });
    const { facts } = deriveCloseoutFacts(member);
    expect(facts.invoice).toMatchObject({ state: 'pending', reason: 'frozen_required_mint_not_minted', amount: 120, ruleSource: 'frozen_record', livePrediction: 'covered_membership' });
  });

  test('project report payment hold wins over delivery_status sent; partial honors the channel ledger; released + sent is done', () => {
    const base = closedOutInputs({
      record: { ...closedOutInputs().record, completion_source: 'project_completion', report_view_token: null, report_generated_at: null, structured_notes: { completionSmsStatus: 'sent' } },
      delivery: null,
    });
    const proj = (o) => ({ id: 'proj-1', status: 'closed', report_token: 'c'.repeat(32), delivery_status: 'sent', ...o });
    expect(deriveCloseoutFacts({ ...base, project: proj({ report_hold_status: 'held' }) }).facts.reportDelivery)
      .toMatchObject({ state: 'pending', reason: 'project_report_on_hold', reportHoldStatus: 'held' });
    expect(deriveCloseoutFacts({ ...base, project: proj({ report_hold_status: 'releasing' }) }).facts.reportDelivery.state).toBe('pending');
    expect(deriveCloseoutFacts({ ...base, project: proj({ report_hold_status: 'released' }) }).facts.reportDelivery.state).toBe('done');
    expect(deriveCloseoutFacts({ ...base, project: proj({ delivery_status: 'partial', delivery_channels: { email: { ok: true }, sms: { ok: false } } }) }).facts.reportDelivery)
      .toMatchObject({ state: 'done', reason: 'project_delivery_partial', channelOk: { email: true, sms: false } });
    expect(deriveCloseoutFacts({ ...base, project: proj({ delivery_status: 'partial', delivery_channels: { email: { ok: false }, sms: { ok: false } } }) }).facts.reportDelivery)
      .toMatchObject({ state: 'failed', reason: 'project_delivery_partial_no_channel' });
    // WDO is email-only: SMS success alone does not deliver the FDACS report; a payer leg never counts.
    expect(deriveCloseoutFacts({ ...base, project: proj({ project_type: 'wdo_inspection', delivery_status: 'partial', delivery_channels: { email: { ok: false }, sms: { ok: true } } }) }).facts.reportDelivery.state).toBe('failed');
    expect(deriveCloseoutFacts({ ...base, project: proj({ delivery_status: 'partial', delivery_channels: { payer_email: { ok: true } } }) }).facts.reportDelivery.state).toBe('failed');
  });

  test('frozen visitOutcome inspection_only / customer_declined → invoice + application not_required (nothing performed)', () => {
    for (const outcome of ['inspection_only', 'customer_declined']) {
      const { facts } = deriveCloseoutFacts(closedOutInputs({
        liveInvoice: null, activeApplicationCount: 0, retractedApplicationCount: 0,
        record: { ...closedOutInputs().record, structured_notes: { visitOutcome: outcome, completionSmsStatus: 'sent', backfillMintRequired: true, backfillMintAmountCents: 9900 } },
      }));
      expect(facts.invoice).toMatchObject({ state: 'not_required', reason: `visit_outcome_${outcome}`, ruleSource: 'frozen_record' });
      expect(facts.application).toMatchObject({ state: 'not_required', reason: `visit_outcome_${outcome}` });
    }
    // A performed outcome leaves the normal rules in force.
    expect(deriveCloseoutFacts(closedOutInputs({ liveInvoice: null, record: { ...closedOutInputs().record, structured_notes: { visitOutcome: 'completed', completionSmsStatus: 'sent' } } })).facts.invoice.state).toBe('pending');
  });

  test('GH r2: customer lookup failure → invoice unknown; rescheduled child does not satisfy follow-up; indeterminate follow-up → unknown; license judged at service_date', () => {
    expect(deriveCloseoutFacts(closedOutInputs({ customer: null, lane: null, customerLookupFailed: true })).facts.invoice)
      .toMatchObject({ state: 'unknown', reason: 'billing_inputs_unavailable', failed: ['customer'] });
    const required = { suggestion: { required: true, days: 14 }, frozen: true };
    expect(deriveCloseoutFacts(closedOutInputs({ followup: { indeterminate: true, reason: 'typed_snapshot_missing', serviceRecordId: REC } })).facts.followUp)
      .toMatchObject({ state: 'unknown', reason: 'followup_typed_snapshot_missing' });
    expect(deriveCloseoutFacts(closedOutInputs({ followup: required, followupChild: null })).facts.followUp.state).toBe('pending');
    const req = baseRequirements({ requiresLicense: true });
    const tech = { id: 'tech-1', fl_applicator_license: 'JF1', license_expiry: '2026-08-31', license_categories: [] };
    const late = deriveCloseoutFacts(closedOutInputs({ requirements: req, visit: { ...closedOutInputs().visit, technician_id: 'tech-1', scheduled_date: '2026-08-30' }, record: { ...closedOutInputs().record, service_date: '2026-09-01' }, technician: tech }));
    expect(late.facts.license).toMatchObject({ state: 'failed', reason: 'technician_license_expired_at_visit', judgedAt: '2026-09-01' });
  });

  test('license fact: catalog requirement vs technician license, expiry at visit date, category match', () => {
    const req = baseRequirements({ requiresLicense: true, licenseCategory: 'Lawn & Ornamental' });
    const tech = (o) => ({ id: 'tech-1', fl_applicator_license: 'JF123456', license_expiry: '2027-01-01', license_categories: ['Lawn & Ornamental', 'General Household Pest'], ...o });
    const run = (o) => deriveCloseoutFacts(closedOutInputs({ requirements: req, visit: { ...closedOutInputs().visit, technician_id: 'tech-1' }, technician: tech(), ...o })).facts.license;
    expect(run({})).toMatchObject({ state: 'done', reason: 'technician_licensed', asOf: 'current_technician_row' });
    expect(run({ technician: tech({ license_expiry: '2026-08-01' }) })).toMatchObject({ state: 'failed', reason: 'technician_license_expired_at_visit' });
    expect(run({ technician: tech({ license_categories: '["Termite"]' }) })).toMatchObject({ state: 'failed', reason: 'technician_license_category_mismatch' });
    // Catalog codes vs technician labels canonicalize to the same category (codex r14).
    const ghpReq = baseRequirements({ requiresLicense: true, licenseCategory: 'GHP' });
    expect(deriveCloseoutFacts(closedOutInputs({ requirements: ghpReq, visit: { ...closedOutInputs().visit, technician_id: 'tech-1' }, technician: tech({ license_categories: ['General Household Pest'] }) })).facts.license.state).toBe('done');
    const loReq = baseRequirements({ requiresLicense: true, licenseCategory: 'L&O' });
    expect(deriveCloseoutFacts(closedOutInputs({ requirements: loReq, visit: { ...closedOutInputs().visit, technician_id: 'tech-1' }, technician: tech({ license_categories: ['Lawn and Ornamental'] }) })).facts.license.state).toBe('done');
    expect(deriveCloseoutFacts(closedOutInputs({ requirements: loReq, visit: { ...closedOutInputs().visit, technician_id: 'tech-1' }, technician: tech({ license_categories: ['GHP'] }) })).facts.license.state).toBe('failed');
    expect(run({ technician: tech({ license_categories: null }) })).toMatchObject({ state: 'unknown', reason: 'technician_license_categories_unrecorded' });
    expect(run({ technician: tech({ fl_applicator_license: null }) })).toMatchObject({ state: 'pending', reason: 'technician_license_missing' });
    expect(run({ technician: null, technicianLookupFailed: true })).toMatchObject({ state: 'unknown', reason: 'technicians_lookup_failed' });
    expect(run({ technician: null })).toMatchObject({ state: 'pending', reason: 'no_technician_on_visit' });
    expect(deriveCloseoutFacts(closedOutInputs()).facts.license).toMatchObject({ state: 'not_required', reason: 'catalog_no_license_required' });
  });

  test('comms vocabulary: sending → pending, blocked → not_required (consent), skipped_recap → done; immediate-path sentSmsAt is read', () => {
    const rec = (status, extra = {}) => ({ ...closedOutInputs().record, structured_notes: { completionSmsStatus: status, ...extra } });
    expect(deriveCloseoutFacts(closedOutInputs({ record: rec('sending') })).facts.comms).toMatchObject({ state: 'pending', reason: 'completion_sms_sending' });
    expect(deriveCloseoutFacts(closedOutInputs({ record: rec('blocked') })).facts.comms).toMatchObject({ state: 'not_required', reason: 'completion_sms_blocked_consent', ruleSource: 'consent' });
    expect(deriveCloseoutFacts(closedOutInputs({ record: rec('skipped_recap_sms_already_sent') })).facts.comms).toMatchObject({ state: 'done', reason: 'recap_sms_sent' });
    expect(deriveCloseoutFacts(closedOutInputs({ record: rec('sent', { sentSmsAt: '2026-08-30T18:07:00Z' }) })).facts.comms.deliveredAt).toBe('2026-08-30T18:07:00.000Z');
  });

  test('report delivery with no queue row falls back to the record-notes mirror: disabled → kill_switch not_required, sent → done, failed → failed', () => {
    const rec = (status, extra = {}) => ({ ...closedOutInputs().record, structured_notes: { completionSmsStatus: 'sent', serviceReportV1EmailStatus: status, ...extra } });
    expect(deriveCloseoutFacts(closedOutInputs({ delivery: null, record: rec('disabled') })).facts.reportDelivery)
      .toMatchObject({ state: 'not_required', reason: 'report_email_kill_switch', ruleSource: 'kill_switch' });
    expect(deriveCloseoutFacts(closedOutInputs({ delivery: null, record: rec('sent', { serviceReportV1EmailSentAt: '2026-08-30T18:06:00Z' }) })).facts.reportDelivery)
      .toMatchObject({ state: 'done', sentAt: '2026-08-30T18:06:00.000Z' });
    expect(deriveCloseoutFacts(closedOutInputs({ delivery: null, record: rec('failed', { serviceReportV1EmailError: 'bounce for jane@example.com' }) })).facts.reportDelivery)
      .toMatchObject({ state: 'failed', lastError: 'bounce for [email]' });
    expect(deriveCloseoutFacts(closedOutInputs({ delivery: null, record: rec('skipped', { serviceReportV1EmailError: 'No service report recipient email' }) })).facts.reportDelivery)
      .toMatchObject({ state: 'failed', reason: 'delivery_skipped_no_recipient' });
    expect(deriveCloseoutFacts(closedOutInputs({ delivery: null, record: rec('skipped', { serviceReportV1EmailError: 'Email suppressed' }) })).facts.reportDelivery)
      .toMatchObject({ state: 'not_required', reason: 'delivery_skipped_suppressed' });
  });

  test('non-V1 template with no delivery row → unknown (not a gap); recap-lane SMS counts as report delivery', () => {
    const typed = { ...closedOutInputs().record, report_template_version: 'wdo_typed_v2', structured_notes: { completionSmsStatus: 'sent' } };
    expect(deriveCloseoutFacts(closedOutInputs({ delivery: null, record: typed })).facts.reportDelivery)
      .toMatchObject({ state: 'unknown', reason: 'no_delivery_row_for_template', templateVersion: 'wdo_typed_v2' });
    const recap = { ...closedOutInputs().record, recap_sms_sent_at: '2026-08-30T18:10:00Z', structured_notes: {} };
    expect(deriveCloseoutFacts(closedOutInputs({ delivery: null, record: recap })).facts.reportDelivery)
      .toMatchObject({ state: 'unknown', reason: 'recap_claim_unverified' });
  });

  test('refunded sibling beside a PAID live invoice stays PARKED — refund.failed can restore the refunded row (codex P0)', () => {
    const { facts } = deriveCloseoutFacts(closedOutInputs({
      liveInvoice: { ...closedOutInputs().liveInvoice, status: 'paid' },
      terminalInvoice: { id: 'inv-refunded', status: 'refunded' },
    }));
    expect(facts.invoice).toMatchObject({ state: 'pending', reason: 'parked_manual_refunded_invoice', liveBesideStatus: 'paid' });
    expect(summarizeCloseout(facts).closedOut).toBe(false);
  });

  test('billing input outages (autopay / dues / payer) → invoice unknown with the failed inputs named', () => {
    const noInvoice = { liveInvoice: null };
    expect(deriveCloseoutFacts(closedOutInputs({ ...noInvoice, autopayActive: null })).facts.invoice)
      .toMatchObject({ state: 'unknown', reason: 'billing_inputs_unavailable', failed: ['autopay'] });
    expect(deriveCloseoutFacts(closedOutInputs({ ...noInvoice, duesLookupFailed: true })).facts.invoice.failed).toEqual(['monthly_dues']);
    expect(deriveCloseoutFacts(closedOutInputs({ ...noInvoice, payerBilled: null })).facts.invoice.failed).toEqual(['bill_to_payer']);
    // A live invoice is evidence but not a verdict while inputs are unreadable (GH r1).
    expect(deriveCloseoutFacts(closedOutInputs({ autopayActive: null })).facts.invoice).toMatchObject({ state: 'unknown', invoiceId: 'inv-1' });
  });

  test('rescheduled visit is a phantom row → nothing owed', () => {
    const { facts } = deriveCloseoutFacts(closedOutInputs({
      visit: { ...closedOutInputs().visit, status: 'rescheduled' }, record: null, attempt: { state: 'none' }, liveInvoice: null, delivery: null,
    }));
    expect(facts.completion).toMatchObject({ state: 'not_required', reason: 'visit_rescheduled' });
    expect(facts.invoice.state).toBe('not_required');
  });

  test('record marked incomplete → completion pending, every downstream fact not_required (visit will be rescheduled)', () => {
    const { facts } = deriveCloseoutFacts(closedOutInputs({ record: { ...closedOutInputs().record, status: 'incomplete' } }));
    expect(facts.completion.state).toBe('pending');
    for (const name of FACT_NAMES.filter((n) => n !== 'completion')) {
      expect(facts[name]).toMatchObject({ state: 'not_required', reason: 'record_marked_incomplete' });
    }
  });

  test('error text is scrubbed (emails, long tokens, long digit runs) before it leaves the service', () => {
    const { facts } = deriveCloseoutFacts(closedOutInputs({
      delivery: { channel: 'email', status: 'failed', attempts: 5, max_attempts: 5, last_error: 'SMTP 550 for bob@example.com token ' + 'a'.repeat(32) + ' acct 12345678' },
    }));
    expect(facts.reportDelivery.lastError).toBe('SMTP 550 for [email] token [token] acct [digits]');
    const failed = deriveCloseoutFacts(closedOutInputs({ record: null, attempt: { state: 'failed', error: 'x jane@x.io' }, visit: { ...closedOutInputs().visit, status: 'on_site' } }));
    expect(failed.facts.completion.error).toBe('x [email]');
  });

  test('billing expectation branches: prepaid out-of-band → not_required; per_application autopay → expected_auto_charge_not_minted', () => {
    const prepaid = closedOutInputs({ visit: { ...closedOutInputs().visit, prepaid_method: 'cash', prepaid_amount: 120 }, liveInvoice: null });
    expect(deriveCloseoutFacts(prepaid).facts.invoice).toMatchObject({ state: 'not_required', reason: 'lane_prepaid' });
    const perApp = closedOutInputs({
      customer: { id: 'cust-1', billing_mode: 'per_application', per_application_fee: 98, autopay_enabled: true },
      lane: { mode: 'per_application', source: 'explicit' }, autopayActive: true,
      visit: { ...closedOutInputs().visit, estimated_price: null }, liveInvoice: null,
    });
    expect(deriveCloseoutFacts(perApp).facts.invoice).toMatchObject({ state: 'pending', reason: 'expected_auto_charge_not_minted', amount: 98 });
  });
});

describe('typed-followup-obligation: strict mode', () => {
  const actual = jest.requireActual('../services/typed-followup-obligation');
  const failingKnex = () => {
    const err = new Error('records offline');
    const q = { where() { return q; }, orderBy() { return q; }, first() { return q; }, then(res, rej) { return Promise.reject(err).then(res, rej); }, catch(fn) { return Promise.reject(err).catch(fn); } };
    return q;
  };
  const completed = { id: 'svc-1', status: 'completed' };

  test('default swallows the record lookup failure as null (legacy callers unchanged)', async () => {
    await expect(actual.typedFollowupObligationForCompletedSource({ scheduledService: completed, knex: failingKnex })).resolves.toBeNull();
  });

  test('strict propagates it so the closeout probe records an outage', async () => {
    await expect(actual.typedFollowupObligationForCompletedSource({ scheduledService: completed, knex: failingKnex, strict: true })).rejects.toThrow('records offline');
  });
});

describe('service-closeout-requirements: strict mode', () => {
  const actual = jest.requireActual('../services/service-closeout-requirements');
  // Real knex fails at await time, not at builder time — mirror that.
  const throwingKnex = () => {
    const err = new Error('catalog offline');
    const q = {
      where() { return q; },
      then(res, rej) { return Promise.reject(err).then(res, rej); },
      catch(fn) { return Promise.reject(err).catch(fn); },
    };
    return { select: () => q };
  };

  test('default mode degrades a catalog failure to fallback inference (legacy behavior, unchanged)', async () => {
    const map = await actual.resolveCloseoutRequirementsForJobs([{ id: 'j1', service_id: 'cat-1', service_type: 'Pest' }], { knex: throwingKnex });
    expect(map.get('j1').source).toBe('fallback_inference');
  });

  test('strict mode propagates the failure so a status reader can say unknown instead of guessing', async () => {
    await expect(actual.resolveCloseoutRequirementsForJobs([{ id: 'j1', service_id: 'cat-1', service_type: 'Pest' }], { knex: throwingKnex, strict: true }))
      .rejects.toThrow('catalog offline');
  });
});

// ---------------------------------------------------------------------------
// Loader against a fake knex: table-keyed canned rows + a minimal where engine.
// ---------------------------------------------------------------------------
function makeFakeKnex(tables) {
  return function knex(table) {
    const source = tables[table];
    if (source instanceof Error) throw source;
    let rows = Array.isArray(source) ? [...source] : [];
    const chain = {
      where(criteria) {
        if (criteria && typeof criteria === 'object') {
          rows = rows.filter((r) => Object.entries(criteria).every(([k, v]) => r[k] === v));
        }
        return chain;
      },
      orWhere(criteria) {
        const extra = (Array.isArray(source) ? source : []).filter((r) => Object.entries(criteria).every(([k, v]) => r[k] === v));
        for (const r of extra) if (!rows.includes(r)) rows.push(r);
        return chain;
      },
      orWhereIn(col, values) {
        const extra = (Array.isArray(source) ? source : []).filter((r) => values.includes(r[col]));
        for (const r of extra) if (!rows.includes(r)) rows.push(r);
        return chain;
      },
      whereIn(col, values) { rows = rows.filter((r) => values.includes(r[col])); return chain; },
      whereNotIn(col, values) { rows = rows.filter((r) => !values.includes(r[col])); return chain; },
      whereNull(col) { rows = rows.filter((r) => r[col] == null); return chain; },
      whereNotNull(col) { rows = rows.filter((r) => r[col] != null); return chain; },
      whereNot(col, v) { rows = rows.filter((r) => r[col] !== v); return chain; },
      orderBy() { return chain; },
      select() { return Promise.resolve(rows); },
      count() { chain._count = true; return chain; },
      first() { return Promise.resolve(chain._count ? { n: rows.length } : (rows[0] || null)); },
      then(resolve, reject) { return Promise.resolve(rows).then(resolve, reject); },
    };
    // knex's where(fn) form used by the invoice-candidate lookups.
    const origWhere = chain.where;
    chain.where = (criteria) => {
      if (typeof criteria === 'function') {
        const collected = [];
        const inCollected = [];
        criteria({
          orWhere: (c) => { collected.push(c); },
          where: (c) => { collected.push(c); },
          orWhereIn: (col, values) => { inCollected.push([col, values]); },
        });
        rows = rows.filter((r) => collected.some((c) => Object.entries(c).every(([k, v]) => r[k] === v))
          || inCollected.some(([col, values]) => values.includes(r[col])));
        return chain;
      }
      return origWhere(criteria);
    };
    return chain;
  };
}

describe('closeout-status: loader against a fake knex', () => {
  const visitRow = {
    id: SVC, customer_id: 'cust-1', status: 'completed', scheduled_date: '2026-08-30', completed_at: '2026-08-30T18:00:00Z',
    service_type: 'Quarterly Pest Control', service_id: 'cat-pest', is_callback: false, is_recurring: true, estimated_price: 120,
  };
  const recordRow = {
    id: REC, scheduled_service_id: SVC, status: 'completed', completion_source: 'detailed_form', created_at: '2026-08-30T18:01:00Z',
    report_view_token: 'b'.repeat(32), report_generated_at: '2026-08-30T18:05:00Z', structured_notes: { completionSmsStatus: 'sent' },
  };
  const healthyTables = () => ({
    scheduled_services: [visitRow],
    customers: [{ id: 'cust-1', billing_mode: 'per_visit', autopay_enabled: false }],
    service_records: [recordRow],
    service_completion_attempts: [{ service_id: SVC, status: 'succeeded', service_record_id: REC, updated_at: '2026-08-30T18:01:00Z' }],
    job_form_submissions: [{ scheduled_service_id: SVC, completed_at: '2026-08-30T18:00:30Z' }],
    property_application_history: [{ service_record_id: REC, retracted_at: null }],
    service_photos: [],
    service_report_deliveries: [{ service_record_id: REC, channel: 'email', status: 'sent', attempts: 1, max_attempts: 5, sent_at: '2026-08-30T18:06:00Z' }],
    invoices: [{ id: 'inv-1', service_record_id: REC, scheduled_service_id: SVC, status: 'sent', total: 120, sent_at: '2026-08-30T18:06:00Z', created_at: '2026-08-30T18:02:00Z' }],
    payers: [],
    projects: [],
    project_photos: [],
    visit_billing_dispositions: [],
    receipt_delivery_jobs: [],
    technicians: [],
  });

  beforeEach(() => {
    catalogRows.length = 0;
    catalogRows.push({
      id: 'cat-pest', name: 'Quarterly Pest Control', category: 'pest_control', closeout_requirements_source: 'catalog_v2',
      requires_service_report: true, requires_application_log: true, required_photo_count: 0,
    });
  });

  test('healthy rows → fully closed out, no unavailable lookups', async () => {
    const result = await getCloseoutStatus(SVC, { knex: makeFakeKnex(healthyTables()), now: NOW });
    expect(result.found).toBe(true);
    expect(result.unavailable).toEqual([]);
    expect(result.summary.closedOut).toBe(true);
    expect(result.requirements.asOf).toBe('current_catalog');
    expect(result.requirements.unevaluated).toEqual([]);
    expect(result.visit).toMatchObject({ status: 'completed', serviceType: 'Quarterly Pest Control', isCallback: false });
    expect(result.record).toMatchObject({ id: REC, backfill: false, posture: 'auto_send' });
  });

  test('a failing table lands in `unavailable` and its fact reads unknown — the loader never throws and never says "missing"', async () => {
    const tables = healthyTables();
    tables.service_photos = new Error('relation "service_photos" does not exist');
    catalogRows[0].required_photo_count = 2;
    const result = await getCloseoutStatus(SVC, { knex: makeFakeKnex(tables), now: NOW });
    expect(result.unavailable.map((u) => u.lookup)).toEqual(['service_photos']);
    expect(result.facts.photos).toMatchObject({ state: 'unknown', reason: 'service_photos_lookup_failed', required: 2 });
    expect(result.summary.unknown).toEqual(['photos']);
    expect(result.summary.open).toEqual([]);
  });

  test('catalog requiresCustomerSignature → requirements.unevaluated + summary.closedOut false — but not for a cancelled visit', async () => {
    catalogRows[0].requires_customer_signature = true;
    const result = await getCloseoutStatus(SVC, { knex: makeFakeKnex(healthyTables()), now: NOW });
    expect(result.requirements.unevaluated).toEqual(['requiresCustomerSignature']);
    expect(result.summary).toMatchObject({ unevaluated: ['requiresCustomerSignature'], closedOut: false });
    const tables = healthyTables();
    tables.scheduled_services = [{ ...visitRow, status: 'cancelled' }]; tables.service_records = []; tables.service_completion_attempts = []; tables.invoices = [];
    const cancelled = await getCloseoutStatus(SVC, { knex: makeFakeKnex(tables), now: NOW });
    expect(cancelled.summary).toMatchObject({ unevaluated: [], closedOut: true });
  });

  test('typed-followup-obligation strict: pre-freeze snapshot mismatch is indeterminate, default stays null', async () => {
    const actual = jest.requireActual('../services/typed-followup-obligation');
    const rec = { id: REC, structured_notes: {}, service_data: { typedReportSnapshot: { type: 'other', values: {} } } };
    const q = { where() { return q; }, orderBy() { return q; }, first() { return Promise.resolve(rec); } };
    const knex = () => q;
    jest.doMock('../services/service-completion-profiles', () => ({ resolveCompletionProfileForScheduledService: async () => ({ findingsType: 'cockroach', followupPolicy: 'alert' }) }));
    jest.resetModules();
    const fresh = jest.requireActual('../services/typed-followup-obligation');
    const completed = { id: SVC, status: 'completed' };
    await expect(fresh.typedFollowupObligationForCompletedSource({ scheduledService: completed, knex, strict: true })).resolves.toMatchObject({ indeterminate: true, reason: 'typed_snapshot_type_mismatch' });
    await expect(fresh.typedFollowupObligationForCompletedSource({ scheduledService: completed, knex })).resolves.toBeNull();
    jest.dontMock('../services/service-completion-profiles');
    // A synthesized fallback profile (row removed/deactivated) meeting a typed snapshot is indeterminate in strict mode (GH r3).
    jest.doMock('../services/service-completion-profiles', () => ({ resolveCompletionProfileForScheduledService: async () => ({ synthesized: true, findingsType: null, followupPolicy: 'none' }) }));
    jest.resetModules();
    const fresh2 = jest.requireActual('../services/typed-followup-obligation');
    await expect(fresh2.typedFollowupObligationForCompletedSource({ scheduledService: completed, knex, strict: true })).resolves.toMatchObject({ indeterminate: true, reason: 'profile_fallback_with_typed_snapshot' });
    await expect(fresh2.typedFollowupObligationForCompletedSource({ scheduledService: completed, knex })).resolves.toBeNull();
    jest.dontMock('../services/service-completion-profiles');
    void actual;
  });

  test('follow-up resolves from the attempt-committed record; projects resolve via a secondary record link (GH r4)', async () => {
    followupMock.mockClear();
    const tables = healthyTables();
    const rec2 = { ...recordRow, id: 'rec-old', created_at: '2026-08-30T17:00:00Z', report_view_token: null, report_generated_at: null };
    tables.service_records = [recordRow, rec2];
    tables.projects = [{ id: 'proj-2', scheduled_service_id: null, service_record_id: 'rec-old', status: 'closed', report_token: 'e'.repeat(32), delivery_status: 'sent', created_at: '2026-08-30T18:03:00Z' }];
    const result = await getCloseoutStatus(SVC, { knex: makeFakeKnex(tables), now: NOW });
    expect(followupMock).toHaveBeenCalledWith(expect.objectContaining({ recordId: REC }));
    expect(result.visit.projectId).toBe('proj-2');
    expect(result.facts.report).toMatchObject({ state: 'done', reason: 'project_report_published' });
  });

  test('a project linked through projects.scheduled_service_id drives report, delivery, and photos', async () => {
    const tables = healthyTables();
    tables.service_records = [{ ...recordRow, completion_source: 'project_completion', report_view_token: null, report_generated_at: null }];
    tables.service_report_deliveries = [];
    tables.projects = [{ id: 'proj-1', scheduled_service_id: SVC, service_record_id: null, status: 'closed', report_token: 'd'.repeat(32), delivery_status: 'sent', created_at: '2026-08-30T18:03:00Z' }];
    tables.project_photos = [{ project_id: 'proj-1', visit: 'primary' }, { project_id: 'proj-1', visit: 'primary' }, { project_id: 'proj-1', visit: 'followup' }];
    catalogRows[0].required_photo_count = 2;
    const result = await getCloseoutStatus(SVC, { knex: makeFakeKnex(tables), now: NOW });
    expect(result.unavailable).toEqual([]);
    expect(result.visit.projectId).toBe('proj-1');
    expect(result.facts.report).toMatchObject({ state: 'done', reason: 'project_report_published' });
    expect(result.facts.reportDelivery).toMatchObject({ state: 'done', reason: 'project_delivery_sent' });
    expect(result.facts.photos).toMatchObject({ state: 'done', actual: 2, source: 'project_photos' });
  });

  test('visit status that moves mid-read RESTARTS the load — all probes see the new row, no contradiction (GH r3 + codex r16)', async () => {
    const tables = healthyTables();
    let visitReads = 0;
    const stable = makeFakeKnex(tables);
    const knex = (table) => {
      if (table === 'scheduled_services') {
        visitReads += 1;
        if (visitReads === 1) return makeFakeKnex({ ...tables, scheduled_services: [{ ...visitRow, status: 'on_site' }] })(table);
      }
      return stable(table);
    };
    const result = await getCloseoutStatus(SVC, { knex, now: NOW });
    expect(result.visitReRead).toEqual({ from: 'on_site', to: 'completed' });
    expect(result.contradictions).toEqual([]);
    expect(result.facts.completion.state).toBe('done');
    // Restarted: the visit row was read again after the flip (initial + re-read + restart initial + restart re-read ≥ 4).
    expect(visitReads).toBeGreaterThanOrEqual(4);
    expect(result.summary.closedOut).toBe(true);
  });

  test('unknown service id → found:false, no facts fabricated', async () => {
    const result = await getCloseoutStatus('nope', { knex: makeFakeKnex(healthyTables()), now: NOW });
    expect(result).toMatchObject({ found: false, lookupFailed: false });
    expect(result.facts).toBeUndefined();
  });

  test('scheduled_services lookup failure → found:false with lookupFailed:true (outage ≠ missing visit)', async () => {
    const tables = healthyTables();
    tables.scheduled_services = new Error('connection refused');
    const result = await getCloseoutStatus(SVC, { knex: makeFakeKnex(tables), now: NOW });
    expect(result).toMatchObject({ found: false, lookupFailed: true });
  });

  test('serviceId is required', async () => {
    await expect(getCloseoutStatus(null)).rejects.toThrow(/serviceId/);
  });

  describe('frozen requirement snapshots', () => {
    // The verdict the completion froze — deliberately mirrors the beforeEach
    // catalog row so the healthy facts stay green, then the tests mutate the
    // live catalog and prove the frozen record does not move.
    const FROZEN_SNAP = {
      v: 1,
      frozenAt: '2026-08-30T18:01:00.000Z',
      serviceId: 'cat-pest',
      serviceName: 'Quarterly Pest Control',
      category: 'pest_control',
      source: 'catalog_v2',
      requiresServiceReport: true,
      requiresApplicationLog: true,
      requiredPhotoCount: 0,
      requiresCustomerSignature: false,
      requiresCustomerNotice: true,
      requiresLicense: false,
      licenseCategory: null,
    };
    const frozenTables = () => {
      const tables = healthyTables();
      tables.service_records = [{
        ...recordRow,
        structured_notes: { completionSmsStatus: 'sent', closeoutRequirements: FROZEN_SNAP },
      }];
      return tables;
    };
    const resolverMock = require('../services/service-closeout-requirements').resolveCloseoutRequirementsForJobs;

    test('catalog edits do NOT flip a frozen record — and the catalog is never read', async () => {
      resolverMock.mockClear();
      // The hazard scenario: requirements tightened AFTER the visit closed.
      catalogRows[0].required_photo_count = 5;
      catalogRows[0].requires_customer_signature = true;
      const result = await getCloseoutStatus(SVC, { knex: makeFakeKnex(frozenTables()), now: NOW });
      expect(result.requirements.asOf).toBe('frozen_at_completion');
      expect(result.requirements.frozenAt).toBe('2026-08-30T18:01:00.000Z');
      expect(result.facts.photos).toMatchObject({
        state: 'not_required',
        reason: 'catalog_zero_required_photos',
        ruleSource: 'frozen_record',
        requirementsSource: 'catalog_v2',
      });
      expect(result.requirements.unevaluated).toEqual([]);
      expect(result.summary.closedOut).toBe(true);
      // Frozen ⇒ zero live-catalog reads: the verdict depends on neither
      // catalog edits nor catalog availability.
      expect(resolverMock).not.toHaveBeenCalled();
    });

    test('a frozen verdict survives a catalog outage', async () => {
      // The resolver is never invoked for a frozen record (asserted below),
      // so an erroring catalog cannot reach the verdict — the same property
      // the "never read" assertion in the previous test pins.
      resolverMock.mockClear();
      const result = await getCloseoutStatus(SVC, { knex: makeFakeKnex(frozenTables()), now: NOW });
      expect(result.unavailable).toEqual([]);
      expect(result.requirements.asOf).toBe('frozen_at_completion');
      expect(result.summary.closedOut).toBe(true);
      expect(resolverMock).not.toHaveBeenCalled();
    });

    test('a BACKFILLED snapshot is frozen but labeled honestly (asOf frozen_by_backfill, GH r1 P2)', async () => {
      resolverMock.mockClear();
      catalogRows[0].required_photo_count = 5; // later catalog edit
      const tables = healthyTables();
      tables.service_records = [{
        ...recordRow,
        structured_notes: {
          completionSmsStatus: 'sent',
          closeoutRequirements: { ...FROZEN_SNAP, source: 'backfilled_from_live_catalog', catalogSource: 'catalog_v2' },
        },
      }];
      const result = await getCloseoutStatus(SVC, { knex: makeFakeKnex(tables), now: NOW });
      expect(result.requirements.asOf).toBe('frozen_by_backfill');
      // Still frozen: the catalog edit does not move the verdict.
      expect(result.facts.photos).toMatchObject({ state: 'not_required', ruleSource: 'frozen_record' });
      expect(resolverMock).not.toHaveBeenCalled();
    });

    test('a malformed snapshot falls back to the live catalog (pre-freeze behavior)', async () => {
      resolverMock.mockClear();
      const tables = healthyTables();
      tables.service_records = [{
        ...recordRow,
        structured_notes: { completionSmsStatus: 'sent', closeoutRequirements: { requiresServiceReport: 'yes' } },
      }];
      const result = await getCloseoutStatus(SVC, { knex: makeFakeKnex(tables), now: NOW });
      expect(result.requirements.asOf).toBe('current_catalog');
      expect(resolverMock).toHaveBeenCalled();
    });
  });
});

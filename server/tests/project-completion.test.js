// The completion billing resolver lazy-requires annual-prepay-renewals for the
// term-link coverage gate; mock it so these tests drive the gate boolean directly
// (annualPrepayCoversVisit's own decision logic is unit-tested separately in
// annual-prepay-coverage-gate.test.js). Default (unset) return is falsy, so every
// other test in this file falls through to the legacy numeric/invoice path.
jest.mock('../services/annual-prepay-renewals', () => ({ annualPrepayCoversVisit: jest.fn() }));
// Payer lookup is mocked so the resolver's third-party Bill-To guard is driven
// directly (default: no payer → self-pay). Keeps these tests off the real DB.
jest.mock('../services/payer', () => ({ resolveForInvoice: jest.fn() }));

const {
  buildProjectCloseoutPreview,
  buildServiceRecordInsert,
  buildServiceRecordProjectCompletionUpdate,
  hasMembership,
  prepaidCoversAmount,
  projectCompletionInvoiceAmount,
  projectFollowupSuggestion,
  projectReviewedForPortalAttachment,
  serviceRecordMatchesScheduledService,
  shouldAttachProjectToPortal,
} = require('../services/project-completion');

// Minimal knex whose invoice lookup finds nothing (so the resolver's terminal
// branch is "invoice_required" unless a coverage gate fires first).
function knexNoExistingInvoice() {
  const chain = {
    whereNot: jest.fn(() => chain),
    where: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    first: jest.fn(async () => null),
  };
  return jest.fn(() => chain);
}

function previewKnexForRoutineLinkedProject() {
  const calls = [];
  const knex = jest.fn((table) => {
    calls.push(table);
    const chain = {
      leftJoin: jest.fn(() => chain),
      where: jest.fn(() => chain),
      whereRaw: jest.fn(() => chain),
      orderBy: jest.fn(() => chain),
      first: jest.fn(async () => {
        if (table === 'projects') {
          return {
            id: 'project-1',
            status: 'draft',
            customer_id: 'cust-1',
            scheduled_service_id: 'svc-1',
          };
        }
        if (table === 'scheduled_services as s') {
          return {
            id: 'svc-1',
            customer_id: 'cust-1',
            service_type: 'Quarterly Pest Control Service',
            service_id: 'catalog-1',
            status: 'pending',
            estimated_price: '350.00',
            create_invoice_on_complete: true,
            waveguard_tier: 'Gold',
            monthly_rate: '99.00',
            customer_active: true,
          };
        }
        if (table === 'services') {
          return {
            service_key: 'pest_general_quarterly',
            name: 'Quarterly Pest Control Service',
            category: 'pest_control',
            billing_type: 'recurring',
          };
        }
        if (table === 'service_records') return null;
        throw new Error(`Unexpected table query: ${table}`);
      }),
    };
    return chain;
  });
  knex.schema = {
    hasTable: jest.fn(async () => false),
  };
  knex._calls = calls;
  return knex;
}

function previewKnexForMissingLinkedScheduledService() {
  const knex = jest.fn((table) => {
    const chain = {
      leftJoin: jest.fn(() => chain),
      where: jest.fn(() => chain),
      first: jest.fn(async () => {
        if (table === 'projects') {
          return {
            id: 'project-1',
            status: 'draft',
            customer_id: 'cust-1',
            scheduled_service_id: 'svc-missing',
          };
        }
        if (table === 'scheduled_services as s') return null;
        throw new Error(`Unexpected table query: ${table}`);
      }),
    };
    return chain;
  });
  return knex;
}

describe('project completion helpers', () => {
  test('recurring_customer policy attaches only for recurring customers', () => {
    const profile = {
      portalVisibility: 'token_only',
      portalAttachPolicy: 'recurring_customer',
    };

    expect(shouldAttachProjectToPortal({
      profile,
      customer: { active: true },
      recurringCustomer: true,
    })).toBe(true);

    expect(shouldAttachProjectToPortal({
      profile,
      customer: { active: true },
      recurringCustomer: false,
    })).toBe(false);
  });

  test('membership detection treats real WaveGuard tier or monthly rate as recurring', () => {
    expect(hasMembership({ waveguard_tier: 'Gold', monthly_rate: 0 })).toBe(true);
    expect(hasMembership({ waveguard_tier: null, monthly_rate: 99 })).toBe(true);
    expect(hasMembership({ waveguard_tier: 'none', monthly_rate: 99 })).toBe(false);
    expect(hasMembership({ waveguard_tier: null, monthly_rate: 0 })).toBe(false);
  });

  test('project portal attachment requires the project to have passed send review', () => {
    expect(projectReviewedForPortalAttachment({ status: 'draft' })).toBe(false);
    expect(projectReviewedForPortalAttachment({ status: 'closed' })).toBe(false);
    expect(projectReviewedForPortalAttachment({ status: 'sent' })).toBe(true);
    expect(projectReviewedForPortalAttachment({ status: 'draft', sent_at: '2026-05-21T12:00:00Z' })).toBe(true);
  });

  test('billable project completions require invoice or prepaid coverage', () => {
    expect(projectCompletionInvoiceAmount({
      scheduledService: { estimated_price: '350.00' },
      customer: {},
    })).toBe(350);
    expect(projectCompletionInvoiceAmount({
      scheduledService: { create_invoice_on_complete: true },
      customer: { monthly_rate: '99.00' },
    })).toBe(99);
    // Callbacks (re-services) are free — never fall back to monthly dues...
    expect(projectCompletionInvoiceAmount({
      scheduledService: { is_callback: true, create_invoice_on_complete: true },
      customer: { monthly_rate: '99.00' },
    })).toBe(0);
    // ...but still bill an explicit positive price if the operator set one.
    expect(projectCompletionInvoiceAmount({
      scheduledService: { is_callback: true, estimated_price: '75.00' },
      customer: { monthly_rate: '99.00' },
    })).toBe(75);
    expect(prepaidCoversAmount({ prepaid_amount: '350.00' }, 350)).toBe(true);
    expect(prepaidCoversAmount({ prepaid_amount: '100.00' }, 350)).toBe(false);
    // annual-prepay stamps are governed by annualPrepayCoversVisit, NOT the amount:
    // a stale annual_prepay_invoice stamp must not suppress here even if it covers.
    expect(prepaidCoversAmount({ prepaid_amount: '350.00', prepaid_method: 'annual_prepay_invoice' }, 350)).toBe(false);
    // other out-of-band methods still covered numerically.
    expect(prepaidCoversAmount({ prepaid_amount: '350.00', prepaid_method: 'cash' }, 350)).toBe(true);
  });

  test('project follow-up suggestion uses profile policy and default interval', () => {
    expect(projectFollowupSuggestion({
      scheduledService: { scheduled_date: '2026-05-21' },
      project: { project_date: '2026-05-21' },
      profile: { followupPolicy: 'none' },
    })).toMatchObject({
      required: false,
      policy: 'none',
      suggestedDate: null,
    });

    expect(projectFollowupSuggestion({
      scheduledService: { scheduled_date: '2026-05-21' },
      project: { project_date: '2026-05-21' },
      profile: { followupPolicy: 'alert', defaultFollowupDays: 3 },
    })).toMatchObject({
      required: true,
      policy: 'alert',
      days: 3,
      suggestedDate: '2026-05-24',
      alertType: 'follow_up_needed',
    });

    expect(projectFollowupSuggestion({
      scheduledService: { scheduled_date: '2026-05-21' },
      project: { project_date: '2026-05-21' },
      profile: { followupPolicy: 'auto_schedule', defaultFollowupDays: 3 },
    })).toMatchObject({
      required: true,
      policy: 'auto_schedule',
      days: 3,
      suggestedDate: '2026-05-24',
      alertType: null,
      unsupported: true,
      reason: 'auto_schedule_not_implemented',
    });
  });

  test('required follow-up alert write failures are surfaced', async () => {
    jest.resetModules();
    jest.doMock('../services/dispatch-alerts', () => ({
      createAlertOnce: jest.fn(async () => {
        throw new Error('alert insert failed');
      }),
    }));

    const {
      createProjectFollowupAlert,
    } = require('../services/project-completion');

    const alertRead = {
      where: jest.fn(() => alertRead),
      whereNull: jest.fn(() => alertRead),
      first: jest.fn(async () => null),
    };
    const trx = jest.fn(() => alertRead);

    await expect(createProjectFollowupAlert({
      scheduledService: {
        id: 'svc-1',
        technician_id: 'tech-1',
        customer_id: 'cust-1',
        service_type: 'Rodent Trapping Service',
      },
      project: {
        id: 'project-1',
        project_type: 'rodent_trapping',
      },
      serviceRecord: { id: 'record-1' },
      profile: { serviceName: 'Rodent Trapping Service' },
      customer: { first_name: 'Adam', last_name: 'Martinez' },
      followup: {
        required: true,
        policy: 'alert',
        alertType: 'follow_up_needed',
        days: 3,
        suggestedDate: '2026-05-22',
      },
      trx,
    })).rejects.toThrow('alert insert failed');

    jest.dontMock('../services/dispatch-alerts');
  });

  test('project follow-up alert reports existing id when atomic insert is deduped', async () => {
    jest.resetModules();
    jest.doMock('../services/dispatch-alerts', () => ({
      createAlertOnce: jest.fn(async () => ({
        created: false,
        row: { id: 'alert-existing' },
      })),
    }));

    const {
      createProjectFollowupAlert,
    } = require('../services/project-completion');

    const alertRead = {
      where: jest.fn(() => alertRead),
      whereNull: jest.fn(() => alertRead),
      first: jest.fn(async () => null),
    };
    const trx = jest.fn(() => alertRead);

    await expect(createProjectFollowupAlert({
      scheduledService: {
        id: 'svc-1',
        technician_id: 'tech-1',
        customer_id: 'cust-1',
        service_type: 'Rodent Trapping Service',
      },
      project: {
        id: 'project-1',
        project_type: 'rodent_trapping',
      },
      serviceRecord: { id: 'record-1' },
      profile: { serviceName: 'Rodent Trapping Service' },
      customer: { first_name: 'Adam', last_name: 'Martinez' },
      followup: {
        required: true,
        policy: 'alert',
        alertType: 'follow_up_needed',
        days: 3,
        suggestedDate: '2026-05-22',
      },
      trx,
    })).resolves.toMatchObject({
      required: true,
      created: false,
      existingAlertId: 'alert-existing',
    });

    jest.dontMock('../services/dispatch-alerts');
  });

  test('project follow-up alert keeps existing open follow-up card regardless of source', async () => {
    jest.resetModules();
    const createAlertOnce = jest.fn();
    jest.doMock('../services/dispatch-alerts', () => ({
      createAlertOnce,
    }));

    const {
      createProjectFollowupAlert,
    } = require('../services/project-completion');

    const alertRead = {
      where: jest.fn(() => alertRead),
      whereNull: jest.fn(() => alertRead),
      first: jest.fn(async () => ({ id: 'alert-normal-completion' })),
    };
    const trx = jest.fn(() => alertRead);

    await expect(createProjectFollowupAlert({
      scheduledService: {
        id: 'svc-1',
        technician_id: 'tech-1',
        customer_id: 'cust-1',
        service_type: 'Rodent Trapping Service',
      },
      project: {
        id: 'project-1',
        project_type: 'rodent_trapping',
      },
      serviceRecord: { id: 'record-1' },
      profile: { serviceName: 'Rodent Trapping Service' },
      customer: { first_name: 'Adam', last_name: 'Martinez' },
      followup: {
        required: true,
        policy: 'alert',
        alertType: 'follow_up_needed',
        days: 3,
        suggestedDate: '2026-05-22',
      },
      trx,
    })).resolves.toMatchObject({
      required: true,
      created: false,
      existingAlertId: 'alert-normal-completion',
    });
    expect(createAlertOnce).not.toHaveBeenCalled();

    jest.dontMock('../services/dispatch-alerts');
  });

  test('closeout preview does not put billing holds on routine linked projects', async () => {
    const knex = previewKnexForRoutineLinkedProject();

    const preview = await buildProjectCloseoutPreview('project-1', knex);

    expect(preview.serviceCompletion).toMatchObject({
      linked: true,
      willCompleteService: false,
      projectBacked: false,
    });
    expect(preview.billing).toMatchObject({
      required: false,
      resolved: true,
      reason: 'project_not_completing_service',
    });
    expect(preview.portal).toMatchObject({
      attached: false,
      reason: 'not_project_backed_service',
      recurringCustomer: null,
    });
    expect(preview.canClose).toBe(true);
    expect(knex._calls).not.toContain('invoices');
    expect(knex._calls).not.toContain('service_records');
  });

  test('closeout preview blocks close when linked scheduled service is missing', async () => {
    const knex = previewKnexForMissingLinkedScheduledService();

    const preview = await buildProjectCloseoutPreview('project-1', knex);

    expect(preview.serviceCompletion).toMatchObject({
      linked: true,
      willCompleteService: false,
      reason: 'linked_scheduled_service_missing',
    });
    expect(preview.portal).toMatchObject({
      attached: false,
      reason: 'linked_scheduled_service_missing',
    });
    expect(preview.canClose).toBe(false);
  });

  test('existing service record reuse requires the same scheduled service link', () => {
    expect(serviceRecordMatchesScheduledService(
      { id: 'record-1', scheduled_service_id: 'svc-1' },
      { id: 'svc-1' },
    )).toBe(true);
    expect(serviceRecordMatchesScheduledService(
      { id: 'record-1', scheduled_service_id: 'svc-other' },
      { id: 'svc-1' },
    )).toBe(false);
    expect(serviceRecordMatchesScheduledService(
      { id: 'record-1' },
      { id: 'svc-1' },
    )).toBe(false);
  });

  test('service record insert marks project completion without creating a routine report token', () => {
    const insert = buildServiceRecordInsert({
      scheduledService: {
        id: 'svc-1',
        customer_id: 'cust-1',
        technician_id: 'tech-1',
        scheduled_date: '2026-05-21',
        service_type: 'Rodent Trapping Service',
      },
      project: {
        id: 'project-1',
        project_type: 'rodent_trapping',
        title: 'Rodent trapping',
        project_date: '2026-05-21',
        report_token: '0123456789abcdef0123456789abcdef',
        recommendations: 'Trap check recommended.',
      },
      profile: {
        completionMode: 'project_required',
        portalVisibility: 'token_only',
        portalAttachPolicy: 'recurring_customer',
      },
      serviceRecordCols: {
        scheduled_service_id: true,
        structured_notes: true,
        completion_source: true,
        protocol_defaults_used: true,
      },
      lifecycleUpdates: {
        actual_end_time: new Date('2026-05-21T16:00:00Z'),
      },
      portalAttached: true,
      reportPath: '/report/project/customer-0123456789ab',
    });

    expect(insert).toMatchObject({
      scheduled_service_id: 'svc-1',
      customer_id: 'cust-1',
      technician_id: 'tech-1',
      service_date: '2026-05-21',
      service_type: 'Rodent Trapping Service',
      status: 'completed',
      completion_source: 'project_completion',
      protocol_defaults_used: false,
    });
    expect(insert.report_view_token).toBeUndefined();
    expect(insert.actual_end_time).toBeUndefined();
    const notes = JSON.parse(insert.structured_notes);
    expect(notes).toMatchObject({
      projectCompletion: true,
      projectId: 'project-1',
      projectType: 'rodent_trapping',
      portalAttached: true,
      projectReport: {
        url: '/report/project/customer-0123456789ab',
      },
    });
  });

  test('existing service record update converts routine report fields to project completion', () => {
    const update = buildServiceRecordProjectCompletionUpdate({
      serviceRecord: {
        id: 'record-1',
        structured_notes: JSON.stringify({ existingNote: true }),
        service_data: JSON.stringify({ existingData: true }),
        report_view_token: 'legacy-report-token',
        report_template_version: 'service_report_v1',
      },
      project: {
        id: 'project-1',
        project_type: 'rodent_trapping',
        title: 'Rodent trapping',
        report_token: '0123456789abcdef0123456789abcdef',
        findings: { traps_set: 'Attic' },
      },
      profile: {
        completionMode: 'project_required',
        portalVisibility: 'token_only',
        portalAttachPolicy: 'recurring_customer',
      },
      serviceRecordCols: {
        status: true,
        structured_notes: true,
        completion_source: true,
        protocol_defaults_used: true,
        service_data: true,
        report_view_token: true,
        report_template_version: true,
        pdf_storage_key: true,
        updated_at: true,
      },
      lifecycleUpdates: {
        actual_end_time: new Date('2026-05-21T16:00:00Z'),
      },
      portalAttached: false,
      reportPath: '/report/project/customer-0123456789ab',
      nowValue: 'NOW',
    });

    expect(update).toMatchObject({
      status: 'completed',
      completion_source: 'project_completion',
      protocol_defaults_used: false,
      report_view_token: null,
      report_template_version: null,
      pdf_storage_key: null,
      updated_at: 'NOW',
    });
    expect(update.actual_end_time).toBeUndefined();
    const notes = JSON.parse(update.structured_notes);
    expect(notes).toMatchObject({
      existingNote: true,
      projectCompletion: true,
      projectId: 'project-1',
      projectType: 'rodent_trapping',
      portalAttached: false,
      projectReport: {
        tokenOnly: true,
      },
    });
    const serviceData = JSON.parse(update.service_data);
    expect(serviceData).toMatchObject({
      existingData: true,
      project: {
        id: 'project-1',
        type: 'rodent_trapping',
        findings: { traps_set: 'Attic' },
      },
    });
  });
});

describe('resolveProjectCompletionBilling — annual-prepay term-link coverage', () => {
  // Earlier tests in this file call jest.resetModules(), which orphans the
  // top-level mock/resolve captures from the module instance resolve lazy-requires.
  // Re-require BOTH from one fresh registry per test so resolve's lazy
  // require('./annual-prepay-renewals') is the same mocked fn we drive here.
  let resolveBilling;
  let coversVisit;
  let payerResolve;
  beforeEach(() => {
    jest.resetModules();
    coversVisit = require('../services/annual-prepay-renewals').annualPrepayCoversVisit;
    payerResolve = require('../services/payer').resolveForInvoice;
    resolveBilling = require('../services/project-completion').resolveProjectCompletionBilling;
  });

  test('discounted annual-prepay visit: term-link coverage suppresses billing even though the slice < undiscounted price', async () => {
    // The numeric gate (prepaid 52.25 < price 55) would FAIL and re-bill — the
    // term-link gate must win and mark it covered.
    expect(jest.isMockFunction(coversVisit)).toBe(true);
    coversVisit.mockResolvedValue(true);
    const scheduledService = {
      id: 'ss-1',
      estimated_price: '55.00',
      prepaid_method: 'annual_prepay_invoice',
      prepaid_amount: '52.25',
      annual_prepay_term_id: 'term-1',
    };
    const result = await resolveBilling({
      scheduledService,
      customer: {},
      knex: knexNoExistingInvoice(),
    });
    expect(result).toMatchObject({ required: true, resolved: true, reason: 'prepaid_covered', amount: 55 });
  });

  test('non-prepay recurring visit: bills normally (gate false, no existing invoice)', async () => {
    coversVisit.mockResolvedValue(false);
    const scheduledService = { id: 'ss-2', estimated_price: '55.00' };
    const result = await resolveBilling({
      scheduledService,
      customer: {},
      knex: knexNoExistingInvoice(),
    });
    expect(result).toMatchObject({ required: true, resolved: false, reason: 'invoice_required', amount: 55 });
  });

  test('other-method prepayment (cash) still covered via the numeric gate', async () => {
    coversVisit.mockResolvedValue(false); // not an annual-prepay stamp
    const scheduledService = {
      id: 'ss-3',
      estimated_price: '55.00',
      prepaid_method: 'cash',
      prepaid_amount: '55.00',
    };
    const result = await resolveBilling({
      scheduledService,
      customer: {},
      knex: knexNoExistingInvoice(),
    });
    expect(result).toMatchObject({ required: true, resolved: true, reason: 'prepaid_covered', amount: 55 });
  });

  test('payer-billed (third-party Bill-To) visit: annual-prepay coverage must NOT suppress the payer invoice', async () => {
    // Even with a LIVE annual-prepay stamp, a payer-billed visit is owed by the
    // payer — the homeowner's prepay can't cover it, so it must still require the invoice.
    coversVisit.mockResolvedValue(true);
    payerResolve.mockResolvedValue({ payerId: 'payer-1' });
    const scheduledService = {
      id: 'ss-5',
      estimated_price: '55.00',
      prepaid_method: 'annual_prepay_invoice',
      prepaid_amount: '55.00',
      annual_prepay_term_id: 'term-1',
    };
    const result = await resolveBilling({
      scheduledService,
      customer: {},
      knex: knexNoExistingInvoice(),
    });
    expect(result).toMatchObject({ required: true, resolved: false, reason: 'invoice_required', amount: 55 });
  });

  test('stale annual-prepay stamp on a dead (refunded/voided) term: bills — the numeric fallback must NOT suppress it', async () => {
    // The term-link gate says NOT covered (term refunded/voided), but the visit
    // still carries a stale annual_prepay_invoice stamp whose amount WOULD cover.
    // It must bill anyway — annual-prepay stamps never fall through to the amount gate.
    coversVisit.mockResolvedValue(false);
    const scheduledService = {
      id: 'ss-4',
      estimated_price: '55.00',
      prepaid_method: 'annual_prepay_invoice',
      prepaid_amount: '55.00',
      annual_prepay_term_id: 'term-1',
    };
    const result = await resolveBilling({
      scheduledService,
      customer: {},
      knex: knexNoExistingInvoice(),
    });
    expect(result).toMatchObject({ required: true, resolved: false, reason: 'invoice_required', amount: 55 });
  });
});

const {
  buildServiceRecordInsert,
  hasMembership,
  prepaidCoversAmount,
  projectCompletionInvoiceAmount,
  projectReviewedForPortalAttachment,
  shouldAttachProjectToPortal,
} = require('../services/project-completion');

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
    expect(prepaidCoversAmount({ prepaid_amount: '350.00' }, 350)).toBe(true);
    expect(prepaidCoversAmount({ prepaid_amount: '100.00' }, 350)).toBe(false);
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
});

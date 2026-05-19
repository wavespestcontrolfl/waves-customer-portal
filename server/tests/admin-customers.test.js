const adminCustomersRoute = require('../routes/admin-customers');

const {
  adminNotificationPrefsDbUpdates,
  cadenceFromEstimateLine,
  customerSearchTerms,
  isSchedulableOneTimeEstimateLine,
  isValidStage,
  mapPipelineCustomer,
  scheduleLinesFromEstimate,
} = adminCustomersRoute._private;

describe('admin customers route helpers', () => {
  test('validates known customer pipeline stages', () => {
    expect(isValidStage('new_lead')).toBe(true);
    expect(isValidStage('active_customer')).toBe(true);
    expect(isValidStage('not_a_stage')).toBe(false);
  });

  test('tokenizes visible customer-row search phrases', () => {
    expect(customerSearchTerms('14208 Sundial Pl, Lakewood Ranch FL')).toEqual([
      '14208',
      'Sundial',
      'Pl',
      'Lakewood',
      'Ranch',
      'FL',
    ]);
  });

  test('maps pipeline rows to the V2 customer-card contract', () => {
    const changedAt = new Date('2026-05-10T12:00:00Z');
    const mapped = mapPipelineCustomer({
      id: 'customer-1',
      first_name: 'Ada',
      last_name: 'Lovelace',
      account_id: 'account-1',
      profile_label: 'Primary',
      address_line1: '1 Algorithm Way',
      city: 'Sarasota',
      phone: '+19415550100',
      waveguard_tier: 'Gold',
      monthly_rate: '129.50',
      lead_score: 82,
      lead_source: 'referral',
      pipeline_stage_changed_at: changedAt,
      next_follow_up_date: '2026-05-12',
    }, 'estimate_sent');

    expect(mapped).toMatchObject({
      id: 'customer-1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      name: 'Ada Lovelace',
      accountId: 'account-1',
      profileLabel: 'Primary',
      address: '1 Algorithm Way, Sarasota',
      monthlyRate: 129.5,
      pipelineStage: 'estimate_sent',
      stageEnteredAt: changedAt,
    });
  });

  test('parses explicit recurring cadence before generic month and annual tokens', () => {
    expect(cadenceFromEstimateLine({ frequency: 'Bi-Monthly' }, 'quarterly')).toBe('bimonthly');
    expect(cadenceFromEstimateLine({ frequency: 'Triannual (every 4 months)' }, 'quarterly')).toBe('triannual');
    expect(cadenceFromEstimateLine({ frequency: 'Semi-Annual' }, 'quarterly')).toBe('semiannual');
    expect(cadenceFromEstimateLine({ frequency: 'Monthly' }, 'quarterly')).toBe('monthly');
  });

  test('excludes billing-only one-time estimate rows from scheduling', () => {
    expect(isSchedulableOneTimeEstimateLine({ service: 'waveguard_setup', price: 199 })).toBe(false);
    expect(isSchedulableOneTimeEstimateLine({ kind: 'discount', price: -50 })).toBe(false);
    expect(isSchedulableOneTimeEstimateLine({ service: 'bed_bug', quoteRequired: true })).toBe(false);
    expect(isSchedulableOneTimeEstimateLine({ label: 'Membership setup fee', amount: 99 })).toBe(false);
    expect(isSchedulableOneTimeEstimateLine({ service: 'termite_bait', label: 'Termite bait installation', amount: 499 })).toBe(true);
  });

  test('does not create fallback schedule lines from billing-only estimate rows', () => {
    const lines = scheduleLinesFromEstimate({
      id: 'estimate-1',
      service_interest: 'WaveGuard setup',
      onetime_total: 99,
      monthly_total: 0,
      estimate_data: {
        result: {
          oneTime: {
            total: 99,
            items: [{ service: 'waveguard_setup', name: 'WaveGuard setup', price: 99 }],
          },
        },
      },
    }, { byKey: new Map(), byName: new Map(), rows: [] });

    expect(lines).toEqual([]);
  });

  test('does not create fallback schedule lines from quote-required estimate rows', () => {
    const lines = scheduleLinesFromEstimate({
      id: 'estimate-quote-required',
      service_interest: 'Bed Bug',
      onetime_total: 0,
      monthly_total: 0,
      estimate_data: {
        result: {
          oneTime: {
            specItems: [{ service: 'bed_bug', name: 'Bed Bug - Quote Required', price: null, quoteRequired: true }],
          },
        },
      },
    }, { byKey: new Map(), byName: new Map(), rows: [] });

    expect(lines).toEqual([]);
  });

  test('preserves fallback schedule line for recurring estimate totals with filtered billing rows', () => {
    const lines = scheduleLinesFromEstimate({
      id: 'estimate-recurring',
      service_interest: 'Pest Control',
      onetime_total: 99,
      monthly_total: 50,
      annual_total: 600,
      estimate_data: {
        result: {
          oneTime: {
            total: 99,
            items: [{ service: 'waveguard_setup', name: 'WaveGuard setup', price: 99 }],
          },
        },
      },
    }, { byKey: new Map(), byName: new Map(), rows: [] });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      name: 'Pest Control',
      price: 50,
      cadence: 'quarterly',
      source: 'recurring',
      estimateId: 'estimate-recurring',
    });
  });

  test('uses annual recurring totals for fallback schedule metadata when monthly total is absent', () => {
    const lines = scheduleLinesFromEstimate({
      id: 'estimate-annual-recurring',
      service_interest: 'Pest Control',
      onetime_total: 99,
      monthly_total: 0,
      annual_total: 600,
      estimate_data: {
        result: {
          oneTime: {
            total: 99,
            items: [{ service: 'waveguard_setup', name: 'WaveGuard setup', price: 99 }],
          },
        },
      },
    }, { byKey: new Map(), byName: new Map(), rows: [] });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      billingType: 'recurring',
      price: 50,
      cadence: 'quarterly',
      source: 'recurring',
      estimateId: 'estimate-annual-recurring',
    });
  });

  test('ignores billing contact name when no billing email exists', () => {
    const { dbUpdates } = adminNotificationPrefsDbUpdates(
      { billingContactName: 'Accounts Payable' },
      {},
    );

    expect(dbUpdates).toEqual({});
  });

  test('updates billing contact name when an existing billing email is present', () => {
    const { dbUpdates } = adminNotificationPrefsDbUpdates(
      { billingContactName: 'Accounts Payable' },
      { billing_email: 'ap@example.com' },
    );

    expect(dbUpdates).toEqual({
      billing_contact_name: 'Accounts Payable',
    });
  });

  test('clears stale billing contact name when billing email changes without a replacement name', () => {
    const { dbUpdates } = adminNotificationPrefsDbUpdates(
      { billingEmail: 'new-ap@example.com' },
      {
        billing_email: 'old-ap@example.com',
        billing_contact_name: 'Old Accounts Payable',
      },
    );

    expect(dbUpdates).toEqual({
      billing_email: 'new-ap@example.com',
      billing_contact_name: null,
    });
  });

  test('rejects billing emails that exceed the database column length', () => {
    const localPart = 'a'.repeat(190);
    const { error } = adminNotificationPrefsDbUpdates({
      billingEmail: `${localPart}@example.com`,
    });

    expect(error).toBe('Billing recipient email must be 200 characters or fewer.');
  });
});

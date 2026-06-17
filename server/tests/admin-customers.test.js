const adminCustomersRoute = require('../routes/admin-customers');

const {
  adminMembershipDailyIdempotencyKey,
  adminMembershipStartIdempotencyKey,
  adminNotificationPrefsDbUpdates,
  cadenceFromEstimateLine,
  compactServiceContactSlots,
  customerSearchTerms,
  defaultAnnualPrepayTermStart,
  hasMembership,
  indexServicesForSchedule,
  isSchedulableOneTimeEstimateLine,
  isValidStage,
  mapCustomerListRow,
  mapPipelineCustomer,
  membershipDetailsChanged,
  scheduleLinesFromEstimate,
  serviceCatalogMatch,
} = adminCustomersRoute._private;

describe('admin customers route helpers', () => {
  test('validates known customer pipeline stages', () => {
    expect(isValidStage('new_lead')).toBe(true);
    expect(isValidStage('active_customer')).toBe(true);
    expect(isValidStage('not_a_stage')).toBe(false);
  });

  test('anchors a new prepay term after a paid active term but inside an unpaid pending window', () => {
    const today = '2026-06-16';
    // No active term → starts today.
    expect(defaultAnnualPrepayTermStart(null, today)).toBe(today);
    // Paid/active term still covering → start the day after its term_end.
    expect(
      defaultAnnualPrepayTermStart({ status: 'active', term_end: '2026-12-31' }, today),
    ).toBe('2027-01-01');
    // payment_pending (sent-but-unpaid) → cover the same window (term_start), NOT
    // term_end + 1, so the overlap guard rejects a stacked duplicate.
    expect(
      defaultAnnualPrepayTermStart(
        { status: 'payment_pending', term_start: '2026-07-01', term_end: '2027-06-30' },
        today,
      ),
    ).toBe('2026-07-01');
    // A paid term whose window already lapsed → starts today (fresh prepay).
    expect(
      defaultAnnualPrepayTermStart({ status: 'active', term_end: '2026-01-01' }, today),
    ).toBe(today);
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

  test('maps customer list rows with editable service-contact fields', () => {
    const mapped = mapCustomerListRow({
      id: 'customer-1',
      first_name: 'Ada',
      last_name: 'Lovelace',
      account_id: 'account-1',
      profile_label: 'Primary',
      is_primary_profile: true,
      email: 'ada@example.com',
      phone: '+19415550100',
      city: 'Sarasota',
      address_line1: '1 Algorithm Way',
      state: 'FL',
      zip: '34236',
      waveguard_tier: 'Gold',
      monthly_rate: '129.50',
      service_contact_name: 'Grace Hopper',
      service_contact_phone: '+19415550199',
      service_contact_email: 'grace@example.com',
      services_count: '4',
      service_type_count: '2',
      cards_on_file: '1',
      tags_str: 'gate,pets',
    });

    expect(mapped).toMatchObject({
      id: 'customer-1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      serviceContactName: 'Grace Hopper',
      serviceContactPhone: '+19415550199',
      serviceContactEmail: 'grace@example.com',
      totalServices: 4,
      serviceCount: 2,
      cardsOnFile: 1,
      tags: ['gate', 'pets'],
    });
  });

  test('maps slot 2/3 service contacts on customer list rows', () => {
    const mapped = mapCustomerListRow({
      id: 'customer-1',
      first_name: 'Ada',
      service_contact2_name: 'Sam Spouse',
      service_contact2_phone: '+19415550112',
      service_contact2_email: 'sam@example.com',
      service_contact3_name: 'Pat Manager',
      service_contact3_phone: '+19415550113',
      service_contact3_email: 'pat@example.com',
      tags_str: '',
    });

    expect(mapped).toMatchObject({
      serviceContact2Name: 'Sam Spouse',
      serviceContact2Phone: '+19415550112',
      serviceContact2Email: 'sam@example.com',
      serviceContact3Name: 'Pat Manager',
      serviceContact3Phone: '+19415550113',
      serviceContact3Email: 'pat@example.com',
    });
  });

  test('clearing slot 1 promotes slot 2 so no hidden contact keeps notifications', () => {
    const before = {
      service_contact_name: 'Grace Hopper',
      service_contact_phone: '+19415550199',
      service_contact_email: 'grace@example.com',
      service_contact2_name: 'Sam Spouse',
      service_contact2_phone: '+19415550112',
      service_contact2_email: 'sam@example.com',
      service_contact3_name: null,
      service_contact3_phone: null,
      service_contact3_email: null,
    };
    const updates = {
      service_contact_name: '',
      service_contact_phone: '',
      service_contact_email: '',
    };

    compactServiceContactSlots(updates, before);

    expect(updates).toEqual({
      service_contact_name: 'Sam Spouse',
      service_contact_phone: '+19415550112',
      service_contact_email: 'sam@example.com',
      service_contact2_name: null,
      service_contact2_phone: null,
      service_contact2_email: null,
      service_contact3_name: null,
      service_contact3_phone: null,
      service_contact3_email: null,
    });
  });

  test('slot compaction is a no-op when no service-contact column is updated', () => {
    const updates = { city: 'Sarasota' };
    compactServiceContactSlots(updates, {
      service_contact2_name: 'Sam Spouse',
    });
    expect(updates).toEqual({ city: 'Sarasota' });
  });

  test('clearing every slot nulls all service-contact columns', () => {
    const before = {
      service_contact_name: 'Grace Hopper',
      service_contact_phone: '+19415550199',
      service_contact_email: 'grace@example.com',
      service_contact2_name: 'Sam Spouse',
      service_contact2_phone: '+19415550112',
      service_contact2_email: 'sam@example.com',
    };
    const updates = {
      service_contact_name: '',
      service_contact_phone: '',
      service_contact_email: '',
      service_contact2_name: '',
      service_contact2_phone: '',
      service_contact2_email: '',
      service_contact3_name: '',
      service_contact3_phone: '',
      service_contact3_email: '',
    };

    compactServiceContactSlots(updates, before);

    expect(Object.values(updates).every((v) => v === null)).toBe(true);
  });

  test('parses explicit recurring cadence before generic month and annual tokens', () => {
    expect(cadenceFromEstimateLine({ frequency: 'Bi-Monthly' }, 'quarterly')).toBe('bimonthly');
    expect(cadenceFromEstimateLine({ frequency: 'Triannual (every 4 months)' }, 'quarterly')).toBe('triannual');
    expect(cadenceFromEstimateLine({ frequency: 'Semi-Annual' }, 'quarterly')).toBe('semiannual');
    expect(cadenceFromEstimateLine({ frequency: 'Monthly' }, 'quarterly')).toBe('monthly');
  });

  test('does not treat one-time or none tiers as memberships', () => {
    expect(hasMembership({ tier: 'One-Time', monthlyRate: 0 })).toBe(false);
    expect(hasMembership({ waveguard_tier: 'one_time', monthly_rate: 0 })).toBe(false);
    expect(hasMembership({ waveguard_tier: 'none', monthly_rate: 129 })).toBe(false);
    expect(hasMembership({ tier: 'Gold', monthlyRate: 0 })).toBe(true);
    expect(hasMembership({ monthlyRate: 129 })).toBe(true);
  });

  test('normalizes membership details before deciding lifecycle sends', () => {
    expect(membershipDetailsChanged(
      { waveguard_tier: 'Gold', monthly_rate: '129.50' },
      { waveguard_tier: 'Gold', monthly_rate: 129.5 },
    )).toBe(false);
    expect(membershipDetailsChanged(
      { waveguard_tier: 'Gold', monthly_rate: '129.50' },
      { waveguard_tier: 'none', monthly_rate: 0 },
    )).toBe(true);
    expect(membershipDetailsChanged(
      { waveguard_tier: 'One-Time', monthly_rate: 0 },
      { waveguard_tier: null, monthly_rate: 0 },
    )).toBe(false);
  });

  test('builds admin membership idempotency keys on the ET business date', () => {
    const eventAt = new Date('2026-05-21T01:30:00.000Z');
    expect(adminMembershipDailyIdempotencyKey(
      'membership.canceled',
      'customer-1',
      'admin',
      eventAt,
    )).toBe('membership.canceled:customer-1:admin:2026-05-20');

    expect(adminMembershipStartIdempotencyKey(
      'customer-1',
      { waveguard_tier: 'none', monthly_rate: 0 },
      { waveguard_tier: 'Gold', monthly_rate: 129 },
      eventAt,
    )).toBe('membership.started:customer-1:admin:2026-05-20:2026-05-21T01:30:00.000Z:none:0:gold:12900');
  });

  test('scopes admin membership-start keys to each admin event', () => {
    const before = { waveguard_tier: 'none', monthly_rate: 0 };
    const after = { waveguard_tier: 'Gold', monthly_rate: 129 };

    expect(adminMembershipStartIdempotencyKey(
      'customer-1',
      before,
      after,
      new Date('2026-05-20T14:00:00.000Z'),
    )).not.toBe(adminMembershipStartIdempotencyKey(
      'customer-1',
      before,
      after,
      new Date('2026-05-20T14:05:00.000Z'),
    ));
  });

  test('excludes billing-only one-time estimate rows from scheduling', () => {
    expect(isSchedulableOneTimeEstimateLine({ service: 'waveguard_setup', price: 199 })).toBe(false);
    expect(isSchedulableOneTimeEstimateLine({ kind: 'discount', price: -50 })).toBe(false);
    expect(isSchedulableOneTimeEstimateLine({ service: 'bed_bug', quoteRequired: true })).toBe(false);
    expect(isSchedulableOneTimeEstimateLine({ label: 'Membership setup fee', amount: 99 })).toBe(false);
    expect(isSchedulableOneTimeEstimateLine({ service: 'termite_bait', label: 'Termite bait installation', amount: 499 })).toBe(true);
  });

  test('rodent bait estimate lines route to the quarterly profile-backed service (Codex P2)', () => {
    const serviceIndex = indexServicesForSchedule([
      { id: 1, service_key: 'rodent_bait_quarterly', name: 'Quarterly Rodent Bait Station Service', short_name: 'Rodent Bait', billing_type: 'recurring', frequency: 'quarterly', visits_per_year: 4 },
      { id: 2, service_key: 'rodent_monitoring', name: 'Rodent Monitoring (Monthly)', short_name: 'Rodent Monitor', billing_type: 'recurring', frequency: 'monthly', visits_per_year: 12 },
      { id: 3, service_key: 'termite_bait', name: 'Termite Bait System', short_name: 'Termite Bait' },
    ]);

    // Keyed lines and label-only lines both land on the quarterly service so
    // completion resolves the typed rodent_bait_station profile.
    expect(serviceCatalogMatch({ service: 'rodent_bait' }, serviceIndex)?.service_key).toBe('rodent_bait_quarterly');
    expect(serviceCatalogMatch({ name: 'Rodent Bait Stations' }, serviceIndex)?.service_key).toBe('rodent_bait_quarterly');
    // Explicit monthly monitoring text keeps the monthly service.
    expect(serviceCatalogMatch({ name: 'Monthly rodent monitoring' }, serviceIndex)?.service_key).toBe('rodent_monitoring');
    // Bare "bait station" text no longer satisfies the termite pick — only
    // genuinely termite-worded lines do.
    expect(serviceCatalogMatch({ name: 'Termite bait stations' }, serviceIndex)?.service_key).toBe('termite_bait');
  });

  test('rodent bait falls back to monthly monitoring when the catalog lacks the quarterly row', () => {
    const legacyIndex = indexServicesForSchedule([
      { id: 2, service_key: 'rodent_monitoring', name: 'Rodent Monitoring (Monthly)', short_name: 'Rodent Monitor' },
    ]);
    expect(serviceCatalogMatch({ service: 'rodent_bait' }, legacyIndex)?.service_key).toBe('rodent_monitoring');
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

  test('rejects string values for admin notification preference booleans', () => {
    const { error } = adminNotificationPrefsDbUpdates({
      serviceReportNotifyPrimary: 'false',
    });

    expect(error).toBe('serviceReportNotifyPrimary must be true or false.');
  });

  test('preserves explicit false admin notification preference booleans', () => {
    const { dbUpdates } = adminNotificationPrefsDbUpdates({
      autoFlipEnRoute: false,
      paymentConfirmationSms: false,
      appointmentNotifyPrimary: false,
      serviceReportNotifyPrimary: false,
    });

    expect(dbUpdates).toEqual({
      appointment_notify_primary: false,
      auto_flip_en_route: false,
      payment_confirmation_sms: false,
      service_report_notify_primary: false,
    });
  });
});

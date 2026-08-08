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
  stageLifecycleStamps,
  mapCustomerListRow,
  mapPipelineCustomer,
  membershipDetailsChanged,
  normalizeAdminAddressInput,
  scheduleLinesFromEstimate,
  serviceCatalogMatch,
} = adminCustomersRoute._private;

describe('stageLifecycleStamps', () => {
  const TODAY = '2026-06-19';

  test('stamps member_since when first entering a customer stage', () => {
    const s = stageLifecycleStamps('new_lead', 'won', { member_since: null }, { today: TODAY });
    expect(s.member_since).toBe(TODAY);
    expect(s.churned_at).toBeUndefined();
    expect(s.pipeline_stage_changed_at).toBeInstanceOf(Date);
  });

  test('keeps a former customer\'s real member_since (customer→customer move)', () => {
    const s = stageLifecycleStamps('won', 'active_customer', { member_since: '2025-01-01' }, { today: TODAY });
    expect(s.member_since).toBeUndefined();
  });

  test('overwrites a lead\'s intake member_since with the conversion date', () => {
    const s = stageLifecycleStamps('new_lead', 'won', { member_since: '2026-01-01' }, { today: TODAY });
    expect(s.member_since).toBe(TODAY);
  });

  test('reactivating a former customer (churned) keeps its member_since', () => {
    const s = stageLifecycleStamps('churned', 'active_customer', { member_since: '2025-01-01' }, { today: TODAY });
    expect(s.member_since).toBeUndefined();
  });

  test('reactivating a past customer keeps its member_since', () => {
    const s = stageLifecycleStamps('past_customer', 'active_customer', { member_since: '2025-01-01' }, { today: TODAY });
    expect(s.member_since).toBeUndefined();
  });

  test('reactivating a past customer with no recorded start stamps today (best effort)', () => {
    const s = stageLifecycleStamps('past_customer', 'won', { member_since: null }, { today: TODAY });
    expect(s.member_since).toBe(TODAY);
  });

  test('entering a live stage re-activates the row (active: true)', () => {
    const s = stageLifecycleStamps('past_customer', 'active_customer', { member_since: '2025-01-01' }, { today: TODAY });
    expect(s.active).toBe(true);
    const s2 = stageLifecycleStamps('churned', 'won', { member_since: '2025-01-01' }, { today: TODAY });
    expect(s2.active).toBe(true);
  });

  test('archival move to past_customer does NOT touch the active flag', () => {
    const s = stageLifecycleStamps('churned', 'past_customer', { member_since: '2025-01-01' }, { today: TODAY });
    expect(s).not.toHaveProperty('active');
  });

  test('archiving a churned customer as past_customer PRESERVES churn history', () => {
    const s = stageLifecycleStamps('churned', 'past_customer', { member_since: '2025-01-01', churned_at: '2026-03-01' }, { today: TODAY });
    expect(s).not.toHaveProperty('churned_at');
    expect(s).not.toHaveProperty('churn_reason');
    expect(s).not.toHaveProperty('member_since');
  });

  test('reactivating OUT of past_customer still clears a preserved churn stamp', () => {
    const s = stageLifecycleStamps('past_customer', 'active_customer', { member_since: '2025-01-01', churned_at: '2026-03-01' }, { today: TODAY });
    expect(s.churned_at).toBeNull();
    expect(s.churn_reason).toBeNull();
    expect(s).not.toHaveProperty('member_since');
  });

  test('always stamps churned_at (ET date) on churn; reason set to value or null', () => {
    const withReason = stageLifecycleStamps('active_customer', 'churned', { member_since: '2025-01-01' }, { today: TODAY, churnReason: 'moved' });
    expect(withReason.churned_at).toBe(TODAY);
    expect(withReason.churn_reason).toBe('moved');
    // No reason given → churn_reason cleared (don't carry a prior reason).
    const noReason = stageLifecycleStamps('active_customer', 'churned', { member_since: '2025-01-01' }, { today: TODAY });
    expect(noReason.churned_at).toBe(TODAY);
    expect(noReason.churn_reason).toBeNull();
  });

  test('clears the churn stamp on reactivation out of churned', () => {
    const s = stageLifecycleStamps('churned', 'active_customer', { member_since: '2025-01-01' }, { today: TODAY });
    expect(s.churned_at).toBeNull();
    expect(s.churn_reason).toBeNull();
  });

  test('clears a stale churned_at even when the old stage was not churned', () => {
    const s = stageLifecycleStamps('at_risk', 'active_customer', { member_since: '2025-01-01', churned_at: '2025-06-01' }, { today: TODAY });
    expect(s.churned_at).toBeNull();
    expect(s.churn_reason).toBeNull();
  });

  test('a lead→lead move only touches pipeline_stage_changed_at', () => {
    const s = stageLifecycleStamps('new_lead', 'contacted', { member_since: null }, { today: TODAY });
    expect(Object.keys(s)).toEqual(['pipeline_stage_changed_at']);
  });

  test('a no-op same-stage save returns no stamps (preserves churned_at)', () => {
    expect(stageLifecycleStamps('churned', 'churned', { member_since: '2025-01-01' }, { today: TODAY })).toEqual({});
    expect(stageLifecycleStamps('active_customer', 'active_customer', { member_since: '2025-01-01' }, { today: TODAY })).toEqual({});
  });

  test('a churned→churned re-save still applies a new churn reason', () => {
    expect(stageLifecycleStamps('churned', 'churned', { member_since: '2025-01-01' }, { today: TODAY, churnReason: 'price' }))
      .toEqual({ churn_reason: 'price' });
  });
});

describe('admin customers route helpers', () => {
  test('dedupes matching inline/dedicated units and flags contradictions', () => {
    expect(normalizeAdminAddressInput({
      addressLine1: '123 Main St Apt 4', addressLine2: 'Unit 4', city: 'Sarasota', zip: '34236',
    })).toMatchObject({
      addressLine1: '123 Main St',
      addressLine2: 'Unit 4',
      unitConflict: false,
    });
    expect(normalizeAdminAddressInput({
      addressLine1: '123 Main St Apt 4', addressLine2: 'Unit 5', city: 'Sarasota', zip: '34236',
    }).unitConflict).toBe(true);
  });

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
    // payment_pending (sent-but-unpaid) STILL covering today → cover the same
    // window (term_start), NOT term_end + 1, so the overlap guard rejects a
    // stacked duplicate.
    expect(
      defaultAnnualPrepayTermStart(
        { status: 'payment_pending', term_start: '2026-07-01', term_end: '2027-06-30' },
        today,
      ),
    ).toBe('2026-07-01');
    // An EXPIRED payment_pending window (term_end before today) is moot → start
    // today so a fresh prepay isn't blocked by a stale unpaid row.
    expect(
      defaultAnnualPrepayTermStart(
        { status: 'payment_pending', term_start: '2024-01-01', term_end: '2024-12-31' },
        today,
      ),
    ).toBe(today);
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
      address_line2: 'Suite 2',
      city: 'Sarasota',
      state: 'FL',
      zip: '34236',
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
      address: '1 Algorithm Way, Suite 2, Sarasota, FL 34236',
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
      address_line2: 'Unit 4',
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
      address: '1 Algorithm Way, Unit 4, Sarasota, FL 34236',
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
      service_contact_role: null,
      service_contact2_name: 'Sam Spouse',
      service_contact2_phone: '+19415550112',
      service_contact2_email: 'sam@example.com',
      service_contact2_role: 'spouse_partner',
      service_contact3_name: null,
      service_contact3_phone: null,
      service_contact3_email: null,
      service_contact3_role: null,
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
      // The person's role travels WITH them through the promotion.
      service_contact_role: 'spouse_partner',
      service_contact2_name: null,
      service_contact2_phone: null,
      service_contact2_email: null,
      service_contact2_role: null,
      service_contact3_name: null,
      service_contact3_phone: null,
      service_contact3_email: null,
      service_contact3_role: null,
      // Identity changed (Grace removed) → the consent artifact no longer
      // describes the stored list, so the save clears it (#2948).
      service_contacts_consent_at: null,
      service_contacts_consent_source: null,
      service_contacts_consent_text_version: null,
    });
  });

  test('a service-contact identity change clears the consent artifact (#2948)', () => {
    const before = {
      service_contact_name: 'Terry Tenant',
      service_contact_phone: '+19415550112',
      service_contact_email: 'terry@example.com',
      service_contacts_consent_at: '2026-07-22T00:00:00Z',
      service_contacts_consent_source: 'portal_account_holder',
      service_contacts_consent_text_version: 'portal-2026-07-22',
    };
    // Admin swaps Terry's phone for a different person's number.
    const updates = {
      service_contact_name: 'Terry Tenant',
      service_contact_phone: '+19415550999',
      service_contact_email: 'terry@example.com',
    };
    compactServiceContactSlots(updates, before);
    expect(updates.service_contacts_consent_at).toBeNull();
    expect(updates.service_contacts_consent_source).toBeNull();
    expect(updates.service_contacts_consent_text_version).toBeNull();
  });

  test('an identity-preserving echo save keeps the consent artifact (#2948)', () => {
    const before = {
      service_contact_name: 'Terry Tenant',
      service_contact_phone: '+19415550112',
      service_contact_email: 'terry@example.com',
      service_contacts_consent_at: '2026-07-22T00:00:00Z',
      service_contacts_consent_source: 'portal_account_holder',
      service_contacts_consent_text_version: 'portal-2026-07-22',
    };
    // Edit form echoes the same people back unchanged (whitespace only).
    const updates = {
      service_contact_name: ' Terry Tenant ',
      service_contact_phone: '+19415550112',
      service_contact_email: 'terry@example.com',
    };
    compactServiceContactSlots(updates, before);
    expect(updates).not.toHaveProperty('service_contacts_consent_at');
    expect(updates).not.toHaveProperty('service_contacts_consent_source');
  });

  test('an echoed shifted list carries the role with the person (codex round-5 P2)', () => {
    // Admin edit form echoes every field: the tenant moved from slot 2 into
    // slot 1, slot 2 cleared, no role fields in the payload. The person's
    // role must follow them; per-slot comparison would have dropped it.
    const before = {
      service_contact_name: 'Rhonda Realtor',
      service_contact_phone: '+19415550100',
      service_contact_email: '',
      service_contact_role: 'real_estate_agent',
      service_contact2_name: 'Terry Tenant',
      service_contact2_phone: '+19415550112',
      service_contact2_email: '',
      service_contact2_role: 'tenant',
    };
    const updates = {
      service_contact_name: 'Terry Tenant',
      service_contact_phone: '+19415550112',
      service_contact_email: '',
      service_contact2_name: '',
      service_contact2_phone: '',
      service_contact2_email: '',
      service_contact3_name: '',
      service_contact3_phone: '',
      service_contact3_email: '',
    };

    compactServiceContactSlots(updates, before);

    expect(updates.service_contact_name).toBe('Terry Tenant');
    expect(updates.service_contact_role).toBe('tenant');
    expect(updates.service_contact2_role).toBeNull();
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

  test('seasonal mosquito (9 visits) maps to the seasonal cadence, not custom/42 (codex r5 P1)', () => {
    // The seasonal9 tier's rows carry frequency 'every_6_weeks'; the modal
    // pre-fill was booking a 42-day series (incl. winter visits) because the
    // booking route creates the series itself and never reaches the
    // converter's forced resolver.
    expect(cadenceFromEstimateLine({
      service: 'mosquito_seasonal',
      name: 'Seasonal Mosquito Control',
      frequency: 'every_6_weeks',
      visitsPerYear: 9,
    }, 'quarterly')).toBe('seasonal_feb_oct');
    // Scoped to mosquito: T&S 9x keeps the every-6-weeks → custom/42 mapping.
    expect(cadenceFromEstimateLine({
      service: 'tree_shrub',
      name: 'Enhanced Tree & Shrub Care Service',
      frequency: 'every_6_weeks',
      visitsPerYear: 9,
    }, 'quarterly')).toBe('every_6_weeks');
    // Monthly mosquito is unaffected.
    expect(cadenceFromEstimateLine({
      service: 'mosquito_monthly',
      name: 'Monthly Mosquito Control',
      frequency: 'monthly',
      visitsPerYear: 12,
    }, 'quarterly')).toBe('monthly');
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

  test('tick-only lines resolve to tick_control, not the flea-only rebranded service (Codex P2)', () => {
    const serviceIndex = indexServicesForSchedule([
      { id: 1, service_key: 'flea_tick', name: 'Flea Control Service', short_name: 'Flea' },
      { id: 2, service_key: 'tick_control', name: 'Tick Control Service', short_name: 'Tick' },
    ]);

    expect(serviceCatalogMatch({ name: 'Tick Treatment' }, serviceIndex)?.service_key).toBe('tick_control');
    expect(serviceCatalogMatch({ name: 'Flea Treatment' }, serviceIndex)?.service_key).toBe('flea_tick');
    // A combined flea-and-tick line keeps resolving to the flea service.
    expect(serviceCatalogMatch({ name: 'Flea and Tick Yard Treatment' }, serviceIndex)?.service_key).toBe('flea_tick');

    // Envs without a tick_control row keep the legacy flea_tick resolution
    // rather than dropping the line to no-match.
    const legacyIndex = indexServicesForSchedule([
      { id: 1, service_key: 'flea_tick', name: 'Flea Control Service', short_name: 'Flea' },
    ]);
    expect(serviceCatalogMatch({ name: 'Tick Treatment' }, legacyIndex)?.service_key).toBe('flea_tick');
  });

  test('seasonal mosquito lines keep the seasonal catalog identity, never monthly (codex r16 P2)', () => {
    const index = indexServicesForSchedule([
      { id: 10, service_key: 'mosquito_monthly', name: 'Monthly Mosquito Control', category: 'mosquito', billing_type: 'recurring', frequency: 'monthly', visits_per_year: 12 },
      { id: 11, service_key: 'mosquito_seasonal', name: 'Seasonal Mosquito Control', category: 'mosquito', billing_type: 'recurring', frequency: 'seasonal_feb_oct', visits_per_year: 9 },
    ]);
    const estimate = {
      id: 'estimate-mq-seasonal',
      monthly_total: 82.5,
      estimate_data: {
        result: {
          recurring: {
            services: [{ service: 'mosquito_seasonal', name: 'Seasonal Mosquito Control', frequency: 'every_6_weeks', visitsPerYear: 9, mo: 82.5 }],
          },
        },
      },
    };
    const [line] = scheduleLinesFromEstimate(estimate, index);
    expect(line.cadence).toBe('seasonal_feb_oct');
    expect(line.serviceKey).toBe('mosquito_seasonal');
    expect(line.serviceId).toBe(11);
    // Without the seasonal catalog row (env not yet migrated), fail to NO
    // identity rather than stamping the monthly row on a seasonal series.
    const monthlyOnlyIndex = indexServicesForSchedule([
      { id: 10, service_key: 'mosquito_monthly', name: 'Monthly Mosquito Control', category: 'mosquito', billing_type: 'recurring', frequency: 'monthly', visits_per_year: 12 },
    ]);
    const [fallbackLine] = scheduleLinesFromEstimate(estimate, monthlyOnlyIndex);
    expect(fallbackLine.cadence).toBe('seasonal_feb_oct');
    expect(fallbackLine.serviceId).toBe(null);
    expect(fallbackLine.serviceKey).not.toBe('mosquito_monthly');
    // Accepted seasonal selections are restamped as { service: 'mosquito',
    // serviceKey: 'mosquito_seasonal' } with a shortened name — the explicit
    // serviceKey must be its own FIRST match candidate or the fuzzy matcher
    // lands on mosquito_monthly (codex r17 P2).
    const restamped = {
      id: 'estimate-mq-restamped',
      monthly_total: 82.5,
      estimate_data: {
        result: {
          recurring: {
            services: [{ service: 'mosquito', serviceKey: 'mosquito_seasonal', name: 'Seasonal Mosquito Control', frequency: 'every_6_weeks', visitsPerYear: 9, mo: 82.5 }],
          },
        },
      },
    };
    const [restampedLine] = scheduleLinesFromEstimate(restamped, index);
    expect(restampedLine.serviceKey).toBe('mosquito_seasonal');
    expect(restampedLine.serviceId).toBe(11);
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

  test('perApplicationPrice: canonical discount-aware provenance on engine rows (codex #3167 audit)', () => {
    const index = indexServicesForSchedule([]);
    // Engine pest row: perTreatment is the explicit per-application signal.
    const listOnly = {
      id: 'est-pa-1',
      monthly_total: 40.33,
      estimate_data: {
        result: { recurring: { services: [
          { service: 'pest_control', name: 'Pest Control', perTreatment: 121, visitsPerYear: 4, mo: 40.33, monthly: 40.33 },
        ] } },
      },
    };
    const [listLine] = scheduleLinesFromEstimate(listOnly, index);
    expect(listLine.perApplicationPrice).toBe(121);
    expect(listLine.price).toBe(121); // pre-fill semantics untouched
    // Per-application rows carry `mo` only as a normalized list figure —
    // never monthly provenance (codex r4).
    expect(listLine.monthlyPrice).toBeUndefined();

    // Discounted row: priceAfterDiscount (per-treatment-after-discount) wins
    // over the list perTreatment AND over the list annual.
    const discounted = {
      id: 'est-pa-2',
      monthly_total: 36.30,
      estimate_data: {
        result: { recurring: { services: [
          { service: 'pest_control', name: 'Pest Control', perTreatment: 121, priceAfterDiscount: 108.90, visitsPerYear: 4, annual: 484, mo: 40.33 },
        ] } },
      },
    };
    const [discLine] = scheduleLinesFromEstimate(discounted, index);
    expect(discLine.perApplicationPrice).toBe(108.90);

    // Genuinely monthly-billed keys never carry per-application provenance.
    const monthlyBilled = {
      id: 'est-pa-3',
      monthly_total: 39,
      estimate_data: {
        result: { recurring: { services: [
          { service: 'rodent_bait', name: 'Rodent Bait Stations', perTreatment: 117, visitsPerYear: 4, mo: 39 },
        ] } },
      },
    };
    const [rodentLine] = scheduleLinesFromEstimate(monthlyBilled, index);
    expect(rodentLine.perApplicationPrice).toBeUndefined();
    // ...but DOES carry explicit monthly provenance (its true billing unit).
    expect(rodentLine.monthlyPrice).toBe(39);
    // Parent-level WaveGuard/manual discount with LIST-only rows (Codex
    // #3173 r3): provenance is REFUSED — the accepted price is discounted
    // and the rows can't prove the net figure.
    const parentDiscounted = {
      id: 'est-pa-4',
      monthly_total: 174.08,
      estimate_data: {
        result: { recurring: {
          discount: 0.15,
          services: [
            { service: 'pest_control', name: 'Pest Control', perTreatment: 180, visitsPerYear: 4, mo: 60 },
            { service: 'lawn_care', name: 'Lawn Care', perTreatment: 89, visitsPerYear: 9, mo: 66.75 },
          ],
        } },
      },
    };
    const discountedLines = scheduleLinesFromEstimate(parentDiscounted, index);
    for (const l of discountedLines) expect(l.perApplicationPrice).toBeUndefined();
    // Aggregate manual discount at result.manualDiscount (the persisted
    // engine location, codex r4) with list-only rows: provenance refused.
    const manualDiscounted = {
      id: 'est-pa-5',
      monthly_total: 90,
      estimate_data: {
        result: {
          manualDiscount: { type: 'FIXED', amount: 780 },
          recurring: { services: [
            { service: 'pest_control', name: 'Pest Control', perTreatment: 180, visitsPerYear: 4, mo: 60 },
          ] },
        },
      },
    };
    const manualLines = scheduleLinesFromEstimate(manualDiscounted, index);
    for (const l of manualLines) expect(l.perApplicationPrice).toBeUndefined();
    // Commercial recurring is EXEMPT from the per-application unit rule
    // (bills monthly): perTreatment never stamps per-app provenance, and
    // the true monthly rides as monthlyPrice (codex #3173 r2-2).
    const commercial = {
      id: 'est-pa-6',
      monthly_total: 250,
      estimate_data: {
        result: { recurring: { services: [
          { service: 'commercial_pest', name: 'Commercial Pest Control', perTreatment: 750, visitsPerYear: 4, mo: 250 },
        ] } },
      },
    };
    const [commercialLine] = scheduleLinesFromEstimate(commercial, index);
    expect(commercialLine.perApplicationPrice).toBeUndefined();
    expect(commercialLine.monthlyPrice).toBe(250);
    // A manual discount whose RECURRING slice is zero (redirected entirely
    // to one-time work) leaves recurring provenance intact (codex r3).
    const oneTimeOnlyDiscount = {
      id: 'est-pa-7',
      monthly_total: 40.33,
      estimate_data: {
        result: {
          manualDiscount: { type: 'FIXED', amount: 780, recurringAmount: 0, oneTimeAmount: 780 },
          recurring: { services: [
            { service: 'pest_control', name: 'Pest Control', perTreatment: 121, visitsPerYear: 4, mo: 40.33 },
          ] },
        },
      },
    };
    const [otdLine] = scheduleLinesFromEstimate(oneTimeOnlyDiscount, index);
    expect(otdLine.perApplicationPrice).toBe(121);

    // Name-only legacy rows resolve their service key through the catalog
    // match — a station rental must hit the monthly-billed exemption, never
    // stamp $31/application (codex r3).
    const rentalIndex = indexServicesForSchedule([
      { id: 21, service_key: 'termite_station_rental', name: 'Termite Station Rental', category: 'termite', billing_type: 'recurring', frequency: 'quarterly', visits_per_year: 4 },
    ]);
    const nameOnlyRental = {
      id: 'est-pa-8',
      monthly_total: 10.33,
      estimate_data: {
        result: { recurring: { services: [
          { name: 'Termite Station Rental', perTreatment: 31, visitsPerYear: 4, mo: 10.33 },
        ] } },
      },
    };
    const [rentalLine] = scheduleLinesFromEstimate(nameOnlyRental, rentalIndex);
    expect(rentalLine.perApplicationPrice).toBeUndefined();
    expect(rentalLine.monthlyPrice).toBe(10.33);
    // manualFinalAnnual (POST-manual-discount) outranks the pre-manual
    // annualAfterDiscount: $400 accepted year / 4 visits = $100/application
    // (codex r4).
    const manualRecurring = {
      id: 'est-pa-9',
      monthly_total: 33.33,
      estimate_data: {
        result: {
          manualDiscount: { type: 'FIXED', amount: 84, recurringAmount: 84 },
          recurring: { services: [
            { service: 'pest_control', name: 'Pest Control', perTreatment: 121, priceAfterDiscount: 121, annualAfterDiscount: 484, manualFinalAnnual: 400, visitsPerYear: 4, mo: 40.33 },
          ] },
        },
      },
    };
    const [mfLine] = scheduleLinesFromEstimate(manualRecurring, index);
    expect(mfLine.perApplicationPrice).toBe(100);

    // One-time rows keep price GROSS but carry the accepted net separately.
    const manualOneTime = {
      id: 'est-pa-10',
      onetime_total: 220,
      estimate_data: {
        result: {
          oneTime: { items: [
            { service: 'bed_bug', name: 'Bed Bug Treatment', price: 300, manualFinalOneTime: 220 },
          ] },
        },
      },
    };
    const otLines = scheduleLinesFromEstimate(manualOneTime, index);
    const bb = otLines.find((l) => /bed bug/i.test(l.name));
    expect(bb.acceptedOneTimePrice).toBe(220);
    expect(bb.price).toBe(300);
    // Accepted ZERO recurring (fixed/100% manual discount consuming the
    // base) wins over the pre-manual annual — presence, not positivity
    // (codex r5).
    const fullyDiscounted = {
      id: 'est-pa-11',
      monthly_total: 0,
      estimate_data: {
        result: {
          manualDiscount: { type: 'FIXED', amount: 484, recurringAmount: 484 },
          recurring: { services: [
            { service: 'pest_control', name: 'Pest Control', perTreatment: 121, annualAfterDiscount: 484, manualFinalAnnual: 0, visitsPerYear: 4, mo: 40.33 },
          ] },
        },
      },
    };
    const [fdLine] = scheduleLinesFromEstimate(fullyDiscounted, index);
    expect(fdLine.perApplicationPrice).toBeUndefined(); // $0/visit is not a per-application CHARGE

    // Catalog aliases normalize to engine keys before the billing-unit
    // decision: a name-only rodent-bait row matches rodent_bait_quarterly
    // in the catalog but must still take the monthly-billed exemption
    // (codex r5).
    const rodentIndex = indexServicesForSchedule([
      { id: 31, service_key: 'rodent_bait_quarterly', name: 'Quarterly Rodent Bait Station Service', short_name: 'Rodent Bait', category: 'rodent', billing_type: 'recurring', frequency: 'quarterly', visits_per_year: 4 },
    ]);
    const nameOnlyRodent = {
      id: 'est-pa-12',
      monthly_total: 39,
      estimate_data: {
        result: { recurring: { services: [
          { name: 'Rodent Bait Stations', perTreatment: 117, visitsPerYear: 4, mo: 39 },
        ] } },
      },
    };
    const [rodentAliasLine] = scheduleLinesFromEstimate(nameOnlyRodent, rodentIndex);
    expect(rodentAliasLine.perApplicationPrice).toBeUndefined();
    expect(rodentAliasLine.monthlyPrice).toBe(39);
    // Specialty one-time rows (exclusion et al.) travel the specItems
    // branch — they carry the accepted net too (codex r6).
    const specialtyDiscounted = {
      id: 'est-pa-13',
      onetime_total: 400,
      estimate_data: {
        result: {
          oneTime: { specItems: [
            { service: 'exclusion', name: 'Exclusion Work', price: 500, manualFinalOneTime: 400 },
          ] },
        },
      },
    };
    const specLines = scheduleLinesFromEstimate(specialtyDiscounted, index);
    const exclusion = specLines.find((l) => /exclusion/i.test(l.name));
    expect(exclusion.acceptedOneTimePrice).toBe(400);
    expect(exclusion.price).toBe(500);







  });

});

// #3140 resolution: the inferred-monthly vector — admin creates/edits that
// leave (NULL lane + real tier + positive rate) — is closed by stamping the
// inference explicitly. These are source pins on the route wiring; the stamp
// decision itself is unit-tested in billing-lane.test.js
// (impliedMonthlyStampForWrite).
describe('admin customer writes stamp the implied monthly lane (source pins)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/admin-customers.js'), 'utf8');

  test('the create path inserts an explicit-or-stamped billing_mode', () => {
    expect(src).toContain('billing_mode: billingModeForCreate');
    expect(src).toMatch(/const billingModeForCreate = explicitBillingMode \|\| impliedLaneStamp;/);
  });

  test('the update path stamps only lane-less saves, decided UNDER the row lock', () => {
    // Never restamp over an operator's own lane decision in the same save…
    expect(src).toContain('const laneStampEligible = req.body.billingMode === undefined && updates.billing_mode === undefined;');
    // …and the decision reads the LOCKED row (pre-push codex P0): a
    // concurrent explicit-lane save that commits before our lock must not
    // be overwritten by the stamp.
    expect(src).toContain('impliedLaneStamp = impliedMonthlyStampForWrite(lockedBefore, { ...lockedBefore, ...updates });');
    expect(src).toContain('if (impliedLaneStamp) updates.billing_mode = impliedLaneStamp;');
    // The stamp lands after changed/after were snapshotted — both are
    // patched post-commit so the sensitive audit records the lane write.
    expect(src).toContain("changed.push('billing_mode');");
  });

  test('both stamp sites surface an owner review notification', () => {
    const sites = src.match(/'billing_lane_review'/g) || [];
    expect(sites.length).toBe(2);
  });
});

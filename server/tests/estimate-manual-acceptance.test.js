jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../services/estimate-converter', () => ({ convertEstimate: jest.fn() }));
jest.mock('../services/lead-estimate-link', () => ({ markLinkedLeadEstimateAccepted: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({
  sendMembershipStarted: jest.fn().mockResolvedValue({ sent: true }),
}));

const AccountMembershipEmail = require('../services/account-membership-email');
const {
  hasManualAnnualPrepayRecurringRows,
  isManualAnnualPrepayEligibleServiceMix,
  markEstimateManuallyAccepted,
} = require('../services/estimate-manual-acceptance');

function makeDb(estimate) {
  const updates = [];
  const inserts = [];
  const database = jest.fn((table) => {
    const builder = {
      clause: null,
      statusList: null,
      rawClause: null,
      where(clause) {
        this.clause = clause;
        return this;
      },
      whereIn(column, values) {
        this.statusList = { column, values };
        return this;
      },
      whereRaw(clause) {
        this.rawClause = clause;
        return this;
      },
      first: async () => {
        if (table === 'estimates') return estimate;
        return null;
      },
      update(patch) {
        updates.push({
          table,
          clause: this.clause,
          statusList: this.statusList,
          rawClause: this.rawClause,
          patch,
        });
        const updated = { ...estimate, ...patch };
        return {
          returning: async () => [updated],
        };
      },
      insert: async (row) => {
        inserts.push({ table, row });
        return [row];
      },
    };
    return builder;
  });
  database.fn = { now: () => 'NOW' };
  database.transaction = jest.fn(async (callback) => callback(database));
  return { database, updates, inserts };
}

describe('estimate manual acceptance', () => {
  beforeEach(() => {
    AccountMembershipEmail.sendMembershipStarted.mockClear();
  });

  test('stamps accepted_at, clears lost metadata, and runs won hooks', async () => {
    const estimate = {
      id: 'estimate-1',
      status: 'viewed',
      customer_id: 'customer-1',
      sent_at: '2026-05-10T12:00:00.000Z',
      accepted_at: null,
      declined_at: '2026-05-11T12:00:00.000Z',
      decline_reason: 'Too expensive',
      monthly_total: '125.00',
      onetime_total: '99.00',
      waveguard_tier: 'Gold',
    };
    const { database, updates, inserts } = makeDb(estimate);
    const leadLinkService = { markLinkedLeadEstimateAccepted: jest.fn().mockResolvedValue() };
    const membershipEmail = {
      customerId: 'customer-1',
      sourceId: `estimate:${estimate.id}`,
      membershipTier: 'Gold',
    };
    const estimateConverter = { convertEstimate: jest.fn().mockResolvedValue({ customerId: 'customer-1', membershipEmail }) };

    const result = await markEstimateManuallyAccepted({
      estimateId: estimate.id,
      adminUserId: 'admin-1',
      database,
      leadLinkService,
      estimateConverter,
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      table: 'estimates',
      clause: { id: estimate.id },
      statusList: { column: 'status', values: ['sent', 'viewed'] },
      rawClause: '(expires_at IS NULL OR expires_at >= NOW())',
      patch: {
        status: 'accepted',
        accepted_at: 'NOW',
        declined_at: null,
        decline_reason: null,
        updated_at: 'NOW',
      },
    });
    expect(updates[0].patch).not.toHaveProperty('sent_at');
    expect(leadLinkService.markLinkedLeadEstimateAccepted).toHaveBeenCalledWith({
      estimateId: estimate.id,
      customerId: 'customer-1',
      monthlyValue: 125,
      initialServiceValue: 99,
      waveguardTier: 'Gold',
    });
    expect(estimateConverter.convertEstimate).toHaveBeenCalledWith(estimate.id, {
      database,
      skipAutoSchedule: true,
      skipSetupInvoice: true,
      skipMembershipEmail: true,
    });
    expect(AccountMembershipEmail.sendMembershipStarted).toHaveBeenCalledWith(membershipEmail);
    expect(inserts).toEqual([
      expect.objectContaining({
        table: 'activity_log',
        row: expect.objectContaining({
          admin_user_id: 'admin-1',
          customer_id: 'customer-1',
          estimate_id: estimate.id,
          action: 'estimate_manual_accept',
        }),
      }),
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.estimate.status).toBe('accepted');
  });

  test('manual annual prepay creates the annual draft invoice and pending term through the converter', async () => {
    const estimate = {
      id: 'estimate-annual-prepay',
      status: 'viewed',
      customer_id: 'customer-annual',
      sent_at: '2026-05-10T12:00:00.000Z',
      accepted_at: null,
      declined_at: null,
      decline_reason: null,
      monthly_total: '55.00',
      annual_total: '660.00',
      onetime_total: '99.00',
      waveguard_tier: 'Bronze',
      estimate_data: {
        recurring: {
          services: [{ service: 'pest_control', name: 'Pest Control', frequency: 'quarterly' }],
        },
      },
    };
    const { database, updates, inserts } = makeDb(estimate);
    const leadLinkService = { markLinkedLeadEstimateAccepted: jest.fn().mockResolvedValue() };
    const membershipEmail = {
      customerId: 'customer-annual',
      sourceId: `estimate:${estimate.id}`,
      membershipTier: 'Bronze',
    };
    const estimateConverter = {
      convertEstimate: jest.fn().mockResolvedValue({
        customerId: 'customer-annual',
        billingTerm: 'prepay_annual',
        draftInvoiceId: 'invoice-annual',
        membershipEmail,
      }),
    };

    const result = await markEstimateManuallyAccepted({
      estimateId: estimate.id,
      adminUserId: 'admin-annual',
      source: 'verbal_annual_prepay',
      billingTerm: 'prepay_annual',
      database,
      leadLinkService,
      estimateConverter,
    });

    expect(updates[0].patch).toMatchObject({
      status: 'accepted',
      accepted_at: 'NOW',
    });
    expect(estimateConverter.convertEstimate).toHaveBeenCalledWith(estimate.id, {
      database,
      skipAutoSchedule: true,
      skipSetupInvoice: false,
      skipMembershipEmail: true,
      autoSendInvoice: false,
      billingTerm: 'prepay_annual',
      prepayInvoiceAmount: 660,
    });
    expect(inserts).toEqual([
      expect.objectContaining({
        table: 'activity_log',
        row: expect.objectContaining({
          admin_user_id: 'admin-annual',
          action: 'estimate_manual_accept',
          metadata: expect.stringContaining('"billingTerm":"prepay_annual"'),
        }),
      }),
    ]);
    expect(result.billingTerm).toBe('prepay_annual');
    expect(result.conversion).toEqual(expect.objectContaining({
      draftInvoiceId: 'invoice-annual',
      billingTerm: 'prepay_annual',
    }));
    expect(AccountMembershipEmail.sendMembershipStarted).not.toHaveBeenCalled();
  });

  test('manual annual prepay rejects estimates without recurring value before marking accepted', async () => {
    const estimate = {
      id: 'estimate-no-recurring-prepay',
      status: 'sent',
      customer_id: 'customer-no-recurring',
      monthly_total: '0.00',
      annual_total: '0.00',
      onetime_total: '250.00',
      waveguard_tier: null,
    };
    const { database, updates, inserts } = makeDb(estimate);

    await expect(markEstimateManuallyAccepted({
      estimateId: estimate.id,
      billingTerm: 'prepay_annual',
      database,
      estimateConverter: { convertEstimate: jest.fn() },
    })).rejects.toMatchObject({
      statusCode: 400,
      message: 'Annual prepay requires a recurring estimate with a monthly or annual total.',
    });

    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
  });

  test('manual annual prepay rejects amount-only estimates without recurring rows', async () => {
    const estimate = {
      id: 'estimate-legacy-amount-only-prepay',
      status: 'sent',
      customer_id: 'customer-legacy',
      monthly_total: '55.00',
      annual_total: '660.00',
      onetime_total: '0.00',
      estimate_data: { result: { onetime: { services: [{ service: 'pest_control' }] } } },
    };
    const { database, updates, inserts } = makeDb(estimate);
    const estimateConverter = { convertEstimate: jest.fn() };

    await expect(markEstimateManuallyAccepted({
      estimateId: estimate.id,
      billingTerm: 'prepay_annual',
      database,
      estimateConverter,
    })).rejects.toMatchObject({
      statusCode: 400,
      message: 'Annual prepay requires recurring service rows on the estimate.',
    });

    expect(estimateConverter.convertEstimate).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
  });

  test('manual annual prepay now allows non-pest recurring mixes (tree & shrub) — 5% prepay model', async () => {
    // Under the unified model every recurring mix can prepay (pest/mosquito waive
    // the setup, all others take the prepay discount), so a tree & shrub mix that
    // was previously ineligible now converts.
    const estimate = {
      id: 'estimate-treeshrub-prepay',
      status: 'sent',
      customer_id: 'customer-treeshrub',
      monthly_total: '55.00',
      annual_total: '660.00',
      onetime_total: '0.00',
      waveguard_tier: 'Bronze',
      estimate_data: {
        recurring: {
          services: [{ service: 'tree_shrub', name: 'Tree & Shrub Care', frequency: 'monthly' }],
        },
      },
    };
    const { database, updates } = makeDb(estimate);
    const leadLinkService = { markLinkedLeadEstimateAccepted: jest.fn().mockResolvedValue() };
    const estimateConverter = {
      convertEstimate: jest.fn().mockResolvedValue({
        customerId: 'customer-treeshrub',
        billingTerm: 'prepay_annual',
        draftInvoiceId: 'invoice-treeshrub',
      }),
    };

    await markEstimateManuallyAccepted({
      estimateId: estimate.id,
      adminUserId: 'admin-1',
      source: 'verbal_annual_prepay',
      billingTerm: 'prepay_annual',
      database,
      leadLinkService,
      estimateConverter,
    });

    expect(estimateConverter.convertEstimate).toHaveBeenCalledWith(estimate.id, expect.objectContaining({
      billingTerm: 'prepay_annual',
      prepayInvoiceAmount: 660,
    }));
    expect(updates[0].patch).toMatchObject({ status: 'accepted' });
  });

  test('manual annual prepay rejects commercial proposals before marking accepted', async () => {
    // A proposal-enabled estimate skips EstimateConverter (its pricing lives in
    // estimate_data.proposal.buildings, which the converter does not read), so
    // an annual-prepay accept would silently create no invoice/term. Reject it.
    const estimate = {
      id: 'estimate-proposal-prepay',
      status: 'sent',
      customer_id: 'customer-board',
      monthly_total: '1200.00',
      annual_total: '14400.00',
      onetime_total: '0.00',
      estimate_data: {
        proposal: {
          enabled: true,
          buildings: [{ name: 'Tower A', lineItems: [{ label: 'Quarterly pest', amount: 3600, cadence: 'quarterly' }] }],
        },
        // Legacy recurring rows present too, so the prepay row/mix checks would
        // otherwise pass — the proposal guard must still short-circuit first.
        recurring: { services: [{ service: 'pest_control', name: 'Pest Control', frequency: 'monthly' }] },
      },
    };
    const { database, updates, inserts } = makeDb(estimate);
    const estimateConverter = { convertEstimate: jest.fn() };

    await expect(markEstimateManuallyAccepted({
      estimateId: estimate.id,
      billingTerm: 'prepay_annual',
      database,
      estimateConverter,
    })).rejects.toMatchObject({
      statusCode: 400,
      message: 'Annual prepay is not available for a commercial proposal. Mark it accepted as a standard win and bill it through the proposal invoice flow.',
    });

    expect(estimateConverter.convertEstimate).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
  });

  test('standard manual accept of a commercial proposal records the win but skips the converter', async () => {
    const estimate = {
      id: 'estimate-proposal-standard',
      status: 'viewed',
      customer_id: 'customer-board-2',
      monthly_total: '1200.00',
      annual_total: '14400.00',
      onetime_total: '0.00',
      estimate_data: {
        proposal: {
          enabled: true,
          buildings: [{ name: 'Tower A', lineItems: [{ label: 'Quarterly pest', amount: 3600, cadence: 'quarterly' }] }],
        },
      },
    };
    const { database, updates } = makeDb(estimate);
    const estimateConverter = { convertEstimate: jest.fn() };
    const leadLinkService = { markLinkedLeadEstimateAccepted: jest.fn().mockResolvedValue() };

    const result = await markEstimateManuallyAccepted({
      estimateId: estimate.id,
      database,
      leadLinkService,
      estimateConverter,
    });

    expect(estimateConverter.convertEstimate).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
    expect(updates[0].patch).toMatchObject({ status: 'accepted' });
    expect(result.estimate.status).toBe('accepted');
  });


  test('manual annual prepay rolls back when conversion does not create a draft invoice', async () => {
    const estimate = {
      id: 'estimate-annual-no-invoice',
      status: 'viewed',
      customer_id: 'customer-annual-no-invoice',
      sent_at: '2026-05-10T12:00:00.000Z',
      monthly_total: '55.00',
      annual_total: '660.00',
      waveguard_tier: 'Bronze',
      estimate_data: {
        result: {
          recurring: {
            services: [{ service: 'pest_control', name: 'Pest Control', frequency: 'quarterly' }],
          },
        },
      },
    };
    const { database } = makeDb(estimate);
    const estimateConverter = {
      convertEstimate: jest.fn().mockResolvedValue({ customerId: estimate.customer_id }),
    };

    await expect(markEstimateManuallyAccepted({
      estimateId: estimate.id,
      billingTerm: 'prepay_annual',
      database,
      estimateConverter,
    })).rejects.toMatchObject({
      statusCode: 500,
      message: 'Customer conversion did not complete; estimate was not marked accepted.',
    });

    expect(estimateConverter.convertEstimate).toHaveBeenCalledWith(estimate.id, expect.objectContaining({
      billingTerm: 'prepay_annual',
      autoSendInvoice: false,
    }));
    expect(AccountMembershipEmail.sendMembershipStarted).not.toHaveBeenCalled();
  });

  test('repairs missing sent_at so manual wins have a funnel denominator', async () => {
    const estimate = {
      id: 'estimate-2',
      status: 'sent',
      customer_id: 'customer-2',
      sent_at: null,
      accepted_at: null,
      monthly_total: '0.00',
      onetime_total: '250.00',
      waveguard_tier: null,
    };
    const { database, updates } = makeDb(estimate);
    const leadLinkService = { markLinkedLeadEstimateAccepted: jest.fn().mockResolvedValue() };
    const estimateConverter = { convertEstimate: jest.fn() };

    const result = await markEstimateManuallyAccepted({
      estimateId: estimate.id,
      database,
      leadLinkService,
      estimateConverter,
    });

    expect(updates[0].patch).toMatchObject({
      status: 'accepted',
      accepted_at: 'NOW',
      sent_at: 'NOW',
    });
    expect(leadLinkService.markLinkedLeadEstimateAccepted).toHaveBeenCalledWith({
      estimateId: estimate.id,
      customerId: 'customer-2',
      monthlyValue: null,
      initialServiceValue: 250,
      waveguardTier: null,
    });
    expect(estimateConverter.convertEstimate).not.toHaveBeenCalled();
    expect(AccountMembershipEmail.sendMembershipStarted).not.toHaveBeenCalled();
    expect(result.warnings).toEqual([]);
  });

  test('rejects non-delivered estimates', async () => {
    const estimate = { id: 'estimate-3', status: 'draft' };
    const { database, updates, inserts } = makeDb(estimate);

    await expect(markEstimateManuallyAccepted({
      estimateId: estimate.id,
      database,
    })).rejects.toMatchObject({
      statusCode: 400,
      message: 'Only sent or viewed estimates can be manually marked accepted. Current status: draft.',
    });

    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
  });

  test('rejects invoice-mode estimates because public accept creates the invoice-mode invoice', async () => {
    const estimate = {
      id: 'estimate-4',
      status: 'sent',
      bill_by_invoice: true,
    };
    const { database, updates, inserts } = makeDb(estimate);

    await expect(markEstimateManuallyAccepted({
      estimateId: estimate.id,
      database,
    })).rejects.toMatchObject({
      statusCode: 400,
      message: 'Invoice-mode estimates must be accepted through the customer link so the due-immediately invoice is created correctly.',
    });

    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
  });

  test('rejects expired sent estimates before closing them accepted', async () => {
    const estimate = {
      id: 'estimate-expired',
      status: 'sent',
      customer_id: 'customer-expired',
      expires_at: '2020-01-01T00:00:00.000Z',
    };
    const { database, updates, inserts } = makeDb(estimate);

    await expect(markEstimateManuallyAccepted({
      estimateId: estimate.id,
      database,
    })).rejects.toMatchObject({
      statusCode: 409,
      message: 'Estimate is no longer active.',
    });

    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
  });

  test('rejects unresolved manager approval before closing estimates accepted', async () => {
    const estimate = {
      id: 'estimate-manager-approval',
      status: 'viewed',
      customer_id: 'customer-manager-approval',
      estimate_data: {
        result: {
          oneTime: {
            items: [
              {
                service: 'dethatching',
                requiresManagerApproval: true,
                managerApprovalReason: 'st_augustine_dethatching',
                managerApprovalSatisfied: false,
              },
            ],
          },
        },
      },
    };
    const { database, updates, inserts } = makeDb(estimate);

    await expect(markEstimateManuallyAccepted({
      estimateId: estimate.id,
      database,
    })).rejects.toMatchObject({
      statusCode: 400,
      message: 'Manager approval is required before this estimate can be manually accepted.',
    });

    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
  });

  test('rejects estimates with one-time choice before closing them accepted', async () => {
    const estimate = {
      id: 'estimate-5',
      status: 'sent',
      customer_id: 'customer-5',
      show_one_time_option: true,
    };
    const { database, updates, inserts } = makeDb(estimate);

    await expect(markEstimateManuallyAccepted({
      estimateId: estimate.id,
      database,
    })).rejects.toMatchObject({
      statusCode: 400,
      message: 'Estimates with a one-time option must be accepted through the customer link so recurring vs one-time is recorded.',
    });

    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
  });

  test('rejects before marking linked leads won when customer conversion fails', async () => {
    const estimate = {
      id: 'estimate-6',
      status: 'viewed',
      customer_id: 'customer-6',
      sent_at: '2026-05-10T12:00:00.000Z',
      accepted_at: null,
      declined_at: null,
      decline_reason: null,
      monthly_total: '125.00',
      onetime_total: '99.00',
      waveguard_tier: 'Gold',
    };
    const { database, updates } = makeDb(estimate);
    const leadLinkService = { markLinkedLeadEstimateAccepted: jest.fn() };
    const estimateConverter = { convertEstimate: jest.fn().mockRejectedValue(new Error('schedule failed')) };

    await expect(markEstimateManuallyAccepted({
      estimateId: estimate.id,
      database,
      leadLinkService,
      estimateConverter,
    })).rejects.toMatchObject({
      statusCode: 500,
      message: 'Customer conversion did not complete; estimate was not marked accepted.',
    });

    expect(updates).toHaveLength(1);
    expect(updates[0].patch).toMatchObject({
      status: 'accepted',
      accepted_at: 'NOW',
    });
    expect(leadLinkService.markLinkedLeadEstimateAccepted).not.toHaveBeenCalled();
    expect(AccountMembershipEmail.sendMembershipStarted).not.toHaveBeenCalled();
  });

  test('rejects unlinked lead estimates before closing them accepted', async () => {
    const estimate = {
      id: 'estimate-7',
      status: 'viewed',
      customer_id: null,
    };
    const { database, updates, inserts } = makeDb(estimate);

    await expect(markEstimateManuallyAccepted({
      estimateId: estimate.id,
      database,
    })).rejects.toMatchObject({
      statusCode: 400,
      message: 'Manual acceptance requires the estimate to be linked to a customer first.',
    });

    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
  });

  test('locks the price at acceptance (price_locked_at/by + pricing_authority=LOCKED)', async () => {
    const estimate = {
      id: 'estimate-lock',
      status: 'viewed',
      customer_id: 'customer-9',
      sent_at: '2026-05-10T12:00:00.000Z',
      accepted_at: null,
      monthly_total: '86.00',
      waveguard_tier: 'Bronze',
      price_locked_at: null,
    };
    const { database, updates } = makeDb(estimate);
    await markEstimateManuallyAccepted({
      estimateId: estimate.id,
      adminUserId: 'admin-9',
      database,
      leadLinkService: { markLinkedLeadEstimateAccepted: jest.fn().mockResolvedValue() },
      estimateConverter: { convertEstimate: jest.fn().mockResolvedValue({ customerId: 'customer-9' }) },
    });
    expect(updates[0].patch).toMatchObject({
      status: 'accepted',
      price_locked_at: 'NOW',
      price_locked_by: 'manual_accept',
      pricing_authority: 'LOCKED',
    });
    // The status guard is what prevents a second accept from re-pricing.
    expect(updates[0].statusList).toEqual({ column: 'status', values: ['sent', 'viewed'] });
  });

  test('preserves an existing lock timestamp rather than re-stamping it', async () => {
    const estimate = {
      id: 'estimate-prelocked',
      status: 'viewed',
      customer_id: 'customer-10',
      sent_at: '2026-05-10T12:00:00.000Z',
      accepted_at: null,
      monthly_total: '86.00',
      waveguard_tier: 'Bronze',
      price_locked_at: '2026-05-12T09:00:00.000Z',
    };
    const { database, updates } = makeDb(estimate);
    await markEstimateManuallyAccepted({
      estimateId: estimate.id,
      adminUserId: 'admin-10',
      database,
      leadLinkService: { markLinkedLeadEstimateAccepted: jest.fn().mockResolvedValue() },
      estimateConverter: { convertEstimate: jest.fn().mockResolvedValue({ customerId: 'customer-10' }) },
    });
    expect(updates[0].patch.price_locked_at).toBe('2026-05-12T09:00:00.000Z');
  });
});

describe('manual annual prepay recurring row detection', () => {
  test('accepts current and nested recurring service shapes', () => {
    expect(hasManualAnnualPrepayRecurringRows({
      estimate_data: { recurring: { services: [{ service: 'pest_control' }] } },
    })).toBe(true);
    expect(hasManualAnnualPrepayRecurringRows({
      estimate_data: { result: { recurring: { services: [{ service: 'lawn_care' }] } } },
    })).toBe(true);
    expect(hasManualAnnualPrepayRecurringRows({
      estimate_data: { result: { results: { recurring: { services: [{ service: 'termite_bait' }] } } } },
    })).toBe(true);
    expect(hasManualAnnualPrepayRecurringRows({
      estimate_data: { services: [{ service: 'pest_control', frequency: 'quarterly' }] },
    })).toBe(true);
  });

  test('rejects amount-only one-time shapes', () => {
    expect(hasManualAnnualPrepayRecurringRows({
      estimate_data: { result: { onetime: { services: [{ service: 'pest_control' }] } } },
    })).toBe(false);
  });
});

describe('manual annual prepay public eligibility reuse', () => {
  test('uses the same service-mix eligibility as public acceptance', () => {
    // Every recurring mix can prepay now (pest/mosquito waive setup, others get 5%).
    expect(isManualAnnualPrepayEligibleServiceMix({
      estimate_data: { recurring: { services: [{ service: 'pest_control', name: 'Pest Control' }] } },
    })).toBe(true);
    expect(isManualAnnualPrepayEligibleServiceMix({
      estimate_data: { recurring: { services: [{ service: 'tree_shrub', name: 'Tree & Shrub Care' }] } },
    })).toBe(true);
    // One-time-only estimates (no recurring rows) remain ineligible.
    expect(isManualAnnualPrepayEligibleServiceMix({
      estimate_data: { recurring: { services: [] } },
    })).toBe(false);
  });
});

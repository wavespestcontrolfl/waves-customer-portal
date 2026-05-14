jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../services/estimate-converter', () => ({ convertEstimate: jest.fn() }));
jest.mock('../services/lead-estimate-link', () => ({ markLinkedLeadEstimateAccepted: jest.fn() }));

const {
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
    const estimateConverter = { convertEstimate: jest.fn().mockResolvedValue({ customerId: 'customer-1' }) };

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
    });
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
      message: 'Customer conversion/scheduling did not complete; estimate was not marked accepted.',
    });

    expect(updates).toHaveLength(1);
    expect(updates[0].patch).toMatchObject({
      status: 'accepted',
      accepted_at: 'NOW',
    });
    expect(leadLinkService.markLinkedLeadEstimateAccepted).not.toHaveBeenCalled();
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
});

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lead-attribution', () => ({ markConverted: jest.fn() }));

const db = require('../models/db');
const leadAttribution = require('../services/lead-attribution');
const {
  attachLeadToEstimate,
  markLinkedLeadEstimateAccepted,
  markLinkedLeadEstimateSent,
  convertLeadFromEvent,
} = require('../services/lead-estimate-link');

function makeDb(lead, estimate = null) {
  const updates = [];
  const activities = [];
  const database = (table) => ({
    where(clause) {
      return {
        first: async () => {
          if (table === 'leads' && lead && clause.id === lead.id) return lead;
          if (table === 'estimates' && estimate && clause.id === estimate.id) return estimate;
          return null;
        },
        update: async (patch) => {
          updates.push({ table, clause, patch });
          return 1;
        },
      };
    },
    insert: async (row) => {
      activities.push({ table, row });
      return [row];
    },
  });

  return { database, updates, activities };
}

describe('lead-estimate link service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('links a new lead to an estimate without recording a response before send', async () => {
    const lead = {
      id: 'lead-1',
      status: 'new',
      phone: '9415550101',
      first_contact_at: new Date(Date.now() - 12 * 60000).toISOString(),
      response_time_minutes: null,
    };
    const { database, updates, activities } = makeDb(lead);

    await attachLeadToEstimate({
      database,
      leadId: lead.id,
      estimateId: 'estimate-1',
      estimate: { id: 'estimate-1', customer_phone: '+1 (941) 555-0101' },
      technician: { first_name: 'Ava', last_name: 'Tech' },
    });

    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'leads',
        clause: { id: lead.id },
        patch: expect.objectContaining({ estimate_id: 'estimate-1' }),
      }),
    ]));
    expect(updates).toHaveLength(1);
    expect(updates[0].patch).not.toHaveProperty('status');
    expect(updates[0].patch).not.toHaveProperty('response_time_minutes');
    expect(activities.map((a) => a.row.activity_type)).toEqual(['estimate_created']);
  });

  test('rejects stale lead ids that do not match the estimate contact', async () => {
    const lead = {
      id: 'lead-1',
      status: 'new',
      phone: '9415550101',
      email: 'lead@example.com',
    };
    const { database, updates, activities } = makeDb(lead);

    await expect(attachLeadToEstimate({
      database,
      leadId: lead.id,
      estimateId: 'estimate-1',
      estimate: { id: 'estimate-1', customer_phone: '9415559999', customer_email: 'other@example.com' },
    })).rejects.toMatchObject({ statusCode: 409 });

    expect(updates).toEqual([]);
    expect(activities).toEqual([]);
  });

  test('allows replacing a stale linked estimate when the caller opts in', async () => {
    const lead = {
      id: 'lead-1',
      status: 'estimate_sent',
      phone: '9415550101',
      estimate_id: 'estimate-old',
    };
    const { database, updates, activities } = makeDb(lead);

    await attachLeadToEstimate({
      database,
      leadId: lead.id,
      estimateId: 'estimate-new',
      estimate: { id: 'estimate-new', customer_phone: '+1 (941) 555-0101' },
      technician: { first_name: 'Ava', last_name: 'Tech' },
      allowReplacingEstimateId: true,
    });

    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'leads',
        clause: { id: lead.id },
        patch: expect.objectContaining({ estimate_id: 'estimate-new' }),
      }),
    ]));
    expect(activities.map((a) => a.row.activity_type)).toEqual(['estimate_created']);
  });

  test('records first response after linked estimate is sent', async () => {
    const lead = {
      id: 'lead-1',
      status: 'new',
      first_contact_at: new Date(Date.now() - 12 * 60000).toISOString(),
      response_time_minutes: null,
    };
    const updates = [];
    const activities = [];
    db.mockImplementation((table) => ({
      where(clause) {
        if (table === 'leads' && clause.estimate_id === 'estimate-1') {
          return Promise.resolve([lead]);
        }
        return {
          update: async (patch) => {
            updates.push({ table, clause, patch });
            return 1;
          },
        };
      },
      insert: async (row) => {
        activities.push({ table, row });
        return [row];
      },
    }));

    await markLinkedLeadEstimateSent({ estimateId: 'estimate-1', sendMethod: 'sms' });

    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'leads',
        clause: { id: lead.id },
        patch: expect.objectContaining({ status: 'estimate_sent' }),
      }),
      expect.objectContaining({
        table: 'leads',
        clause: { id: lead.id },
        patch: expect.objectContaining({ response_time_minutes: expect.any(Number) }),
      }),
    ]));
    expect(activities.map((a) => a.row.activity_type)).toEqual(['first_response', 'estimate_sent']);
  });

  test('rejects unknown leads before creating activity rows', async () => {
    const { database, activities } = makeDb(null);

    await expect(attachLeadToEstimate({
      database,
      leadId: 'missing-lead',
      estimateId: 'estimate-1',
    })).rejects.toMatchObject({ statusCode: 404 });

    expect(activities).toEqual([]);
  });

  test('marks open linked leads converted when estimate is accepted', async () => {
    db.mockImplementation((table) => ({
      where: async (clause) => {
        expect(table).toBe('leads');
        expect(clause).toEqual({ estimate_id: 'estimate-1' });
        return [
          { id: 'lead-open', status: 'estimate_viewed' },
          { id: 'lead-lost', status: 'lost' },
        ];
      },
    }));

    await markLinkedLeadEstimateAccepted({
      estimateId: 'estimate-1',
      customerId: 'customer-1',
      monthlyValue: 125,
      initialServiceValue: 99,
      waveguardTier: 'Gold',
    });

    expect(leadAttribution.markConverted).toHaveBeenCalledTimes(1);
    expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-open', {
      customerId: 'customer-1',
      monthlyValue: 125,
      initialServiceValue: 99,
      waveguardTier: 'Gold',
    });
  });
});

describe('convertLeadFromEvent (funnel triggers)', () => {
  // contactQuery captures the where-builder used by findUnconvertedLeadsByContact
  // so a test can assert the customer_id IS NULL guard is applied.
  function makeConvertDb(opts = {}) {
    const calls = { whereNull: [] };
    const db = (table) => {
      if (opts.throwOnTable === table) throw new Error('db boom');
      return {
        where(clause) {
          if (table === 'estimates') return { first: async () => opts.estimate || null };
          if (table === 'customers') return { first: async () => opts.customer || null };
          if (table === 'leads' && clause && 'estimate_id' in clause) {
            return Promise.resolve(opts.leadsByEstimate || []);
          }
          return Promise.resolve([]);
        },
        whereNotIn() {
          // findUnconvertedLeadsByContact: .whereNotIn(...).whereNull('customer_id').andWhere(...)
          return {
            whereNull(col) {
              calls.whereNull.push(col);
              return { andWhere: () => Promise.resolve(opts.contactLeads || []) };
            },
          };
        },
      };
    };
    db._calls = calls;
    return db;
  }

  test('deposit_paid: accepted estimate → matches by estimate link with value hints', async () => {
    const markConverted = jest.fn().mockResolvedValue();
    const database = makeConvertDb({
      estimate: { id: 'e1', status: 'accepted', customer_id: 'c1', monthly_total: 125, onetime_total: 99, waveguard_tier: 'Gold' },
      leadsByEstimate: [{ id: 'L1', status: 'estimate_sent' }],
    });

    const result = await convertLeadFromEvent({
      source: 'deposit_paid',
      estimateId: 'e1',
      requireAcceptedEstimate: true,
      database,
      leadAttributionService: { markConverted },
    });

    expect(result).toMatchObject({ converted: true, count: 1, leadIds: ['L1'] });
    expect(markConverted).toHaveBeenCalledWith('L1', {
      customerId: 'c1',
      monthlyValue: 125,
      initialServiceValue: 99,
      waveguardTier: 'Gold',
      triggerSource: 'deposit_paid',
    });
  });

  test('deposit_paid: estimate not yet accepted → skipped, no conversion', async () => {
    const markConverted = jest.fn();
    const database = makeConvertDb({
      estimate: { id: 'e1', status: 'sent', customer_id: null },
      leadsByEstimate: [{ id: 'L1', status: 'estimate_sent' }],
    });

    const result = await convertLeadFromEvent({
      source: 'deposit_paid',
      estimateId: 'e1',
      requireAcceptedEstimate: true,
      database,
      leadAttributionService: { markConverted },
    });

    expect(result).toEqual({ converted: false, reason: 'estimate_not_accepted' });
    expect(markConverted).not.toHaveBeenCalled();
  });

  test('service_completed: matches the unconverted originating lead by contact, preserves values', async () => {
    const markConverted = jest.fn().mockResolvedValue();
    const database = makeConvertDb({
      customer: { id: 'c1', phone: '+19412269100', email: 'holly@example.com' },
      contactLeads: [{ id: 'L3', status: 'new', customer_id: null }],
    });

    const result = await convertLeadFromEvent({
      source: 'service_completed',
      customerId: 'c1',
      database,
      leadAttributionService: { markConverted },
    });

    expect(result).toMatchObject({ converted: true, leadIds: ['L3'] });
    // Only the customer + source — no revenue fields, so markConverted preserves
    // any monthly_value/waveguard_tier already on the lead.
    expect(markConverted.mock.calls[0][1]).toEqual({ customerId: 'c1', triggerSource: 'service_completed' });
    // The contact fallback must restrict to unconverted leads.
    expect(database._calls.whereNull).toContain('customer_id');
  });

  test('skips already-closed leads and reports no_open_lead', async () => {
    const markConverted = jest.fn().mockResolvedValue();
    const database = makeConvertDb({
      customer: { id: 'c1', phone: '+19412269100' },
      contactLeads: [{ id: 'Lwon', status: 'won', customer_id: null }],
    });

    const result = await convertLeadFromEvent({
      source: 'service_completed',
      customerId: 'c1',
      database,
      leadAttributionService: { markConverted },
    });

    expect(result).toEqual({ converted: false, reason: 'no_open_lead' });
    expect(markConverted).not.toHaveBeenCalled();
  });

  test('never throws — a db failure resolves to an error result', async () => {
    const markConverted = jest.fn();
    const database = makeConvertDb({ throwOnTable: 'customers' });

    const result = await convertLeadFromEvent({
      source: 'service_completed',
      customerId: 'c1',
      database,
      leadAttributionService: { markConverted },
    });

    expect(result).toEqual({ converted: false, reason: 'error' });
    expect(markConverted).not.toHaveBeenCalled();
  });
});

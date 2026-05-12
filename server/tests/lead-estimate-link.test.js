jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lead-attribution', () => ({ markConverted: jest.fn() }));

const db = require('../models/db');
const leadAttribution = require('../services/lead-attribution');
const {
  attachLeadToEstimate,
  markLinkedLeadEstimateAccepted,
} = require('../services/lead-estimate-link');

function makeDb(lead) {
  const updates = [];
  const activities = [];
  const database = (table) => ({
    where(clause) {
      return {
        first: async () => (table === 'leads' && lead && clause.id === lead.id ? lead : null),
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

  test('links a new lead to an estimate and records pipeline activities', async () => {
    const lead = {
      id: 'lead-1',
      status: 'new',
      first_contact_at: new Date(Date.now() - 12 * 60000).toISOString(),
      response_time_minutes: null,
    };
    const { database, updates, activities } = makeDb(lead);

    await attachLeadToEstimate({
      database,
      leadId: lead.id,
      estimateId: 'estimate-1',
      technician: { first_name: 'Ava', last_name: 'Tech' },
    });

    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'leads',
        clause: { id: lead.id },
        patch: expect.objectContaining({ estimate_id: 'estimate-1', status: 'contacted' }),
      }),
      expect.objectContaining({
        table: 'leads',
        clause: { id: lead.id },
        patch: expect.objectContaining({ response_time_minutes: expect.any(Number) }),
      }),
    ]));
    expect(activities.map((a) => a.row.activity_type)).toEqual(['first_response', 'estimate_created']);
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

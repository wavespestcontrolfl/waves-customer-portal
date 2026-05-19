jest.mock('../models/db', () => jest.fn());

const {
  buildEstimatePersistenceFields,
  createOrReuseAdminEstimate,
  estimateViewUrl,
} = require('../services/admin-estimate-persistence');
const {
  clearAllEstimatePricingCache,
  getEstimatePricingCache,
  setEstimatePricingCache,
} = require('../services/estimate-pricing-cache');

function makeDatabase({ lead, estimate, emptyEstimateUpdate = false }) {
  const updates = [];
  const inserts = [];
  let storedEstimate = estimate;

  const trx = (table) => ({
    where(clause) {
      return {
        forUpdate() {
          return this;
        },
        first: async () => {
          if (table === 'leads' && clause.id === lead?.id) return lead;
          if (table === 'estimates' && clause.id === storedEstimate?.id) return storedEstimate;
          return null;
        },
        update(patch) {
          updates.push({ table, clause, patch });
          if (table === 'estimates' && clause.id === storedEstimate?.id) {
            if (emptyEstimateUpdate) return { returning: async () => [] };
            storedEstimate = { ...storedEstimate, ...patch };
            return { returning: async () => [storedEstimate] };
          }
          return Promise.resolve(1);
        },
      };
    },
    insert(row) {
      inserts.push({ table, row });
      if (table === 'estimates') {
        storedEstimate = { id: 'estimate-new', status: 'draft', ...row };
        return { returning: async () => [storedEstimate] };
      }
      return Promise.resolve([row]);
    },
  });

  return {
    database: {
      transaction: async (callback) => callback(trx),
    },
    updates,
    inserts,
    getEstimate: () => storedEstimate,
  };
}

const baseBody = {
  address: '123 Palm Ave',
  customerName: 'Van Lee',
  customerPhone: '(941) 555-0101',
  customerEmail: 'van@example.com',
  leadId: 'lead-1',
  customerId: null,
  estimateData: { inputs: { address: '123 Palm Ave' }, result: { total: 125 } },
  monthlyTotal: 125,
  annualTotal: 1500,
  onetimeTotal: 0,
  waveguardTier: 'Gold',
  notes: 'Initial note',
  satelliteUrl: null,
  showOneTimeOption: false,
  billByInvoice: false,
};

describe('admin estimate persistence', () => {
  beforeEach(() => {
    clearAllEstimatePricingCache();
  });

  test('persists service_interest inferred from quoted service lines', () => {
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      serviceInterest: '',
      estimateData: {
        result: {
          recurring: {
            services: [
              { service: 'lawn_care', name: 'Lawn Care', mo: 84 },
              { service: 'pest_control', name: 'Pest Control', mo: 48.33 },
            ],
          },
        },
      },
    });

    expect(fields.service_interest).toBe('Lawn Care + Pest Control');
  });

  test('reuses an existing lead-linked draft instead of creating a second estimate', async () => {
    const now = () => new Date('2026-05-15T12:00:00.000Z');
    const { database, updates, inserts } = makeDatabase({
      lead: {
        id: 'lead-1',
        status: 'new',
        phone: '9415550101',
        estimate_id: 'estimate-draft',
      },
      estimate: {
        id: 'estimate-draft',
        status: 'draft',
        token: 'existing-token',
        customer_phone: '(941) 555-0101',
      },
    });
    setEstimatePricingCache('estimate-draft', { frequencies: [{ monthly: 99 }] });
    expect(getEstimatePricingCache('estimate-draft')).toEqual({ frequencies: [{ monthly: 99 }] });

    const result = await createOrReuseAdminEstimate({
      database,
      body: { ...baseBody, address: '456 Revised St', monthlyTotal: 145 },
      technicianId: 'tech-1',
      now,
    });

    expect(result).toMatchObject({
      reused: true,
      estimate: {
        id: 'estimate-draft',
        token: 'existing-token',
        address: '456 Revised St',
        monthly_total: 145,
      },
    });
    expect(inserts).toEqual([]);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      table: 'estimates',
      clause: { id: 'estimate-draft', status: 'draft' },
      patch: {
        address: '456 Revised St',
        monthly_total: 145,
        updated_at: now(),
      },
    });
    expect(updates[0].patch.expires_at.toISOString()).toBe('2026-05-22T12:00:00.000Z');
    expect(estimateViewUrl(result.estimate.token)).toBe('https://portal.wavespestcontrol.com/estimate/existing-token');
    expect(getEstimatePricingCache('estimate-draft')).toBeNull();
  });

  test('rejects a reused draft when the current lead contact no longer matches', async () => {
    const { database, updates, inserts } = makeDatabase({
      lead: {
        id: 'lead-1',
        status: 'new',
        phone: '9415550101',
        email: 'van@example.com',
        estimate_id: 'estimate-draft',
      },
      estimate: {
        id: 'estimate-draft',
        status: 'draft',
        token: 'existing-token',
      },
    });

    await expect(createOrReuseAdminEstimate({
      database,
      body: {
        ...baseBody,
        customerPhone: '941-555-9999',
        customerEmail: 'other@example.com',
      },
      technicianId: 'tech-1',
      now: () => new Date('2026-05-15T12:00:00.000Z'),
    })).rejects.toMatchObject({ statusCode: 409 });

    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
  });

  test('rejects a one-time choice on a mixed recurring-service estimate', async () => {
    const { database, updates, inserts } = makeDatabase({
      lead: {
        id: 'lead-1',
        status: 'new',
        phone: '9415550101',
        estimate_id: null,
      },
    });

    await expect(createOrReuseAdminEstimate({
      database,
      body: {
        ...baseBody,
        showOneTimeOption: true,
        onetimeTotal: 250,
        estimateData: {
          result: {
            recurring: {
              services: [
                { name: 'Pest Control', mo: 89 },
                { name: 'Lawn Care', mo: 80 },
              ],
            },
          },
        },
      },
      technicianId: 'tech-1',
      now: () => new Date('2026-05-15T12:00:00.000Z'),
    })).rejects.toMatchObject({ statusCode: 400 });

    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
  });

  test('does not overwrite a draft that changed status during reuse', async () => {
    const { database, updates } = makeDatabase({
      emptyEstimateUpdate: true,
      lead: {
        id: 'lead-1',
        status: 'new',
        phone: '9415550101',
        estimate_id: 'estimate-draft',
      },
      estimate: {
        id: 'estimate-draft',
        status: 'draft',
        token: 'existing-token',
        customer_phone: '(941) 555-0101',
      },
    });

    await expect(createOrReuseAdminEstimate({
      database,
      body: baseBody,
      technicianId: 'tech-1',
      now: () => new Date('2026-05-15T12:00:00.000Z'),
    })).rejects.toMatchObject({ statusCode: 409 });

    expect(updates).toHaveLength(1);
    expect(updates[0].clause).toEqual({ id: 'estimate-draft', status: 'draft' });
  });
});

jest.mock('../models/db', () => jest.fn());

const {
  estimateReviseBlock,
  reviseAdminEstimate,
} = require('../services/admin-estimate-persistence');
const { clearAllEstimatePricingCache } = require('../services/estimate-pricing-cache');

// Force the CLIENT_FALLBACK pricing path so tests exercise the revise
// plumbing (guards, preserved columns, atomic update) without needing a
// syncable pricing engine or a real customer-services lookup.
const noRecompute = async () => ({ recomputed: false, reason: 'NO_INPUTS' });

function makeReviseDatabase({ estimate, updateReturnsEmpty = false }) {
  const updates = [];
  const database = (table) => {
    if (table !== 'estimates') {
      // Any side lookup (prior qualifying services, pricing sync) is
      // best-effort in the pipeline — throwing here proves the fallback path.
      throw new Error(`unexpected table ${table}`);
    }
    const chain = {
      where: () => chain,
      whereNull: () => chain,
      whereNotIn: () => chain,
      first: async () => estimate,
      update: (patch) => {
        updates.push(patch);
        return {
          returning: async () => (updateReturnsEmpty ? [] : [{ ...estimate, ...patch }]),
        };
      },
    };
    return chain;
  };
  return { database, updates };
}

const sentEstimate = {
  id: 'est-1',
  token: 'tok-abc123',
  status: 'sent',
  customer_id: 'cust-9',
  customer_name: 'Beverly Carter',
  customer_phone: '(941) 555-0102',
  customer_email: 'beverly@example.com',
  address: '456 Gulf Dr',
  satellite_url: 'https://maps.example.com/sat.png',
  price_locked_at: null,
  archived_at: null,
  sent_at: '2026-07-09T14:00:00Z',
  expires_at: '2026-07-16T14:00:00Z',
  created_by_technician_id: 'tech-1',
  estimate_data: JSON.stringify({
    inputs: { address: '456 Gulf Dr', svcPest: true },
    result: { recurring: { grandTotal: 48, services: [{ service: 'pest_control', name: 'Pest Control', mo: 48 }] } },
    engineRequest: { profile: { homeSqFt: 1800 }, selectedServices: ['PEST'], options: {} },
    sendSnapshot: { renderedAt: '2026-07-09T14:00:00Z', pricingBundle: { stale: true } },
    preferences: { interiorService: false },
  }),
};

const reviseBody = {
  address: '456 Gulf Dr',
  customerName: 'Beverly Carter',
  customerPhone: '(941) 555-0102',
  customerEmail: 'beverly@example.com',
  customerId: null,
  estimateData: {
    inputs: { address: '456 Gulf Dr', svcPest: true, svcLawn: true },
    result: {
      recurring: {
        grandTotal: 132,
        services: [
          { service: 'pest_control', name: 'Pest Control', mo: 48 },
          { service: 'lawn_care', name: 'Lawn Care', mo: 84 },
        ],
      },
    },
    engineRequest: { profile: { homeSqFt: 1800 }, selectedServices: ['PEST', 'LAWN'], options: {} },
  },
  monthlyTotal: 132,
  annualTotal: 1584,
  onetimeTotal: 0,
  waveguardTier: 'Silver',
  notes: 'Added lawn care per customer request',
  satelliteUrl: null,
  showOneTimeOption: false,
  billByInvoice: false,
};

describe('estimateReviseBlock', () => {
  test.each(['draft', 'scheduled', 'sent', 'viewed', 'send_failed'])(
    'status %s is editable',
    (status) => {
      expect(estimateReviseBlock({ status, price_locked_at: null, archived_at: null })).toBeNull();
    },
  );

  test.each([
    ['accepted', 409],
    ['declined', 409],
    ['expired', 409],
    ['sending', 409],
  ])('status %s blocks with %s', (status, statusCode) => {
    const block = estimateReviseBlock({ status, price_locked_at: null, archived_at: null });
    expect(block).not.toBeNull();
    expect(block.statusCode).toBe(statusCode);
  });

  test('price lock blocks even on an otherwise-editable status', () => {
    const block = estimateReviseBlock({ status: 'sent', price_locked_at: '2026-07-09T15:00:00Z', archived_at: null });
    expect(block.statusCode).toBe(409);
    expect(block.message).toMatch(/price-locked/);
  });

  test('archived rows block with 400', () => {
    const block = estimateReviseBlock({ status: 'sent', price_locked_at: null, archived_at: '2026-07-09T15:00:00Z' });
    expect(block.statusCode).toBe(400);
    expect(block.message).toMatch(/archived/i);
  });

  test('commercial proposals route to the proposal editor', () => {
    const block = estimateReviseBlock(
      { status: 'sent', price_locked_at: null, archived_at: null },
      { proposal: { enabled: true } },
    );
    expect(block.statusCode).toBe(400);
    expect(block.message).toMatch(/commercial proposal/i);
  });

  test('parses stringified estimate_data when no parsed blob is supplied', () => {
    const block = estimateReviseBlock({
      status: 'sent',
      price_locked_at: null,
      archived_at: null,
      estimate_data: JSON.stringify({ proposal: { enabled: true } }),
    });
    expect(block).not.toBeNull();
    expect(block.message).toMatch(/commercial proposal/i);
  });
});

describe('reviseAdminEstimate', () => {
  beforeEach(() => {
    clearAllEstimatePricingCache();
  });

  test('revises a sent estimate in place without touching identity/lifecycle columns', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: sentEstimate });
    const { estimate } = await reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: reviseBody,
      technicianId: 'tech-2',
      recompute: noRecompute,
    });

    expect(updates).toHaveLength(1);
    const patch = updates[0];
    // Identity + lifecycle stay owned by the row.
    expect(patch).not.toHaveProperty('token');
    expect(patch).not.toHaveProperty('status');
    expect(patch).not.toHaveProperty('expires_at');
    expect(patch).not.toHaveProperty('created_by_technician_id');
    // Quote content is replaced.
    expect(patch.monthly_total).toBe(132);
    expect(patch.annual_total).toBe(1584);
    const data = JSON.parse(patch.estimate_data);
    expect(data.inputs.svcLawn).toBe(true);
    expect(data.result.recurring.services).toHaveLength(2);
    // The stale send snapshot + customer preferences described the previous
    // quote and must not survive the revise.
    expect(data.sendSnapshot).toBeUndefined();
    expect(data.preferences).toBeUndefined();
    expect(estimate.id).toBe('est-1');
    expect(estimate.token).toBe('tok-abc123');
    expect(estimate.status).toBe('sent');
  });

  test('preserves existing customer linkage and satellite snapshot when the body omits them', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: sentEstimate });
    await reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: { ...reviseBody, customerId: null, satelliteUrl: null },
      recompute: noRecompute,
    });
    expect(updates[0].customer_id).toBe('cust-9');
    expect(updates[0].satellite_url).toBe('https://maps.example.com/sat.png');
  });

  test('404s when the estimate does not exist', async () => {
    const { database } = makeReviseDatabase({ estimate: null });
    await expect(reviseAdminEstimate({
      database,
      estimateId: 'missing',
      body: reviseBody,
      recompute: noRecompute,
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  test('409s on an accepted estimate without writing', async () => {
    const { database, updates } = makeReviseDatabase({
      estimate: { ...sentEstimate, status: 'accepted', price_locked_at: '2026-07-09T15:00:00Z' },
    });
    await expect(reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: reviseBody,
      recompute: noRecompute,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(updates).toHaveLength(0);
  });

  test('400s on an archived estimate without writing', async () => {
    const { database, updates } = makeReviseDatabase({
      estimate: { ...sentEstimate, archived_at: '2026-07-09T15:00:00Z' },
    });
    await expect(reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: reviseBody,
      recompute: noRecompute,
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(updates).toHaveLength(0);
  });

  test('400s on a commercial proposal without writing', async () => {
    const { database, updates } = makeReviseDatabase({
      estimate: {
        ...sentEstimate,
        estimate_data: JSON.stringify({ proposal: { enabled: true, buildings: [] } }),
      },
    });
    await expect(reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: reviseBody,
      recompute: noRecompute,
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(updates).toHaveLength(0);
  });

  test('409s when the guarded update loses to a concurrent lock', async () => {
    const { database } = makeReviseDatabase({ estimate: sentEstimate, updateReturnsEmpty: true });
    await expect(reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: reviseBody,
      recompute: noRecompute,
    })).rejects.toMatchObject({ statusCode: 409 });
  });
});

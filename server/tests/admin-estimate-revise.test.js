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

// Pin the clock inside the fixture's validity window (sent 07-09, expires
// 07-16) — the expiry guard compares against `now`, so real-clock tests would
// start failing the day the fixture's expires_at passes.
const fixedNow = () => new Date('2026-07-10T12:00:00Z');

// Default linked-customer row matches the sentEstimate fixture's contact, so
// contact-preserving revises pass the customer revalidation guard untouched.
const matchingCustomer = {
  id: 'cust-9',
  phone: '9415550102',
  email: 'beverly@example.com',
};

function makeReviseDatabase({
  estimate,
  lead = null,
  customer = matchingCustomer,
  updateReturnsEmpty = false,
}) {
  const updates = [];
  const rawGuards = [];
  const groupedWheres = [];
  const database = (table) => {
    if (table === 'customers') {
      let clause = null;
      const customerChain = {
        where: (c) => {
          clause = c;
          return customerChain;
        },
        first: async () => {
          if (!customer) return null;
          return String(customer.id) === String(clause?.id) ? customer : null;
        },
      };
      return customerChain;
    }
    if (table === 'leads') {
      // FK lookup passes { estimate_id }; the mirror lookup passes { id }.
      let clause = null;
      const leadChain = {
        where: (c) => {
          clause = c;
          return leadChain;
        },
        whereNull: () => leadChain,
        first: async () => {
          if (!lead) return null;
          if (clause?.estimate_id !== undefined) {
            return String(lead.estimate_id || '') === String(clause.estimate_id) ? lead : null;
          }
          if (clause?.id !== undefined) {
            return String(lead.id) === String(clause.id) ? lead : null;
          }
          return null;
        },
      };
      return leadChain;
    }
    if (table !== 'estimates') {
      // Any side lookup (prior qualifying services, pricing sync) is
      // best-effort in the pipeline — throwing here proves the fallback path.
      throw new Error(`unexpected table ${table}`);
    }
    const chain = {
      // The expiry mirror is a grouped where (whereNull OR >) — record the
      // callback so tests can replay it against a recorder and assert the
      // predicate without a real query builder.
      where: (clause) => {
        if (typeof clause === 'function') groupedWheres.push(clause);
        return chain;
      },
      whereNull: () => chain,
      whereNotIn: () => chain,
      whereRaw: (sql) => {
        rawGuards.push(sql);
        return chain;
      },
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
  return { database, updates, rawGuards, groupedWheres };
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

  test('date-expired rows block with 409 even before the worker flips status', () => {
    const block = estimateReviseBlock(
      { status: 'sent', price_locked_at: null, archived_at: null, expires_at: '2026-07-09T14:00:00Z' },
      undefined,
      new Date('2026-07-10T12:00:00Z'),
    );
    expect(block).not.toBeNull();
    expect(block.statusCode).toBe(409);
    expect(block.message).toMatch(/expiration/i);
  });

  test('a future expiry stays editable', () => {
    expect(estimateReviseBlock(
      { status: 'sent', price_locked_at: null, archived_at: null, expires_at: '2026-07-16T14:00:00Z' },
      undefined,
      new Date('2026-07-10T12:00:00Z'),
    )).toBeNull();
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
      now: fixedNow,
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
      now: fixedNow,
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
      now: fixedNow,
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
      now: fixedNow,
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
      now: fixedNow,
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
      now: fixedNow,
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
      now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  test('400s when the revise body carries no estimateData', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: sentEstimate });
    await expect(reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: { ...reviseBody, estimateData: null },
      recompute: noRecompute,
      now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(updates).toHaveLength(0);
  });

  test('carries the lead_id mirror and schedule-stitch pointer across the rewrite', async () => {
    const withLinkage = {
      ...sentEstimate,
      estimate_data: JSON.stringify({
        ...JSON.parse(sentEstimate.estimate_data),
        lead_id: 'lead-7',
        scheduled_service_id: 'svc-3',
      }),
    };
    // The mirror lead's contact matches (same phone), so a same-contact revise
    // must succeed AND keep both linkage keys.
    const { database, updates } = makeReviseDatabase({
      estimate: withLinkage,
      lead: { id: 'lead-7', estimate_id: null, phone: '9415550102', email: null, customer_id: null },
    });
    await reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: reviseBody,
      recompute: noRecompute,
      now: fixedNow,
    });
    const data = JSON.parse(updates[0].estimate_data);
    expect(data.lead_id).toBe('lead-7');
    expect(data.scheduled_service_id).toBe('svc-3');
    // Still a full rewrite otherwise — stale snapshot stays dropped.
    expect(data.sendSnapshot).toBeUndefined();
  });

  test('guards the atomic update against a concurrent commercial-proposal conversion', async () => {
    const { database, rawGuards } = makeReviseDatabase({ estimate: sentEstimate });
    await reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: reviseBody,
      recompute: noRecompute,
      now: fixedNow,
    });
    expect(rawGuards.some((sql) => String(sql).includes("'COMMERCIAL'"))).toBe(true);
  });

  test('mirrors the date-expiry verdict inside the guarded update', async () => {
    const { database, groupedWheres } = makeReviseDatabase({ estimate: sentEstimate });
    await reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: reviseBody,
      recompute: noRecompute,
      now: fixedNow,
    });
    // Replay the grouped where against a recorder: it must scope the commit
    // to (expires_at IS NULL OR expires_at > now).
    const recorded = [];
    const recorder = {
      whereNull: (...args) => { recorded.push(['whereNull', ...args]); return recorder; },
      orWhere: (...args) => { recorded.push(['orWhere', ...args]); return recorder; },
    };
    expect(groupedWheres).toHaveLength(1);
    groupedWheres[0](recorder);
    expect(recorded).toEqual([
      ['whereNull', 'expires_at'],
      ['orWhere', 'expires_at', '>', fixedNow()],
    ]);
  });

  test('clears the satellite snapshot when the revise changes the address', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: sentEstimate });
    await reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: { ...reviseBody, address: '789 Bay St' },
      recompute: noRecompute,
      now: fixedNow,
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].satellite_url).toBeNull();
  });

  test('keeps the satellite snapshot across a pure address reformat', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: sentEstimate });
    await reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: { ...reviseBody, address: '  456  GULF dr ' },
      recompute: noRecompute,
      now: fixedNow,
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].satellite_url).toBe('https://maps.example.com/sat.png');
  });

  test('409s when the revise moves the contact away from an FK-linked lead', async () => {
    const { database, updates } = makeReviseDatabase({
      estimate: sentEstimate,
      lead: { id: 'lead-7', estimate_id: 'est-1', phone: '9415550102', email: 'beverly@example.com', customer_id: null },
    });
    await expect(reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: {
        ...reviseBody,
        customerName: 'Someone Else',
        customerPhone: '9415559999',
        customerEmail: 'someone.else@example.com',
      },
      recompute: noRecompute,
      now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(updates).toHaveLength(0);
  });

  test('allows a contact reformat that still matches the linked lead', async () => {
    const { database, updates } = makeReviseDatabase({
      estimate: sentEstimate,
      lead: { id: 'lead-7', estimate_id: 'est-1', phone: '(941) 555-0102', email: null, customer_id: null },
    });
    await reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      // Raw string differs from the row (digits vs formatted) but normalizes
      // to the same phone — must not 409.
      body: { ...reviseBody, customerPhone: '941-555-0102' },
      recompute: noRecompute,
      now: fixedNow,
    });
    expect(updates).toHaveLength(1);
  });

  test('409s a date-expired row the worker has not flipped yet, without writing', async () => {
    const { database, updates } = makeReviseDatabase({
      estimate: { ...sentEstimate, expires_at: '2026-07-01T14:00:00Z' },
    });
    await expect(reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: reviseBody,
      recompute: noRecompute,
      now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(updates).toHaveLength(0);
  });

  test('409s when the revise moves the contact away from the linked customer', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: sentEstimate });
    await expect(reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      // customer_id 'cust-9' is preserved by the revise, but neither the new
      // phone nor the new email matches that customer's contact.
      body: {
        ...reviseBody,
        customerName: 'Someone Else',
        customerPhone: '9415559999',
        customerEmail: 'someone.else@example.com',
      },
      recompute: noRecompute,
      now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(updates).toHaveLength(0);
  });

  test('allows a contact change that still matches the linked customer on one channel', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: sentEstimate });
    await reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      // Phone moves to a new number, but the email still matches cust-9 —
      // same one-channel match rule as the lead guard.
      body: { ...reviseBody, customerPhone: '9415559999' },
      recompute: noRecompute,
      now: fixedNow,
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].customer_id).toBe('cust-9');
  });

  test('409s when the preserved customer link points at a missing customer row', async () => {
    const { database, updates } = makeReviseDatabase({ estimate: sentEstimate, customer: null });
    await expect(reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: { ...reviseBody, customerPhone: '9415559999', customerEmail: 'other@example.com' },
      recompute: noRecompute,
      now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(updates).toHaveLength(0);
  });

  test('blocks a mirror-linked (no-FK) lead the same way', async () => {
    const withMirror = {
      ...sentEstimate,
      customer_id: null,
      estimate_data: JSON.stringify({
        ...JSON.parse(sentEstimate.estimate_data),
        lead_id: 'lead-9',
      }),
    };
    const { database, updates } = makeReviseDatabase({
      estimate: withMirror,
      lead: { id: 'lead-9', estimate_id: null, phone: '9415550102', email: null, customer_id: null },
    });
    await expect(reviseAdminEstimate({
      database,
      estimateId: 'est-1',
      body: {
        ...reviseBody,
        customerId: null,
        customerPhone: '9415559999',
        customerEmail: 'other@example.com',
      },
      recompute: noRecompute,
      now: fixedNow,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(updates).toHaveLength(0);
  });
});

const {
  buildEstimateServiceRevisionDraft,
  createEstimateAddServiceRequest,
  normalizeRequestedServiceKey,
} = require('../services/estimate-add-service-request');

function phoneLast10(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function matches(row, filters, notInFilters, rawFilters) {
  return filters.every((filter) => Object.entries(filter).every(([key, value]) => row[key] === value))
    && notInFilters.every((filter) => !filter.values.includes(row[filter.column]))
    && rawFilters.every((filter) => filter(row));
}

function makeDb(tables) {
  let nextId = 1;
  function database(table) {
    const rows = tables[table] || (tables[table] = []);
    const filters = [];
    const notInFilters = [];
    const rawFilters = [];
    const query = {
      forUpdate() {
        return query;
      },
      where(criteria) {
        filters.push(criteria || {});
        return query;
      },
      whereRaw(sql, params = []) {
        if (/LOWER\(email\)/i.test(sql) && params[0]) {
          const email = params[0];
          rawFilters.push((row) => String(row.email || '').trim().toLowerCase() === email);
        } else if (/REGEXP_REPLACE\(COALESCE\(phone/i.test(sql) && params[0]) {
          const last10 = params[0];
          rawFilters.push((row) => phoneLast10(row.phone) === last10);
        }
        return query;
      },
      whereNull(column) {
        rawFilters.push((row) => row[column] == null);
        return query;
      },
      whereNotIn(column, values) {
        notInFilters.push({ column, values });
        return query;
      },
      select() {
        return Promise.resolve(rows.filter((row) => matches(row, filters, notInFilters, rawFilters)));
      },
      first() {
        return Promise.resolve(rows.find((row) => matches(row, filters, notInFilters, rawFilters)) || null);
      },
      update(updates) {
        let count = 0;
        rows.forEach((row) => {
          if (matches(row, filters, notInFilters, rawFilters)) {
            Object.assign(row, updates);
            count += 1;
          }
        });
        return Promise.resolve(count);
      },
      insert(payload) {
        let ignoreConflicts = false;
        const insertResult = {
          onConflict() {
            return {
              ignore() {
                ignoreConflicts = true;
                return insertResult;
              },
            };
          },
          returning() {
            if (ignoreConflicts && tables.__insertConflicts?.[table]) {
              return Promise.resolve([]);
            }
            const insertError = tables.__insertErrors?.[table];
            if (insertError) return Promise.reject(insertError);
            const row = {
              id: payload.id || `${table}-${nextId++}`,
              ...payload,
              created_at: payload.created_at || new Date('2026-06-06T12:00:00Z').toISOString(),
            };
            rows.push(row);
            return Promise.resolve([row]);
          },
          catch(handler) {
            return insertResult.returning().catch(handler);
          },
        };
        return insertResult;
      },
    };
    return query;
  }
  database.transaction = async (handler) => handler(database);
  return database;
}

function baseEstimate(overrides = {}) {
  return {
    id: 'estimate-1',
    token: 'public-token',
    customer_id: 'customer-1',
    customer_name: 'Taylor Morgan',
    customer_phone: '+15555550101',
    customer_email: 'taylor@example.com',
    status: 'sent',
    address: '123 Main St',
    monthly_total: 50,
    annual_total: 600,
    onetime_total: 0,
    waveguard_tier: 'Bronze',
    estimate_data: {
      inputs: {
        homeSqFt: 2000,
        stories: 1,
        lotSqFt: 10000,
        propertyType: 'single_family',
        zone: 'A',
        features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
        paymentMethod: 'card',
        services: {
          pest: { frequency: 'quarterly', version: 'v1', roachType: 'none' },
        },
      },
    },
    ...overrides,
  };
}

describe('estimate add-service request workflow', () => {
  test('normalizes customer-facing service names', () => {
    expect(normalizeRequestedServiceKey('Add Lawn Care and save more')).toBe('lawn_care');
    expect(normalizeRequestedServiceKey('Pest Control')).toBe('pest_control');
    expect(normalizeRequestedServiceKey('WaveGuard Mosquito')).toBe('mosquito');
    expect(normalizeRequestedServiceKey('pool cleaning')).toBeNull();
  });

  test('builds a draft revision without mutating the live estimate', () => {
    const estimate = baseEstimate();
    const originalMonthly = estimate.monthly_total;
    const revision = buildEstimateServiceRevisionDraft(estimate, 'lawn_care');

    expect(revision.status).toBe('priced');
    expect(revision.serviceKey).toBe('lawn_care');
    expect(revision.updated.monthly).toBeGreaterThan(0);
    expect(revision.draftEstimateData.inputs.services.lawn).toEqual(expect.objectContaining({
      track: 'st_augustine',
      tier: 'enhanced',
    }));
    expect(estimate.monthly_total).toBe(originalMonthly);
    expect(estimate.estimate_data.inputs.services.lawn).toBeUndefined();
  });

  test('creates a durable service request, timeline event, notification, SMS, and email', async () => {
    const estimate = baseEstimate();
    const tables = {
      estimates: [estimate],
      customers: [{
        id: 'customer-1',
        first_name: 'Taylor',
        last_name: 'Morgan',
        phone: '+15555550101',
        email: 'taylor@example.com',
      }],
      service_requests: [],
      customer_interactions: [],
      activity_log: [],
      property_preferences: [],
      notification_prefs: [],
    };
    const notificationTrigger = jest.fn(async () => ({ bellWritten: true }));
    const sendMessage = jest.fn(async () => ({ sent: true }));
    const sendRequestReceived = jest.fn(() => Promise.resolve({ ok: true }));

    const result = await createEstimateAddServiceRequest({
      estimateToken: 'public-token',
      requestedService: 'lawn_care',
      database: makeDb(tables),
      notificationTrigger,
      sendMessage,
      accountMembershipEmail: { sendRequestReceived },
    });

    expect(result.success).toBe(true);
    expect(result.deduped).toBe(false);
    expect(result.request).toEqual(expect.objectContaining({
      estimateId: 'estimate-1',
      customerId: 'customer-1',
      requestedService: 'lawn_care',
      source: 'public_estimate',
      status: 'new',
    }));
    expect(result.request.pricingRevision).toEqual(expect.objectContaining({
      status: 'priced',
      serviceKey: 'lawn_care',
    }));
    expect(result.request.pricingRevision.draftEstimateData).toBeUndefined();
    expect(result.request.pricingRevision.error).toBeUndefined();
    expect(result.revision).toEqual(expect.objectContaining({
      status: 'priced',
      serviceKey: 'lawn_care',
    }));
    expect(result.revision.draftEstimateData).toBeUndefined();
    expect(tables.service_requests).toHaveLength(1);
    expect(tables.service_requests[0]).toEqual(expect.objectContaining({
      estimate_id: 'estimate-1',
      customer_id: 'customer-1',
      requested_service: 'lawn_care',
      source: 'public_estimate',
      category: 'add_service',
      status: 'new',
    }));
    expect(JSON.parse(tables.service_requests[0].pricing_revision)).toEqual(expect.objectContaining({
      status: 'priced',
      serviceKey: 'lawn_care',
    }));
    expect(estimate.monthly_total).toBe(50);
    expect(estimate.estimate_data.inputs.services.lawn).toBeUndefined();
    expect(tables.customer_interactions).toHaveLength(1);
    expect(tables.activity_log).toHaveLength(1);
    expect(notificationTrigger).toHaveBeenCalledWith(
      'bundle_quote_requested',
      expect.objectContaining({
        estimateId: 'estimate-1',
        customerId: 'customer-1',
        requestId: tables.service_requests[0].id,
        customerName: 'Taylor Morgan',
        suggestedService: 'Lawn Care',
        bundled: false,
        previousTier: 'Bronze',
        previousMonthly: 50,
        requestedService: 'lawn_care',
        source: 'public_estimate',
        pricingRevisionStatus: 'priced',
      })
    );
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: '+15555550101',
      body: 'Hi Taylor, we received your request to add lawn care to your Waves estimate. Our team will review the property details and send the updated option shortly.',
      customerId: 'customer-1',
      estimateId: 'estimate-1',
      metadata: expect.objectContaining({
        service_request_id: tables.service_requests[0].id,
        requested_service: 'lawn_care',
      }),
    }));
    expect(sendRequestReceived).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'customer-1',
      request: tables.service_requests[0],
      responseTime: 'shortly',
      idempotencyKey: `estimate.add_service_request.email:${tables.service_requests[0].id}`,
    }));
  });

  test('dedupes duplicate open requests without resending side effects', async () => {
    const estimate = baseEstimate();
    const existingRequest = {
      id: 'request-1',
      customer_id: 'customer-1',
      estimate_id: 'estimate-1',
      requested_service: 'lawn_care',
      source: 'public_estimate',
      category: 'add_service',
      subject: 'Add Lawn Care to estimate #estimate-1',
      status: 'new',
      pricing_revision: JSON.stringify({
        status: 'not_priced',
        serviceKey: 'lawn_care',
        error: 'pricing stack details',
        draftEstimateData: { internal: true },
      }),
      created_at: '2026-06-06T12:00:00Z',
    };
    const tables = {
      estimates: [estimate],
      customers: [{ id: 'customer-1', first_name: 'Taylor', last_name: 'Morgan', phone: '+15555550101' }],
      service_requests: [existingRequest],
      customer_interactions: [],
      activity_log: [],
    };
    const notifyAdmin = jest.fn();
    const sendMessage = jest.fn();
    const sendRequestReceived = jest.fn();

    const result = await createEstimateAddServiceRequest({
      estimateToken: 'public-token',
      requestedService: 'lawn_care',
      database: makeDb(tables),
      notificationService: { notifyAdmin },
      sendMessage,
      accountMembershipEmail: { sendRequestReceived },
    });

    expect(result.deduped).toBe(true);
    expect(result.request.id).toBe('request-1');
    expect(result.request.pricingRevision).toEqual(expect.objectContaining({
      status: 'not_priced',
      serviceKey: 'lawn_care',
    }));
    expect(result.request.pricingRevision.error).toBeUndefined();
    expect(result.request.pricingRevision.draftEstimateData).toBeUndefined();
    expect(tables.service_requests).toHaveLength(1);
    expect(tables.customer_interactions).toHaveLength(0);
    expect(tables.activity_log).toHaveLength(0);
    expect(notifyAdmin).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendRequestReceived).not.toHaveBeenCalled();
  });

  test('dedupes unlinked estimates before creating a customer', async () => {
    const estimate = baseEstimate({ customer_id: null });
    const existingRequest = {
      id: 'request-1',
      customer_id: 'customer-1',
      estimate_id: 'estimate-1',
      requested_service: 'lawn_care',
      source: 'public_estimate',
      category: 'add_service',
      subject: 'Add Lawn Care to estimate #estimate-1',
      status: 'new',
      pricing_revision: JSON.stringify({ status: 'priced', serviceKey: 'lawn_care' }),
      created_at: '2026-06-06T12:00:00Z',
    };
    const tables = {
      estimates: [estimate],
      customers: [],
      service_requests: [existingRequest],
      customer_interactions: [],
      activity_log: [],
    };

    const result = await createEstimateAddServiceRequest({
      estimateToken: 'public-token',
      requestedService: 'lawn_care',
      database: makeDb(tables),
      notificationTrigger: jest.fn(async () => ({ bellWritten: true })),
      sendMessage: jest.fn(),
      accountMembershipEmail: { sendRequestReceived: jest.fn() },
    });

    expect(result.deduped).toBe(true);
    expect(tables.customers).toHaveLength(0);
    expect(estimate.customer_id).toBeNull();
    expect(tables.service_requests).toHaveLength(1);
  });

  test('creates request-only customers as inactive leads without billing fields', async () => {
    const estimate = baseEstimate({ customer_id: null });
    const tables = {
      estimates: [estimate],
      customers: [],
      service_requests: [],
      customer_interactions: [],
      activity_log: [],
      property_preferences: [],
      notification_prefs: [],
    };
    const sendRequestReceived = jest.fn(() => Promise.resolve({ ok: true }));

    const result = await createEstimateAddServiceRequest({
      estimateToken: 'public-token',
      requestedService: 'lawn_care',
      database: makeDb(tables),
      notificationTrigger: jest.fn(async () => ({ bellWritten: true })),
      sendMessage: jest.fn(async () => ({ sent: true })),
      accountMembershipEmail: { sendRequestReceived },
    });

    expect(result.deduped).toBe(false);
    expect(tables.customers).toHaveLength(1);
    expect(tables.customers[0]).toEqual(expect.objectContaining({
      active: false,
      waveguard_tier: null,
      monthly_rate: null,
      member_since: null,
      stage: 'new_lead',
      pipeline_stage: 'new_lead',
      lead_source: 'public_estimate',
      lead_source_detail: 'estimate_add_service_request',
      lead_source_channel: 'public_estimate',
    }));
    expect(estimate.customer_id).toBe(tables.customers[0].id);
    expect(tables.service_requests[0].customer_id).toBe(tables.customers[0].id);
    expect(sendRequestReceived).not.toHaveBeenCalled();
  });

  test('stores new estimate lead addresses as clamped street lines', async () => {
    const longStreet = `987 ${'Long Street Name '.repeat(20)}`;
    const estimate = baseEstimate({
      customer_id: null,
      address: `${longStreet}, Sarasota, FL 34236`,
    });
    const tables = {
      estimates: [estimate],
      customers: [],
      service_requests: [],
      customer_interactions: [],
      activity_log: [],
      property_preferences: [],
      notification_prefs: [],
    };

    await createEstimateAddServiceRequest({
      estimateToken: 'public-token',
      requestedService: 'lawn_care',
      database: makeDb(tables),
      notificationTrigger: jest.fn(async () => ({ bellWritten: true })),
      sendMessage: jest.fn(async () => ({ sent: true })),
      accountMembershipEmail: { sendRequestReceived: jest.fn(() => Promise.resolve({ ok: true })) },
    });

    expect(tables.customers[0].address_line1).toBe(longStreet.slice(0, 200));
    expect(tables.customers[0].address_line1).toHaveLength(200);
    expect(tables.customers[0].address_line1).not.toContain(',');
  });

  test('links unlinked estimates only to a unique non-deleted phone and address match', async () => {
    const estimate = baseEstimate({
      customer_id: null,
      customer_phone: '+15555550101',
      address: '123 Main St, Sarasota, FL 34236',
    });
    const tables = {
      estimates: [estimate],
      customers: [{
        id: 'customer-1',
        first_name: 'Taylor',
        last_name: 'Morgan',
        phone: '(555) 555-0101',
        email: 'taylor@example.com',
        address_line1: '123 Main St',
        deleted_at: null,
      }],
      service_requests: [],
      customer_interactions: [],
      activity_log: [],
      property_preferences: [],
      notification_prefs: [],
    };

    const result = await createEstimateAddServiceRequest({
      estimateToken: 'public-token',
      requestedService: 'lawn_care',
      database: makeDb(tables),
      notificationTrigger: jest.fn(async () => ({ bellWritten: true })),
      sendMessage: jest.fn(async () => ({ sent: true })),
      accountMembershipEmail: { sendRequestReceived: jest.fn(() => Promise.resolve({ ok: true })) },
    });

    expect(result.deduped).toBe(false);
    expect(tables.customers).toHaveLength(1);
    expect(estimate.customer_id).toBe('customer-1');
    expect(tables.service_requests[0].customer_id).toBe('customer-1');
  });

  test('skips SMS when an email-matched customer has a different phone', async () => {
    const estimate = baseEstimate({
      customer_id: null,
      customer_phone: '+15555550999',
      customer_email: 'taylor@example.com',
      address: '123 Main St, Sarasota, FL 34236',
    });
    const tables = {
      estimates: [estimate],
      customers: [{
        id: 'customer-1',
        first_name: 'Taylor',
        last_name: 'Morgan',
        phone: '+15555550101',
        email: 'taylor@example.com',
        address_line1: '123 Main St',
        active: true,
        deleted_at: null,
      }],
      service_requests: [],
      customer_interactions: [],
      activity_log: [],
      property_preferences: [],
      notification_prefs: [],
    };
    const sendMessage = jest.fn(async () => ({ sent: true }));
    const sendRequestReceived = jest.fn(() => Promise.resolve({ ok: true }));

    const result = await createEstimateAddServiceRequest({
      estimateToken: 'public-token',
      requestedService: 'lawn_care',
      database: makeDb(tables),
      notificationTrigger: jest.fn(async () => ({ bellWritten: true })),
      sendMessage,
      accountMembershipEmail: { sendRequestReceived },
    });

    expect(result.deduped).toBe(false);
    expect(estimate.customer_id).toBe('customer-1');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendRequestReceived).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'customer-1',
    }));
  });

  test('creates a new inactive lead when existing contact matches are ambiguous', async () => {
    const estimate = baseEstimate({
      customer_id: null,
      customer_phone: '+15555550101',
      customer_email: 'shared@example.com',
      address: '789 New Property Rd, Sarasota, FL 34236',
    });
    const tables = {
      estimates: [estimate],
      customers: [
        {
          id: 'customer-1',
          first_name: 'Taylor',
          last_name: 'Morgan',
          phone: '+15555550101',
          email: 'shared@example.com',
          address_line1: '123 Main St',
          deleted_at: null,
        },
        {
          id: 'customer-2',
          first_name: 'Taylor',
          last_name: 'Morgan',
          phone: '555-555-0101',
          email: 'shared@example.com',
          address_line1: '456 Other Ave',
          deleted_at: null,
        },
        {
          id: 'customer-deleted',
          first_name: 'Taylor',
          last_name: 'Morgan',
          phone: '+15555550101',
          email: 'shared@example.com',
          address_line1: '789 New Property Rd',
          deleted_at: '2026-01-01T00:00:00Z',
        },
      ],
      service_requests: [],
      customer_interactions: [],
      activity_log: [],
      property_preferences: [],
      notification_prefs: [],
    };

    const result = await createEstimateAddServiceRequest({
      estimateToken: 'public-token',
      requestedService: 'lawn_care',
      database: makeDb(tables),
      notificationTrigger: jest.fn(async () => ({ bellWritten: true })),
      sendMessage: jest.fn(async () => ({ sent: true })),
      accountMembershipEmail: { sendRequestReceived: jest.fn(() => Promise.resolve({ ok: true })) },
    });

    expect(result.deduped).toBe(false);
    expect(tables.customers).toHaveLength(4);
    const created = tables.customers[3];
    expect(created).toEqual(expect.objectContaining({
      active: false,
      pipeline_stage: 'new_lead',
      lead_source: 'public_estimate',
      address_line1: '789 New Property Rd',
    }));
    expect(['customer-1', 'customer-2', 'customer-deleted']).not.toContain(estimate.customer_id);
    expect(estimate.customer_id).toBe(created.id);
    expect(tables.service_requests[0].customer_id).toBe(created.id);
  });

  test('does not link near-miss street address substrings', async () => {
    const estimate = baseEstimate({
      customer_id: null,
      customer_phone: '+15555550101',
      address: '23 Main St, Sarasota, FL 34236',
    });
    const tables = {
      estimates: [estimate],
      customers: [{
        id: 'customer-1',
        first_name: 'Taylor',
        last_name: 'Morgan',
        phone: '+15555550101',
        address_line1: '123 Main St',
        deleted_at: null,
      }],
      service_requests: [],
      customer_interactions: [],
      activity_log: [],
      property_preferences: [],
      notification_prefs: [],
    };

    await createEstimateAddServiceRequest({
      estimateToken: 'public-token',
      requestedService: 'lawn_care',
      database: makeDb(tables),
      notificationTrigger: jest.fn(async () => ({ bellWritten: true })),
      sendMessage: jest.fn(async () => ({ sent: true })),
      accountMembershipEmail: { sendRequestReceived: jest.fn(() => Promise.resolve({ ok: true })) },
    });

    expect(tables.customers).toHaveLength(2);
    expect(estimate.customer_id).toBe(tables.customers[1].id);
    expect(estimate.customer_id).not.toBe('customer-1');
    expect(tables.service_requests[0].customer_id).toBe(tables.customers[1].id);
  });

  test('returns a controlled conflict when duplicate customer insert cannot be safely matched', async () => {
    const estimate = baseEstimate({
      customer_id: null,
      customer_phone: '+15555550101',
      address: '789 New Property Rd, Sarasota, FL 34236',
    });
    const tables = {
      __insertConflicts: { customers: true },
      estimates: [estimate],
      customers: [{
        id: 'customer-1',
        first_name: 'Taylor',
        last_name: 'Morgan',
        phone: '+15555550101',
        address_line1: '123 Main St',
        deleted_at: null,
      }],
      service_requests: [],
      customer_interactions: [],
      activity_log: [],
      property_preferences: [],
      notification_prefs: [],
    };

    await expect(createEstimateAddServiceRequest({
      estimateToken: 'public-token',
      requestedService: 'lawn_care',
      database: makeDb(tables),
      notificationTrigger: jest.fn(async () => ({ bellWritten: true })),
      sendMessage: jest.fn(async () => ({ sent: true })),
      accountMembershipEmail: { sendRequestReceived: jest.fn(() => Promise.resolve({ ok: true })) },
    })).rejects.toMatchObject({ status: 409 });

    expect(estimate.customer_id).toBeNull();
    expect(tables.service_requests).toHaveLength(0);
  });

  test('rejects unsupported service keys before creating side effects', async () => {
    const estimate = baseEstimate();
    const tables = {
      estimates: [estimate],
      customers: [{ id: 'customer-1', first_name: 'Taylor', last_name: 'Morgan', phone: '+15555550101' }],
      service_requests: [],
      customer_interactions: [],
      activity_log: [],
    };
    const notifyAdmin = jest.fn();
    const sendMessage = jest.fn();
    const sendRequestReceived = jest.fn();

    await expect(createEstimateAddServiceRequest({
      estimateToken: 'public-token',
      requestedService: 'Pool Cleaning',
      database: makeDb(tables),
      notificationService: { notifyAdmin },
      sendMessage,
      accountMembershipEmail: { sendRequestReceived },
    })).rejects.toMatchObject({ status: 400 });

    expect(tables.service_requests).toHaveLength(0);
    expect(tables.customer_interactions).toHaveLength(0);
    expect(tables.activity_log).toHaveLength(0);
    expect(notifyAdmin).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendRequestReceived).not.toHaveBeenCalled();
  });

  test('rejects inactive estimates before creating side effects', async () => {
    const estimate = baseEstimate({ status: 'declined' });
    const tables = {
      estimates: [estimate],
      customers: [{ id: 'customer-1', first_name: 'Taylor', last_name: 'Morgan', phone: '+15555550101' }],
      service_requests: [],
      customer_interactions: [],
      activity_log: [],
    };
    const notifyAdmin = jest.fn();
    const sendMessage = jest.fn();
    const sendRequestReceived = jest.fn();

    await expect(createEstimateAddServiceRequest({
      estimateToken: 'public-token',
      requestedService: 'lawn_care',
      database: makeDb(tables),
      notificationService: { notifyAdmin },
      sendMessage,
      accountMembershipEmail: { sendRequestReceived },
    })).rejects.toMatchObject({ status: 409 });

    expect(tables.service_requests).toHaveLength(0);
    expect(tables.customer_interactions).toHaveLength(0);
    expect(tables.activity_log).toHaveLength(0);
    expect(notifyAdmin).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendRequestReceived).not.toHaveBeenCalled();
  });
});

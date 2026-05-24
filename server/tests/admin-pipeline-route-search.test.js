jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
}));

const { __private } = require('../routes/admin-pipeline');

function fakeQuery() {
  const calls = [];
  const scope = {
    whereILike(column, value) {
      calls.push(['whereILike', column, value]);
      return this;
    },
    orWhereILike(column, value) {
      calls.push(['orWhereILike', column, value]);
      return this;
    },
    orWhereRaw(sql, bindings) {
      calls.push(['orWhereRaw', sql, bindings]);
      return this;
    },
  };

  return {
    calls,
    where(fn) {
      fn.call(scope);
      return this;
    },
  };
}

describe('admin pipeline route search prefilter', () => {
  test('lead search includes normalized phone digits and lead/estimate refs', () => {
    const query = fakeQuery();

    __private.applyLeadSearch(query, '5551234567');

    expect(query.calls).toContainEqual(['orWhereRaw', 'leads.id::text ILIKE ?', ['%5551234567%']]);
    expect(query.calls).toContainEqual(['orWhereRaw', 'leads.estimate_id::text ILIKE ?', ['%5551234567%']]);
    expect(query.calls).toContainEqual([
      'orWhereRaw',
      "regexp_replace(COALESCE(leads.phone, ''), '[^0-9]', '', 'g') LIKE ?",
      ['%5551234567%'],
    ]);
  });

  test('estimate search includes normalized phone digits and estimate/customer refs', () => {
    const query = fakeQuery();

    __private.applyEstimateSearch(query, '#abc123');

    expect(query.calls).toContainEqual(['orWhereRaw', 'estimates.id::text ILIKE ?', ['%abc123%']]);
    expect(query.calls).toContainEqual(['orWhereRaw', 'estimates.customer_id::text ILIKE ?', ['%abc123%']]);
    expect(query.calls).not.toContainEqual([
      'orWhereRaw',
      "regexp_replace(COALESCE(estimates.customer_phone, ''), '[^0-9]', '', 'g') LIKE ?",
      ['%123%'],
    ]);
  });

  test('search does not add broad id predicates for empty hash refs', () => {
    const leadQuery = fakeQuery();
    const estimateQuery = fakeQuery();

    __private.applyLeadSearch(leadQuery, '#');
    __private.applyEstimateSearch(estimateQuery, '#');

    expect(leadQuery.calls.some((call) => call[0] === 'orWhereRaw' && call[1].includes('id::text'))).toBe(false);
    expect(estimateQuery.calls.some((call) => call[0] === 'orWhereRaw' && call[1].includes('id::text'))).toBe(false);
  });
});

function createFakeDb(seed = {}) {
  const state = {
    leads: [...(seed.leads || [])],
    estimates: [...(seed.estimates || [])],
    lead_activities: [],
  };

  function table(name) {
    let whereId = null;
    let updatePayload = null;
    return {
      where(key, value) {
        if (typeof key === 'object') whereId = key.id;
        else if (key === 'id') whereId = value;
        return this;
      },
      first() {
        return state[name].find((row) => row.id === whereId) || null;
      },
      update(payload) {
        updatePayload = payload;
        const index = state[name].findIndex((row) => row.id === whereId);
        if (index >= 0) state[name][index] = { ...state[name][index], ...payload };
        return this;
      },
      returning() {
        return [state[name].find((row) => row.id === whereId)].filter(Boolean);
      },
      insert(payload) {
        state[name].push(payload);
        return this;
      },
      _updatePayload() {
        return updatePayload;
      },
    };
  }

  const fakeDb = (name) => table(name);
  fakeDb.transaction = async (callback) => callback(fakeDb);
  fakeDb.state = state;
  return fakeDb;
}

describe('admin pipeline opportunity linking', () => {
  test('links a valid lead and estimate and records activity', async () => {
    const database = createFakeDb({
      leads: [{ id: 'lead-1', estimate_id: null }],
      estimates: [{ id: 'est-1', status: 'draft' }],
    });

    const result = await __private.linkOpportunityRecords({
      database,
      leadId: 'lead-1',
      estimateId: 'est-1',
      actor: 'Ada Admin',
    });

    expect(result.linked).toBe(true);
    expect(database.state.leads[0].estimate_id).toBe('est-1');
    expect(database.state.lead_activities[0]).toMatchObject({
      lead_id: 'lead-1',
      activity_type: 'linked_estimate',
      performed_by: 'Ada Admin',
    });
  });

  test('rejects missing lead or estimate', async () => {
    const database = createFakeDb({
      leads: [{ id: 'lead-1', estimate_id: null }],
      estimates: [],
    });

    await expect(__private.linkOpportunityRecords({
      database,
      leadId: 'missing',
      estimateId: 'est-1',
    })).rejects.toMatchObject({ status: 404, message: 'Lead not found' });

    await expect(__private.linkOpportunityRecords({
      database,
      leadId: 'lead-1',
      estimateId: 'missing',
    })).rejects.toMatchObject({ status: 404, message: 'Estimate not found' });
  });

  test('rejects a lead linked to another estimate unless forced', async () => {
    const database = createFakeDb({
      leads: [{ id: 'lead-1', estimate_id: 'est-old' }],
      estimates: [{ id: 'est-new', status: 'draft' }],
    });

    await expect(__private.linkOpportunityRecords({
      database,
      leadId: 'lead-1',
      estimateId: 'est-new',
    })).rejects.toMatchObject({
      status: 409,
      code: 'lead_already_linked',
      currentEstimateId: 'est-old',
    });

    await expect(__private.linkOpportunityRecords({
      database,
      leadId: 'lead-1',
      estimateId: 'est-new',
      force: true,
    })).resolves.toMatchObject({ linked: true });
    expect(database.state.leads[0].estimate_id).toBe('est-new');
  });
});

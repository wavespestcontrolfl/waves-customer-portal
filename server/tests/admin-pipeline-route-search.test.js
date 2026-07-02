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

  test('lead source prefilter skips legacy lead_source when the column is absent', () => {
    const query = fakeQuery();

    __private.applyLeadSourceFilter(query, 'home advisor');

    expect(query.calls).toContainEqual(['whereILike', 'lead_sources.name', '%home advisor%']);
    expect(query.calls).toContainEqual(['orWhereILike', 'lead_sources.channel', '%home advisor%']);
    expect(query.calls).toContainEqual(['orWhereILike', 'leads.lead_type', '%home advisor%']);
    expect(query.calls).not.toContainEqual(['orWhereILike', 'leads.lead_source', '%home advisor%']);
  });

  test('lead source prefilter includes legacy lead_source text when the column exists', () => {
    const query = fakeQuery();

    __private.applyLeadSourceFilter(query, 'home advisor', { hasLegacyLeadSource: true });

    expect(query.calls).toContainEqual(['whereILike', 'lead_sources.name', '%home advisor%']);
    expect(query.calls).toContainEqual(['orWhereILike', 'lead_sources.channel', '%home advisor%']);
    expect(query.calls).toContainEqual(['orWhereILike', 'leads.lead_type', '%home advisor%']);
    expect(query.calls).toContainEqual(['orWhereILike', 'leads.lead_source', '%home advisor%']);
  });

  test('legacy lead_source column probe rechecks schema instead of caching forever', async () => {
    const database = {
      schema: {
        hasColumn: jest.fn()
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(false),
      },
    };

    await expect(__private.hasLegacyLeadSourceColumn(database)).resolves.toBe(true);
    await expect(__private.hasLegacyLeadSourceColumn(database)).resolves.toBe(false);
    expect(database.schema.hasColumn).toHaveBeenCalledTimes(2);
  });
});

describe('admin pipeline saved views', () => {
  test('normalizes saved view filters to the supported URL-backed shape', () => {
    expect(__private.normalizeSavedViewFilters({
      stage: 'viewed',
      search: '  Jane Smith  ',
      sort: 'next_follow_up',
      date_range: '30d',
      source: '  Google  ',
    })).toEqual({
      filter: 'viewed',
      search: 'Jane Smith',
      sort: 'next_follow_up',
      dateRange: '30d',
      source: 'Google',
    });

    expect(__private.normalizeSavedViewFilters({
      filter: 'unknown',
      sort: 'random',
      dateRange: 'forever',
    })).toMatchObject({
      filter: 'needs_action',
      sort: 'default',
      dateRange: 'all',
    });
  });

  test('creates saved views scoped to the technician', async () => {
    const database = createFakeDb({
      admin_pipeline_saved_views: [{ id: 'existing', technician_id: 'tech-1', sort_order: 2, filters: {} }],
    });

    const savedView = await __private.createSavedPipelineView({
      database,
      technicianId: 'tech-1',
      name: '  Google leads  ',
      filters: { filter: 'all', source: 'google' },
    });

    expect(savedView).toMatchObject({
      name: 'Google leads',
      sortOrder: 3,
      filters: {
        filter: 'all',
        search: '',
        sort: 'default',
        dateRange: 'all',
        source: 'google',
      },
    });
    expect(database.state.admin_pipeline_saved_views).toHaveLength(2);
    expect(database.state.admin_pipeline_saved_views[1]).toMatchObject({
      technician_id: 'tech-1',
      name: 'Google leads',
      sort_order: 3,
    });
  });

  test('deletes saved views only for the owning technician', async () => {
    const database = createFakeDb({
      admin_pipeline_saved_views: [
        { id: 'view-1', technician_id: 'tech-1', name: 'Mine', sort_order: 1, filters: {} },
        { id: 'view-2', technician_id: 'tech-2', name: 'Other', sort_order: 1, filters: {} },
      ],
    });

    await expect(__private.deleteSavedPipelineView({
      database,
      technicianId: 'tech-1',
      viewId: 'view-2',
    })).rejects.toThrow('Saved view not found');

    await expect(__private.deleteSavedPipelineView({
      database,
      technicianId: 'tech-1',
      viewId: 'view-1',
    })).resolves.toEqual({ deleted: true, id: 'view-1' });
    expect(database.state.admin_pipeline_saved_views.map((row) => row.id)).toEqual(['view-2']);
  });
});

function createFakeDb(seed = {}) {
  const state = {
    leads: [...(seed.leads || [])],
    estimates: [...(seed.estimates || [])],
    lead_activities: [],
    pipeline_duplicate_risk_dismissals: [],
    admin_pipeline_saved_views: [...(seed.admin_pipeline_saved_views || [])],
    audit_log: [],
  };

  function table(name) {
    const wheres = [];
    const nullColumns = [];
    let updatePayload = null;
    let insertPayload = null;
    let conflictKey = null;
    let lastUpdatedRows = [];
    const rowMatches = (row) => wheres.every(([key, value]) => row[key] === value)
      && nullColumns.every((column) => row[column] === null || row[column] === undefined);
    const query = {
      whereNull(column) {
        nullColumns.push(column);
        return this;
      },
      where(key, value) {
        if (typeof key === 'object') {
          for (const [objectKey, objectValue] of Object.entries(key)) wheres.push([objectKey, objectValue]);
        } else {
          wheres.push([key, value]);
        }
        return this;
      },
      first() {
        return state[name].find(rowMatches) || null;
      },
      update(payload) {
        updatePayload = payload;
        lastUpdatedRows = [];
        const index = state[name].findIndex(rowMatches);
        if (index >= 0) {
          state[name][index] = { ...state[name][index], ...payload };
          lastUpdatedRows = [state[name][index]];
        }
        return this;
      },
      returning() {
        return lastUpdatedRows.length ? lastUpdatedRows : [state[name].find(rowMatches)].filter(Boolean);
      },
      insert(payload) {
        insertPayload = payload;
        const row = { id: payload.id || `${name}-${state[name].length + 1}`, ...payload };
        if (!conflictKey) state[name].push(row);
        else {
          const index = state[name].findIndex((existing) => existing[conflictKey] === row[conflictKey]);
          if (index >= 0) state[name][index] = { ...state[name][index], ...row };
          else state[name].push(row);
        }
        lastUpdatedRows = [row];
        return this;
      },
      onConflict(key) {
        conflictKey = key;
        return this;
      },
      merge(payload) {
        const keys = Array.isArray(conflictKey) ? conflictKey : [conflictKey];
        const index = state[name].findIndex((row) => keys.every((key) => row[key] === insertPayload[key]));
        if (index >= 0) state[name][index] = { ...state[name][index], ...payload };
        return this;
      },
      del() {
        const before = state[name].length;
        state[name] = state[name].filter((row) => !rowMatches(row));
        return before - state[name].length;
      },
      max(aliasExpression) {
        const [column, alias] = String(aliasExpression).split(/\s+as\s+/i);
        const rows = state[name].filter(rowMatches);
        const max = rows.reduce((largest, row) => Math.max(largest, Number(row[column] || 0)), 0);
        return {
          first: () => ({ [alias || column]: max }),
        };
      },
      _updatePayload() {
        return updatePayload;
      },
    };
    return query;
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

describe('admin pipeline duplicate-risk dismissal', () => {
  test('filters dismissed lead pairs from candidate lists without hiding other candidates', () => {
    const result = __private.filterDismissedCandidates([
      { leadId: 'lead-1', name: 'Dismissed Lead' },
      { leadId: 'lead-2', name: 'Still Visible' },
    ], ['lead-1']);

    expect(result).toEqual({
      dismissedCount: 1,
      candidates: [{ leadId: 'lead-2', name: 'Still Visible' }],
    });
  });

  test('dismisses an existing estimate and records audit log', async () => {
    const database = createFakeDb({
      leads: [{ id: 'lead-1' }],
      estimates: [{ id: 'est-1', status: 'draft' }],
    });

    const result = await __private.dismissDuplicateRisk({
      database,
      estimateId: 'est-1',
      leadId: 'lead-1',
      reason: 'bad_match',
      note: 'Different address',
      actorId: 'tech-1',
    });

    expect(result.dismissed).toBe(true);
    expect(database.state.pipeline_duplicate_risk_dismissals[0]).toMatchObject({
      estimate_id: 'est-1',
      lead_id: 'lead-1',
      dismissed_by: 'tech-1',
      reason: 'bad_match',
      note: 'Different address',
    });
    expect(database.state.audit_log[0]).toMatchObject({
      actor_type: 'technician',
      actor_id: 'tech-1',
      action: 'pipeline.duplicate_risk.dismiss',
      resource_type: 'estimate',
      resource_id: 'est-1',
    });
  });

  test('normalizes unknown dismissal reasons and rejects missing estimates', async () => {
    expect(__private.normalizeDismissReason('not-a-real-reason')).toBe('not_same_customer');

    const database = createFakeDb({ estimates: [] });
    await expect(__private.dismissDuplicateRisk({
      database,
      estimateId: 'missing',
      leadId: 'lead-1',
    })).rejects.toMatchObject({ status: 404, message: 'Estimate not found' });
  });

  test('requires a lead id for duplicate-risk dismissal', async () => {
    const database = createFakeDb({ estimates: [{ id: 'est-1' }] });
    await expect(__private.dismissDuplicateRisk({
      database,
      estimateId: 'est-1',
    })).rejects.toMatchObject({ status: 400, message: 'leadId is required' });
  });

  test('reopens a dismissed duplicate pair and records audit log', async () => {
    const database = createFakeDb({
      estimates: [{ id: 'est-1' }],
    });
    database.state.pipeline_duplicate_risk_dismissals.push({
      id: 'dismissal-1',
      estimate_id: 'est-1',
      lead_id: 'lead-1',
      reason: 'bad_match',
    });

    const result = await __private.reopenReviewedDuplicate({
      database,
      action: 'dismissed',
      estimateId: 'est-1',
      leadId: 'lead-1',
      actorId: 'tech-1',
    });

    expect(result).toMatchObject({ reopened: true, action: 'dismissed' });
    expect(database.state.pipeline_duplicate_risk_dismissals).toEqual([]);
    expect(database.state.audit_log[0]).toMatchObject({
      actor_type: 'technician',
      actor_id: 'tech-1',
      action: 'pipeline.duplicate_risk.reopen_dismissal',
      resource_type: 'estimate',
      resource_id: 'est-1',
    });
  });

  test('undoes a linked duplicate pair only when the lead still points to that estimate', async () => {
    const database = createFakeDb({
      leads: [{ id: 'lead-1', estimate_id: 'est-1' }],
      estimates: [{ id: 'est-1' }],
    });

    const result = await __private.reopenReviewedDuplicate({
      database,
      action: 'linked',
      estimateId: 'est-1',
      leadId: 'lead-1',
      actor: 'Ada Admin',
    });

    expect(result).toMatchObject({ reopened: true, action: 'linked' });
    expect(database.state.leads[0].estimate_id).toBeNull();
    expect(database.state.lead_activities[0]).toMatchObject({
      lead_id: 'lead-1',
      activity_type: 'unlinked_estimate',
      performed_by: 'Ada Admin',
    });
    expect(database.state.audit_log[0]).toMatchObject({
      action: 'pipeline.duplicate_risk.reopen_link',
      resource_id: 'est-1',
    });
  });

  test('rejects linked reopen when the lead link has changed', async () => {
    const database = createFakeDb({
      leads: [{ id: 'lead-1', estimate_id: 'est-new' }],
    });

    await expect(__private.reopenReviewedDuplicate({
      database,
      action: 'linked',
      estimateId: 'est-old',
      leadId: 'lead-1',
    })).rejects.toMatchObject({
      status: 409,
      code: 'link_changed',
      currentEstimateId: 'est-new',
    });
  });
});

describe('admin pipeline reviewed history helpers', () => {
  test('history limit defaults and clamps values', () => {
    expect(__private.historyLimit(undefined)).toBe(20);
    expect(__private.historyLimit('0')).toBe(1);
    expect(__private.historyLimit('-5')).toBe(1);
    expect(__private.historyLimit('250')).toBe(100);
    expect(__private.historyLimit('8')).toBe(8);
  });

  test('dismissal history maps note presence without exposing raw notes', () => {
    const history = __private.mapDismissalHistory({
      id: 'dismissal-1',
      estimate_id: 'est-1',
      lead_id: 'lead-1',
      estimate_customer_name: 'Jane Smith',
      lead_first_name: 'Jane',
      lead_last_name: 'Smith',
      dismissed_by_name: 'Ada Admin',
      reason: 'bad_match',
      note: 'Private note',
      updated_at: '2026-05-24T12:00:00.000Z',
    });

    expect(history).toEqual({
      id: 'dismissal-1',
      action: 'dismissed',
      estimateId: 'est-1',
      leadId: 'lead-1',
      estimateRef: 'Est est-1',
      leadRef: 'Lead lead-1',
      estimateLabel: 'Jane Smith',
      leadLabel: 'Jane Smith',
      customerName: 'Jane Smith',
      reason: 'bad_match',
      actor: 'Ada Admin',
      hasNote: true,
      createdAt: '2026-05-24T12:00:00.000Z',
    });
    expect(history).not.toHaveProperty('note');
  });

  test('linked history parses estimate id from activity metadata', () => {
    expect(__private.mapLinkedHistory({
      id: 'activity-1',
      lead_id: 'lead-1',
      lead_first_name: 'Ada',
      lead_last_name: 'Lovelace',
      performed_by: 'Ada Admin',
      metadata: JSON.stringify({ estimateId: 'est-1' }),
      created_at: '2026-05-24T13:00:00.000Z',
    })).toEqual({
      id: 'activity-1',
      action: 'linked',
      estimateId: 'est-1',
      leadId: 'lead-1',
      estimateRef: 'Est est-1',
      leadRef: 'Lead lead-1',
      estimateLabel: null,
      leadLabel: 'Ada Lovelace',
      customerName: 'Ada Lovelace',
      reason: null,
      actor: 'Ada Admin',
      hasNote: false,
      createdAt: '2026-05-24T13:00:00.000Z',
    });
  });

  test('linked history tolerates malformed metadata', () => {
    expect(__private.mapLinkedHistory({
      id: 'activity-2',
      lead_id: 'lead-2',
      performed_by: null,
      metadata: '{',
      created_at: null,
    })).toMatchObject({
      estimateId: null,
      leadId: 'lead-2',
      actor: null,
    });
  });

  test('estimate context enriches linked history customer labels without mutating note privacy', () => {
    const [history] = __private.applyEstimateHistoryContext([
      {
        id: 'activity-1',
        action: 'linked',
        estimateId: 'est-1',
        leadId: 'lead-1',
        estimateLabel: null,
        leadLabel: null,
        customerName: null,
        hasNote: false,
      },
    ], [{ id: 'est-1', customer_name: 'Jane Smith' }]);

    expect(history).toMatchObject({
      estimateLabel: 'Jane Smith',
      customerName: 'Jane Smith',
      hasNote: false,
    });
    expect(history).not.toHaveProperty('note');
  });

  test('reviewed history sort uses newest linked and dismissed decisions first', () => {
    const items = [
      __private.mapLinkedHistory({
        id: 'activity-old',
        lead_id: 'lead-1',
        metadata: JSON.stringify({ estimateId: 'est-1' }),
        created_at: '2026-05-24T12:00:00.000Z',
      }),
      __private.mapDismissalHistory({
        id: 'dismissal-new',
        estimate_id: 'est-2',
        lead_id: 'lead-2',
        updated_at: '2026-05-24T13:00:00.000Z',
      }),
    ].sort(__private.compareHistoryCreatedAt);

    expect(items.map((item) => item.id)).toEqual(['dismissal-new', 'activity-old']);
  });

  test('reviewed history hides linked entries that were later reopened', () => {
    const linked = __private.mapLinkedHistory({
      id: 'activity-linked',
      lead_id: 'lead-1',
      metadata: JSON.stringify({ estimateId: 'est-1' }),
      created_at: '2026-05-24T12:00:00.000Z',
    });

    expect(__private.filterReopenedLinkedHistory([linked], [{
      id: 'activity-unlinked',
      lead_id: 'lead-1',
      metadata: JSON.stringify({ estimateId: 'est-1' }),
      created_at: '2026-05-24T13:00:00.000Z',
    }])).toEqual([]);

    expect(__private.filterReopenedLinkedHistory([linked], [{
      id: 'activity-unlinked-old',
      lead_id: 'lead-1',
      metadata: JSON.stringify({ estimateId: 'est-1' }),
      created_at: '2026-05-24T11:00:00.000Z',
    }])).toEqual([linked]);
  });
});

describe('admin pipeline opportunity history helpers', () => {
  test('parses opportunity refs without relying on source table labels', () => {
    expect(__private.parseOpportunityRef('lead:lead-1')).toEqual({ leadId: 'lead-1', estimateId: null });
    expect(__private.parseOpportunityRef('estimate:est-1')).toEqual({ leadId: null, estimateId: 'est-1' });
    expect(__private.parseOpportunityRef('lead:lead-1:estimate:est-1')).toEqual({ leadId: 'lead-1', estimateId: 'est-1' });
    expect(__private.parseOpportunityRef('est-1')).toEqual({ leadId: null, estimateId: 'est-1' });
  });

  test('maps lead activity events without exposing raw metadata', () => {
    const event = __private.mapLeadActivityEvent({
      id: 'activity-1',
      activity_type: 'linked_estimate',
      description: 'Linked estimate est-1',
      performed_by: 'Ada Admin',
      metadata: JSON.stringify({ estimateId: 'est-1', privateThing: 'hidden' }),
      created_at: '2026-05-24T12:00:00.000Z',
    });

    expect(event).toMatchObject({
      id: 'lead_activity:activity-1',
      type: 'linked_estimate',
      title: 'Linked Estimate',
      description: 'Linked estimate est-1',
      actor: 'Ada Admin',
      occurredAt: '2026-05-24T12:00:00.000Z',
      source: 'lead_activity',
      metadata: {
        estimateId: 'est-1',
        hasMetadata: true,
      },
    });
    expect(event.metadata).not.toHaveProperty('privateThing');
  });

  test('maps duplicate dismissal timeline events with note presence only', () => {
    const event = __private.mapDismissalTimelineEvent({
      id: 'dismissal-1',
      estimate_id: 'est-1',
      lead_id: 'lead-1',
      reason: 'bad_match',
      note: 'Private note',
      dismissed_by_name: 'Ada Admin',
      updated_at: '2026-05-24T13:00:00.000Z',
    });

    expect(event).toMatchObject({
      id: 'duplicate_dismissal:dismissal-1',
      type: 'duplicate_dismissed',
      title: 'Duplicate Match Dismissed',
      description: 'bad match',
      actor: 'Ada Admin',
      occurredAt: '2026-05-24T13:00:00.000Z',
      metadata: {
        estimateId: 'est-1',
        leadId: 'lead-1',
        hasNote: true,
      },
    });
    expect(event.metadata).not.toHaveProperty('note');
  });

  test('maps duplicate reopen audit events to readable titles', () => {
    expect(__private.mapAuditTimelineEvent({
      id: 'audit-1',
      action: 'pipeline.duplicate_risk.reopen_link',
      actor_type: 'technician',
      actor_name: 'Ada Admin',
      resource_id: 'est-1',
      metadata: JSON.stringify({ estimateId: 'est-1', leadId: 'lead-1' }),
      created_at: '2026-05-24T14:00:00.000Z',
    })).toMatchObject({
      id: 'audit:audit-1',
      type: 'pipeline.duplicate_risk.reopen_link',
      title: 'Duplicate Link Reopened',
      actor: 'Ada Admin',
      occurredAt: '2026-05-24T14:00:00.000Z',
      metadata: {
        estimateId: 'est-1',
        leadId: 'lead-1',
      },
    });
  });
});

'use strict';

describe('agent-gap-reports', () => {
  let dbMock;
  let insertedRows;
  let mergedCalls;
  let returningRows;
  let loggerMock;

  beforeEach(() => {
    jest.resetModules();
    insertedRows = [];
    mergedCalls = [];
    returningRows = [{ id: 7, occurrences: 1, status: 'new' }];
    loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    dbMock = jest.fn((table) => {
      if (table === 'agent_gap_reports') {
        return {
          insert: jest.fn((row) => {
            insertedRows.push(row);
            return {
              onConflict: jest.fn(() => ({
                merge: jest.fn((mergeFields) => {
                  mergedCalls.push(mergeFields);
                  return { returning: jest.fn().mockResolvedValue(returningRows) };
                }),
              })),
            };
          }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    });
    dbMock.raw = jest.fn((sql) => ({ __raw: sql }));

    jest.doMock('../models/db', () => dbMock);
    jest.doMock('../services/logger', () => loggerMock);
  });

  function load() {
    return require('../services/agent-gap-reports');
  }

  describe('recordGapReport', () => {
    test('rejects an unknown kind without touching the database', async () => {
      const { recordGapReport } = load();
      const result = await recordGapReport({ source: 'intelligence-bar', kind: 'made_up', summary: 'Add a thing' });
      expect(result).toBeNull();
      expect(dbMock).not.toHaveBeenCalled();
    });

    test('two summaries that differ only in word order dedupe to the same fingerprint', async () => {
      const { recordGapReport } = load();
      await recordGapReport({ source: 'intelligence-bar', kind: 'missing_capability', summary: 'add property to customer' });
      await recordGapReport({ source: 'intelligence-bar', kind: 'missing_capability', summary: 'customer property add' });
      expect(insertedRows).toHaveLength(2);
      expect(insertedRows[0].fingerprint).toBe(insertedRows[1].fingerprint);
    });

    test('a different closest_tool changes the fingerprint even with the same words', async () => {
      const { recordGapReport } = load();
      await recordGapReport({ source: 'intelligence-bar', kind: 'tool_failure', summary: 'send a text message', closestTool: 'send_sms' });
      await recordGapReport({ source: 'intelligence-bar', kind: 'tool_failure', summary: 'send a text message', closestTool: 'reply_via_sms' });
      expect(insertedRows[0].fingerprint).not.toBe(insertedRows[1].fingerprint);
    });

    test('redacts an email, a phone number, and a UUID out of the summary and attempted text', async () => {
      const { recordGapReport } = load();
      await recordGapReport({
        source: 'intelligence-bar',
        kind: 'blocked',
        summary: 'Could not text jane.doe@example.com about record 10000000-0000-4000-8000-000000000001',
        attempted: 'Called 555-123-4567 to confirm',
      });
      const row = insertedRows[0];
      expect(row.summary).not.toMatch(/jane\.doe@example\.com/);
      expect(row.summary).toContain('[email]');
      expect(row.summary).not.toMatch(/10000000-0000-4000-8000-000000000001/);
      expect(row.summary).toContain('[id]');
      expect(row.attempted).not.toMatch(/555-123-4567/);
      expect(row.attempted).toContain('[phone]');
    });

    test('an empty summary after redaction records nothing', async () => {
      const { recordGapReport } = load();
      const result = await recordGapReport({ source: 'intelligence-bar', kind: 'missing_capability', summary: '   ' });
      expect(result).toBeNull();
      expect(dbMock).not.toHaveBeenCalled();
    });

    test('a closest_tool that is not a bare snake_case identifier is dropped, not stored raw', async () => {
      const { recordGapReport } = load();
      await recordGapReport({ source: 'intelligence-bar', kind: 'tool_failure', summary: 'do a thing', closestTool: 'Not Valid!' });
      expect(insertedRows[0].closest_tool).toBeNull();
    });

    test('a domain outside the reviewed policy list is dropped to null', async () => {
      const { recordGapReport } = load();
      await recordGapReport({ source: 'intelligence-bar', kind: 'missing_capability', summary: 'do a thing', domain: 'not_a_real_domain' });
      expect(insertedRows[0].domain).toBeNull();
    });

    test('a real policy domain is kept', async () => {
      const { recordGapReport } = load();
      await recordGapReport({ source: 'intelligence-bar', kind: 'missing_capability', summary: 'do a thing', domain: 'ops' });
      expect(insertedRows[0].domain).toBe('ops');
    });

    test('a recurrence bumps occurrences, refreshes last_seen_at, and reopens a fixed gap to new', async () => {
      const { recordGapReport } = load();
      await recordGapReport({ source: 'intelligence-bar', kind: 'missing_capability', summary: 'add a second address' });
      expect(mergedCalls[0]).toHaveProperty('occurrences');
      expect(mergedCalls[0]).toHaveProperty('last_seen_at');
      expect(mergedCalls[0].status.__raw).toMatch(/CASE WHEN/i);
      expect(mergedCalls[0].status.__raw).toMatch(/'fixed'/);
      expect(mergedCalls[0].status.__raw).toMatch(/'new'/);
    });

    test('returns the upserted id, occurrences, and status', async () => {
      returningRows = [{ id: 42, occurrences: 3, status: 'building' }];
      const { recordGapReport } = load();
      const result = await recordGapReport({ source: 'intelligence-bar', kind: 'blocked', summary: 'do a thing' });
      expect(result).toEqual({ id: 42, occurrences: 3, status: 'building' });
    });

    test('never throws when the database insert rejects, and logs only the error code', async () => {
      dbMock = jest.fn(() => ({
        insert: jest.fn(() => ({ onConflict: jest.fn(() => ({ merge: jest.fn(() => ({ returning: jest.fn().mockRejectedValue(Object.assign(new Error('customer jane@example.com failed'), { code: '23505' })) })) })) })),
      }));
      dbMock.raw = jest.fn((sql) => ({ __raw: sql }));
      jest.doMock('../models/db', () => dbMock);
      const { recordGapReport } = load();
      const result = await recordGapReport({ source: 'intelligence-bar', kind: 'blocked', summary: 'do a thing' });
      expect(result).toBeNull();
      expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining('23505'));
      expect(loggerMock.warn).not.toHaveBeenCalledWith(expect.stringContaining('jane@example.com'));
    });
  });

  describe('createGapCollector', () => {
    test('a recovered discovery (capabilities_found) drops the earlier missing_capability signal', async () => {
      const { createGapCollector } = load();
      const collector = createGapCollector({ source: 'intelligence-bar' });
      collector.discovery({ query: 'add second address' }, { status: 'capability_unimplemented' });
      collector.discovery({ query: 'add second address' }, { status: 'capabilities_found' });
      await collector.flush();
      expect(insertedRows).toHaveLength(0);
    });

    test('an unresolved discovery miss records a missing_capability gap on flush', async () => {
      const { createGapCollector } = load();
      const collector = createGapCollector({ source: 'intelligence-bar' });
      collector.discovery({ query: 'add second address', domain: 'customers' }, { status: 'capability_unimplemented' });
      await collector.flush();
      expect(insertedRows).toHaveLength(1);
      expect(insertedRows[0].kind).toBe('missing_capability');
      expect(insertedRows[0].summary).toContain('add second address');
    });

    test('the model filing report_gap itself drops the automatic discovery signal', async () => {
      const { createGapCollector } = load();
      const collector = createGapCollector({ source: 'intelligence-bar' });
      collector.discovery({ query: 'add second address' }, { status: 'capability_unimplemented' });
      collector.reported({ tool: null });
      await collector.flush();
      expect(insertedRows).toHaveLength(0);
    });

    test('a tool that fails twice in one request records one tool_failure gap with the error code, never the raw message', async () => {
      const { createGapCollector } = load();
      const collector = createGapCollector({ source: 'intelligence-bar' });
      collector.toolResult('send_sms', { error: 'customer jane@example.com not found', code: 'not_found' }, true);
      collector.toolResult('send_sms', { error: 'customer jane@example.com not found', code: 'not_found' }, true);
      await collector.flush();
      expect(insertedRows).toHaveLength(1);
      expect(insertedRows[0].kind).toBe('tool_failure');
      expect(insertedRows[0].closest_tool).toBe('send_sms');
      expect(insertedRows[0].summary).toContain('send_sms failed 2 times');
      expect(insertedRows[0].summary).toContain('not_found');
      expect(insertedRows[0].summary).not.toContain('jane@example.com');
    });

    test('a single tool failure never crosses the threshold', async () => {
      const { createGapCollector } = load();
      const collector = createGapCollector({ source: 'intelligence-bar' });
      collector.toolResult('send_sms', { error: 'oops', code: 'oops' }, true);
      await collector.flush();
      expect(insertedRows).toHaveLength(0);
    });

    test('a tool the model already named in report_gap is not double-reported for its own failures', async () => {
      const { createGapCollector } = load();
      const collector = createGapCollector({ source: 'intelligence-bar' });
      collector.toolResult('send_sms', { error: 'oops', code: 'oops' }, true);
      collector.toolResult('send_sms', { error: 'oops', code: 'oops' }, true);
      collector.reported({ tool: 'send_sms' });
      await collector.flush();
      expect(insertedRows).toHaveLength(0);
    });

    test('capability_not_loaded failures are ignored — a routing artifact, not a real gap', async () => {
      const { createGapCollector } = load();
      const collector = createGapCollector({ source: 'intelligence-bar' });
      collector.toolResult('some_tool', { error: 'Discover this capability before using it', code: 'capability_not_loaded' }, true);
      collector.toolResult('some_tool', { error: 'Discover this capability before using it', code: 'capability_not_loaded' }, true);
      await collector.flush();
      expect(insertedRows).toHaveLength(0);
    });

    test('a tool result carrying capability_unimplemented queues a missing_capability signal keyed by tool name', async () => {
      const { createGapCollector } = load();
      const collector = createGapCollector({ source: 'intelligence-bar' });
      collector.toolResult('made_up_tool', { error: 'no such tool', code: 'capability_unimplemented' }, true);
      await collector.flush();
      expect(insertedRows).toHaveLength(1);
      expect(insertedRows[0].closest_tool).toBe('made_up_tool');
      expect(insertedRows[0].summary).toContain('made_up_tool');
    });

    test('flush never rejects even when the database throws', async () => {
      dbMock = jest.fn(() => ({
        insert: jest.fn(() => ({ onConflict: jest.fn(() => ({ merge: jest.fn(() => ({ returning: jest.fn().mockRejectedValue(new Error('db down')) })) })) })),
      }));
      dbMock.raw = jest.fn((sql) => ({ __raw: sql }));
      jest.doMock('../models/db', () => dbMock);
      const { createGapCollector } = load();
      const collector = createGapCollector({ source: 'intelligence-bar' });
      collector.toolResult('send_sms', { error: 'oops', code: 'oops' }, true);
      collector.toolResult('send_sms', { error: 'oops', code: 'oops' }, true);
      await expect(collector.flush()).resolves.toBeUndefined();
    });

    test('discover_capabilities and report_gap tool results are never treated as tool failures', async () => {
      const { createGapCollector } = load();
      const collector = createGapCollector({ source: 'intelligence-bar' });
      collector.toolResult('discover_capabilities', { error: 'x', code: 'x' }, true);
      collector.toolResult('discover_capabilities', { error: 'x', code: 'x' }, true);
      collector.toolResult('report_gap', { error: 'x', code: 'x' }, true);
      collector.toolResult('report_gap', { error: 'x', code: 'x' }, true);
      await collector.flush();
      expect(insertedRows).toHaveLength(0);
    });
  });
});

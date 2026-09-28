'use strict';

describe('agent-gap-reports', () => {
  let dbMock;
  let insertedRows;
  let mergedCalls;
  let returningRows;
  let loggerMock;
  let sightings;

  beforeEach(() => {
    jest.resetModules();
    delete process.env.AGENT_GAP_REPORTS;
    insertedRows = [];
    mergedCalls = [];
    returningRows = [{ id: '7', occurrences: 1, status: 'new' }];
    loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    sightings = [];
    const table = jest.fn((name) => {
      if (name === 'agent_gap_reports') {
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
          where: jest.fn(() => ({
            update: jest.fn((fields) => ({ returning: jest.fn().mockResolvedValue([{ id: '7', kind: 'missing_capability', occurrences: 1, ...fields }]) })),
          })),
        };
      }
      if (name === 'agent_gap_report_sightings') {
        return { insert: jest.fn(async (row) => { sightings.push(row); }) };
      }
      throw new Error(`Unexpected table ${name}`);
    });
    table.raw = jest.fn((sql) => ({ __raw: sql }));
    dbMock = table;
    dbMock.transaction = jest.fn(async (work) => work(table));

    jest.doMock('../models/db', () => dbMock);
    jest.doMock('../services/logger', () => loggerMock);
  });

  afterEach(() => {
    delete process.env.AGENT_GAP_REPORTS;
  });

  function load() {
    return require('../services/agent-gap-reports');
  }

  const DECLINE = "I can't do that from the bar.";

  describe('prepareGapRow', () => {
    test('rejects an unknown kind', () => {
      const { _private: { prepareGapRow } } = load();
      expect(prepareGapRow({ source: 'intelligence-bar', kind: 'made_up', summary: 'Add a thing' })).toBeNull();
    });

    test('word-order variants of the same ask share a fingerprint', () => {
      const { _private: { prepareGapRow } } = load();
      const a = prepareGapRow({ source: 'intelligence-bar', kind: 'missing_capability', summary: 'add property to customer' });
      const b = prepareGapRow({ source: 'intelligence-bar', kind: 'missing_capability', summary: 'customer property add' });
      expect(a.fingerprint).toBe(b.fingerprint);
    });

    test('a missing capability keeps one fingerprint whatever tool the search ranked first', () => {
      const { _private: { prepareGapRow } } = load();
      const a = prepareGapRow({ source: 'intelligence-bar', kind: 'missing_capability', summary: 'refund a card payment', closestTool: 'get_refunds' });
      const b = prepareGapRow({ source: 'intelligence-bar', kind: 'missing_capability', summary: 'refund a card payment', closestTool: 'list_payouts' });
      expect(a.fingerprint).toBe(b.fingerprint);
      expect(a.closest_tool).toBe('get_refunds');
    });

    test('only missing capabilities are recorded; tool failures live in tool_health_events', () => {
      const { _private: { prepareGapRow } } = load();
      expect(prepareGapRow({ source: 'intelligence-bar', kind: 'tool_failure', summary: 'send_sms kept failing' })).toBeNull();
    });

    test('redacts contact details, UUIDs, record numbers and the request customer names', () => {
      const { _private: { prepareGapRow } } = load();
      const row = prepareGapRow({
        source: 'intelligence-bar',
        kind: 'missing_capability',
        summary: 'Add property 61760 for Dana Synthwell, dana@example.com, 941-555-0100, id 3f6012af-0fff-4b41-865a-76061b85818d',
        freeText: true,
        attempted: 'Tried update_customer for Synthwell',
      }, ['Dana Synthwell', 'Dana', 'Synthwell']);
      expect(row.summary).not.toMatch(/Dana|Synthwell|dana@example\.com|941-555-0100|61760|3f6012af/);
      expect(row.summary).toContain('[name]');
      expect(row.summary).toContain('[email]');
      expect(row.summary).toContain('[phone]');
      expect(row.summary).toContain('[number]');
      expect(row.summary).toContain('[id]');
      expect(row.attempted).not.toContain('Synthwell');
    });

    test('redacts a request customer name that ends in an accented letter', () => {
      const { _private: { prepareGapRow } } = load();
      const row = prepareGapRow({ source: 'intelligence-bar', kind: 'missing_capability', summary: 'add a rental for José Núñez and Chloé' },
        ['José Núñez', 'José', 'Núñez', 'Chloé']);
      expect(row.summary).toBe('add a rental for [name] and [name]');
    });

    test('model-written text loses names and new addresses the request never resolved', () => {
      const { _private: { prepareGapRow } } = load();
      const row = prepareGapRow({ source: 'intelligence-bar', kind: 'missing_capability', freeText: true,
        summary: 'Refund a Stripe payment for Dana Synthwell at 12 Palm Row on Monday' });
      expect(row.summary).toBe('Refund a Stripe payment for [name] [name] at [address] on Monday');
    });

    test('a capitalized first word is kept only when it reads as the verb; acronyms and tiers stay', () => {
      const { _private: { scrubProperNouns } } = load();
      expect(scrubProperNouns('Dana wants a WDO inspection')).toBe('[name] wants a WDO inspection');
      expect(scrubProperNouns('Add a Silver tier discount for GA4 visitors')).toBe('Add a Silver tier discount for GA4 visitors');
    });

    test("the server's own phrasing is not scrubbed as if a model wrote it", () => {
      const { _private: { prepareGapRow } } = load();
      const row = prepareGapRow({ source: 'intelligence-bar', kind: 'missing_capability', summary: 'Asked for a tool that does not exist: create_property',
        attempted: 'Searched the bar; no matching tool' });
      expect(row.summary).toBe('Asked for a tool that does not exist: create_property');
      expect(row.attempted).toBe('Searched the bar; no matching tool');
    });

    test('an empty summary after cleaning records nothing', () => {
      const { _private: { prepareGapRow } } = load();
      expect(prepareGapRow({ source: 'intelligence-bar', kind: 'missing_capability', summary: '   ' })).toBeNull();
    });

    test('a tool name that is not a bare identifier is dropped, and a domain outside the policy list is null', () => {
      const { _private: { prepareGapRow } } = load();
      const row = prepareGapRow({ source: 'intelligence-bar', kind: 'missing_capability', summary: 'a thing', closestTool: 'drop table; --', domain: 'not-a-domain' });
      expect(row.closest_tool).toBeNull();
      expect(row.domain).toBeNull();
      expect(prepareGapRow({ source: 'intelligence-bar', kind: 'missing_capability', summary: 'a thing', domain: 'customers' }).domain).toBe('customers');
    });
  });

  describe('writeGapRows', () => {
    test('a recurrence bumps occurrences, reopens a fixed gap, and enriches rather than drops detail', async () => {
      const { writeGapRows } = load();
      const saved = await writeGapRows([{ source: 'intelligence-bar', kind: 'missing_capability', summary: 'add a second service address' }]);
      expect(saved).toEqual([{ id: 7, occurrences: 1, status: 'new' }]);
      const merge = mergedCalls[0];
      expect(merge.occurrences.__raw).toMatch(/occurrences \+ 1/);
      expect(merge.status.__raw).toMatch(/WHEN agent_gap_reports.status = 'fixed' THEN 'new'/);
      expect(merge.domain.__raw).toMatch(/COALESCE\(agent_gap_reports.domain, EXCLUDED.domain\)/);
      expect(merge.closest_tool.__raw).toMatch(/COALESCE\(agent_gap_reports.closest_tool, EXCLUDED.closest_tool\)/);
      expect(merge.attempted.__raw).toMatch(/COALESCE\(EXCLUDED.attempted, agent_gap_reports.attempted\)/);
      expect(dbMock.transaction).toHaveBeenCalledTimes(1);
      expect(sightings).toEqual([{ gap_id: '7', seen_at: expect.any(Date) }]);
    });

    test('the same gap twice in one batch is written once', async () => {
      const { writeGapRows } = load();
      await writeGapRows([
        { source: 'intelligence-bar', kind: 'missing_capability', summary: 'add a second service address' },
        { source: 'intelligence-bar', kind: 'missing_capability', summary: 'second service address add' },
      ]);
      expect(insertedRows).toHaveLength(1);
    });

    test('never throws when the insert rejects, and logs only the error code', async () => {
      dbMock.transaction.mockImplementation(async () => { throw Object.assign(new Error('insert into agent_gap_reports ... dana@example.com'), { code: '23505' }); });
      const { writeGapRows } = load();
      await expect(writeGapRows([{ source: 'intelligence-bar', kind: 'missing_capability', summary: 'x y z' }])).resolves.toEqual([]);
      expect(loggerMock.warn).toHaveBeenCalledWith('[agent-gap-reports] record failed (23505)');
    });

    test('the AGENT_GAP_REPORTS=off kill switch writes nothing and drops the prompt line', async () => {
      process.env.AGENT_GAP_REPORTS = 'off';
      const { writeGapRows, gapReportsEnabled, gapReportPromptLine } = load();
      expect(gapReportsEnabled()).toBe(false);
      expect(gapReportPromptLine()).toBe('');
      await expect(writeGapRows([{ source: 'intelligence-bar', kind: 'missing_capability', summary: 'add a second service address' }])).resolves.toEqual([]);
      expect(dbMock).not.toHaveBeenCalled();
      expect(dbMock.transaction).not.toHaveBeenCalled();
    });

    test('setGapStatus writes one of the lifecycle statuses and refuses anything else', async () => {
      const { setGapStatus, GAP_STATUSES } = load();
      expect(GAP_STATUSES).toEqual(['new', 'building', 'fixed', 'by_design', 'dismissed']);
      await expect(setGapStatus(7, 'done')).rejects.toThrow(/status must be one of/);
      await expect(setGapStatus(7, 'by_design')).resolves.toMatchObject({ status: 'by_design' });
    });

    test('with the switch on, the prompt line asks for a general search before declining', () => {
      const { gapReportPromptLine } = load();
      expect(gapReportPromptLine()).toMatch(/discover_capabilities with a short, general description/);
    });
  });

  describe('createGapCollector', () => {
    const MISS = { status: 'capability_unimplemented', capabilities: [] };
    const found = (...ids) => ({ status: 'capabilities_found', capabilities: ids.map((id) => ({ id, domain: 'customers' })) });

    test('records nothing unless the reply declined', async () => {
      const { createGapCollector } = load();
      const collector = createGapCollector({ source: 'intelligence-bar' });
      collector.discovery({ query: 'add a second service address' }, MISS);
      await collector.flush({ reply: 'Here are the three customers you asked about.' });
      expect(dbMock.transaction).not.toHaveBeenCalled();
    });

    test('a search that found nothing is recorded with the search as its summary', async () => {
      const { createGapCollector } = load();
      const collector = createGapCollector({ source: 'intelligence-bar' });
      collector.discovery({ query: 'add a second service address', domain: 'customers' }, MISS);
      await collector.flush({ reply: DECLINE });
      expect(insertedRows).toHaveLength(1);
      expect(insertedRows[0]).toMatchObject({ kind: 'missing_capability', summary: 'add a second service address', domain: 'customers', attempted: 'Searched the bar; no matching tool' });
    });

    test('a search whose surfaced tools were never used keeps the top tool and its domain', async () => {
      const { createGapCollector } = load();
      const collector = createGapCollector({ source: 'intelligence-bar' });
      collector.discovery({ query: 'refund a card payment' }, found('get_refunds', 'list_payouts'));
      await collector.flush({ reply: DECLINE });
      expect(insertedRows[0]).toMatchObject({ closest_tool: 'get_refunds', domain: 'customers', attempted: 'Searched the bar; 2 related tool(s) found, none used successfully' });
    });

    test('a related tool succeeding does not hide a declined request; the note says it ran', async () => {
      const { createGapCollector } = load();
      const collector = createGapCollector({ source: 'intelligence-bar' });
      collector.discovery({ query: 'refund a card payment' }, found('list_refunds'));
      collector.toolResult('list_refunds', { refunds: [] }, false);
      await collector.flush({ reply: "I can list refunds, but I can't issue one from the bar." });
      expect(insertedRows).toHaveLength(1);
      expect(insertedRows[0]).toMatchObject({ summary: 'refund a card payment', attempted: 'Searched the bar; a related tool ran, but the reply still declined part of the request' });
    });

    test('a success before the search is not credited to it', async () => {
      const { createGapCollector } = load();
      const collector = createGapCollector({ source: 'intelligence-bar' });
      collector.toolResult('query_customers', { customers: [] }, false);
      collector.discovery({ query: 'merge two customer records' }, found('query_customers'));
      await collector.flush({ reply: DECLINE });
      expect(insertedRows[0].attempted).toBe('Searched the bar; 1 related tool(s) found, none used successfully');
    });

    test('distinct searches are each recorded; a repeated search counts once for the request', async () => {
      const { createGapCollector } = load();
      const collector = createGapCollector({ source: 'intelligence-bar' });
      collector.discovery({ query: 'add a second service address' }, MISS);
      collector.discovery({ query: 'add a second service address' }, MISS);
      collector.discovery({ query: 'refund a card payment' }, MISS);
      await collector.flush({ reply: DECLINE });
      expect(insertedRows.map((row) => row.summary)).toEqual(['add a second service address', 'refund a card payment']);
    });

    test('tool failures are never recorded here, coded or not', async () => {
      const { createGapCollector } = load();
      const collector = createGapCollector({ source: 'intelligence-bar' });
      for (let i = 0; i < 3; i += 1) {
        collector.toolResult('adjust_stock', { error: 'x', code: 'target_clarification_required' }, true);
        collector.toolResult('send_sms', { error: 'IB writes are turned off' }, true);
      }
      await collector.flush({ reply: DECLINE });
      expect(insertedRows).toHaveLength(0);
    });

    test('a tool name that does not exist is recorded as a missing capability', async () => {
      const { createGapCollector } = load();
      const collector = createGapCollector({ source: 'intelligence-bar' });
      collector.toolResult('create_property', { error: 'no such tool', code: 'capability_unimplemented' }, true);
      await collector.flush({ reply: DECLINE });
      expect(insertedRows[0]).toMatchObject({ kind: 'missing_capability', closest_tool: 'create_property', summary: 'Asked for a tool that does not exist: create_property' });
    });

    test('the request customer names are redacted from a model-written search', async () => {
      const { createGapCollector } = load();
      const collector = createGapCollector({ source: 'intelligence-bar' });
      collector.discovery({ query: 'add a rental property for Dana Synthwell at 12 Palm Row' }, MISS);
      await collector.flush({ reply: DECLINE, taskContext: { targets: [{ label: 'Dana Synthwell', address: '12 Palm Row' }] } });
      expect(insertedRows[0].summary).not.toMatch(/Dana|Synthwell|Palm Row/);
    });

    test('flush never rejects, even when the database throws', async () => {
      dbMock.transaction.mockImplementation(async () => { throw new Error('down'); });
      const { createGapCollector } = load();
      const collector = createGapCollector({ source: 'intelligence-bar' });
      collector.discovery({ query: 'add a second service address' }, MISS);
      await expect(collector.flush({ reply: DECLINE })).resolves.toBeUndefined();
    });

    test('the decline check recognizes the phrasings the bar uses', () => {
      const { _private: { DECLINE_RE } } = load();
      for (const reply of ["I can't merge records directly", 'I cannot deactivate it from the bar', 'I could not find a way to do that.',
        "There's no tool in this bar that adds a property", "I don't have a tool for refunds", 'That isn’t available from here']) {
        expect(DECLINE_RE.test(reply)).toBe(true);
      }
      expect(DECLINE_RE.test('Done — the visit moved to Thursday at 9 AM.')).toBe(false);
    });
  });
});

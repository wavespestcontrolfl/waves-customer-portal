'use strict';

describe('agent-gap-reports', () => {
  let dbMock;
  let insertedRows;
  let mergedCalls;
  let returningRows;
  let loggerMock;
  let sightings;
  let priorRow;
  let belledUpdates;
  let savepointMock;
  let notifyMock;
  let digestMock;

  beforeEach(() => {
    jest.resetModules();
    delete process.env.AGENT_GAP_REPORTS;
    insertedRows = [];
    mergedCalls = [];
    returningRows = [{ id: '7', occurrences: 1, status: 'new', domain: null, xmax: '0' }];
    priorRow = undefined;
    belledUpdates = [];
    notifyMock = jest.fn().mockResolvedValue({ id: 'n1' });
    digestMock = jest.fn().mockResolvedValue({ ok: true, channel: 'in_app', id: 'd1' });
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
            forUpdate: jest.fn(() => ({ first: jest.fn(async () => priorRow) })),
            update: jest.fn((fields) => {
              if (fields && fields.belled_at) { belledUpdates.push(fields); return Promise.resolve(1); }
              return { returning: jest.fn().mockResolvedValue([{ id: '7', kind: 'missing_capability', occurrences: 1, ...fields }]) };
            }),
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
    // The row transaction, with its own savepoint (the bell is written in one).
    const trx = jest.fn((name) => table(name));
    trx.raw = table.raw;
    savepointMock = jest.fn(async (work) => work(trx));
    trx.transaction = savepointMock;
    dbMock.transaction = jest.fn(async (work) => work(trx));

    jest.doMock('../models/db', () => dbMock);
    jest.doMock('../services/logger', () => loggerMock);
    jest.doMock('../services/notification-service', () => ({ notifyAdmin: notifyMock }));
    jest.doMock('../services/ops-digest', () => ({ deliverOpsDigest: digestMock }));
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

    test('the description is stored as written, with no name or contact scrubbing (owner 2026-09-28)', () => {
      const { _private: { prepareGapRow } } = load();
      const row = prepareGapRow({ source: 'intelligence-bar', kind: 'missing_capability',
        summary: 'add property manager zoë at 12 Palm Row,  dana@example.com' });
      expect(row.summary).toBe('add property manager zoë at 12 Palm Row, dana@example.com');
    });

    test("the server's own phrasing is stored as written", () => {
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
      expect(saved).toEqual([{ id: 7, occurrences: 1, status: 'new', domain: null, rang: true, reopened: false }]);
      const merge = mergedCalls[0];
      expect(merge.occurrences.__raw).toMatch(/occurrences \+ 1/);
      expect(merge.status.__raw).toMatch(/WHEN agent_gap_reports.status = 'fixed' THEN 'new'/);
      expect(merge.domain.__raw).toMatch(/COALESCE\(agent_gap_reports.domain, EXCLUDED.domain\)/);
      expect(merge.closest_tool.__raw).toMatch(/COALESCE\(agent_gap_reports.closest_tool, EXCLUDED.closest_tool\)/);
      expect(merge.attempted.__raw).toMatch(/COALESCE\(EXCLUDED.attempted, agent_gap_reports.attempted\)/);
      expect(merge.belled_at.__raw).toMatch(/WHEN agent_gap_reports.status = 'fixed' THEN NULL ELSE agent_gap_reports.belled_at/);
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

    test('uses a supplied transaction executor instead of the root database', async () => {
      const { writeGapRows } = load();
      const boundedExecutor = { transaction: savepointMock };
      await writeGapRows([{
        source: 'intelligence-bar', kind: 'missing_capability', summary: 'add a second service address',
      }], boundedExecutor);
      expect(savepointMock).toHaveBeenCalled();
      expect(dbMock.transaction).not.toHaveBeenCalled();
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

  describe('the admin bell when a gap is recorded', () => {
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    const signal = (over = {}) => ({ source: 'texting-ai', kind: 'missing_capability', summary: 'reschedule a recurring series', domain: 'scheduling', ...over });

    test('a first sighting rings once, inside the row transaction, with the two short lines', async () => {
      const { writeGapRows } = load();
      returningRows = [{ id: '7', occurrences: 1, status: 'new', domain: 'scheduling', xmax: '0' }];
      const saved = await writeGapRows([signal({ domain: 'scheduling' })]);
      await flush();
      expect(saved[0]).toMatchObject({ id: 7, rang: true, reopened: false });
      expect(notifyMock).toHaveBeenCalledTimes(1);
      const [category, title, body, opts] = notifyMock.mock.calls[0];
      expect(category).toBe('agents');
      expect(title).toBe('Gap #7: texting assistant (scheduling)');
      expect(body).toBe('Say "build gap #7" in any Claude session to start a PR.');
      expect(opts.bell).toBe(true);
      expect(opts.dedupeKey).toMatch(/^agent-gap:7:\d{4}-\d{2}-\d{2}T/);
    });

    test('a repeat of an open gap (new, building, by_design, dismissed) is silent', async () => {
      const { writeGapRows } = load();
      for (const status of ['new', 'building', 'by_design', 'dismissed']) {
        priorRow = { status, belled_at: new Date() };
        returningRows = [{ id: '7', occurrences: 4, status, domain: 'scheduling', xmax: '12345' }];
        const [saved] = await writeGapRows([signal()]);
        expect(saved.rang).toBe(false);
      }
      await flush();
      expect(notifyMock).not.toHaveBeenCalled();
    });

    test('a fixed gap that happens again reopens to new and rings again as "is back"', async () => {
      const { writeGapRows } = load();
      priorRow = { status: 'fixed' };
      returningRows = [{ id: '7', occurrences: 5, status: 'new', domain: 'scheduling', xmax: '12345' }];
      const [saved] = await writeGapRows([signal({ source: 'texting-ai' })]);
      await flush();
      expect(saved).toMatchObject({ rang: true, reopened: true });
      expect(notifyMock).toHaveBeenCalledTimes(1);
      const [, title, body, opts] = notifyMock.mock.calls[0];
      expect(title).toBe('Gap #7 is back: texting assistant (scheduling)');
      expect(body).toBe('Say "build gap #7" in any Claude session to start a PR.');
      expect(opts.metadata).toMatchObject({ gapId: 7, reopened: true });
    });

    // Owner 2026-10-01: "A Claude window on the Mac starts building it" is Claude
    // work. It is an engineering row in the Activity feed, never a bell row.
    test.each(['intelligence-bar', 'tech-bar'])('a %s gap (a Claude window builds it) goes to the Activity feed, never the bell', async (source) => {
      const { writeGapRows } = load();
      returningRows = [{ id: '7', occurrences: 1, status: 'new', domain: 'scheduling', xmax: '0' }];
      const [saved] = await writeGapRows([signal({ source })]);
      await flush();
      expect(saved).toMatchObject({ id: 7, rang: true, reopened: false });
      expect(notifyMock).not.toHaveBeenCalled();
      expect(digestMock).toHaveBeenCalledTimes(1);
      const arg = digestMock.mock.calls[0][0];
      expect(arg).toMatchObject({
        key: 'agent-gap', audience: 'engineering', link: '/admin/agents',
        subject: expect.stringMatching(/^FIX: Gap #7/),
        headline: expect.stringMatching(/^Gap #7: (bar|tech bar) \(scheduling\)$/),
        summary: 'A Claude window on the Mac starts building it within 10 min.',
        metadata: { gapId: 7, source, reopened: false },
      });
      expect(arg.dedupeKey).toMatch(/^agent-gap:7:\d{4}-\d{2}-\d{2}T/);
      expect(arg.trx).toBeDefined();
      expect(belledUpdates).toHaveLength(1);
    });

    // The seam derives the row's kind from the subject: an unprefixed one reads as
    // FYI (completed in Activity, dropped by needs-me). The FIX: prefix keeps the
    // open gap actionable.
    test('the digest subject classifies as an actionable engineering finding, not FYI', () => {
      jest.dontMock('../services/ops-digest');
      const real = jest.requireActual('../services/ops-digest');
      const { gapBellText } = load()._private;
      const { title, body } = gapBellText({ id: 7, source: 'intelligence-bar', domain: 'scheduling' });
      const fields = real.digestRowFields({ subject: `FIX: ${title}`, headline: title, summary: body, audience: 'engineering' });
      expect(fields).toMatchObject({ kind: 'FIX', audience: 'engineering', feed: 'activity', title: 'Gap #7: bar (scheduling)' });
      expect(real.digestRowFields({ subject: title, headline: title, audience: 'engineering' }).kind).toBe('FYI');
    });

    // GATE_OPS_DIGESTS_IN_APP / GATE_AGENT_ACTIVITY off (the default): deliverOpsDigest
    // takes its email path and writes no row. The gap must not be stamped as rung
    // for nothing: it falls back to the bell.
    test.each([
      ['feed off (email path)', { ok: true, channel: 'email' }],
      ['digest row not written (fallback)', { ok: true, channel: 'email', fallback: true }],
    ])('a Claude-built gap falls back to the bell when the Activity feed is unavailable: %s', async (_n, outcome) => {
      const { writeGapRows } = load();
      digestMock.mockResolvedValue(outcome);
      returningRows = [{ id: '7', occurrences: 1, status: 'new', domain: 'scheduling', xmax: '0' }];
      const [saved] = await writeGapRows([signal({ source: 'intelligence-bar' })]);
      await flush();
      expect(saved).toMatchObject({ rang: true });
      expect(notifyMock).toHaveBeenCalledTimes(1);
      const [category, title, body, opts] = notifyMock.mock.calls[0];
      expect(category).toBe('agents');
      expect(title).toBe('Gap #7: bar (scheduling)');
      expect(body).toBe('A Claude window on the Mac starts building it within 10 min.');
      expect(opts.bell).toBe(true);
      expect(belledUpdates).toHaveLength(1);
    });

    test('a Claude-built gap stamps belled_at only once a row really landed: neither path writing leaves it unset', async () => {
      const { writeGapRows } = load();
      digestMock.mockResolvedValue({ ok: true, channel: 'email' });
      notifyMock.mockResolvedValue(null);
      const [saved] = await writeGapRows([signal({ source: 'tech-bar' })]);
      expect(saved.rang).toBe(false);
      expect(belledUpdates).toHaveLength(0);
    });

    test('a Claude-built gap that is back rings the Activity feed as "is back", and a digest row that was not written leaves belled_at unset', async () => {
      const { writeGapRows } = load();
      priorRow = { status: 'fixed' };
      returningRows = [{ id: '7', occurrences: 5, status: 'new', domain: 'scheduling', xmax: '12345' }];
      await writeGapRows([signal({ source: 'intelligence-bar' })]);
      expect(digestMock.mock.calls[0][0].headline).toBe('Gap #7 is back: bar (scheduling)');
      expect(belledUpdates).toHaveLength(1);
      belledUpdates = [];
      digestMock.mockResolvedValue({ ok: false, channel: 'in_app', id: null });
      notifyMock.mockResolvedValue(null);
      const [retry] = await writeGapRows([signal({ source: 'intelligence-bar' })]);
      expect(retry.rang).toBe(false);
      expect(belledUpdates).toHaveLength(0);
    });

    test('an open gap recorded before the per-gap bell (belled_at NULL) rings on its next sighting and is stamped', async () => {
      const { writeGapRows } = load();
      for (const status of ['new', 'building']) {
        belledUpdates = [];
        priorRow = { status, belled_at: null };
        returningRows = [{ id: '7', occurrences: 3, status, domain: 'scheduling', xmax: '555' }];
        const [saved] = await writeGapRows([signal()]);
        expect(saved).toMatchObject({ rang: true, reopened: false });
        expect(belledUpdates).toHaveLength(1);
      }
      await flush();
      expect(notifyMock).toHaveBeenCalledTimes(2);
      expect(notifyMock.mock.calls[0][1]).toBe('Gap #7: texting assistant (scheduling)');
    });

    test('an open gap that already rang stays quiet, and by_design / dismissed with NULL belled_at never ring', async () => {
      const { writeGapRows } = load();
      priorRow = { status: 'new', belled_at: new Date() };
      returningRows = [{ id: '7', occurrences: 3, status: 'new', domain: null, xmax: '555' }];
      expect((await writeGapRows([signal()]))[0].rang).toBe(false);
      for (const status of ['by_design', 'dismissed']) {
        priorRow = { status, belled_at: null };
        returningRows = [{ id: '7', occurrences: 3, status, domain: null, xmax: '555' }];
        expect((await writeGapRows([signal()]))[0].rang).toBe(false);
      }
      await flush();
      expect(notifyMock).not.toHaveBeenCalled();
      expect(belledUpdates).toHaveLength(0);
    });

    test('a bell stamps belled_at in a savepoint of the row transaction, on insert and on reopen', async () => {
      const { writeGapRows } = load();
      await writeGapRows([signal()]);
      expect(insertedRows[0].belled_at).toBeUndefined();
      expect(savepointMock).toHaveBeenCalledTimes(1);
      expect(notifyMock.mock.calls[0][3].trx).toBeDefined();
      expect(belledUpdates).toHaveLength(1);
      priorRow = { status: 'fixed', belled_at: new Date() };
      returningRows = [{ id: '7', occurrences: 2, status: 'new', domain: null, xmax: '9' }];
      await writeGapRows([signal()]);
      expect(belledUpdates).toHaveLength(2);
    });

    test('a reopen and the first sighting have different dedupe keys', async () => {
      const { writeGapRows } = load();
      await writeGapRows([signal()]);
      await new Promise((resolve) => setTimeout(resolve, 5));
      priorRow = { status: 'fixed' };
      returningRows = [{ id: '7', occurrences: 2, status: 'new', domain: null, xmax: '99' }];
      await writeGapRows([signal()]);
      await flush();
      expect(notifyMock).toHaveBeenCalledTimes(2);
      expect(notifyMock.mock.calls[0][3].dedupeKey).not.toBe(notifyMock.mock.calls[1][3].dedupeKey);
    });

    test('the AGENT_GAP_REPORTS=off kill switch rings nothing', async () => {
      process.env.AGENT_GAP_REPORTS = 'off';
      const { writeGapRows, _private: { ringGapBell } } = load();
      await writeGapRows([signal()]);
      expect(await ringGapBell(null, { id: 7, source: 'texting-ai', domain: null, at: new Date() })).toBe(false);
      await flush();
      expect(notifyMock).not.toHaveBeenCalled();
    });

    test('a bell failure never throws or fails the record, and logs only the error code', async () => {
      const { writeGapRows } = load();
      notifyMock.mockRejectedValue(Object.assign(new Error('boom customer text'), { code: 'ECONNRESET' }));
      const saved = await writeGapRows([signal()]);
      await flush();
      expect(saved).toHaveLength(1);
      expect(loggerMock.warn).toHaveBeenCalledWith('[agent-gap-reports] bell failed (ECONNRESET)');
    });

    test('a failed bell leaves belled_at unset (next sighting rings) and still saves the sighting', async () => {
      const { writeGapRows } = load();
      notifyMock.mockRejectedValue(Object.assign(new Error('down'), { code: 'ECONNRESET' }));
      const saved = await writeGapRows([signal()]);
      expect(saved).toHaveLength(1);
      expect(saved[0].rang).toBe(false);
      expect(sightings).toHaveLength(1);
      expect(belledUpdates).toHaveLength(0);
    });

    test('a bell notifyAdmin did not write (null) also leaves belled_at unset', async () => {
      const { writeGapRows } = load();
      notifyMock.mockResolvedValue(null);
      await writeGapRows([signal()]);
      expect(belledUpdates).toHaveLength(0);
      expect(loggerMock.warn).toHaveBeenCalledWith('[agent-gap-reports] bell failed (NOT_WRITTEN)');
    });

    test('a delivered bell stamps belled_at', async () => {
      const { writeGapRows } = load();
      const saved = await writeGapRows([signal()]);
      expect(notifyMock).toHaveBeenCalledTimes(1);
      expect(saved[0].rang).toBe(true);
      expect(belledUpdates).toHaveLength(1);
    });

    test('title and body stay short for every source, and the title never carries the summary', () => {
      const { _private: { gapBellText, SOURCE_LABELS } } = load();
      for (const source of [...Object.keys(SOURCE_LABELS), 'something-else']) {
        for (const reopened of [false, true]) {
          const { title, body } = gapBellText({ id: 1234567, source, domain: 'communications', reopened });
          expect(body.length).toBeLessThanOrEqual(110);
          expect(title.split('\n')).toHaveLength(1);
          expect(title).toMatch(/^Gap #1234567( is back)?: /);
        }
      }
      expect(gapBellText({ id: 3, source: 'tech-bar', domain: null }).title).toBe('Gap #3: tech bar (other)');
      expect(gapBellText({ id: 3, source: 'phone-agent', domain: null }).body).toBe('Say "build gap #3" in any Claude session to start a PR.');
    });
  });

  describe('recordGap', () => {
    test('writes one row for a source with no per-request collector', async () => {
      const { recordGap } = load();
      const saved = await recordGap({ source: 'texting-ai', summary: 'Customer asked about a service we do not offer',
        attempted: 'Customer text: does Waves do pool cleaning?' });
      expect(saved).toEqual([{ id: 7, occurrences: 1, status: 'new', domain: null, rang: true, reopened: false }]);
      expect(insertedRows[0]).toMatchObject({ source: 'texting-ai', kind: 'missing_capability',
        summary: 'Customer asked about a service we do not offer' });
    });

    test('never throws when the write rejects', async () => {
      dbMock.transaction.mockImplementation(async () => { throw new Error('down'); });
      const { recordGap } = load();
      await expect(recordGap({ source: 'phone-agent', summary: 'wants pool service', attempted: 'Handed to the office' }))
        .resolves.toEqual([]);
    });

    test('the AGENT_GAP_REPORTS=off kill switch writes nothing', async () => {
      process.env.AGENT_GAP_REPORTS = 'off';
      const { recordGap } = load();
      await expect(recordGap({ source: 'phone-agent', summary: 'x' })).resolves.toEqual([]);
      expect(dbMock).not.toHaveBeenCalled();
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

    test('a tool name the registry does not have is recorded as a missing capability', async () => {
      const { createGapCollector } = load();
      const collector = createGapCollector({ source: 'intelligence-bar', isRegisteredTool: () => false });
      collector.toolResult('create_property', { error: 'no such tool', code: 'capability_unimplemented' }, true);
      await collector.flush({ reply: DECLINE });
      expect(insertedRows[0]).toMatchObject({ kind: 'missing_capability', closest_tool: 'create_property', summary: 'Asked for a tool the bar does not have: create_property' });
    });

    test("a registered tool refusing a case keeps the tool's own description, not 'does not exist'", async () => {
      const { createGapCollector } = load();
      const collector = createGapCollector({ source: 'intelligence-bar', isRegisteredTool: (name) => name === 'save_customer_estimate' });
      collector.toolResult('save_customer_estimate', { error: 'Commercial estimates are not supported by this tool', code: 'capability_unimplemented' }, true);
      await collector.flush({ reply: DECLINE });
      expect(insertedRows[0]).toMatchObject({ closest_tool: 'save_customer_estimate', attempted: 'The tool exists but does not support this case',
        summary: 'save_customer_estimate: Commercial estimates are not supported by this tool' });
    });

    test('declined with no signals gathered records the ask itself (the tech-bar fallback, no discovery loop)', async () => {
      const { createGapCollector } = load();
      const collector = createGapCollector({ source: 'tech-bar' });
      await collector.flush({ reply: DECLINE, ask: '  Can you add a note to my next stop?  ' });
      expect(insertedRows).toHaveLength(1);
      expect(insertedRows[0]).toMatchObject({ source: 'tech-bar', kind: 'missing_capability',
        summary: 'Can you add a note to my next stop?', attempted: 'The bar declined; no capability search ran' });
    });

    test('a decline after a tool genuinely failed records no ask — an outage, not a missing feature', async () => {
      const { createGapCollector } = load();
      const collector = createGapCollector({ source: 'tech-bar' });
      collector.toolResult('get_weather_conditions', { error: 'Weather API unavailable' }, true);
      await collector.flush({ reply: DECLINE, ask: 'what is the weather at my next stop' });
      expect(insertedRows).toHaveLength(0);
    });

    test('a field answer that merely says "not supported" is not a bar refusal — no ask recorded', async () => {
      const { createGapCollector } = load();
      const collector = createGapCollector({ source: 'tech-bar' });
      await collector.flush({ reply: 'That tank mix is not supported by the label, so use the separate rinse.', ask: 'can I tank mix these two' });
      expect(insertedRows).toHaveLength(0);
    });

    test('declined with no signals and no ask records nothing', async () => {
      const { createGapCollector } = load();
      const collector = createGapCollector({ source: 'tech-bar' });
      await collector.flush({ reply: DECLINE, ask: '   ' });
      expect(insertedRows).toHaveLength(0);
    });

    test('declined WITH signals gathered ignores ask — existing collected signals are unchanged', async () => {
      const { createGapCollector } = load();
      const collector = createGapCollector({ source: 'intelligence-bar' });
      collector.discovery({ query: 'add a second service address', domain: 'customers' }, MISS);
      await collector.flush({ reply: DECLINE, ask: 'a completely different ask' });
      expect(insertedRows).toHaveLength(1);
      expect(insertedRows[0]).toMatchObject({ summary: 'add a second service address' });
    });

    test('not declined records nothing, ask or no ask', async () => {
      const { createGapCollector } = load();
      const collector = createGapCollector({ source: 'tech-bar' });
      await collector.flush({ reply: "Here's your route for today.", ask: 'what is my route today?' });
      expect(insertedRows).toHaveLength(0);
    });

    test('flush never rejects, even when the database throws', async () => {
      dbMock.transaction.mockImplementation(async () => { throw new Error('down'); });
      const { createGapCollector } = load();
      const collector = createGapCollector({ source: 'intelligence-bar' });
      collector.discovery({ query: 'add a second service address' }, MISS);
      await expect(collector.flush({ reply: DECLINE })).resolves.toBeUndefined();
    });

    test('the decline check recognizes refusals the bar has actually given', () => {
      const { _private: { DECLINE_RE } } = load();
      for (const reply of ["I can't merge records directly", 'I cannot deactivate, edit, or delete it from the bar',
        'I could not find a way to do that from the bar.', "There's no tool in this bar that adds a property",
        "I don't have an inventory tool in this bar", 'That isn’t available from here', 'Recurring series edits are not supported yet',
        'This is a system issue I can’t work around from here', 'There is no way to issue a refund']) {
        expect(DECLINE_RE.test(reply)).toBe(true);
      }
    });

    test('a read that worked but found nothing, or a request missing information, is not a decline', () => {
      const { _private: { DECLINE_RE } } = load();
      for (const reply of ["I couldn't find any matching invoices", 'that time is not available', "I can't confirm the price without the invoice",
        "I can't switch it without the rental's street address", 'Done — the visit moved to Thursday at 9 AM.']) {
        expect(DECLINE_RE.test(reply)).toBe(false);
      }
    });
  });

  describe('gapWindowCutoff', () => {
    test('reaches the prior Monday 08:15 ET across the fall DST change (169 hours)', () => {
      const { _private: { gapWindowCutoff } } = load();
      const run = new Date('2026-11-02T13:15:00Z'); // Mon 08:15 EST
      expect(gapWindowCutoff(7, run).toISOString()).toBe('2026-10-26T12:15:00.000Z'); // Mon 08:15 EDT
    });

    test('reaches the prior Monday 08:15 ET across the spring DST change (167 hours)', () => {
      const { _private: { gapWindowCutoff } } = load();
      const run = new Date('2027-03-15T12:15:00Z'); // Mon 08:15 EDT
      expect(gapWindowCutoff(7, run).toISOString()).toBe('2027-03-08T13:15:00.000Z'); // Mon 08:15 EST
    });

    test('an ordinary week is exactly seven days back', () => {
      const { _private: { gapWindowCutoff } } = load();
      const run = new Date('2026-10-05T12:15:00Z');
      expect(gapWindowCutoff(7, run).toISOString()).toBe('2026-09-28T12:15:00.000Z');
    });
  });
});

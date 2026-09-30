// writeGapRows()'s upsert and list_gap_reports' grouping/ordering against
// real PostgreSQL (server/models/migrations/20260928160000_agent_gap_reports.js
// must be applied to DATABASE_URL first).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// The bell writer is stubbed: this suite shares CI's database with the other
// DB-gated suites, so it must not leave `agents` notification rows behind.
// notifyAdmin receives the gap row's savepoint as opts.trx.
const mockNotifyAdmin = jest.fn(async () => ({ id: 1 }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...args) => mockNotifyAdmin(...args) }));

postgres('agent-gap-reports against PostgreSQL', () => {
  let db;
  let writeGapRows;
  let listGapReports;
  const source = `test-source-${Date.now()}`;
  const insertedIds = [];

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use a disposable local database');
    db = require('../models/db');
    if (!(await db.schema.hasTable('agent_gap_reports'))) {
      throw new Error('Apply migration 20260928160000_agent_gap_reports to this database first');
    }
    ({ writeGapRows } = require('../services/agent-gap-reports'));
    // list_gap_reports is a plain function inside gap-report-tools.js's TOOLS
    // dispatcher; exercise it through executeGapReportTool exactly as the
    // route does.
    const gapTools = require('../services/intelligence-bar/gap-report-tools');
    listGapReports = (input) => gapTools.executeGapReportTool('list_gap_reports', input);
  }, 30000);

  afterEach(async () => {
    if (insertedIds.length) {
      await db('agent_gap_reports').whereIn('id', insertedIds).del();
      insertedIds.length = 0;
    }
  });

  afterAll(async () => { await db?.destroy(); });

  async function record(overrides = {}) {
    const [result] = await writeGapRows([{ source, kind: 'missing_capability', summary: 'Synthetic gap for db test', ...overrides }]);
    if (result?.id && !insertedIds.includes(result.id)) insertedIds.push(result.id);
    return result;
  }

  test('list_gap_reports leaves out gaps already marked fixed, by_design or dismissed', async () => {
    const open = await record({ summary: 'Synthetic list gap still open' });
    const fixed = await record({ summary: 'Synthetic list gap fixed after its last sighting' });
    await db('agent_gap_reports').where('id', fixed.id).update({ status: 'fixed' });
    const result = await listGapReports({ days: 1 });
    const ids = result.groups.flatMap((d) => d.gaps || []).map((g) => g.gap_id);
    expect(ids).toContain(open.id);
    expect(ids).not.toContain(fixed.id);
  });

  test('rang is true on the first sighting and a fixed reopen, false on a repeat of an open gap', async () => {
    const first = await record({ summary: 'Synthetic ring detection gap' });
    expect(first.rang).toBe(true);
    const repeat = await record({ summary: 'Synthetic ring detection gap' });
    expect(repeat.rang).toBe(false);
    await db('agent_gap_reports').where('id', first.id).update({ status: 'fixed' });
    const reopened = await record({ summary: 'Synthetic ring detection gap' });
    expect(reopened).toMatchObject({ rang: true, reopened: true, status: 'new' });
    await db('agent_gap_reports').where('id', first.id).update({ status: 'building' });
    expect((await record({ summary: 'Synthetic ring detection gap' })).rang).toBe(false);
  });

  test('a pre-cutover open gap (belled_at NULL) rings on its next sighting, then is quiet; by_design / dismissed never ring; an insert stamps belled_at', async () => {
    const first = await record({ summary: 'Synthetic legacy belled gap' });
    expect((await db('agent_gap_reports').where('id', first.id).first('belled_at')).belled_at).not.toBeNull();
    await db('agent_gap_reports').where('id', first.id).update({ belled_at: null });
    const legacy = await record({ summary: 'Synthetic legacy belled gap' });
    expect(legacy).toMatchObject({ rang: true, reopened: false });
    expect((await db('agent_gap_reports').where('id', first.id).first('belled_at')).belled_at).not.toBeNull();
    expect((await record({ summary: 'Synthetic legacy belled gap' })).rang).toBe(false);
    for (const status of ['dismissed', 'by_design']) {
      await db('agent_gap_reports').where('id', first.id).update({ status, belled_at: null });
      expect((await record({ summary: 'Synthetic legacy belled gap' })).rang).toBe(false);
      expect((await db('agent_gap_reports').where('id', first.id).first('belled_at')).belled_at).toBeNull();
    }
  });

  test('list_gap_reports reports the real matching total and has_more when it caps the rows', async () => {
    for (let i = 0; i < 51; i += 1) await record({ summary: `Synthetic capped gap ${source} ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))} alpha` });
    const result = await listGapReports({ days: 1 });
    expect(result.returned).toBe(50);
    expect(result.total_matching).toBeGreaterThanOrEqual(51);
    expect(result.has_more).toBe(true);
    expect(result.note).toMatch(/most-seen of/);
  });

  test('a recurrence fills in the domain and tool the first sighting lacked and keeps the latest attempt', async () => {
    const first = await record({ summary: 'Synthetic enrichment gap', attempted: 'first try' });
    const second = await record({ summary: 'Synthetic enrichment gap', domain: 'customers', closestTool: 'update_customer', attempted: 'second try' });
    expect(second.id).toBe(first.id);
    const row = await db('agent_gap_reports').where('id', first.id).first();
    expect(row).toMatchObject({ domain: 'customers', closest_tool: 'update_customer', attempted: 'second try', occurrences: 2 });
    const third = await record({ summary: 'Synthetic enrichment gap', domain: 'schedule' });
    const after = await db('agent_gap_reports').where('id', third.id).first();
    expect(after).toMatchObject({ domain: 'customers', attempted: 'second try', occurrences: 3 });
  });

  test('a recurrence of the same gap increments occurrences and bumps last_seen_at', async () => {
    const first = await record({ summary: 'Add a second service address to a customer' });
    expect(first.occurrences).toBe(1);
    const before = await db('agent_gap_reports').where('id', first.id).first('last_seen_at');

    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await record({ summary: 'Add a second service address to a customer' });
    expect(second.id).toBe(first.id);
    expect(second.occurrences).toBe(2);

    const after = await db('agent_gap_reports').where('id', first.id).first('last_seen_at');
    expect(new Date(after.last_seen_at).getTime()).toBeGreaterThan(new Date(before.last_seen_at).getTime());
  });

  test('a recurrence on a fixed gap reopens it as new; building stays building', async () => {
    const fixed = await record({ summary: 'A gap the owner already fixed once' });
    await db('agent_gap_reports').where('id', fixed.id).update({ status: 'fixed' });
    const reopened = await record({ summary: 'A gap the owner already fixed once' });
    expect(reopened.id).toBe(fixed.id);
    expect(reopened.status).toBe('new');
    expect(reopened.occurrences).toBe(2);

    const building = await record({ summary: 'A gap already in progress' });
    await db('agent_gap_reports').where('id', building.id).update({ status: 'building' });
    const recurred = await record({ summary: 'A gap already in progress' });
    expect(recurred.status).toBe('building');
  });

  test('by_design and dismissed gaps stay in their status across a recurrence', async () => {
    const byDesign = await record({ summary: 'A gap the owner ruled by design' });
    await db('agent_gap_reports').where('id', byDesign.id).update({ status: 'by_design' });
    const recurredByDesign = await record({ summary: 'A gap the owner ruled by design' });
    expect(recurredByDesign.status).toBe('by_design');

    const dismissed = await record({ summary: 'A gap the owner dismissed' });
    await db('agent_gap_reports').where('id', dismissed.id).update({ status: 'dismissed' });
    const recurredDismissed = await record({ summary: 'A gap the owner dismissed' });
    expect(recurredDismissed.status).toBe('dismissed');
  });

  test('every hit writes a sighting, and a window counts only its own sightings', async () => {
    const gap = await record({ summary: 'Synthetic windowed gap' });
    await record({ summary: 'Synthetic windowed gap' });
    // Two older sightings, outside a 7-day window but inside 30 days.
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    await db('agent_gap_report_sightings').insert([{ gap_id: gap.id, seen_at: old }, { gap_id: gap.id, seen_at: old }]);
    await db('agent_gap_reports').where('id', gap.id).update({ occurrences: 4 });
    expect(Number((await db('agent_gap_report_sightings').where('gap_id', gap.id).count('* as n'))[0].n)).toBe(4);
    const week = (await listGapReports({ days: 7 })).groups.flatMap((g) => g.gaps).find((g) => g.gap_id === gap.id);
    expect(week).toMatchObject({ times_seen_in_window: 2, times_seen_total: 4 });
    const month = (await listGapReports({ days: 30 })).groups.flatMap((g) => g.gaps).find((g) => g.gap_id === gap.id);
    expect(month.times_seen_in_window).toBe(4);
  });

  test('a gap busy this week outranks one with more lifetime hits but fewer this week', async () => {
    const veteran = await record({ summary: 'Synthetic veteran gap', domain: 'ops' });
    await db('agent_gap_reports').where('id', veteran.id).update({ occurrences: 100 });
    const fresh = await record({ summary: 'Synthetic fresh gap', domain: 'ops' });
    await record({ summary: 'Synthetic fresh gap', domain: 'ops' });
    await record({ summary: 'Synthetic fresh gap', domain: 'ops' });
    const ids = (await listGapReports({ days: 7 })).groups.find((g) => g.domain === 'ops').gaps.map((g) => g.gap_id);
    expect(ids.indexOf(fresh.id)).toBeLessThan(ids.indexOf(veteran.id));
  });

  test('setGapStatus moves a gap through the lifecycle; closed statuses leave the default list', async () => {
    const { setGapStatus } = require('../services/agent-gap-reports');
    const gap = await record({ summary: 'Synthetic gap the owner rules by design' });
    await expect(setGapStatus(gap.id, 'by_design')).resolves.toMatchObject({ status: 'by_design' });
    const ids = (await listGapReports({ days: 7 })).groups.flatMap((g) => g.gaps).map((g) => g.gap_id);
    expect(ids).not.toContain(gap.id);
    await expect(setGapStatus(gap.id, 'shipped')).rejects.toThrow(/status must be one of/);
    await expect(setGapStatus(987654321, 'fixed')).resolves.toBeNull();
  });

  test('list_gap_reports groups by domain, orders by occurrence volume, and excludes closed statuses by default', async () => {
    const heavy = await record({ summary: 'Heavy hit gap in ops domain', domain: 'ops' });
    for (let i = 0; i < 3; i += 1) await record({ summary: 'Heavy hit gap in ops domain', domain: 'ops' });
    const light = await record({ summary: 'Light hit gap with no domain' });
    const closed = await record({ summary: 'A closed gap that should be excluded by default', domain: 'ops' });
    await db('agent_gap_reports').where('id', closed.id).update({ status: 'dismissed' });

    const result = await listGapReports({ days: 1, include_closed: false });
    expect(result.window_days).toBe(1);
    const opsGroup = result.groups.find((g) => g.domain === 'ops');
    const otherGroup = result.groups.find((g) => g.domain === 'other');
    expect(opsGroup).toBeTruthy();
    expect(otherGroup).toBeTruthy();
    // ops (4 occurrences on the heavy gap) outranks other (1 occurrence).
    expect(result.groups.indexOf(opsGroup)).toBeLessThan(result.groups.indexOf(otherGroup));
    expect(opsGroup.gaps[0].gap_id).toBe(heavy.id);
    expect(opsGroup.gaps[0].times_seen_in_window).toBe(4);
    expect(opsGroup.gaps[0].times_seen_total).toBe(4);
    expect(opsGroup.gaps.some((g) => g.gap_id === closed.id)).toBe(false);
    expect(otherGroup.gaps.some((g) => g.gap_id === light.id)).toBe(true);
    expect(result.note).toMatch(/gap #/);

    const withClosed = await listGapReports({ days: 1, include_closed: true });
    const opsGroupClosed = withClosed.groups.find((g) => g.domain === 'ops');
    expect(opsGroupClosed.gaps.some((g) => g.gap_id === closed.id)).toBe(true);
  });

  test('a bell that fails inside its savepoint (aborted statement, null result) leaves the sighting saved and belled_at NULL', async () => {
    mockNotifyAdmin.mockImplementationOnce(async (_c, _t, _b, opts) => {
      // Same shape as notification-service's create(): a failed statement on
      // the caller's connection, caught, returned as null.
      try { await opts.trx.raw('SELECT 1/0'); } catch { return null; }
      return { id: 1 };
    });
    const gap = await record({ summary: 'Synthetic failed bell gap' });
    expect(gap.rang).toBe(false);
    const row = await db('agent_gap_reports').where('id', gap.id).first('belled_at', 'occurrences');
    expect(row).toMatchObject({ belled_at: null, occurrences: 1 });
    expect(Number((await db('agent_gap_report_sightings').where('gap_id', gap.id).count('* as n'))[0].n)).toBe(1);
    const next = await record({ summary: 'Synthetic failed bell gap' });
    expect(next.rang).toBe(true);
    expect((await db('agent_gap_reports').where('id', gap.id).first('belled_at')).belled_at).not.toBeNull();
  });
});

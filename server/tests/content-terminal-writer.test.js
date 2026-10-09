// Terminal writer hand-off (GATE_CONTENT_WRITER_TERMINAL): the daily content
// run lists due posts instead of drafting them. Proves the sort (due / open PR
// / merged PR), the day and week caps, that only the daily run completes a
// merged row, and that one admin item is raised only when a post is due.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { terminalWriterWork, handOffToTerminal, terminalWriterLive, branchFor, SETTLED_REASON } = require('../services/content/terminal-writer');
const { composeAdminAlert } = require('../services/admin-alert-compose');

// Queue ids are UUIDs; the tests name them by one letter.
const uid = (c) => `00000000-0000-4000-8000-0000000000${c.charCodeAt(0).toString(16).padStart(2, '0')}`;
const row = (c, over = {}) => ({ id: uid(c), status: 'pending', action_type: 'new_supporting_blog', query: `ants in the kitchen ${c}`, score: 80, ...over });

const pr = (c, over = {}) => ({ head: { ref: `terminal-writer/${uid(c)}` }, base: { ref: 'main' }, html_url: `u/${c}`, state: 'open', merged_at: null, ...over });
const mergedPr = (c) => pr(c, { state: 'closed', merged_at: '2026-10-08T12:00:00Z' });

// open / closed: the GitHub pull lists. peek answers per action type, as the queue does.
function fakes({ rows, open = [], closed = [], doneThisWeek = 0, doneToday = 0, openKeys = [] }) {
  const updates = [];
  // the module asks the engine's publish counter for the day first, then the week
  const counts = [doneToday, doneThisWeek];
  let counted = 0;
  const query = (calls) => {
    const q = {
      where: (...a) => { calls.push(a); return q; },
      whereIn: (...a) => { calls.push(['in', ...a]); return q; },
      whereNot: (...a) => { calls.push(['not', ...a]); return q; },
      // rows by id, whatever their score or availability
      select: async () => rows.filter((r) => (calls.find((c) => c[0] === 'in' && c[1] === 'id') || [])[2]?.includes(r.id)),
      update: async (patch) => { updates.push({ where: calls, patch }); return 1; },
    };
    return q;
  };
  return {
    updates,
    deps: {
      queue: {
        peek: jest.fn(async ({ actionType, minScore }) => rows.filter((r) => r.action_type === actionType && r.score >= minScore)),
        recoverStaleClaims: jest.fn(async () => 0),
      },
      gh: {
        env: () => ({ owner: 'acme', repo: 'site', defaultBranch: 'main' }),
        ghFetchPaginated: jest.fn(async (path) => (path.includes('state=open') ? [...open, { head: { ref: 'content/other-pr' }, base: { ref: 'main' }, state: 'open' }, { head: { ref: 'terminal-writer/not-an-id' }, base: { ref: 'main' }, state: 'open' }] : closed)),
      },
      db: Object.assign(() => query([]), { raw: (sql, bindings) => ({ sql, bindings }) }),
      countPublishedSince: jest.fn(async (action) => (action === 'new_supporting_blog' ? counts[counted++ % 2] : 0)),
      raiseAdminAlert: jest.fn(async (category, spec) => { composeAdminAlert(spec); return { id: 'n1' }; }),
      episodes: { openAdminAlertKeys: jest.fn(async () => openKeys), closeAdminAlertKeys: jest.fn(async () => 0) },
    },
  };
}

describe('terminal writer hand-off', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_DAY = '3';
    process.env.AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_WEEK = '10';
  });
  afterEach(() => { process.env = { ...saved }; });

  test('the gate is on only for exactly "true"', () => {
    delete process.env.GATE_CONTENT_WRITER_TERMINAL;
    expect(terminalWriterLive()).toBe(false);
    process.env.GATE_CONTENT_WRITER_TERMINAL = '1';
    expect(terminalWriterLive()).toBe(false);
    process.env.GATE_CONTENT_WRITER_TERMINAL = 'true';
    expect(terminalWriterLive()).toBe(true);
  });

  test('a row with no PR is due and carries its branch; open and merged PRs are not due', async () => {
    const f = fakes({
      rows: [row('a'), row('b'), row('c'), row('d', { action_type: 'add_internal_links' }), row('e', { status: 'pending_review' })],
      open: [pr('a')],
      closed: [mergedPr('b')],
    });
    const work = await terminalWriterWork({ deps: f.deps });
    expect(work.due.map((r) => [r.id, r.branch])).toEqual([[uid('c'), branchFor(uid('c'))]]);
    expect(work.inProgress.map((r) => r.id)).toEqual([uid('a')]);
    expect(work.merged.map((r) => r.id)).toEqual([uid('b')]);
    // read-only by default: the merged row is not completed
    expect(f.updates).toEqual([]);
  });

  test('a PR closed without a merge leaves the row due', async () => {
    const f = fakes({ rows: [row('a')], closed: [pr('a', { state: 'closed' })] });
    expect((await terminalWriterWork({ deps: f.deps })).due.map((r) => r.id)).toEqual([uid('a')]);
  });

  test('due plus in progress stays inside the daily cap', async () => {
    const f = fakes({ rows: ['a', 'b', 'c', 'd', 'e'].map((c) => row(c)), open: [pr('a'), pr('b')] });
    expect((await terminalWriterWork({ deps: f.deps })).due.map((r) => r.id)).toEqual([uid('c')]);
  });

  test('an open or merged PR on a row below the score floor still uses its slot', async () => {
    const rows = ['a', 'b', 'c', 'd'].map((c) => row(c)).concat([row('y', { score: 1 }), row('z', { score: 1 })]);
    const open = fakes({ rows, open: [pr('y')] });
    expect((await terminalWriterWork({ deps: open.deps })).due.map((r) => r.id)).toEqual([uid('a'), uid('b')]);
    // nine done this week + one merged PR not settled yet = the week is full
    // (the clock is pinned to the day after the merge, inside the same week)
    const now = new Date('2026-10-09T13:00:00Z');
    const merged = fakes({ rows, closed: [mergedPr('z')], doneThisWeek: 9 });
    expect((await terminalWriterWork({ now, deps: merged.deps })).due).toEqual([]);
    // the daily run settles that merge by id
    await terminalWriterWork({ complete: true, now, deps: merged.deps });
    expect(merged.updates.map((u) => u.where[0])).toEqual([['id', uid('z')]]);
    // the engine's counter now holds that merge; the read-only pass did not add it twice
    expect(merged.deps.countPublishedSince).toHaveBeenCalledWith('new_supporting_blog', expect.any(Date));
  });

  test('a post merged today uses a daily slot; one merged on an earlier day does not', async () => {
    const now = new Date('2026-10-09T18:00:00Z');
    const rows = ['a', 'b', 'c', 'd'].map((c) => row(c));
    // x merged today and its row is still pending; one more row was completed today (either writer)
    const today = fakes({ rows: rows.concat([row('x')]), closed: [pr('x', { state: 'closed', merged_at: '2026-10-09T15:00:00Z' })], doneToday: 1 });
    expect((await terminalWriterWork({ now, deps: today.deps })).due.map((r) => r.id)).toEqual([uid('a')]);
    const earlier = fakes({ rows: rows.concat([row('x')]), closed: [pr('x', { state: 'closed', merged_at: '2026-10-08T15:00:00Z' })] });
    expect((await terminalWriterWork({ now, deps: earlier.deps })).due.map((r) => r.id)).toEqual([uid('a'), uid('b'), uid('c')]);
  });

  test('a merge from last week that is not settled yet does not use a slot of this week', async () => {
    // Monday 2026-10-12, read before the 9:00 AM run; the PR merged on Sunday.
    const now = new Date('2026-10-12T11:00:00Z');
    const rows = [row('a'), row('z')];
    const f = fakes({ rows, closed: [pr('z', { state: 'closed', merged_at: '2026-10-11T20:00:00Z' })], doneThisWeek: 9 });
    expect((await terminalWriterWork({ now, deps: f.deps })).due.map((r) => r.id)).toEqual([uid('a')]);
  });

  test('a cap of 0 hands out nothing', async () => {
    process.env.AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_DAY = '0';
    const f = fakes({ rows: [row('a')] });
    expect((await terminalWriterWork({ deps: f.deps })).due).toEqual([]);
  });

  test('a due row carries the action the queue matched it on', async () => {
    const f = fakes({ rows: [row('a')] });
    f.deps.queue.peek = jest.fn(async ({ actionType }) => (actionType === 'refresh_existing_page' ? [row('a', { action_type: 'new_supporting_blog' })] : []));
    expect((await terminalWriterWork({ deps: f.deps })).due.map((r) => r.action_type)).toEqual(['refresh_existing_page']);
  });

  test('a merge into a branch other than the site default is not a published post', async () => {
    const f = fakes({ rows: [row('a')], closed: [pr('a', { state: 'closed', merged_at: '2026-10-08T12:00:00Z', base: { ref: 'release' } })] });
    const work = await terminalWriterWork({ complete: true, deps: f.deps });
    expect(work.due.map((r) => r.id)).toEqual([uid('a')]);
    expect(f.updates).toEqual([]);
  });

  test('the daily run fences a row with an open PR out of the claimable window; the read-only pass does not', async () => {
    const now = new Date('2026-10-09T13:00:00Z');
    const f = fakes({ rows: [row('a'), row('b')], open: [pr('a')] });
    await terminalWriterWork({ now, deps: f.deps });
    expect(f.updates).toEqual([]);
    await terminalWriterWork({ complete: true, now, deps: f.deps });
    expect(f.updates).toHaveLength(1);
    expect(f.updates[0].where).toEqual([['in', 'id', [uid('a')]], ['status', 'pending']]);
    expect(f.updates[0].patch.available_at).toEqual(new Date('2026-10-12T13:00:00Z'));
    expect(f.updates[0].patch.expires_at).toEqual({ sql: 'CASE WHEN expires_at IS NULL THEN NULL ELSE GREATEST(expires_at, ?) END', bindings: [new Date('2026-10-12T13:00:00Z')] });
  });

  test('a row another writer moved out of pending keeps its PR: open is still in progress, merged is still settled', async () => {
    const now = new Date('2026-10-09T13:00:00Z');
    // the queue no longer serves either row: peek returns only b
    const f = fakes({ rows: [row('b')], open: [pr('a')], closed: [mergedPr('z')] });
    f.deps.db = Object.assign(() => {
      const calls = [];
      const q = {
        where: (...a) => { calls.push(a); return q; },
        whereIn: (...a) => { calls.push(['in', ...a]); return q; },
        whereNot: (...a) => { calls.push(['not', ...a]); return q; },
        // a: fenced, then superseded to 'skipped' by a page edit; z: expired by the janitor
        select: async () => [row('a', { status: 'skipped' }), row('z', { status: 'expired' })],
        update: async (patch) => { f.updates.push({ where: calls, patch }); return 1; },
      };
      return q;
    }, { raw: (sql, bindings) => ({ sql, bindings }) });
    const work = await terminalWriterWork({ complete: true, now, deps: f.deps });
    expect(work.inProgress.map((r) => r.id)).toEqual([uid('a')]);
    expect(work.merged.map((r) => r.id)).toEqual([uid('z')]);
    expect(f.updates[0].patch).toMatchObject({ status: 'done' });
  });

  test('other queue rows cannot hide a writing row: each writing action is read on its own', async () => {
    const f = fakes({ rows: [row('a', { action_type: 'refresh_existing_page' })] });
    expect((await terminalWriterWork({ deps: f.deps })).due.map((r) => r.id)).toEqual([uid('a')]);
    expect(f.deps.queue.peek.mock.calls.map(([o]) => o.actionType).sort()).toEqual(['create_customer_question_page', 'create_or_refresh_city_service_page', 'new_supporting_blog', 'refresh_existing_page', 'rewrite_title_meta']);
  });

  test('the weekly cap counts rows already completed this week', async () => {
    const f = fakes({ rows: ['a', 'b', 'c'].map((c) => row(c)), doneThisWeek: 9 });
    expect((await terminalWriterWork({ deps: f.deps })).due.map((r) => r.id)).toEqual([uid('a')]);
    const full = fakes({ rows: [row('a')], doneThisWeek: 10 });
    expect((await terminalWriterWork({ deps: full.deps })).due).toEqual([]);
  });

  test('the daily run completes a merged row and raises one valid admin item for the due posts', async () => {
    const f = fakes({ rows: [row('a'), row('b')], closed: [mergedPr('a')] });
    const out = await handOffToTerminal({ now: new Date('2026-10-09T13:00:00Z'), deps: f.deps });
    expect(out).toMatchObject({ outcome: 'handed_to_terminal', due: 1, merged: 1 });
    // a claim a dead API batch left behind is released first, then the queue is read
    expect(f.deps.queue.recoverStaleClaims.mock.invocationCallOrder[0]).toBeLessThan(f.deps.queue.peek.mock.invocationCallOrder[0]);
    expect(f.updates).toHaveLength(1);
    expect(f.updates[0].patch).toMatchObject({ status: 'done', skip_reason: SETTLED_REASON, completed_at: new Date('2026-10-08T12:00:00Z') });
    expect(f.updates[0].where).toEqual(expect.arrayContaining([['id', uid('a')], ['not', 'status', 'done']]));
    expect(f.deps.raiseAdminAlert).toHaveBeenCalledTimes(1);
    const [category, spec, opts] = f.deps.raiseAdminAlert.mock.calls[0];
    expect(category).toBe('content');
    expect(spec.action).toBe('write 1 website post in the terminal');
    expect(opts.dedupeKey).toBe('content-terminal-due:2026-10-09');
    // a later pass with a different list rewrites the same item and does not ring again
    expect(opts.refreshOnDedupe).toBe(true);
    expect(opts.ringOnRefresh()).toBe(false);
    expect(opts.detail).toContain('ants in the kitchen b');
  });

  test("no post due raises nothing and closes the open items, today's included", async () => {
    const now = new Date('2026-10-09T17:00:00Z');
    const f = fakes({ rows: [row('a')], open: [pr('a')], openKeys: ['content-terminal-due:2026-10-08', 'content-terminal-due:2026-10-09'] });
    const out = await handOffToTerminal({ now, deps: f.deps });
    expect(out.due).toBe(0);
    expect(f.deps.raiseAdminAlert).not.toHaveBeenCalled();
    expect(f.deps.episodes.closeAdminAlertKeys.mock.calls[0][1]).toEqual(['content-terminal-due:2026-10-08', 'content-terminal-due:2026-10-09']);
  });

  test("posts due closes only the earlier days' items", async () => {
    const now = new Date('2026-10-09T13:00:00Z');
    const f = fakes({ rows: [row('a')], openKeys: ['content-terminal-due:2026-10-08', 'content-terminal-due:2026-10-09'] });
    await handOffToTerminal({ now, deps: f.deps });
    expect(f.deps.episodes.closeAdminAlertKeys.mock.calls[0][1]).toEqual(['content-terminal-due:2026-10-08']);
    expect(f.deps.raiseAdminAlert).toHaveBeenCalledTimes(1);
  });
});

// The gate makes the terminal the only writer: every API drafting entry goes
// through runNext, and the 1pm catch-up retries the hand-off instead of drafting.
describe('terminal writer gate in the runner', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; jest.restoreAllMocks(); });

  test('runNext refuses to draft and claims nothing', async () => {
    process.env.GATE_CONTENT_WRITER_TERMINAL = 'true';
    const queue = require('../services/content/opportunity-queue');
    const claim = jest.spyOn(queue, 'claimNext');
    const runner = require('../services/content/autonomous-runner');
    const out = await runner.runNext({});
    expect(out).toMatchObject({ outcome: 'skipped_terminal_writer', skip_reason: 'terminal_writer' });
    expect(claim).not.toHaveBeenCalled();
  });

  test('the catch-up runs the hand-off again', async () => {
    process.env.GATE_CONTENT_WRITER_TERMINAL = 'true';
    const terminalWriter = require('../services/content/terminal-writer');
    const handOff = jest.spyOn(terminalWriter, 'handOffToTerminal').mockResolvedValue({ outcome: 'handed_to_terminal' });
    const runner = require('../services/content/autonomous-runner');
    jest.spyOn(runner, '_withEngineLock').mockImplementation((label, fn) => fn());
    expect(await runner.runCatchUp()).toEqual({ outcome: 'handed_to_terminal' });
    expect(handOff).toHaveBeenCalledTimes(1);
  });
});

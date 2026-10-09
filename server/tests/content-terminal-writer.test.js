// Terminal writer hand-off (GATE_CONTENT_WRITER_TERMINAL): the daily content
// run lists due posts instead of drafting them. Proves the sort (due / open PR
// / merged PR), the day and week caps, that only the daily run completes a
// merged row, and that one admin item is raised only when a post is due.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { terminalWriterWork, handOffToTerminal, terminalWriterLive, branchFor } = require('../services/content/terminal-writer');
const { composeAdminAlert } = require('../services/admin-alert-compose');

// Queue ids are UUIDs; the tests name them by one letter.
const uid = (c) => `00000000-0000-4000-8000-0000000000${c.charCodeAt(0).toString(16).padStart(2, '0')}`;
const row = (c, over = {}) => ({ id: uid(c), status: 'pending', action_type: 'new_supporting_blog', query: `ants in the kitchen ${c}`, score: 80, ...over });

const pr = (c, over = {}) => ({ head: { ref: `terminal-writer/${uid(c)}` }, html_url: `u/${c}`, state: 'open', merged_at: null, ...over });
const mergedPr = (c) => pr(c, { state: 'closed', merged_at: '2026-10-08T12:00:00Z' });

// open / closed: the GitHub pull lists. peek answers per action type, as the queue does.
function fakes({ rows, open = [], closed = [], doneThisWeek = 0 }) {
  const updates = [];
  const query = (calls) => {
    const q = {
      where: (...a) => { calls.push(a); return q; },
      whereIn: () => q,
      // pending rows among the merged PR ids, whatever their score
      select: async () => closed.filter((p) => p.merged_at).map((p) => ({ id: p.head.ref.split('/')[1] })).filter((m) => rows.some((r) => r.id === m.id && r.status === 'pending')),
      update: async (patch) => { updates.push({ where: calls, patch }); return 1; },
      count: () => q,
      first: async () => ({ n: doneThisWeek }),
    };
    return q;
  };
  return {
    updates,
    deps: {
      queue: { peek: jest.fn(async ({ actionType, minScore }) => rows.filter((r) => r.action_type === actionType && r.score >= minScore)) },
      gh: {
        env: () => ({ owner: 'acme', repo: 'site' }),
        ghFetchPaginated: jest.fn(async (path) => (path.includes('state=open') ? [...open, { head: { ref: 'content/other-pr' }, state: 'open' }, { head: { ref: 'terminal-writer/not-an-id' }, state: 'open' }] : closed)),
      },
      db: () => query([]),
      raiseAdminAlert: jest.fn(async (category, spec) => { composeAdminAlert(spec); return { id: 'n1' }; }),
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
    const merged = fakes({ rows, closed: [mergedPr('z')], doneThisWeek: 9 });
    expect((await terminalWriterWork({ deps: merged.deps })).due).toEqual([]);
    // the daily run settles that merge by id
    await terminalWriterWork({ complete: true, deps: merged.deps });
    expect(merged.updates.map((u) => u.where[0])).toEqual([['id', uid('z')]]);
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
    expect(f.updates).toHaveLength(1);
    expect(f.updates[0].patch).toMatchObject({ status: 'done' });
    expect(f.updates[0].where).toEqual(expect.arrayContaining([['id', uid('a')], ['status', 'pending']]));
    expect(f.deps.raiseAdminAlert).toHaveBeenCalledTimes(1);
    const [category, spec, opts] = f.deps.raiseAdminAlert.mock.calls[0];
    expect(category).toBe('content');
    expect(spec.action).toBe('write 1 website post in the terminal');
    expect(opts.dedupeKey).toBe('content-terminal-due:2026-10-09');
    expect(opts.detail).toContain('ants in the kitchen b');
  });

  test('no post due raises nothing', async () => {
    const f = fakes({ rows: [row('a')], open: [pr('a')] });
    const out = await handOffToTerminal({ deps: f.deps });
    expect(out.due).toBe(0);
    expect(f.deps.raiseAdminAlert).not.toHaveBeenCalled();
  });
});

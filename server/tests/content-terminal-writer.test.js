// Terminal writer hand-off (GATE_CONTENT_WRITER_TERMINAL): the daily content
// run lists due posts instead of drafting them. Proves the sort (due / open PR
// / merged PR), the day and week caps, that only the daily run completes a
// merged row, and that one admin item is raised only when a post is due.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { terminalWriterWork, handOffToTerminal, terminalWriterLive, branchFor } = require('../services/content/terminal-writer');
const { composeAdminAlert } = require('../services/admin-alert-compose');

const row = (id, over = {}) => ({ id, status: 'pending', action_type: 'new_supporting_blog', query: `ants in the kitchen ${id}`, score: 80, ...over });

// prs: opportunity id -> list of GitHub pull objects on its branch.
function fakes({ rows, prs = {}, doneThisWeek = 0 }) {
  const updates = [];
  const query = (calls) => {
    const q = {
      where: (...a) => { calls.push(a); return q; },
      whereIn: () => q,
      update: async (patch) => { updates.push({ where: calls, patch }); return 1; },
      count: () => q,
      first: async () => ({ n: doneThisWeek }),
    };
    return q;
  };
  return {
    updates,
    deps: {
      queue: { peek: jest.fn(async () => rows) },
      gh: {
        env: () => ({ owner: 'acme', repo: 'site' }),
        ghFetchPaginated: jest.fn(async (path) => {
          const id = decodeURIComponent(path).split('terminal-writer/')[1];
          return prs[id] || [];
        }),
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
      prs: { a: [{ state: 'open', html_url: 'u/1' }], b: [{ state: 'closed', merged_at: '2026-10-08T12:00:00Z', html_url: 'u/2' }] },
    });
    const work = await terminalWriterWork({ deps: f.deps });
    expect(work.due.map((r) => [r.id, r.branch])).toEqual([['c', branchFor('c')]]);
    expect(work.inProgress.map((r) => r.id)).toEqual(['a']);
    expect(work.merged.map((r) => r.id)).toEqual(['b']);
    // read-only by default: the merged row is not completed
    expect(f.updates).toEqual([]);
  });

  test('a PR closed without a merge leaves the row due', async () => {
    const f = fakes({ rows: [row('a')], prs: { a: [{ state: 'closed', merged_at: null }] } });
    expect((await terminalWriterWork({ deps: f.deps })).due.map((r) => r.id)).toEqual(['a']);
  });

  test('due plus in progress stays inside the daily cap', async () => {
    const f = fakes({ rows: ['a', 'b', 'c', 'd', 'e'].map((id) => row(id)), prs: { a: [{ state: 'open' }], b: [{ state: 'open' }] } });
    expect((await terminalWriterWork({ deps: f.deps })).due.map((r) => r.id)).toEqual(['c']);
  });

  test('the weekly cap counts rows already completed this week', async () => {
    const f = fakes({ rows: ['a', 'b', 'c'].map((id) => row(id)), doneThisWeek: 9 });
    expect((await terminalWriterWork({ deps: f.deps })).due.map((r) => r.id)).toEqual(['a']);
    const full = fakes({ rows: [row('a')], doneThisWeek: 10 });
    expect((await terminalWriterWork({ deps: full.deps })).due).toEqual([]);
  });

  test('the daily run completes a merged row and raises one valid admin item for the due posts', async () => {
    const f = fakes({ rows: [row('a'), row('b')], prs: { a: [{ state: 'closed', merged_at: '2026-10-08T12:00:00Z', html_url: 'u/2' }] } });
    const out = await handOffToTerminal({ now: new Date('2026-10-09T13:00:00Z'), deps: f.deps });
    expect(out).toMatchObject({ outcome: 'handed_to_terminal', due: 1, merged: 1 });
    expect(f.updates).toHaveLength(1);
    expect(f.updates[0].patch).toMatchObject({ status: 'done' });
    expect(f.updates[0].where).toEqual(expect.arrayContaining([['id', 'a'], ['status', 'pending']]));
    expect(f.deps.raiseAdminAlert).toHaveBeenCalledTimes(1);
    const [category, spec, opts] = f.deps.raiseAdminAlert.mock.calls[0];
    expect(category).toBe('content');
    expect(spec.action).toBe('write 1 website post in the terminal');
    expect(opts.dedupeKey).toBe('content-terminal-due:2026-10-09');
    expect(opts.detail).toContain('ants in the kitchen b');
  });

  test('no post due raises nothing', async () => {
    const f = fakes({ rows: [row('a')], prs: { a: [{ state: 'open' }] } });
    const out = await handOffToTerminal({ deps: f.deps });
    expect(out.due).toBe(0);
    expect(f.deps.raiseAdminAlert).not.toHaveBeenCalled();
  });
});

// Terminal writer (GATE_CONTENT_WRITER_TERMINAL): the draft step reads one JSON
// file a terminal session pushed to the Astro repo. Proves what counts as a
// usable draft, what waits, and that one admin item names the waiting rows.
// The seam in the runner is covered in autonomous-runner.test.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const tw = require('../services/content/terminal-writer');
const { composeAdminAlert } = require('../services/admin-alert-compose');

const ID = '00000000-0000-4000-8000-0000000000aa';
const body = 'Ghost ants trail along the kitchen backsplash in the wet season. '.repeat(8);
const file = (obj) => ({ sha: 's1', content: typeof obj === 'string' ? obj : JSON.stringify(obj) });
const ghWith = (getFile) => ({ getFile: jest.fn(getFile), getBranchSha: jest.fn(async () => null), retireBranch: jest.fn(async () => true) });

describe('terminal writer gate', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  test('on only for exactly "true"; a title/meta rewrite is never written in the terminal', () => {
    delete process.env.GATE_CONTENT_WRITER_TERMINAL;
    expect(tw.writesInTerminal({ action_type: 'new_supporting_blog', page_type: 'blog' })).toBe(false);
    process.env.GATE_CONTENT_WRITER_TERMINAL = '1';
    expect(tw.terminalWriterLive()).toBe(false);
    process.env.GATE_CONTENT_WRITER_TERMINAL = 'true';
    expect(tw.writesInTerminal({ action_type: 'new_supporting_blog', page_type: 'blog' })).toBe(true);
    expect(tw.writesInTerminal({ action_type: 'rewrite_title_meta', page_type: 'metadata' })).toBe(false);
  });
});

describe('fetchTerminalDraft', () => {
  test('reads the row\'s own branch and file and returns the dispatcher\'s result shape with only draft fields', async () => {
    const gh = ghWith(async () => file({ opportunity_id: ID, frontmatter: { title: 'Ghost Ants' }, body, schema: { '@type': 'Article' }, notes_for_reviewer: 'n', brief_id: 'b1', extra: 'dropped' }));
    const out = await tw.fetchTerminalDraft(ID, { gh });
    expect(gh.getFile).toHaveBeenCalledWith(`terminal-drafts/${ID}.json`, `terminal-writer/${ID}`);
    expect(out).toMatchObject({ ok: true, agent_id: 'terminal-writer', session_id: null });
    expect(out.draft).toEqual({ frontmatter: { title: 'Ghost Ants' }, body, schema: { '@type': 'Article' }, notes_for_reviewer: 'n' });
    expect(typeof out.duration_ms).toBe('number');
  });

  test('no file, or no branch (404), is "missing"', async () => {
    expect(await tw.fetchTerminalDraft(ID, { gh: ghWith(async () => null) })).toMatchObject({ ok: false, code: tw.MISSING });
    const notFound = ghWith(async () => { throw Object.assign(new Error('Not Found'), { status: 404 }); });
    expect(await tw.fetchTerminalDraft(ID, { gh: notFound })).toMatchObject({ ok: false, code: tw.MISSING });
  });

  test('any other GitHub failure throws: it must not read as "no draft yet"', async () => {
    const down = ghWith(async () => { throw Object.assign(new Error('Bad Gateway'), { status: 502 }); });
    await expect(tw.fetchTerminalDraft(ID, { gh: down })).rejects.toThrow('Bad Gateway');
  });

  test.each([
    ['not JSON', '{nope'],
    ['a JSON array', []],
    ['another row\'s id', { opportunity_id: 'someone-else', frontmatter: {}, body }],
    ['no frontmatter object', { opportunity_id: ID, frontmatter: 'x', body }],
    ['a body that is too short', { opportunity_id: ID, frontmatter: {}, body: 'short' }],
    ['a claims_ledger that is not a list', { opportunity_id: ID, frontmatter: {}, body, claims_ledger: {} }],
    ['an oversized file', { opportunity_id: ID, frontmatter: {}, body: 'x'.repeat(400001) }],
  ])('%s is rejected with a reason', async (_label, content) => {
    const out = await tw.fetchTerminalDraft(ID, { gh: ghWith(async () => file(content)) });
    expect(out).toMatchObject({ ok: false, code: tw.INVALID });
    expect(out.reason).toMatch(/^terminal draft rejected: /);
  });
});

test('retireTerminalDraft is true only for a confirmed delete and never throws', async () => {
  const gh = ghWith(async () => null);
  expect(await tw.retireTerminalDraft(ID, { gh })).toBe(true);
  expect(gh.retireBranch).toHaveBeenCalledWith(`terminal-writer/${ID}`);
  gh.retireBranch.mockResolvedValue(false);
  expect(await tw.retireTerminalDraft(ID, { gh })).toBe(false);
  gh.retireBranch.mockRejectedValue(new Error('boom'));
  expect(await tw.retireTerminalDraft(ID, { gh })).toBe(false);
});

describe('waiting rows and the admin item', () => {
  const B = '00000000-0000-4000-8000-0000000000bb';
  const C = '00000000-0000-4000-8000-0000000000cc';
  const waiting = (id, over = {}) => ({ opportunity_id: id, brief_id: `brief-${id.slice(-2)}`, action_type: 'new_supporting_blog', outcome: tw.AWAITING_OUTCOME, skip_reason: tw.MISSING, query: `topic ${id.slice(-2)}`, score: 80, ...over });
  // branches: opportunity id -> the file on its branch (absent = no branch)
  function deps({ rows, branches = {}, openKeys = [] }) {
    const gh = {
      getFile: jest.fn(async (path, branch) => (branches[branch.split('/')[1]] === undefined ? null : file(branches[branch.split('/')[1]]))),
    };
    return {
      gh,
      db: { raw: jest.fn(async () => ({ rows })) },
      episodes: { openAdminAlertKeys: jest.fn(async () => openKeys), closeAdminAlertKeys: jest.fn(async () => 0) },
      raiseAdminAlert: jest.fn(async (category, spec) => { composeAdminAlert(spec); return { id: 'n1' }; }),
    };
  }

  test('no file = due; a usable file = written; a file the run would reject stays due until a good one replaces it', async () => {
    const branches = { [B]: { opportunity_id: B, frontmatter: {}, body }, [C]: '{still bad' };
    // C's last run found nothing; a bad file was pushed since
    const d = deps({ rows: [waiting(ID), waiting(B), waiting(C)], branches });
    const out = await tw.awaitingTerminalDrafts({ deps: d });
    expect(out.due.map((r) => r.opportunity_id)).toEqual([ID, C]);
    expect(out.written.map((r) => r.opportunity_id)).toEqual([B]);
    expect(out.due[0]).toMatchObject({ branch: `terminal-writer/${ID}`, draft_path: `terminal-drafts/${ID}.json`, brief_id: 'brief-aa' });
    // the query asks for the latest run of each pending row and keeps the waiting ones
    expect(d.db.raw.mock.calls[0][1]).toEqual([7, tw.AWAITING_OUTCOME]);

    branches[C] = { opportunity_id: C, frontmatter: {}, body };
    expect((await tw.awaitingTerminalDrafts({ deps: d })).written.map((r) => r.opportunity_id)).toEqual([B, C]);
  });

  test('rows due: one valid admin item for today, rewritten quietly on a later pass; earlier days are closed', async () => {
    const now = new Date('2026-10-09T13:00:00Z');
    const d = deps({ rows: [waiting(ID), waiting(C, { skip_reason: tw.INVALID })], branches: { [C]: '{bad' }, openKeys: ['content-terminal-due:2026-10-08', 'content-terminal-due:2026-10-09'] });
    expect(await tw.raiseTerminalDue({ now, deps: d })).toEqual({ due: 2, written: 0 });
    expect(d.episodes.closeAdminAlertKeys.mock.calls[0][1]).toEqual(['content-terminal-due:2026-10-08']);
    const [category, spec, opts] = d.raiseAdminAlert.mock.calls[0];
    expect(category).toBe('content');
    expect(spec.action).toBe('write 2 website posts in the terminal');
    expect(opts.dedupeKey).toBe('content-terminal-due:2026-10-09');
    expect(opts.refreshOnDedupe).toBe(true);
    expect(opts.ringOnRefresh()).toBe(false);
    expect(opts.detail).toContain('topic aa');
    expect(opts.detail).toContain('topic cc (the last draft file was rejected)');
  });

  test('nothing due: no item, and today\'s open item is closed too', async () => {
    const now = new Date('2026-10-09T17:00:00Z');
    const d = deps({ rows: [waiting(B)], branches: { [B]: { opportunity_id: B, frontmatter: {}, body } }, openKeys: ['content-terminal-due:2026-10-09'] });
    expect(await tw.raiseTerminalDue({ now, deps: d })).toEqual({ due: 0, written: 1 });
    expect(d.raiseAdminAlert).not.toHaveBeenCalled();
    expect(d.episodes.closeAdminAlertKeys.mock.calls[0][1]).toEqual(['content-terminal-due:2026-10-09']);
  });
});

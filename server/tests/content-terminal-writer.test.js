// Terminal writer (GATE_CONTENT_WRITER_TERMINAL): the draft step reads one JSON
// file a terminal session pushed to the Astro repo. Proves what counts as a
// usable draft, what waits, and the life of the one admin item that names the
// waiting rows. The seam in the runner is covered in autonomous-runner.test.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const tw = require('../services/content/terminal-writer');

const ID = '00000000-0000-4000-8000-0000000000aa';
const BRIEF = 'brief-aa';
const body = 'Ghost ants trail along the kitchen backsplash in the wet season. '.repeat(8);
const good = (over = {}) => ({ opportunity_id: ID, brief_id: BRIEF, frontmatter: { title: 'Ghost Ants' }, body, ...over });
const file = (obj) => ({ sha: 'blob', content: typeof obj === 'string' ? obj : JSON.stringify(obj) });
// One branch per test: `content` undefined = no branch.
const ghWith = (content, { sha = 'commit-1' } = {}) => ({
  getBranchSha: jest.fn(async () => (content === undefined ? null : sha)),
  getFile: jest.fn(async () => (content === null ? null : file(content))),
  retireBranch: jest.fn(async () => true),
});

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

describe('waitingBriefId: the brief on the latest run, only when that run waits for a draft', () => {
  const skipped = [];
  const conn = (latest) => () => ({ where: () => ({ whereNotIn: (...a) => { skipped.push(a); return { orderBy: () => ({ first: async () => latest }) }; } }) });
  test.each([
    ['a waiting run', { outcome: 'deferred_terminal_draft', brief_id: BRIEF }, BRIEF],
    ['a gate retry (the row needs a new brief first)', { outcome: 'deferred_gate_retry', brief_id: BRIEF }, null],
    ['no run at all', undefined, null],
  ])('%s', async (_label, latest, expected) => {
    expect(await tw.waitingBriefId(ID, { conn: conn(latest) })).toBe(expected);
    // a publish-cap deferral between two looks is not the row's "latest run"
    expect(skipped.at(-1)).toEqual(['outcome', ['deferred_publish_cap']]);
  });
});

describe('fetchTerminalDraft', () => {
  test('reads the file at the branch commit and returns the dispatcher\'s result shape with only draft fields', async () => {
    const gh = ghWith(good({ schema: { '@type': 'Article' }, notes_for_reviewer: 'n', extra: 'dropped' }));
    const out = await tw.fetchTerminalDraft(ID, { gh, expectedBriefId: BRIEF });
    expect(gh.getBranchSha).toHaveBeenCalledWith(`terminal-writer/${ID}`);
    expect(gh.getFile).toHaveBeenCalledWith(`terminal-drafts/${ID}.json`, 'commit-1');
    expect(out).toMatchObject({ ok: true, agent_id: 'terminal-writer', session_id: null, brief_id: BRIEF, revision: 'commit-1' });
    expect(out.draft).toEqual({ frontmatter: { title: 'Ghost Ants' }, body, schema: { '@type': 'Article' }, notes_for_reviewer: 'n' });
    expect(typeof out.duration_ms).toBe('number');
  });

  test('no brief handed out, no branch, no file, or a 404 is "missing"', async () => {
    const unread = ghWith(good());
    expect(await tw.fetchTerminalDraft(ID, { gh: unread, expectedBriefId: null })).toMatchObject({ ok: false, code: tw.MISSING });
    expect(unread.getBranchSha).not.toHaveBeenCalled();
    expect(await tw.fetchTerminalDraft(ID, { gh: ghWith(undefined), expectedBriefId: BRIEF })).toMatchObject({ ok: false, code: tw.MISSING });
    expect(await tw.fetchTerminalDraft(ID, { gh: ghWith(null), expectedBriefId: BRIEF })).toMatchObject({ ok: false, code: tw.MISSING });
    const notFound = ghWith(good());
    notFound.getFile.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
    expect(await tw.fetchTerminalDraft(ID, { gh: notFound, expectedBriefId: BRIEF })).toMatchObject({ ok: false, code: tw.MISSING });
  });

  test('any other GitHub failure throws: it must not read as "no draft yet"', async () => {
    const down = ghWith(good());
    down.getBranchSha.mockRejectedValue(Object.assign(new Error('Bad Gateway'), { status: 502 }));
    await expect(tw.fetchTerminalDraft(ID, { gh: down, expectedBriefId: BRIEF })).rejects.toThrow('Bad Gateway');
  });

  test.each([
    ['not JSON', '{nope'],
    ['a JSON array', []],
    ['another row\'s id', good({ opportunity_id: 'someone-else' })],
    ['a draft written from another brief', good({ brief_id: 'brief-old' })],
    ['a draft that names no brief', good({ brief_id: undefined })],
    ['no frontmatter object', good({ frontmatter: 'x' })],
    ['a body that is too short', good({ body: 'short' })],
    ['a claims_ledger that is not a list', good({ claims_ledger: {} })],
    ['an oversized file', good({ body: 'x'.repeat(400001) })],
  ])('%s is rejected with a reason', async (_label, content) => {
    const out = await tw.fetchTerminalDraft(ID, { gh: ghWith(content), expectedBriefId: BRIEF });
    expect(out).toMatchObject({ ok: false, code: tw.INVALID });
    expect(out.reason).toMatch(/^terminal draft rejected: /);
  });
});

describe('retireTerminalDraft', () => {
  test('deletes the branch while it still points at the commit that was read', async () => {
    const gh = ghWith(good());
    expect(await tw.retireTerminalDraft(ID, { gh, revision: 'commit-1' })).toBe(true);
    expect(gh.retireBranch).toHaveBeenCalledWith(`terminal-writer/${ID}`);
  });

  test('a push since the read is kept: nothing is deleted', async () => {
    const gh = ghWith(good(), { sha: 'commit-2' });
    expect(await tw.retireTerminalDraft(ID, { gh, revision: 'commit-1' })).toBe(false);
    expect(gh.retireBranch).not.toHaveBeenCalled();
  });

  test('an unconfirmed delete or a GitHub error is false, never a throw', async () => {
    const gh = ghWith(good());
    gh.retireBranch.mockResolvedValue(false);
    expect(await tw.retireTerminalDraft(ID, { gh, revision: 'commit-1' })).toBe(false);
    gh.retireBranch.mockRejectedValue(new Error('boom'));
    expect(await tw.retireTerminalDraft(ID, { gh, revision: 'commit-1' })).toBe(false);
  });
});

describe('waiting rows and the admin item', () => {
  const B = '00000000-0000-4000-8000-0000000000bb';
  const C = '00000000-0000-4000-8000-0000000000cc';
  const R = '00000000-0000-4000-8000-0000000000dd';
  const waiting = (id, over = {}) => ({ opportunity_id: id, brief_id: `brief-${id.slice(-2)}`, action_type: 'new_supporting_blog', outcome: tw.AWAITING_OUTCOME, agent_id: null, skip_reason: tw.MISSING, query: `topic ${id.slice(-2)}`, score: 80, ...over });
  const draftFor = (id, over = {}) => ({ opportunity_id: id, brief_id: `brief-${id.slice(-2)}`, frontmatter: {}, body, ...over });
  // branches: opportunity id -> the file on its branch (absent = no branch)
  function deps({ rows, branches = {}, openKeys = [] }) {
    const idOf = (branch) => branch.split('/')[1];
    const gh = {
      getBranchSha: jest.fn(async (branch) => (branches[idOf(branch)] === undefined ? null : `sha-${idOf(branch)}`)),
      getFile: jest.fn(async (path) => file(branches[path.split('/')[1].replace('.json', '')])),
    };
    return {
      gh,
      db: { raw: jest.fn(async () => ({ rows })) },
      episodes: {
        openAdminAlertKeys: jest.fn(async () => openKeys),
        closeAdminAlertKeys: jest.fn(async () => 0),
        raiseAdminAlertWithReopen: jest.fn(async () => ({ id: 'n1', rang: true })),
      },
    };
  }

  test('no file = due; a usable file = written; a file the run would reject (bad JSON, another brief) stays due; a failed check waits for its retry brief', async () => {
    const branches = { [B]: draftFor(B), [C]: draftFor(C, { brief_id: 'brief-from-before-the-retry' }) };
    const d = deps({ rows: [waiting(ID), waiting(B), waiting(C), waiting(R, { outcome: tw.GATE_RETRY_OUTCOME, agent_id: tw.TERMINAL_AGENT_ID })], branches });
    const out = await tw.awaitingTerminalDrafts({ deps: d });
    expect(out.due.map((r) => r.opportunity_id)).toEqual([ID, C]);
    expect(out.due[1].problem).toMatch(/brief_id is not the brief this row waits on/);
    expect(out.written.map((r) => r.opportunity_id)).toEqual([B]);
    expect(out.rebrief.map((r) => r.opportunity_id)).toEqual([R]);
    expect(out.due[0]).toMatchObject({ branch: `terminal-writer/${ID}`, draft_path: `terminal-drafts/${ID}.json`, brief_id: 'brief-aa' });
    // the latest run of each pending row: waiting ones, and gate retries of a terminal draft
    expect(d.db.raw.mock.calls[0][1]).toEqual([7, ['deferred_publish_cap'], tw.AWAITING_OUTCOME, tw.GATE_RETRY_OUTCOME, tw.TERMINAL_AGENT_ID]);

    branches[C] = draftFor(C);
    expect((await tw.awaitingTerminalDrafts({ deps: d })).written.map((r) => r.opportunity_id)).toEqual([B, C]);
  });

  test('rows due: one item for today through the reopen mechanism, versioned by what is due; earlier days are closed', async () => {
    const now = new Date('2026-10-09T13:00:00Z');
    const d = deps({ rows: [waiting(ID), waiting(C)], branches: { [C]: '{bad' }, openKeys: ['content-terminal-due:2026-10-08', 'content-terminal-due:2026-10-09'] });
    expect(await tw.raiseTerminalDue({ now, deps: d })).toEqual({ due: 2, written: 0, rebrief: 0 });
    expect(d.episodes.closeAdminAlertKeys.mock.calls[0][1]).toEqual(['content-terminal-due:2026-10-08']);
    const [category, title, why, opts] = d.episodes.raiseAdminAlertWithReopen.mock.calls[0];
    expect([category, title]).toEqual(['content', 'Content — write 2 website posts in the terminal']);
    expect(why).toBe('The content queue has 2 posts that wait for a draft from the terminal.');
    expect(opts).toMatchObject({ dedupeKey: 'content-terminal-due:2026-10-09', refreshOnDedupe: true, link: '/admin/blog?tab=autopilot' });
    expect(opts.metadata).toMatchObject({ severity: 'needs-you', doneWhen: 'drafts_written', who: 'claude' });
    expect(opts.ringOnRefresh()).toBe(false);
    expect(opts.detail).toContain('topic aa');
    expect(opts.detail).toContain('topic cc (the last draft file was rejected)');

    // the same list again is the same version; a different list is a new one
    await tw.raiseTerminalDue({ now, deps: d });
    const versions = d.episodes.raiseAdminAlertWithReopen.mock.calls.map((c) => c[3].dedupeVersion);
    expect(versions[1]).toBe(versions[0]);
    const other = deps({ rows: [waiting(ID)] });
    await tw.raiseTerminalDue({ now, deps: other });
    expect(other.episodes.raiseAdminAlertWithReopen.mock.calls[0][3].dedupeVersion).not.toBe(versions[0]);
  });

  test('nothing due: no item, and today\'s open item is closed too; a row that waits for its retry brief raises nothing', async () => {
    const now = new Date('2026-10-09T17:00:00Z');
    const d = deps({ rows: [waiting(B), waiting(R, { outcome: tw.GATE_RETRY_OUTCOME, agent_id: tw.TERMINAL_AGENT_ID })], branches: { [B]: draftFor(B) }, openKeys: ['content-terminal-due:2026-10-09'] });
    expect(await tw.raiseTerminalDue({ now, deps: d })).toEqual({ due: 0, written: 1, rebrief: 1 });
    expect(d.episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(d.episodes.closeAdminAlertKeys.mock.calls[0][1]).toEqual(['content-terminal-due:2026-10-09']);
  });
});

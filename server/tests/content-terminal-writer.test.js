// Terminal writer (GATE_CONTENT_WRITER_TERMINAL): the draft step reads one JSON
// file a terminal session pushed to the Astro repo. Proves what counts as a
// usable draft, what waits, and the life of the one admin item that names the
// waiting rows. The seam in the runner is covered in autonomous-runner.test.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The editorial-evidence gate, switched per test.
let mockEditorialOn = false;
jest.mock('../services/content/editorial-evidence', () => ({ enabled: () => mockEditorialOn }));

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

describe('with the editorial-evidence gate on, briefs that need an approved answer plan stay on the agent', () => {
  const saved = { ...process.env };
  beforeEach(() => { process.env.GATE_CONTENT_WRITER_TERMINAL = 'true'; mockEditorialOn = true; });
  afterEach(() => { process.env = { ...saved }; mockEditorialOn = false; });

  test.each([
    ['a supporting blog', { action_type: 'new_supporting_blog', page_type: 'supporting-blog' }, false],
    ['a customer question page', { action_type: 'create_customer_question_page', page_type: 'customer-question' }, false],
    ['a refresh', { action_type: 'refresh_existing_page', page_type: 'refresh' }, false],
    ['a city service page (no answer plan)', { action_type: 'create_or_refresh_city_service_page', page_type: 'city-service' }, true],
  ])('%s', (_label, brief, inTerminal) => {
    expect(tw.writesInTerminal(brief)).toBe(inTerminal);
    expect(tw.draftSourceFor(ID, { id: BRIEF, ...brief }, { handed: true }) !== null).toBe(inTerminal);
  });

  test('with that gate off, the same briefs are written in the terminal', () => {
    mockEditorialOn = false;
    expect(tw.writesInTerminal({ action_type: 'new_supporting_blog', page_type: 'supporting-blog' })).toBe(true);
  });
});

describe('waitingBriefId: the brief on the latest run, only when that run waits for a draft', () => {
  const skipped = [];
  const conn = (latest) => () => ({ where: () => ({ whereRaw: (...a) => { skipped.push(a); return { orderBy: () => ({ first: async () => latest }) }; } }) });
  test.each([
    ['a waiting run', { outcome: 'deferred_terminal_draft', brief_id: BRIEF }, BRIEF],
    ['a gate retry (the row needs a new brief first)', { outcome: 'deferred_gate_retry', brief_id: BRIEF }, null],
    ['a cap deferral after the draft was taken (the late backstop)', { outcome: 'deferred_publish_cap', brief_id: BRIEF }, null],
    ['no run at all', undefined, null],
  ])('%s', async (_label, latest, expected) => {
    expect(await tw.waitingBriefId(ID, { conn: conn(latest) })).toBe(expected);
    // a publish-cap deferral that ended before the draft step (no agent) is not the row's "latest run"
    expect(skipped.at(-1)).toEqual(['NOT (outcome = ? AND agent_id IS NULL)', ['deferred_publish_cap']]);
  });
});

describe('fetchTerminalDraft', () => {
  test('reads the file at the branch commit and returns the dispatcher\'s result shape with only draft fields', async () => {
    const gh = ghWith(good({ schema: { '@type': 'Article' }, notes_for_reviewer: 'n', extra: 'dropped' }));
    const out = await tw.fetchTerminalDraft(ID, { gh, expectedBriefId: BRIEF });
    expect(gh.getBranchSha).toHaveBeenCalledWith(`terminal-writer/${ID}`);
    expect(gh.getFile).toHaveBeenCalledWith(`terminal-drafts/${ID}.json`, 'commit-1');
    expect(out).toMatchObject({ ok: true, agent_id: 'terminal-writer', session_id: null, brief_id: BRIEF, revision: 'commit-1' });
    expect(out.draft).toEqual({ type: 'draft', frontmatter: { title: 'Ghost Ants' }, body, schema: { '@type': 'Article' }, notes_for_reviewer: 'n' });
    expect(typeof out.duration_ms).toBe('number');
  });

  // Live 2026-10-09: two terminal refresh drafts passed every gate and then parked as
  // publisher_adapter_unavailable, because the publisher only takes a draft stamped type 'draft'
  // (the agent's emit_draft handler stamps it; the terminal path did not).
  test('a terminal draft is one the publisher takes: stamped type draft, whatever the file says', async () => {
    const publisher = require('../services/content-astro/astro-publisher');
    const out = await tw.fetchTerminalDraft(ID, { gh: ghWith(good({ type: 'metadata' })), expectedBriefId: BRIEF });
    expect(out.draft.type).toBe('draft');
    expect(publisher.canPublishRefresh(out.draft, { action_type: 'refresh_existing_page', target_url: 'https://www.wavespestcontrol.com/x/' })).toBe(true);
    expect(publisher.canPublishDraftBrief(out.draft, { action_type: 'new_supporting_blog' })).toBe(true);
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

describe('draftSourceFor: the terminal as a draft source with the dispatcher\'s contract', () => {
  const saved = { ...process.env };
  beforeEach(() => { process.env.GATE_CONTENT_WRITER_TERMINAL = 'true'; });
  afterEach(() => { process.env = { ...saved }; });
  const brief = { id: BRIEF, action_type: 'new_supporting_blog', page_type: 'supporting-blog' };

  test('no source (the agent writes) with the gate off, on a dry run, and for a title/meta rewrite', () => {
    expect(tw.draftSourceFor(ID, brief, { handed: true, dryRun: true })).toBeNull();
    expect(tw.draftSourceFor(ID, { ...brief, action_type: 'rewrite_title_meta', page_type: 'metadata' }, { handed: true })).toBeNull();
    process.env.GATE_CONTENT_WRITER_TERMINAL = 'false';
    expect(tw.draftSourceFor(ID, brief, { handed: true })).toBeNull();
  });

  test('a usable draft is returned as the dispatcher would return one', async () => {
    const out = await tw.draftSourceFor(ID, brief, { handed: true, gh: ghWith(good()) }).runWithBrief();
    expect(out).toMatchObject({ ok: true, brief_id: BRIEF, revision: 'commit-1' });
    expect(out.wait).toBeUndefined();
  });

  test('a brief that was not handed out yet, a missing or rejected file, and a GitHub failure all WAIT', async () => {
    const unread = ghWith(good());
    expect(await tw.draftSourceFor(ID, brief, { handed: false, gh: unread }).runWithBrief()).toMatchObject({ ok: false, wait: true, code: tw.MISSING });
    expect(unread.getBranchSha).not.toHaveBeenCalled();
    expect(await tw.draftSourceFor(ID, brief, { handed: true, gh: ghWith('{nope') }).runWithBrief()).toMatchObject({ ok: false, wait: true, code: tw.INVALID });
    const down = ghWith(good());
    down.getBranchSha.mockRejectedValue(Object.assign(new Error('Bad Gateway'), { status: 502 }));
    expect(await tw.draftSourceFor(ID, brief, { handed: true, gh: down }).runWithBrief()).toMatchObject({ ok: false, wait: true, code: tw.UNREADABLE, agent_id: 'terminal-writer' });
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

test('cleanupConsumedDrafts deletes the branch of a stored run that took a draft, and nothing else', async () => {
  const gh = ghWith(good());
  await tw.cleanupConsumedDrafts([
    { id: 'run_1', opportunity_id: ID, terminal_draft_revision: 'commit-1' },
    { id: null, opportunity_id: ID, terminal_draft_revision: 'commit-1' }, // never stored: the pushed file is the only copy
    { id: 'run_3', opportunity_id: ID }, // waited; took no draft
  ], { gh });
  expect(gh.retireBranch).toHaveBeenCalledTimes(1);
});

describe('waiting rows and the admin item', () => {
  const B = '00000000-0000-4000-8000-0000000000bb';
  const C = '00000000-0000-4000-8000-0000000000cc';
  const R = '00000000-0000-4000-8000-0000000000dd';
  const waiting = (id, over = {}) => ({ opportunity_id: id, brief_id: `brief-${id.slice(-2)}`, brief_created_at: new Date(), action_type: 'new_supporting_blog', outcome: tw.AWAITING_OUTCOME, agent_id: null, skip_reason: tw.MISSING, query: `topic ${id.slice(-2)}`, score: 80, ...over });
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
    expect(d.db.raw.mock.calls[0][1]).toEqual([7, 'deferred_publish_cap', tw.AWAITING_OUTCOME, tw.GATE_RETRY_OUTCOME, tw.TERMINAL_AGENT_ID]);

    branches[C] = draftFor(C);
    expect((await tw.awaitingTerminalDrafts({ deps: d })).written.map((r) => r.opportunity_id)).toEqual([B, C]);
  });

  test('a waiting row whose brief is too old, or gone, is not offered for writing: the next run briefs it again', async () => {
    const now = new Date('2026-10-09T13:00:00Z');
    const d = deps({ rows: [
      waiting(ID, { brief_created_at: new Date('2026-10-03T13:00:00Z') }),
      waiting(B, { brief_created_at: new Date('2026-10-01T13:00:00Z') }),
      waiting(C, { brief_created_at: null }),
    ] });
    const out = await tw.awaitingTerminalDrafts({ now, deps: d });
    expect(out.due.map((r) => r.opportunity_id)).toEqual([ID]);
    expect(out.rebrief.map((r) => r.opportunity_id)).toEqual([B, C]);
  });

  test('rows due: one item for today through the reopen mechanism, versioned by what is due; earlier days are closed', async () => {
    const now = new Date('2026-10-09T13:00:00Z');
    const d = deps({ rows: [waiting(ID), waiting(C)], branches: { [C]: '{bad' }, openKeys: ['content-terminal-due:2026-10-08', 'content-terminal-due:2026-10-09'] });
    expect(await tw.raiseTerminalDue({ now, deps: d })).toEqual({ due: 2, written: 0, rebrief: 0, delivered: true });
    expect(d.episodes.closeAdminAlertKeys.mock.calls[0][1]).toEqual(['content-terminal-due:2026-10-08']);
    const [category, title, why, opts] = d.episodes.raiseAdminAlertWithReopen.mock.calls[0];
    expect([category, title]).toEqual(['content', 'Content — write 2 website posts in the terminal']);
    expect(why).toBe('The content queue has 2 posts that wait for a draft from the terminal.');
    // bellDefault: the content category is off the bell policy's default list; this item asks for work
    expect(opts).toMatchObject({ dedupeKey: 'content-terminal-due:2026-10-09', refreshOnDedupe: true, link: '/admin/blog?tab=autopilot', bellDefault: true });
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

  test('an item the bell policy suppressed is reported as not delivered', async () => {
    const d = deps({ rows: [waiting(ID)] });
    d.episodes.raiseAdminAlertWithReopen.mockResolvedValue({ id: null, suppressed: true, rang: false });
    expect(await tw.raiseTerminalDue({ now: new Date('2026-10-09T13:00:00Z'), deps: d })).toMatchObject({ due: 1, delivered: false });
  });

  test('nothing due: no item, and today\'s open item is closed too; a row that waits for its retry brief raises nothing', async () => {
    const now = new Date('2026-10-09T17:00:00Z');
    const d = deps({ rows: [waiting(B), waiting(R, { outcome: tw.GATE_RETRY_OUTCOME, agent_id: tw.TERMINAL_AGENT_ID })], branches: { [B]: draftFor(B) }, openKeys: ['content-terminal-due:2026-10-09'] });
    expect(await tw.raiseTerminalDue({ now, deps: d })).toEqual({ due: 0, written: 1, rebrief: 1, delivered: false });
    expect(d.episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(d.episodes.closeAdminAlertKeys.mock.calls[0][1]).toEqual(['content-terminal-due:2026-10-09']);
  });
});

describe('the gate as a kill switch, and the 1pm catch-up', () => {
  const episodes = (open) => ({ openAdminAlertKeys: jest.fn(async () => open), closeAdminAlertKeys: jest.fn(async () => open.length) });

  test('gate off: every open terminal item is closed, with no GitHub read', async () => {
    const e = episodes(['content-terminal-due:2026-10-08', 'content-terminal-due:2026-10-09']);
    await tw.closeTerminalItems({ now: new Date('2026-10-09T13:00:00Z'), deps: { episodes: e, db: {} } });
    expect(e.closeAdminAlertKeys.mock.calls[0][1]).toEqual(['content-terminal-due:2026-10-08', 'content-terminal-due:2026-10-09']);
    expect(e.closeAdminAlertKeys.mock.calls[0][2]).toBe('terminal_writer_off');
  });

  describe('blogDraftRequested: is the drought alert false news?', () => {
    const saved = { ...process.env };
    beforeEach(() => { process.env.GATE_CONTENT_WRITER_TERMINAL = 'true'; });
    afterEach(() => { process.env = { ...saved }; });
    const now = new Date('2026-10-09T17:00:00Z');
    const withBlog = (rows) => ({ raw: jest.fn(async () => ({ rows })) });

    test('true only when today\'s item stands AND a blog waits', async () => {
      expect(await tw.blogDraftRequested({ now, deps: { episodes: episodes(['content-terminal-due:2026-10-09']), db: withBlog([{}]) } })).toBe(true);
      // the item is open but only other page types wait
      expect(await tw.blogDraftRequested({ now, deps: { episodes: episodes(['content-terminal-due:2026-10-09']), db: withBlog([]) } })).toBe(false);
      // a blog waits but today's item is not open (never raised, suppressed, or closed)
      expect(await tw.blogDraftRequested({ now, deps: { episodes: episodes(['content-terminal-due:2026-10-08']), db: withBlog([{}]) } })).toBe(false);
    });

    test('false with the gate off and on any read failure: the drought alert is the fallback signal', async () => {
      const failing = { openAdminAlertKeys: jest.fn(async () => { throw new Error('db down'); }) };
      expect(await tw.blogDraftRequested({ now, deps: { episodes: failing, db: withBlog([{}]) } })).toBe(false);
      process.env.GATE_CONTENT_WRITER_TERMINAL = 'false';
      expect(await tw.blogDraftRequested({ now, deps: { episodes: episodes(['content-terminal-due:2026-10-09']), db: withBlog([{}]) } })).toBe(false);
    });
  });
});

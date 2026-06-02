/**
 * Unit tests for agent-dispatcher pure helpers + brief-driven-tools
 * emit sinks. No Anthropic API calls (those are exercised end-to-end
 * by the CLI dry-run + integration tests at deploy time).
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/content-astro/github-client', () => ({ getFile: jest.fn() }));

const dispatcher = require('../services/content/agents/agent-dispatcher');
const { pickAgent, buildInputPayload, ACTION_TO_AGENT } = dispatcher._internals;
const tools = require('../services/content/agents/brief-driven-tools');
const { executeBriefTool, getDraft, clearDraft } = tools;
const { urlToAstroPath, parseJsonbColumns } = tools._internals;
const db = require('../models/db');
const gh = require('../services/content-astro/github-client');

const { WRITER_AGENT_CONFIG } = require('../services/content/agents/writer-agent-config');
const { REFRESH_AGENT_CONFIG } = require('../services/content/agents/refresh-agent-config');
const { META_REWRITER_CONFIG } = require('../services/content/agents/meta-rewriter-config');

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  // restore env between tests
  for (const k of ['CONTENT_WRITER_AGENT_ID', 'CONTENT_REFRESHER_AGENT_ID', 'CONTENT_META_REWRITER_AGENT_ID']) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL_ENV[k];
  }
});

function brief(overrides = {}) {
  return {
    opportunity_id: 'opp-1',
    action_type: 'new_supporting_blog',
    page_type: 'supporting-blog',
    target_url: null,
    target_keyword: 'how to identify a termite swarm',
    city: 'Bradenton',
    service: 'pest',
    word_count_target: '900-1500',
    human_review_required: false,
    router_notes: '',
    ...overrides,
  };
}

function registryQuery(row, seen = []) {
  const query = {};
  query.select = jest.fn(() => query);
  query.whereNotNull = jest.fn(() => query);
  query.whereNot = jest.fn(() => query);
  query.whereRaw = jest.fn((sql, bindings) => {
    seen.push(['whereRaw', sql, bindings]);
    return query;
  });
  query.andWhere = jest.fn((callback) => {
    const whereScope = {
      where: jest.fn((column, value) => {
        seen.push([column, value]);
        return whereScope;
      }),
      orWhere: jest.fn((column, value) => {
        seen.push([column, value]);
        return whereScope;
      }),
    };
    callback.call(whereScope);
    return query;
  });
  query.orderByRaw = jest.fn(() => query);
  query.orderBy = jest.fn(() => query);
  query.limit = jest.fn(() => query);
  query.first = jest.fn(async () => row);
  return query;
}

// ── ACTION_TO_AGENT map coverage ────────────────────────────────────

describe('ACTION_TO_AGENT map', () => {
  test('covers every writer-action variant + refresh + meta + non-LLM', () => {
    expect(ACTION_TO_AGENT.create_or_refresh_city_service_page.role).toBe('writer');
    expect(ACTION_TO_AGENT.create_customer_question_page.role).toBe('writer');
    expect(ACTION_TO_AGENT.new_supporting_blog.role).toBe('writer');
    expect(ACTION_TO_AGENT.refresh_existing_page.role).toBe('refresh');
    expect(ACTION_TO_AGENT.rewrite_title_meta.role).toBe('meta');
    expect(ACTION_TO_AGENT.add_internal_links.role).toBe('none');
    expect(ACTION_TO_AGENT.gbp_post.role).toBe('none');
    expect(ACTION_TO_AGENT.do_not_publish.role).toBe('none');
  });
});

// ── pickAgent ───────────────────────────────────────────────────────

describe('pickAgent', () => {
  test('returns ok+agent_id when env var set', () => {
    process.env.CONTENT_WRITER_AGENT_ID = 'agent_writer_123';
    const r = pickAgent(brief({ action_type: 'create_or_refresh_city_service_page' }));
    expect(r.ok).toBe(true);
    expect(r.agent_id).toBe('agent_writer_123');
    expect(r.role).toBe('writer');
  });
  test('returns ok=false agent_not_registered when env var missing', () => {
    delete process.env.CONTENT_WRITER_AGENT_ID;
    const r = pickAgent(brief({ action_type: 'new_supporting_blog' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('agent_not_registered');
    expect(r.env_var_missing).toBe('CONTENT_WRITER_AGENT_ID');
    expect(r.config_name).toBe('waves-content-writer');
  });
  test('returns ok=false role=none for non-LLM actions', () => {
    const r = pickAgent(brief({ action_type: 'add_internal_links' }));
    expect(r.ok).toBe(false);
    expect(r.role).toBe('none');
  });
  test('refresh_existing_page → refresher agent', () => {
    process.env.CONTENT_REFRESHER_AGENT_ID = 'agent_refresh_456';
    const r = pickAgent(brief({ action_type: 'refresh_existing_page' }));
    expect(r.ok).toBe(true);
    expect(r.agent_id).toBe('agent_refresh_456');
    expect(r.role).toBe('refresh');
  });
  test('rewrite_title_meta → meta-rewriter agent', () => {
    process.env.CONTENT_META_REWRITER_AGENT_ID = 'agent_meta_789';
    const r = pickAgent(brief({ action_type: 'rewrite_title_meta' }));
    expect(r.ok).toBe(true);
    expect(r.agent_id).toBe('agent_meta_789');
    expect(r.role).toBe('meta');
  });
  test('unknown action_type returns ok=false', () => {
    const r = pickAgent(brief({ action_type: 'made_up_action' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unknown_action_type/);
  });
  test('throws on missing brief', () => {
    expect(() => pickAgent(null)).toThrow();
  });
});

// ── buildInputPayload ───────────────────────────────────────────────

describe('buildInputPayload', () => {
  test('includes instruction + brief_summary with correct keys', () => {
    const p = buildInputPayload(brief());
    expect(p.instruction).toMatch(/get_content_brief/);
    expect(p.brief_summary.opportunity_id).toBe('opp-1');
    expect(p.brief_summary.action_type).toBe('new_supporting_blog');
    expect(p.brief_summary.city).toBe('Bradenton');
    expect(p.brief_summary.service).toBe('pest');
  });
  test('handles missing optional fields', () => {
    const p = buildInputPayload(brief({ target_url: undefined, city: undefined }));
    expect(p.brief_summary.target_url).toBeNull();
    expect(p.brief_summary.city).toBeNull();
  });
});

// ── runWithBrief dry-run ────────────────────────────────────────────

describe('runWithBrief dry-run', () => {
  test('returns routing decision + input payload without calling API', async () => {
    process.env.CONTENT_WRITER_AGENT_ID = 'agent_writer_999';
    const r = await dispatcher.runWithBrief(brief(), { dryRun: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('dry_run');
    expect(r.agent_id).toBe('agent_writer_999');
    expect(r.input_payload.brief_summary.opportunity_id).toBe('opp-1');
  });
  test('returns agent_not_registered when env missing — even in dry-run', async () => {
    delete process.env.CONTENT_WRITER_AGENT_ID;
    const r = await dispatcher.runWithBrief(brief(), { dryRun: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('agent_not_registered');
  });
  test('returns role=none for do_not_publish action', async () => {
    const r = await dispatcher.runWithBrief(brief({ action_type: 'do_not_publish' }), { dryRun: true });
    expect(r.ok).toBe(false);
    expect(r.role).toBe('none');
  });
});

// ── emit_draft / emit_metadata_only sinks ───────────────────────────

describe('emit_draft tool sink', () => {
  test('captures full draft into per-session store', async () => {
    const sid = 'sess-A';
    const r = await executeBriefTool('emit_draft', {
      frontmatter: { title: 'Test' },
      body: 'body content here',
      schema: { '@type': 'Article' },
      notes_for_reviewer: 'looks fine',
    }, { sessionId: sid });
    expect(r.ok).toBe(true);
    expect(r.body_chars).toBe('body content here'.length);
    const captured = getDraft(sid);
    expect(captured.type).toBe('draft');
    expect(captured.body).toBe('body content here');
    expect(captured.frontmatter.title).toBe('Test');
    clearDraft(sid);
  });
  test('errors without sessionId', async () => {
    const r = await executeBriefTool('emit_draft', {
      frontmatter: {}, body: 'x',
    }, {});
    expect(r.error).toMatch(/session context missing/);
  });
  test('errors without required body fields', async () => {
    const r = await executeBriefTool('emit_draft', { frontmatter: {} }, { sessionId: 'sess-B' });
    expect(r.error).toMatch(/required/);
    clearDraft('sess-B');
  });
});

describe('emit_metadata_only tool sink', () => {
  test('captures title + meta', async () => {
    const sid = 'sess-meta-1';
    const r = await executeBriefTool('emit_metadata_only', {
      title: 'Bradenton Pest Control — Free Inspection in 24 Hours',
      meta_description: 'Same-day Bradenton pest control with a 30-day satisfaction guarantee. Free inspection. Licensed FDACS. Get a quote in under two minutes today.',
    }, { sessionId: sid });
    expect(r.ok).toBe(true);
    const captured = getDraft(sid);
    expect(captured.type).toBe('metadata');
    expect(captured.title).toMatch(/Bradenton/);
    expect(captured.meta_description.length).toBeGreaterThan(100);
    clearDraft(sid);
  });
});

// ── urlToAstroPath ──────────────────────────────────────────────────

describe('urlToAstroPath', () => {
  test.each([
    ['/blog/something/', 'src/content/blog/something.md'],
    ['/pest-control-bradenton-fl/', 'src/content/services/pest-control-bradenton-fl.md'],
    ['https://www.wavespestcontrol.com/lawn-care-sarasota-fl/', 'src/content/services/lawn-care-sarasota-fl.md'],
    ['/lakewood-ranch-fl/', 'src/content/services/lakewood-ranch-fl.md'],
    ['/longboat-key/', 'src/content/locations/longboat-key.md'],
    // bare service hubs must land in services/, not locations/
    ['/lawn-care/', 'src/content/services/lawn-care.md'],
    ['/mosquito-control/', 'src/content/services/mosquito-control.md'],
    ['/pest-control/', 'src/content/services/pest-control.md'],
    ['/termite-control/', 'src/content/services/termite-control.md'],
    ['/pest-control-services/', 'src/content/services/pest-control-services.md'],
  ])('%s → %s', (url, expected) => {
    expect(urlToAstroPath(url)).toBe(expected);
  });
  test('null/empty', () => {
    expect(urlToAstroPath(null)).toBeNull();
    expect(urlToAstroPath('')).toBeNull();
  });
  test.each([
    '/blog/../../../../README',
    '/../etc/passwd',
    '/pages/../config/db',
    '/blog/post%2e%2e/secret',
    '/blog/post\\..\\secret',
    '/UPPERCASE/path',
    '/has space/seg',
    '/-leadinghyphen/',
    '/trailinghyphen-/',
  ])('rejects unsafe path %s', (url) => {
    expect(urlToAstroPath(url)).toBeNull();
  });
});

describe('get_existing_page registry fallback', () => {
  beforeEach(() => {
    db.mockReset();
    gh.getFile.mockReset();
  });

  test('loads canonical blog URLs outside /blog from content_registry source path', async () => {
    const seen = [];
    db.mockReturnValue(registryQuery({ astro_source_path: 'src/content/blog/fertilizer-blackout-sarasota-county.md' }, seen));
    gh.getFile.mockImplementation(async (path) => {
      if (path === 'src/content/blog/fertilizer-blackout-sarasota-county.md') {
        return {
          sha: 'registry-sha',
          content: '---\ntitle: Fertilizer Blackout Sarasota County\n---\nExisting body copy.',
        };
      }
      return null;
    });

    const r = await executeBriefTool('get_existing_page', {
      page_url: '/lawn-care/fertilizer-blackout-sarasota-county/',
    }, { sessionId: 'sess-existing-page' });

    expect(r.error).toBeUndefined();
    expect(r.file_path).toBe('src/content/blog/fertilizer-blackout-sarasota-county.md');
    expect(r.frontmatter.title).toBe('Fertilizer Blackout Sarasota County');
    expect(r.body).toContain('Existing body copy.');
    expect(gh.getFile).toHaveBeenCalledWith('src/content/locations/lawn-care/fertilizer-blackout-sarasota-county.md');
    expect(gh.getFile).toHaveBeenCalledWith('src/content/blog/fertilizer-blackout-sarasota-county.mdx');
    expect(gh.getFile).toHaveBeenCalledWith('src/content/blog/fertilizer-blackout-sarasota-county.md');
    expect(seen).toContainEqual(['live_url', '/lawn-care/fertilizer-blackout-sarasota-county/']);
    expect(seen).not.toContainEqual(['canonical_url_normalized', '/lawn-care/fertilizer-blackout-sarasota-county/']);
  });

  test('preserves external host in content_registry lookup keys', async () => {
    const seen = [];
    db.mockReturnValue(registryQuery(null, seen));
    gh.getFile.mockResolvedValue(null);

    const r = await executeBriefTool('get_existing_page', {
      page_url: 'https://sarasotaflpestcontrol.com/lawn-care/fertilizer-blackout-sarasota-county/',
    }, { sessionId: 'sess-existing-page-external' });

    expect(r.error).toContain('Astro file not found');
    expect(seen).toContainEqual(['live_url', 'https://sarasotaflpestcontrol.com/lawn-care/fertilizer-blackout-sarasota-county/']);
    expect(seen).toContainEqual(['live_url', '/lawn-care/fertilizer-blackout-sarasota-county/']);
    expect(seen).toContainEqual(['whereRaw', 'metadata::text ILIKE ?', ['%sarasotaflpestcontrol.com%']]);
  });
});

// ── parseJsonbColumns helper ────────────────────────────────────────

describe('parseJsonbColumns', () => {
  test('parses string columns, leaves object columns alone', () => {
    const row = {
      a: '{"x":1}',
      b: { y: 2 },
      c: 'not-json',
    };
    const out = parseJsonbColumns(row, ['a', 'b', 'c']);
    expect(out.a).toEqual({ x: 1 });
    expect(out.b).toEqual({ y: 2 });
    expect(out.c).toBe('not-json'); // unchanged on parse failure
  });
});

// ── config shape sanity ─────────────────────────────────────────────

describe('agent configs have valid shape', () => {
  test.each([
    ['writer', WRITER_AGENT_CONFIG, 'waves-content-writer'],
    ['refresher', REFRESH_AGENT_CONFIG, 'waves-content-refresher'],
    ['meta-rewriter', META_REWRITER_CONFIG, 'waves-content-meta-rewriter'],
  ])('%s config', (_label, cfg, expectedName) => {
    expect(cfg.name).toBe(expectedName);
    expect(typeof cfg.description).toBe('string');
    expect(typeof cfg.model).toBe('string');
    expect(typeof cfg.system).toBe('string');
    expect(cfg.system.length).toBeGreaterThan(200);
    expect(Array.isArray(cfg.tools)).toBe(true);
    expect(cfg.tools.length).toBeGreaterThan(1);
  });
  test('writer + refresher both define emit_draft', () => {
    for (const cfg of [WRITER_AGENT_CONFIG, REFRESH_AGENT_CONFIG]) {
      const names = cfg.tools.filter((t) => t.type === 'custom').map((t) => t.name);
      expect(names).toContain('emit_draft');
    }
  });
  test('meta-rewriter defines emit_metadata_only, not emit_draft', () => {
    const names = META_REWRITER_CONFIG.tools.filter((t) => t.type === 'custom').map((t) => t.name);
    expect(names).toContain('emit_metadata_only');
    expect(names).not.toContain('emit_draft');
  });
  test('refresher defines get_existing_page (writer does not)', () => {
    const refreshNames = REFRESH_AGENT_CONFIG.tools.filter((t) => t.type === 'custom').map((t) => t.name);
    const writerNames = WRITER_AGENT_CONFIG.tools.filter((t) => t.type === 'custom').map((t) => t.name);
    expect(refreshNames).toContain('get_existing_page');
    expect(writerNames).not.toContain('get_existing_page');
  });
});

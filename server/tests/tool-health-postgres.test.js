// Real migrated PostgreSQL, synthetic tool_health_events rows, rolled back
// after every test. The clock is moved to 2040 so only these rows fall in
// the window. Health audit HE-01..HE-03.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  return db;
});

const toolHealthRouter = require('../routes/tool-health');

const NOW = new Date('2040-01-10T16:00:00Z').getTime();
const IN_WINDOW = new Date('2040-01-10T15:30:00Z');

function getHandler() {
  const layer = toolHealthRouter.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.get);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

postgres('tool health against migrated PostgreSQL', () => {
  let database;
  let trx;

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
  });

  beforeEach(async () => {
    trx = await database.transaction();
    require('../models/db').connection = trx;
  });

  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  async function events(rows) {
    await trx('tool_health_events').insert(rows.map((row) => ({ created_at: IN_WINDOW, success: true, ...row })));
  }

  async function health(hours) {
    const spy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    const res = {
      statusCode: 200,
      body: undefined,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
    };
    const next = jest.fn();
    try {
      await getHandler()({ query: hours === undefined ? {} : { hours }, params: {}, headers: {} }, res, next);
    } finally {
      spy.mockRestore();
    }
    if (next.mock.calls.length) throw next.mock.calls[0][0];
    return res.body;
  }

  const many = (count, row) => Array.from({ length: count }, () => ({ ...row }));

  test('calls with no context are the "unknown" card, and every card adds up to its rows', async () => {
    await events([
      { source: 'intelligence-bar', context: 'schedule', tool_name: 'find_slots' },
      { source: 'intelligence-bar', context: 'schedule', tool_name: 'find_slots', success: false },
      ...many(2, { source: 'intelligence-bar', context: null, tool_name: 'lookup_customer' }),
      { source: 'intelligence-bar', context: null, tool_name: 'draft_reply', success: false },
      // A request that named "unknown" itself shares the null rows.
      { source: 'intelligence-bar', context: 'unknown', tool_name: 'lookup_customer' },
    ]);
    const body = await health('24');
    const unknown = body.contexts.find((c) => c.context === 'unknown');
    expect(unknown).toMatchObject({ total: 4, failed: 1, toolsUsed: 2 });
    expect(unknown.tools).toHaveLength(2);
    expect(unknown.tools.find((t) => t.toolName === 'lookup_customer')).toMatchObject({ total: 3, failed: 0 });
    for (const card of body.contexts) {
      expect(card.total).toBe(card.tools.reduce((sum, t) => sum + t.total, 0));
      expect(card.failed).toBe(card.tools.reduce((sum, t) => sum + t.failed, 0));
    }
    expect(body.contexts.reduce((sum, c) => sum + c.total, 0)).toBe(body.summary.total);
  });

  test('a failing critical source turns the banner critical under a busy healthy one', async () => {
    await events([
      { source: 'intelligence-bar', context: 'dashboard', tool_name: 'kpi_summary', success: false },
      ...many(40, { source: 'mcp-admin', context: 'mcp', tool_name: 'get_day_summary' }),
    ]);
    const body = await health('24');
    // 1 failure in 41 calls is under the 5% warning line on its own.
    expect(body.summary).toMatchObject({ total: 41, failed: 1 });
    expect(body.agents.find((a) => a.source === 'intelligence-bar').status).toBe('critical');
    expect(body.alerts).toContainEqual({
      severity: 'critical',
      title: 'Admin Intelligence Bar failing',
      detail: '1/1 calls failed (100%) in the last 24h.',
    });
    expect(body.overallStatus).toBe('critical');
  });

  test('a failing source that is not critical makes the banner a warning, not critical', async () => {
    await events([
      { source: 'tech-intelligence-bar', context: 'tech', tool_name: 'route_lookup', success: false },
      ...many(40, { source: 'mcp-admin', context: 'mcp', tool_name: 'get_day_summary' }),
    ]);
    const body = await health('24');
    expect(body.agents.find((a) => a.source === 'tech-intelligence-bar').status).toBe('critical');
    expect(body.alerts).toContainEqual(expect.objectContaining({ severity: 'warning', title: 'Tech Intelligence Bar failing' }));
    expect(body.overallStatus).toBe('warning');
  });

  test('healthy traffic stays Healthy, and the window is the hours asked for', async () => {
    await events([
      ...many(5, { source: 'intelligence-bar', context: 'dashboard', tool_name: 'kpi_summary' }),
      // Two hours back: inside 24h, outside 1h.
      { source: 'intelligence-bar', context: 'dashboard', tool_name: 'kpi_summary', created_at: new Date('2040-01-10T14:00:00Z') },
    ]);
    const day = await health(undefined);
    expect(day).toMatchObject({ windowHours: 24, overallStatus: 'ok', alerts: [] });
    expect(day.summary.total).toBe(6);
    const hour = await health('1');
    expect(hour).toMatchObject({ windowHours: 1, overallStatus: 'ok' });
    expect(hour.summary.total).toBe(5);
  });
});

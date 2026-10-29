/**
 * GATE_BI_TECH_SCORECARD: with the gate off, get_operations_snapshot has no techScorecard key and the
 * agent's prompt and tools are today's; with it on, the snapshot carries the scorecard and the prompt
 * and the one tool description gain the scorecard rules. Nothing is sent and no model is called.
 */
const makeChain = (value) => {
  const chain = {
    where: () => chain, whereNull: () => chain, whereIn: () => chain, count: () => chain, select: () => chain,
    first: () => Promise.resolve(value),
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return chain;
};
const mockDb = jest.fn((table) => makeChain(table === 'scheduled_services' ? { total: '10', completed: '8', count: '2' } : []));
mockDb.raw = (sql) => sql;

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/forecast-analyzer', () => ({ analyzeTomorrow: async () => ({ needsReschedule: [] }) }));
const mockComputeCoreKpis = jest.fn(async () => ({}));
jest.mock('../routes/admin-dashboard', () => ({ computeCoreKpis: (...a) => mockComputeCoreKpis(...a) }));
const mockBuild = jest.fn();
jest.mock('../services/bi-tech-scorecard', () => ({ buildTechScorecard: (...a) => mockBuild(...a) }));

const { executeBITool } = require('../services/bi-agent-tools');
const { BI_AGENT_CONFIG } = require('../services/bi-agent-config');

const SNAPSHOT_KEYS = [
  'servicesThisWeek', 'completedThisWeek', 'completionRate', 'servicesToday', 'unassigned', 'tomorrowRescheduleCount',
  'tomorrowWeather', 'kpis', 'opsLine', 'kpiWindow',
];
const SCORECARD = { week: { from: '2026-10-26', to: '2026-11-01' }, rows: [{ technician: 'Ada' }] };

beforeEach(() => { delete process.env.GATE_BI_TECH_SCORECARD; mockBuild.mockReset(); });
afterAll(() => { delete process.env.GATE_BI_TECH_SCORECARD; });

describe('get_operations_snapshot techScorecard', () => {
  test('gate off: no techScorecard key, and the scorecard is never built', async () => {
    const result = await executeBITool('get_operations_snapshot', {});
    expect(Object.keys(result)).toEqual(SNAPSHOT_KEYS);
    expect(mockBuild).not.toHaveBeenCalled();
    process.env.GATE_BI_TECH_SCORECARD = 'TRUE';
    expect(Object.keys(await executeBITool('get_operations_snapshot', {}))).toEqual(SNAPSHOT_KEYS);
  });

  test('gate on: the snapshot carries the scorecard after today\'s keys', async () => {
    process.env.GATE_BI_TECH_SCORECARD = 'true';
    mockBuild.mockResolvedValue(SCORECARD);
    const result = await executeBITool('get_operations_snapshot', {});
    expect(Object.keys(result)).toEqual([...SNAPSHOT_KEYS, 'techScorecard']);
    expect(result.techScorecard).toBe(SCORECARD);
  });

  test('gate on: a scorecard failure leaves the rest of the snapshot and says unavailable', async () => {
    process.env.GATE_BI_TECH_SCORECARD = 'true';
    mockBuild.mockRejectedValue(new Error('boom'));
    const result = await executeBITool('get_operations_snapshot', {});
    expect(result.techScorecard).toEqual({ rows: [], unavailable: 'scorecard failed' });
    expect(result.opsLine).toEqual(expect.any(String));
  });
});

describe('BI agent config', () => {
  const snapshotTool = (tools) => tools.find((t) => t.name === 'get_operations_snapshot');

  test('gate off: no scorecard text anywhere in the prompt or tools', () => {
    expect(BI_AGENT_CONFIG.system).not.toMatch(/techScorecard|TECHNICIAN SCORECARD/);
    expect(JSON.stringify(BI_AGENT_CONFIG.tools)).not.toMatch(/techScorecard/);
    expect(BI_AGENT_CONFIG.tools).toBe(BI_AGENT_CONFIG.tools); // same constant on every read
  });

  test('gate on: today\'s prompt plus the scorecard rules; only the snapshot tool description changes', () => {
    const offSystem = BI_AGENT_CONFIG.system;
    const offTools = BI_AGENT_CONFIG.tools;
    process.env.GATE_BI_TECH_SCORECARD = 'true';
    const onTools = BI_AGENT_CONFIG.tools;
    expect(BI_AGENT_CONFIG.system.startsWith(offSystem)).toBe(true);
    expect(BI_AGENT_CONFIG.system).toMatch(/ONLY when techScorecard\.rows has 2 or more technicians/);
    expect(BI_AGENT_CONFIG.system).toMatch(/operations_section ALWAYS carries the full table/);
    expect(onTools.map((t) => t.name)).toEqual(offTools.map((t) => t.name));
    onTools.forEach((tool, i) => {
      if (tool.name === 'get_operations_snapshot') return;
      expect(tool).toBe(offTools[i]);
    });
    expect(snapshotTool(onTools).description.startsWith(snapshotTool(offTools).description)).toBe(true);
    expect(snapshotTool(onTools).description).toMatch(/techScorecard/);
    expect(snapshotTool(onTools).input_schema).toEqual(snapshotTool(offTools).input_schema);
  });
});

jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
  logGateStatus: jest.fn(),
}));

const {
  parseListEnv,
  parsePositiveEnvInt,
  runContentRegistryMaintenance,
} = require('../services/scheduler');

describe('scheduler content registry maintenance', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  test('parses maintenance env controls conservatively', () => {
    expect(parseListEnv('matched, conflict ,,db_changed_since_sync', ['fallback'])).toEqual([
      'matched',
      'conflict',
      'db_changed_since_sync',
    ]);
    expect(parseListEnv('', ['fallback'])).toEqual(['fallback']);
    expect(parsePositiveEnvInt('25', 300)).toBe(25);
    expect(parsePositiveEnvInt('-1', 300)).toBe(300);
    expect(parsePositiveEnvInt('bad', 300)).toBe(300);
  });

  test('runs GitHub-backed sync before live status refresh', async () => {
    process.env.CONTENT_REGISTRY_GITHUB_REF = 'main';
    process.env.CONTENT_REGISTRY_LIVE_STATUS_STATUSES = 'matched,conflict';
    process.env.CONTENT_REGISTRY_LIVE_STATUS_LIMIT = '25';

    const registry = {
      runContentRegistrySync: jest.fn().mockResolvedValue({
        ok: true,
        sync_run_id: 'sync-1',
        summary: { matched: 199, conflicts: 0 },
      }),
    };
    const liveStatus = {
      runContentRegistryLiveStatusCheck: jest.fn().mockResolvedValue({
        ok: true,
        summary: { checked: 25, updated: 2 },
      }),
    };

    const result = await runContentRegistryMaintenance({ registry, liveStatus });

    expect(registry.runContentRegistrySync).toHaveBeenCalledWith(expect.objectContaining({
      astroSource: 'github',
      githubRef: 'main',
      contentType: null,
      commit: true,
    }));
    expect(liveStatus.runContentRegistryLiveStatusCheck).toHaveBeenCalledWith({
      statuses: ['matched', 'conflict'],
      limit: 25,
      commit: true,
    });
    expect(result).toMatchObject({
      sync_run_id: 'sync-1',
      statuses: ['matched', 'conflict'],
      limit: 25,
    });
  });

  test('fails closed when registry sync fails', async () => {
    const registry = {
      runContentRegistrySync: jest.fn().mockResolvedValue({
        ok: false,
        error: 'GitHub source unavailable',
      }),
    };
    const liveStatus = {
      runContentRegistryLiveStatusCheck: jest.fn(),
    };

    await expect(runContentRegistryMaintenance({ registry, liveStatus })).rejects.toThrow(/GitHub source unavailable/);
    expect(liveStatus.runContentRegistryLiveStatusCheck).not.toHaveBeenCalled();
  });
});

/**
 * GBP ops tool — unit tests with a mocked google-business service.
 * Read-only contract: benign dark state, per-location isolation (one
 * location's API failure never blanks the others), listing-state mapping,
 * post summary truncation, failures as { error }.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

jest.mock('../config/locations', () => ({
  WAVES_LOCATIONS: [
    { id: 'bradenton', name: 'Lakewood Ranch', googleLocationResourceName: 'accounts/1/locations/11' },
    { id: 'venice', name: 'Venice', googleLocationResourceName: 'accounts/1/locations/22' },
  ],
}));

const mockGbp = {
  configured: false,
  isLocationConfigured: jest.fn(),
  getLocationDetails: jest.fn(),
  listLocalPosts: jest.fn(),
};
jest.mock('../services/google-business', () => mockGbp);

const { executeGbpOpsTool } = require('../services/intelligence-bar/gbp-ops-tools');

describe('intelligence bar GBP ops tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGbp.configured = false;
  });

  test('unconfigured state is benign — no error field and no location calls', async () => {
    const result = await executeGbpOpsTool('get_gbp_status');
    expect(result.error).toBeUndefined();
    expect(result.configured).toBe(false);
    expect(result.message).toMatch(/GBP_CLIENT_ID/);
    expect(mockGbp.isLocationConfigured).not.toHaveBeenCalled();
  });

  test('unknown tool name returns an error result', async () => {
    mockGbp.configured = true;
    const result = await executeGbpOpsTool('create_gbp_post');
    expect(result.error).toMatch(/Unknown tool/);
  });

  test('maps listing state and recent posts per location; one failure stays isolated', async () => {
    mockGbp.configured = true;
    mockGbp.isLocationConfigured.mockImplementation(async (id) => id === 'bradenton');
    mockGbp.getLocationDetails.mockResolvedValueOnce({
      locationState: { isVerified: true, isPublished: true, isSuspended: false },
    });
    mockGbp.listLocalPosts.mockRejectedValueOnce(new Error('quota exceeded'));

    const result = await executeGbpOpsTool('get_gbp_status');
    expect(result.error).toBeUndefined();
    expect(result.total).toBe(2);
    expect(result.connected).toBe(1);

    const bradenton = result.locations.find(l => l.location_id === 'bradenton');
    expect(bradenton.connected).toBe(true);
    expect(bradenton.listing_state).toEqual({
      is_verified: true, is_published: true, is_suspended: false, is_disconnected: null,
    });
    // Posts call failed — isolated to its own field, listing state intact
    expect(bradenton.posts_error).toMatch(/quota exceeded/);

    const venice = result.locations.find(l => l.location_id === 'venice');
    expect(venice.connected).toBe(false);
    expect(venice.note).toMatch(/reconnect/i);
    expect(mockGbp.getLocationDetails).toHaveBeenCalledTimes(1);
  });

  test('post summaries are truncated', async () => {
    mockGbp.configured = true;
    mockGbp.isLocationConfigured.mockResolvedValue(true);
    mockGbp.getLocationDetails.mockResolvedValue({ locationState: {} });
    mockGbp.listLocalPosts.mockResolvedValue([
      { createTime: '2026-07-15T12:00:00Z', state: 'LIVE', summary: 'z'.repeat(500) },
    ]);

    const result = await executeGbpOpsTool('get_gbp_status');
    expect(result.error).toBeUndefined();
    for (const loc of result.locations) {
      expect(loc.recent_posts[0].summary).toHaveLength(140);
      expect(loc.recent_posts[0].state).toBe('LIVE');
    }
  });
});

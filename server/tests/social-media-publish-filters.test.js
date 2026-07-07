// Publish-filter fail-closed semantics. The regression this guards: channels
// and gbpLocationIds come from req.body, so a malformed EXPLICIT value (a bare
// string instead of an array) must NOT fall back to "post everywhere" — only a
// truly omitted (null/undefined) filter defaults to all.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config', () => ({ s3: {} }));

const social = require('../services/social-media');
const { normalizePublishChannels, normalizeGbpLocationIds } = social;

describe('normalizePublishChannels', () => {
  test('omitted (null/undefined) defaults to the LEGACY four platforms — Twitter is explicit-opt-in (the admin Publish All flow previews only these four)', () => {
    expect(normalizePublishChannels(undefined)).toEqual(new Set(['facebook', 'instagram', 'linkedin', 'gbp']));
    expect(normalizePublishChannels(null)).toEqual(new Set(['facebook', 'instagram', 'linkedin', 'gbp']));
  });

  test('a valid array selects only those platforms (twitter selectable explicitly)', () => {
    expect(normalizePublishChannels(['facebook', 'gbp'])).toEqual(new Set(['facebook', 'gbp']));
    expect(normalizePublishChannels(['Facebook ', 'INSTAGRAM'])).toEqual(new Set(['facebook', 'instagram']));
    expect(normalizePublishChannels(['twitter'])).toEqual(new Set(['twitter']));
  });

  test('the autonomous blog-share channel list covers every platform incl. twitter', () => {
    expect(social.PUBLISH_PLATFORMS).toEqual(['facebook', 'instagram', 'linkedin', 'gbp', 'twitter']);
    expect(social.DEFAULT_PUBLISH_PLATFORMS).toEqual(['facebook', 'instagram', 'linkedin', 'gbp']);
  });

  test('malformed EXPLICIT value fails closed to no platforms (never all)', () => {
    expect(normalizePublishChannels('facebook')).toEqual(new Set());     // string, not array
    expect(normalizePublishChannels({ facebook: true })).toEqual(new Set());
    expect(normalizePublishChannels(42)).toEqual(new Set());
  });

  test('an all-invalid or empty array yields no platforms', () => {
    expect(normalizePublishChannels([])).toEqual(new Set());
    expect(normalizePublishChannels(['myspace', 'tiktok'])).toEqual(new Set());
  });
});

describe('normalizeGbpLocationIds', () => {
  test('omitted (null/undefined) → null = all GBP locations', () => {
    expect(normalizeGbpLocationIds(undefined)).toBeNull();
    expect(normalizeGbpLocationIds(null)).toBeNull();
  });

  test('malformed EXPLICIT value fails closed to an empty set (never all)', () => {
    expect(normalizeGbpLocationIds('sarasota')).toEqual(new Set());
    expect(normalizeGbpLocationIds(99)).toEqual(new Set());
  });

  test('an all-invalid or empty array yields an empty set', () => {
    expect(normalizeGbpLocationIds([])).toEqual(new Set());
    expect(normalizeGbpLocationIds(['not-a-location'])).toEqual(new Set());
  });
});

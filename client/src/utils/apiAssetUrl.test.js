import { describe, expect, test } from 'vitest';
import { resolveApiAssetUrl } from './apiAssetUrl';

describe('resolveApiAssetUrl', () => {
  test('leaves same-origin /api paths alone', () => {
    expect(resolveApiAssetUrl('/api/estimates/tok/map/satellite', '/api')).toBe('/api/estimates/tok/map/satellite');
  });
  test('rebases /api paths onto a configured API origin', () => {
    expect(resolveApiAssetUrl('/api/estimates/tok/map/satellite', 'https://api.example.test/api/'))
      .toBe('https://api.example.test/api/estimates/tok/map/satellite');
  });
  test('passes other values through', () => {
    expect(resolveApiAssetUrl('https://cdn.example.test/x.png', 'https://api.example.test/api')).toBe('https://cdn.example.test/x.png');
    expect(resolveApiAssetUrl(null)).toBeNull();
  });
});

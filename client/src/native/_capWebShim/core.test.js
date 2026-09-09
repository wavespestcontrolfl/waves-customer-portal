import { describe, expect, it } from 'vitest';
import { Capacitor, registerPlugin } from './core';

describe('Capacitor browser shim', () => {
  it('supports the named registration import while keeping native paths disabled', () => {
    expect(Capacitor.isNativePlatform()).toBe(false);
    expect(Capacitor.getPlatform()).toBe('web');
    expect(Capacitor.isPluginAvailable('WavesBadge')).toBe(false);
    expect(registerPlugin('WavesBadge')).toEqual({});
  });
});

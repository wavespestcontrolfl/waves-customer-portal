import { describe, it, expect } from 'vitest';
import { detectDynamicViewportUnit } from './viewportUnits.js';

describe('detectDynamicViewportUnit', () => {
  it('uses dvh when the engine reports support', () => {
    expect(detectDynamicViewportUnit({ supports: (prop, value) => prop === 'height' && value === '100dvh' })).toBe('dvh');
  });

  it('falls back to vh when dvh is unsupported', () => {
    expect(detectDynamicViewportUnit({ supports: () => false })).toBe('vh');
  });

  it('falls back to vh when CSS.supports is missing or throws', () => {
    expect(detectDynamicViewportUnit(undefined)).toBe('vh');
    expect(detectDynamicViewportUnit({})).toBe('vh');
    expect(detectDynamicViewportUnit({ supports: () => { throw new Error('nope'); } })).toBe('vh');
  });
});

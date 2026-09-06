// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  applyGlassScene,
  attachGlassPointerFx,
  fireGlassConfetti,
  useGlassSurface,
} from './glass-engine';

const setSearch = (search) => {
  window.history.replaceState(null, '', `/e/test${search}`);
};

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});

afterEach(() => {
  setSearch('');
  document.documentElement.removeAttribute('data-glass-theme');
  document.documentElement.style.background = '';
  document.body.style.background = '';
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('applyGlassScene', () => {
  it('the scene mounts attribute, orbs, and grain; cleanup restores everything', () => {
    document.documentElement.style.background = 'rgb(1, 2, 3)';
    document.body.style.background = 'rgb(4, 5, 6)';

    const { orbs, cleanup } = applyGlassScene();
    expect(document.documentElement.hasAttribute('data-glass-theme')).toBe(true);
    expect(orbs).toBe(document.querySelector('.glass-scene-orbs'));
    expect(orbs.querySelectorAll('.glass-orb')).toHaveLength(5);
    expect(document.querySelector('.glass-scene-grain')).not.toBeNull();
    expect(document.getElementById('root').style.zIndex).toBe('1');

    cleanup();
    expect(document.documentElement.hasAttribute('data-glass-theme')).toBe(false);
    expect(document.querySelector('.glass-scene-orbs')).toBeNull();
    expect(document.querySelector('.glass-scene-grain')).toBeNull();
    expect(document.documentElement.style.background).toBe('rgb(1, 2, 3)');
    expect(document.body.style.background).toBe('rgb(4, 5, 6)');
  });

});

describe('attachGlassPointerFx', () => {

  it('detach removes listeners and the specular vars', () => {
    const { orbs, cleanup } = applyGlassScene();
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const detach = attachGlassPointerFx(document.documentElement, orbs, false);
    expect(add).toHaveBeenCalledWith('pointermove', expect.any(Function), { passive: true });

    document.documentElement.style.setProperty('--mx', '40%');
    document.documentElement.style.setProperty('--my', '60%');
    detach();
    expect(remove).toHaveBeenCalledWith('pointermove', expect.any(Function));
    expect(document.documentElement.style.getPropertyValue('--mx')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--my')).toBe('');
    cleanup();
  });
});

describe('fireGlassConfetti', () => {
  it('no-ops when no glass theme is mounted', () => {
    const before = document.body.childElementCount;
    fireGlassConfetti(10, 10);
    expect(document.body.childElementCount).toBe(before);
  });

  it('no-ops when Element.animate is unavailable (jsdom)', () => {
    document.documentElement.setAttribute('data-glass-theme', '');
    const before = document.body.childElementCount;
    fireGlassConfetti(10, 10);
    expect(document.body.childElementCount).toBe(before);
  });
});

describe('useGlassSurface', () => {
  it('mounts the scene while active and tears it down on unmount', () => {
    const { unmount } = renderHook(() => useGlassSurface(true));
    expect(document.documentElement.hasAttribute('data-glass-theme')).toBe(true);
    expect(document.querySelector('.glass-scene-orbs')).not.toBeNull();
    unmount();
    expect(document.documentElement.hasAttribute('data-glass-theme')).toBe(false);
    expect(document.querySelector('.glass-scene-orbs')).toBeNull();
  });

  it('does nothing when inactive', () => {
    const { unmount } = renderHook(() => useGlassSurface(false));
    expect(document.documentElement.hasAttribute('data-glass-theme')).toBe(false);
    unmount();
  });

});

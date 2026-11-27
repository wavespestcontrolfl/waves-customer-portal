// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ native: true, platform: 'android', backListener: null }));
const App = vi.hoisted(() => ({
  addListener: vi.fn(async (event, cb) => {
    if (event === 'backButton') state.backListener = cb;
    return { remove: vi.fn() };
  }),
  minimizeApp: vi.fn(async () => {}),
  exitApp: vi.fn(async () => {}),
}));

vi.mock('./platform', () => ({
  isNativeApp: () => state.native,
  nativePlatform: () => state.platform,
}));
vi.mock('@capacitor/app', () => ({ App }));

import {
  dismissVisibleDialog,
  handleAndroidBackButton,
  initNativeBackButton,
  registerBackButtonHandler,
  _resetNativeBackButtonForTests,
} from './nativeBackButton';

beforeEach(() => {
  state.native = true;
  state.platform = 'android';
  state.backListener = null;
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  _resetNativeBackButtonForTests();
  document.body.innerHTML = '';
});

describe('nativeBackButton (Android hardware/gesture Back)', () => {
  it('registers the backButton listener only on native Android', async () => {
    state.platform = 'ios';
    expect(await initNativeBackButton()).toBe(false);
    expect(App.addListener).not.toHaveBeenCalled();

    state.platform = 'android';
    expect(await initNativeBackButton()).toBe(true);
    expect(App.addListener).toHaveBeenCalledWith('backButton', expect.any(Function));
  });

  it('walks registered handlers in LIFO order so topmost modals/sheets close first', async () => {
    const events = [];
    const unregisterTab = registerBackButtonHandler(() => { events.push('tab'); return true; });
    const unregisterModal = registerBackButtonHandler(() => { events.push('modal'); return true; });

    expect(await handleAndroidBackButton({ canGoBack: true }, App)).toBe('handled');
    expect(events).toEqual(['modal']);
    expect(App.minimizeApp).not.toHaveBeenCalled();

    unregisterModal();
    expect(await handleAndroidBackButton({ canGoBack: true }, App)).toBe('handled');
    expect(events).toEqual(['modal', 'tab']);
    unregisterTab();
  });

  it('dispatches Escape to dismiss an open modal dialog inside a child tab', async () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.getClientRects = () => [{ width: 300, height: 300 }];
    document.body.appendChild(dialog);

    const onKeyDown = vi.fn();
    document.addEventListener('keydown', onKeyDown);
    try {
      expect(await handleAndroidBackButton({ canGoBack: true }, App)).toBe('dialog-escape');
      expect(onKeyDown).toHaveBeenCalledWith(expect.objectContaining({ key: 'Escape' }));
    } finally {
      document.removeEventListener('keydown', onKeyDown);
    }
  });

  it('lets a portal handler dismiss an active child-tab dialog before switching tabs to Home', async () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.getClientRects = () => [{ width: 300, height: 300 }];
    document.body.appendChild(dialog);

    const switchTab = vi.fn();
    const onKeyDown = vi.fn();
    document.addEventListener('keydown', onKeyDown);
    const unregister = registerBackButtonHandler(() => {
      if (dismissVisibleDialog()) return true;
      switchTab('dashboard');
      return true;
    });
    try {
      expect(await handleAndroidBackButton({ canGoBack: true }, App)).toBe('handled');
      expect(onKeyDown).toHaveBeenCalledWith(expect.objectContaining({ key: 'Escape' }));
      expect(switchTab).not.toHaveBeenCalled();

      dialog.remove();
      expect(await handleAndroidBackButton({ canGoBack: true }, App)).toBe('handled');
      expect(switchTab).toHaveBeenCalledWith('dashboard');
    } finally {
      unregister();
      document.removeEventListener('keydown', onKeyDown);
    }
  });

  it('uses browser history on sub-routes and minimizes cleanly at Home root', async () => {
    const backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    try {
      window.history.replaceState({}, '', '/report/abc123');
      expect(await handleAndroidBackButton({ canGoBack: true }, App)).toBe('history-back');
      expect(backSpy).toHaveBeenCalledTimes(1);
      expect(App.minimizeApp).not.toHaveBeenCalled();

      window.history.replaceState({}, '', '/');
      expect(await handleAndroidBackButton({ canGoBack: true }, App)).toBe('minimized');
      expect(App.minimizeApp).toHaveBeenCalledTimes(1);
    } finally {
      backSpy.mockRestore();
    }
  });

  it('falls back to exitApp when minimizeApp throws on an older binary', async () => {
    App.minimizeApp.mockRejectedValueOnce(new Error('not implemented'));
    expect(await handleAndroidBackButton({ canGoBack: false }, App)).toBe('minimized');
    expect(App.exitApp).toHaveBeenCalledTimes(1);
  });
});

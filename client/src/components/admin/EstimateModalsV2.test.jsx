// @vitest-environment jsdom
// UI audit F0076: the modals surface the server's error reason, not "HTTP 409".
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeclineModalV2 } from './EstimateModalsV2';

beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'test-token');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('DeclineModalV2 error surfacing', () => {
  it('alerts with the server reason on a 409', async () => {
    const reason = 'This estimate is held for a re-price (a customer clarify reply).';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: reason }), { status: 409, headers: { 'Content-Type': 'application/json' } })));
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const onSaved = vi.fn();
    render(<DeclineModalV2 estimate={{ id: 'e1', customerName: 'Pat Customer' }} onClose={() => {}} onSaved={onSaved} />);
    fireEvent.click(screen.getAllByRole('radio')[0]);
    fireEvent.click(screen.getByRole('button', { name: /mark as lost|save/i }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1));
    expect(alertSpy.mock.calls[0][0]).toContain(reason);
    expect(alertSpy.mock.calls[0][0]).not.toContain('HTTP 409');
    expect(onSaved).not.toHaveBeenCalled();
  });
});

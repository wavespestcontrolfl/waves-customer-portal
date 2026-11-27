// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VisitHoldControls, { OnHoldChip } from './VisitHoldControls';

const VISIT = { id: 'v-1', status: 'confirmed', customerName: 'Pat Sample' };
let calls;

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null, method: init?.method });
    return { ok: true, json: async () => ({ success: true }) };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('VisitHoldControls', () => {
  it('shows nothing while the gate is off', () => {
    const { container } = render(<VisitHoldControls service={VISIT} enabled={false} adminActions />);
    expect(container).toBeEmptyDOMElement();
  });

  it('asks before holding, sends the note, and reports the change', async () => {
    const onChanged = vi.fn();
    render(<VisitHoldControls service={VISIT} enabled adminActions={false} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Customer will call - put on hold' }));
    expect(screen.getByTestId('hold-confirm')).toHaveTextContent('no reminder texts go out');
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: ' said he will call ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm hold' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(calls).toEqual([{ url: '/api/admin/schedule/v-1/hold', method: 'POST', body: { note: 'said he will call' } }]);
  });

  it('offers no hold on a visit that is not pending or confirmed', () => {
    const { container } = render(<VisitHoldControls service={{ ...VISIT, status: 'completed' }} enabled adminActions />);
    expect(container).toBeEmptyDOMElement();
  });

  it('a held visit shows Release hold to the office only', async () => {
    const held = { ...VISIT, heldAt: '2026-11-10T15:00:00Z' };
    const tech = render(<VisitHoldControls service={held} enabled adminActions={false} />);
    expect(tech.container).toBeEmptyDOMElement();
    tech.unmount();
    const onChanged = vi.fn();
    render(<VisitHoldControls service={held} enabled adminActions onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Release hold' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls[0].url).toBe('/api/admin/schedule/v-1/hold/release');
  });

  it('shows the server refusal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: 'A completed visit cannot be put on hold' }) })));
    render(<VisitHoldControls service={VISIT} enabled adminActions />);
    fireEvent.click(screen.getByRole('button', { name: 'Customer will call - put on hold' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm hold' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('cannot be put on hold');
  });
});

describe('OnHoldChip', () => {
  it('renders only for a held visit', () => {
    const { container, rerender } = render(<OnHoldChip service={VISIT} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<OnHoldChip service={{ ...VISIT, heldAt: '2026-11-10T15:00:00Z' }} />);
    expect(screen.getByTestId('on-hold-chip')).toHaveTextContent('On hold');
  });
});

// @vitest-environment jsdom
// GATE_DAY_ONLY_PROMISE part E: an editor opened on a row from any feed (the month view, a customer page) reads the visit's
// office fields first, so its "Customer asked for this time" box starts from the stored choice.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const gate = { on: true };
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlag: (key) => key === 'day_only_promise' && gate.on }));

import { needsOfficeFields, withOfficeFields } from './useHydratedOfficeService';

const Probe = ({ service }) => (
  <div data-testid="probe">{String(service.customerAskedTime)}|{service.told ? service.told.level : '-'}|{String(service.reminder24hOn)}</div>
);

const reply = (body) => ({ ok: true, json: async () => body });

beforeEach(() => { gate.on = true; localStorage.setItem('waves_admin_token', 'test-token'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('needsOfficeFields', () => {
  it('only with the gate on and a row that lacks the fields', () => {
    expect(needsOfficeFields({ id: 'v1' }, true)).toBe(true);
    expect(needsOfficeFields({ id: 'v1', customerAskedTime: null }, true)).toBe(false);
    expect(needsOfficeFields({ id: 'v1', customerAskedTime: false }, true)).toBe(false);
    expect(needsOfficeFields({ id: 'v1' }, false)).toBe(false);
    expect(needsOfficeFields(null, true)).toBe(false);
  });
});

describe('withOfficeFields', () => {
  it('a row without the fields: the editor waits, reads visit-summary once, then opens with the stored choice', async () => {
    const fetcher = vi.fn(async () => reply({ visit: null, office: { customerAskedTime: true, told: { level: 'hour' }, reminder24hOn: true } }));
    vi.stubGlobal('fetch', fetcher);
    const Wrapped = withOfficeFields(Probe, { block: true });
    render(<Wrapped service={{ id: 'v1' }} />);
    expect(screen.queryByTestId('probe')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('true|hour|true'));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toMatch(/\/admin\/schedule\/v1\/visit-summary$/);
  });

  it('a failed read still opens the editor, with the choice unknown (unchecked), no badge and no reminder answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const Wrapped = withOfficeFields(Probe, { block: true });
    render(<Wrapped service={{ id: 'v1' }} />);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('null|-|undefined'));
  });

  it('the visit sheet (block: false) shows at once and merges the fields in', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ visit: null, office: { customerAskedTime: false, told: { level: 'day' } } })));
    const Wrapped = withOfficeFields(Probe, { block: false });
    render(<Wrapped service={{ id: 'v1' }} />);
    expect(screen.getByTestId('probe').textContent).toBe('undefined|-|undefined');
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('false|day|undefined'));
  });

  it('no request: a row that carries the fields, the gate off, or a technician\'s sheet', async () => {
    const fetcher = vi.fn(async () => reply({}));
    vi.stubGlobal('fetch', fetcher);
    const Wrapped = withOfficeFields(Probe, { block: true });
    render(<Wrapped service={{ id: 'v1', customerAskedTime: false, reminder24hOn: true }} />);
    expect(screen.getByTestId('probe').textContent).toBe('false|-|true');
    cleanup();
    gate.on = false;
    render(<Wrapped service={{ id: 'v1' }} />);
    expect(screen.getByTestId('probe').textContent).toBe('undefined|-|undefined');
    cleanup();
    gate.on = true;
    render(<Wrapped service={{ id: 'v1' }} adminActions={false} />);
    expect(screen.getByTestId('probe').textContent).toBe('undefined|-|undefined');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

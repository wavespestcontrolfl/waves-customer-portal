// @vitest-environment jsdom
// GATE_DAY_ONLY_PROMISE part E: an editor opened on a row from any feed (the month view, a customer page) reads the visit's
// office fields first, so its "Customer asked for this time" box starts from the stored choice.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const gate = { on: true };
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlag: (key) => key === 'day_only_promise' && gate.on }));

import { needsOfficeFields, usePropertyReminderAnswer, withOfficeFields } from './useHydratedOfficeService';

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
  const Wrapped = withOfficeFields(Probe, { block: true });
  const asText = () => screen.getByTestId('probe').textContent;

  it('a row without the fields: the editor waits, reads visit-summary once, then opens with the stored choice (true = checked)', async () => {
    const fetcher = vi.fn(async () => reply({ visit: null, office: { customerAskedTime: true, told: { level: 'hour' }, reminder24hOn: true } }));
    vi.stubGlobal('fetch', fetcher);
    render(<Wrapped service={{ id: 'v1' }} />);
    expect(screen.queryByTestId('probe')).toBeNull();
    await waitFor(() => expect(asText()).toBe('true|hour|true'));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toMatch(/\/admin\/schedule\/v1\/visit-summary$/);
  });

  it('a successful read with no recorded choice (office present, customerAskedTime null) is a real "no choice": opens unchecked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ visit: null, office: { customerAskedTime: null, reminder24hOn: true } })));
    render(<Wrapped service={{ id: 'v1' }} />);
    await waitFor(() => expect(asText()).toBe('null|-|true'));
  });

  it('a failed read is retried once, then the editor does NOT open on a default: Try again and Close show instead', async () => {
    const fetcher = vi.fn(async () => { throw new Error('offline'); });
    vi.stubGlobal('fetch', fetcher);
    const onClose = vi.fn();
    render(<Wrapped service={{ id: 'v1' }} onClose={onClose} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Could not load this appointment. You can try again.'));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('probe')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Try again reads again and opens the editor when the read now works', async () => {
    let healthy = false;
    const fetcher = vi.fn(async () => {
      if (!healthy) throw new Error('offline');
      return reply({ visit: null, office: { customerAskedTime: true } });
    });
    vi.stubGlobal('fetch', fetcher);
    render(<Wrapped service={{ id: 'v1' }} onClose={vi.fn()} />);
    await screen.findByRole('alert');
    healthy = true;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(asText()).toBe('true|-|undefined'));
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('a non-OK reply, a reply without `office`, and an office without the stored choice are all UNKNOWN (retried, then the failed panel)', async () => {
    for (const make of [
      () => ({ ok: false, status: 500, json: async () => ({ office: { customerAskedTime: true } }) }),
      () => reply({ visit: null }),
      () => reply({ visit: null, office: { told: { level: 'day' } } }),
    ]) {
      const fetcher = vi.fn(async () => make());
      vi.stubGlobal('fetch', fetcher);
      const view = render(<Wrapped service={{ id: 'v1' }} onClose={vi.fn()} />);
      await screen.findByRole('alert');
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId('probe')).toBeNull();
      view.unmount();
    }
  });

  it('the visit sheet (block: false) shows at once, merges the fields in, and keeps showing without them if the read never works', async () => {
    const Sheet = withOfficeFields(Probe, { block: false });
    vi.stubGlobal('fetch', vi.fn(async () => reply({ visit: null, office: { customerAskedTime: false, told: { level: 'day' } } })));
    render(<Sheet service={{ id: 'v1' }} />);
    expect(asText()).toBe('undefined|-|undefined');
    await waitFor(() => expect(asText()).toBe('false|day|undefined'));
    cleanup();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    render(<Sheet service={{ id: 'v2' }} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    expect(asText()).toBe('undefined|-|undefined');
  });

  it('no request: a row that carries the fields, the gate off, or a technician\'s sheet', async () => {
    const fetcher = vi.fn(async () => reply({}));
    vi.stubGlobal('fetch', fetcher);
    render(<Wrapped service={{ id: 'v1', customerAskedTime: false, reminder24hOn: true }} />);
    expect(asText()).toBe('false|-|true');
    cleanup();
    gate.on = false;
    render(<Wrapped service={{ id: 'v1' }} />);
    expect(asText()).toBe('undefined|-|undefined');
    cleanup();
    gate.on = true;
    render(<Wrapped service={{ id: 'v1' }} adminActions={false} />);
    expect(asText()).toBe('undefined|-|undefined');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('a late reply for an earlier row never replaces the current row\'s answer (A then B)', () => {
  it('office fields: visit v1\'s late reply after switching to v2 leaves v2\'s fields', async () => {
    let releaseA;
    const heldA = new Promise((resolve) => { releaseA = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/v1/')) { await heldA; return reply({ visit: null, office: { customerAskedTime: true } }); }
      return reply({ visit: null, office: { customerAskedTime: false } });
    }));
    const Wrapped = withOfficeFields(Probe, { block: true });
    const view = render(<Wrapped service={{ id: 'v1' }} />);
    view.rerender(<Wrapped service={{ id: 'v2' }} />);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('false|-|undefined'));
    releaseA();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.getByTestId('probe').textContent).toBe('false|-|undefined');
  });

  it('property reminder answer: customer A\'s late reply after switching to B leaves B\'s answer', async () => {
    let releaseA;
    const heldA = new Promise((resolve) => { releaseA = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/cust-a/')) { await heldA; return reply({ reminder24hOn: false, reminder24hByProperty: {} }); }
      return reply({ reminder24hOn: true, reminder24hByProperty: {} });
    }));
    const Answer = ({ customerId }) => {
      const on = usePropertyReminderAnswer({ id: 'v', customerId, propertyId: 'p-home', reminder24hOn: false }, 'p-other', true);
      return <div data-testid="answer">{String(on)}</div>;
    };
    const view = render(<Answer customerId="cust-a" />);
    view.rerender(<Answer customerId="cust-b" />);
    await waitFor(() => expect(screen.getByTestId('answer').textContent).toBe('true'));
    releaseA();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.getByTestId('answer').textContent).toBe('true');
  });
});

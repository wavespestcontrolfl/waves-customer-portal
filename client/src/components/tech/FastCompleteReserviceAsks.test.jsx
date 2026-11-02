// @vitest-environment jsdom
// The "They told us" block and its hook on their own (the sheets' suites pin the wiring): the flag decides
// whether anything is read, a read that answers nothing usable draws nothing, the hold follows the answers, and
// the body field is only there once the block loaded items. Synthetic data only.
import React from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import FastCompleteReserviceAsks, { useReserviceAsks, withAsksHold } from './FastCompleteReserviceAsks';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const ITEM = { id: 'form:1', source: 'request_form', at: '2026-10-06T14:00:00.000Z', text: 'Ants again', quoted: true, lead: null, kind: 'problem', pests: ['Ants'] };
const ROWS = [{ productId: 'taurus', name: 'Taurus SC', active: true, product: {} }];

let latest = null;
function Harness({ enabled = true, request, rows = ROWS }) {
  const asks = useReserviceAsks({ service: { id: 'svc-1', reserviceAsksEnabled: enabled }, request, rows });
  latest = asks;
  return (
    <div>
      <FastCompleteReserviceAsks asks={asks} />
      <output data-testid="hold">{withAsksHold('', asks)}</output>
    </div>
  );
}

describe('useReserviceAsks', () => {
  test('flag off: nothing is read, drawn or sent', () => {
    const request = vi.fn();
    render(<Harness enabled={false} request={request} />);
    expect(request).not.toHaveBeenCalled();
    expect(screen.queryByText(/They told us/)).toBeNull();
    expect(latest.field()).toEqual({});
    expect(latest.hold).toBe('');
  });

  test('reads the asks from the visit\'s own path', async () => {
    const request = vi.fn(async () => ({ enabled: true, lane: 'pest', items: [ITEM] }));
    render(<Harness request={request} />);
    await screen.findByText('They told us · 1 item');
    expect(request).toHaveBeenCalledWith('/admin/dispatch/svc-1/reservice-asks');
  });

  test('while the read is out Complete waits, with words that say so', async () => {
    let release;
    const request = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    render(<Harness request={request} />);
    expect(screen.getByTestId('hold').textContent).toBe('Loading what the customer told us…');
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    release({ items: [] });
    await waitFor(() => expect(screen.getByTestId('hold').textContent).toBe(''));
    expect(screen.queryByText(/They told us/)).toBeNull();
  });

  test('the sheet\'s own reason wins over the block\'s', async () => {
    const request = vi.fn(async () => ({ items: [ITEM] }));
    render(<Harness request={request} />);
    await screen.findByText('They told us · 1 item');
    expect(withAsksHold('Select at least one product.', latest)).toBe('Select at least one product.');
    expect(withAsksHold('', latest)).toBe('Answer each item in They told us.');
  });

  test('the body field appears once every item is answered, and a removed product takes its pick with it', async () => {
    const request = vi.fn(async () => ({ items: [ITEM] }));
    const { rerender } = render(<Harness request={request} />);
    await screen.findByText('They told us · 1 item');
    const item = screen.getByRole('group', { name: 'Request form · Oct 6' });
    fireEvent.click(within(item).getByRole('button', { name: 'Treated' }));
    fireEvent.click(within(item).getByRole('button', { name: 'Taurus SC' }));
    expect(latest.hold).toBe('');
    expect(latest.field()).toEqual({ reserviceAnswers: { items: [{ itemId: 'form:1', answer: 'treated', productIds: ['taurus'] }] } });
    rerender(<Harness request={request} rows={[]} />);
    expect(latest.hold).toBe('Answer each item in They told us.');
    expect(latest.field()).toEqual({});
    rerender(<Harness request={request} rows={ROWS} />);
    expect(latest.hold).toBe('Answer each item in They told us.');
    expect(within(item).getByRole('button', { name: 'Taurus SC' }).getAttribute('aria-pressed')).toBe('false');
  });

  test('every chip is a real button with aria-pressed, and the inputs have labels', async () => {
    const question = { ...ITEM, id: 'text:2', kind: 'question', text: 'Is it ok?' };
    render(<Harness request={vi.fn(async () => ({ items: [ITEM, question] }))} />);
    await screen.findByText('They told us · 2 items');
    for (const button of screen.getAllByRole('button')) expect(button.getAttribute('aria-pressed')).not.toBeNull();
    expect(screen.getByLabelText('Your answer').tagName).toBe('INPUT');
    fireEvent.click(within(screen.getByRole('group', { name: 'Request form · Oct 6' })).getByRole('button', { name: 'Not today' }));
    expect(screen.getByLabelText('Why not today? (office only)').tagName).toBe('INPUT');
  });
});

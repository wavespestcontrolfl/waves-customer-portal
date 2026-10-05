// @vitest-environment jsdom
// The lawn photo / analyze / confirm step, shared by the full completion form
// and the lawn Fast Complete sheet. The full form's behavior is pinned by its
// own SchedulePage.lawn* tests; these pin what moving it added: it calls the
// fetcher it is given, and no text is set under 14px.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import LawnAssessmentCompletionBlock from './LawnAssessmentCompletionBlock';

afterEach(cleanup);

const mount = (props = {}) => {
  const request = vi.fn(async () => ({ shotListEnabled: true, assessment: null }));
  render(<LawnAssessmentCompletionBlock service={{ id: 'svc-1', customerId: 'cust-1' }} request={request} showGaugeReading {...props} />);
  return request;
};
const sizes = () => Array.from(document.querySelectorAll('[style]')).filter((el) => el.style.fontSize).map((el) => parseFloat(el.style.fontSize));

describe('LawnAssessmentCompletionBlock', () => {
  it('reads an existing assessment through the fetcher it is given', async () => {
    const request = mount();
    await screen.findByLabelText('Add turf photos');
    expect(request).toHaveBeenCalledWith('/admin/lawn-assessment/service/svc-1');
  });

  it('sets no text under 14px (portal brand rule), with or without the gauge reading', async () => {
    mount();
    await waitFor(() => expect(screen.queryByTestId('lawn-photo-mode-pending')).toBeNull());
    // The block is styled with classes now: no inline size under 14px, and none of
    // the small type-scale classes (text-11, text-12, text-13) anywhere in it.
    expect(sizes().every((size) => size >= 14)).toBe(true);
    const small = Array.from(document.querySelectorAll('[class]')).filter((el) => /(^|\s)text-(11|12|13)(\s|$)/.test(el.getAttribute('class')));
    expect(small).toEqual([]);
  });

  it('has no green anywhere: the buttons are the standard dark and light ones', async () => {
    mount();
    await screen.findByLabelText('Add turf photos');
    expect(document.body.innerHTML).not.toMatch(/green|emerald|#16A34A|#10B981/i);
    expect(screen.getByRole('button', { name: 'Analyze lawn' }).className).toContain('bg-zinc-900');
  });

  it('the full form keeps all eight shots, the 0/8 count and the minimum-photos guide; only the compact sheet trims them', async () => {
    mount();
    await screen.findByTestId('lawn-shot-list');
    expect(screen.getAllByRole('listitem').filter((li) => li.getAttribute('data-testid')?.startsWith('lawn-shot-'))).toHaveLength(8);
    expect(screen.getByText('0/8')).toBeTruthy();
    expect(screen.getByTestId('lawn-shot-list-hint').textContent).toMatch(/Aim for at least 4 photos/);
    cleanup();
    mount({ compact: true });
    await screen.findByTestId('lawn-shot-list');
    expect(screen.getAllByRole('listitem').filter((li) => li.getAttribute('data-testid')?.startsWith('lawn-shot-'))).toHaveLength(4);
    expect(screen.getByText('0 added')).toBeTruthy();
    expect(screen.queryByTestId('lawn-shot-list-hint')).toBeNull();
    // The lawn length box shows in the compact mode too, once the host asks for it.
    expect(screen.getByText('Lawn length')).toBeTruthy();
  });
});

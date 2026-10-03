// @vitest-environment jsdom
// The lawn photo / analyze / confirm step, shared by the full completion form
// and the lawn Fast Complete sheet. The full form's behavior is pinned by its
// own SchedulePage.lawn* tests; these pin what moving it added: it calls the
// fetcher it is given, and its text sizes are untouched unless a host sets a
// floor.
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

  it('keeps its original text sizes by default (the full form is unchanged)', async () => {
    mount();
    await waitFor(() => expect(screen.queryByTestId('lawn-photo-mode-pending')).toBeNull());
    expect(sizes()).toContain(12);
    expect(sizes()).toContain(13);
  });

  it('raises every size under the floor a host sets, and leaves larger ones alone', async () => {
    mount({ textFloor: 14 });
    await waitFor(() => expect(screen.queryByTestId('lawn-photo-mode-pending')).toBeNull());
    expect(Math.min(...sizes())).toBe(14);
  });
});

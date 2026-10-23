// @vitest-environment jsdom
// The lawn photo / analyze / confirm step, shared by the full completion form
// and the lawn Fast Complete sheet. The full form's behavior is pinned by its
// own SchedulePage.lawn* tests; these pin what moving it added: it calls the
// fetcher it is given, and no text is set under 14px.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('a confirmed assessment offers the report preview on admin hosts only, in a new tab', async () => {
    const confirmedLookup = async () => ({ shotListEnabled: true, assessment: { id: 'la-1', confirmed_by_tech: true, turf_density: 80, weed_suppression: 80, color_health: 80 } });
    render(<LawnAssessmentCompletionBlock service={{ id: 'svc-1', customerId: 'cust-1' }} request={vi.fn(confirmedLookup)} showReportPreview />);
    const link = await screen.findByRole('link', { name: 'Preview report' });
    expect(link.getAttribute('href')).toBe('/admin/report-preview/svc-1');
    expect(link.getAttribute('target')).toBe('_blank');
    cleanup();
    render(<LawnAssessmentCompletionBlock service={{ id: 'svc-1', customerId: 'cust-1' }} request={vi.fn(confirmedLookup)} />);
    await screen.findByText('Assessment confirmed');
    expect(screen.queryByRole('link', { name: 'Preview report' })).toBeNull();
  });

  it('the lawn sheet (compact) shows the last visit\'s four scores and overall score, read-only, from the same lookup', async () => {
    const request = vi.fn(async () => ({ assessment: null, lastVisit: { date: '2026-09-20', overall: 74, scores: { turf_density: 70, weed_suppression: null, color_health: 78, stress_damage: 72 } } }));
    mount({ compact: true, request });
    const card = await screen.findByLabelText('Last visit scores');
    expect(card.textContent).toContain('Sep 20, 2026');
    expect(screen.getByTestId('lawn-last-visit-overall').textContent).toBe('74/100');
    expect(screen.getByTestId('lawn-last-visit-weed_suppression').textContent).toBe('Weed control—');
    expect(card.querySelectorAll('input, button')).toHaveLength(0);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('shows no last-visit row when the lookup leaves it out (read failed)', async () => {
    mount();
    await screen.findByLabelText('Add turf photos');
    expect(screen.queryByLabelText('Last visit scores')).toBeNull();
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
    // On the lawn sheet it is a row at the end of the photo slot list.
    expect(screen.getByTestId('lawn-shot-list').lastElementChild.getAttribute('data-testid')).toBe('lawn-length-row');
  });

  it('its handle runs a step only when that step\'s own button could be pressed, and onProgress says which can', async () => {
    const ref = React.createRef();
    const onProgress = vi.fn();
    const request = mount({ ref, compact: true, onProgress });
    await waitFor(() => expect(screen.queryByTestId('lawn-photo-mode-pending')).toBeNull());
    // No photo: Analyze and Confirm are off, so the handle does nothing; Add a photo is on.
    await waitFor(() => expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ photos: 0, assessed: false, canAddPhoto: true, canAnalyze: false, canConfirm: false })));
    ref.current.analyze();
    ref.current.confirm();
    expect(request.mock.calls.map(([path]) => path)).toEqual(['/admin/lawn-assessment/service/svc-1']);
    // openPhotoPicker clicks the same hidden input as Add turf photos.
    const open = vi.spyOn(screen.getByLabelText('Add turf photos'), 'click');
    ref.current.openPhotoPicker();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('a photo still being read from the untagged picker holds Analyze until the read lands', async () => {
    // A FileReader that waits for the test to finish it: the read is in flight.
    const pending = [];
    class HeldFileReader { readAsDataURL() { pending.push(() => { this.result = 'data:image/jpeg;base64,cGhvdG8='; this.onload({ target: { result: this.result } }); }); } }
    class FixtureImage { set src(_v) { this.width = 800; this.height = 600; this.onload(); } }
    vi.stubGlobal('FileReader', HeldFileReader);
    vi.stubGlobal('Image', FixtureImage);
    const ref = React.createRef();
    const onProgress = vi.fn();
    const request = mount({ ref, compact: true, onProgress });
    await waitFor(() => expect(screen.queryByTestId('lawn-photo-mode-pending')).toBeNull());
    const input = screen.getByLabelText('Add turf photos');
    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(pending).toHaveLength(1));
    // In flight: Analyze is off for the handle and reported off.
    ref.current.analyze();
    expect(request.mock.calls.map(([path]) => path)).toEqual(['/admin/lawn-assessment/service/svc-1']);
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ canAnalyze: false }));
    await act(async () => { pending[0](); });
    await waitFor(() => expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ photos: 1, canAnalyze: true })));
    vi.unstubAllGlobals();
  });

  it('the customer-label chooser follows each lookup: a service whose lookup omits the flag does not keep it', async () => {
    class FixtureFileReader { readAsDataURL() { this.result = 'data:image/jpeg;base64,cGhvdG8='; this.onload({ target: { result: this.result } }); } }
    class FixtureImage { set src(_v) { this.width = 800; this.height = 600; this.onload(); } }
    vi.stubGlobal('FileReader', FixtureFileReader);
    vi.stubGlobal('Image', FixtureImage);
    const request = vi.fn(async (path) => (path.endsWith('/svc-1')
      ? { shotListEnabled: true, labelPickEnabled: true, assessment: null }
      : { shotListEnabled: true, assessment: null }));
    const block = (id) => <LawnAssessmentCompletionBlock service={{ id, customerId: 'cust-1' }} request={request} showGaugeReading />;
    const addSlotted = async () => {
      await waitFor(() => expect(screen.queryByTestId('lawn-photo-mode-pending')).toBeNull());
      fireEvent.change(screen.getByLabelText('Add turf photos'), { target: { files: [new File(['x'], 'a.jpg', { type: 'image/jpeg' })] } });
      fireEvent.change(await screen.findByLabelText('Slot for photo 1'), { target: { value: 'shade' } });
    };
    const { rerender } = render(block('svc-1'));
    await addSlotted();
    expect(await screen.findByLabelText('Shown to the customer as, photo 1')).toBeTruthy();
    rerender(block('svc-2'));
    await addSlotted();
    expect(screen.queryByLabelText(/Shown to the customer as/)).toBeNull();
    vi.unstubAllGlobals();
  });
});


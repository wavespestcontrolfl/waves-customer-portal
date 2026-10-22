// @vitest-environment jsdom
// GATE_REPORT_WEB_SLIDER, technician side: last visit's photo beside the shot row, and the faint
// overlay on today's photo. The lookup key is absent when the gate is off, and then nothing shows.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import LawnAssessmentCompletionBlock from './LawnAssessmentCompletionBlock';
import SameAngleGuide, { guideDayLabel } from './SameAngleGuide';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const GUIDE = { front: { url: 'https://signed.test/front.jpg', date: '2026-09-20' } };
const mount = (lookup) => {
  const request = vi.fn(async () => lookup);
  render(<LawnAssessmentCompletionBlock service={{ id: 'svc-1', customerId: 'cust-1' }} request={request} />);
  return request;
};

describe('same-angle guide in the lawn photo step', () => {
  it('shows last visit\'s front photo on the Front row only, with its date, when the lookup carries it', async () => {
    mount({ shotListEnabled: true, lastVisitShots: GUIDE, assessment: null });
    const guide = await screen.findByTestId('same-angle-guide');
    expect(guide.textContent).toContain('Last visit, Sep 20');
    expect(guide.closest('[data-testid="lawn-shot-front"]')).toBeTruthy();
    expect(screen.getAllByTestId('same-angle-guide')).toHaveLength(1);
    expect(screen.getByAltText('Front overview at the last visit, Sep 20').getAttribute('src')).toBe(GUIDE.front.url);
    // No photo added yet: nothing to lay it over.
    expect(screen.queryByRole('button', { name: 'Show on photo' })).toBeNull();
  });

  it('gate off (no key in the lookup): nothing extra renders', async () => {
    mount({ shotListEnabled: true, assessment: null });
    await screen.findByTestId('lawn-shot-list');
    expect(screen.queryByTestId('same-angle-guide')).toBeNull();
  });

  it('shot list off: the guide stays hidden even if a key arrives', async () => {
    mount({ lastVisitShots: GUIDE, assessment: null });
    await waitFor(() => expect(screen.queryByTestId('lawn-photo-mode-pending')).toBeNull());
    expect(screen.queryByTestId('same-angle-guide')).toBeNull();
  });

  it('once a front photo is added, "Show on photo" lays last visit\'s photo faintly over it, and "Hide on photo" removes it', async () => {
    class FixtureFileReader { readAsDataURL() { this.result = 'data:image/jpeg;base64,cGhvdG8='; this.onload({ target: { result: this.result } }); } }
    class FixtureImage { set src(_v) { this.width = 800; this.height = 600; this.onload(); } }
    vi.stubGlobal('FileReader', FixtureFileReader);
    vi.stubGlobal('Image', FixtureImage);
    mount({ shotListEnabled: true, lastVisitShots: GUIDE, assessment: null });
    await screen.findByTestId('same-angle-guide');
    await waitFor(() => expect(screen.queryByTestId('lawn-photo-mode-pending')).toBeNull());
    fireEvent.click(screen.getByLabelText('Add photo for Front overview'));
    fireEvent.change(screen.getByLabelText('Add turf photos'), { target: { files: [new File(['x'], 'a.jpg', { type: 'image/jpeg' })] } });
    const show = await screen.findByRole('button', { name: 'Show on photo' });
    expect(show.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByTestId('same-angle-overlay')).toBeNull();
    fireEvent.click(show);
    const overlay = await screen.findByTestId('same-angle-overlay');
    expect(overlay.getAttribute('src')).toBe(GUIDE.front.url);
    expect(overlay.className).toContain('pointer-events-none');
    fireEvent.click(screen.getByRole('button', { name: 'Hide on photo' }));
    expect(screen.queryByTestId('same-angle-overlay')).toBeNull();
  });
});

describe('SameAngleGuide', () => {
  it('renders nothing without a photo, and reads dates without a timezone shift', () => {
    const { container } = render(<SameAngleGuide shot={null} label="Front" />);
    expect(container.innerHTML).toBe('');
    expect(guideDayLabel('2026-10-01')).toBe('Oct 1');
    expect(guideDayLabel('nope')).toBe('');
  });
});

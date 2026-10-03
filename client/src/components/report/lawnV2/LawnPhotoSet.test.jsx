// @vitest-environment jsdom
// Lawn report photo set (lawn report rebuild P23, GATE_LAWN_REPORT_PHOTO_SET):
// a payload carrying `photoSet` shows every photo at once, in the order and with
// the labels the server sent, in place of the swipe strip. Without a photoSet the
// strip renders exactly as before. Synthetic URLs only.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import LawnReportV2Section from './LawnReportV2Section';
import { LawnPhotoStrip, PrintContext } from './LawnReportV2';

afterEach(cleanup);

const SET = [
  { url: 'https://example.test/front.jpg', shot: 'front', label: 'Front yard' },
  { url: 'https://example.test/back.jpg', shot: 'back', label: 'Back yard' },
  { url: 'https://example.test/close.jpg', shot: 'close_up', label: 'Close-up' },
  { url: 'https://example.test/trouble-a.jpg', shot: 'trouble', label: 'Trouble spot' },
  { url: 'https://example.test/trouble-b.jpg', shot: 'trouble', label: 'Trouble spot' },
];
const STRIP = [{ url: 'https://example.test/strip.jpg', label: 'Front yard' }, { url: 'https://example.test/strip2.jpg', label: 'Back yard' }];

describe('LawnPhotoStrip with a photo set', () => {
  it('shows every photo with its label, in the order sent, and no slider', () => {
    const { container } = render(<LawnPhotoStrip photos={STRIP} photoSet={SET} />);
    const imgs = [...container.querySelectorAll('img')];
    expect(imgs.map((img) => img.getAttribute('src'))).toEqual(SET.map((p) => p.url));
    expect(imgs.map((img) => img.getAttribute('alt'))).toEqual(SET.map((p) => p.label));
    expect([...container.querySelectorAll('figcaption')].map((el) => el.textContent)).toEqual(SET.map((p) => p.label));
    expect(container.querySelector('button')).toBeNull();
    expect(screen.getByText('Lawn photos')).toBeInTheDocument();
    // The old strip's photos are not shown beside the set.
    expect(container.querySelector('img[src="https://example.test/strip.jpg"]')).toBeNull();
  });

  it('opens a photo full size in a new tab on the web, with no link in print', () => {
    const web = render(<LawnPhotoStrip photoSet={SET} />);
    const link = web.container.querySelector('a');
    expect(link).toHaveAttribute('href', SET[0].url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    cleanup();
    const printed = render(<PrintContext.Provider value><LawnPhotoStrip photoSet={SET} /></PrintContext.Provider>);
    expect(printed.container.querySelector('a')).toBeNull();
    expect(printed.container.querySelectorAll('img')).toHaveLength(SET.length);
  });

  it('keeps the technician notes beside the set', () => {
    render(<LawnPhotoStrip photoSet={SET} summary="A few thin tan patches." lead />);
    expect(screen.getByText('Technician notes')).toBeInTheDocument();
    expect(screen.getByText('A few thin tan patches.')).toBeInTheDocument();
  });

  it('captions are at least 14px', () => {
    const { container } = render(<LawnPhotoStrip photoSet={SET} />);
    for (const caption of container.querySelectorAll('figcaption')) expect(parseFloat(caption.style.fontSize)).toBeGreaterThanOrEqual(14);
  });

  it('ignores a photo with no link and falls back to the strip when the set is empty or missing', () => {
    const { container, unmount } = render(<LawnPhotoStrip photos={STRIP} photoSet={[{ url: '', label: 'Front yard' }]} />);
    expect(container.querySelector('[data-testid="lawn-photo-set"]')).toBeNull();
    expect(container.querySelector('img[src="https://example.test/strip.jpg"]')).not.toBeNull();
    unmount();
    const none = render(<LawnPhotoStrip photos={STRIP} />);
    expect(none.container.querySelector('[data-testid="lawn-photo-set"]')).toBeNull();
    expect(none.container.querySelectorAll('img')).toHaveLength(2);
  });
});

describe('LawnReportV2Section passes the set through', () => {
  const base = { photos: STRIP, insights: [], diagnosis: [] };

  it('legacy layout: the set replaces the strip', () => {
    const { container } = render(<LawnReportV2Section data={{ ...base, photoSet: SET }} />);
    expect(container.querySelector('[data-testid="lawn-photo-set"]')).not.toBeNull();
    expect(container.querySelectorAll('img')).toHaveLength(SET.length);
  });

  it('lead layout: the set replaces the strip', () => {
    const lead = { headline: 'Stable', why: null, applied: null, yourPart: [], next: null };
    const { container } = render(<LawnReportV2Section data={{ ...base, lead, photoSet: SET }} />);
    expect(container.querySelector('[data-testid="lawn-photo-set"]')).not.toBeNull();
  });

  it('no photoSet: the strip renders as it always did', () => {
    const { container } = render(<LawnReportV2Section data={base} />);
    expect(container.querySelector('[data-testid="lawn-photo-set"]')).toBeNull();
    expect(container.querySelectorAll('img')).toHaveLength(STRIP.length);
  });
});

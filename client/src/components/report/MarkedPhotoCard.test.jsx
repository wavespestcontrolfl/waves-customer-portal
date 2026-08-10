// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import MarkedPhotoCard from './MarkedPhotoCard';

afterEach(() => cleanup());

const MARKED = {
  photoId: 'mp1',
  url: 'https://cdn.example.com/wall.jpg',
  caption: 'Exterior wall base',
  captionKey: 'foamPoints',
  legend: [{ kind: 'foam_injection', label: 'Drilled & foamed' }],
  marks: [
    { n: 1, x: 0.02, y: 0.02, kind: 'foam_injection', label: 'Drilled & foamed' },
    { n: 2, x: 0.5, y: 0.5, kind: 'foam_injection', label: 'Drilled & foamed' },
    { n: 3, x: 0.98, y: 0.9, kind: 'wood_treatment', label: 'Wood treated' },
  ],
};

describe('MarkedPhotoCard', () => {
  it('fails closed when the photo cannot load', () => {
    // Pins and a "Where we treated" claim over a broken-image frame is a
    // worse statement than no card at all — the PDF path does the same.
    const { container } = render(<MarkedPhotoCard marked={MARKED} live={false} />);
    expect(container.textContent).toMatch(/Where we treated/);
    fireEvent.error(container.querySelector('img[src="https://cdn.example.com/wall.jpg"]'));
    expect(container.textContent).not.toMatch(/Where we treated/);
  });

  it('renders no card at all when the visit carries no marks', () => {
    const { container } = render(
      <MarkedPhotoCard marked={{ ...MARKED, marks: [] }} live={false} />,
    );
    expect(container.textContent).toBe('');
  });

  it('keeps edge badges inside the frame', () => {
    const { container } = render(<MarkedPhotoCard marked={MARKED} live={false} />);
    const badge = (n) => [...container.querySelectorAll('span')].find((el) => el.textContent === n);
    // Top-edge mark: the badge flips BELOW its point rather than clipping.
    expect(badge('1').style.top).toBe('13px');
    expect(badge('1').style.bottom).toBe('');
    // Left-edge mark shifts inward; a centred mark keeps the normal offset.
    expect(badge('1').style.transform).toBe('translateX(-10%)');
    expect(badge('2').style.transform).toBe('translateX(-50%)');
    // Right-edge mark shifts the other way.
    expect(badge('3').style.transform).toBe('translateX(-90%)');
  });

  it('drops the foam claim when a non-foam kind is present', () => {
    const { container } = render(<MarkedPhotoCard marked={MARKED} live={false} />);
    expect(container.textContent).not.toMatch(/Foam was injected/);
    expect(container.textContent).toMatch(/marked the points treated/);
  });
});

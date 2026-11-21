// @vitest-environment jsdom
// The roof points card on the customer estimate (owner ruling 2026-11-20, choice 4A): numbered pins on the county roof photo,
// the same numbers in the list under it, the count wording (1 vs N), the photo year, and the fallback when the photo fails.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RoofPointsCard from './RoofPointsCard';

afterEach(cleanup);

const pin = (n, over = {}) => ({ n, x: 0.2 * n, y: 0.1 * n, type: 'roof_returns_and_valleys', label: `Point ${n}`, action: 'seal', ...over });
const points = (pins, over = {}) => ({ imageUrl: 'https://example.test/aerial.jpg', imageYear: 2025, pins, ...over });

describe('RoofPointsCard', () => {
  it('prints the plural lead, the note, the ordered list and the photo credit', () => {
    render(<RoofPointsCard points={points([
      pin(1, { label: 'Roof return, front left', action: 'seal' }),
      pin(2, { label: 'Branch touching the roof', action: 'trim back' }),
      pin(3, { type: 'plumbing_vent_stacks', label: 'Vent pipe', action: 'seal around' }),
    ])} address="12 Synthetic Way" />);
    expect(screen.getByText('Your Waves technician found 3 places where rodents can get into your roof.')).toBeInTheDocument();
    expect(screen.getByText('The numbers match the list below.')).toBeInTheDocument();
    const items = screen.getByTestId('roof-points-list').querySelectorAll('li');
    expect([...items].map((li) => li.textContent)).toEqual([
      'Roof return, front left: seal',
      'Branch touching the roof: trim back',
      'Vent pipe: seal around',
    ]);
    expect(screen.getByText('Photo: county aerial, 2025.')).toBeInTheDocument();
    expect(screen.getByAltText('Aerial photo of the roof at 12 Synthetic Way, with 3 numbered places where rodents can get in')).toHaveAttribute('src', 'https://example.test/aerial.jpg');
  });

  it('uses the singular for one point', () => {
    render(<RoofPointsCard points={points([pin(1)])} />);
    expect(screen.getByText('Your Waves technician found 1 place where rodents can get into your roof.')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('1 places');
    expect(screen.getByAltText(/with 1 numbered place where rodents can get in$/)).toBeInTheDocument();
  });

  it('draws one numbered pin per point at its x and y fractions, matching the list numbers', () => {
    render(<RoofPointsCard points={points([pin(1, { x: 0.25, y: 0.4 }), pin(2, { x: 0.7, y: 0.55 })])} />);
    const pins = screen.getAllByTestId('roof-point-pin');
    expect(pins.map((p) => p.textContent)).toEqual(['1', '2']);
    expect(pins[0].style.left).toBe('25%');
    expect(pins[0].style.top).toBe('40%');
    expect(pins[1].style.left).toBe('70%');
    expect(pins[1].style.top).toBe('55%');
  });

  it('keeps a pin inside the photo when a stored fraction is out of range', () => {
    render(<RoofPointsCard points={points([pin(1, { x: 1.4, y: -0.2 })])} />);
    const [p] = screen.getAllByTestId('roof-point-pin');
    expect(p.style.left).toBe('100%');
    expect(p.style.top).toBe('0%');
  });

  it('lists points in number order even when they arrive out of order', () => {
    render(<RoofPointsCard points={points([pin(2, { label: 'Second' }), pin(1, { label: 'First' })])} />);
    expect([...screen.getByTestId('roof-points-list').querySelectorAll('li')].map((li) => li.textContent)).toEqual(['First: seal', 'Second: seal']);
  });

  it('calls onImageError when the photo fails to load', () => {
    const onImageError = vi.fn();
    render(<RoofPointsCard points={points([pin(1)])} onImageError={onImageError} />);
    act(() => { fireEvent.error(screen.getByRole('img')); });
    expect(onImageError).toHaveBeenCalledTimes(1);
  });

  it('prints no AI wording, no photo credit without a year, and nothing with no photo or no points', () => {
    const { container, rerender } = render(<RoofPointsCard points={points([pin(1)], { imageYear: null })} />);
    expect(container.textContent).not.toMatch(/\bAI\b/);
    expect(container.textContent).not.toContain('Photo: county aerial');
    rerender(<RoofPointsCard points={points([])} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<RoofPointsCard points={points([pin(1)], { imageUrl: '' })} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<RoofPointsCard points={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

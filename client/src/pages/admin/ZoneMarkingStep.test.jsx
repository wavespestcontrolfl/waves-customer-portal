// @vitest-environment jsdom
// Zone-marking capture step (satellite coverage PR 2). Pointer math runs
// against the svg's bounding rect, which jsdom reports as all-zeros — the
// tests stub getBoundingClientRect so normalized coordinates are real.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZoneMarkingStep } from './SchedulePage';

const MAP = {
  available: true,
  image: {
    url: 'https://maps.example/static.png',
    width: 640,
    height: 340,
    center: { lat: 27.36, lng: -82.38 },
    zoom: 20,
    attributionText: 'Map data (c) Google',
  },
  zones: [],
};

// jsdom's PointerEvent constructor drops clientX/clientY, so pointer
// gestures dispatch as MouseEvents under the pointer event names (React's
// synthetic system routes by event name, and MouseEvent carries coords).
function firePointer(el, type, clientX, clientY) {
  fireEvent(el, new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY }));
}

function stubSvgRect(container) {
  const svg = container.querySelector('svg');
  svg.getBoundingClientRect = () => ({
    left: 0, top: 0, width: 640, height: 340, right: 640, bottom: 340, x: 0, y: 0,
  });
  return svg;
}

afterEach(cleanup);

describe('ZoneMarkingStep', () => {
  it('renders nothing without an available map or areas', () => {
    const { container: c1 } = render(
      <ZoneMarkingStep map={{ available: false }} areas={['Perimeter']} marks={{}} onSetMark={() => {}} onClearMark={() => {}} />,
    );
    expect(c1.firstChild).toBeNull();
    const { container: c2 } = render(
      <ZoneMarkingStep map={MAP} areas={[]} marks={{}} onSetMark={() => {}} onClearMark={() => {}} />,
    );
    expect(c2.firstChild).toBeNull();
  });

  it('shows the areas, progress count, and required Google attribution', () => {
    render(
      <ZoneMarkingStep map={MAP} areas={['Perimeter', 'Yard']} marks={{ Perimeter: { type: 'circle', cx: 0.5, cy: 0.5, r: 0.07 } }} onSetMark={() => {}} onClearMark={() => {}} />,
    );
    expect(screen.getByText('1. Perimeter')).toBeInTheDocument();
    expect(screen.getByText('2. Yard')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 marked')).toBeInTheDocument();
    expect(screen.getByText('Map data (c) Google')).toBeInTheDocument();
  });

  it('tap places a normalized circle for the active area', () => {
    const onSetMark = vi.fn();
    const { container } = render(
      <ZoneMarkingStep map={MAP} areas={['Perimeter', 'Yard']} marks={{}} onSetMark={onSetMark} onClearMark={() => {}} />,
    );
    const svg = stubSvgRect(container);
    firePointer(svg, 'pointerup', 320, 170);
    expect(onSetMark).toHaveBeenCalledWith('Perimeter', { type: 'circle', cx: 0.5, cy: 0.5, r: 0.07 });
  });

  it('box tool drag commits a normalized rect; tiny drags are ignored', () => {
    const onSetMark = vi.fn();
    const { container } = render(
      <ZoneMarkingStep map={MAP} areas={['Perimeter']} marks={{}} onSetMark={onSetMark} onClearMark={() => {}} />,
    );
    fireEvent.click(screen.getByText('Box'));
    const svg = stubSvgRect(container);

    firePointer(svg, 'pointerdown', 64, 34);
    firePointer(svg, 'pointermove', 320, 170);
    firePointer(svg, 'pointerup', 320, 170);
    expect(onSetMark).toHaveBeenCalledWith('Perimeter', { type: 'rect', x: 0.1, y: 0.1, w: 0.4, h: 0.4 });

    onSetMark.mockClear();
    firePointer(svg, 'pointerdown', 100, 100);
    firePointer(svg, 'pointerup', 102, 101);
    expect(onSetMark).not.toHaveBeenCalled();
  });

  it('fast drag with no pointermove still commits the full rect (release point wins)', () => {
    const onSetMark = vi.fn();
    const { container } = render(
      <ZoneMarkingStep map={MAP} areas={['Perimeter']} marks={{}} onSetMark={onSetMark} onClearMark={() => {}} />,
    );
    fireEvent.click(screen.getByText('Box'));
    const svg = stubSvgRect(container);

    // pointer streams may deliver zero move events before release — the box
    // must close at the pointerup coordinates, not the stale draft corner
    firePointer(svg, 'pointerdown', 64, 34);
    firePointer(svg, 'pointerup', 320, 170);
    expect(onSetMark).toHaveBeenCalledWith('Perimeter', { type: 'rect', x: 0.1, y: 0.1, w: 0.4, h: 0.4 });
  });

  it('warns while partially marked (partial posts are discarded at submit)', () => {
    render(
      <ZoneMarkingStep map={MAP} areas={['Perimeter', 'Yard']} marks={{ Perimeter: { type: 'circle', cx: 0.5, cy: 0.5, r: 0.07 } }} onSetMark={() => {}} onClearMark={() => {}} />,
    );
    expect(screen.getByText(/Marks only save when every area is marked/)).toBeInTheDocument();
  });

  it('remove clears the active area mark; resize nudges the circle radius', () => {
    const onSetMark = vi.fn();
    const onClearMark = vi.fn();
    render(
      <ZoneMarkingStep
        map={MAP}
        areas={['Perimeter']}
        marks={{ Perimeter: { type: 'circle', cx: 0.4, cy: 0.4, r: 0.07 } }}
        onSetMark={onSetMark}
        onClearMark={onClearMark}
      />,
    );
    fireEvent.click(screen.getByText('+'));
    expect(onSetMark).toHaveBeenCalledWith('Perimeter', { type: 'circle', cx: 0.4, cy: 0.4, r: 0.085 });
    fireEvent.click(screen.getByText('Remove mark'));
    expect(onClearMark).toHaveBeenCalledWith('Perimeter');
  });

  it('ignores input while disabled', () => {
    const onSetMark = vi.fn();
    const { container } = render(
      <ZoneMarkingStep map={MAP} areas={['Perimeter']} marks={{}} onSetMark={onSetMark} onClearMark={() => {}} disabled />,
    );
    const svg = stubSvgRect(container);
    firePointer(svg, 'pointerup', 320, 170);
    expect(onSetMark).not.toHaveBeenCalled();
  });

  it('disabled freezes Remove and resize too, not just the pointer handlers', () => {
    // an edit landing mid-submit is not in the already-sent payload — it
    // would silently vanish behind a successful save
    const onSetMark = vi.fn();
    const onClearMark = vi.fn();
    render(
      <ZoneMarkingStep
        map={MAP}
        areas={['Perimeter']}
        marks={{ Perimeter: { type: 'circle', cx: 0.4, cy: 0.4, r: 0.07 } }}
        onSetMark={onSetMark}
        onClearMark={onClearMark}
        disabled
      />,
    );
    fireEvent.click(screen.getByText('+'));
    fireEvent.click(screen.getByText('-'));
    fireEvent.click(screen.getByText('Remove mark'));
    expect(onSetMark).not.toHaveBeenCalled();
    expect(onClearMark).not.toHaveBeenCalled();
  });
});

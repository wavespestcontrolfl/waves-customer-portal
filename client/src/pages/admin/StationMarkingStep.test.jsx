// @vitest-environment jsdom
// Bait station marking step (station-map-v1). Pointer math runs against the
// svg's bounding rect, which jsdom reports as all-zeros — the tests stub
// getBoundingClientRect so normalized coordinates are real (same approach as
// ZoneMarkingStep.test.jsx).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StationMarkingStep } from './SchedulePage';

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
  stations: [],
};

const station = (key, number, cx, cy, extra = {}) => ({
  key,
  id: key.startsWith('new-') ? null : key,
  number,
  label: null,
  shape: { type: 'circle', cx, cy, r: 0.035 },
  stale: false,
  ...extra,
});

// jsdom's PointerEvent constructor drops clientX/clientY, so pointer
// gestures dispatch as MouseEvents under the pointer event names.
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

const noop = () => {};
const baseProps = {
  map: MAP,
  statuses: {},
  onAddStation: noop,
  onMoveStation: noop,
  onSetStatus: noop,
  onRemoveStation: noop,
};

afterEach(cleanup);

describe('StationMarkingStep', () => {
  it('renders nothing without an available map', () => {
    const { container } = render(
      <StationMarkingStep {...baseProps} map={{ available: false }} stations={[station('st-1', 1, 0.5, 0.5)]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows the pin count, activity count, and required Google attribution', () => {
    render(
      <StationMarkingStep
        {...baseProps}
        stations={[station('st-1', 1, 0.25, 0.5), station('st-2', 2, 0.75, 0.5)]}
        statuses={{ 'st-2': 'activity' }}
      />,
    );
    expect(screen.getByText('2 pinned · 1 with activity')).toBeInTheDocument();
    expect(screen.getByText('Map data (c) Google')).toBeInTheDocument();
  });

  it('add mode drops a pin per tap with normalized coordinates and stays armed', () => {
    const onAddStation = vi.fn();
    const { container } = render(
      <StationMarkingStep {...baseProps} stations={[]} onAddStation={onAddStation} />,
    );
    const svg = stubSvgRect(container);
    fireEvent.click(screen.getByText('Add stations'));
    firePointer(svg, 'pointerup', 320, 170);
    firePointer(svg, 'pointerup', 160, 85);
    expect(onAddStation).toHaveBeenNthCalledWith(1, { cx: 0.5, cy: 0.5 });
    expect(onAddStation).toHaveBeenNthCalledWith(2, { cx: 0.25, cy: 0.25 });
    expect(screen.getByText('Done adding')).toBeInTheDocument();
  });

  it('add mode ignores taps on existing pins (no stacked duplicates) and stops at the station cap', () => {
    const onAddStation = vi.fn();
    const { container } = render(
      <StationMarkingStep
        {...baseProps}
        stations={[station('st-1', 1, 0.25, 0.5), station('st-2', 2, 0.75, 0.5)]}
        onAddStation={onAddStation}
        maxStations={2}
      />,
    );
    stubSvgRect(container);
    // at the cap the add-mode entry point is disabled outright
    const capButton = screen.getByRole('button', { name: 'Station cap (2)' });
    expect(capButton).toBeDisabled();

    const { container: c2 } = render(
      <StationMarkingStep
        {...baseProps}
        stations={[station('st-1', 1, 0.25, 0.5)]}
        onAddStation={onAddStation}
        maxStations={2}
      />,
    );
    const svg2 = stubSvgRect(c2);
    fireEvent.click([...c2.querySelectorAll('button')].find((b) => b.textContent === 'Add stations'));
    firePointer(svg2, 'pointerup', 160, 170); // dead on station 1 — ignored
    expect(onAddStation).not.toHaveBeenCalled();
    firePointer(svg2, 'pointerup', 480, 170); // empty ground — adds
    expect(onAddStation).toHaveBeenCalledWith({ cx: 0.75, cy: 0.5 });
  });

  it('tapping a pin selects it and status chips report the tapped status', () => {
    const onSetStatus = vi.fn();
    const { container } = render(
      <StationMarkingStep
        {...baseProps}
        stations={[station('st-1', 1, 0.25, 0.5)]}
        onSetStatus={onSetStatus}
      />,
    );
    const svg = stubSvgRect(container);
    firePointer(svg, 'pointerup', 160, 170); // station 1 sits at (0.25, 0.5)
    expect(screen.getByText('Station 1:')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    expect(onSetStatus).toHaveBeenCalledWith('st-1', 'activity');
  });

  it('a tap away from every pin deselects instead of selecting the nearest', () => {
    const { container } = render(
      <StationMarkingStep {...baseProps} stations={[station('st-1', 1, 0.25, 0.5)]} />,
    );
    const svg = stubSvgRect(container);
    firePointer(svg, 'pointerup', 160, 170);
    expect(screen.getByText('Station 1:')).toBeInTheDocument();
    firePointer(svg, 'pointerup', 600, 40); // far corner
    expect(screen.queryByText('Station 1:')).not.toBeInTheDocument();
  });

  it('existing stations offer Retire, new pins offer Remove', () => {
    const onRemoveStation = vi.fn();
    const { container } = render(
      <StationMarkingStep
        {...baseProps}
        stations={[station('st-1', 1, 0.25, 0.5), station('new-1', 2, 0.75, 0.5)]}
        onRemoveStation={onRemoveStation}
      />,
    );
    const svg = stubSvgRect(container);
    firePointer(svg, 'pointerup', 160, 170);
    expect(screen.getByRole('button', { name: 'Retire station' })).toBeInTheDocument();
    firePointer(svg, 'pointerup', 480, 170);
    fireEvent.click(screen.getByRole('button', { name: 'Remove pin' }));
    expect(onRemoveStation).toHaveBeenCalledWith('new-1');
  });

  it('Move pin arms a re-position and the next map tap moves the SELECTED station', () => {
    const onMoveStation = vi.fn();
    const { container } = render(
      <StationMarkingStep
        {...baseProps}
        stations={[station('st-1', 1, 0.25, 0.5)]}
        onMoveStation={onMoveStation}
      />,
    );
    const svg = stubSvgRect(container);
    firePointer(svg, 'pointerup', 160, 170);
    fireEvent.click(screen.getByRole('button', { name: 'Move pin' }));
    firePointer(svg, 'pointerup', 480, 85);
    expect(onMoveStation).toHaveBeenCalledWith('st-1', { cx: 0.75, cy: 0.25 });
  });

  it('an armed move ignores taps on OTHER pins (server would skip them as position-occupied)', () => {
    const onMoveStation = vi.fn();
    const { container } = render(
      <StationMarkingStep
        {...baseProps}
        stations={[station('st-1', 1, 0.25, 0.5), station('st-2', 2, 0.75, 0.5)]}
        onMoveStation={onMoveStation}
      />,
    );
    const svg = stubSvgRect(container);
    firePointer(svg, 'pointerup', 160, 170); // select station 1
    fireEvent.click(screen.getByRole('button', { name: 'Move pin' }));
    firePointer(svg, 'pointerup', 480, 170); // dead on station 2 — ignored, stays armed
    expect(onMoveStation).not.toHaveBeenCalled();
    firePointer(svg, 'pointerup', 480, 85); // empty ground — moves
    expect(onMoveStation).toHaveBeenCalledWith('st-1', { cx: 0.75, cy: 0.25 });
  });

  it('the add-mode cap counts stale (drift-hidden) stations — they hold registry slots', () => {
    render(
      <StationMarkingStep
        {...baseProps}
        stations={[
          station('st-1', 1, 0.25, 0.5),
          { key: 'st-2', id: 'st-2', number: 2, label: null, shape: null, stale: true },
        ]}
        maxStations={2}
      />,
    );
    expect(screen.getByRole('button', { name: 'Station cap (2)' })).toBeDisabled();
  });

  it('stale stations surface a re-pin affordance that places by tap', () => {
    const onMoveStation = vi.fn();
    const { container } = render(
      <StationMarkingStep
        {...baseProps}
        stations={[
          station('st-1', 1, 0.25, 0.5),
          { key: 'st-2', id: 'st-2', number: 2, label: null, shape: null, stale: true },
        ]}
        onMoveStation={onMoveStation}
      />,
    );
    const svg = stubSvgRect(container);
    fireEvent.click(screen.getByRole('button', { name: 'Place #2' }));
    firePointer(svg, 'pointerup', 320, 170);
    expect(onMoveStation).toHaveBeenCalledWith('st-2', { cx: 0.5, cy: 0.5 });
  });

  it('office mode (showStatuses=false) hides status chips and the legend but keeps Move/Retire', () => {
    const { container } = render(
      <StationMarkingStep
        {...baseProps}
        stations={[station('st-1', 1, 0.25, 0.5)]}
        showStatuses={false}
      />,
    );
    const svg = stubSvgRect(container);
    firePointer(svg, 'pointerup', 160, 170);
    expect(screen.getByText('Station 1:')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Activity' })).not.toBeInTheDocument();
    expect(screen.queryByText('No access')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move pin' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retire station' })).toBeInTheDocument();
  });

  it('disabled freezes adds, selection taps, and every mutating control', () => {
    const onAddStation = vi.fn();
    const onSetStatus = vi.fn();
    const { container } = render(
      <StationMarkingStep
        {...baseProps}
        stations={[station('st-1', 1, 0.25, 0.5)]}
        onAddStation={onAddStation}
        onSetStatus={onSetStatus}
        disabled
      />,
    );
    const svg = stubSvgRect(container);
    firePointer(svg, 'pointerup', 160, 170);
    expect(screen.queryByText('Station 1:')).not.toBeInTheDocument();
    expect(onAddStation).not.toHaveBeenCalled();
    expect(onSetStatus).not.toHaveBeenCalled();
  });
});

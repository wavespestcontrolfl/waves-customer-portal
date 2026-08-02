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

  it('rodent program swaps the copy: title, consumption chip/counter — mechanics unchanged', () => {
    const onSetStatus = vi.fn();
    const { container } = render(
      <StationMarkingStep
        {...baseProps}
        stations={[station('st-1', 1, 0.25, 0.5), station('st-2', 2, 0.75, 0.5)]}
        statuses={{ 'st-2': 'activity' }}
        onSetStatus={onSetStatus}
        program="rodent"
      />,
    );
    expect(screen.getByText('Rodent bait station map')).toBeInTheDocument();
    expect(screen.getByText('2 pinned · 1 with consumption')).toBeInTheDocument();
    const svg = stubSvgRect(container);
    firePointer(svg, 'pointerup', 160, 170); // select station 1
    fireEvent.click(screen.getByRole('button', { name: 'Consumption' }));
    // the wire status value stays 'activity' — labels differ, the enum doesn't
    expect(onSetStatus).toHaveBeenCalledWith('st-1', 'activity');
    expect(screen.queryByRole('button', { name: 'Activity' })).not.toBeInTheDocument();
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

  // Owner 2026-08-02: "when I mark rodent traps I can't zoom in and zoom out
  // like I can with trace where we sprayed." The zoom is a pure viewBox
  // window over the SAME basemap — stored normalized coordinates never move.
  describe('zoom + pan', () => {
    it('opens at the full frame with zoom-out already spent', () => {
      const { container } = render(<StationMarkingStep {...baseProps} stations={[]} />);
      expect(container.querySelector('svg')).toHaveAttribute('viewBox', '0 0 640 340');
      expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Zoom in' })).toBeEnabled();
      expect(screen.queryByText(/drag to pan/)).not.toBeInTheDocument();
    });

    it('steps 1x - 2x - 4x about the centre and stops at the imagery limit', () => {
      const { container } = render(<StationMarkingStep {...baseProps} stations={[]} />);
      const svg = container.querySelector('svg');
      const zoomIn = screen.getByRole('button', { name: 'Zoom in' });

      fireEvent.click(zoomIn);
      expect(svg).toHaveAttribute('viewBox', '160 85 320 170');
      expect(screen.getByText('2× · drag to pan')).toBeInTheDocument();

      fireEvent.click(zoomIn);
      expect(svg).toHaveAttribute('viewBox', '240 127.5 160 85');
      expect(zoomIn).toBeDisabled();

      fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
      expect(svg).toHaveAttribute('viewBox', '160 85 320 170');
    });

    it('a zoomed tap maps through the window to the right normalized point', () => {
      const onAddStation = vi.fn();
      const { container } = render(
        <StationMarkingStep {...baseProps} stations={[]} onAddStation={onAddStation} />,
      );
      const svg = stubSvgRect(container);
      fireEvent.click(screen.getByRole('button', { name: 'Zoom in' })); // view 160 85 320 170
      fireEvent.click(screen.getByText('Add stations'));
      // Same client point that reads 0.25/0.25 at full view.
      firePointer(svg, 'pointerup', 160, 85);
      expect(onAddStation).toHaveBeenCalledWith({ cx: 0.375, cy: 0.375 });
    });

    it('dragging pans the map instead of dropping a pin', () => {
      const onAddStation = vi.fn();
      const { container } = render(
        <StationMarkingStep {...baseProps} stations={[]} onAddStation={onAddStation} />,
      );
      const svg = stubSvgRect(container);
      fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
      fireEvent.click(screen.getByText('Add stations'));

      firePointer(svg, 'pointerdown', 320, 170);
      firePointer(svg, 'pointermove', 420, 170);
      firePointer(svg, 'pointerup', 420, 170);

      expect(svg).toHaveAttribute('viewBox', '110 85 320 170');
      expect(onAddStation).not.toHaveBeenCalled();
    });

    it('a thumb-shake under the slop still counts as a tap', () => {
      const onAddStation = vi.fn();
      const { container } = render(
        <StationMarkingStep {...baseProps} stations={[]} onAddStation={onAddStation} />,
      );
      const svg = stubSvgRect(container);
      fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
      fireEvent.click(screen.getByText('Add stations'));

      firePointer(svg, 'pointerdown', 320, 170);
      firePointer(svg, 'pointermove', 324, 170); // 4 client px — under the slop
      firePointer(svg, 'pointerup', 324, 170);

      expect(svg).toHaveAttribute('viewBox', '160 85 320 170');
      expect(onAddStation).toHaveBeenCalledTimes(1);
    });

    // codex P2 on #3159: measuring the slop in FRAME units made it scale
    // with the rendered width, so on a real phone (~340px for a 640-unit
    // frame) the advertised 6px was ~3.2px and an ordinary shake swallowed
    // the tap. Every earlier zoom test stubs a 640px rect, where the two
    // units coincide — which is exactly why this one does not.
    it('the slop is real client pixels, even on a phone-width frame', () => {
      const onAddStation = vi.fn();
      const { container } = render(
        <StationMarkingStep {...baseProps} stations={[]} onAddStation={onAddStation} />,
      );
      const svg = container.querySelector('svg');
      // 390px viewport: the card renders the frame at ~340 CSS px.
      svg.getBoundingClientRect = () => ({
        left: 0, top: 0, width: 340, height: 181, right: 340, bottom: 181, x: 0, y: 0,
      });
      fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
      fireEvent.click(screen.getByText('Add stations'));

      firePointer(svg, 'pointerdown', 170, 90);
      firePointer(svg, 'pointermove', 174, 90); // 4 real px of thumb shake
      firePointer(svg, 'pointerup', 174, 90);

      expect(svg).toHaveAttribute('viewBox', '160 85 320 170'); // did not pan
      expect(onAddStation).toHaveBeenCalledTimes(1); // the tap survived
    });

    it('zooming frees ground the pin used to swallow — the tap radius is fixed in SCREEN px', () => {
      // One real spot on the property: 16 frame units right of the pin at
      // (0.5, 0.5). That is what zooming is FOR — a trap 16 units from
      // another one is unplaceable while the pin's 22-unit tap radius covers
      // it, and placeable once the frame is magnified.
      const onAddStation = vi.fn();
      const { container } = render(
        <StationMarkingStep
          {...baseProps}
          stations={[station('st-1', 1, 0.5, 0.5)]}
          onAddStation={onAddStation}
        />,
      );
      const svg = stubSvgRect(container);
      // Full view: 336 client px puts the tap 16 units out — inside the pin.
      firePointer(svg, 'pointerup', 336, 170);
      expect(screen.getByText('Station 1:')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
      fireEvent.click(screen.getByText('Add stations'));
      // 2×: the same 16 units now sits 32 client px out, clear of the pin.
      firePointer(svg, 'pointerup', 352, 170);
      expect(onAddStation).toHaveBeenCalledWith({ cx: 0.525, cy: 0.5 });
    });

    it('at full view a drag is still a tap — the original one-tap flow is untouched', () => {
      const onAddStation = vi.fn();
      const { container } = render(
        <StationMarkingStep {...baseProps} stations={[]} onAddStation={onAddStation} />,
      );
      const svg = stubSvgRect(container);
      fireEvent.click(screen.getByText('Add stations'));
      firePointer(svg, 'pointerdown', 160, 85);
      firePointer(svg, 'pointermove', 320, 170);
      firePointer(svg, 'pointerup', 320, 170);
      expect(svg).toHaveAttribute('viewBox', '0 0 640 340');
      expect(onAddStation).toHaveBeenCalledWith({ cx: 0.5, cy: 0.5 });
    });
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

// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StationMapCard, eligibleTrapIndices } from './StationMapCard';

// Trap-pin mode (GATE_RODENT_REPORT_REFRESH): trapping pins render as snap
// traps — wooden base, kill bar, number badge — with the caught-rat
// silhouette ONLY on capture stations. Every other program/surface keeps the
// ratified numbered-circle pins byte-for-byte (My Plan embed included, which
// never opts in).

const STATION_MAP = {
  available: true,
  program: 'trapping',
  image: { url: 'https://example.test/map.png', width: 640, height: 340 },
  attributionText: 'Map data © Google',
  summary: { total: 2, checked: 2, activity: 1, serviced: 0, inaccessible: 0 },
  stations: [
    { id: 's1', number: 1, label: null, cx: 0.25, cy: 0.5, status: 'ok' },
    { id: 's2', number: 2, label: 'Garage', cx: 0.75, cy: 0.5, status: 'activity' },
  ],
};

afterEach(cleanup);

describe('StationMapCard — trap pins', () => {
  it('renders snap-trap pins with numbers when trapPins is on for a trapping program', () => {
    const { container } = render(<StationMapCard stationMap={STATION_MAP} trapPins />);
    const pins = container.querySelectorAll('.trap-pin');
    expect(pins).toHaveLength(2);
    // number badges keep the pin numbering
    const texts = [...container.querySelectorAll('svg text')].map((node) => node.textContent);
    expect(texts).toEqual(expect.arrayContaining(['1', '2']));
    // tooltips speak "Trap", trapping legend copy is unchanged
    expect(container.querySelector('title').textContent).toContain('Trap 1');
    // armed trap: bar open; capture station: bar sprung
    expect(container.querySelectorAll('.trap-bar')).toHaveLength(2);
    expect(container.querySelectorAll('.trap-bar-snapped')).toHaveLength(1);
  });

  it('keeps the numbered-circle pins when trapPins is off, or for non-trapping programs, or the plan variant', () => {
    for (const props of [
      { stationMap: STATION_MAP },
      { stationMap: { ...STATION_MAP, program: 'rodent' }, trapPins: true },
      { stationMap: STATION_MAP, trapPins: true, variant: 'plan' },
    ]) {
      const { container, unmount } = render(<StationMapCard {...props} />);
      expect(container.querySelectorAll('.trap-pin')).toHaveLength(0);
      expect(container.querySelectorAll('svg circle').length).toBeGreaterThanOrEqual(2);
      unmount();
    }
  });

  it('summary line still reports inspected counts and captures', () => {
    const { container } = render(<StationMapCard stationMap={STATION_MAP} trapPins />);
    expect(container.textContent).toContain('2 of 2 stations inspected');
    expect(container.textContent).toContain('1 with captures recorded');
  });

  it('only armed (ok) traps are eligible for the ambient rat cycle', () => {
    // capture / inaccessible / serviced / unchecked pins carry a persisted
    // legend status — the decorative rat must never fire them (codex P2)
    expect(eligibleTrapIndices([
      { status: 'ok' },
      { status: 'activity' },
      { status: 'inaccessible' },
      { status: 'serviced' },
      { status: 'on_file' },
      { status: 'ok' },
    ])).toEqual([0, 5]);
    expect(eligibleTrapIndices([])).toEqual([]);
  });
});

// A declared trap SETUP means the pins went out on THIS visit. The default
// 'ok' status previously read "Checked — no capture" and the summary counted
// them as "inspected", both of which contradicted the same report's "Traps
// set" finding (codex P1 on #3159).
describe('StationMapCard — declared trap setup', () => {
  const SETUP_MAP = {
    ...STATION_MAP,
    initialSetup: true,
    summary: { total: 2, checked: 2, activity: 0, serviced: 0, inaccessible: 0 },
    stations: [
      { id: 's1', number: 1, label: null, cx: 0.25, cy: 0.5, status: 'ok' },
      { id: 's2', number: 2, label: 'Garage', cx: 0.75, cy: 0.5, status: 'ok' },
    ],
  };

  it('says the traps were set, never checked or inspected', () => {
    const { container } = render(<StationMapCard stationMap={SETUP_MAP} trapPins />);
    const text = container.textContent;
    expect(text).toContain('2 traps set this visit');
    expect(text).toContain('Set this visit');
    expect(text).not.toContain('inspected');
    expect(text).not.toContain('Checked — no capture');
  });

  it('a visit WITHOUT the flag keeps the ratified re-check wording', () => {
    const { container } = render(<StationMapCard stationMap={STATION_MAP} trapPins />);
    const text = container.textContent;
    expect(text).toContain('2 of 2 stations inspected');
    expect(text).not.toContain('set this visit');
  });

  it('the plan embed ignores it — that variant aggregates across visits', () => {
    const { container } = render(<StationMapCard stationMap={SETUP_MAP} variant="plan" />);
    const text = container.textContent;
    expect(text).not.toContain('set this visit');
    expect(text).toContain('inspected');
  });
});

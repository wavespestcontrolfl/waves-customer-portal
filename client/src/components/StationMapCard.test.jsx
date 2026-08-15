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

// codex P2 round 6: the closeout autofills traps_checked from the pins but
// relinquishes the field once the tech hand-edits it, so the map's count and
// the typed count can legitimately diverge.
//
// Round 9 corrected how that divergence is handled. Withholding the setup
// flag does NOT make the map neutral — it makes it say "inspected", which on
// a declared setup is worse than saying nothing. The stage and the count are
// separate facts: the stage is declared by the tech and stands; only the
// disputed number is suppressed.
describe('StationMapCard — setup counts stay consistent', () => {
  it('counts accessible pins, not every pin', () => {
    const { container } = render(<StationMapCard trapPins stationMap={{
      ...STATION_MAP,
      initialSetup: true,
      summary: { total: 3, checked: 2, activity: 0, serviced: 0, inaccessible: 1 },
      stations: [
        { id: 's1', number: 1, label: null, cx: 0.2, cy: 0.5, status: 'ok' },
        { id: 's2', number: 2, label: null, cx: 0.5, cy: 0.5, status: 'ok' },
        { id: 's3', number: 3, label: null, cx: 0.8, cy: 0.5, status: 'inaccessible' },
      ],
    }} />);
    // 2 accessible, matching what the closeout's autofill would have written.
    expect(container.textContent).toContain('2 traps set this visit');
    expect(container.textContent).toContain('1 not accessible');
    expect(container.textContent).not.toContain('3 traps set this visit');
  });

  it('without the flag the map says nothing about setup', () => {
    const { container } = render(<StationMapCard trapPins stationMap={{
      ...STATION_MAP,
      summary: { total: 2, checked: 2, activity: 0, serviced: 0, inaccessible: 0 },
      stations: [
        { id: 's1', number: 1, label: null, cx: 0.25, cy: 0.5, status: 'ok' },
        { id: 's2', number: 2, label: null, cx: 0.75, cy: 0.5, status: 'ok' },
      ],
    }} />);
    expect(container.textContent).toContain('2 of 2 stations inspected');
    expect(container.textContent).not.toContain('set this visit');
  });

  it('a disputed count drops the number but KEEPS the setup wording', () => {
    const { container } = render(<StationMapCard trapPins stationMap={{
      ...STATION_MAP,
      initialSetup: true,
      setupCountVerified: false,
      summary: { total: 2, checked: 2, activity: 0, serviced: 0, inaccessible: 0 },
      stations: [
        { id: 's1', number: 1, label: null, cx: 0.25, cy: 0.5, status: 'ok' },
        { id: 's2', number: 2, label: null, cx: 0.75, cy: 0.5, status: 'ok' },
      ],
    }} />);
    const text = container.textContent;
    // the pins still read as placements…
    expect(text).toContain('Set this visit');
    expect(text).toContain('where the traps went out on this visit');
    // …but the map restates no count, and never claims an inspection
    expect(text).not.toContain('traps set this visit');
    expect(text).not.toContain('inspected');
    expect(text).not.toContain('Checked — no capture');
  });

  it('an older payload with no verification field keeps its count', () => {
    const { container } = render(<StationMapCard trapPins stationMap={{
      ...STATION_MAP,
      initialSetup: true,
      summary: { total: 2, checked: 2, activity: 0, serviced: 0, inaccessible: 0 },
      stations: [
        { id: 's1', number: 1, label: null, cx: 0.25, cy: 0.5, status: 'ok' },
        { id: 's2', number: 2, label: null, cx: 0.75, cy: 0.5, status: 'ok' },
      ],
    }} />);
    expect(container.textContent).toContain('2 traps set this visit');
  });
});

// Termite bait-station pin animation (GATE_TERMITE_BAIT_PINS): the numbered
// circle pins pop in staggered and activity pins carry a pulsing halo — the
// termite report's map treatment (owner 2026-08-15). Everything else keeps
// the ratified static circles.
const TERMITE_MAP = {
  ...STATION_MAP,
  program: 'termite',
};

describe('StationMapCard — termite station pin animation', () => {
  it('animates circle pins and pulses activity stations when stationPins is on', () => {
    const { container } = render(<StationMapCard stationMap={TERMITE_MAP} stationPins />);
    const pins = container.querySelectorAll('.station-pin-pop');
    expect(pins).toHaveLength(2);
    // one activity station → exactly one pulse halo
    expect(container.querySelectorAll('.station-pulse')).toHaveLength(1);
    // still the numbered-circle rendering, not trap pins
    expect(container.querySelectorAll('.trap-pin')).toHaveLength(0);
    const texts = [...container.querySelectorAll('svg text')].map((node) => node.textContent);
    expect(texts).toEqual(expect.arrayContaining(['1', '2']));
    expect(container.querySelector('title').textContent).toContain('Station 1');
  });

  it('keeps static pins when stationPins is off', () => {
    const { container } = render(<StationMapCard stationMap={TERMITE_MAP} />);
    expect(container.querySelectorAll('.station-pin-pop')).toHaveLength(0);
    expect(container.querySelectorAll('.station-pulse')).toHaveLength(0);
  });

  it('never animates the plan embed or non-termite programs', () => {
    const plan = render(<StationMapCard stationMap={TERMITE_MAP} stationPins variant="plan" />);
    expect(plan.container.querySelectorAll('.station-pin-pop')).toHaveLength(0);
    cleanup();
    const rodent = render(<StationMapCard stationMap={{ ...TERMITE_MAP, program: 'rodent' }} stationPins />);
    expect(rodent.container.querySelectorAll('.station-pin-pop')).toHaveLength(0);
    expect(rodent.container.querySelectorAll('.station-pulse')).toHaveLength(0);
  });
});

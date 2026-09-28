// @vitest-environment jsdom
// Render tests for the Pest Report V2 "expectations" blocks
// (owner-approved 2026-09-27, GATE_PEST_REPORT_EXPECTATIONS) — each card
// renders when its payload key is present and renders nothing otherwise
// (gate off, or the visit had no relevant data, look identical).

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { PestRainExpectation, PestSpiderExpectation, PestWhatToExpect } from './PestReportV2';
import PestReportV2Section from './PestReportV2Section';

describe('PestRainExpectation', () => {
  afterEach(cleanup);

  it('renders each line when present', () => {
    render(<PestRainExpectation rain={{ lines: ['It\'s rained about 1.2" at your property over the past week.', 'Heavy rain pushes ants indoors; trails over the next few days usually mean the colony is moving through the treated band.'] }} />);
    expect(screen.getByText('Rain and your treatment')).toBeTruthy();
    expect(screen.getByText(/rained about 1\.2"/)).toBeTruthy();
    expect(screen.getByText(/Heavy rain pushes ants indoors/)).toBeTruthy();
  });

  it('renders nothing when absent', () => {
    const { container } = render(<PestRainExpectation rain={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when lines is empty', () => {
    const { container } = render(<PestRainExpectation rain={{ lines: [] }} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('PestSpiderExpectation', () => {
  afterEach(cleanup);

  const SPIDERS = {
    headline: 'Spiders',
    whatWeDid: 'This visit: Swept eaves, window frames, door frames, and lanai.',
    expectation: 'New webs can appear within days as new spiders arrive from outside.',
    nextStep: 'If it hasn\'t thinned out by then, text us and we\'ll come take another look.',
  };

  it('renders headline, what-we-did, expectation, and next step', () => {
    render(<PestSpiderExpectation spiders={SPIDERS} />);
    expect(screen.getByText('Spiders')).toBeTruthy();
    expect(screen.getByText(/Swept eaves/)).toBeTruthy();
    expect(screen.getByText(/New webs can appear/)).toBeTruthy();
    expect(screen.getByText(/come take another look/)).toBeTruthy();
  });

  it('renders nothing when absent', () => {
    const { container } = render(<PestSpiderExpectation spiders={null} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('PestWhatToExpect', () => {
  afterEach(cleanup);

  it('renders each line as a list item', () => {
    render(<PestWhatToExpect whatToExpect={{ lines: ['Ants may show up more for a few days.', 'Dead roaches may appear for a week or two.'] }} />);
    expect(screen.getByText('What to expect')).toBeTruthy();
    expect(screen.getByText('Ants may show up more for a few days.')).toBeTruthy();
    expect(screen.getByText('Dead roaches may appear for a week or two.')).toBeTruthy();
  });

  it('renders nothing when absent', () => {
    const { container } = render(<PestWhatToExpect whatToExpect={null} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('PestReportV2Section — expectations composition', () => {
  afterEach(cleanup);

  const STATUS_DATA = {
    status: { key: 'protected', label: 'Protected', tone: 'good' },
    statusSummary: 'Your service is complete and your protection plan is on track.',
  };

  it('renders all three expectations cards when present on the payload', () => {
    render(<PestReportV2Section data={{
      ...STATUS_DATA,
      expectations: {
        rain: { lines: ['It rained about 1" this week.'] },
        spiders: { headline: 'Spiders', whatWeDid: 'We swept the eaves.', expectation: 'Webs should thin out over about two weeks.', nextStep: 'Text us if not.' },
        whatToExpect: { lines: ['Ants may show up more for a few days.'] },
      },
    }} />);
    expect(screen.getByText('Rain and your treatment')).toBeTruthy();
    expect(screen.getByText('Spiders')).toBeTruthy();
    expect(screen.getByText('What to expect')).toBeTruthy();
  });

  it('renders none of the three when expectations is absent (gate off)', () => {
    render(<PestReportV2Section data={STATUS_DATA} />);
    expect(screen.queryByText('Rain and your treatment')).toBeNull();
    expect(screen.queryByText('Spiders')).toBeNull();
    expect(screen.queryByText('What to expect')).toBeNull();
  });
});

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

  // whatWeDid is server-fixed wording (never a raw protocol-action label —
  // owner ruling 2026-09-28); this fixture matches the actual server output.
  const SPIDERS = {
    headline: 'Spiders',
    whatWeDid: 'We knocked down webs and treated the eaves and entry points where spiders build.',
    expectation: 'New webs can appear within days as new spiders arrive from outside.',
    nextStep: 'If it hasn\'t thinned out by then, text us and we\'ll come take another look.',
  };

  it('renders headline, what-we-did, expectation, and next step', () => {
    render(<PestSpiderExpectation spiders={SPIDERS} />);
    expect(screen.getByText('Spiders')).toBeTruthy();
    expect(screen.getByText(/knocked down webs/)).toBeTruthy();
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

  // codex P2 2026-09-29 round 3: a sparse callback report (suppressDefense,
  // no primary move / metric / AI summary / concern) now returns from the
  // server with expectations as its ONLY real content — mirrors that exact
  // payload shape (every other field null/undefined, same as
  // buildPestReportV2 actually returns) and confirms the section still
  // mounts, shows the status hero + expectations, and never crashes on the
  // missing sibling fields.
  it('mounts correctly when expectations is the ONLY content (sparse callback payload)', () => {
    const EXPECTATIONS_ONLY_DATA = {
      status: { key: 'watching', label: 'We’re watching', tone: 'watch' },
      statusSummary: 'Your service is complete and your protection plan is on track.',
      supportingMetric: null,
      defense: null,
      primaryMove: null,
      customerConcern: null,
      bugFiles: [],
      pressureReceipt: null,
      weatherCall: null,
      aiSummary: null,
      forecast: null,
      expectations: {
        rain: { lines: ['It rained about 1" this week.'] },
        spiders: null,
        whatToExpect: { lines: ['Ants may show up more for a few days.'] },
      },
    };
    expect(() => render(<PestReportV2Section data={EXPECTATIONS_ONLY_DATA} />)).not.toThrow();
    expect(screen.getByText('Today’s protection status')).toBeTruthy();
    expect(screen.getByText('We’re watching')).toBeTruthy();
    expect(screen.getByText('Rain and your treatment')).toBeTruthy();
    expect(screen.getByText('What to expect')).toBeTruthy();
    // The unrelated cards this sparse payload carries nothing for stay out.
    expect(screen.queryByText('Spiders')).toBeNull();
  });
});

describe('expectation body copy meets the 16px customer text floor', () => {
  afterEach(cleanup);

  it('rain, spider and what-to-expect body text render at 16px; eyebrows stay 14px', () => {
    render(
      <>
        <PestRainExpectation rain={{ lines: ['It\'s rained about 1.2" at your property over the past week.'] }} />
        <PestSpiderExpectation spiders={{ headline: 'Spiders', whatWeDid: 'We swept webs from the eaves.', expectation: 'Expect fewer webs over the next two weeks.', nextStep: 'Text us if they keep coming back.' }} />
        <PestWhatToExpect whatToExpect={{ lines: ['With gel bait, dead roaches may show up for a week or two.'] }} />
      </>,
    );
    const body = [
      screen.getByText(/rained about 1\.2"/),
      screen.getByText('We swept webs from the eaves.'),
      screen.getByText('Expect fewer webs over the next two weeks.'),
      screen.getByText('Text us if they keep coming back.'),
      screen.getByText(/dead roaches may show up/),
    ];
    for (const node of body) expect(node.style.fontSize).toBe('16px');
    expect(screen.getByText('Rain and your treatment').style.fontSize).toBe('14px');
  });
});

// @vitest-environment jsdom
// GATE_LAWN_REPORT_POLISH: the Water card's three states. The payload carries water.scheduleKind only while the
// gate is live; without it the card prints exactly what it always did.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { WaterIntakeBar } from './LawnReportV2';
import COPY from '../../../../../shared/lawn-report-polish-copy.json';

afterEach(cleanup);

const BASE = { rainInches: 1.2, targetInches: 1, status: 'unknown', confidence: 'low', explanation: 'We don’t have your irrigation schedule on file yet. The seasonal target for your lawn is about 1"/wk.' };
const mixed = { ...BASE, irrigationInches: null, totalInches: 1.2, scheduleOnFile: false, scheduleKind: 'runtime_only', scheduleText: '45 min, Mondays' };

describe('state B: a schedule on file, no weekly inches', () => {
  it('prints what is on file, says weekly inches are missing, prints no Total, and asks for the weekly inches', () => {
    const { container } = render(<WaterIntakeBar water={mixed} />);
    expect(screen.getByTestId('lawn-water-schedule-on-file')).toHaveTextContent('45 min, Mondays');
    expect(container).not.toHaveTextContent('Not on file');
    expect(container).not.toHaveTextContent('Irrigation not on file');
    expect(container).toHaveTextContent(COPY.confidenceLabel);
    expect(container.textContent).not.toMatch(/\bTotal\b/);
    expect(container).toHaveTextContent(COPY.ctaTitle);
    expect(container).toHaveTextContent(COPY.ctaBody);
    const link = screen.getByRole('link', { name: COPY.ctaButton });
    expect(link).toHaveAttribute('href', '/?tab=property');
    expect(container).not.toHaveTextContent('we don’t have your watering schedule yet');
    expect(container).not.toHaveTextContent('Add your watering schedule');
  });

  it('only the part that is on file prints, and the stored words are used as given', () => {
    render(<WaterIntakeBar water={{ ...mixed, scheduleText: '45 min' }} />);
    expect(screen.getByTestId('lawn-water-schedule-on-file')).toHaveTextContent(/^45 min$/);
    cleanup();
    render(<WaterIntakeBar water={{ ...mixed, scheduleText: 'Mondays and Thursdays' }} />);
    expect(screen.getByTestId('lawn-water-schedule-on-file')).toHaveTextContent(/^Mondays and Thursdays$/);
  });

  it('without a rain reading the confidence line is the generic one (the schedule row still prints)', () => {
    const { container } = render(<WaterIntakeBar water={{ ...mixed, rainInches: null, totalInches: null }} />);
    expect(container).toHaveTextContent('Limited data this week');
    expect(screen.getByTestId('lawn-water-schedule-on-file')).toBeInTheDocument();
  });
});

describe('state C and the gate off: the card as it always was', () => {
  const none = { ...BASE, irrigationInches: null, totalInches: 1.2, scheduleOnFile: false };

  it('no scheduleKind (gate off): "Not on file", the schedule call to action', () => {
    const { container } = render(<WaterIntakeBar water={none} />);
    expect(container).toHaveTextContent('Not on file');
    expect(container).toHaveTextContent('Irrigation not on file');
    expect(container).toHaveTextContent('Get a water reading built for your lawn');
    expect(screen.getByRole('link', { name: 'Add your watering schedule →' })).toBeInTheDocument();
    expect(screen.queryByTestId('lawn-water-schedule-on-file')).toBeNull();
    expect(screen.queryByTestId('lawn-water-basis')).toBeNull();
  });

  it('scheduleKind none (gate on, nothing on file) is the same card', () => {
    const off = render(<WaterIntakeBar water={none} />).container.innerHTML;
    cleanup();
    expect(render(<WaterIntakeBar water={{ ...none, scheduleKind: 'none' }} />).container.innerHTML).toBe(off);
  });
});

describe('state A: inches known', () => {
  const known = { ...BASE, irrigationInches: 0.28, totalInches: 1.48, scheduleOnFile: true, status: 'high', confidence: 'high' };

  it('a derived figure prints its basis line beside the Irrigation row, no call to action', () => {
    const basis = 'About 0.28" a week from 45 minutes per zone, 1 day a week on rotor heads — typical head rates.';
    const { container } = render(<WaterIntakeBar water={{ ...known, scheduleKind: 'inches', irrigationBasis: basis }} />);
    expect(screen.getByTestId('lawn-water-basis')).toHaveTextContent(basis);
    expect(container).toHaveTextContent('Irrigation');
    expect(container).toHaveTextContent('0.28"');
    expect(container).toHaveTextContent('Total');
    expect(container).not.toHaveTextContent('Not on file');
    expect(container.querySelector('.lawn-water-cta')).toBeNull();
  });

  it('typed inches have no basis line, and the card matches the old one byte for byte', () => {
    const old = render(<WaterIntakeBar water={known} />).container.innerHTML;
    cleanup();
    expect(render(<WaterIntakeBar water={{ ...known, scheduleKind: 'inches' }} />).container.innerHTML).toBe(old);
  });
});

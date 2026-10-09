// @vitest-environment jsdom
// GATE_LAWN_WATER_RAIN: the Water card's "rain covered" state, the new deficit / surplus sentences and the rain sensor
// line. The server sets water.status 'rain_covered', water.rainCard and water.rainSensorLine only for a record whose
// frozen decision allows them; without those keys the card prints exactly what it always did.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { WaterIntakeBar, statusMeta } from './LawnReportV2';
import COPY from '../../../../../shared/lawn-water-rain-copy.json';
import WATERING from '../../../../../shared/watering-copy.json';

afterEach(cleanup);

const COVERED = `Rain alone covered your lawn this week. Leave the sprinklers off until the grass shows ${WATERING.wiltSigns}, then run one full cycle on an allowed watering day.`;
const BASE = { rainInches: 6, targetInches: 1.25, irrigationInches: 0.75, totalInches: 6.75, scheduleOnFile: true, confidence: 'high', source: 'irrigation_advice' };
const covered = { ...BASE, status: 'rain_covered', explanation: COVERED, rainCard: true, rainSensorLine: true };

describe('rain covered', () => {
  it('a neutral pill "Rain covered it", the fixed sentence at the 16px body size, the Rain row showing the measured total', () => {
    const { container } = render(<WaterIntakeBar water={covered} />);
    expect(statusMeta('rain_covered').label).toBe('Rain covered it');
    expect(container).toHaveTextContent('Rain covered it');
    expect(container).not.toHaveTextContent('Above target');
    const sentence = [...container.querySelectorAll('p')].find((el) => el.textContent === COVERED);
    expect(sentence).toBeTruthy();
    expect(sentence.style.fontSize).toBe('16px');
    expect(container).toHaveTextContent('6"');
  });

  it('with no schedule on file the sentence still prints (it names the sprinklers, which the irrigation screen would have hidden)', () => {
    const none = { ...covered, scheduleOnFile: false, irrigationInches: null, totalInches: 6, confidence: 'low', scheduleKind: 'none' };
    const { container } = render(<WaterIntakeBar water={none} />);
    expect(container).toHaveTextContent(COVERED);
    expect(container).toHaveTextContent('Rain covered it');
    expect(container).toHaveTextContent('Add your watering schedule'); // the schedule call to action stays
  });

  it('a weekly plan on the card keeps today\'s rule: the plan is the one watering instruction, the pill still says rain covered', () => {
    const { container } = render(<WaterIntakeBar water={{ ...covered, weekPlan: { title: 'This week: skip your run', detail: 'Rain covered it.' } }} />);
    expect(container).not.toHaveTextContent(COVERED);
    expect(container).toHaveTextContent('Rain covered it');
    expect(screen.getByTestId('lawn-water-rain-sensor')).toHaveTextContent(COPY.sensorLine); // not a plan duplicate
  });
});

describe('the lead layout', () => {
  it('the rain card\'s sentence stays on the card (not folded into "Why this reading"); an ordinary explanation still folds', () => {
    const { container } = render(<WaterIntakeBar water={covered} lead />);
    const sentence = [...container.querySelectorAll('p')].find((el) => el.textContent === COVERED);
    expect(sentence).toBeTruthy();
    expect(sentence.closest('details')).toBeNull();
    expect(container.querySelector('details')).toBeNull(); // nothing else to fold: no empty expander
    cleanup();
    const plain = render(<WaterIntakeBar water={{ ...BASE, status: 'high', explanation: 'Your weekly water (rain + irrigation) is running above about 1.25"/wk.' }} lead />).container;
    expect([...plain.querySelectorAll('p')].find((el) => el.textContent.startsWith('Your weekly water')).closest('details')).not.toBeNull();
  });
});

describe('the rain sensor line', () => {
  it('prints once, as the fixed sentence at 16px, only in a rain-covered week', () => {
    render(<WaterIntakeBar water={covered} />);
    const line = screen.getAllByTestId('lawn-water-rain-sensor');
    expect(line).toHaveLength(1);
    expect(line[0]).toHaveTextContent('Florida law requires a rain shutoff device on an automatic sprinkler system. If yours skipped a run this week, it is working.');
    expect(line[0].style.fontSize).toBe('16px');
  });

  it('absent when the server did not ask for it, or the week is not rain covered', () => {
    const { container } = render(<WaterIntakeBar water={{ ...covered, rainSensorLine: false }} />);
    expect(container.querySelector('[data-testid="lawn-water-rain-sensor"]')).toBeNull();
    cleanup();
    const other = render(<WaterIntakeBar water={{ ...BASE, status: 'low', rainCard: true, rainSensorLine: true, explanation: 'Your weekly water is below about 1.25"/wk.' }} />);
    expect(other.container.querySelector('[data-testid="lawn-water-rain-sensor"]')).toBeNull();
  });
});

describe('the new deficit and surplus sentences', () => {
  it('print at 16px; an ordinary explanation keeps 14px', () => {
    const deficit = { ...BASE, rainInches: 0.2, totalInches: 0.95, status: 'low', rainCard: true, explanation: `Your weekly water is below about 1.25"/wk. If the grass shows ${WATERING.wiltSigns}, run one full cycle on your next allowed watering day.` };
    const first = render(<WaterIntakeBar water={deficit} />).container;
    expect([...first.querySelectorAll('p')].find((el) => el.textContent === deficit.explanation).style.fontSize).toBe('16px');
    cleanup();
    const old = { ...deficit, rainCard: undefined, explanation: 'Your weekly water is below about 1.25"/wk. A little more irrigation time will help the lawn handle the heat.' };
    const second = render(<WaterIntakeBar water={old} />).container;
    expect([...second.querySelectorAll('p')].find((el) => el.textContent === old.explanation).style.fontSize).toBe('14px');
  });
});

describe('without the rain card the card is what it was', () => {
  it('no rainCard key: the irrigation-word screen still hides a schedule sentence beside "Not on file"', () => {
    const none = { rainInches: 1.2, targetInches: 1, status: 'unknown', confidence: 'low', scheduleOnFile: false, irrigationInches: null, totalInches: 1.2, explanation: 'We don’t have your irrigation schedule on file yet. The seasonal target for your lawn is about 1"/wk.' };
    const { container } = render(<WaterIntakeBar water={none} />);
    expect(container.querySelector('[data-testid="lawn-water-rain-sensor"]')).toBeNull();
    expect(container).not.toHaveTextContent('Rain covered it');
    expect(container).not.toHaveTextContent('We don’t have your irrigation schedule on file yet.');
  });
});

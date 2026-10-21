// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import WebPromiseCards, { ReportLiveChip, ReportProgramCard } from './WebPromiseCards';

afterEach(cleanup);

const promise = {
  monthLine: 'Month 4 of 12 in your lawn program.',
  items: [
    { key: 'coverage', label: 'Coverage', state: 'on_track', sentence: 'Coverage is on track at this point in the program.' },
    { key: 'color', label: 'Color', state: 'ahead', sentence: 'Color is ahead of where the program aims to be at this point.' },
    { key: 'weeds', label: 'Weeds', state: 'behind', sentence: 'Weeds are behind where the program aims to be at this point.' },
  ],
};

describe('web promise cards (GATE_REPORT_WEB_PROGRAM, GATE_REPORT_WEB_LIVE_CHIP)', () => {
  it('renders nothing without either key', () => {
    const { container } = render(<WebPromiseCards data={{ serviceLine: 'lawn' }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the live chip sentence as the server sent it', () => {
    render(<WebPromiseCards data={{ liveChip: { state: 'recent_rain', text: 'Rain fell 2 hours ago. Wait until the lawn is dry.' } }} glass />);
    expect(screen.getByRole('status')).toHaveTextContent('Rain fell 2 hours ago. Wait until the lawn is dry.');
    expect(screen.getByTestId('report-live-chip')).toHaveAttribute('data-glass', 'card');
  });

  it('shows the month line and one row per category, state spelled out in words', () => {
    render(<WebPromiseCards data={{ programPromise: promise }} />);
    const card = screen.getByTestId('report-program-card');
    expect(card).toHaveTextContent('Month 4 of 12 in your lawn program.');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(card).toHaveTextContent('On track');
    expect(card).toHaveTextContent('Ahead');
    expect(card).toHaveTextContent('Behind');
    expect(card).toHaveTextContent('Weeds are behind where the program aims to be at this point.');
  });

  it('either card alone, and an empty chip or program, render nothing', () => {
    expect(render(<ReportLiveChip chip={{ text: '' }} />).container).toBeEmptyDOMElement();
    expect(render(<ReportProgramCard promise={{ monthLine: 'x', items: [] }} />).container).toBeEmptyDOMElement();
    expect(render(<ReportProgramCard promise={null} />).container).toBeEmptyDOMElement();
  });

  it('is live-only: the wrapper carries the live-only class and a print rule hides it', () => {
    const { container } = render(<WebPromiseCards data={{ liveChip: { state: 'no_rain', text: 'No rain since your treatment.' }, programPromise: promise }} />);
    const wrapper = container.querySelector('[data-live-only="true"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper.classList.contains('web-live-only')).toBe(true);
    expect(wrapper.contains(screen.getByTestId('report-live-chip'))).toBe(true);
    expect(wrapper.contains(screen.getByTestId('report-program-card'))).toBe(true);
    const css = container.querySelector('style').textContent;
    expect(css).toMatch(/@media print\s*\{[^}]*\.web-live-only[^}]*display:\s*none\s*!important/);
  });

  it('keeps every font size at the 14px web floor', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/components/report/WebPromiseCards.jsx'), 'utf8');
    const sizes = [...source.matchAll(/fontSize: ([\d.]+)/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(14);
  });
});

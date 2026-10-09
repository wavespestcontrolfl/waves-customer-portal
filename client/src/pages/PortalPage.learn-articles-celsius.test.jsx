// @vitest-environment jsdom
// The Learn articles' Celsius tip takes its yearly limit from the stats response (celsiusMaxPerYear),
// never a number written in the page: 2 under the v13 lawn program, 3 before it.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api', () => {
  const target = {};
  const proxy = new Proxy(target, {
    get: (obj, prop) => {
      if (typeof prop !== 'string') return obj[prop];
      if (!(prop in obj)) obj[prop] = vi.fn(() => new Promise(() => {}));
      return obj[prop];
    },
    set: (obj, prop, value) => { obj[prop] = value; return true; },
  });
  return { default: proxy };
});

import api from '../utils/api';
import { buildArticles, useLearnArticles } from './PortalPage';

const celsiusTip = (articles) => articles.flatMap((a) => a.tips).find((tip) => /Celsius WG/.test(tip));

function Probe() {
  const articles = useLearnArticles();
  return <div data-testid="tip">{celsiusTip(articles)}</div>;
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('buildArticles', () => {
  it('states the figure it is given', () => {
    expect(celsiusTip(buildArticles({ celsiusMaxPerYear: 2 }))).toBe('We spot-treat with Celsius WG (max 2 applications a year)');
    expect(celsiusTip(buildArticles({ celsiusMaxPerYear: 3 }))).toBe('We spot-treat with Celsius WG (max 3 applications a year)');
  });
  it('names no number without one', () => {
    expect(celsiusTip(buildArticles())).toBe('We spot-treat with Celsius WG (a yearly application limit applies)');
  });
});

describe('useLearnArticles (the production entry point)', () => {
  it.each([2, 3])('reads celsiusMaxPerYear %i from the stats response', async (figure) => {
    api.getServiceStats.mockResolvedValue({ celsiusMaxPerYear: figure });
    render(<Probe />);
    expect(screen.getByTestId('tip')).toHaveTextContent('a yearly application limit applies');
    await waitFor(() => expect(screen.getByTestId('tip')).toHaveTextContent(`max ${figure} applications a year`));
    expect(api.getServiceStats).toHaveBeenCalledTimes(1);
  });

  it('keeps naming no number when the stats call fails', async () => {
    api.getServiceStats.mockRejectedValue(new Error('offline'));
    render(<Probe />);
    await waitFor(() => expect(api.getServiceStats).toHaveBeenCalled());
    expect(screen.getByTestId('tip')).toHaveTextContent('a yearly application limit applies');
  });
});

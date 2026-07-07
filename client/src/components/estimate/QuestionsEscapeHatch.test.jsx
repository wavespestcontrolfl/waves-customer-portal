// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import QuestionsEscapeHatch from './QuestionsEscapeHatch';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubUserAgent(ua) {
  vi.stubGlobal('navigator', { ...window.navigator, userAgent: ua });
}

describe('QuestionsEscapeHatch', () => {
  it('desktop mailto keeps the quote number — "#" must be percent-encoded, not a fragment', () => {
    stubUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    render(<QuestionsEscapeHatch estimateSlug="WPC-2026-1001" />);
    const href = screen.getByRole('link').getAttribute('href');
    expect(href).toMatch(/^mailto:/);
    // A raw "#" starts the URL fragment and truncates the body before the
    // quote id (Codex P2, PR #2468).
    expect(href).not.toContain('#');
    expect(href).toContain(encodeURIComponent('quote #WPC-2026-1001'));
  });

  it('mobile sms body carries the encoded quote number', () => {
    stubUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)');
    render(<QuestionsEscapeHatch estimateSlug="WPC-2026-1001" />);
    const href = screen.getByRole('link').getAttribute('href');
    expect(href).toMatch(/^sms:/);
    expect(href).not.toContain('#');
    expect(href).toContain(encodeURIComponent('quote #WPC-2026-1001'));
  });

  it('lawn-report context never mentions a quote number', () => {
    stubUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    render(<QuestionsEscapeHatch context="lawn_report" />);
    const href = screen.getByRole('link').getAttribute('href');
    expect(href).toContain(encodeURIComponent('my Waves lawn report'));
    expect(href).not.toContain('quote');
  });
});

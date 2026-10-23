// @vitest-environment jsdom
// "Before you book": the estimate PDF document prints the server's
// `beforeYouBook` page as one last section, exactly as given, and nothing when the key is absent.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import EstimateProposalDocument from './EstimateProposalDocument';

afterEach(() => { cleanup(); });

const BYB = {
  title: 'Before you book',
  sections: [
    { key: 'scheduling', heading: 'Scheduling and paying', lines: ['Server line one.', 'Server line two.'] },
    { key: 'lawn', heading: 'Lawn', lines: ['Server lawn line.'] },
  ],
  closing: 'Server closing line.',
};

const DOC_DATA = (extra = {}) => ({
  publicOrigin: 'https://portal.wavespestcontrol.com',
  estimate: { token: 'tok-1', slug: 'EST-2099-0003', customerName: 'Pat Example', address: '1 Example Way, Sarasota, FL 34200', createdAt: '2026-10-22T14:00:00.000Z', category: 'RESIDENTIAL', isOneTimeOnly: false },
  proposal: { enabled: false, synthesized: true, title: 'Service Proposal', buildings: [{ name: 'Lawn', lineItems: [{ description: 'Lawn care', quantity: 1, unitPrice: 50, amount: 50, frequency: 'monthly' }] }], totals: {} },
  cta: {},
  ...extra,
});

describe('EstimateProposalDocument before you book', () => {
  it('prints the sections, lines and closing line after the terms', () => {
    render(<EstimateProposalDocument data={DOC_DATA({ beforeYouBook: BYB })} token="tok-1" />);
    const page = screen.getByTestId('doc-before-you-book');
    expect(page).toHaveClass('doc-byb');
    expect(page).toHaveTextContent('Before you book');
    for (const text of ['Scheduling and paying', 'Server line one.', 'Server line two.', 'Lawn', 'Server lawn line.', 'Server closing line.']) {
      expect(page).toHaveTextContent(text);
    }
    const terms = screen.getByText(/^(Terms|Service terms)$/);
    expect(terms.compareDocumentPosition(page) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('starts on a new printed page', () => {
    render(<EstimateProposalDocument data={DOC_DATA({ beforeYouBook: BYB })} token="tok-1" />);
    const css = Array.from(document.querySelectorAll('style')).map((el) => el.textContent).join('\n');
    expect(css).toMatch(/\.doc-byb\s*\{[^}]*break-before:\s*page/);
  });

  it('prints nothing without the key (gate off) or with no sections', () => {
    render(<EstimateProposalDocument data={DOC_DATA()} token="tok-1" />);
    expect(screen.queryByTestId('doc-before-you-book')).toBeNull();
    cleanup();
    render(<EstimateProposalDocument data={DOC_DATA({ beforeYouBook: { title: 'Before you book', sections: [], closing: null } })} token="tok-1" />);
    expect(screen.queryByTestId('doc-before-you-book')).toBeNull();
    expect(document.body.textContent).not.toContain('Before you book');
  });
});

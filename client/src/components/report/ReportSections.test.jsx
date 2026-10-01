// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ReportText, { reportSectionsForText } from './ReportSections';

afterEach(() => cleanup());

const SECTIONS = [
  { key: 'whatWeFound', title: 'What we found', paragraphs: ['You mentioned ants by the dishwasher.'] },
  { key: 'whatWeDid', title: 'What we did and why', paragraphs: ['We placed bait along the counter.', 'Outside, we treated the foundation.'] },
  { key: 'whatToExpect', title: 'What to expect', paragraphs: ['You may see a few more ants for a few days.'] },
  { key: 'whatsNext', title: 'What’s next', paragraphs: ['Let us know if they keep trailing after about 1–2 weeks.'] },
];
const JOINED = SECTIONS.map((section) => section.paragraphs.join(' ')).join(' ');

describe('four-section report text', () => {
  it('matches only the exact report text, whitespace aside', () => {
    expect(reportSectionsForText(SECTIONS, JOINED)).toBe(SECTIONS);
    expect(reportSectionsForText(SECTIONS, `  ${JOINED.replace(/ /g, '\n')}  `)).toBe(SECTIONS);
    expect(reportSectionsForText(SECTIONS, 'Your routine service is complete.')).toBeNull();
    expect(reportSectionsForText(null, JOINED)).toBeNull();
  });

  it('renders the titles and paragraphs, with the next visit opening "What’s next"', () => {
    render(<ReportText text={JOINED} sections={SECTIONS} nextVisitLabel="Quarterly Pest Control · Wed, Dec 9" />);
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent))
      .toEqual(['What we found', 'What we did and why', 'What to expect', 'What’s next']);
    expect(screen.getByText('Outside, we treated the foundation.')).toBeInTheDocument();
    expect(screen.getByText('Next visit: Quarterly Pest Control · Wed, Dec 9')).toBeInTheDocument();
  });

  it('keeps any other text as one paragraph', () => {
    const { container } = render(<ReportText text="Your routine service is complete." sections={SECTIONS} className="ai-summary-body" />);
    expect(screen.queryByRole('heading')).toBeNull();
    expect(container.querySelector('p.ai-summary-body')).toHaveTextContent('Your routine service is complete.');
  });
});

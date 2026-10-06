// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import TreeShrubReportV2Section from './TreeShrubReportV2Section';

afterEach(cleanup);

// "From your technician" on the tree & shrub web report (GATE_TS_TECH_PARAGRAPH):
// the frozen text from reportV2.techParagraph prints as given under "What we
// applied today"; an absent key renders nothing. Synthetic data only.

const TEXT = 'Our technician found scale on the hedge along the back fence. Merit 2F went on the hedges, and Palm Gro 8-2-12 went on the palms.';
const snapshot = {
  overallScore: 77,
  statusHeadline: 'Landscape looking healthy',
  treatmentSummary: 'Today we applied an insect control and a fertilizer.',
};

describe('TreeShrubReportV2Section — From your technician', () => {
  it('prints the paragraph word for word, once, right after "What we applied today"', () => {
    const { container } = render(<TreeShrubReportV2Section data={{ snapshot, techParagraph: TEXT }} />);
    const block = screen.getByTestId('ts-tech-paragraph');
    expect(block.children[0].textContent).toBe('From your technician');
    expect(block.children[1].textContent).toBe(TEXT);
    expect(container.textContent.split('From your technician').length - 1).toBe(1);
    const text = container.textContent;
    expect(text.indexOf('What we applied today')).toBeLessThan(text.indexOf('From your technician'));
  });

  it('renders nothing for an absent, empty or non-string key', () => {
    for (const techParagraph of [undefined, null, '', '   ', { text: TEXT }, 42]) {
      cleanup();
      const { container } = render(<TreeShrubReportV2Section data={{ snapshot, techParagraph }} />);
      expect(container.textContent).not.toContain('From your technician');
      expect(screen.queryByTestId('ts-tech-paragraph')).toBeNull();
    }
  });
});

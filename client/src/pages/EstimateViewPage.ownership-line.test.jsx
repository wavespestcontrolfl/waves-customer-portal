// @vitest-environment jsdom
// Ownership line on the confirm step (owner 2026-10-02): one quiet line at
// the foot of ReviewPhase, below the payment disclosures.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ReviewPhase } from './EstimateViewPage';

afterEach(() => cleanup());

describe('estimate ownership line', () => {
  it('renders the ownership + license line once, after the confirm button', () => {
    render(
      <ReviewPhase
        slotId="2026-09-16_13-00_tech-1"
        slotMeta={{ date: '2026-09-16', time: '1:00 PM – 3:00 PM' }}
        paymentPreference="per_application"
        onConfirm={() => {}}
        onCancel={() => {}}
        serviceMode="recurring"
      />,
    );
    const lines = screen.getAllByTestId('estimate-ownership-line');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveTextContent('Locally owned. Not private equity. FL License #JB351547');
    const confirm = screen.getAllByRole('button')[0];
    expect(confirm.compareDocumentPosition(lines[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

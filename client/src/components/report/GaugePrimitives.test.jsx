// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TrendChip } from './GaugePrimitives';

afterEach(() => cleanup());

describe('TrendChip', () => {
  // 'rescaled' = earlier scores exist but on the pre-2026-09-24 scale: the
  // gauge must claim nothing (no "First marker", no up/down, no delta).
  it('renders nothing for a rescaled trend, even with a stray delta', () => {
    const { container } = render(<TrendChip trend="rescaled" delta={2.1} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('still renders a real trend with its delta', () => {
    const { container } = render(<TrendChip trend="increasing" delta={0.7} />);
    expect(container).toHaveTextContent('Increasing');
    expect(container).toHaveTextContent('+0.7 vs. last visit');
  });
});

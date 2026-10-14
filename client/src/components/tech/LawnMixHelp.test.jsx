// @vitest-environment jsdom
// The gallons sprayed control of the lawn mix help (GATE_LAWN_MIX_HELP): the preview shows the figure /complete will record,
// held to the lawn's area, with a one-line note when it was capped. Synthetic data only.
import React from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render, renderHook, screen } from '@testing-library/react';
import { RowMixHelp, useMixHelp } from './LawnMixHelp';

afterEach(cleanup);

const entry = { name: 'X', carrierGalPer1000: 1, perTank: { 1: { text: 'a', coversSqft: 1000 }, 2: { text: 'b', coversSqft: 2000 } }, per1000: 'p', note: null };
const block = (over = {}) => ({ tanks: [1, 2], rows: { aaa: entry }, weedOrder: null, planLawnSqft: null, ...over });
const row = (gallons) => ({ productId: 'AAA', name: 'Spot spray', spotRule: true, spotGallons: gallons });

function shown({ help, visitSqft, gallons }) {
  const { result } = renderHook(() => useMixHelp(help, 'op-1', visitSqft));
  render(<RowMixHelp row={row(gallons)} mix={result.current} locked={false} onChange={() => {}} />);
  return result.current;
}

describe('gallons preview cap', () => {
  test('capped by the visit area: the capped figure and the note', () => {
    shown({ help: block({ planLawnSqft: 3000 }), visitSqft: 1900, gallons: '4' });
    expect(screen.getByText('About 1,900 sq ft at 1 gal per 1,000 sq ft.')).toBeTruthy();
    expect(screen.getByText("Capped at the lawn's 1,900 sq ft.")).toBeTruthy();
    expect(screen.queryByText(/4,000/)).toBeNull();
  });

  test('capped by the plan\'s lawn size when no visit area is known', () => {
    shown({ help: block({ planLawnSqft: 2500 }), visitSqft: null, gallons: '4' });
    expect(screen.getByText('About 2,500 sq ft at 1 gal per 1,000 sq ft.')).toBeTruthy();
    expect(screen.getByText("Capped at the lawn's 2,500 sq ft.")).toBeTruthy();
  });

  test('the visit area wins over a larger plan size', () => {
    shown({ help: block({ planLawnSqft: 5000 }), visitSqft: 1900, gallons: '4' });
    expect(screen.getByText("Capped at the lawn's 1,900 sq ft.")).toBeTruthy();
  });

  test('uncapped when neither area is known: today\'s figure, no note', () => {
    shown({ help: block(), visitSqft: null, gallons: '4' });
    expect(screen.getByText('About 4,000 sq ft at 1 gal per 1,000 sq ft.')).toBeTruthy();
    expect(screen.queryByText(/Capped at/)).toBeNull();
  });

  test('no note when the gallons fit inside the lawn', () => {
    shown({ help: block(), visitSqft: 1900, gallons: '1' });
    expect(screen.getByText('About 1,000 sq ft at 1 gal per 1,000 sq ft.')).toBeTruthy();
    expect(screen.queryByText(/Capped at/)).toBeNull();
  });

  test('gate off (no mix help): nothing renders and no cap is held', () => {
    const mix = shown({ help: null, visitSqft: 1900, gallons: '4' });
    expect(mix.lawn).toBeNull();
    expect(screen.queryByText(/sq ft/)).toBeNull();
  });
});

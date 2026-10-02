// @vitest-environment jsdom
// The product picker's grouping: the pest line (the default) is unchanged, and
// the lawn line (`line="lawn"`) lists lawn categories under "Lawn products".
import React from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import FastCompleteProductPicker from './FastCompleteProductPicker';

afterEach(cleanup);

const PRODUCTS = [
  { id: 'bifen', name: 'Bifen Insecticide', category: 'insecticide' },
  { id: 'bait', name: 'Roach Gel Bait', category: 'bait' },
  { id: 'celsius', name: 'Celsius WG', category: 'herbicide' },
  { id: 'fert', name: 'Turf Fertilizer', category: 'fertilizer' },
  { id: 'sign', name: 'Yard Sign', category: 'supplies' },
];
const COMMON = [{ productId: 'bifen', usualUnit: 'fl_oz', usualAmount: 4 }];

function mount(props = {}) {
  render(<FastCompleteProductPicker variant="sheet" products={PRODUCTS} commonProducts={COMMON} onSheetIds={new Set()} onPick={vi.fn()} onClose={vi.fn()} {...props} />);
  return screen.getByRole('dialog', { name: 'Add a product' });
}
const names = (group) => within(group).getAllByRole('button').map((b) => b.textContent);

describe('default (pest) grouping', () => {
  test('is unchanged: used most, all pest products, other behind Show other products', () => {
    const picker = mount();
    expect(names(within(picker).getByRole('group', { name: 'Used most on pest visits' })).join('|')).toMatch(/Bifen Insecticide/);
    expect(within(picker).getByRole('group', { name: 'All pest products' })).toBeTruthy();
    expect(within(within(picker).getByRole('group', { name: 'All pest products' })).getByRole('button', { name: /Roach Gel Bait/ })).toBeTruthy();
    expect(within(picker).queryByText('Celsius WG')).toBeNull();
    expect(within(picker).queryByRole('group', { name: 'Lawn products' })).toBeNull();
    fireEvent.click(within(picker).getByRole('button', { name: 'Show other products' }));
    const other = within(picker).getByRole('group', { name: 'Other products' });
    expect(within(other).getByRole('button', { name: /Celsius WG/ })).toBeTruthy();
    expect(within(other).getByRole('button', { name: /Turf Fertilizer/ })).toBeTruthy();
    expect(within(picker).queryByText('Yard Sign')).toBeNull();
  });

  test('an explicit line="pest" is the same as the default', () => {
    const picker = mount({ line: 'pest' });
    expect(within(picker).getByRole('group', { name: 'All pest products' })).toBeTruthy();
  });
});

describe('lawn grouping', () => {
  test('lawn categories are listed as Lawn products; the rest waits behind Show other products', () => {
    const picker = mount({ line: 'lawn' });
    expect(within(picker).getByRole('group', { name: 'Used on the last lawn visit' })).toBeTruthy();
    const lawn = within(picker).getByRole('group', { name: 'Lawn products' });
    expect(within(lawn).getByRole('button', { name: /Celsius WG/ })).toBeTruthy();
    expect(within(lawn).getByRole('button', { name: /Turf Fertilizer/ })).toBeTruthy();
    expect(within(picker).queryByText('Roach Gel Bait')).toBeNull();
    fireEvent.click(within(picker).getByRole('button', { name: 'Show other products' }));
    expect(within(within(picker).getByRole('group', { name: 'Other products' })).getByRole('button', { name: /Roach Gel Bait/ })).toBeTruthy();
    expect(within(picker).queryByText('Yard Sign')).toBeNull();
  });

  test('search covers every listed product on either line', () => {
    const picker = mount({ line: 'lawn' });
    fireEvent.change(within(picker).getByLabelText('Search products'), { target: { value: 'bait' } });
    expect(within(within(picker).getByRole('group', { name: 'Matching products' })).getByRole('button', { name: /Roach Gel Bait/ })).toBeTruthy();
  });
});

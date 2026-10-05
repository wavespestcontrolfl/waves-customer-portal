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

  test('the dialog search covers every listed product on either line', () => {
    const picker = mount({ line: 'lawn' });
    fireEvent.change(within(picker).getByLabelText('Search products'), { target: { value: 'bait' } });
    expect(within(within(picker).getByRole('group', { name: 'Matching products' })).getByRole('button', { name: /Roach Gel Bait/ })).toBeTruthy();
  });

  test('a product tagged with its service lines is a lawn product only when lawn is one; an untagged one goes by its category', () => {
    const tagged = [
      { id: 'arena', name: 'Arena 50 WDG', category: 'insecticide', service_lines: ['lawn', 'pest'] },
      { id: 'advion', name: 'Advion WDG Granular', category: 'insecticide', service_lines: ['pest'] },
      { id: 'nutri', name: 'Nutriroot', category: 'fertilizer', service_lines: ['tree_shrub'] },
      // pg hands jsonb back parsed; a fake store may hand back the string.
      { id: 'string', name: 'Stringy Fert', category: 'fertilizer', service_lines: '["lawn"]' },
      ...PRODUCTS,
    ];
    const picker = mount({ line: 'lawn', products: tagged });
    const lawn = names(within(picker).getByRole('group', { name: 'Lawn products' })).join('|');
    expect(lawn).toMatch(/Arena 50 WDG/);
    expect(lawn).toMatch(/Stringy Fert/);
    expect(lawn).toMatch(/Celsius WG/);
    expect(lawn).not.toMatch(/Advion WDG Granular/);
    expect(lawn).not.toMatch(/Nutriroot/);
    fireEvent.click(within(picker).getByRole('button', { name: 'Show other products' }));
    const other = names(within(picker).getByRole('group', { name: 'Other products' })).join('|');
    expect(other).toMatch(/Advion WDG Granular/);
    expect(other).toMatch(/Nutriroot/);
  });
});

describe('inline search (the lawn sheet)', () => {
  const products = [
    { id: 'arena', name: 'Arena 50 WDG', category: 'insecticide', service_lines: ['lawn', 'pest'] },
    { id: 'advion', name: 'Advion WDG Granular', category: 'insecticide', service_lines: ['pest'] },
    { id: 'nufarm', name: 'Nufarm Cleary 3336F', category: 'fungicide' },
    ...PRODUCTS,
  ];
  function mountInline(props = {}) {
    render(<FastCompleteProductPicker variant="inline" line="lawn" products={products} commonProducts={[]} onSheetIds={new Set()} onPick={vi.fn()} {...props} />);
    return screen.getByLabelText('Search products');
  }

  test('on the lawn line it lists lawn products only: no bait, no pest-tagged insecticide, no supplies', () => {
    const box = mountInline();
    fireEvent.change(box, { target: { value: 'wdg' } });
    const matches = names(screen.getByRole('group', { name: 'Matching products' })).join('|');
    expect(matches).toMatch(/Arena 50 WDG/);
    expect(matches).not.toMatch(/Advion WDG Granular/);
    fireEvent.change(box, { target: { value: 'bait' } });
    expect(screen.getByText('No products match.')).toBeTruthy();
    fireEvent.change(box, { target: { value: 'sign' } });
    expect(screen.getByText('No products match.')).toBeTruthy();
    fireEvent.change(box, { target: { value: 'nu' } });
    expect(names(screen.getByRole('group', { name: 'Matching products' })).join('|')).toMatch(/Nufarm Cleary 3336F/);
  });

  test('on the pest line it searches every listed product', () => {
    const box = mountInline({ line: 'pest' });
    fireEvent.change(box, { target: { value: 'bait' } });
    expect(names(screen.getByRole('group', { name: 'Matching products' })).join('|')).toMatch(/Roach Gel Bait/);
  });
});

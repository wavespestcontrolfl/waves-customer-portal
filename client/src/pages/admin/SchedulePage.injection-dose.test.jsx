// @vitest-environment jsdom
//
// The Tree & Shrub injection record in the truck's measures (owner ruling
// 2026-09-29): an Arborjet label's mL rate reads in tsp or fl oz per inch of
// trunk (or per palm), the dose for the tree measured shows under it, and the
// dose itself is a number of tsp or fl oz. Nothing on the record reads mL.
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompletionPanel, TreeShrubCloseoutBlock, treeShrubCloseoutBlocksClient } from './SchedulePage';
import { injectionBand, injectionDoseText, injectionLabelRate, injectionLabelText } from '../../lib/injection-dose';

vi.mock('../../hooks/useFeatureFlag', () => ({
  useFeatureFlagReady: () => ({ enabled: false, ready: true }),
}));

// The catalog's Arborjet labels, as their display fields read. Only PHOSPHO-jet
// and Mn-jet have band tables; IMA-jet and Palm-jet have a label line only.
const IMA_JET = {
  id: 'ima-jet', name: 'Arborjet Ima-Jet Systemic Insecticide', category: 'insecticide',
  default_rate: '2-8', default_unit: 'ml/inch dbh', application_method: 'trunk_injection',
};
const PALM_JET = {
  id: 'palm-jet', name: 'Arborjet Palm-Jet Palm Nutrition', category: 'fertilizer',
  default_rate: '5-30', default_unit: 'ml/palm', application_method: 'trunk_injection',
};
const PHOSPHO_JET = {
  id: 'phospho-jet', name: 'Arborjet PHOSPHO-Jet Systemic Fungicide', category: 'fungicide',
  default_rate: '3.5-7', default_unit: 'ml/inch dbh', application_method: 'trunk_injection',
};
const MN_JET = {
  id: 'mn-jet', name: 'ArborJet Mn-Jet Fe Micros', category: 'fertilizer',
  default_rate: '5-15', default_unit: 'ml/inch dbh', application_method: 'trunk_injection',
};
const IMA_RATE = injectionLabelRate(IMA_JET);
const MN_RATE = injectionLabelRate(MN_JET);
const PHOSPHO_RATE = injectionLabelRate(PHOSPHO_JET);
const PALM_RATE = injectionLabelRate(PALM_JET);
const COLORS = { card: '#fff', border: '#ddd', text: '#111', muted: '#666', error: '#c00', warn: '#e60' };

// The block holding its own closeout state, as CompletionPanel does.
let latest;
function Block({ injectionProducts, initial = {} }) {
  const [value, setValue] = useState({ injectionPerformed: true, injectionRecord: {}, ...initial });
  latest = value;
  return (
    <TreeShrubCloseoutBlock
      value={value}
      onChange={setValue}
      blocks={[]}
      productFlags={{ hasInjectionProduct: true, missingActuals: [] }}
      injectionProducts={injectionProducts}
      inputStyle={{}}
      colors={COLORS}
    />
  );
}
const record = () => latest.injectionRecord;

afterEach(() => {
  cleanup();
  latest = undefined;
});

describe('the injection record', () => {
  it("names the visit's one injection product and reads its label per inch of trunk", async () => {
    render(<Block injectionProducts={[{ name: IMA_JET.name, rate: IMA_RATE }]} />);
    await waitFor(() => expect(record().product).toBe(IMA_JET.name));
    expect(screen.getByLabelText('Injection product').value).toBe(IMA_JET.name);
    expect(screen.getByText('½ – 1½ tsp per inch of trunk')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\bml\b/i);
  });

  it('works out the dose for the trunk measured and the plant picked, and stores the dose in tsp or fl oz', async () => {
    render(<Block injectionProducts={[{ name: PHOSPHO_JET.name, rate: PHOSPHO_RATE }]} />);
    await waitFor(() => expect(record().product).toBe(PHOSPHO_JET.name));
    fireEvent.change(screen.getByLabelText('Trunk (inches across, chest high)'), { target: { value: '10' } });
    expect(record().sizeClassOrDbh).toBe('10 in DBH');
    // The tech picks the plant first: the trunk alone settles nothing.
    expect(screen.queryByText('Dose for this tree')).toBeNull();
    fireEvent.change(screen.getByLabelText('Plant'), { target: { value: 'tree' } });
    expect(screen.getByText('Dose for this tree')).toBeTruthy();
    expect(screen.getByText(injectionDoseText(PHOSPHO_RATE, 10, 'tree'))).toBeTruthy();
    expect(screen.getByText('1.18 fl oz')).toBeTruthy();
    // Under 12 in, the label's 3.5 mL per inch.
    expect(screen.getByText(injectionLabelText(PHOSPHO_RATE, injectionBand(PHOSPHO_RATE, 10, 'tree')))).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Dose amount'), { target: { value: '7' } });
    expect(record().dose).toBe('7 fl oz');
    fireEvent.change(screen.getByLabelText('Dose unit'), { target: { value: 'tsp' } });
    expect(record().dose).toBe('7 tsp');
    expect([...screen.getByLabelText('Dose unit').options].map((option) => option.value)).toEqual(['tsp', 'fl_oz']);
    expect(screen.queryByRole('note')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\bml\b/i);
  });

  it("notes a dose over the label for that trunk, against the label's exact limit", () => {
    render(
      <Block
        injectionProducts={[{ name: PHOSPHO_JET.name, rate: PHOSPHO_RATE }]}
        initial={{ injectionRecord: { product: PHOSPHO_JET.name, sizeClassOrDbh: '10 in DBH' } }}
      />,
    );
    fireEvent.change(screen.getByLabelText('Dose amount'), { target: { value: '3' } });
    expect(screen.getByRole('note').textContent).toMatch(/^3 fl oz is more than the label allows for a 10-inch trunk/);
    // 2 fl oz is 59 mL, inside the label's top 70 mL for a 10-inch trunk, until the tree is picked.
    fireEvent.change(screen.getByLabelText('Dose amount'), { target: { value: '2' } });
    expect(screen.queryByRole('note')).toBeNull();
    // A tree under 12 in is allowed 35 mL: 2 fl oz is over it.
    fireEvent.change(screen.getByLabelText('Plant'), { target: { value: 'tree' } });
    expect(screen.getByRole('note').textContent).toMatch(/^2 fl oz is more than the label allows for a 10-inch trunk \(1\.18 fl oz\)/);
  });

  it("starts a new product without the old product's dose and band", async () => {
    render(
      <Block
        injectionProducts={[{ name: PHOSPHO_JET.name, rate: PHOSPHO_RATE }, { name: MN_JET.name, rate: MN_RATE }]}
        initial={{ injectionRecord: { product: PHOSPHO_JET.name, sizeClassOrDbh: '10 in DBH', dose: '1 fl oz', labelBand: { product: PHOSPHO_JET.name, key: 'tree' } } }}
      />,
    );
    fireEvent.change(screen.getByLabelText('Injection product'), { target: { value: MN_JET.name } });
    expect(record()).toMatchObject({ product: MN_JET.name, dose: '', labelBand: null, sizeClassOrDbh: '10 in DBH' });
    // Mn-jet asks for its own pick.
    expect(screen.getByLabelText('Plant and season').value).toBe('');
    expect(screen.getByLabelText('Dose amount').value).toBe('');
  });

  it('starts a palm product without the trunk measured for a tree', () => {
    render(
      <Block
        injectionProducts={[{ name: IMA_JET.name, basis: 'inch', rate: IMA_RATE }, { name: PALM_JET.name, basis: 'palm', rate: PALM_RATE }]}
        initial={{ injectionRecord: { product: IMA_JET.name, sizeClassOrDbh: '10 in DBH' } }}
      />,
    );
    fireEvent.change(screen.getByLabelText('Injection product'), { target: { value: PALM_JET.name } });
    expect(record().sizeClassOrDbh).toBe('');
  });

  it('asks for the trunk in inches for a label in grams per inch', () => {
    render(<Block injectionProducts={[{ name: 'Arborjet Arbor OTC Fungicide 1 oz', basis: 'inch', rate: null }]} initial={{ injectionRecord: { product: 'Arborjet Arbor OTC Fungicide 1 oz' } }} />);
    fireEvent.change(screen.getByLabelText('Trunk (inches across, chest high)'), { target: { value: '8' } });
    expect(record().sizeClassOrDbh).toBe('8 in DBH');
  });

  it("needs PHOSPHO-jet's plant picked, then settles the dose size by the trunk", async () => {
    render(<Block injectionProducts={[{ name: PHOSPHO_JET.name, rate: PHOSPHO_RATE }]} />);
    await waitFor(() => expect(record().product).toBe(PHOSPHO_JET.name));
    const pick = screen.getByLabelText('Plant');
    expect([...pick.options].map((option) => option.value)).toEqual(['', 'tree', 'palm']);
    // The tree option names its rate; the palm option is just its label.
    expect(screen.getByRole('option', { name: /^Tree \(hardwood or conifer\): / }).textContent).toMatch(/ tsp per inch of trunk$/);
    expect(screen.getByRole('option', { name: PHOSPHO_RATE.bands[1].label }).textContent).toBe(PHOSPHO_RATE.bands[1].label);
    fireEvent.change(screen.getByLabelText('Trunk (inches across, chest high)'), { target: { value: '10' } });
    expect(screen.queryByText('Dose for this tree')).toBeNull();
    fireEvent.change(pick, { target: { value: 'tree' } });
    expect(record().labelBand).toEqual({ product: PHOSPHO_JET.name, key: 'tree' });
    expect(screen.getByText(injectionDoseText(PHOSPHO_RATE, 10, 'tree'))).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Trunk (inches across, chest high)'), { target: { value: '18' } });
    expect(screen.getByText('2¼ – 3 fl oz')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Trunk (inches across, chest high)'), { target: { value: '30' } });
    expect(screen.getByText('5¼ – 7 fl oz')).toBeTruthy();
  });

  it("settles Mn-jet by the plant and season picked, whatever the trunk", async () => {
    render(<Block injectionProducts={[{ name: MN_JET.name, rate: MN_RATE }]} initial={{ injectionRecord: { product: MN_JET.name, sizeClassOrDbh: '10 in DBH' } }} />);
    const pick = screen.getByLabelText('Plant and season');
    expect([...pick.options].map((option) => option.value)).toEqual(['', 'tree_low', 'tree_late', 'palm']);
    expect(screen.queryByText('Dose for this tree')).toBeNull();
    fireEvent.change(pick, { target: { value: 'tree_low' } });
    expect(screen.getByText(injectionDoseText(MN_RATE, 10, 'tree_low'))).toBeTruthy();
    fireEvent.change(pick, { target: { value: 'tree_late' } });
    expect(screen.getByText(injectionDoseText(MN_RATE, 10, 'tree_late'))).toBeTruthy();
    expect(record().labelBand).toEqual({ product: MN_JET.name, key: 'tree_late' });
    // A tree to another tree measures the size the same way: the trunk stays.
    expect(record().sizeClassOrDbh).toBe('10 in DBH');
  });

  it('works out no dose and has no picker for IMA-jet or Palm-jet, only the label line', async () => {
    const { unmount } = render(<Block injectionProducts={[{ name: IMA_JET.name, rate: IMA_RATE }]} />);
    await waitFor(() => expect(record().product).toBe(IMA_JET.name));
    expect(screen.queryByLabelText('Target pest')).toBeNull();
    expect(screen.queryByLabelText('Plant')).toBeNull();
    fireEvent.change(screen.getByLabelText('Trunk (inches across, chest high)'), { target: { value: '10' } });
    expect(screen.queryByText('Dose for this tree')).toBeNull();
    expect(screen.getByText(/No dose is worked out for this product/)).toBeTruthy();
    // The target issue stays the tech's own text.
    expect(record().targetIssue ?? '').toBe('');
    unmount();
    render(<Block injectionProducts={[{ name: PALM_JET.name, rate: PALM_RATE }]} />);
    await waitFor(() => expect(record().product).toBe(PALM_JET.name));
    expect(screen.queryByLabelText('Palm size')).toBeNull();
    expect(screen.queryByText('Dose per palm')).toBeNull();
    expect(screen.getByText(/No dose is worked out for this product/)).toBeTruthy();
    expect(screen.getByText(injectionLabelText(PALM_RATE))).toBeTruthy();
  });

  it('works out no dose for an injectable with no band table', async () => {
    const rate = injectionLabelRate({ name: 'Some Injectable', default_rate: '1-6', default_unit: 'ml/inch dbh' });
    render(<Block injectionProducts={[{ name: 'Some Injectable', rate }]} />);
    await waitFor(() => expect(record().product).toBe('Some Injectable'));
    fireEvent.change(screen.getByLabelText('Trunk (inches across, chest high)'), { target: { value: '10' } });
    expect(screen.queryByText('Dose for this tree')).toBeNull();
    expect(screen.getByText(/No dose is worked out for this product/)).toBeTruthy();
  });

  it('reads a typed fraction, and never runs its digits together', () => {
    render(<Block injectionProducts={[]} initial={{ injectionRecord: { product: 'Tree-age' } }} />);
    const amount = screen.getByLabelText('Dose amount');
    fireEvent.change(amount, { target: { value: '1/2' } });
    expect(record().dose).toBe('0.5 fl oz');
    fireEvent.change(amount, { target: { value: '1 1/' } });
    expect(record().dose).toBe('');
    expect(amount.value).toBe('1 1/');
    expect(screen.getByText('Enter the dose as a number, like 1.5 or 1 1/2.')).toBeTruthy();
    fireEvent.change(amount, { target: { value: '1 1/2' } });
    expect(record().dose).toBe('1.5 fl oz');
    expect(screen.queryByText(/Enter the dose as a number/)).toBeNull();
  });

  it('shows the trunk the record holds after it changes elsewhere', async () => {
    render(<Block injectionProducts={[{ name: IMA_JET.name, rate: IMA_RATE }]} />);
    await waitFor(() => expect(record().product).toBe(IMA_JET.name));
    fireEvent.change(screen.getByLabelText('Trunk (inches across, chest high)'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Injection product'), { target: { value: '__other__' } });
    fireEvent.change(screen.getByPlaceholderText('DBH / palm size'), { target: { value: '20 in DBH' } });
    fireEvent.change(screen.getByLabelText('Injection product'), { target: { value: IMA_JET.name } });
    expect(screen.getByLabelText('Trunk (inches across, chest high)').value).toBe('20');
  });

  it('keeps a saved tsp dose in tsp while its amount is replaced', () => {
    render(<Block injectionProducts={[]} initial={{ injectionRecord: { product: 'Tree-age', dose: '3 tsp' } }} />);
    fireEvent.change(screen.getByLabelText('Dose amount'), { target: { value: '' } });
    expect(screen.getByLabelText('Dose unit').value).toBe('tsp');
    fireEvent.change(screen.getByLabelText('Dose amount'), { target: { value: '2' } });
    expect(record().dose).toBe('2 tsp');
  });

  it('saves the picked band with the record, and reads it back', () => {
    const { unmount } = render(
      <Block
        injectionProducts={[{ name: PHOSPHO_JET.name, rate: PHOSPHO_RATE }]}
        initial={{ injectionRecord: { product: PHOSPHO_JET.name, sizeClassOrDbh: '10 in DBH' } }}
      />,
    );
    fireEvent.change(screen.getByLabelText('Plant'), { target: { value: 'tree' } });
    expect(record().labelBand).toEqual({ product: PHOSPHO_JET.name, key: 'tree' });
    const saved = record();
    unmount();
    render(<Block injectionProducts={[{ name: PHOSPHO_JET.name, rate: PHOSPHO_RATE }]} initial={{ injectionRecord: { ...saved, dose: '2 fl oz' } }} />);
    expect(screen.getByLabelText('Plant').value).toBe('tree');
    expect(screen.getByRole('note').textContent).toMatch(/^2 fl oz is more than the label allows/);
  });

  it("never fills the target issue from a band, and keeps it the tech's own text", () => {
    render(
      <Block
        injectionProducts={[{ name: PHOSPHO_JET.name, rate: PHOSPHO_RATE }]}
        initial={{ injectionRecord: { product: PHOSPHO_JET.name, sizeClassOrDbh: '10 in DBH', targetIssue: 'Anthracnose' } }}
      />,
    );
    fireEvent.change(screen.getByLabelText('Plant'), { target: { value: 'tree' } });
    expect(record().targetIssue).toBe('Anthracnose');
    expect(screen.getByPlaceholderText('Injection target issue').value).toBe('Anthracnose');
    fireEvent.change(screen.getByPlaceholderText('Injection target issue'), { target: { value: 'Leaf spot' } });
    expect(record().targetIssue).toBe('Leaf spot');
  });

  it('notes a dose under the label for that trunk', () => {
    render(
      <Block
        injectionProducts={[{ name: PHOSPHO_JET.name, rate: PHOSPHO_RATE }]}
        initial={{ injectionRecord: { product: PHOSPHO_JET.name, sizeClassOrDbh: '10 in DBH', labelBand: { product: PHOSPHO_JET.name, key: 'tree' } } }}
      />,
    );
    fireEvent.change(screen.getByLabelText('Dose amount'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Dose unit'), { target: { value: 'tsp' } });
    expect(screen.getByRole('note').textContent).toMatch(/^1 tsp is less than the label's dose for a 10-inch trunk/);
    fireEvent.change(screen.getByLabelText('Dose unit'), { target: { value: 'fl_oz' } });
    fireEvent.change(screen.getByLabelText('Dose amount'), { target: { value: '1.18' } });
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('notes nothing under or over for a dose before the plant is picked', () => {
    render(
      <Block
        injectionProducts={[{ name: PHOSPHO_JET.name, rate: PHOSPHO_RATE }]}
        initial={{ injectionRecord: { product: PHOSPHO_JET.name, sizeClassOrDbh: '10 in DBH' } }}
      />,
    );
    fireEvent.change(screen.getByLabelText('Dose amount'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Dose unit'), { target: { value: 'tsp' } });
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('stores no trunk of zero', async () => {
    render(<Block injectionProducts={[{ name: PHOSPHO_JET.name, rate: PHOSPHO_RATE }]} />);
    await waitFor(() => expect(record().product).toBe(PHOSPHO_JET.name));
    for (const typed of ['.', '0', '0.0']) {
      fireEvent.change(screen.getByLabelText('Trunk (inches across, chest high)'), { target: { value: typed } });
      expect(record().sizeClassOrDbh).toBe('');
    }
  });

  it('follows the visit when the product it named itself is replaced', async () => {
    const { rerender } = render(<Block injectionProducts={[{ name: IMA_JET.name, rate: IMA_RATE }]} />);
    await waitFor(() => expect(record().product).toBe(IMA_JET.name));
    rerender(<Block injectionProducts={[{ name: PHOSPHO_JET.name, rate: PHOSPHO_RATE }]} />);
    await waitFor(() => expect(record().product).toBe(PHOSPHO_JET.name));
    expect(screen.getByLabelText('Injection product').value).toBe(PHOSPHO_JET.name);
  });

  it('follows the visit from a restored draft whose product the form named', async () => {
    render(
      <Block
        injectionProducts={[{ name: PHOSPHO_JET.name, rate: PHOSPHO_RATE }]}
        initial={{ injectionRecord: { product: IMA_JET.name, productAuto: true } }}
      />,
    );
    await waitFor(() => expect(record().product).toBe(PHOSPHO_JET.name));
  });

  it('keeps a restored product the tech chose, even off the visit', async () => {
    render(
      <Block
        injectionProducts={[{ name: PHOSPHO_JET.name, rate: PHOSPHO_RATE }]}
        initial={{ injectionRecord: { product: IMA_JET.name, productAuto: false } }}
      />,
    );
    await act(async () => {});
    expect(record().product).toBe(IMA_JET.name);
  });

  it('never reads a saved trunk size in another unit as inches', () => {
    render(
      <Block
        injectionProducts={[{ name: PHOSPHO_JET.name, rate: PHOSPHO_RATE }]}
        initial={{ injectionRecord: { product: PHOSPHO_JET.name, sizeClassOrDbh: '30 cm DBH', labelBand: { product: PHOSPHO_JET.name, key: 'tree' } } }}
      />,
    );
    expect(screen.getByLabelText('Trunk (inches across, chest high)').value).toBe('');
    expect(screen.getByText('The saved size "30 cm DBH" is not in inches. Enter the trunk in inches.')).toBeTruthy();
    expect(screen.queryByText('Dose for this tree')).toBeNull();
    fireEvent.change(screen.getByLabelText('Trunk (inches across, chest high)'), { target: { value: '12' } });
    expect(screen.getByText('Dose for this tree')).toBeTruthy();
    expect(record().sizeClassOrDbh).toBe('12 in DBH');
    expect(screen.queryByText(/is not in inches/)).toBeNull();
  });

  it('takes a palm pick with no trunk, no dose, and no under or over note', async () => {
    render(
      <Block
        injectionProducts={[{ name: PHOSPHO_JET.name, rate: PHOSPHO_RATE }]}
        initial={{ injectionRecord: { product: PHOSPHO_JET.name, sizeClassOrDbh: '10 in DBH', dose: '9 fl oz' } }}
      />,
    );
    fireEvent.change(screen.getByLabelText('Plant'), { target: { value: 'palm' } });
    expect(record().labelBand).toEqual({ product: PHOSPHO_JET.name, key: 'palm' });
    // Tree to palm starts the size over, and the trunk field gives way to the free-text size.
    expect(record().sizeClassOrDbh).toBe('');
    expect(screen.queryByLabelText('Trunk (inches across, chest high)')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('DBH / palm size'), { target: { value: 'Large palm' } });
    expect(record().sizeClassOrDbh).toBe('Large palm');
    expect(screen.queryByText('Dose for this tree')).toBeNull();
    expect(screen.queryByText('Dose per palm')).toBeNull();
    expect(screen.getByText('Dose you put in, per palm')).toBeTruthy();
    // 9 fl oz would be over any tree's label; a palm is dosed from the label's canopy table.
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.queryByText(/is not in inches/)).toBeNull();
    // The palm option is only its label, no rate.
    expect(screen.getByLabelText('Plant').selectedOptions[0].textContent).toBe(PHOSPHO_RATE.bands[1].label);
    // No tree rate per inch of trunk is shown for a palm.
    expect(screen.getByText("palms are dosed per palm from the label's canopy-spread table")).toBeTruthy();
    // (Only the picker's Tree option still names the tree rate.)
    expect(screen.queryAllByText(/per inch of trunk/).every((node) => node.tagName === 'OPTION')).toBe(true);
  });

  it('starts the size over when the pick goes from palm back to tree, but not from tree to tree', () => {
    render(
      <Block
        injectionProducts={[{ name: MN_JET.name, rate: MN_RATE }]}
        initial={{ injectionRecord: { product: MN_JET.name, sizeClassOrDbh: '10 in DBH', labelBand: { product: MN_JET.name, key: 'tree_low' } } }}
      />,
    );
    fireEvent.change(screen.getByLabelText('Plant and season'), { target: { value: 'tree_late' } });
    expect(record().sizeClassOrDbh).toBe('10 in DBH');
    fireEvent.change(screen.getByLabelText('Plant and season'), { target: { value: 'palm' } });
    expect(record().sizeClassOrDbh).toBe('');
    fireEvent.change(screen.getByPlaceholderText('DBH / palm size'), { target: { value: 'Medium palm' } });
    fireEvent.change(screen.getByLabelText('Plant and season'), { target: { value: 'tree_low' } });
    expect(record().sizeClassOrDbh).toBe('');
    expect(screen.getByLabelText('Trunk (inches across, chest high)').value).toBe('');
  });

  it('keeps an explicit other product, never putting the one injection product back', async () => {
    render(<Block injectionProducts={[{ name: IMA_JET.name, rate: IMA_RATE }]} />);
    await waitFor(() => expect(record().product).toBe(IMA_JET.name));
    fireEvent.change(screen.getByLabelText('Injection product'), { target: { value: '__other__' } });
    expect(record().product).toBe('');
    fireEvent.change(screen.getByPlaceholderText('Injection product'), { target: { value: 'Tree-age' } });
    fireEvent.change(screen.getByPlaceholderText('Injection product'), { target: { value: '' } });
    await act(async () => {});
    expect(record().product).toBe('');
    expect(screen.getByLabelText('Injection product').value).toBe('__other__');
    expect(screen.queryByText(/^Label:/)).toBeNull();
  });

  it('takes another product by name, with no helper', () => {
    render(<Block injectionProducts={[{ name: IMA_JET.name, rate: IMA_RATE }, { name: PALM_JET.name, rate: PALM_RATE }]} />);
    // Two injection products: nothing is picked for the tech.
    expect(record().product ?? '').toBe('');
    fireEvent.change(screen.getByLabelText('Injection product'), { target: { value: '__other__' } });
    fireEvent.change(screen.getByPlaceholderText('Injection product'), { target: { value: 'Tree-age' } });
    expect(record().product).toBe('Tree-age');
    expect(screen.queryByText(/^Label:/)).toBeNull();
    expect(screen.getByPlaceholderText('DBH / palm size')).toBeTruthy();
  });

  it('keeps a leading decimal point while the dose is typed', () => {
    render(<Block injectionProducts={[]} initial={{ injectionRecord: { product: 'Tree-age' } }} />);
    fireEvent.change(screen.getByLabelText('Dose amount'), { target: { value: '.' } });
    expect(screen.getByLabelText('Dose amount').value).toBe('.');
    fireEvent.change(screen.getByLabelText('Dose amount'), { target: { value: '.5' } });
    expect(screen.getByLabelText('Dose amount').value).toBe('.5');
    expect(record().dose).toBe('.5 fl oz');
  });

  it('reads a dose saved before this form, and shows one it cannot read', () => {
    const { unmount } = render(<Block injectionProducts={[]} initial={{ injectionRecord: { product: 'Tree-age', dose: '½ fl oz' } }} />);
    expect(screen.getByLabelText('Dose amount').value).toBe('0.5');
    expect(screen.getByLabelText('Dose unit').value).toBe('fl_oz');
    unmount();
    render(<Block injectionProducts={[]} initial={{ injectionRecord: { product: 'Tree-age', dose: 'a squirt' } }} />);
    expect(screen.getByLabelText('Dose amount').value).toBe('');
    expect(screen.getByText('The saved dose "a squirt" is not a number of tsp or fl oz. Enter it again.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Dose amount'), { target: { value: '2' } });
    expect(record().dose).toBe('2 fl oz');
    expect(screen.queryByText(/is not a number of tsp or fl oz/)).toBeNull();
  });

  it('keeps a typed product when the visit has no injection product; the dose is still tsp or fl oz', () => {
    render(<Block injectionProducts={[]} />);
    expect(screen.queryByLabelText('Injection product')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Injection product'), { target: { value: 'Tree-age' } });
    fireEvent.change(screen.getByLabelText('Dose amount'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Dose unit'), { target: { value: 'tsp' } });
    expect(record()).toMatchObject({ product: 'Tree-age', dose: '4 tsp' });
  });
});

const SHRUB_VISIT = {
  id: 'injection-shrub-visit', customerId: 'injection-customer', customerName: 'Synthetic Customer',
  serviceType: 'Tree & Shrub Care', status: 'confirmed', scheduledDate: '2099-01-01', estimatedPrice: 90,
  completionProfile: { serviceKey: 'tree_shrub', requiresProducts: true },
};

describe.each([['desktop', 1024], ['phone', 390]])('the Complete Service form, %s layout', (_layout, width) => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    vi.stubGlobal('scrollTo', vi.fn());
    vi.stubGlobal('alert', vi.fn());
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ customer: {}, actions: [], available: false }) })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  });

  it("lists the visit's Arborjet product in the injection record, its label in tsp", async () => {
    await act(async () => {
      render(<CompletionPanel service={SHRUB_VISIT} products={[IMA_JET]} onClose={() => {}} onSubmit={vi.fn()} />);
    });
    const search = screen.getByPlaceholderText(width < 640 ? 'Search products…' : 'Search products...');
    fireEvent.change(search, { target: { value: IMA_JET.name } });
    fireEvent.click(await screen.findByText(IMA_JET.name));
    await waitFor(() => expect(screen.getByLabelText('Injection product').value).toBe(IMA_JET.name));
    expect(screen.getByText('½ – 1½ tsp per inch of trunk')).toBeTruthy();
    // IMA-jet has no band table: the label line only, no picker, no worked-out dose.
    expect(screen.queryByLabelText('Target pest')).toBeNull();
    fireEvent.change(screen.getByLabelText('Trunk (inches across, chest high)'), { target: { value: '10' } });
    expect(screen.queryByText('Dose for this tree')).toBeNull();
    expect(screen.getByText(/No dose is worked out for this product/)).toBeTruthy();
  });

  it('asks for the injection record for an injectable named only by its catalog label', async () => {
    await act(async () => {
      render(<CompletionPanel service={SHRUB_VISIT} products={[PHOSPHO_JET]} onClose={() => {}} onSubmit={vi.fn()} />);
    });
    const search = screen.getByPlaceholderText(width < 640 ? 'Search products…' : 'Search products...');
    fireEvent.change(search, { target: { value: PHOSPHO_JET.name } });
    fireEvent.click(await screen.findByText(PHOSPHO_JET.name));
    await waitFor(() => expect(screen.getByLabelText('Injection product').value).toBe(PHOSPHO_JET.name));
    fireEvent.change(screen.getByLabelText('Trunk (inches across, chest high)'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Plant'), { target: { value: 'tree' } });
    expect(screen.getByText(injectionDoseText(PHOSPHO_RATE, 10, 'tree'))).toBeTruthy();
  });
});

describe('the closeout check against the product label', () => {
  const blocksFor = (product, rate, record) => treeShrubCloseoutBlocksClient({
    closeout: {
      injectionPerformed: true,
      injectionRecord: {
        plantSpecies: 'Live oak', product, dose: '3 tsp', numberOfPorts: 4,
        targetIssue: 'Scale', followUpDate: '2099-02-01', sizeClassOrDbh: '10 in DBH', ...record,
      },
    },
    productFlags: { missingActuals: [] },
    injectionProducts: [{ name: product, productId: 'p-1', basis: rate?.basis, rate }],
    servicePhotos: [], service: {}, customerRecap: '', notes: '', isIncompleteVisit: false,
  }).filter((block) => block.field?.startsWith('injectionRecord')).map((block) => block.message);

  it('needs the trunk in inches for a label in grams per inch', () => {
    const blocks = treeShrubCloseoutBlocksClient({
      closeout: { injectionPerformed: true, injectionRecord: { plantSpecies: 'Live oak', product: 'Arbor OTC', dose: '3 tsp', numberOfPorts: 4, targetIssue: 'Lethal bronzing', followUpDate: '2099-02-01', sizeClassOrDbh: 'Large' } },
      productFlags: { missingActuals: [] },
      injectionProducts: [{ name: 'Arbor OTC', basis: 'inch', rate: null }],
      servicePhotos: [], service: {}, customerRecap: '', notes: '', isIncompleteVisit: false,
    }).map((block) => block.message);
    expect(blocks).toContain('Enter the trunk in inches.');
  });

  it('finds the product by catalog id after a rename', () => {
    expect(blocksFor(PHOSPHO_JET.name, PHOSPHO_RATE, { product: 'Old name', productId: 'p-1', sizeClassOrDbh: '30 cm DBH', labelBand: { product: 'Old name', key: 'tree' } }))
      .toEqual(['Enter the trunk in inches.']);
    // The pick belongs to the name the record holds; a renamed record needs its pick again.
    expect(blocksFor(PHOSPHO_JET.name, PHOSPHO_RATE, { product: 'Old name', productId: 'p-1' })).toEqual(['Pick the plant for the injection dose.']);
  });

  it('needs the plant for PHOSPHO-jet and the plant and season for Mn-jet, picked for this product', () => {
    expect(blocksFor(PHOSPHO_JET.name, PHOSPHO_RATE, {})).toEqual(['Pick the plant for the injection dose.']);
    expect(blocksFor(PHOSPHO_JET.name, PHOSPHO_RATE, { labelBand: { product: 'Other', key: 'tree' } })).toEqual(['Pick the plant for the injection dose.']);
    expect(blocksFor(PHOSPHO_JET.name, PHOSPHO_RATE, { labelBand: { product: PHOSPHO_JET.name, key: 'tree' } })).toEqual([]);
    expect(blocksFor(MN_JET.name, MN_RATE, {})).toEqual(['Pick the plant and season for the injection dose.']);
    expect(blocksFor(MN_JET.name, MN_RATE, { labelBand: { product: PHOSPHO_JET.name, key: 'tree_low' } })).toEqual(['Pick the plant and season for the injection dose.']);
    expect(blocksFor(MN_JET.name, MN_RATE, { labelBand: { product: MN_JET.name, key: 'tree_late' } })).toEqual([]);
    // A key from another label's table is no pick.
    expect(blocksFor(MN_JET.name, MN_RATE, { labelBand: { product: MN_JET.name, key: 'tree' } })).toEqual(['Pick the plant and season for the injection dose.']);
  });

  it('needs no band for IMA-jet, Palm-jet or a label with no table', () => {
    expect(blocksFor(IMA_JET.name, IMA_RATE, {})).toEqual([]);
    expect(blocksFor(PALM_JET.name, PALM_RATE, { sizeClassOrDbh: 'Large palm' })).toEqual([]);
    expect(blocksFor('Some Injectable', injectionLabelRate({ name: 'Some Injectable', default_rate: '1-6', default_unit: 'ml/inch dbh' }), {})).toEqual([]);
    // IMA-jet is still per inch: it needs the trunk in inches.
    expect(blocksFor(IMA_JET.name, IMA_RATE, { sizeClassOrDbh: 'Large' })).toEqual(['Enter the trunk in inches.']);
  });

  it('needs no trunk in inches for a palm pick, and takes a free-text size', () => {
    const palm = { labelBand: { product: PHOSPHO_JET.name, key: 'palm' } };
    expect(blocksFor(PHOSPHO_JET.name, PHOSPHO_RATE, { ...palm, sizeClassOrDbh: 'Large palm' })).toEqual([]);
    expect(blocksFor(MN_JET.name, MN_RATE, { labelBand: { product: MN_JET.name, key: 'palm' }, sizeClassOrDbh: '30 cm DBH' })).toEqual([]);
    // A size is still required.
    expect(blocksFor(PHOSPHO_JET.name, PHOSPHO_RATE, { ...palm, sizeClassOrDbh: '' })).toEqual(['Injection record requires DBH or palm size class.']);
    // The same size on a tree pick is not a trunk in inches.
    expect(blocksFor(PHOSPHO_JET.name, PHOSPHO_RATE, { labelBand: { product: PHOSPHO_JET.name, key: 'tree' }, sizeClassOrDbh: 'Large palm' })).toEqual(['Enter the trunk in inches.']);
  });

  it('needs a per-inch trunk in inches above zero', () => {
    const tree = { labelBand: { product: PHOSPHO_JET.name, key: 'tree' } };
    for (const sizeClassOrDbh of ['0 in DBH', '30 cm DBH']) {
      expect(blocksFor(PHOSPHO_JET.name, PHOSPHO_RATE, { ...tree, sizeClassOrDbh })).toEqual(['Enter the trunk in inches.']);
    }
  });
});

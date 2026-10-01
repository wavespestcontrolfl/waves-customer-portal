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

// Two of the catalog's Arborjet labels, as their display fields read.
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
const IMA_RATE = injectionLabelRate(IMA_JET);
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

  it('works out the dose for the trunk measured and stores the dose in tsp or fl oz', async () => {
    render(<Block injectionProducts={[{ name: IMA_JET.name, rate: IMA_RATE }]} />);
    await waitFor(() => expect(record().product).toBe(IMA_JET.name));
    fireEvent.change(screen.getByLabelText('Trunk (inches across, chest high)'), { target: { value: '10' } });
    expect(record().sizeClassOrDbh).toBe('10 in DBH');
    // The label splits its rate: no dose until the tech picks the band.
    expect(screen.queryByText('Dose for this tree')).toBeNull();
    fireEvent.change(screen.getByLabelText('Target pest'), { target: { value: 'sap_feeders' } });
    expect(screen.getByText('Dose for this tree')).toBeTruthy();
    expect(screen.getByText(injectionDoseText(IMA_RATE, 10, 'sap_feeders'))).toBeTruthy();
    // Under 12 in, the label's lower rate for sap feeders: 2 mL per inch.
    expect(screen.getByText(injectionLabelText(IMA_RATE, injectionBand(IMA_RATE, 10, 'sap_feeders')))).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Dose amount'), { target: { value: '4' } });
    expect(record().dose).toBe('4 fl oz');
    fireEvent.change(screen.getByLabelText('Dose unit'), { target: { value: 'tsp' } });
    expect(record().dose).toBe('4 tsp');
    expect([...screen.getByLabelText('Dose unit').options].map((option) => option.value)).toEqual(['tsp', 'fl_oz']);
    expect(screen.queryByRole('note')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\bml\b/i);
  });

  it("notes a dose over the label for that trunk, against the label's exact limit", () => {
    render(
      <Block
        injectionProducts={[{ name: IMA_JET.name, rate: IMA_RATE }]}
        initial={{ injectionRecord: { product: IMA_JET.name, sizeClassOrDbh: '10 in DBH' } }}
      />,
    );
    fireEvent.change(screen.getByLabelText('Dose amount'), { target: { value: '3' } });
    expect(screen.getByRole('note').textContent).toMatch(/^3 fl oz is more than the label allows for a 10-inch trunk/);
    // 2 fl oz is 59 mL, inside the label's top 80 mL for a 10-inch trunk.
    fireEvent.change(screen.getByLabelText('Dose amount'), { target: { value: '2' } });
    expect(screen.queryByRole('note')).toBeNull();
    // For sap feeders the same tree (under 12 in) is allowed 20 mL: 2 fl oz is over it.
    fireEvent.change(screen.getByLabelText('Target pest'), { target: { value: 'sap_feeders' } });
    expect(screen.getByRole('note').textContent).toMatch(/^2 fl oz is more than the label allows for a 10-inch trunk \(4 tsp\)/);
  });

  it("starts a new product without the old product's dose and band", async () => {
    render(
      <Block
        injectionProducts={[{ name: IMA_JET.name, rate: IMA_RATE }, { name: PHOSPHO_JET.name, rate: PHOSPHO_RATE }]}
        initial={{ injectionRecord: { product: IMA_JET.name, sizeClassOrDbh: '10 in DBH', dose: '1 fl oz', labelBand: { product: IMA_JET.name, key: 'sap_feeders' } } }}
      />,
    );
    fireEvent.change(screen.getByLabelText('Injection product'), { target: { value: PHOSPHO_JET.name } });
    expect(record()).toMatchObject({ product: PHOSPHO_JET.name, dose: '', labelBand: null, sizeClassOrDbh: '10 in DBH' });
    expect(screen.getByLabelText('Dose amount').value).toBe('');
  });

  it('settles a size-banded label by the trunk, with nothing to pick', async () => {
    render(<Block injectionProducts={[{ name: PHOSPHO_JET.name, rate: PHOSPHO_RATE }]} />);
    await waitFor(() => expect(record().product).toBe(PHOSPHO_JET.name));
    expect(screen.queryByLabelText('Target pest')).toBeNull();
    fireEvent.change(screen.getByLabelText('Trunk (inches across, chest high)'), { target: { value: '10' } });
    expect(screen.getByText(injectionDoseText(PHOSPHO_RATE, 10, ''))).toBeTruthy();
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
        injectionProducts={[{ name: IMA_JET.name, rate: IMA_RATE }]}
        initial={{ injectionRecord: { product: IMA_JET.name, sizeClassOrDbh: '10 in DBH' } }}
      />,
    );
    fireEvent.change(screen.getByLabelText('Target pest'), { target: { value: 'sap_feeders' } });
    expect(record().labelBand).toEqual({ product: IMA_JET.name, key: 'sap_feeders' });
    const saved = record();
    unmount();
    render(<Block injectionProducts={[{ name: IMA_JET.name, rate: IMA_RATE }]} initial={{ injectionRecord: { ...saved, dose: '2 fl oz' } }} />);
    expect(screen.getByLabelText('Target pest').value).toBe('sap_feeders');
    expect(screen.getByRole('note').textContent).toMatch(/^2 fl oz is more than the label allows/);
  });

  it("records IMA-jet's target group as the target issue, with no second field", async () => {
    render(<Block injectionProducts={[{ name: IMA_JET.name, rate: IMA_RATE }]} />);
    await waitFor(() => expect(record().product).toBe(IMA_JET.name));
    expect(screen.queryByPlaceholderText('Injection target issue')).toBeNull();
    fireEvent.change(screen.getByLabelText('Target pest'), { target: { value: 'borers' } });
    expect(record().targetIssue).toBe(IMA_RATE.bands.find((band) => band.key === 'borers').label);
  });

  it('notes a dose under the label for that trunk', () => {
    render(
      <Block
        injectionProducts={[{ name: PHOSPHO_JET.name, rate: PHOSPHO_RATE }]}
        initial={{ injectionRecord: { product: PHOSPHO_JET.name, sizeClassOrDbh: '10 in DBH' } }}
      />,
    );
    fireEvent.change(screen.getByLabelText('Dose amount'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Dose unit'), { target: { value: 'tsp' } });
    expect(screen.getByRole('note').textContent).toMatch(/^1 tsp is less than the label's dose for a 10-inch trunk/);
    fireEvent.change(screen.getByLabelText('Dose unit'), { target: { value: 'fl_oz' } });
    fireEvent.change(screen.getByLabelText('Dose amount'), { target: { value: '1.18' } });
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
        initial={{ injectionRecord: { product: PHOSPHO_JET.name, sizeClassOrDbh: '30 cm DBH' } }}
      />,
    );
    expect(screen.getByLabelText('Trunk (inches across, chest high)').value).toBe('');
    expect(screen.getByText('The saved size "30 cm DBH" is not in inches. Enter the trunk in inches.')).toBeTruthy();
    expect(screen.queryByText('Dose for this tree')).toBeNull();
    fireEvent.change(screen.getByLabelText('Trunk (inches across, chest high)'), { target: { value: '12' } });
    expect(record().sizeClassOrDbh).toBe('12 in DBH');
    expect(screen.getByText('Dose for this tree')).toBeTruthy();
  });

  it('doses a palm per palm, with no trunk size', async () => {
    render(<Block injectionProducts={[{ name: PALM_JET.name, rate: PALM_RATE }]} />);
    await waitFor(() => expect(record().product).toBe(PALM_JET.name));
    expect(screen.queryByLabelText('Trunk (inches across, chest high)')).toBeNull();
    // The palm-size band is the record's size: no second size field.
    expect(screen.queryByPlaceholderText('DBH / palm size')).toBeNull();
    fireEvent.change(screen.getByLabelText('Palm size'), { target: { value: 'medium' } });
    expect(record().sizeClassOrDbh).toBe('Medium palm (12 to 24 ft spread)');
    expect(screen.getByText('Dose per palm')).toBeTruthy();
    expect(screen.getByText(injectionDoseText(PALM_RATE, '', 'medium'))).toBeTruthy();
    expect(screen.getByText('Dose you put in, per palm')).toBeTruthy();
    expect(screen.getByText(injectionLabelText(PALM_RATE, PALM_RATE.bands[1]))).toBeTruthy();
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
    fireEvent.change(screen.getByLabelText('Trunk (inches across, chest high)'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Target pest'), { target: { value: 'sap_feeders' } });
    expect(screen.getByText(injectionDoseText(IMA_RATE, 10, 'sap_feeders'))).toBeTruthy();
  });

  it('asks for the injection record for an injectable named only by its catalog label', async () => {
    await act(async () => {
      render(<CompletionPanel service={SHRUB_VISIT} products={[PHOSPHO_JET]} onClose={() => {}} onSubmit={vi.fn()} />);
    });
    const search = screen.getByPlaceholderText(width < 640 ? 'Search products…' : 'Search products...');
    fireEvent.change(search, { target: { value: PHOSPHO_JET.name } });
    fireEvent.click(await screen.findByText(PHOSPHO_JET.name));
    await waitFor(() => expect(screen.getByLabelText('Injection product').value).toBe(PHOSPHO_JET.name));
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
    injectionProducts: [{ name: product, rate }],
    servicePhotos: [], service: {}, customerRecap: '', notes: '', isIncompleteVisit: false,
  }).filter((block) => block.field?.startsWith('injectionRecord')).map((block) => block.message);

  it('needs the band a label is split by, picked for this product', () => {
    expect(blocksFor(IMA_JET.name, IMA_RATE, {})).toEqual(['Pick the target pest for the injection dose.']);
    expect(blocksFor(IMA_JET.name, IMA_RATE, { labelBand: { product: 'Other', key: 'sap_feeders' } })).toEqual(['Pick the target pest for the injection dose.']);
    expect(blocksFor(IMA_JET.name, IMA_RATE, { labelBand: { product: IMA_JET.name, key: 'sap_feeders' }, targetIssue: 'Aphids, scales, whiteflies and other sap feeders' })).toEqual([]);
    expect(blocksFor(IMA_JET.name, IMA_RATE, { labelBand: { product: IMA_JET.name, key: 'sap_feeders' }, targetIssue: 'Borers' }))
      .toEqual(['Target issue must match the picked band (Aphids, scales, whiteflies and other sap feeders).']);
    expect(blocksFor(PHOSPHO_JET.name, PHOSPHO_RATE, {})).toEqual([]);
  });

  it('needs the palm size to be the picked palm band', () => {
    const band = { product: PALM_JET.name, key: 'small' };
    expect(blocksFor(PALM_JET.name, PALM_RATE, { labelBand: band, sizeClassOrDbh: 'Small palm (6 to 12 ft spread)' })).toEqual([]);
    expect(blocksFor(PALM_JET.name, PALM_RATE, { labelBand: band, sizeClassOrDbh: 'Large palm (24 to 48 ft spread)' })).toEqual(['Palm size must match the picked band (Small palm (6 to 12 ft spread)).']);
  });

  it('needs a per-inch trunk in inches above zero', () => {
    for (const sizeClassOrDbh of ['0 in DBH', '30 cm DBH']) {
      expect(blocksFor(PHOSPHO_JET.name, PHOSPHO_RATE, { sizeClassOrDbh })).toEqual(['Enter the trunk in inches.']);
    }
  });
});

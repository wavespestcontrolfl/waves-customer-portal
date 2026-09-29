// @vitest-environment jsdom
//
// The Tree & Shrub injection record in the truck's measures (owner ruling
// 2026-09-29): an Arborjet label's mL rate reads in tsp or fl oz per inch of
// trunk (or per palm), the dose for the tree measured shows under it, and the
// dose itself is a number of tsp or fl oz. Nothing on the record reads mL.
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompletionPanel, TreeShrubCloseoutBlock } from './SchedulePage';
import { injectionDoseText, injectionLabelRate, injectionLabelText } from '../../lib/injection-dose';

vi.mock('../../hooks/useFeatureFlag', () => ({
  useFeatureFlagReady: () => ({ enabled: false, ready: true }),
}));

// Two of the catalog's Arborjet labels, as their display fields read.
const IMA_JET = {
  id: 'ima-jet-10', name: 'Arborjet Ima-Jet 10', category: 'insecticide',
  default_rate: '1-6', default_unit: 'ml/inch dbh', application_method: 'trunk_injection',
};
const PALM_JET = {
  id: 'palm-jet', name: 'Arborjet Palm-Jet Palm Nutrition', category: 'fertilizer',
  default_rate: '5-30', default_unit: 'ml/palm', application_method: 'trunk_injection',
};
const IMA_RATE = injectionLabelRate(IMA_JET);
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
    expect(screen.getByText('¼ – 1 tsp per inch of trunk')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\bml\b/i);
  });

  it('works out the dose for the trunk measured and stores the dose in tsp or fl oz', async () => {
    render(<Block injectionProducts={[{ name: IMA_JET.name, rate: IMA_RATE }]} />);
    await waitFor(() => expect(record().product).toBe(IMA_JET.name));
    fireEvent.change(screen.getByLabelText('Trunk (inches across, chest high)'), { target: { value: '10' } });
    expect(record().sizeClassOrDbh).toBe('10 in DBH');
    expect(screen.getByText('Dose for this tree')).toBeTruthy();
    expect(screen.getByText(injectionDoseText(IMA_RATE, 10))).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Dose amount'), { target: { value: '1' } });
    expect(record().dose).toBe('1 fl oz');
    fireEvent.change(screen.getByLabelText('Dose unit'), { target: { value: 'tsp' } });
    expect(record().dose).toBe('1 tsp');
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
    // 2 fl oz is 59 mL, inside the label's 60 mL for a 10-inch trunk.
    fireEvent.change(screen.getByLabelText('Dose amount'), { target: { value: '2' } });
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('doses a palm per palm, with no trunk size', async () => {
    render(<Block injectionProducts={[{ name: PALM_JET.name, rate: PALM_RATE }]} />);
    await waitFor(() => expect(record().product).toBe(PALM_JET.name));
    expect(screen.queryByLabelText('Trunk (inches across, chest high)')).toBeNull();
    expect(screen.getByPlaceholderText('DBH / palm size')).toBeTruthy();
    expect(screen.getByText('Dose per palm')).toBeTruthy();
    expect(screen.getByText('Dose you put in, per palm')).toBeTruthy();
    expect(screen.getByText(injectionLabelText(PALM_RATE))).toBeTruthy();
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
    expect(screen.getByText('¼ – 1 tsp per inch of trunk')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Trunk (inches across, chest high)'), { target: { value: '10' } });
    expect(screen.getByText(injectionDoseText(IMA_RATE, 10))).toBeTruthy();
  });
});

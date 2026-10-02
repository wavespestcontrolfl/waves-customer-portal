import React, { useId, useState } from 'react';
import { Select } from '../ui';
import { formatMeasuredAmount, formatMeasuredRange } from '../../lib/mix-amount';

const TANKS = [{ id: 'bg', gallons: 1 }, { id: 'flowzone', gallons: 4 }, { id: 'rig', gallons: 110 }];
const heading = 'text-14 font-medium text-ink-tertiary';

function ProductDetails({ product, equipment, mode, tank, onTankChange }) {
  const [localChosen, setLocalChosen] = useState(product.equipment?.[0] || '');
  const chosen = product.mix ? tank : localChosen;
  const options = (product.equipment || []).filter(key => equipment[key]);
  const labelClass = mode === 'tech' ? 'text-14 font-medium text-ink-secondary' : heading;
  return <div className="space-y-4 border-t border-hairline border-b-0 border-x-0 border-solid border-zinc-200 bg-zinc-50 p-4 text-14 leading-relaxed">
    {product.pending && <p className="text-ink-primary">{product.pending}</p>}
    {options.length > 0 && <div>
      <label className="block space-y-1">
        <span className={labelClass}>Equipment</span>
        <Select className="min-h-11 text-14" aria-label={`Equipment for ${product.name}`} value={chosen}
          onChange={e => product.mix ? onTankChange(e.target.value) : setLocalChosen(e.target.value)}>
          {options.map(key => <option key={key} value={key}>{equipment[key].name}</option>)}
        </Select>
      </label>
      <p className="mt-1 text-ink-secondary">{equipment[chosen]?.model && `${equipment[chosen].model} · `}{equipment[chosen]?.detail}</p>
    </div>}
    <div><h4 className={labelClass}>{product.targetTitle}</h4><p>{product.targets}</p></div>
    <div><h4 className={labelClass}>How to apply</h4><p>{product.apply}</p></div>
    <div><h4 className={labelClass}>Label rates</h4><dl className="space-y-2 mt-1">{product.rates.map(([rate, target]) => <div key={rate}><dt className="font-medium">{rate}</dt><dd className="text-ink-secondary">{target}</dd></div>)}</dl></div>
    {product.limits?.length > 0 && <div><h4 className={labelClass}>Restrictions</h4><ul className="list-disc pl-5 space-y-1">{product.limits.map(limit => <li key={limit}>{limit}</li>)}</ul></div>}
    {product.program && <p className="text-ink-secondary">{product.program}</p>}
    {product.url ? <a href={product.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-ink-primary underline underline-offset-4">{product.source} ↗</a> : <p className="text-ink-secondary">{product.source}</p>}
  </div>;
}

function amountFor(product, gallons) {
  if (!product.mix) return product.summary;
  if (product.mix[0] === product.mix[1]) {
    // A fixed guide dose is the label minimum (TriTek 1% = 1.28 fl oz/gal):
    // round UP to a measurable quarter ounce so the tank never mixes under it.
    const exact = product.mix[0] * gallons;
    const up = Math.ceil(exact * 4 - 1e-9) / 4;
    const text = formatMeasuredAmount(up, 'fl oz', { truckMeasures: true });
    return up > exact + 1e-9 ? `≈ ${text}` : text;
  }
  return formatMeasuredRange(product.mix[0] * gallons, product.mix[1] * gallons, 'fl oz', { truckMeasures: true });
}

export default function TreeShrubFieldGuide({ guide, mode = 'admin', safetyRules = [] }) {
  const [open, setOpen] = useState(null);
  const [tank, setTank] = useState('flowzone');
  const instance = useId();
  const tech = mode === 'tech';
  const labelClass = tech ? 'text-14 font-medium text-ink-secondary' : heading;
  const hasMix = Object.values(guide.products).some(p => p.mix);
  return <div className="bg-white text-ink-primary text-14 leading-relaxed [&_*]:box-border [&_p]:m-0 [&_h2]:mt-0 [&_h3]:mt-0 [&_h4]:m-0 [&_dl]:mb-0 [&_dd]:ml-0 [&_ul]:my-0" data-testid="tree-shrub-field-guide">
    <header className="border-b border-hairline border-t-0 border-x-0 border-solid border-zinc-200 pb-4 mb-5">
      <h2 className="text-20 font-medium">Tree &amp; Shrub</h2>
      <p className="text-ink-secondary">{guide.month} · {guide.title}</p>
      {hasMix && <label className={`block mt-3 max-w-xs space-y-1 ${tech ? '' : 'md:hidden'}`}>
        <span className={labelClass}>Mix size</span>
        <Select aria-label="Mix size" className="min-h-11 text-14" value={tank} onChange={e => setTank(e.target.value)}>
          {TANKS.map(t => <option key={t.id} value={t.id}>{guide.equipment[t.id].name}</option>)}
        </Select>
      </label>}
    </header>
    {guide.decision && <p className="mb-5 text-ink-secondary">{guide.decision}</p>}
    {[['routine', 'Routine when due'], ['conditional', 'If you find']].map(([section, title]) => guide[section].length > 0 && <section key={section} className="mb-6">
      <h3 className={`${labelClass} mb-2`}>{title}</h3>
      {!tech && <div className="hidden md:grid grid-cols-[minmax(180px,2fr)_repeat(3,minmax(100px,1fr))] gap-3 py-2 border-b border-hairline border-t-0 border-x-0 border-solid border-zinc-200 text-14 text-ink-tertiary">
        <span>Product</span><span>B&amp;G 1 gal</span><span>FlowZone 4 gal</span><span>Rig 110 gal</span>
      </div>}
      {guide[section].map((row, i) => {
        const product = guide.products[row.key];
        const key = `${section}-${row.key}-${i}`;
        const panelId = `${instance}-${key}`;
        const expanded = key === open;
        return <div key={key} className="border-b border-hairline border-t-0 border-x-0 border-solid border-zinc-200">
          <button type="button" aria-expanded={expanded} aria-controls={panelId} onClick={() => setOpen(expanded ? null : key)}
            className={`appearance-none border-0 bg-transparent px-0 w-full min-h-11 text-left py-3 u-focus-ring ${tech ? '' : 'md:grid md:grid-cols-[minmax(180px,2fr)_repeat(3,minmax(100px,1fr))] md:gap-3 md:items-center'}`}>
            <span className="block"><span className="font-medium">{product.name}</span><span aria-hidden="true" className="ml-2">{expanded ? '−' : '+'}</span><span className="block text-ink-secondary">{row.where}</span></span>
            <span className={`block text-ink-secondary ${tech ? '' : 'md:hidden'}`}>{amountFor(product, TANKS.find(t => t.id === tank).gallons)}</span>
            {!tech && (product.mix ? TANKS.map(t => <span className="hidden md:block tabular-nums" key={t.id}>{amountFor(product, t.gallons)}</span>) : <span className="hidden md:block md:col-span-3 text-ink-secondary">{product.summary}</span>)}
          </button>
          {expanded && <div id={panelId}><ProductDetails key={key} product={product} equipment={guide.equipment} mode={mode} tank={tank} onTankChange={setTank} /></div>}
        </div>;
      })}
    </section>)}
    {guide.dont.length > 0 && <section className="mb-6"><h3 className={`${labelClass} mb-2`}><span className="text-alert-fg mr-2" aria-hidden="true">●</span>Don’t</h3><ul className="space-y-1">{guide.dont.map(line => <li key={line}>{line}</li>)}</ul></section>}
    {guide.palmChart.length > 0 && <section className="border-t border-hairline border-b-0 border-x-0 border-solid border-zinc-200 pt-4"><h3 className={`${labelClass} mb-2`}>Palm chart · pounds per palm</h3>
      <dl className="grid grid-cols-4 gap-y-3 text-center">{guide.palmChart.map(row => <div key={row.width}><dt className="text-ink-secondary">{row.width} ft</dt><dd className="font-medium tabular-nums">{row.lb.toFixed(1)} lb</dd></div>)}</dl>
      <p className="mt-3 text-ink-secondary">Canopy width² ÷ 105, rounded down. Weigh each palm’s amount and spread under the canopy.</p>
    </section>}
    {safetyRules.length > 0 && <section aria-label="Program safety rules" className="mt-5 border-t border-hairline border-b-0 border-x-0 border-solid border-zinc-200 pt-4">
      <h3 className={`${labelClass} mb-2`}>Safety</h3>
      <ul className="space-y-1 list-disc pl-5">{safetyRules.map(rule => <li key={rule}>{rule}</li>)}</ul>
    </section>}
  </div>;
}

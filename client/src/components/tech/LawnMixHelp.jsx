// client/src/components/tech/LawnMixHelp.jsx
//
// Mix help of the lawn Fast Complete sheet (GATE_LAWN_MIX_HELP, owner 2026-10-09): the amount of product for a full tank of a spot spray
// (the server does the arithmetic and sends it as words), the tank size chips (remembered on this device), and "Gallons sprayed" typed
// in place of the area. Technician surface only; nothing here reaches a customer.
import React, { useCallback, useId, useState } from 'react';
import { Input } from '../ui';
import { Chip } from './FastCompleteParts';
import {
  carrierOf, gallonsToArea, mixEntryFor, mixLine, rememberTank, rememberedTank, weedCarrier, weedMixLines,
} from '../../lib/lawn-mix-help';

/** The sheet's mix state: the block, the shared tank size, and the weed entry's shared gallons. */
export function useMixHelp(help, operatorId) {
  const [tank, setTankState] = useState(() => (help ? rememberedTank(operatorId, help.tanks) : null));
  const [weedGallons, setWeedGallons] = useState('');
  const setTank = useCallback((next) => { setTankState(next); rememberTank(operatorId, next); }, [operatorId]);
  return { help, tank, setTank, weedGallons, setWeedGallons };
}

function TankChips({ mix, label, locked }) {
  return (
    <div role="group" aria-label={`${label} tank size`} className="tech-visit-tile-grid">
      {mix.help.tanks.map((size) => (
        <Chip key={size} disabled={locked} label={`${size} gal`} pressed={mix.tank === size} onClick={() => mix.setTank(size)} />
      ))}
    </div>
  );
}

function MixText({ line, note = null }) {
  if (!line && !note) return null;
  return (
    <>
      {line && <p className="tech-visit-muted" role="status">{[line.text, line.covers].filter(Boolean).join(' ')}</p>}
      {note && <p className="tech-visit-muted" role="status">{note}</p>}
    </>
  );
}

// "Gallons sprayed", typed in place of the area: the area is figured from the gallons (shown), and /complete records it.
function GallonsControl({ title, value, carrier, locked, onChange }) {
  const inputId = useId();
  const area = gallonsToArea(value, carrier);
  return (
    <div className="tech-spot-area">
      <label htmlFor={inputId} className="tech-product-editor-label">{`Gallons sprayed (instead of the area)${title ? `, ${title}` : ''}`}</label>
      <Input
        id={inputId}
        className="tech-visit-control tech-product-amount-input"
        type="number"
        inputMode="decimal"
        min="0"
        step="any"
        disabled={locked}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      />
      {area && <p className="tech-visit-muted" role="status">{`About ${area.toLocaleString('en-US')} sq ft at ${carrier} gal per 1,000 sq ft.`}</p>}
    </div>
  );
}

/** Under a plain spot row's area: the full-tank amount for the row, and the gallons entry. Renders nothing when the server sent no entry. */
export function RowMixHelp({ row, mix, locked, onChange }) {
  const entry = mix?.help && row.spotRule && !row.weedGroup ? mixEntryFor(mix.help, row.productId) : null;
  if (!entry) return null;
  const carrier = carrierOf(mix.help, row.productId);
  return (
    <div role="group" aria-label={`Mix for ${row.name}`} className="tech-spot-area">
      <p className="tech-product-editor-label">Mix for a full tank</p>
      <TankChips mix={mix} label={row.name} locked={locked} />
      <MixText line={mixLine(entry, mix.tank)} note={entry.perTank ? null : entry.note} />
      {carrier && !row.spotExempt && (
        <GallonsControl title={row.name} value={row.spotGallons} carrier={carrier} locked={locked} onChange={(value) => onChange({ spotGallons: value, spotSqft: value ? '' : row.spotSqft })} />
      )}
    </div>
  );
}

/**
 * Inside the Weed spots card: the amount of each weed product on the sheet for the chosen tank (the surfactant by the existing 90 F rule),
 * the mixing order when the catalog states one for every product, the Celsius label's tank lines, and the gallons entry.
 * `rows` are the weed-mix rows on the sheet; `surfactant` is the weed decision's `{ included, note }`; `onWeedArea` clears the typed area.
 */
export function WeedMixHelp({ mix, rows, surfactant, locked, onWeedArea }) {
  if (!mix?.help || !rows.length) return null;
  const { lines, order, labelLines } = weedMixLines(mix.help, rows, mix.tank);
  const carrier = weedCarrier(mix.help, rows);
  if (!lines.length && !carrier) return null;
  return (
    <div role="group" aria-label="Mix for Weed spots" className="tech-spot-area">
      <p className="tech-product-editor-label">Mix for a full tank</p>
      <TankChips mix={mix} label="Weed spots" locked={locked} />
      {lines.map((entry) => <MixText key={entry.id} line={entry.line && { ...entry.line, text: `${entry.name}, ${entry.line.text}` }} note={entry.note && `${entry.name}: ${entry.note}`} />)}
      {surfactant && surfactant.included === false && surfactant.note && <p className="tech-visit-muted" role="status">{surfactant.note}</p>}
      {order && <p className="tech-visit-muted" role="status">{`Mixing order: ${order.join(', ')}.`}</p>}
      {labelLines.map((line) => <p key={line.source} className="tech-visit-muted">{`${line.source}: ${line.text}`}</p>)}
      {carrier && (
        <GallonsControl
          title="Weed spots"
          value={mix.weedGallons}
          carrier={carrier}
          locked={locked}
          onChange={(value) => { mix.setWeedGallons(value); if (value) onWeedArea(''); }}
        />
      )}
    </div>
  );
}

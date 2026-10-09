// client/src/components/tech/LawnSodParts.jsx
//
// The new-sod parts of the lawn Fast Complete sheet (GATE_LAWN_NEW_SOD_NOTE, owner 2026-10-09):
//  - SodBanner: the top of the sheet. "New sod, day N. Laid <date>." with whole lawn or the named
//    part, the held classes in one line, the large patch note, and (once the weed killer hold has
//    passed its 30 days) the technician's "Sod mowed twice and does not lift" tick.
//  - HeldLines: the planned lines the holds keep off the sheet, greyed with their reason. The
//    technician can still add one by hand (warn first, but allow).
// The server decides every rule and every word (lib/lawn-sod-sheet.js reads them); this file only
// renders them and performs the two taps.
import React, { useId, useState } from 'react';
import { Button, ActionFeedback } from '../ui';

const lowerId = (id) => String(id ?? '').toLowerCase();

export function SodBanner({ newSod, onRooted, locked = false }) {
  const tickId = useId();
  const [tick, setTick] = useState({ busy: false, error: '' });
  if (!newSod) return null;
  if (newSod.unavailable) {
    return <p className="tech-sod-banner tech-visit-status--warn" role="status">{newSod.message}</p>;
  }
  const confirm = async (event) => {
    if (!event.target.checked || tick.busy) return;
    setTick({ busy: true, error: '' });
    try {
      await onRooted(newSod.rooted.sodLaidOn);
      setTick({ busy: false, error: '' });
    } catch (err) {
      setTick({ busy: false, error: err?.message || 'Could not save that. Try again.' });
    }
  };
  return (
    <section className="tech-sod-banner" aria-label="New sod">
      <p className="tech-sod-banner-title">{`${newSod.headline} ${newSod.where}`}</p>
      {newSod.heldLine && <p className="tech-visit-muted">{newSod.heldLine}</p>}
      {newSod.largePatch && <p className="tech-visit-muted">{newSod.largePatch}</p>}
      {newSod.rooted && (
        <div className="tech-sod-tick">
          <input id={tickId} type="checkbox" checked={tick.busy} disabled={locked || tick.busy} onChange={confirm} />
          <label htmlFor={tickId}>{newSod.rooted.label}</label>
        </div>
      )}
      {tick.error && <ActionFeedback error className="tech-visit-feedback">{tick.error}</ActionFeedback>}
    </section>
  );
}

// The catalog product a plan-shaped item stands for (a product the catalog does not list still opens, from the item's name).
const productFor = (item, catalog) => (catalog || []).find((product) => lowerId(product.id) === lowerId(item.productId)) || { id: item.productId, name: item.name || 'Product' };

export function HeldLines({ items, newSod, rows, catalog, locked, onAdd }) {
  const titleId = useId();
  if (!items.length) return null;
  const on = new Set(rows.map((row) => lowerId(row.productId)));
  return (
    <div className="tech-protocol-addons tech-sod-held" role="group" aria-labelledby={titleId}>
      <div className="tech-protocol-addons-head">
        <h4 id={titleId} className="tech-protocol-addons-title">Held for new sod</h4>
        <p className="tech-visit-muted">Not on the sheet. Add one only if you applied it.</p>
      </div>
      {items.map((item) => {
        const onSheet = on.has(lowerId(item.productId));
        const name = productFor(item, catalog).name;
        return (
          <div key={item.productId} className="tech-protocol-addon tech-sod-held-line">
            <span className="tech-protocol-addon-text">
              <span className="tech-protocol-addon-name">{name}</span>
              <span className="tech-visit-muted">{onSheet ? 'On the sheet' : newSod.lines[lowerId(item.productId)]?.reason}</span>
            </span>
            <Button
              type="button"
              variant="secondary"
              className="tech-visit-action tech-protocol-addon-add"
              aria-label={onSheet ? `${name} is on the sheet` : `Add ${name} anyway`}
              disabled={locked || onSheet}
              onClick={() => onAdd(productFor(item, catalog), { planned: item })}
            >
              {onSheet ? '✓' : 'Add anyway'}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

// client/src/components/tech/LawnSpotTarget.jsx
//
// The target of a spot fungicide or insecticide row (owner 2026-10-09). One small closed choice, optional, never blocking Complete:
// it tells the report what the spot was for, so "What to expect" reads as treating a problem rather than as protection. A row opened
// by a chinch find shows a line instead (the target is stored with no tap). The server sends the lists and checks the tag
// (lib/lawn-spot-target.js, services/lawn-spot-target.js). Technician surface only.
import React from 'react';
import { Chip } from './FastCompleteParts';
import { spotTargetOffer } from '../../lib/lawn-spot-target';

/** `config`: the context's spotTargets; `chinch`: the chinch decision; `takeAll`: the guide's take-all ids (a Set). Renders nothing when the row has no offer. */
export default function SpotTargetControl({ row, config, chinch, takeAll, locked, onChange }) {
  const offer = spotTargetOffer(row, { config, chinch, takeAll });
  if (!offer) return null;
  if (offer.kind === 'auto') {
    return <p className="tech-visit-muted" role="status">{`Recorded for: ${offer.target}.`}</p>;
  }
  return (
    <div role="group" aria-label={`Treating, ${row.name}`} className="tech-spot-area">
      <p className="tech-product-editor-label">Treating (optional)</p>
      <div className="tech-visit-tile-grid">
        {offer.choices.map((name) => (
          <Chip key={name} disabled={locked} label={name} pressed={row.spotTarget === name} onClick={() => onChange({ spotTarget: row.spotTarget === name ? '' : name })} />
        ))}
      </div>
    </div>
  );
}

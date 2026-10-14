// client/src/components/tech/LawnSpotPlace.jsx
//
// The place of a spot treatment and the lawn's known trouble areas, for the lawn Fast Complete sheet
// (GATE_LAWN_TROUBLE_AREAS, owner 2026-10-09). The server decides every word and every closed place
// (lib/lawn-trouble-places.js reads it); this file renders:
//   - PlaceControl         "Where" with one chip per place of the closed list, under a spot row's area. A place
//                          the yearly limits close for the row is off, with the limit's own words under the chips.
//   - PlaceAddButtons      the place buttons of a one-tap entry (Weed spots, Chinch bugs found): the tap names the
//                          place and adds what that place takes, so the place costs no extra tap there.
//   - KnownTroubleAreas    a compact line above the guide cards: place, type, last treated date; Clear asks once.
// Technician surface only.
import React, { useId, useState } from 'react';
import { Button } from '../ui';
import { Chip } from './FastCompleteParts';
import { knownPlacesOfType, troubleTypeOfRow } from '../../lib/lawn-trouble-places';

// The reason line under a row's chips: why a place is off, or that the place came from a known trouble area.
function placeNote(row) {
  if (row.placeNowhere) return `${row.name} cannot go anywhere on this lawn right now. ${row.placeNowhere}`;
  if (row.placeBlock) return row.placeBlock;
  if (row.placeUnreadable) return 'The limits could not be checked for this place. Record what you applied; the office will review it.';
  if (row.placeDefaulted) return 'Set from the known trouble area. Tap another place to change it.';
  return null;
}

/** "Where on the lawn": one tap among the closed list. `onChange(placeId)`. */
export function PlaceControl({ areas, row, title = null, locked, onChange }) {
  const known = knownPlacesOfType(areas, troubleTypeOfRow(row));
  const note = placeNote(row);
  return (
    <div role="group" aria-label={title ? `${title} place` : `Place for ${row.name}`} className="tech-spot-area">
      <p className="tech-product-editor-label">Where on the lawn</p>
      <div className="tech-visit-tile-grid">
        {areas.places.map((place) => (
          <Chip
            key={place.id}
            disabled={locked || !!row.placeProblems?.[place.id]}
            label={known.has(place.id) ? `${place.label} · known` : place.label}
            pressed={row.place === place.id}
            onClick={() => onChange(place.id)}
          />
        ))}
      </div>
      {note && <p className="tech-visit-muted" role="status">{note}</p>}
    </div>
  );
}

/**
 * The place buttons of an entry that adds products in one tap. `choices` are the places the entry can add for
 * (`{ id, label, known }`); `onPick(placeId)` adds what that place takes and sets the place. An entry with no choice
 * left renders nothing (its line says why).
 */
export function PlaceAddButtons({ choices, locked, ariaPrefix, onPick }) {
  if (!choices.length) return null;
  return (
    <span className="tech-guide-actions" role="group" aria-label={`${ariaPrefix} place`}>
      {choices.map((choice) => (
        <Button
          key={choice.id}
          type="button"
          variant="secondary"
          className="tech-visit-action tech-protocol-addon-add"
          aria-label={`${ariaPrefix}: ${choice.label}`}
          disabled={locked}
          onClick={() => onPick(choice.id)}
        >
          {choice.known ? `${choice.label} · known` : choice.label}
        </Button>
      ))}
    </span>
  );
}

const dateLabel = (day) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day || ''));
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

/**
 * "Known trouble areas": one line each, above the guide cards. Clear is one tap and one confirm; the server clears it
 * for the lawn (every technician sees it gone). `clear(id)` rejects when the server refuses; nothing changes then.
 */
export function KnownTroubleAreas({ known, unavailable = false, locked, clear }) {
  const headId = useId();
  const [confirming, setConfirming] = useState(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!known.length && !unavailable) return null;
  const confirmClear = async (area) => {
    setBusy(true);
    setFailed(false);
    try {
      await clear(area.id);
      setConfirming(null);
    } catch {
      setFailed(true);
    }
    setBusy(false);
  };
  return (
    <div className="tech-protocol-addons" role="group" aria-labelledby={headId}>
      <div className="tech-protocol-addons-head">
        <h4 id={headId} className="tech-protocol-addons-title">Known trouble areas</h4>
      </div>
      {unavailable && !known.length && <p className="tech-visit-muted" role="status">The known trouble areas could not be loaded.</p>}
      {known.map((area) => {
        const treated = dateLabel(area.lastTreatedOn);
        const name = `${area.placeLabel}, ${area.typeLabel.toLowerCase()}`;
        return (
          <div key={area.id} className="tech-protocol-addon">
            <span className="tech-protocol-addon-text">
              <span className="tech-protocol-addon-name">{`${area.placeLabel} · ${area.typeLabel}`}</span>
              {treated && <span className="tech-visit-muted">{`Last treated ${treated}`}</span>}
              {confirming === area.id && <span className="tech-visit-muted" role="status">{failed ? 'Could not clear it. Try again.' : `Clear ${name}?`}</span>}
            </span>
            {confirming === area.id ? (
              <span className="tech-guide-actions">
                <Button type="button" variant="secondary" className="tech-visit-action tech-protocol-addon-add" disabled={locked || busy} aria-label={`Confirm clear ${name}`} onClick={() => confirmClear(area)}>Clear it</Button>
                <Button type="button" variant="secondary" className="tech-visit-action tech-protocol-addon-add" disabled={busy} onClick={() => { setConfirming(null); setFailed(false); }}>Keep</Button>
              </span>
            ) : (
              <Button type="button" variant="secondary" className="tech-visit-action tech-protocol-addon-add" disabled={locked} aria-label={`Clear ${name}`} onClick={() => { setConfirming(area.id); setFailed(false); }}>Clear</Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

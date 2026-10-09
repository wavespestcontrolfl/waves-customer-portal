import React, { useEffect, useState } from "react";
import { Checkbox, Field, Input, Select } from "../ui";
import {
  LARGER_TIER,
  SAME_VISIT,
  STANDALONE_VISIT,
  countAreaAddOns,
  isAreaAddOnPricedPerApplication,
  knownAreaFor,
  newAddOnEntry,
  reseedAddOnEntries,
  tierSelectValue,
  withTierChoice,
} from "../../lib/areaAddOns";

// "Add-on treatments" on the staff estimator (GATE_AREA_ADDONS). Tier 1 admin
// style: ui primitives plus the zinc ramp, like the dethatching and top
// dressing blocks beside it. The catalog (names, tiers, limits) comes from the
// server; this component never names a price. Selections live in the estimate
// form (`value`, see lib/areaAddOns.js) and every change goes out through
// `onChange`, so the screen's own invalidation runs. A grass-bound add-on
// (catalog `requiresGrassTrack`) carries its own required grass choice with no
// default; `grassChoices` is the grass list the screen already offers and
// `pickedGrass` a grass the rep chose on the screen (null while untouched).
// The visit is ONE choice for the whole group (`visit` / `onVisitChange`):
// several add-ons are a single visit and carry one drive.

const PANEL = "ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200";
const NOTE = "text-14 text-ink-secondary";
const GRASS_NAMES = { st_augustine: "St. Augustine" };

function areaFieldLabel(item) {
  const label = item.areaLabel ? item.areaLabel.charAt(0).toUpperCase() + item.areaLabel.slice(1) : "Treated";
  return `${label} area`;
}

function rowNotes(item, entry) {
  const notes = [];
  if (item.limitText) notes.push(`Limit: ${item.limitText}`);
  if (item.requiresGrassTrack) {
    notes.push(`${GRASS_NAMES[item.requiresGrassTrack] || "One grass"} only. Other grass becomes a manual quote.`);
    if (!entry.grassType) notes.push("Choose the grass to price this. Until then it is a manual quote.");
  }
  if (item.key === "hardscape_weed") {
    notes.push("Hard surfaces and bare ground only. Keep off lawn, beds and root zones.");
  }
  return notes;
}

function AreaFields({ item, entry, known, onEntry }) {
  const choice = tierSelectValue(item, entry);
  const largest = item.tiers[item.tiers.length - 1];
  const idBase = `estimate-areaAddOn-${item.key}`;
  return (
    <>
      <Field label={areaFieldLabel(item)} id={`${idBase}-tier`} className="mb-4">
        <Select value={choice} onChange={(e) => onEntry(withTierChoice(item, entry, e.target.value, known))}>
          {choice === "" && <option value="">Choose an area</option>}
          {item.tiers.map((tier) => (
            <option key={tier} value={String(tier)}>Up to {tier.toLocaleString("en-US")} sq ft</option>
          ))}
          <option value={LARGER_TIER}>Larger: manual quote</option>
        </Select>
      </Field>
      {choice === LARGER_TIER && (
        <Field
          label={`${areaFieldLabel(item)} (sq ft)`}
          id={`${idBase}-area`}
          help={`Enter the real area. Over ${largest.toLocaleString("en-US")} sq ft is a manual quote.`}
          className="mb-4"
        >
          <Input type="number" min="1" value={entry.areaSqFt ?? ""} onChange={(e) => onEntry({ ...entry, areaSqFt: e.target.value })} />
        </Field>
      )}
    </>
  );
}

// A grass-bound add-on's own grass: no default, required. The estimate's grass
// is never used for it; a grass the rep already chose on this screen can start
// the row, and the help line says so.
function GrassField({ item, entry, grassChoices, pickedGrass, onEntry }) {
  const chosen = entry.grassType || "";
  return (
    <Field
      label="Grass"
      id={`estimate-areaAddOn-${item.key}-grass`}
      required
      help={chosen && chosen === pickedGrass ? "From the Grass Type / Track box on this screen. Change it here if the grass differs." : undefined}
      className="mb-4"
    >
      <Select value={chosen} onChange={(e) => onEntry({ ...entry, grassType: e.target.value })}>
        {chosen === "" && <option value="">Choose the grass</option>}
        {grassChoices.map((grass) => <option key={grass.value} value={grass.value}>{grass.label}</option>)}
      </Select>
    </Field>
  );
}

// The one visit choice for every selected add-on. Same visit needs a ONE-TIME
// service on this estimate to ride with (the one-time accept books the add-ons;
// a recurring plan cannot host them yet); an add-on is never that service.
function VisitField({ visit, oneTimeHostSelected, onVisitChange }) {
  const same = visit === SAME_VISIT;
  return (
    <Field
      label="Visit"
      id="estimate-areaAddOns-visit"
      help={same && !oneTimeHostSelected ? "Same visit needs a one-time service on this estimate. Sell the add-on on its own visit, or on its own estimate." : "All selected add-ons share this visit."}
      className="mb-4"
    >
      <Select value={same ? SAME_VISIT : STANDALONE_VISIT} onChange={(e) => onVisitChange(e.target.value)}>
        <option value={STANDALONE_VISIT}>Own visit</option>
        <option value={SAME_VISIT}>Same visit as a one-time service on this estimate</option>
      </Select>
    </Field>
  );
}

function SelectedPanel({ item, entry, known, grassChoices, pickedGrass, onEntry }) {
  return (
    <div className={PANEL}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {item.tiers && <AreaFields item={item} entry={entry} known={known} onEntry={onEntry} />}
        {item.requiresGrassTrack && <GrassField item={item} entry={entry} grassChoices={grassChoices} pickedGrass={pickedGrass} onEntry={onEntry} />}
      </div>
      {known && <div className={NOTE}>{known.source}: about {known.sqft.toLocaleString("en-US")} sq ft {known.noun}. {known.advice}</div>}
      {rowNotes(item, entry).map((note) => <div key={note} className={NOTE}>{note}</div>)}
    </div>
  );
}

function OfferedRow({ item, entry, knownAreas, grassChoices, pickedGrass, value, onChange }) {
  const known = knownAreaFor(item.key, knownAreas);
  return (
    <div>
      <div className="mb-1">
        <Checkbox
          id={`estimate-areaAddOn-${item.key}`}
          label={item.name}
          checked={!!entry}
          onChange={(e) => {
            const next = { ...value };
            if (e.target.checked) next[item.key] = newAddOnEntry(item, known, pickedGrass);
            else delete next[item.key];
            onChange(next);
          }}
        />
      </div>
      {entry && (
        <SelectedPanel
          item={item}
          entry={entry}
          known={known}
          grassChoices={grassChoices}
          pickedGrass={pickedGrass}
          onEntry={(nextEntry) => onChange({ ...value, [item.key]: nextEntry })}
        />
      )}
    </div>
  );
}

// A selection the screen can no longer offer (the gate is off, or the server
// dropped the add-on). It stays visible so a saved estimate does not lose it
// silently; the rep unchecks it to go on.
function UnavailableRow({ addOnKey, name, enabled, value, onChange }) {
  return (
    <div>
      <div className="mb-1">
        <Checkbox
          id={`estimate-areaAddOn-${addOnKey}`}
          label={name}
          checked
          onChange={() => {
            const next = { ...value };
            delete next[addOnKey];
            onChange(next);
          }}
        />
      </div>
      <div className={`${PANEL} ${NOTE}`}>
        {enabled
          ? "This add-on is no longer offered. Uncheck it to calculate."
          : "Add-on treatments are currently unavailable. Uncheck this one to calculate."}
      </div>
    </div>
  );
}

// The known areas change when a property lookup reruns: an entry still on the
// tier it was pre-filled with follows the new area, so it never keeps the old
// property's tier beside a hint that shows the new one.
function useReseededEntries(selection, catalog, knownAreas, onChange) {
  const bedKnown = knownAreas?.bed?.sqft ?? null;
  const lawnKnown = knownAreas?.lawn?.sqft ?? null;
  useEffect(() => {
    const next = reseedAddOnEntries(selection, catalog, knownAreas);
    if (next !== selection) onChange(next);
  }, [bedKnown, lawnKnown]);
}

export default function AreaAddOnsGroup({
  catalog, value, onChange, visit = STANDALONE_VISIT, onVisitChange, knownAreas, grassChoices, pickedGrass = null, oneTimeHostSelected,
}) {
  const [userOpen, setUserOpen] = useState(null);
  const selection = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  useReseededEntries(selection, catalog, knownAreas, onChange);
  const count = countAreaAddOns(selection);
  const offered = catalog?.enabled ? catalog.items : [];
  if (offered.length === 0 && count === 0) return null;
  const expanded = userOpen ?? count > 0;
  const names = new Map((catalog?.items || []).map((item) => [item.key, item.name]));
  const offeredKeys = new Set(offered.map((item) => item.key));
  const unavailableKeys = Object.keys(selection).filter((key) => !offeredKeys.has(key));
  return (
    <div data-testid="area-addons-group">
      <div className="mt-3 mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h4 className="text-16 font-medium text-zinc-900 m-0">Add-on treatments</h4>
        {count > 0 && <span className={NOTE}>{count} selected</span>}
        <button
          data-ui-text-action
          type="button"
          aria-expanded={expanded}
          onClick={() => setUserOpen(!expanded)}
          className="text-14 underline cursor-pointer"
        >
          {expanded ? "Hide" : "Show"}
        </button>
      </div>
      {expanded && (
        <>
          <div className={`${NOTE} mb-2`}>Sold on their own visit or with another service.</div>
          {offered.map((item) => (
            <OfferedRow
              key={item.key}
              item={item}
              entry={selection[item.key]}
              knownAreas={knownAreas}
              grassChoices={grassChoices}
              pickedGrass={pickedGrass}
              value={selection}
              onChange={onChange}
            />
          ))}
          {count > 0 && offered.length > 0 && <VisitField visit={visit} oneTimeHostSelected={oneTimeHostSelected} onVisitChange={onVisitChange} />}
          {unavailableKeys.map((key) => (
            <UnavailableRow
              key={key}
              addOnKey={key}
              name={names.get(key) || key}
              enabled={!!catalog?.enabled}
              value={selection}
              onChange={onChange}
            />
          ))}
        </>
      )}
    </div>
  );
}

// The price cell of a one-time row on the estimate preview: an add-on's price is one application, so
// it carries the unit under it ("per application"); every other row shows the amount alone.
export function PerApplicationPrice({ item, amount }) {
  if (!isAreaAddOnPricedPerApplication(item)) return amount;
  return (
    <>
      {amount}
      <span className="block text-14 font-normal text-ink-secondary">per application</span>
    </>
  );
}

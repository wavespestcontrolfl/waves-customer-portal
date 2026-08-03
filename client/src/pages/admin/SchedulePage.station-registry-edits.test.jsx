import { describe, expect, it } from "vitest";

import { pendingStationEdits, reconcileNewPinsWithRegistry } from "./SchedulePage.jsx";

// Pre-push P0 on the #3159 lane: while the station registry is loading or
// failed, the completion payload posts no station entries — but a
// billing-detour draft can restore pins, moves, statuses, and retirements,
// and a successful submit clears the draft they came from. handleSubmit
// blocks on pendingStationEdits in that state; each of the four edit kinds
// must trip it on its own, or that kind is silently deletable.
describe("pendingStationEdits — every restored edit kind blocks a station-less completion", () => {
  const none = { stationNew: [], stationMoves: {}, stationStatuses: {}, stationRetired: [] };

  it("no edits → nothing pending (completion proceeds station-less)", () => {
    expect(pendingStationEdits(none)).toBe(false);
  });

  it("each edit kind is pending on its own", () => {
    expect(pendingStationEdits({
      ...none,
      stationNew: [{ key: "new-1", number: 9, shape: { lat: 27.3, lng: -82.5 } }],
    })).toBe(true);
    expect(pendingStationEdits({
      ...none,
      stationMoves: { "st-1": { lat: 27.3, lng: -82.5 } },
    })).toBe(true);
    expect(pendingStationEdits({ ...none, stationStatuses: { "st-1": "damaged" } })).toBe(true);
    expect(pendingStationEdits({ ...none, stationRetired: ["st-1"] })).toBe(true);
  });
});

// Round 18 (codex P1): the server dedupes an id-less create landing on an
// existing row's exact position and attaches its check to the EXISTING
// station — so a restored draft pin colliding with a row confirmed after
// the draft was saved must not display or count as a second trap. The
// reconcile drops the pin and transfers its status to the existing row,
// mirroring the server outcome.
describe("reconcileNewPinsWithRegistry — restored creates vs the confirmed roster", () => {
  const pin = (key, cx, cy) => ({ key, number: 9, shape: { type: "circle", cx, cy, r: 0.02 } });
  const row = (id, cx, cy) => ({ id, number: 1, shape: { type: "circle", cx, cy, r: 0.02 } });

  it("keeps non-colliding pins untouched (changed=false, same references)", () => {
    const stationNew = [pin("new-1", 0.25, 0.25)];
    const stationStatuses = { "new-1": "activity" };
    const out = reconcileNewPinsWithRegistry({
      stationNew,
      stationPreloads: [row("st-1", 0.75, 0.75)],
      stationStatuses,
    });
    expect(out.changed).toBe(false);
    expect(out.stationNew).toBe(stationNew);
    expect(out.stationStatuses).toBe(stationStatuses);
  });

  it("drops a colliding pin and transfers its status to the existing row", () => {
    const out = reconcileNewPinsWithRegistry({
      stationNew: [pin("new-1", 0.5, 0.5), pin("new-2", 0.1, 0.1)],
      stationPreloads: [row("st-1", 0.5, 0.5)],
      stationStatuses: { "new-1": "activity" },
    });
    expect(out.changed).toBe(true);
    expect(out.stationNew.map((p) => p.key)).toEqual(["new-2"]);
    expect(out.stationStatuses).toEqual({ "st-1": "activity" });
  });

  it("never overwrites a status the existing row already carries", () => {
    const out = reconcileNewPinsWithRegistry({
      stationNew: [pin("new-1", 0.5, 0.5)],
      stationPreloads: [row("st-1", 0.5, 0.5)],
      stationStatuses: { "new-1": "activity", "st-1": "ok" },
    });
    expect(out.stationStatuses).toEqual({ "st-1": "ok" });
  });

  it("a pin without a shape is kept, never treated as colliding", () => {
    const shapeless = { key: "new-3", number: 11, shape: null };
    const out = reconcileNewPinsWithRegistry({
      stationNew: [shapeless],
      stationPreloads: [row("st-1", 0.5, 0.5)],
      stationStatuses: {},
    });
    expect(out.changed).toBe(false);
    expect(out.stationNew).toEqual([shapeless]);
  });
});

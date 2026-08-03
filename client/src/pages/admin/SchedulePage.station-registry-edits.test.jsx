import { describe, expect, it } from "vitest";

import { pendingStationEdits } from "./SchedulePage.jsx";

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

// The note's station read as a state machine (lib/station-read-state.js).
import { describe, expect, it } from "vitest";
import { INITIAL_READ_STATE, READ_VIEW, readStatusFor, stationReadReducer, stationSummary } from "./station-read-state";

const run = (...events) => events.reduce((state, event) => stationReadReducer(state, event), INITIAL_READ_STATE);
const N = "station 2 had activity";

describe("readStatusFor", () => {
  it("is none before any read, reading while one is in flight, failed after a failure, ok after a success", () => {
    expect(readStatusFor(INITIAL_READ_STATE, N)).toBe("none");
    expect(readStatusFor(run({ type: "readStarted", note: N }), N)).toBe("reading");
    expect(readStatusFor(run({ type: "readStarted", note: N }, { type: "readFailed", note: N }), N)).toBe("failed");
    expect(readStatusFor(run({ type: "readStarted", note: N }, { type: "readSucceeded", note: N }), N)).toBe("ok");
  });

  it("a changed note is not read yet; the text that was read is read again", () => {
    const ok = run({ type: "readSucceeded", note: N });
    expect(readStatusFor(ok, `${N}. And station 3.`)).toBe("none");
    expect(readStatusFor(ok, `  ${N}  `)).toBe("ok");
  });

  it("a read in flight or failed for other text says nothing about this note", () => {
    const state = run({ type: "readStarted", note: "old" }, { type: "readFailed", note: "old" });
    expect(readStatusFor(state, N)).toBe("none");
  });

  it("the last successful read for a note survives a refresh in flight and a refresh that fails", () => {
    const ok = run({ type: "readSucceeded", note: N });
    expect(readStatusFor(stationReadReducer(ok, { type: "readStarted", note: N }), N)).toBe("ok");
    expect(readStatusFor(stationReadReducer(stationReadReducer(ok, { type: "readStarted", note: N }), { type: "readFailed", note: N }), N)).toBe("ok");
  });

  it("retains exactly one successful read: the note whose marks are on the sheet", () => {
    const state = run({ type: "readSucceeded", note: "a" }, { type: "readSucceeded", note: "b" });
    expect([readStatusFor(state, "a"), readStatusFor(state, "b"), readStatusFor(state, "c")]).toEqual(["none", "ok", "none"]);
  });

  it("A read, B read, back to A with a failing refresh: A is failed, never retained", () => {
    const state = run(
      { type: "readSucceeded", note: "a" }, { type: "readSucceeded", note: "b" },
      { type: "noteChanged", note: "a" }, { type: "readStarted", note: "a" }, { type: "readFailed", note: "a" },
    );
    expect(readStatusFor(state, "a")).toBe("failed");
  });

  it("the hand check stands whatever the note says, until it is cleared", () => {
    const hand = run({ type: "handConfirmed" });
    expect(readStatusFor(hand, N)).toBe("hand");
    expect(readStatusFor(stationReadReducer(hand, { type: "handCleared" }), N)).toBe("none");
  });

  it("a roster that changed clears every read and the hand check", () => {
    const state = run({ type: "readSucceeded", note: N }, { type: "handConfirmed" }, { type: "rosterChanged" });
    expect(state).toEqual(INITIAL_READ_STATE);
  });

  it("noteChanged drops an attempt made for other text and keeps the reads", () => {
    const state = run({ type: "readSucceeded", note: "a" }, { type: "readFailed", note: "b" });
    const changed = stationReadReducer(state, { type: "noteChanged", note: "c" });
    expect(changed.attempt).toBeNull();
    expect(readStatusFor(changed, "a")).toBe("ok");
    expect(stationReadReducer(state, { type: "noteChanged", note: "b" })).toBe(state);
  });

  it("ignores an event it does not know", () => {
    expect(stationReadReducer(INITIAL_READ_STATE, { type: "nope" })).toBe(INITIAL_READ_STATE);
  });
});

describe("the card's table", () => {
  const ctx = { registryState: "ready", hold: "", count: 4, flagged: 0 };
  it("says all OK only when the stations are known", () => {
    for (const status of Object.keys(READ_VIEW)) {
      const text = stationSummary({ ...ctx, readStatus: status });
      expect(/all OK/.test(text)).toBe(READ_VIEW[status].known);
    }
  });

  it("names the flagged count when stations are known, the registry hold first, loading before all", () => {
    expect(stationSummary({ ...ctx, readStatus: "ok", flagged: 2 })).toBe("4 stations, 2 flagged, the rest OK");
    expect(stationSummary({ ...ctx, readStatus: "hand", flagged: 1 })).toBe("4 stations, checked by hand, 1 flagged, the rest OK");
    expect(stationSummary({ ...ctx, readStatus: "ok", hold: "No stations are on record. Use the Full form." })).toMatch(/Full form/);
    expect(stationSummary({ ...ctx, readStatus: "ok", registryState: "loading", hold: "x" })).toBe("Loading the stations…");
  });

  it("holds Complete in every state that is not known, and in none that is", () => {
    for (const [status, view] of Object.entries(READ_VIEW)) expect(Boolean(view.hold)).toBe(!view.known && status !== "hand");
  });

  it("offers the hand check where the read did not succeed, and its undo only after it", () => {
    expect(["none", "reading", "failed", "ok", "hand"].map((s) => READ_VIEW[s].handButton)).toEqual([true, false, true, false, false]);
    expect(["none", "reading", "failed", "ok", "hand"].map((s) => READ_VIEW[s].undoButton)).toEqual([false, false, false, false, true]);
  });
});

describe("an unresolved read", () => {
  it("is its own status: not known, held, offering the hand check, and the card opens", () => {
    const state = run({ type: "readStarted", note: N }, { type: "readFailed", note: N, detail: "unresolved" });
    expect(readStatusFor(state, N)).toBe("unresolved");
    expect(READ_VIEW.unresolved).toMatchObject({ known: false, handButton: true, opensCard: true });
    expect(READ_VIEW.unresolved.hold).toMatch(/Couldn’t match everything you said about the stations/);
    expect(stationSummary({ registryState: "ready", hold: "", readStatus: "unresolved", count: 4, flagged: 1 })).toBe("4 stations. Couldn’t match everything you said about them.");
  });

  it("a later clean read of the same note replaces it", () => {
    const state = run({ type: "readFailed", note: N, detail: "unresolved" }, { type: "readSucceeded", note: N });
    expect(readStatusFor(state, N)).toBe("ok");
  });
});

describe("an unresolved refresh of a note already read", () => {
  it("withdraws the earlier read: the stations are no longer known", () => {
    const state = run({ type: "readSucceeded", note: N }, { type: "readStarted", note: N }, { type: "readFailed", note: N, detail: "unresolved" });
    expect(readStatusFor(state, N)).toBe("unresolved");
    // A plain failure does not.
    const kept = run({ type: "readSucceeded", note: N }, { type: "readFailed", note: N });
    expect(readStatusFor(kept, N)).toBe("ok");
  });
});

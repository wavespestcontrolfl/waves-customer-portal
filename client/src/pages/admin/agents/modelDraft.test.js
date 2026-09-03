import { describe, expect, it } from "vitest";
import { UNPIN, buildMigrationSet, computeChanges, effectiveLegFor, envBlockOf, modelsInUse, selectorDraftFor } from "./modelDraft";
import { CATALOG, makeData } from "./modelDraft.fixture";

const resolve = (data, draft) => {
  const byKey = Object.fromEntries(data.selectors.map((s) => [s.key, s]));
  const selectorDraft = selectorDraftFor(byKey, draft);
  return { selectorDraft, effectiveLeg: effectiveLegFor(draft, selectorDraft) };
};

describe("computeChanges", () => {
  it("a selector draft is one change that lists every unpinned follower, flagging locked and unchecked lanes", () => {
    const data = makeData();
    const draft = { MODEL_FLAGSHIP: "m2" };
    const { selectorDraft, effectiveLeg } = resolve(data, draft);
    const changes = computeChanges({ data, draft, selectorDraft });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ env: "MODEL_FLAGSHIP", from: "m1", to: "m2", lanes: 3, restart: true, lockedLanes: ["Deep audit"], uncheckedLanes: 0 });
    expect(changes[0].laneNames).toEqual(["SMS intent", "SMS draft", "Deep audit"]);
    // Pinned lanes keep their pin; unpinned followers move.
    expect(effectiveLeg(data.lanes[0].primary)).toBe("m2");
    expect(effectiveLeg(data.lanes[2].primary)).toBe("m1");
  });

  it("a pin draft and an unpin are separate env changes with the right destinations", () => {
    const data = makeData();
    const draft = { PIN_IB: "m2", PIN_REPORT: UNPIN };
    const { selectorDraft } = resolve(data, draft);
    const changes = computeChanges({ data, draft, selectorDraft });
    expect(changes.map((c) => c.env).sort()).toEqual(["PIN_IB", "PIN_REPORT"]);
    const ib = changes.find((c) => c.env === "PIN_IB");
    expect(ib).toMatchObject({ from: "m1", to: "m2", label: "Intelligence Bar", uncheckedLanes: 1 });
    const report = changes.find((c) => c.env === "PIN_REPORT");
    expect(report).toMatchObject({ unpin: true, destinations: ["m1"] });
    expect(envBlockOf(changes, CATALOG)).toBe("PIN_IB=m2\n# delete PIN_REPORT  (unpin → Claude Opus 4.8)");
  });

  it("a pin drafted to the model it would follow anyway is not a change", () => {
    const data = makeData();
    const draft = { PIN_IB: "m1" };
    const { selectorDraft } = resolve(data, draft);
    // PIN_IB is pinned today, so keeping m1 explicitly is still a no-op only
    // once it stops being pinned; the composer keeps it because the pin exists.
    expect(computeChanges({ data, draft, selectorDraft })).toHaveLength(1);
    const draft2 = { MODEL_FLAGSHIP: "m1" };
    expect(computeChanges({ data, draft: draft2, selectorDraft: resolve(data, draft2).selectorDraft })).toHaveLength(0);
  });
});

describe("buildMigrationSet", () => {
  it("groups every env on the source model by its worst follower", () => {
    const data = makeData();
    const set = buildMigrationSet({ data, catalog: CATALOG, fromId: "m1", toId: "m2" });
    expect(set.eligible.map((e) => e.env)).toEqual(["PIN_REPORT"]);
    expect(set.shadow).toEqual([]);
    expect(set.approval.map((e) => e.env).sort()).toEqual(["MODEL_FLAGSHIP", "PIN_IB"]);
    expect(set.blocked).toEqual([]);
    const shared = set.approval.find((e) => e.env === "MODEL_FLAGSHIP");
    expect(shared.lanes.map((l) => l.id)).toEqual(["sms_intent", "sms_draft", "audit_deep"]);
    expect(shared.reasons).toEqual(["carries customer content", "locked: Bake-off"]);
    expect(set.approval.find((e) => e.env === "PIN_IB").reasons).toEqual(["unchecked after a switch"]);
  });

  it("a target the env cannot serve lands in blocked with the reason", () => {
    const data = makeData();
    const set = buildMigrationSet({ data, catalog: CATALOG, fromId: "m1", toId: "m3" });
    expect(set.blocked.map((e) => e.env).sort()).toEqual(["MODEL_FLAGSHIP", "PIN_IB"]);
    expect(set.blocked.every((e) => e.reasons.includes("different provider"))).toBe(true);
    // The report pin accepts OpenAI too, so it stays eligible.
    expect(set.eligible.map((e) => e.env)).toEqual(["PIN_REPORT"]);
  });

  it("a judged lane on its own env is a shadow candidate; no source model → empty groups", () => {
    const data = makeData();
    data.lanes[1].inbound = false;
    data.lanes[1].primary = { ...data.lanes[1].primary, pinEnv: "PIN_SMS_DRAFT", pinned: true };
    const set = buildMigrationSet({ data, catalog: CATALOG, fromId: "m1", toId: "m2" });
    expect(set.shadow.map((e) => e.env)).toEqual(["PIN_SMS_DRAFT"]);
    expect(buildMigrationSet({ data, catalog: CATALOG, fromId: null, toId: "m2" })).toEqual({ eligible: [], shadow: [], approval: [], blocked: [] });
  });
});

describe("modelsInUse", () => {
  it("counts primary legs and parallel arms, most-used first", () => {
    const data = makeData();
    data.lanes[0].also = [{ model: "m4", selector: null, pinEnv: null, pinned: false }];
    expect(modelsInUse(data)).toEqual([["m1", 5], ["m4", 1]]);
  });
});

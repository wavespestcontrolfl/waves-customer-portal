import { describe, expect, it } from "vitest";
import { UNPIN, buildMigrationSet, computeChanges, discoveredEntry, effectiveLegFor, envBlockOf, holdsFor, modelsInUse, selectorDraftFor } from "./modelDraft";
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

  it("deleting a selector override returns every follower to the registry default; no override → nothing to delete", () => {
    const data = makeData();
    // Railway pins FLAGSHIP at m1 while the registry default has moved to m2.
    Object.assign(data.selectors[0], { overridden: true, overrideEnv: "MODEL_FLAGSHIP", codeDefault: "m2", unpinnedModel: "m2" });
    const draft = { MODEL_FLAGSHIP: UNPIN };
    const { selectorDraft, effectiveLeg } = resolve(data, draft);
    const changes = computeChanges({ data, draft, selectorDraft });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ env: "MODEL_FLAGSHIP", from: "m1", to: "m2", unpin: true, lanes: 3 });
    expect(effectiveLeg(data.lanes[0].primary)).toBe("m2");
    expect(envBlockOf(changes, CATALOG)).toBe("# delete MODEL_FLAGSHIP  (unpin → Claude Opus 5)");
    // Set through a legacy alias: the delete line names the alias, and the
    // destination is whatever the server says takes over (here another alias's value).
    Object.assign(data.selectors[0], { overrideEnv: "FLAGSHIP_MODEL_LEGACY", unpinnedModel: "m1" });
    const aliased = computeChanges({ data, draft, selectorDraft: resolve(data, draft).selectorDraft });
    expect(envBlockOf(aliased, CATALOG)).toBe("# delete FLAGSHIP_MODEL_LEGACY  (unpin → Claude Opus 4.8)");
    data.lanes[3].primary.setEnv = "REPORT_MODEL_LEGACY";
    const pinDraft = { PIN_REPORT: UNPIN };
    expect(envBlockOf(computeChanges({ data, draft: pinDraft, selectorDraft: resolve(data, pinDraft).selectorDraft }), CATALOG)).toBe("# delete REPORT_MODEL_LEGACY  (unpin → Claude Opus 4.8)");
    const plain = makeData();
    expect(computeChanges({ data: plain, draft, selectorDraft: resolve(plain, draft).selectorDraft })).toHaveLength(0);
  });

  it("a locked follower with its own unset env is held at its model; one without an env is only warned about", () => {
    const data = makeData();
    // Deep audit (locked) follows FLAGSHIP through an unset per-lane env.
    data.lanes[4].primary = { ...data.lanes[4].primary, pinEnv: "AUDIT_MODEL" };
    expect(holdsFor(data, "FLAGSHIP")).toEqual({ AUDIT_MODEL: "m1" });
    expect(holdsFor(data, "OPENAI_FAST")).toEqual({});
    const draft = { MODEL_FLAGSHIP: "m2", ...holdsFor(data, "FLAGSHIP") };
    const { selectorDraft, effectiveLeg } = resolve(data, draft);
    const changes = computeChanges({ data, draft, selectorDraft });
    expect(changes.map((c) => c.env)).toEqual(["MODEL_FLAGSHIP", "AUDIT_MODEL"]);
    expect(changes[0]).toMatchObject({ lanes: 2, lockedLanes: [] });
    expect(changes[1]).toMatchObject({ hold: true, from: "m1", to: "m1", label: "Deep audit held at its current model (locked; it would otherwise follow FLAGSHIP)" });
    expect(effectiveLeg(data.lanes[4].primary)).toBe("m1");
    expect(envBlockOf(changes, CATALOG)).toBe("MODEL_FLAGSHIP=m2\nAUDIT_MODEL=m1");
    // No env to hold with → it moves, and the change says so.
    const plain = makeData();
    const d2 = { MODEL_FLAGSHIP: "m2" };
    expect(computeChanges({ data: plain, draft: d2, selectorDraft: resolve(plain, d2).selectorDraft })[0].lockedLanes).toEqual(["Deep audit"]);
  });

  it("a registration-locked managed agent never rides a selector change", () => {
    const data = makeData();
    data.lanes[4].lock = { kind: "registration", label: "Registered agent", detail: "re-register to move it" };
    const draft = { MODEL_FLAGSHIP: "m2" };
    const changes = computeChanges({ data, draft, selectorDraft: resolve(data, draft).selectorDraft });
    expect(changes[0]).toMatchObject({ lanes: 2, lockedLanes: [] });
    expect(changes[0].laneNames).toEqual(["SMS intent", "SMS draft"]);
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

  it("a target the server only knows by id (empty caps) is blocked, not treated as universal", () => {
    const data = makeData();
    const catalog = { ...CATALOG, m8: { label: "gpt-4o-transcribe", provider: "openai", caps: [], status: "current" } };
    const set = buildMigrationSet({ data, catalog, fromId: "m1", toId: "m8" });
    expect(set.eligible).toEqual([]);
    expect(set.blocked.length).toBeGreaterThan(0);
    expect(set.blocked.find((e) => e.env === "PIN_REPORT").reasons).toContain("no text support");
  });

  it("a judged lane on its own env is a shadow candidate; no source model → empty groups", () => {
    const data = makeData();
    data.lanes[1].inbound = false;
    data.lanes[1].primary = { ...data.lanes[1].primary, pinEnv: "PIN_SMS_DRAFT", pinned: true };
    const set = buildMigrationSet({ data, catalog: CATALOG, fromId: "m1", toId: "m2" });
    expect(set.shadow.map((e) => e.env)).toEqual(["PIN_SMS_DRAFT"]);
    expect(buildMigrationSet({ data, catalog: CATALOG, fromId: null, toId: "m2" })).toEqual({ eligible: [], shadow: [], approval: [], blocked: [] });
  });

  it("a target found through live search moves once its discovered entry joins the catalog", () => {
    const data = makeData();
    const found = { id: "m9", label: "Claude Next", provider: "anthropic" };
    const blind = buildMigrationSet({ data, catalog: CATALOG, fromId: "m1", toId: "m9" });
    expect(blind.eligible).toEqual([]);
    expect(blind.blocked.every((e) => e.reasons.includes("unknown model"))).toBe(true);
    const catalog = { ...CATALOG, m9: discoveredEntry(found, null, "text") };
    expect(catalog.m9).toMatchObject({ label: "Claude Next", provider: "anthropic", caps: ["text"], discovered: true });
    const set = buildMigrationSet({ data, catalog, fromId: "m1", toId: "m9" });
    expect(set.eligible.map((e) => e.env)).toEqual(["PIN_REPORT"]);
    expect(set.blocked).toEqual([]);
  });

  it("an unset per-lane env whose code default is the source still moves by setting it; a selector-fed leg moves through its selector", () => {
    const data = makeData();
    data.lanes.push({
      id: "lawn_writer", name: "Lawn writer", area: "reports", continuity: "verified", inbound: false, lock: null, fanout: false, applies: "restart",
      primary: { model: "m3", selector: null, pinEnv: "LAWN_WRITER_MODEL", pinned: false, unpinnedModel: "m3", accepts: { providers: ["openai"], cap: "text", deep: false }, live: false },
      fallback: null, retry: null, also: [],
    });
    // SMS intent's primary follows FLAGSHIP through an unset env pin (E-style).
    data.lanes[0].primary = { ...data.lanes[0].primary, pinEnv: "SMS_INTENT_MODEL" };
    const set = buildMigrationSet({ data, catalog: CATALOG, fromId: "m3", toId: "m4" });
    expect(set.eligible.map((e) => e.env)).toEqual(["LAWN_WRITER_MODEL"]);
    const flagship = buildMigrationSet({ data, catalog: CATALOG, fromId: "m1", toId: "m2" });
    expect(flagship.approval.map((e) => e.env).sort()).toEqual(["MODEL_FLAGSHIP", "PIN_IB"]);
    expect(flagship.approval.find((e) => e.env === "MODEL_FLAGSHIP").lanes.map((l) => l.id)).toContain("sms_intent");
  });

  it("registration-locked lanes are left out of a selector's migration entry", () => {
    const data = makeData();
    data.lanes[4].lock = { kind: "registration", label: "Registered agent", detail: "re-register to move it" };
    const set = buildMigrationSet({ data, catalog: CATALOG, fromId: "m1", toId: "m2" });
    const shared = set.approval.find((e) => e.env === "MODEL_FLAGSHIP");
    expect(shared.lanes.map((l) => l.id)).toEqual(["sms_intent", "sms_draft"]);
    expect(shared.reasons).toEqual(["carries customer content"]);
  });
});

describe("modelsInUse", () => {
  it("counts every leg — backups and retries included — once per lane, most-used first", () => {
    const data = makeData();
    // SMS intent already runs m4 as its backup; a parallel arm on m4 is the same lane.
    data.lanes[0].also = [{ model: "m4", selector: null, pinEnv: null, pinned: false }];
    expect(modelsInUse(data)).toEqual([["m1", 5], ["m4", 2]]);
    data.lanes[1].retry = { model: "m3", selector: null, pinEnv: null, pinned: false };
    expect(modelsInUse(data)).toContainEqual(["m3", 1]);
  });
});

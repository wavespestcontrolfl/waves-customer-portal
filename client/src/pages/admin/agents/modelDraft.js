// Pure helpers behind the Models tab's change composer: which legs a lane
// runs, what the draft resolves each leg to, the one-change-per-env list the
// review dialog shows, and the whole-model migration set. No React, no fetch —
// everything here is unit-testable against the GET /admin/agents/models shape.

// Draft value meaning "delete this env var in Railway" — a pinned leg then
// falls back to its selector / code default (`process.env.PIN || …`).
export const UNPIN = "__unpin__";

export function modelLabel(catalog, id) {
  if (!id) return "—";
  return catalog[id]?.label || id;
}

// Every leg a lane runs or falls back to: primary, fallback, the fallback's
// retry, and any parallel arms.
export const legsOf = (lane) => [lane.primary, lane.fallback, lane.retry, ...(lane.also || [])].filter(Boolean);

// A managed agent's model is embedded when the agent is registered with
// Anthropic; a registry env change reaches it at the next registration, not on
// restart. Such a lane never rides a selector change or a bulk migration.
export const movesOnEnv = (lane) => lane.lock?.kind !== "registration";

// Catalog entry for a model picked through live search / the newest list.
// Keeps whatever the catalog already knew (caps, deep-only); a fresh find is
// offered only for the modality it was found for.
export function discoveredEntry(model, prior, cap) {
  return {
    ...(prior || {}),
    label: model.label || model.id,
    provider: model.provider,
    caps: prior?.caps?.length ? prior.caps : [cap || "text"],
    status: "current",
    discovered: !prior || !!prior.discovered,
    ...(model.requiresDeep || prior?.requires === "deep" ? { requires: "deep" } : {}),
  };
}

// A selector's drafted value, following registry aliases: a selector that
// derives from another (OPENAI_SMS_DRAFT ← OPENAI_FAST while unset) moves
// with its parent's draft unless drafted itself. Deleting a selector override
// (UNPIN) lands on the registry's code default, or on the parent it derives from.
export function selectorDraftFor(selectorByKey, draft) {
  const resolve = (key) => {
    const s = selectorByKey[key];
    if (!s) return undefined;
    if (draft[s.env] === UNPIN) return s.unpinnedModel || (s.derivesFrom ? resolve(s.derivesFrom) || selectorByKey[s.derivesFrom]?.current : undefined);
    if (draft[s.env]) return draft[s.env];
    if (s.derived && s.derivesFrom) return resolve(s.derivesFrom);
    return undefined;
  };
  return resolve;
}

// What a selector-fed leg returns to once the selector's ACTIVE override is
// deleted: the server's after-unpin model (next set alias, else the registry
// default), or the parent a derived selector follows.
export const selectorUnpinnedModel = (s, selectorByKey) => s.unpinnedModel || (s.derivesFrom ? selectorByKey[s.derivesFrom]?.current : null) || null;

// The env var an unpin DELETES: the one actually set in Railway (a legacy
// alias such as MODEL_OPENAI_BEST or OPENAI_MODEL), not the canonical name
// the composer writes new values to.
const deleteEnvOf = (c) => c.deleteEnv || c.env;

// Effective model for a leg after the draft: a lane pin wins over its
// selector, exactly as `process.env.PIN || MODELS.TIER` does at boot.
export function effectiveLegFor(draft, selectorDraft) {
  return (leg) => {
    if (!leg) return null;
    if (leg.pinEnv && draft[leg.pinEnv] === UNPIN) return (leg.selector && selectorDraft(leg.selector)) || leg.unpinnedModel;
    if (leg.pinEnv && draft[leg.pinEnv]) return draft[leg.pinEnv];
    if (leg.pinEnv && leg.pinned) return leg.model;
    return (leg.selector && selectorDraft(leg.selector)) || leg.model;
  };
}

// Where a leg's model actually comes from: its own env pin, else the shared
// selector it follows (a change there moves every lane on that selector).
export const envForLeg = (leg, selectorByKey) => leg.pinEnv || (leg.selector && selectorByKey[leg.selector]?.env) || null;

// Holds that must accompany a selector draft: a LOCKED lane that follows the
// selector through an unset per-lane env is pinned at its current model, so
// the shared change cannot move it (mentions_prober on WORKHORSE via
// MODEL_MENTIONS). A locked follower with no env of its own cannot be held —
// the composer warns about it instead (sealed_eval's Claude leg on SMS_SONNET).
export function holdsFor(data, selectorKey) {
  const holds = {};
  if (!data) return holds;
  for (const l of data.lanes) {
    if (!l.lock || !movesOnEnv(l)) continue;
    for (const leg of legsOf(l)) {
      if (leg.selector === selectorKey && !leg.pinned && leg.pinEnv && !holds[leg.pinEnv]) holds[leg.pinEnv] = leg.model;
    }
  }
  return holds;
}

// One change per env var, computed from the COMPLETE draft: selectors (with
// derived aliases and locked holds), then pins aggregated by env.
export function computeChanges({ data, draft, selectorDraft }) {
  if (!data) return [];
  const pinnedAfterDraft = (leg) => (leg.pinEnv && draft[leg.pinEnv] ? draft[leg.pinEnv] !== UNPIN : !!leg.pinned);
  const baseAfterDraft = (leg) => (leg.selector && selectorDraft(leg.selector)) || leg.unpinnedModel || leg.model;
  const byEnv = new Map();
  for (const s of data.selectors) {
    const drafted = draft[s.env];
    if (!drafted) continue;
    const unpin = drafted === UNPIN;
    if (unpin && !s.overridden) continue;
    const next = unpin ? selectorDraft(s.key) : drafted;
    if (!unpin && next === s.current) continue;
    // Followers = this selector plus any unlocked selector that derives from
    // it and is not set or drafted on its own. A LOCKED derived selector is
    // held at its current model with a pin line of its own.
    const derived = data.selectors.filter((d) => d.derived && d.derivesFrom === s.key && !draft[d.env]);
    const held = derived.filter((d) => d.lock);
    const moving = derived.filter((d) => !d.lock);
    const keys = [s.key, ...moving.map((d) => d.key)];
    const follows = (leg) => leg && keys.includes(leg.selector) && !pinnedAfterDraft(leg);
    const following = data.lanes.filter((l) => movesOnEnv(l) && legsOf(l).some(follows));
    byEnv.set(s.env, {
      env: s.env,
      from: s.current,
      to: next,
      unpin,
      deleteEnv: unpin ? s.overrideEnv || s.env : undefined,
      label: `${s.key} selector${moving.length ? ` (+ ${moving.map((d) => d.key).join(", ")}, unset so it follows)` : ""}`,
      lanes: following.length,
      laneNames: following.map((l) => l.name),
      // Locked followers the composer could not hold (no env of their own).
      lockedLanes: following.filter((l) => l.lock).map((l) => l.name),
      uncheckedLanes: following.filter((l) => l.continuity === "unchecked").length,
      restart: true,
    });
    for (const d of held) {
      byEnv.set(d.env, { env: d.env, from: d.current, to: d.current, hold: true, label: `${d.key} held at its current model (locked; it would otherwise follow ${s.key})`, lanes: 0, restart: true });
    }
  }
  for (const l of data.lanes) {
    for (const leg of legsOf(l)) {
      const env = leg?.pinEnv;
      const next = env && draft[env];
      if (!next || byEnv.has(env)) continue;
      const unpin = next === UNPIN;
      const sharing = data.lanes.filter((x) => legsOf(x).some((g) => g.pinEnv === env));
      const legOf = (x) => legsOf(x).find((g) => g.pinEnv === env);
      // Unpinning a shared env can land its lanes on different models.
      const destinations = unpin ? [...new Set(sharing.map((x) => baseAfterDraft(legOf(x))))] : [next];
      if (!unpin && sharing.every((x) => next === baseAfterDraft(legOf(x)) && !legOf(x).pinned)) continue;
      const hold = !unpin && !leg.pinned && next === leg.model;
      const label = hold
        ? `${l.name} held at its current model (locked; it would otherwise follow ${leg.selector})`
        : sharing.length > 1 ? `${env} (${sharing.map((x) => x.name).join(", ")})` : `${l.name}${leg === l.primary ? "" : " · backup"}`;
      byEnv.set(env, {
        env,
        from: leg.model,
        to: destinations[0],
        destinations,
        unpin,
        hold,
        deleteEnv: unpin ? leg.setEnv || env : undefined,
        label,
        lanes: sharing.length,
        laneNames: sharing.map((x) => x.name),
        uncheckedLanes: sharing.filter((x) => x.continuity === "unchecked").length,
        // Timing comes from the leg the env feeds (a live fallback pin
        // applies on the next request even if the primary is boot-time).
        restart: sharing.some((x) => !legOf(x).live),
      });
    }
  }
  return [...byEnv.values()];
}

export const destinationLabel = (change, catalog) => (change.destinations || [change.to]).map((id) => modelLabel(catalog, id)).join(" / ");

// Unpins are deletions: Railway has no "unset" syntax, so the line is an
// instruction rather than an assignment.
export function envBlockOf(changes, catalog) {
  return changes.map((c) => (c.unpin ? `# delete ${deleteEnvOf(c)}  (unpin → ${destinationLabel(c, catalog)})` : `${c.env}=${c.to}`)).join("\n");
}

// Can the target model serve what this env feeds (provider, modality, deep-only)?
function incompatibility(accepts, target) {
  if (!target) return "unknown model";
  if (!accepts) return null;
  if (!accepts.providers.includes(target.provider)) return "different provider";
  if (target.caps?.length && !target.caps.includes(accepts.cap)) return `no ${accepts.cap} support`;
  if (target.requires === "deep" && !accepts.deep) return "deep-audit only";
  return null;
}

// Whole-model migration: every env that currently resolves to `fromId`,
// grouped by what has to happen before it can move to `toId`.
//   eligible — every lane the env feeds is verified (a deterministic checker
//              gates the output), not inbound, not locked
//   shadow   — judged lanes: a judge or replay eval can score the new model
//              first, so run it shadow before promoting
//   approval — inbound content (prompt-injection surface widens on a switch)
//              or unchecked lanes (nothing catches a regression except the owner)
//   blocked  — locked, no env to set, or the target cannot serve the env
// An env is classified by its WORST follower, so drafting the eligible group
// never moves a lane that needed a closer look.
const GROUP_RANK = { eligible: 0, shadow: 1, approval: 2, blocked: 3 };
export function buildMigrationSet({ data, catalog, fromId, toId }) {
  const groups = { eligible: [], shadow: [], approval: [], blocked: [] };
  if (!data || !fromId) return groups;
  const target = toId ? catalog[toId] : null;
  const laneGroup = (lane) => {
    // A locked lane that follows a shared setting moves with it by design
    // (the composer warns); it still needs the owner's look, not a bulk move.
    if (lane.lock) return ["approval", `locked: ${lane.lock.label || "by ruling"}`];
    if (lane.inbound) return ["approval", "carries customer content"];
    if (lane.continuity === "unchecked") return ["approval", "unchecked after a switch"];
    if (lane.continuity === "judged") return ["shadow", "judged — run shadow first"];
    return ["eligible", "verified by a deterministic check"];
  };
  const push = (entry) => {
    let group = "eligible";
    const reasons = new Set();
    for (const lane of entry.lanes) {
      const [g, why] = laneGroup(lane);
      if (GROUP_RANK[g] > GROUP_RANK[group]) group = g;
      if (g !== "eligible") reasons.add(why);
    }
    const bad = toId ? incompatibility(entry.accepts, target) : null;
    if (bad) {
      group = "blocked";
      reasons.add(bad);
    }
    groups[group].push({ ...entry, reasons: [...reasons] });
  };
  const seen = new Set();
  for (const s of data.selectors || []) {
    if (s.current !== fromId) continue;
    seen.add(s.env);
    const derived = (data.selectors || []).filter((d) => d.derived && d.derivesFrom === s.key && !d.lock);
    const keys = [s.key, ...derived.map((d) => d.key)];
    const lanes = data.lanes.filter((l) => movesOnEnv(l) && legsOf(l).some((g) => keys.includes(g.selector) && !g.pinned));
    if (s.lock) {
      groups.blocked.push({ env: s.env, kind: "selector", label: `${s.key} selector`, lanes, accepts: s.accepts, reasons: [s.lock.label || "locked"] });
      continue;
    }
    push({ env: s.env, kind: "selector", label: `${s.key} selector`, lanes, accepts: s.accepts });
  }
  // Per-lane envs: set pins, plus unset envs whose code default is the source
  // (LAWN_WRITER_MODEL unset → gpt-5.5 still moves by setting it). An unset
  // env over a SELECTOR is not listed — that leg moves through its selector.
  for (const l of data.lanes) {
    if (!movesOnEnv(l)) continue;
    for (const leg of legsOf(l)) {
      if (leg.model !== fromId || !leg.pinEnv || seen.has(leg.pinEnv)) continue;
      if (!leg.pinned && leg.selector) continue;
      seen.add(leg.pinEnv);
      const lanes = data.lanes.filter((x) => legsOf(x).some((g) => g.pinEnv === leg.pinEnv));
      const label = lanes.length > 1 ? `${lanes.length} lanes on one pin` : `${l.name}${leg === l.primary ? "" : " · backup"}`;
      // A pin that belongs to a locked lane is the lock itself.
      if (lanes.every((x) => x.lock)) {
        groups.blocked.push({ env: leg.pinEnv, kind: "pin", label, lanes, accepts: leg.accepts, reasons: [l.lock?.label || "locked"] });
        continue;
      }
      push({ env: leg.pinEnv, kind: "pin", label, lanes, accepts: leg.accepts });
    }
  }
  return groups;
}

// Models in use, most-used first: [id, laneCount] over EVERY leg — primary,
// backup, retry, parallel arms — counted once per lane, so a model that only
// ever runs as a backup (the Gemini retry model) can still be moved.
export function modelsInUse(data) {
  if (!data) return [];
  const counts = new Map();
  for (const l of data.lanes) {
    for (const id of new Set(legsOf(l).map((g) => g.model).filter(Boolean))) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

// Lawn photo shot list helpers (lawn report rebuild P18). The client reads the
// same shared/lawn-photo-shots.json the server does; these pin the helpers the
// admin drawer builds on.
import { describe, expect, it } from "vitest";
import DEFINITION from "../../../shared/lawn-photo-shots.json";
import { MAX_PHOTO_BYTES, MAX_TOTAL_BYTES, SHOTS, SHOT_CAP, SHOT_MINIMUM, addPhotos, assignShotZone, decodedBytes, describeAddResult, dropStalePicks, pickOptions, pickedKey, planFileReads, setLabelPick, missingMinimumSlots, shotIsFull, shotLabel, shotListHint } from "./lawn-photo-shots";

const photos = (...zones) => zones.map((zone, i) => ({ name: `p${i}`, zone }));
const zonesOf = (list) => list.map((p) => p.zone);

describe("shot list definition", () => {
  it("is the shared JSON: eight shots in technician order, cap 8, minimum 4", () => {
    expect(SHOTS.map((s) => s.key)).toEqual(["front", "back", "side", "close_up", "blade_crown", "hot_edge", "shade", "trouble"]);
    expect(SHOTS.map((s) => s.key)).toEqual(DEFINITION.shots.map((s) => s.key));
    expect(SHOT_CAP).toBe(8);
    expect(SHOT_MINIMUM).toBe(4);
    expect(SHOTS.every((s) => s.instruction && s.label)).toBe(true);
    expect(shotLabel("hot_edge")).toBe("Hot edge");
    expect(shotLabel("nope")).toBe("");
  });
});

describe("soft minimum hint", () => {
  it("names what is still needed and says it is only a guide", () => {
    expect(shotListHint(photos(null))).toBe(
      "Aim for at least 4 photos: front, back or side, canopy close-up, and blade and crown. Still needed: Front overview, Back overview or Side overview, Canopy close-up, Blade and crown. This is a guide only, and Analyze lawn works at any time.",
    );
    expect(shotListHint(photos("front", "side", "close_up"))).toMatch(/Still needed: Blade and crown\./);
  });

  it("goes away once front, back or side, close-up and blade are covered", () => {
    expect(shotListHint(photos("front", "back", "close_up", "blade_crown"))).toBeNull();
    expect(shotListHint(photos("front", "side", "close_up", "blade_crown", "trouble"))).toBeNull();
    expect(missingMinimumSlots(photos("front", "back"))).toEqual(["Canopy close-up", "Blade and crown"]);
  });
});

describe("assignShotZone", () => {
  it("tags a photo, and picking the same shot again clears it", () => {
    const tagged = assignShotZone(photos(null, null), 1, "back");
    expect(zonesOf(tagged)).toEqual([null, "back"]);
    expect(zonesOf(assignShotZone(tagged, 1, "back"))).toEqual([null, null]);
  });

  it("moves a one-photo shot to the newest photo that picks it", () => {
    expect(zonesOf(assignShotZone(photos("front", null), 1, "front"))).toEqual([null, "front"]);
    expect(zonesOf(assignShotZone(photos("close_up", "shade", null), 2, "close_up"))).toEqual([null, "shade", "close_up"]);
  });

  it("lets a problem area hold two photos and moves the earliest on a third", () => {
    let list = photos(null, null, null);
    list = assignShotZone(list, 0, "trouble");
    list = assignShotZone(list, 1, "trouble");
    expect(zonesOf(list)).toEqual(["trouble", "trouble", null]);
    list = assignShotZone(list, 2, "trouble");
    expect(zonesOf(list)).toEqual([null, "trouble", "trouble"]);
  });
});

describe("shotIsFull", () => {
  it("is full at one photo for most shots and two for a problem area", () => {
    expect(shotIsFull(photos("front"), "front")).toBe(true);
    expect(shotIsFull(photos("front"), "back")).toBe(false);
    expect(shotIsFull(photos("trouble"), "trouble")).toBe(false);
    expect(shotIsFull(photos("trouble", "trouble"), "trouble")).toBe(true);
  });
});

const MIB = 1048576;
const pic = (mb, name) => ({ name, data: `data:image/jpeg;base64,${Buffer.alloc(Math.floor(mb * MIB)).toString("base64")}` });
const small = (name) => ({ name, data: "data:image/jpeg;base64,cGhvdG8=" });
const names = (list) => list.map((p) => p.name);

describe("size numbers", () => {
  it("come from the shared JSON, and a full base64 set leaves 8 MiB under the 50 MiB body limit", () => {
    expect(MAX_PHOTO_BYTES).toBe(DEFINITION.maxPhotoBytes);
    expect(MAX_TOTAL_BYTES).toBe(DEFINITION.maxTotalBytes);
    expect(50 * MIB - Math.ceil(MAX_TOTAL_BYTES / 3) * 4).toBeGreaterThanOrEqual(8 * MIB);
    expect(decodedBytes("data:image/jpeg;base64,cGhvdG8=")).toBe(5);
    expect(decodedBytes("")).toBe(0);
  });
});

describe("addPhotos, shot list off (the original behavior)", () => {
  const off = { shotList: false };
  it("caps at 3, never tags, never checks size, and reports nothing", () => {
    const held = [small("a")];
    const out = addPhotos(held, [small("b"), small("c"), small("d")], { ...off, shot: "back" });
    expect(names(out.photos)).toEqual(["a", "b", "c"]);
    expect(zonesOf(out.photos)).toEqual([undefined, null, null]);
    expect(out.rejected).toEqual([]);
    expect(out.untagged).toEqual([]);
    expect(describeAddResult(out)).toBe("");
    expect(addPhotos([], [pic(6, "huge")], off).photos).toHaveLength(1);
    expect(addPhotos(photos(null, null, null), [small("x")], off).photos).toHaveLength(3);
  });
});

describe("addPhotos, shot list on", () => {
  const on = { shotList: true };

  it("adds untagged photos in order and reports nothing", () => {
    const out = addPhotos([], [small("a"), small("b")], on);
    expect(names(out.photos)).toEqual(["a", "b"]);
    expect(zonesOf(out.photos)).toEqual([null, null]);
    expect(describeAddResult(out)).toBe("");
  });

  it("holds 8 photos and names each one left out beyond the cap", () => {
    const held = Array.from({ length: 6 }, (_, i) => small(`h${i}`));
    const out = addPhotos(held, [small("a"), small("b"), small("c"), small("d")], on);
    expect(out.photos).toHaveLength(8);
    expect(out.rejected.map((r) => r.name)).toEqual(["c", "d"]);
    expect(describeAddResult(out)).toBe("c was not added: a visit holds up to 8 photos. Remove one first. d was not added: a visit holds up to 8 photos. Remove one first.");
  });

  it("refuses a photo over the per-photo limit, naming it, and keeps the rest", () => {
    const out = addPhotos([], [small("ok"), pic(6, "huge.jpg")], on);
    expect(names(out.photos)).toEqual(["ok"]);
    expect(describeAddResult(out)).toBe("huge.jpg is 6.0 MB; each photo must be 5.0 MB or smaller. Retake it or choose a smaller one.");
    expect(addPhotos([], [pic(5, "edge")], on).photos).toHaveLength(1); // exactly 5 MiB fits
  });

  it("refuses a photo that would pass the total, naming it and the running total", () => {
    const held = Array.from({ length: 6 }, (_, i) => pic(4.5, `h${i}`));
    const out = addPhotos(held, [small("fits"), pic(4.5, "late")], on);
    expect(names(out.photos).slice(-1)).toEqual(["fits"]);
    expect(out.rejected.map((r) => r.name)).toEqual(["late"]);
    expect(describeAddResult(out)).toMatch(/^late \(4\.5 MB\) was not added: one visit can carry 30\.0 MB of photos and these already total 27\.0 MB/);
    // Exactly at the total still fits.
    expect(addPhotos([pic(5, "a"), pic(5, "b"), pic(5, "c"), pic(5, "d"), pic(5, "e")], [pic(5, "f")], on).photos).toHaveLength(6);
    expect(addPhotos([pic(5, "a"), pic(5, "b"), pic(5, "c"), pic(5, "d"), pic(5, "e"), pic(5, "f")], [small("g")], on).rejected).toHaveLength(1);
  });

  it("tags the photo with the tapped shot while it has room", () => {
    const out = addPhotos(photos("front"), [small("n")], { ...on, shot: "back" });
    expect(zonesOf(out.photos)).toEqual(["front", "back"]);
    expect(out.untagged).toEqual([]);
  });

  it("a one-photo shot that is already taken: the new photo goes in untagged and the technician is told", () => {
    const out = addPhotos(photos("back"), [small("n.jpg")], { ...on, shot: "back" });
    expect(zonesOf(out.photos)).toEqual(["back", null]);
    expect(describeAddResult(out)).toMatch(/^n\.jpg was added without a shot tag: Back overview already has its photo\./);
  });

  it("a problem area takes two photos from one pick (wide + close-up); a third goes in untagged and is reported", () => {
    const out = addPhotos([], [small("wide"), small("close"), small("extra")], { ...on, shot: "trouble" });
    expect(zonesOf(out.photos)).toEqual(["trouble", "trouble", null]);
    expect(out.untagged.map((u) => u.name)).toEqual(["extra"]);
    expect(describeAddResult(out)).toMatch(/extra was added without a shot tag: Problem area already has its 2 photos/);
    // One problem photo already held: only one more fits.
    expect(zonesOf(addPhotos(photos("trouble"), [small("a"), small("b")], { ...on, shot: "trouble" }).photos)).toEqual(["trouble", "trouble", null]);
  });

  it("a one-photo shot picked with two files tags the first and reports the second", () => {
    const out = addPhotos([], [small("a"), small("b")], { ...on, shot: "close_up" });
    expect(zonesOf(out.photos)).toEqual(["close_up", null]);
    expect(out.untagged.map((u) => u.name)).toEqual(["b"]);
  });

  it("a rejected photo never takes the tag: the next kept photo does", () => {
    const out = addPhotos([], [pic(6, "huge"), small("ok")], { ...on, shot: "side" });
    expect(zonesOf(out.photos)).toEqual(["side"]);
    expect(names(out.photos)).toEqual(["ok"]);
  });

  it("overlapping adds decided one after the other give the same total either way round", () => {
    const first = [pic(4.5, "A1"), pic(4.5, "A2"), pic(4.5, "A3")];
    const second = [pic(4.5, "B1"), pic(4.5, "B2"), pic(4.5, "B3")];
    const run = (x, y) => {
      const one = addPhotos([], x, on);
      const two = addPhotos(one.photos, y, on);
      return { photos: two.photos, rejected: [...one.rejected, ...two.rejected] };
    };
    const ab = run(first, [...second, pic(4.5, "B4")]);
    const ba = run([...second, pic(4.5, "B4")], first);
    // 6 x 4.5 = 27 MB fits, the 7th photo (31.5 MB) does not, whichever read lands first.
    expect(ab.photos).toHaveLength(6);
    expect(ba.photos).toHaveLength(6);
    expect(ab.rejected).toHaveLength(1);
    expect(ba.rejected).toHaveLength(1);
    expect(describeAddResult({ rejected: ab.rejected })).toMatch(/was not added: one visit can carry 30\.0 MB/);
  });

  it("two reads for the same one-photo shot never leave two tags, in either order", () => {
    const a = addPhotos([], [small("a")], { ...on, shot: "back" });
    const b = addPhotos(a.photos, [small("b")], { ...on, shot: "back" });
    expect(zonesOf(b.photos).filter((z) => z === "back")).toHaveLength(1);
    const c = addPhotos([], [small("b")], { ...on, shot: "back" });
    const d = addPhotos(c.photos, [small("a")], { ...on, shot: "back" });
    expect(zonesOf(d.photos).filter((z) => z === "back")).toHaveLength(1);
  });

  it("does not mutate its inputs", () => {
    const held = [{ ...small("h"), zone: "front" }];
    const snapshot = JSON.stringify(held);
    addPhotos(held, [small("n")], { ...on, shot: "back" });
    expect(JSON.stringify(held)).toBe(snapshot);
  });
});

describe("planFileReads (bound the batch before decoding)", () => {
  const files = (n) => Array.from({ length: n }, (_, i) => ({ name: `f${i + 1}.jpg` }));

  it("reads only what the visit can still hold and names the rest", () => {
    const plan = planFileReads(files(20), { held: photos(null, null, null, null, null) });
    expect(plan.toRead.map((f) => f.name)).toEqual(["f1.jpg", "f2.jpg", "f3.jpg"]);
    expect(plan.skipped).toHaveLength(17);
    expect(describeAddResult({ rejected: plan.skipped.slice(0, 1) })).toBe("f4.jpg was not read: a visit holds up to 8 photos and 5 are added or being read. Remove one first.");
  });

  it("counts reads already in flight, so two quick picks share the room", () => {
    expect(planFileReads(files(6), { inFlight: 6 }).toRead).toHaveLength(2);
    expect(planFileReads(files(6), { held: photos(null, null), inFlight: 6 }).toRead).toHaveLength(0);
  });

  it("reads everything when there is room", () => {
    expect(planFileReads(files(3), {})).toEqual({ toRead: files(3), skipped: [] });
    expect(planFileReads([], {})).toEqual({ toRead: [], skipped: [] });
  });

  it("for a shot's own Add, is limited to that shot's remaining room, counting in-flight reads", () => {
    expect(planFileReads(files(3), { shot: "close_up" }).toRead).toHaveLength(1);
    expect(planFileReads(files(3), { shot: "close_up", held: photos("close_up") }).toRead).toHaveLength(0);
    expect(planFileReads(files(3), { shot: "trouble" }).toRead).toHaveLength(2);
    expect(planFileReads(files(3), { shot: "trouble", inFlightForShot: 1 }).toRead).toHaveLength(1);
    const plan = planFileReads(files(3), { shot: "back" });
    expect(describeAddResult({ rejected: plan.skipped.slice(0, 1) })).toBe('f2.jpg was not read: Back overview takes one photo and has room for 1. Use "Add turf photos" for the rest.');
  });
});

describe("customer label pick (GATE_LAWN_PHOTO_LABEL_PICK helpers)", () => {
  it("offers the eight customer wordings in shot list order, keyed by shot", () => {
    expect(pickOptions().map((o) => o.value)).toEqual(SHOTS.map((s) => s.key));
    expect(pickOptions().map((o) => o.label)).toEqual(["Front yard", "Back yard", "Side yard", "Close-up", "Blade close-up", "Sunny edge", "Shaded area", "Trouble spot"]);
  });

  it("defaults to the slot, shows a pick when there is one, and ignores a pick that is not a shot", () => {
    expect(pickedKey({ zone: "shade" })).toBe("shade");
    expect(pickedKey({ zone: "shade", labelKey: "close_up" })).toBe("close_up");
    expect(pickedKey({ zone: "shade", labelKey: "garage" })).toBe("shade");
    expect(pickedKey({})).toBe("");
  });

  it("sets a pick on one photo, clears it when it equals the slot, and leaves the others alone", () => {
    const held = photos("shade", "front");
    const picked = setLabelPick(held, 0, "close_up");
    expect(picked[0].labelKey).toBe("close_up");
    expect(picked[1]).toBe(held[1]);
    expect(Object.prototype.hasOwnProperty.call(setLabelPick(picked, 0, "shade")[0], "labelKey")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(setLabelPick(held, 0, "garage")[0], "labelKey")).toBe(false);
  });

  it("drops a pick when its photo changes slot, and changes nothing when no pick exists", () => {
    const before = [{ ...photos("shade")[0], labelKey: "close_up" }, ...photos("front")];
    const moved = dropStalePicks(before, assignShotZone(before, 0, "hot_edge"));
    expect(moved[0].zone).toBe("hot_edge");
    expect(Object.prototype.hasOwnProperty.call(moved[0], "labelKey")).toBe(false);
    const plain = photos("shade", "front");
    const after = assignShotZone(plain, 0, "hot_edge");
    expect(dropStalePicks(plain, after)).toEqual(after);
    // A pick on a photo whose slot did not change survives.
    const kept = dropStalePicks(before, assignShotZone(before, 1, "back"));
    expect(kept[0].labelKey).toBe("close_up");
  });
});


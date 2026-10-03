// Lawn photo shot list helpers (lawn report rebuild P18). The client reads the
// same shared/lawn-photo-shots.json the server does; these pin the helpers the
// admin drawer builds on.
import { describe, expect, it } from "vitest";
import DEFINITION from "../../../shared/lawn-photo-shots.json";
import { SHOTS, SHOT_CAP, SHOT_MINIMUM, assignShotZone, missingMinimumSlots, shotIsFull, shotLabel, shotListHint } from "./lawn-photo-shots";

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

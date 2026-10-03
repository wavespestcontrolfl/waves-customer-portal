// Lawn photo shot list helpers (lawn report rebuild P18). The client reads the
// same shared/lawn-photo-shots.json the server does; these pin the helpers the
// admin drawer builds on.
import { describe, expect, it } from "vitest";
import DEFINITION from "../../../shared/lawn-photo-shots.json";
import { MAX_PHOTO_BYTES, MAX_TOTAL_BYTES, SHOTS, SHOT_CAP, SHOT_MINIMUM, appendTaggedPhotos, assignShotZone, decodedBytes, fitPhotosToSizeLimit, missingMinimumSlots, shotIsFull, shotLabel, shotListHint } from "./lawn-photo-shots";

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

describe("appendTaggedPhotos", () => {
  it("tags the first new photo with the tapped shot when that shot has room", () => {
    const next = appendTaggedPhotos(photos("front"), [{ name: "n" }], "back", 8);
    expect(zonesOf(next)).toEqual(["front", "back"]);
  });

  it("leaves the new photo untagged when the shot filled up while it was being read", () => {
    const next = appendTaggedPhotos(photos("back"), [{ name: "n" }], "back", 8);
    expect(zonesOf(next)).toEqual(["back", null]);
    // A problem area still has room for a second photo.
    expect(zonesOf(appendTaggedPhotos(photos("trouble"), [{ name: "n" }], "trouble", 8))).toEqual(["trouble", "trouble"]);
  });

  it("never exceeds the cap, and no tag means no tag", () => {
    expect(appendTaggedPhotos(photos(null, null), [{}, {}, {}], null, 3)).toHaveLength(3);
    expect(zonesOf(appendTaggedPhotos(photos(), [{}], null, 8))).toEqual([null]);
  });
});

describe("size rule", () => {
  const photo = (mb, name) => ({ name, data: `data:image/jpeg;base64,${Buffer.alloc(Math.floor(mb * 1048576)).toString("base64")}` });

  it("uses the shared numbers: 5 MiB each, 30 MiB together, and a full base64 set leaves 8 MiB under the 50 MiB body limit", () => {
    expect(MAX_PHOTO_BYTES).toBe(DEFINITION.maxPhotoBytes);
    expect(MAX_TOTAL_BYTES).toBe(DEFINITION.maxTotalBytes);
    expect(50 * 1048576 - Math.ceil(MAX_TOTAL_BYTES / 3) * 4).toBeGreaterThanOrEqual(8 * 1048576);
  });

  it("measures decoded bytes from a data URL", () => {
    expect(decodedBytes("data:image/jpeg;base64,cGhvdG8=")).toBe(5);
    expect(decodedBytes("")).toBe(0);
  });

  it("keeps photos that fit and names every one that does not", () => {
    const held = [photo(4.5, "h1"), photo(4.5, "h2"), photo(4.5, "h3"), photo(4.5, "h4"), photo(4.5, "h5"), photo(4.5, "h6")];
    const fit = fitPhotosToSizeLimit(held, [photo(1, "ok"), photo(4.5, "late"), photo(6, "huge")]);
    expect(fit.accepted.map((p) => p.name)).toEqual(["ok"]);
    expect(fit.message).toMatch(/late \(4\.5 MB\) was not added/);
    expect(fit.message).toMatch(/huge is 6\.0 MB; each photo must be 5\.0 MB or smaller/);
    expect(fitPhotosToSizeLimit([], [photo(1, "a")])).toEqual({ accepted: expect.any(Array), message: "" });
  });

  it("enforces the size rule inside the append when asked", () => {
    const held = Array.from({ length: 6 }, (_, i) => ({ ...photo(4.5, `h${i}`), zone: null }));
    const next = appendTaggedPhotos(held, [photo(4.5, "late")], "back", 8, { enforceSize: true });
    expect(next).toHaveLength(6);
  });
});

import { describe, expect, it } from "vitest";
import protocols from "../../../server/config/protocols.json";
import FORMER from "./protocol-action-former-text.json";
import { remapRestoredActionLabels } from "./protocol-action-renames";
import { renameProtocolMarkerLines } from "../pages/admin/SchedulePage";

const OLD_DRY = "Leave the doors open until the spray has dried; nobody rides in the vehicle and no child seat goes back in until then";
const NEW_DRY = "Doors open until the spray dries; nobody rides and no child seat goes back in until then";
const cardLines = new Set(Object.values(protocols).flatMap((program) => (program.visits || [])
  .flatMap((visit) => [visit.primary, visit.secondary].flatMap((text) => String(text || "").split("\n")))));

describe("remapRestoredActionLabels", () => {
  it("maps a draft's old vehicle drying step to the current card line", () => {
    expect(FORMER[OLD_DRY]).toBe(NEW_DRY);
    expect(remapRestoredActionLabels([OLD_DRY], [NEW_DRY, "Vacuum seats"])).toEqual({ labels: [NEW_DRY], renames: { [OLD_DRY]: NEW_DRY }, dropped: [] });
  });

  it("keeps one label when the tech already re-checked the new wording", () => {
    expect(remapRestoredActionLabels([OLD_DRY, NEW_DRY], [NEW_DRY]).labels).toEqual([NEW_DRY]);
  });

  it("matches the current line after normalizing case, spacing and end punctuation", () => {
    expect(remapRestoredActionLabels(["vacuum  seats."], ["Vacuum seats"], {})).toEqual({ labels: ["Vacuum seats"], renames: { "vacuum  seats.": "Vacuum seats" }, dropped: [] });
  });

  it("drops a former card line with no current match, and leaves any other label to the submit allowlist", () => {
    expect(remapRestoredActionLabels([OLD_DRY, "Perimeter spray"], ["Vacuum seats"])).toEqual({ labels: ["Perimeter spray"], renames: {}, dropped: [OLD_DRY] });
  });

  it("names a current card line for every former line", () => {
    const stale = Object.entries(FORMER).filter(([, to]) => ![...cardLines].some((line) => line === to || line.startsWith(`${to} (`)));
    expect(stale).toEqual([]);
  });
});

describe("renameProtocolMarkerLines", () => {
  it("rewrites the old marker text and keeps one marker when the new one is there", () => {
    expect(renameProtocolMarkerLines(`[Protocol] ${OLD_DRY}\nA note`, { [OLD_DRY]: NEW_DRY })).toBe(`[Protocol] ${NEW_DRY}\nA note`);
    expect(renameProtocolMarkerLines(`[Protocol] ${OLD_DRY}\n[Protocol] ${NEW_DRY}`, { [OLD_DRY]: NEW_DRY })).toBe(`[Protocol] ${NEW_DRY}`);
    // A capitalization-only rename keeps its one marker (it is not a duplicate of itself).
    expect(renameProtocolMarkerLines('[Protocol] vacuum seats', { 'vacuum seats': 'Vacuum seats' })).toBe('[Protocol] Vacuum seats');
  });
});

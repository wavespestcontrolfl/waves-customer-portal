import { describe, expect, test } from "vitest";
import { AREAS_BY_SERVICE } from "./SchedulePage";
import AREA_SCOPES from "../../../../shared/treatment-area-scopes.json";

describe("completion panel area chips", () => {
  test("every generic area chip carries an explicit report scope", () => {
    const lists = ["interior", "exterior", "unscoped"];
    const unclassified = Object.values(AREAS_BY_SERVICE).flat().filter((label) => (
      lists.filter((list) => AREA_SCOPES[list].includes(label)).length !== 1
    ));
    expect(unclassified).toEqual([]);
  });
});

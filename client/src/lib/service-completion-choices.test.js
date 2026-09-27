import { describe, expect, test } from "vitest";
import observationCatalog from "../../../shared/service-completion-observations.json";
import {
  SERVICE_COMPLETION_CHOICE_CATEGORIES,
  SERVICE_COMPLETION_CHOICE_COUNTS,
  SERVICE_COMPLETION_CHOICE_FAMILIES,
  SERVICE_COMPLETION_CHOICES,
  normalizeServiceCompletionChoiceCategory,
  normalizeServiceCompletionChoiceFamily,
  searchServiceCompletionChoices,
  serviceCompletionChoicesFor,
} from "./service-completion-choices";

describe("service completion choices", () => {
  test("builds the customer-safe observation choices from the shared vocabulary", () => {
    for (const family of SERVICE_COMPLETION_CHOICE_FAMILIES) {
      expect(SERVICE_COMPLETION_CHOICES[family].observations.map(({ label }) => label))
        .toEqual(observationCatalog[family].map(([, label]) => label));
    }
  });

  test("provides 25–30 stable, unique choices in every routine-service category", () => {
    const allIds = [];
    for (const family of SERVICE_COMPLETION_CHOICE_FAMILIES) {
      expect(Object.keys(SERVICE_COMPLETION_CHOICES[family])).toEqual(SERVICE_COMPLETION_CHOICE_CATEGORIES);
      for (const category of SERVICE_COMPLETION_CHOICE_CATEGORIES) {
        const choices = SERVICE_COMPLETION_CHOICES[family][category];
        expect(choices.length).toBeGreaterThanOrEqual(25);
        expect(choices.length).toBeLessThanOrEqual(30);
        expect(SERVICE_COMPLETION_CHOICE_COUNTS[family][category]).toBe(choices.length);
        expect(new Set(choices.map(({ label }) => label)).size).toBe(choices.length);
        for (const choice of choices) {
          expect(choice.id).toMatch(/^[a-z0-9-]+$/);
          expect(choice.label).toMatch(/[.!?]$/);
          expect(choice.label).not.toContain(",");
          expect(Array.isArray(choice.keywords)).toBe(true);
          expect(choice).not.toHaveProperty("product");
          expect(choice).not.toHaveProperty("rate");
          expect(choice).not.toHaveProperty("method");
          allIds.push(choice.id);
        }
      }
    }
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  test("normalizes the existing routine service keys and category aliases", () => {
    expect(normalizeServiceCompletionChoiceFamily("lawn_care")).toBe("lawn");
    expect(normalizeServiceCompletionChoiceFamily("Tree & Shrub")).toBe("tree_shrub");
    expect(normalizeServiceCompletionChoiceFamily("pest_control")).toBe("recurring_pest");
    expect(normalizeServiceCompletionChoiceFamily("mosquito")).toBeNull();
    expect(serviceCompletionChoicesFor("commercial_lawn", "recommendations")).toEqual([]);
    expect(serviceCompletionChoicesFor("palm", "observations")).toBe(SERVICE_COMPLETION_CHOICES.tree_shrub.observations);
    expect(normalizeServiceCompletionChoiceCategory("protocol actions")).toBe("completedActions");
    expect(normalizeServiceCompletionChoiceCategory("recommendation")).toBe("recommendations");
    for (const category of ["actionsCompleted", "protocolActionsCompleted"]) {
      expect(serviceCompletionChoicesFor("lawn", category)).toBe(SERVICE_COMPLETION_CHOICES.lawn.completedActions);
    }
    expect(serviceCompletionChoicesFor("unknown", "observations")).toEqual([]);
  });

  test("searches labels and keywords with all query terms while preserving library order", () => {
    expect(searchServiceCompletionChoices("lawn", "observations", "broken head").map(({ id }) => id))
      .toEqual(["lawn-observation-damaged-sprinkler"]);
    expect(searchServiceCompletionChoices("tree_shrub", "recommendations", "arborist deadwood").map(({ id }) => id))
      .toEqual(["tree-shrub-recommendation-qualified-deadwood-review"]);
    expect(searchServiceCompletionChoices("pest_control", "actions", "cobweb sweep").map(({ id }) => id))
      .toEqual(["recurring-pest-completed-action-removed-webs"]);
    expect(searchServiceCompletionChoices("lawn", "observations", "")).toBe(SERVICE_COMPLETION_CHOICES.lawn.observations);
  });

  test("treats inherited object names as unsupported families and categories", () => {
    expect(normalizeServiceCompletionChoiceFamily("constructor")).toBeNull();
    expect(normalizeServiceCompletionChoiceCategory("constructor")).toBeNull();
    expect(serviceCompletionChoicesFor("constructor", "observations")).toEqual([]);
    expect(serviceCompletionChoicesFor("lawn", "constructor")).toEqual([]);
  });

  test("keeps recommendation ownership explicit and completed work phrased as performed actions", () => {
    for (const family of SERVICE_COMPLETION_CHOICE_FAMILIES) {
      expect(SERVICE_COMPLETION_CHOICES[family].recommendations.every(({ label }) => label.startsWith("Homeowner:"))).toBe(true);
      expect(SERVICE_COMPLETION_CHOICES[family].completedActions.every(({ label }) => (
        /^(Applied|Checked|Cleared|Collected|Compared|Completed|Documented|Identified|Inspected|Marked|Recorded|Removed|Replaced|Reset|Reviewed|Serviced|Spot-treated|Tested|Treated)/.test(label)
      ))).toBe(true);
    }
  });

  test("supplies dry-time metadata only as action facts and never product defaults", () => {
    const exterior = serviceCompletionChoicesFor("pest", "actions")
      .find(({ id }) => id.endsWith("applied-perimeter-band"));
    const unscopedApplication = serviceCompletionChoicesFor("pest", "actions")
      .find(({ id }) => id.endsWith("applied-gel-bait"));
    const unscopedApplicationIds = [
      "completed-crack-crevice",
      "applied-gel-bait",
      "dusted-voids",
    ];
    const unscopedApplications = serviceCompletionChoicesFor("pest", "actions")
      .filter(({ id }) => unscopedApplicationIds.some((suffix) => id.endsWith(suffix)));
    const inspection = serviceCompletionChoicesFor("lawn", "actions")
      .find(({ id }) => id.endsWith("inspected-turf"));

    expect(exterior).toMatchObject({ scope: "exterior", treatmentApplied: true });
    expect(unscopedApplication).toMatchObject({ treatmentApplied: true });
    expect(unscopedApplications).toHaveLength(unscopedApplicationIds.length);
    expect(unscopedApplications.every((choice) => choice.treatmentApplied === true)).toBe(true);
    expect(unscopedApplications.every((choice) => !Object.hasOwn(choice, "scope"))).toBe(true);
    expect(inspection).toMatchObject({ scope: "exterior", treatmentApplied: false });
    expect([...exterior.keywords, ...unscopedApplication.keywords]).not.toContain("product");
  });
});

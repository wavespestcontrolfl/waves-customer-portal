import { describe, expect, it } from "vitest";
import {
  ALL_CUSTOMER_TABLE_COLUMNS,
  normalizeCustomerTableViewState,
} from "./customer-table-view-settings";

describe("customer table view settings", () => {
  it("keeps required columns, drops unknown and duplicate columns, and restores canonical order", () => {
    expect(normalizeCustomerTableViewState({
      visibleColumns: ["attention", "unknown", "attention", "property"],
    }).visibleColumns).toEqual(["customer", "property", "attention", "actions"]);
    expect(normalizeCustomerTableViewState({ visibleColumns: "property" }).visibleColumns)
      .toEqual(ALL_CUSTOMER_TABLE_COLUMNS);
  });

  it("allowlists filters without erasing editable health-score bounds", () => {
    const normalized = normalizeCustomerTableViewState({
      search: "x".repeat(200),
      filterStage: "injected",
      filterTier: "Diamond",
      sortBy: "privateField",
      pageSize: 75,
      healthFilters: {
        healthGrade: "Z",
        healthRisk: "unknown",
        minHealthScore: "80",
        maxHealthScore: "20",
        minChurnProbability: "42",
        retention: "private",
        customerId: "must-not-survive",
      },
      customerId: "also-must-not-survive",
    });

    expect(normalized.search).toHaveLength(160);
    expect(normalized).toMatchObject({
      filterStage: "all",
      filterTier: "all",
      sortBy: "lastName",
      pageSize: 100,
      healthFilters: {
        healthGrade: "",
        healthRisk: "",
        minHealthScore: "80",
        maxHealthScore: "20",
        minChurnProbability: "",
        retention: "",
      },
    });
    expect(normalized).not.toHaveProperty("customerId");
    expect(normalized.healthFilters).not.toHaveProperty("customerId");
  });
});

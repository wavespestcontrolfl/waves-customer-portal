// @vitest-environment jsdom
//
// codex round-3 P2 on PR #4673: admin-protocols.js lawn-mix stopped sending
// materialCostSummary to a technician (pricing projection), but
// ProtocolMixCard rendered that as "0/N lines priced" — indistinguishable
// from "genuinely nothing priced yet". The server now tags the response
// viewerRole: 'technician'; the card hides the Material Cost card/column
// instead of showing the fabricated zero.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ProtocolMixCard } from "./ProtocolReferenceTabV2";

afterEach(() => cleanup());

const BASE_ITEM = {
  raw: "K-Flow 0-0-25",
  matched: true,
  selected: true,
  product: { id: "kflow", name: "LESCO K-Flow 0-0-25", activeIngredient: "Potassium" },
  jobMix: { amount: 12, amountUnit: "fl_oz", ratePer1000: 3, rateUnit: "fl_oz" },
};

function basePlan(overrides) {
  return {
    items: [BASE_ITEM],
    selectedItems: [BASE_ITEM],
    equipment: { tankCapacityGal: 110 },
    visit: { objective: "Fixture visit" },
    ...overrides,
  };
}

it("hides the Material Cost card and the Mat$ column for a technician (restricted) viewer", () => {
  render(
    <ProtocolMixCard
      plan={basePlan({ viewerRole: "technician" })}
      selectedConditionalIds={[]}
      onToggleConditional={() => {}}
    />,
  );
  expect(screen.queryByText("Material Cost")).not.toBeInTheDocument();
  expect(screen.queryByText("Mat$")).not.toBeInTheDocument();
  expect(screen.queryByText(/lines priced/)).not.toBeInTheDocument();
});

it("control: an admin viewer still sees the Material Cost card and Mat$ column", () => {
  render(
    <ProtocolMixCard
      plan={basePlan({
        viewerRole: "admin",
        materialCostSummary: { total: 3.6, pricedLineCount: 1, selectedLineCount: 1 },
        items: [{ ...BASE_ITEM, jobMix: { ...BASE_ITEM.jobMix, materialCost: 3.6 } }],
      })}
      selectedConditionalIds={[]}
      onToggleConditional={() => {}}
    />,
  );
  expect(screen.getByText("Material Cost")).toBeInTheDocument();
  expect(screen.getAllByText("Mat$").length).toBeGreaterThan(0);
  expect(screen.getByText(/1\/1 lines priced/)).toBeInTheDocument();
});

// @vitest-environment jsdom
//
// GATE_LAWN_V13 tank sheet: when /lawn-mix returns `blocks` (an apply-alone product
// selected beside another product) the server withholds every quantity and the card
// says why, prominently, instead of the generic "select calibrated equipment" text.
// A spot row shows its label rate and the enter-it-yourself note, never a quantity.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ProtocolMixCard } from "./ProtocolReferenceTabV2";

afterEach(() => cleanup());

const BLOCK = {
  code: "lawn_v13_apply_alone",
  productId: "tet",
  message: "Tetrino Insecticide is applied alone, but other products are selected with it. Remove them from the mix or apply them separately.",
};
const TETRINO = { raw: "Tetrino Insecticide — chinch bugs", matched: true, selected: true, conditional: false, product: { id: "tet", name: "Tetrino Insecticide" }, jobMix: null, plannedMix: null };
const ARENA = {
  raw: "Arena 50 WDG — chinch bug spots", matched: true, selected: true, conditional: true,
  product: { id: "are", name: "Arena 50 WDG" }, jobMix: null, plannedMix: null,
  spot: { note: "Spot: enter the area treated and the amount used.", reference: "Label rate 0.29 oz per 1,000 sq ft" },
};

const plan = (overrides) => ({
  items: [TETRINO, ARENA], selectedItems: [TETRINO, ARENA], equipment: { tankCapacityGal: 110 },
  visit: { objective: "Fixture visit" }, mixingOrder: [], warnings: [], blocks: [], ...overrides,
});
const renderCard = (p) => render(<ProtocolMixCard plan={p} selectedConditionalIds={["are"]} onToggleConditional={() => {}} />);

it("a blocked mix shows the block message as an alert and in the mixing order, not the generic hint", () => {
  renderCard(plan({ blocks: [BLOCK] }));
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent("Mix on hold");
  expect(alert).toHaveTextContent(BLOCK.message);
  // The mixing-order card repeats the reason where the order would be.
  expect(screen.getAllByText(BLOCK.message, { exact: false }).length).toBeGreaterThanOrEqual(2);
  expect(screen.queryByText(/Select calibrated equipment and products/)).not.toBeInTheDocument();
  expect(screen.queryByText(/appear once calibrated equipment is selected/)).not.toBeInTheDocument();
});

it("control: no blocks and no mix keeps the generic hint and shows no alert", () => {
  renderCard(plan());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByText(/Select calibrated equipment and products/)).toBeInTheDocument();
});

it("a spot row shows its label rate and the note beside the product, with no quantity", () => {
  renderCard(plan());
  expect(screen.getAllByText(/Label rate 0\.29 oz per 1,000 sq ft\. Spot: enter the area treated and the amount used\./).length).toBeGreaterThan(0);
});

it("an unavailable line says why beside the product, with no quantity", () => {
  const unlinked = { ...TETRINO, unavailable: { reason: "No protocol row is linked to this product, so no amount is planned. Enter the actual work." } };
  renderCard(plan({ items: [unlinked], selectedItems: [unlinked] }));
  expect(screen.getAllByText(/No protocol row is linked to this product/).length).toBeGreaterThan(0);
});

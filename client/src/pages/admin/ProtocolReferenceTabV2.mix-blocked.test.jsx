// @vitest-environment jsdom
//
// GATE_LAWN_V13 tank sheet: when /lawn-mix returns `blocks` (an apply-alone product
// selected beside another product) the server withholds every quantity and the card
// says why, prominently, instead of the generic "select calibrated equipment" text.
// A spot row shows its label rate and the enter-it-yourself note, never a quantity.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
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

it("shows a field hold on both layouts even after a technician requested the product", () => {
  const held = { ...TETRINO, selected: false, conditional: true, fieldHold: "tetrino_scout_evidence_required" };
  render(<ProtocolMixCard
    plan={plan({ items: [held], selectedItems: [], equipment: { carrierGalPer1000: 1, tankCapacityGal: 110 } })}
    selectedConditionalIds={["tet"]} onToggleConditional={() => {}}
  />);
  expect(screen.getAllByText("On hold")).toHaveLength(2);
  expect(screen.queryByText("Selected")).not.toBeInTheDocument();
  expect(screen.queryByText(/appear once a sprayer/)).not.toBeInTheDocument();
  expect(screen.queryByText("Area Mix")).not.toBeInTheDocument();
});

it("a blocked mix shows the block message as an alert and in the mixing order, not the generic hint", () => {
  renderCard(plan({ blocks: [BLOCK] }));
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent("Mix warnings");
  expect(alert).toHaveTextContent(BLOCK.message);
  // The mixing-order card repeats the reason where the order would be.
  expect(screen.getAllByText(BLOCK.message, { exact: false }).length).toBeGreaterThanOrEqual(2);
  expect(screen.queryByText(/Select a sprayer and products/)).not.toBeInTheDocument();
  expect(screen.queryByText(/appear once a sprayer is selected/)).not.toBeInTheDocument();
});

it("control: no blocks and no mix keeps the generic hint and shows no alert", () => {
  renderCard(plan());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByText(/Select a sprayer and products/)).toBeInTheDocument();
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

it("a bermuda backpack mix order shows as its own block beside the base order, only when present", () => {
  const bermudaMixingOrder = [
    { step: 1, productId: null, productName: "Water", instruction: "Fill the backpack sprayer about half full with clean water." },
    { step: 2, productId: "rec", productName: "Recognition", instruction: "Add the Recognition." },
    { step: 3, productId: "fus", productName: "Fusilade II", instruction: "Add the Fusilade II." },
    { step: 4, productId: "nis", productName: "Surfactant", instruction: "Add the surfactant last." },
  ];
  const mixingOrder = [{ step: 1, productId: "pot", productName: "Fixture potassium", instruction: "Add the potassium." }];
  const { unmount } = renderCard(plan({ mixingOrder, bermudaMixingOrder }));
  expect(screen.getByText("Bermuda backpack mix")).toBeInTheDocument();
  for (const { productName } of bermudaMixingOrder) expect(screen.getByText(productName)).toBeInTheDocument();
  expect(screen.getByText("Mixing order")).toBeInTheDocument();
  expect(screen.getByText("Fixture potassium")).toBeInTheDocument();
  unmount();
  renderCard(plan({ mixingOrder }));
  expect(screen.queryByText("Bermuda backpack mix")).not.toBeInTheDocument();
});

// A sprayed product line on the sheet; mixWith: the product id the server resolved its tankMixWith to (one tank).
const sprayItem = (id, name, mixWith, raw = `${name} — fixture line`) => ({ raw, matched: true, selected: true, conditional: false, product: { id, name },
  tankAmounts: { application: "spray", ...(mixWith ? { mixWith: "fixture", mixWithProductIds: [mixWith] } : {}) }, jobMix: null, plannedMix: null });
const never = (a, b, reason) => ({ productAId: a[0], productAName: a[1], productBId: b[0], productBName: b[1], verdict: "never", reason });
const ASK = "Ask the office before you mix this tank.";
// The base "Mixing order" card (the product rows above it carry their own lines).
const orderCard = () => within(screen.getByText("Mixing order").closest(".overflow-hidden"));

it("a Never pair in a mixing order names only its pair and says to ask the office; the steps, numbers and amounts stay", () => {
  const bermudaMixingOrder = [
    { step: 1, productId: null, productName: "Water", instruction: "Fill the backpack sprayer about half full with clean water." },
    { step: 2, productId: "rec", productName: "Recognition", instruction: "Add 0.1 oz Recognition." },
    { step: 3, productId: "fus", productName: "Fusilade II", instruction: "Add 1.5 fl oz Fusilade II." },
    { step: 4, productId: "nis", productName: "Surfactant", instruction: "Add the surfactant last." },
  ];
  const mixingOrder = [
    { step: 1, productId: "pot", productName: "Fixture potassium", instruction: "Add 2 oz potassium." },
    { step: 2, productId: "fe", productName: "Fixture iron", instruction: "Add 1 oz iron." },
  ];
  const items = [sprayItem("pot", "Fixture potassium"), sprayItem("fe", "Fixture iron", "pot")];
  const mixCheck = { pairs: [never(["rec", "Recognition"], ["nis", "Surfactant"], "Label bars it."), never(["pot", "Fixture potassium"], ["fe", "Fixture iron"], "Fixture rule.")] };
  renderCard(plan({ items, selectedItems: items, mixingOrder, bermudaMixingOrder, mixCheck }));
  // Once before the steps and once under each step of the pair; never a "mix separately" instruction.
  expect(screen.getAllByText(`Do not mix: Recognition + Surfactant. Label bars it. ${ASK}`)).toHaveLength(3);
  expect(orderCard().getAllByText(`Do not mix: Fixture potassium + Fixture iron. Fixture rule. ${ASK}`)).toHaveLength(3);
  expect(screen.queryByText(/separately/)).not.toBeInTheDocument();
  for (const step of [...bermudaMixingOrder, ...mixingOrder]) {
    expect(screen.getAllByText(step.productName).length).toBeGreaterThan(0);
    expect(screen.getByText(step.instruction)).toBeInTheDocument();
  }
  expect(screen.getAllByText("2", { selector: ".u-nums" })).toHaveLength(2);
  expect(screen.getByText("4", { selector: ".u-nums" })).toBeInTheDocument();
});

it("a mixing order shows its Caution and jar-test lines before the steps, keeps its step numbers and shows no Do not mix line", () => {
  const mixingOrder = [
    { step: 1, productId: "pot", productName: "Fixture potassium", instruction: "Add 2 oz potassium." },
    { step: 2, productId: "fe", productName: "Fixture iron", instruction: "Add 1 oz iron." },
  ];
  const bermudaMixingOrder = [
    { step: 1, productId: "rec", productName: "Recognition", instruction: "Add 0.1 oz Recognition." },
    { step: 2, productId: "fus", productName: "Fusilade II", instruction: "Add 1.5 fl oz Fusilade II." },
  ];
  const items = [sprayItem("pot", "Fixture potassium"), sprayItem("fe", "Fixture iron", "pot")];
  const mixCheck = { pairs: [
    { productAId: "pot", productAName: "Fixture potassium", productBId: "fe", productBName: "Fixture iron", verdict: "caution", reason: "Fixture caution." },
    { productAId: "rec", productAName: "Recognition", productBId: "fus", productBName: "Fusilade II", verdict: "ok", reason: "Owner checked.", jarTestRequired: true },
  ] };
  renderCard(plan({ items, selectedItems: items, mixingOrder, bermudaMixingOrder, mixCheck }));
  expect(orderCard().getByText("Caution: Fixture caution.")).toBeInTheDocument();
  expect(screen.getByText("Jar test first")).toBeInTheDocument();
  expect(screen.queryByText(/^Do not mix: /)).not.toBeInTheDocument();
  expect(screen.getAllByText("2", { selector: ".u-nums" })).toHaveLength(2);
});

it("the base mixing order is checked tank by tank: a pair across two tanks gives no line; a Never pair in one tank sits under its steps", () => {
  const mixingOrder = [
    { step: 1, productId: "cel", productName: "Celsius WG", instruction: "Add 0.12 oz Celsius WG." },
    { step: 2, productId: "fert", productName: "Fixture fertilizer", instruction: "Add 2 oz fertilizer, then the Synthetic surfactant." },
    { step: 3, productId: "nis", productName: "Synthetic surfactant", instruction: "Add 1 fl oz surfactant last." },
  ];
  // The weed spot mix (Celsius + surfactant) and the broadcast fertilizer are two tanks.
  const items = [sprayItem("cel", "Celsius WG"), sprayItem("nis", "Synthetic surfactant", "cel"), sprayItem("fert", "Fixture fertilizer")];
  const mixCheck = { pairs: [
    never(["cel", "Celsius WG"], ["nis", "Synthetic surfactant"], "Label: no surfactant."),
    never(["cel", "Celsius WG"], ["fert", "Fixture fertilizer"], "Cross-tank rule."),
  ] };
  renderCard(plan({ items, selectedItems: items, mixingOrder, mixCheck }));
  const line = `Do not mix: Celsius WG + Synthetic surfactant. Label: no surfactant. ${ASK}`;
  const stepBox = (instruction) => screen.getByText(instruction).parentElement;
  expect(screen.queryByText(/Cross-tank rule/)).not.toBeInTheDocument();
  expect(within(stepBox("Add 0.12 oz Celsius WG.")).getByText(line)).toBeInTheDocument();
  expect(within(stepBox("Add 1 fl oz surfactant last.")).getByText(line)).toBeInTheDocument();
  // By product id only: the fertilizer step names the surfactant in its text and still gets no line; its text stays.
  expect(within(stepBox("Add 2 oz fertilizer, then the Synthetic surfactant.")).queryByText(/^Do not mix: /)).not.toBeInTheDocument();
});

it("the detailed product view puts its tank's Do not mix and Caution lines under each protocol line by product id; the lines stay as written", () => {
  const cel = sprayItem("cel", "Celsius WG", null, "Celsius WG + NIS broadleaf");
  const nis = sprayItem("nis", "LESCO 90/10 Nonionic Surfactant", "cel");
  const pot = sprayItem("pot", "Fixture potassium", "cel");
  const kflow = sprayItem("kflow", "LESCO K-Flow 0-0-25", null, "LESCO K-Flow 0-0-25 with LESCO 90/10 Nonionic Surfactant");
  const mixCheck = { pairs: [
    never(["cel", "Celsius WG"], ["nis", "LESCO 90/10 Nonionic Surfactant"], "Fixture rule."),
    { productAId: "cel", productAName: "Celsius WG", productBId: "pot", productBName: "Fixture potassium", verdict: "caution", reason: "Fixture caution." },
  ] };
  const items = [cel, nis, pot, kflow];
  renderCard(plan({ items, selectedItems: items, mixCheck }));
  const NEVER = `Do not mix: Celsius WG + LESCO 90/10 Nonionic Surfactant. Fixture rule. ${ASK}`;
  const CAUTION = "Caution: Fixture caution. (Celsius WG + Fixture potassium)";
  const under = (raw) => screen.getAllByText(raw).map((node) => {
    const lines = [];
    for (let next = node.nextElementSibling; next?.classList.contains("text-alert-fg"); next = next.nextElementSibling) lines.push(next.textContent);
    return lines;
  });
  for (const lines of under(cel.raw)) expect(lines).toEqual([NEVER, CAUTION]);
  for (const lines of under(nis.raw)) expect(lines).toEqual([NEVER]);
  for (const lines of under(pot.raw)) expect(lines).toEqual([CAUTION]);
  // Its text names the LESCO surfactant, but it is in no tank with Celsius.
  for (const lines of under(kflow.raw)) expect(lines).toEqual([]);
});

// Owner 2026-11-27: a sprayer number with no expiry is a neutral note on the card, outside the alert box; a real warning stays in it.
it("a sprayer number's note is plain text outside the alert box; a warning stays in the alert box", () => {
  renderCard(plan({ items: [TETRINO], warnings: [
    { code: "sprayer_number", severity: "note", message: "110-Gallon Spray Tank #1: 2 gal per 1,000 sq ft, from tank counts." },
    { code: "missing_calibration", message: "No sprayer test on file for the selected tank." },
  ] }));
  const note = screen.getByText("110-Gallon Spray Tank #1: 2 gal per 1,000 sq ft, from tank counts.");
  expect(note.closest(".bg-alert-bg")).toBeNull();
  expect(screen.getByText("No sprayer test on file for the selected tank.").closest(".bg-alert-bg")).not.toBeNull();
});

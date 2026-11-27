import React from "react";
import { createPortal } from "react-dom";
import { productLabelLink } from "../../lib/product-label";
import { FieldDocument, FieldDocumentBody, FieldFooter, FieldMasthead, FieldTitle } from "../../components/FieldDocument";
import { Button, Card } from "../../components/ui";
import "./protocol-tank-sheet.css";

const TANK_MIX_CATEGORIES = new Set([
  "water_conditioner", "dry_wg_wdg_wp_df", "liquid_flowable_sc", "ec_ew",
  "solution_sl", "liquid_fertilizer", "adjuvant_last",
]);

const unitText = (unit) => String(unit || "").replaceAll("_", " ");
const num = (value) => Number(value).toLocaleString("en-US", { maximumFractionDigits: 3 });
const fillText = (fill) => `${num(fill.amount)} ${unitText(fill.amountUnit)}${fill.metricAmount ? ` (${num(fill.metricAmount)} ${fill.metricUnit})` : ""}`;
const CARRIER_SOURCE = { row: "from the program row", line: "protocol line" };
const isSpreader = (item) => item.tankAmounts?.application === "spreader";
const nameKey = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
// How a product goes on, from the program's own mix marks: a spreader; added to another product's mix (the surfactant and
// Certainty in the Celsius weed mix); the base of a mix others are added to; the Bermuda removal step's one shared tank; applied
// alone. With no mark, neutral wording.
// The one test every mix instruction uses: a product is in today's mix only when it is selected for this sheet and not blocked
// (a Bermuda step the server marks unavailable, a field hold), at a limit, held, skipped, or a spreader product.
const BLOCKED_PLAN_STATES = new Set(["capped", "held", "unavailable"]);
const mixReady = (item) => Boolean(item.selected && !item.unavailable && !item.fieldHold && !item.tankAmounts?.skipped
  && !BLOCKED_PLAN_STATES.has(item.tankAmounts?.planState) && !isSpreader(item));
// By product id only: the server resolves the program's tankMixWith names with the plan's own line resolver (mixWithProductIds).
const mixesInto = (additive, base) => (additive.tankAmounts?.mixWithProductIds || []).includes(String(base.product.id));
// A tankMixWith name the resolver could not tie to a product on this sheet: "No rule on file", never a guess.
const unresolvedPartner = (item) => Boolean(item.tankAmounts?.mixWith) && !(item.tankAmounts?.mixWithProductIds || []).length;
const GRANULAR_METHOD = { hand_shaker: "Hand shaker", spreader: "Spreader" };

// The Bermuda removal step's shared tank, by product id from the server's step order (lawn-bermuda-removal.js mixOrderField:
// water, Recognition, Fusilade II, the surfactant last). The server sends no order for a blocked step, and the line shows only
// when every step product on the sheet is ready.
function sharedTank(item, products, order) {
  const steps = (order || []).filter((step) => step.productId);
  const ids = steps.map((step) => String(step.productId));
  const stepItems = products.filter((other) => other.bermudaStep);
  if (!ids.includes(String(item.product.id)) || !stepItems.every((other) => mixReady(other) && ids.includes(String(other.product.id)))) return null;
  return { text: `Same tank: ${steps.map((step) => step.productName).join(" + ")}`, tankIds: ids };
}

// A base product and every ready product added to its mix: one shared tank.
const baseTank = (base, products) => [base, ...products.filter((other) => mixReady(other) && mixesInto(other, base))].map((tankItem) => String(tankItem.product.id));

const uniqueByText = (lines) => lines.filter((entry, index) => lines.findIndex((other) => other.text === entry.text) === index);
// One product line's warnings (its tank card, the detailed product view): its own mix line's tank only, so two rows of one
// product (the weed mix and the Bermuda backpack) each keep their own tank.
export function itemMixWarnings(item, plan) {
  if (!item?.product) return [];
  const products = (plan.items || []).filter((other) => other.product);
  return tankMixWarnings(applicationMethod(item, products, plan.bermudaMixingOrder).tankIds, plan.mixCheck);
}
// The sheet's tanks, by product id: each base tank its cards name (a base and the products added to its mix), and the Bermuda
// backpack (the server's step order). The base mixing order lists products from several tanks; it is checked tank by tank.
export function sheetTanks(plan) {
  const products = (plan.items || []).filter((item) => item.product);
  const base = products.filter((item) => !item.bermudaStep)
    .map((item) => applicationMethod(item, products, plan.bermudaMixingOrder).tankIds).filter((ids) => ids?.length > 1);
  return { base: base.filter((ids, index) => base.findIndex((other) => [...other].sort().join() === [...ids].sort().join()) === index), bermuda: mixOrderIds(plan.bermudaMixingOrder) };
}
// A mixing order's warnings: each tank checked on its own, among the products of the order.
export function mixOrderWarnings(steps, tanks, mixCheck) {
  const ids = mixOrderIds(steps);
  return uniqueByText(tanks.flatMap((tank) => tankMixWarnings(tank.filter((id) => ids.includes(id)), mixCheck)));
}

// The one mix-line helper: the line's text, and the product ids it puts in the same tank (tankIds; null for no shared tank).
function applicationMethod(item, products, order) {
  const amounts = item.tankAmounts || {};
  const line = (text, tankIds = null) => ({ text, tankIds });
  if (isSpreader(item)) return line(GRANULAR_METHOD[amounts.applicator] || "Spreader");
  const neutral = line(amounts.applyAlone ? "Apply alone in its own tank" : "Mixing: follow this card and the label");
  if (!mixReady(item)) return neutral;
  // A Bermuda step line never takes the name marks below (they point at each other): the shared tank, or neutral wording.
  if (item.bermudaStep) return sharedTank(item, products, order) || neutral;
  const bases = products.filter((base) => mixReady(base) && mixesInto(item, base));
  if (bases.length) return line(`Add to the ${amounts.mixWith} mix`, [...new Set(bases.flatMap((base) => baseTank(base, products)))]);
  const partners = products.filter((other) => mixReady(other) && mixesInto(other, item));
  if (partners.length) return line(`Tank with: ${partners.map((other) => other.product.name).join(", ")}`, baseTank(item, products));
  return unresolvedPartner(item) ? { ...neutral, unresolved: true } : neutral;
}

// The mix safety table's answer (server: /lawn-mix mixCheck) for each pair in one shared tank: nothing for Yes, and
// "Jar test first" whenever the pair's rule asks for one. A Never pair replaces the mix line on every card of that tank
// ("Do not mix: <A> + <B>. <reason>. Ask the office before you mix this tank."): it names only the pair and never says how to
// resolve it. Every other answer shows under the line. Never in place of a product or an amount (owner 2026-11-26).
// A failed check: one "Mix check unavailable" line on the sheet. No check (fewer than two sprayed products): nothing.
const noEndDot = (text) => String(text || "").trim().replace(/[.\s]+$/, "");
const NEVER_TEXT = (pair) => [`Do not mix: ${pair.productAName} + ${pair.productBName}.`, noEndDot(pair.reason) && `${noEndDot(pair.reason)}.`,
  "Ask the office before you mix this tank."].filter(Boolean).join(" ");
const MIX_CHECK_TEXT = { caution: (pair) => `Caution: ${pair.reason}`, never: NEVER_TEXT, unknown: (pair) => pair.reason || "No rule on file" };
export const MIX_CHECK_UNAVAILABLE = "Mix check unavailable. Check the labels.";
// The one verdict path: every place that tells staff to combine products (card mix lines, printed cards, the base and Bermuda
// mixing orders, their step text) takes its warnings from here.
export function tankMixWarnings(tankIds, mixCheck) {
  if (!tankIds || tankIds.length < 2 || !Array.isArray(mixCheck?.pairs)) return [];
  const inTank = new Set(tankIds.map((id) => id.toLowerCase()));
  const lines = mixCheck.pairs
    .filter((pair) => inTank.has(String(pair.productAId).toLowerCase()) && inTank.has(String(pair.productBId).toLowerCase()))
    .flatMap((pair) => {
      // In a tank of three or more, each line names its pair.
      const names = inTank.size > 2 ? ` (${pair.productAName} + ${pair.productBName})` : "";
      return [
        MIX_CHECK_TEXT[pair.verdict] && {
          // A Never line names its pair already.
          verdict: pair.verdict, pair, text: `${MIX_CHECK_TEXT[pair.verdict](pair)}${pair.verdict === "never" ? "" : names}`,
          // A Never pair in the tank: the line takes the mix line's place on every card of the tank.
          replacesLine: pair.verdict === "never",
        },
        // A rule can ask for a jar test whatever its verdict, a Yes included.
        pair.jarTestRequired && { verdict: "caution", pair, text: `Jar test first${names}` },
      ].filter(Boolean);
    });
  return lines.filter((entry, index) => lines.findIndex((other) => other.text === entry.text) === index);
}

// The product ids of a mixing order (base or Bermuda): one tank.
export const mixOrderIds = (order) => (order || []).filter((step) => step.productId).map((step) => String(step.productId));

// The warning lines that go directly under one direction (a mixing-order step, a card's directions, a protocol line): each
// pair with that direction's product, by product id from the server's resolved lines. Never by name text; the direction's text
// is never rewritten.
export function directionLines(warnings, { productId, verdicts = ["never"] }) {
  if (productId == null) return [];
  const own = String(productId).toLowerCase();
  return warnings.filter((warning) => verdicts.includes(warning.verdict) && warning.pair
    && [warning.pair.productAId, warning.pair.productBId].some((id) => String(id).toLowerCase() === own))
    .map((warning) => warning.text);
}

// The Celsius label's heat rule (server: lawn-weed-mix.js), on the surfactant card and the Celsius card whenever the sheet tells
// them to mix.
function surfactantNote(item, products) {
  // The surfactant's own card always carries it, selected or not; the Celsius card when the sheet tells them to mix.
  const own = item.tankAmounts?.surfactantNote;
  if (own) return own;
  if (!mixReady(item)) return null;
  return products.find((other) => mixReady(other) && other.tankAmounts?.surfactantNote && mixesInto(other, item))?.tankAmounts.surfactantNote || null;
}

// A program volume the sprayer's test does not put out (server: the pass count), named for the use it applies to.
const sentenceCase = (text) => text.charAt(0).toUpperCase() + text.slice(1);
// "Use the other sprayer" only when the server found another sprayer on this sheet tested at the label volume.
function volumeAdvice({ labelGalPer1000: label, testedGalPer1000: tested, passes, otherSprayerName }) {
  const other = otherSprayerName ? `, or use ${otherSprayerName} (tested at ${num(label)})` : "";
  if (passes) return `Make ${passes} passes, or slow down to reach the label volume.`;
  return `${tested > label ? "Speed up" : "Slow down"} to reach ${num(label)}${other}.`;
}
const volumeText = (check) => [
  check.use ? `${sentenceCase(check.use)}:` : null,
  `Label volume is ${num(check.labelGalPer1000)} gal per 1,000. ${check.sprayerName || "This sprayer"} was tested at ${num(check.testedGalPer1000)}.`,
  volumeAdvice(check),
].filter(Boolean).join(" ");
const PLAN_STATE_NOTES = {
  capped: "Limit reached: do not apply at this visit.",
  held: "City hold: do not apply at this visit.",
  unavailable: "No program rate: catalog rate shown.",
};

// A volume stated for one use of the line (October Velista, large patch at 2 gal per 1,000 sq ft): that use's own fills.
const useRows = (useFills = []) => useFills.flatMap((use) => [["100 gal", use.per100Gal], ["FlowZone 4 gal", use.backpack4Gal]]
  .filter(([, fill]) => fill)
  .map(([label, fill]) => [`${label}, ${use.use}`, `${fillText(fill)} at ${num(use.carrierGalPer1000)} gal per 1,000 sq ft`]));

// One product's fill amounts (server: lawn-tank-reference.js) as [label, text] rows, and the one amount the heading shows.
const headingFill = (fill, backpack) => `${fillText(fill)} / ${num(fill.gallons)} gal${fill === backpack ? " FlowZone" : ""}`;

// The card heading: the full tank, else 100 gal, else FlowZone. A card with only per-use fills (October Velista with no FlowZone
// test) shows the first of them, never "No amount".
function amountHeading(amounts) {
  const main = amounts.fullTank || amounts.per100Gal || amounts.backpack4Gal;
  if (main) return headingFill(main, amounts.backpack4Gal);
  const use = (amounts.useFills || []).find((entry) => entry.per100Gal || entry.backpack4Gal);
  return use ? `${headingFill(use.per100Gal || use.backpack4Gal, use.backpack4Gal)}, ${use.use}` : "No amount";
}

function amountRows(amounts) {
  if (!amounts) return { rows: [], heading: "No amount" };
  if (amounts.skipped) return { rows: [], heading: "Skipped this round" };
  const rate = amounts.ratePer1000 ? `${num(amounts.ratePer1000)} ${unitText(amounts.rateUnit)} per 1,000 sq ft` : null;
  if (amounts.application === "spreader") {
    return { rows: [["Rate", rate || "Rate not on file. Use the label rate."]], heading: rate ? `${num(amounts.ratePer1000)} ${unitText(amounts.rateUnit)} / 1,000 sq ft` : "No amount" };
  }
  const rows = [["Rate", amounts.concentrationPercent ? `${num(amounts.concentrationPercent)}% of the spray volume` : rate || "Not on file. Use the label rate."]];
  if (amounts.per100Gal) rows.push(["100 gal tank", fillText(amounts.per100Gal)]);
  if (amounts.fullTank) rows.push([`Full ${num(amounts.fullTank.gallons)} gal tank`, fillText(amounts.fullTank)]);
  // A backpack amount names the FlowZone unit whose test it used.
  if (amounts.backpack4Gal) rows.push(["FlowZone 4 gal", `${fillText(amounts.backpack4Gal)}${amounts.backpack4Gal.sprayerName ? ` · ${amounts.backpack4Gal.sprayerName} test` : ""}`]);
  else if (amounts.backpackMissing) rows.push(["FlowZone 4 gal", "No FlowZone test on file. Test it to show this."]);
  if (amounts.fixedCarrierGalPer1000) rows.push(["Spray volume", `${num(amounts.fixedCarrierGalPer1000)} gal per 1,000 sq ft (${CARRIER_SOURCE[amounts.fixedCarrierSource]})`]);
  rows.push(...useRows(amounts.useFills));
  return { rows, heading: amountHeading(amounts) };
}

// The checks that once withheld a product's amount, now short warnings beside it (owner 2026-11-26: warn, never hide).
function productCautions(item, exclusions, products) {
  const { product, tankAmounts: amounts = {} } = item;
  // The whole species only: a named cultivar exclusion (Floratam, an unknown cultivar) stays on the excluded-turf line.
  const excludesDefaultTurf = exclusions.some((species) => ["staugustine", "staugustinegrass"].includes(nameKey(species)));
  return [
    !product.labelVerifiedAt && "Label not verified in the app.",
    excludesDefaultTurf && "Not labeled for St. Augustine.",
    item.conditional && "Conditional: confirm the trigger first.",
    !item.selected && "Not selected: yearly and visit limits are not checked here.",
    amounts?.application === "spray" && !TANK_MIX_CATEGORIES.has(product.mixingOrderCategory) && "Tank mixing not set in the app. Check the label.",
    PLAN_STATE_NOTES[amounts?.planState],
    item.fieldHold && "On hold: see the warning above.",
    // The program's required notes for this product, selected or not (the sheet-wide warnings list only the selected ones).
    ...(item.gateNotes || []).filter((note) => note.severity === "required").map((note) => note.text),
    surfactantNote(item, products),
    ...(amounts?.volumeChecks || []).map(volumeText),
  ].filter(Boolean);
}

// Amounts come from the server calculation, from the selected rig's last
// sprayer test. Every check is a warning beside the amount, never in place of
// it (owner 2026-11-26); only a missing sprayer test leaves an amount out.
export default function ProtocolTankSheet({ plan, safetyRules = [] }) {
  const equipment = plan.equipment;
  const products = (plan.items || []).filter((item) => item.product);
  const sheet = (
    <>
      <FieldMasthead variant="staff" />
      <FieldTitle
        eyebrow="Protocol reference"
        title="110-gallon tank mixing reference"
        subtitle={`St. Augustine · ${plan.month} · ${equipment?.systemName || "No calibrated tank selected"}`}
        reference={plan.month}
      />
      <div className="protocol-tank-content space-y-4 text-zinc-900">
        <div>
          <p className="mt-2 text-zinc-600">
            Reference sheet, not a pesticide container label or approval to combine every product.
            Follow each product label for mixing, PPE, application restrictions and re-entry.
          </p>
          <p className="mt-2">Products are not approved to be combined in one tank unless their card says so.</p>
          <p className="mt-2 font-medium">Reference amounts. Yearly and visit limits are checked on the job card, not here.</p>
          <p className="mt-2">{plan.visit?.objective}</p>
        </div>
        {equipment?.carrierGalPer1000 > 0 && (
          <p className="protocol-tank-meta">
            Carrier: {equipment.carrierGalPer1000} gal per 1,000 sq ft · Full-tank coverage: {Number(equipment.tankCoverageSqft).toLocaleString("en-US")} sq ft
          </p>
        )}
        {[...(plan.warnings || []), ...(plan.blocks || [])].map((warning, index) => (
          <p key={`${warning.code}-${index}`} className="text-alert-fg">{warning.message}</p>
        ))}
        {safetyRules.map((rule) => <p key={rule} className="text-alert-fg">{rule}</p>)}
        {plan.mixCheck?.status === "unavailable" && <p className="font-medium text-alert-fg">{MIX_CHECK_UNAVAILABLE}</p>}
        {!products.length && <p>No mapped products are available for this month.</p>}
        {products.map((item, index) => {
        const product = item.product;
        const amounts = item.tankAmounts;
        const { rows: fills, heading } = amountRows(amounts);
        const labelLink = productLabelLink(product);
        const exclusions = product.excludedTurfSpecies || [];
        const cautions = productCautions(item, exclusions, products);
        const method = applicationMethod(item, products, plan.bermudaMixingOrder);
        const tankWarnings = [...tankMixWarnings(method.tankIds, plan.mixCheck),
          ...(method.unresolved ? [{ verdict: "unknown", text: MIX_CHECK_TEXT.unknown({}) }] : [])];
        const neverLines = tankWarnings.filter((warning) => warning.replacesLine);
        const ppe = product.ppeText || (Array.isArray(product.ppeRequired) ? product.ppeRequired.join(", ").replaceAll("_", " ") : product.ppeRequired);
        const safety = [
          ["Active ingredient", product.activeIngredient],
          ["Application instruction", item.raw && <>{item.raw}{directionLines(tankWarnings, { productId: product.id, verdicts: ["never", "caution"] })
            .map((text) => <span key={text} className="block font-medium text-alert-fg">{text}</span>)}</>],
          ["Application scope", item.scope],
          ["Signal word", product.signalWord],
          ["PPE", ppe || "Not on file — consult the product label"],
          ["Re-entry", product.reentryText || "Consult the product label"],
          ["Compatibility", product.compatibilityNotes],
          ["Irrigation", product.irrigationNotes],
          ["Do not tank mix with", (product.doNotTankMixWith || []).join("; ")],
          ["Rainfast timing", product.rainfastMinutes == null ? null : `${product.rainfastMinutes} minutes`],
          ["Pollinators", product.pollinatorPrecautions],
        ].filter(([, value]) => value);
        return (
          <section key={`${product.id}-${index}`} className="protocol-tank-product">
            <div className="field-section-heading protocol-tank-product-heading doc-keep-with-next flex flex-wrap justify-between gap-2">
              <h3>{product.name}</h3>
              <span className="protocol-tank-meta font-mono">{heading}</span>
            </div>
            {neverLines.length
              ? neverLines.map((warning) => <p key={warning.text} className="mt-2 font-medium text-alert-fg">{warning.text}</p>)
              : <p className="mt-2 font-medium">{method.text}</p>}
            {tankWarnings.filter((warning) => !warning.replacesLine).map((warning) => (
              <p key={warning.text} className={`mt-1 ${warning.verdict === "unknown" ? "text-zinc-700" : "text-alert-fg"}`}>{warning.text}</p>
            ))}
            <p className="mt-2 text-zinc-600">{item.selected ? "Selected." : "Not selected."}</p>
            {fills.length > 0 && <dl className="protocol-tank-meta mt-2 grid gap-x-4 gap-y-1 grid-cols-[auto_1fr]">{fills.map(([label, value]) => <React.Fragment key={label}><dt className="font-medium">{label}</dt><dd className="font-mono">{value}</dd></React.Fragment>)}</dl>}
            {cautions.map((caution) => <p key={caution} className="mt-2 text-alert-fg">{caution}</p>)}
            <p className="mt-2">{product.mixingInstructions || "Mixing directions are not on file. Consult the product label."}</p>
            {product.mixingInstructions && directionLines(tankWarnings, { productId: product.id }).map((text) => <p key={text} className="mt-1 font-medium text-alert-fg">{text}</p>)}
            {exclusions.length > 0 && <p className="mt-2 text-alert-fg">Excluded turf: {exclusions.join(", ")}</p>}
            <dl className="protocol-tank-meta mt-3 grid gap-3 md:grid-cols-2">{safety.map(([label, value]) => <div key={label}><dt className="font-medium">{label}</dt><dd>{typeof value === "string" || typeof value === "number" ? String(value) : value}</dd></div>)}</dl>
            <div className="protocol-tank-meta mt-3 flex flex-wrap gap-4">
              {labelLink ? <a className="underline" href={labelLink.href} target="_blank" rel="noopener noreferrer">Product label</a> : <span>Product label document not on file</span>}
              {product.sdsUrl ? <a className="underline" href={product.sdsUrl} target="_blank" rel="noopener noreferrer">Safety data sheet</a> : <span>SDS not on file</span>}
            </div>
          </section>
        );
        })}
      </div>
      <FieldFooter label="Tank mixing reference" reference={plan.month} />
    </>
  );
  return (
    <>
      <Card className="p-4">
        <div className="waves-field-no-print mb-4 flex justify-end"><Button variant="secondary" onClick={() => window.print()}>Print mixing reference</Button></div>
        <FieldDocumentBody className="field-document-scroll protocol-tank-document">
          {sheet}
        </FieldDocumentBody>
      </Card>
      {createPortal(
        <div className="protocol-print-sheet">
          <FieldDocument className="protocol-tank-print-document">
            {sheet}
          </FieldDocument>
        </div>, document.body,
      )}
    </>
  );
}

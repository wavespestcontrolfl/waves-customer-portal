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
// How a product goes on: a spreader, an addition to another product's mix (the program names it: the surfactant in the Celsius
// weed mix), or its own single-product tank.
const OWN_TANK = "Separate single-product tank";
function applicationMethod(item) {
  if (isSpreader(item)) return "Spreader";
  const mixWith = item.tankAmounts?.mixWith;
  return mixWith ? `Add to the ${mixWith} mix` : OWN_TANK;
}
const PLAN_STATE_NOTES = {
  capped: "Limit reached: do not apply at this visit.",
  held: "City hold: do not apply at this visit.",
  unavailable: "No program rate: catalog rate shown.",
};

// One product's fill amounts (server: lawn-tank-reference.js) as [label, text] rows, and the one amount the heading shows.
function amountRows(amounts) {
  if (!amounts) return { rows: [], heading: "No amount" };
  const rate = amounts.ratePer1000 ? `${num(amounts.ratePer1000)} ${unitText(amounts.rateUnit)} per 1,000 sq ft` : null;
  if (amounts.application === "spreader") {
    return { rows: [["Rate", rate || "Rate not on file. Use the label rate."]], heading: rate ? `${num(amounts.ratePer1000)} ${unitText(amounts.rateUnit)} / 1,000 sq ft` : "No amount" };
  }
  const rows = [["Rate", amounts.concentrationPercent ? `${num(amounts.concentrationPercent)}% of the spray volume` : rate || "Not on file. Use the label rate."]];
  if (amounts.per100Gal) rows.push(["100 gal tank", fillText(amounts.per100Gal)]);
  if (amounts.fullTank) rows.push([`Full ${num(amounts.fullTank.gallons)} gal tank`, fillText(amounts.fullTank)]);
  if (amounts.backpack4Gal) rows.push(["FlowZone 4 gal", fillText(amounts.backpack4Gal)]);
  else if (amounts.backpackMissing) rows.push(["FlowZone 4 gal", "No FlowZone test on file. Test it to show this."]);
  if (amounts.fixedCarrierGalPer1000) rows.push(["Spray volume", `${num(amounts.fixedCarrierGalPer1000)} gal per 1,000 sq ft (${CARRIER_SOURCE[amounts.fixedCarrierSource]})`]);
  const main = amounts.fullTank || amounts.per100Gal || amounts.backpack4Gal;
  return { rows, heading: main ? `${fillText(main)} / ${num(main.gallons)} gal${main === amounts.backpack4Gal ? " FlowZone" : ""}` : "No amount" };
}

// The checks that once withheld a product's amount, now short warnings beside it (owner 2026-11-26: warn, never hide).
function productCautions(item, exclusions) {
  const { product, tankAmounts: amounts = {} } = item;
  const excludesDefaultTurf = exclusions.some((species) => String(species).toLowerCase().replace(/[^a-z]/g, "").startsWith("staugustine"));
  return [
    !product.labelVerifiedAt && "Label not verified in the app.",
    excludesDefaultTurf && "Not labeled for St. Augustine.",
    item.conditional && "Conditional: confirm the trigger first.",
    amounts?.application === "spray" && !TANK_MIX_CATEGORIES.has(product.mixingOrderCategory) && "Tank mixing not set in the app. Check the label.",
    PLAN_STATE_NOTES[amounts?.planState],
    item.fieldHold && "On hold: see the warning above.",
  ].filter(Boolean);
}

// Amounts come from the server calculation, from the selected rig's last
// sprayer test. Every check is a warning beside the amount, never in place of
// it (owner 2026-11-26); only a missing sprayer test leaves an amount out.
export default function ProtocolTankSheet({ plan, safetyRules = [] }) {
  const equipment = plan.equipment;
  const products = (plan.items || []).filter((item) => item.product);
  const ownTank = products.some((item) => applicationMethod(item) === OWN_TANK);
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
          {ownTank && <p className="mt-2">Each product marked &ldquo;{OWN_TANK}&rdquo; needs its own tank. Do not combine those products in one tank.</p>}
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
        {!products.length && <p>No mapped products are available for this month.</p>}
        {products.map((item, index) => {
        const product = item.product;
        const amounts = item.tankAmounts;
        const { rows: fills, heading } = amountRows(amounts);
        const labelLink = productLabelLink(product);
        const exclusions = product.excludedTurfSpecies || [];
        const cautions = productCautions(item, exclusions);
        const ppe = product.ppeText || (Array.isArray(product.ppeRequired) ? product.ppeRequired.join(", ").replaceAll("_", " ") : product.ppeRequired);
        const safety = [
          ["Active ingredient", product.activeIngredient],
          ["Application instruction", item.raw],
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
            <p className="mt-2 font-medium">{applicationMethod(item)}</p>
            <p className="mt-2 text-zinc-600">{item.selected ? "Selected." : "Not selected."}</p>
            {fills.length > 0 && <dl className="protocol-tank-meta mt-2 grid gap-x-4 gap-y-1 grid-cols-[auto_1fr]">{fills.map(([label, value]) => <React.Fragment key={label}><dt className="font-medium">{label}</dt><dd className="font-mono">{value}</dd></React.Fragment>)}</dl>}
            {cautions.map((caution) => <p key={caution} className="mt-2 text-alert-fg">{caution}</p>)}
            <p className="mt-2">{product.mixingInstructions || "Mixing directions are not on file. Consult the product label."}</p>
            {exclusions.length > 0 && <p className="mt-2 text-alert-fg">Excluded turf: {exclusions.join(", ")}</p>}
            <dl className="protocol-tank-meta mt-3 grid gap-3 md:grid-cols-2">{safety.map(([label, value]) => <div key={label}><dt className="font-medium">{label}</dt><dd>{String(value)}</dd></div>)}</dl>
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

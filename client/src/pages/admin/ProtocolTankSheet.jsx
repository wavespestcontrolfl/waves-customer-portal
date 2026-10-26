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

// Amounts come from the existing server calculation. Never scale a different
// rig's output or turn an optional product into a selected tank ingredient.
export default function ProtocolTankSheet({ plan, calibration, safetyRules = [] }) {
  const equipment = plan.equipment;
  const currentCalibration = calibration?.id === equipment?.calibrationId
    && calibration?.calibration_status === "field_verified"
    && (!equipment?.expiresAt || new Date(equipment.expiresAt) > new Date());
  const tankReady = Number(equipment?.tankCapacityGal) === 110 && currentCalibration;
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
          <p className="mt-2">Each product below requires a separate single-product tank. Do not combine the listed products in one tank.</p>
          <p className="mt-2">{plan.visit?.objective}</p>
        </div>
        {!tankReady && (
          <p role="alert" className="rounded-md border border-alert-fg/30 bg-alert-bg p-3 text-alert-fg">
            Tank quantities are unavailable. Select a 110-gallon tank with a current, field-verified calibration.
          </p>
        )}
        {tankReady && (
          <p className="protocol-tank-meta">
            Carrier: {equipment.carrierGalPer1000} gal per 1,000 sq ft · Full-tank coverage: {Number(equipment.tankCoverageSqft).toLocaleString("en-US")} sq ft
          </p>
        )}
        {(plan.warnings || []).map((warning, index) => (
          <p key={`${warning.code}-${index}`} className="text-alert-fg">{warning.message}</p>
        ))}
        {safetyRules.map((rule) => <p key={rule} className="text-alert-fg">{rule}</p>)}
        {!products.length && <p>No mapped products are available for this month.</p>}
        {products.map((item, index) => {
        const product = item.product;
        const mix = item.fullTankMix;
        const labelLink = productLabelLink(product);
        const tankProduct = TANK_MIX_CATEGORIES.has(product.mixingOrderCategory);
        const exclusions = product.excludedTurfSpecies || [];
        const excludesDefaultTurf = exclusions.some((species) => String(species).toLowerCase().replace(/[^a-z]/g, "").startsWith("staugustine"));
        const quantityChecks = [item.selected, tankReady, tankProduct, product.labelVerifiedAt, !excludesDefaultTurf,
          Number.isFinite(mix?.amount), mix?.amount > 0, mix?.amountUnit];
        const hasAmount = quantityChecks.every(Boolean);
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
              <span className="protocol-tank-meta font-mono">{hasAmount ? `${mix.amount} ${mix.amountUnit.replaceAll("_", " ")} / 110 gal` : "Quantity withheld"}</span>
            </div>
            <p className="mt-2 font-medium">Separate single-product tank</p>
            <p className="mt-2 text-zinc-600">{item.conditional ? "Conditional product — confirm its trigger before use." : "Protocol product"} {item.selected ? "Selected." : "Not selected for this tank."}</p>
            {!tankProduct && <p className="mt-2">Tank mixing is not established for this product. Check its application method and label.</p>}
            {!product.labelVerifiedAt && <p className="mt-2 text-alert-fg">Label verification missing.</p>}
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

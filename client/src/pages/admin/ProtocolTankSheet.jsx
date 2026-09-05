import React from "react";
import { createPortal } from "react-dom";
import { productLabelLink } from "../../lib/product-label";
import { Button, Card } from "../../components/ui";

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
    <div className="space-y-4 text-14 text-zinc-900">
      <div>
        <h2 className="text-20 font-medium">110-gallon tank mixing reference</h2>
        <p className="mt-1">St. Augustine · {plan.month} · {equipment?.systemName || "No calibrated tank selected"}</p>
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
        <p>
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
          <section key={`${product.id}-${index}`} className="break-inside-avoid rounded-md border border-zinc-200 p-4">
            <div className="flex flex-wrap justify-between gap-2">
              <h3 className="text-16 font-medium">{product.name}</h3>
              <span className="font-mono">{hasAmount ? `${mix.amount} ${mix.amountUnit.replaceAll("_", " ")} / 110 gal` : "Quantity withheld"}</span>
            </div>
            <p className="mt-2 font-medium">Separate single-product tank</p>
            <p className="mt-2 text-zinc-600">{item.conditional ? "Conditional product — confirm its trigger before use." : "Protocol product"} {item.selected ? "Selected." : "Not selected for this tank."}</p>
            {!tankProduct && <p className="mt-2">Tank mixing is not established for this product. Check its application method and label.</p>}
            {!product.labelVerifiedAt && <p className="mt-2 text-alert-fg">Label verification missing.</p>}
            <p className="mt-2">{product.mixingInstructions || "Mixing directions are not on file. Consult the product label."}</p>
            {exclusions.length > 0 && <p className="mt-2 text-alert-fg">Excluded turf: {exclusions.join(", ")}</p>}
            <dl className="mt-3 grid gap-3 md:grid-cols-2">{safety.map(([label, value]) => <div key={label}><dt className="font-medium">{label}</dt><dd>{String(value)}</dd></div>)}</dl>
            <div className="mt-3 flex flex-wrap gap-4">
              {labelLink ? <a className="underline" href={labelLink.href} target="_blank" rel="noopener noreferrer">Product label</a> : <span>Product label document not on file</span>}
              {product.sdsUrl ? <a className="underline" href={product.sdsUrl} target="_blank" rel="noopener noreferrer">Safety data sheet</a> : <span>SDS not on file</span>}
            </div>
          </section>
        );
      })}
    </div>
  );
  return (
    <>
      <Card className="p-4">
        <div className="mb-4 flex justify-end"><Button variant="secondary" onClick={() => window.print()}>Print mixing reference</Button></div>
        {sheet}
      </Card>
      {createPortal(
        <div className="protocol-print-sheet">
          <style>{`
            .protocol-print-sheet { display: none; }
            @media print {
              body:has(> .protocol-print-sheet) > :not(.protocol-print-sheet) { display: none !important; }
              body > .protocol-print-sheet { display: block !important; padding: 16px; color: black; background: white; }
              .protocol-print-sheet a::after { content: " (" attr(href) ")"; overflow-wrap: anywhere; }
            }
          `}</style>
          {sheet}
        </div>, document.body,
      )}
    </>
  );
}

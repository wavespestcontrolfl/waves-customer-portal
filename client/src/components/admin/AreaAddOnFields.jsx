import { governedRateText, hostAreaAddOns, isChemicalAreaAddOnKey, isGovernedProduct, soldAreaText } from "../../lib/areaAddOns";

// Said when the feed named no governed product for a chemical add-on (the server sends its own sentence otherwise).
const PRODUCT_UNAVAILABLE = "The product for this add-on could not be confirmed right now. Reload the visit or ask the office.";

// The add-on fields on a visit that has area add-ons attached as rows (GATE_AREA_ADDONS).
// The visit keeps its own full completion form; this block sits beside it and records
// each attached chemical add-on's product, pre-labelled with what the estimate sold and
// the governed rate. The product lands in the visit's ordinary product list as a row
// tagged with the add-on (`areaAddOnKey`), where its treated square feet are entered, so
// the server saves it like any other application row. The add-on that IS the visit is
// recorded in the generic product list (an untagged row is the visit's own) and is not
// listed here, but when it has no product to choose this block says so.
// What the estimate sold and the governed rate for one add-on, as plain lines.
function AddOnFacts({ addOn, chemical, noProduct, colors }) {
  const sold = soldAreaText(addOn);
  const rate = chemical && governedRateText(addOn.governed);
  return (
    <>
      {sold && <div>{sold}</div>}
      {addOn.grassType === "st_augustine" && <div>Grass on the estimate: St. Augustine</div>}
      {rate && <div>Governed rate: {rate}.</div>}
      {chemical && !noProduct && addOn.governed?.withheld && <div style={{ color: colors.muted }}>Rate not filled in. {addOn.governed.withheld} Enter the rate from the label.</div>}
      {!chemical && <div style={{ color: colors.muted }}>No product to record for this add-on.</div>}
    </>
  );
}

// The product of one chemical add-on: what is recorded, or the picker with the governed product, or why there is nothing to pick.
function AddOnProduct({ addOn, recorded, offered, disabled, onAddProduct, colors, selectStyle }) {
  if (recorded.length > 0) {
    return <div>Recorded: {recorded.map((row) => row.displayName || row.name).join(", ")}. The rate and the treated square feet are required: enter them in its product row below.</div>;
  }
  if (offered.length === 0) {
    return <div role="status" data-testid="area-addon-no-product" style={{ fontWeight: 600 }}>{addOn.governed?.productNote || PRODUCT_UNAVAILABLE}</div>;
  }
  return (
    <>
      <div style={{ color: colors.muted }}>Product not recorded yet. Choose the product you used for this add-on.</div>
      <select
        aria-label={`Product used for ${addOn.name}`}
        value=""
        disabled={disabled}
        onChange={(event) => {
          const product = offered.find((row) => String(row.id) === event.target.value);
          if (product) onAddProduct(product, addOn);
        }}
        style={selectStyle}
      >
        <option value="">Choose a product</option>
        {offered.map((row) => <option key={row.id} value={row.id}>{row.display_name || row.name}</option>)}
      </select>
    </>
  );
}

export default function AreaAddOnFields({ service, selectedProducts, products, onAddProduct, disabled, colors, selectStyle, labelStyle }) {
  const addOns = hostAreaAddOns(service);
  const ownNote = service?.areaAddOnOwn?.governed?.productNote || null;
  if (addOns.length === 0) {
    return ownNote ? <div data-testid="area-addon-own-note" style={{ margin: "0 0 16px", fontSize: 14, color: colors.text }}>{ownNote}</div> : null;
  }
  const choices = [...(products || [])];
  return (
    <div style={{ display: "grid", gap: 12, margin: "0 0 16px" }} data-testid="area-addon-fields">
      <label style={labelStyle}>Add-on treatments on this visit</label>
      {addOns.map((addOn) => {
        const recorded = (selectedProducts || []).filter((row) => row.areaAddOnKey === addOn.key);
        const chemical = isChemicalAreaAddOnKey(addOn.key);
        // The add-on is governed to ONE product (the protocol's), which the server found in the catalog and sent by ID; the
        // picker offers only that one. The server flags any other product recorded for the add-on. With no governed product
        // to select (it is inactive or not in the catalog, or the lookup failed) nothing is offered, and the form says so.
        const offered = choices.filter((row) => isGovernedProduct(addOn.governed, row));
        const noProduct = chemical && recorded.length === 0 && offered.length === 0;
        return (
          <div key={addOn.key} style={{ border: `1px solid ${colors.border}`, borderRadius: 12, padding: 12, display: "grid", gap: 8, fontSize: 14, color: colors.text }}>
            <div style={{ fontWeight: 600 }}>{addOn.name}</div>
            <AddOnFacts addOn={addOn} chemical={chemical} noProduct={noProduct} colors={colors} />
            {chemical && <AddOnProduct addOn={addOn} recorded={recorded} offered={offered} disabled={disabled} onAddProduct={onAddProduct} colors={colors} selectStyle={selectStyle} />}
          </div>
        );
      })}
    </div>
  );
}

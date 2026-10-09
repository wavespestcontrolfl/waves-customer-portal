import { governedRateText, hostAreaAddOns, isChemicalAreaAddOnKey, soldAreaText } from "../../lib/areaAddOns";

// The add-on fields on a visit that has area add-ons attached as rows (GATE_AREA_ADDONS).
// The visit keeps its own full completion form; this block sits beside it and records
// each attached chemical add-on's product, pre-labelled with what the estimate sold and
// the governed rate. The product lands in the visit's ordinary product list as a row
// tagged with the add-on (`areaAddOnKey`), where its treated square feet are entered, so
// the server saves it like any other application row. The add-on that IS the visit is
// recorded in the generic product list (an untagged row is the visit's own) and is not
// listed here.
export default function AreaAddOnFields({ service, selectedProducts, products, onAddProduct, disabled, colors, selectStyle, labelStyle }) {
  const addOns = hostAreaAddOns(service);
  if (addOns.length === 0) return null;
  const choices = [...(products || [])].sort((a, b) => String(a.display_name || a.name || "").localeCompare(String(b.display_name || b.name || "")));
  return (
    <div style={{ display: "grid", gap: 12, margin: "0 0 16px" }} data-testid="area-addon-fields">
      <label style={labelStyle}>Add-on treatments on this visit</label>
      {addOns.map((addOn) => {
        const sold = soldAreaText(addOn);
        const recorded = (selectedProducts || []).filter((row) => row.areaAddOnKey === addOn.key);
        const chemical = isChemicalAreaAddOnKey(addOn.key);
        // The add-on is governed to ONE product (the protocol's); the picker offers only it. The server flags any other
        // product recorded for the add-on. With no governed product known (or none in the catalog) every product is offered.
        const governedName = String(addOn.governed?.productName || "").trim().toLowerCase();
        const governedChoices = governedName ? choices.filter((row) => String(row.name || "").trim().toLowerCase() === governedName) : [];
        const offered = governedChoices.length ? governedChoices : choices;
        return (
          <div key={addOn.key} style={{ border: `1px solid ${colors.border}`, borderRadius: 12, padding: 12, display: "grid", gap: 8, fontSize: 14, color: colors.text }}>
            <div style={{ fontWeight: 600 }}>{addOn.name}</div>
            {sold && <div>{sold}</div>}
            {addOn.grassType === "st_augustine" && <div>Grass on the estimate: St. Augustine</div>}
            {chemical && governedRateText(addOn.governed) && <div>Governed rate: {governedRateText(addOn.governed)}.</div>}
            {chemical && addOn.governed?.withheld && <div style={{ color: colors.muted }}>Rate not filled in. {addOn.governed.withheld} Enter the rate from the label.</div>}
            {!chemical && <div style={{ color: colors.muted }}>No product to record for this add-on.</div>}
            {chemical && recorded.length > 0 && (
              <div>Recorded: {recorded.map((row) => row.displayName || row.name).join(", ")}. The rate and the treated square feet are required: enter them in its product row below.</div>
            )}
            {chemical && recorded.length === 0 && (
              <>
                <div style={{ color: colors.muted }}>Product not recorded yet. Choose the product you used for this add-on.</div>
                <select
                  aria-label={`Product used for ${addOn.name}`}
                  value=""
                  disabled={disabled}
                  onChange={(event) => {
                    const product = choices.find((row) => String(row.id) === event.target.value);
                    if (product) onAddProduct(product, addOn);
                  }}
                  style={selectStyle}
                >
                  <option value="">Choose a product</option>
                  {offered.map((row) => <option key={row.id} value={row.id}>{row.display_name || row.name}</option>)}
                </select>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

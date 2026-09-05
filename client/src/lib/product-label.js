// Distributor forms carry a third segment (e.g. 432-1507-59144); junk values
// like "N/A" or "Not EPA-registered fertilizer" fail the pattern on purpose.
export const EPA_REG_PATTERN = /^\d+-\d+(-\d+)?$/;

export function productLabelLink(product) {
  if (!product) return null;
  if (product.labelUrl) {
    return { href: product.labelUrl, text: "Label", source: "on_file" };
  }
  const reg = String(product.epaRegNumber || "").trim();
  if (EPA_REG_PATTERN.test(reg)) {
    return {
      href: `https://ordspub.epa.gov/ords/pesticides/f?p=PPLS:102::::::P102_REG_NUM:${reg}`,
      text: "EPA label (PPLS)",
      source: "ppls",
    };
  }
  return null;
}

// Seeds the estimator form for a customer's new-home estimate (Moving PR B1).
//
// The office starts it from the Moving card. The form opens with the recurring
// services the customer already has, the new address, and nothing else carried
// over: the new house is measured again, a one-time job or a stale discount does
// not follow the customer, and the estimate is never part of a multi-property
// group (so the Multi-Home preset is never picked here).
//
// Pure: the component passes its default form and its property reset, and gets
// back the seeded form plus the label of a discount the old estimate had.

// Recurring services that move with the customer. Every other svc* flag goes off:
// termite bait, recurring termite foam, misting and every one-time service.
export const MOVE_KEPT_SERVICE_FLAGS = ["svcLawn", "svcPest", "svcTs", "svcInjection", "svcMosquito", "svcRodentBait"];

function hadDiscount(inputs) {
  const type = inputs.manualDiscountType;
  return !!inputs.manualDiscountPreset
    || (!!type && type !== "NONE")
    || (Array.isArray(inputs.serviceSpecificDiscountKeys) && inputs.serviceSpecificDiscountKeys.length > 0);
}

function discountLabel(inputs) {
  return String(inputs.manualDiscountLabel || inputs.manualDiscountPreset || "").trim()
    || (Array.isArray(inputs.serviceSpecificDiscountKeys) ? inputs.serviceSpecificDiscountKeys.join(", ") : "")
    || "discount";
}

// Discounts, price overrides, delivery choices and lead links start clean.
const CLEAN_FIELDS = Object.freeze({
  manualDiscountPreset: "",
  manualDiscountType: "NONE",
  manualDiscountValue: "",
  manualDiscountLabel: "",
  manualDiscountInternalReason: "",
  roachFeeOverride: "",
  standaloneRoachFeeOverride: "",
  showOneTimeOption: false,
  billByInvoice: false,
  offerTiers: false,
  _offerTiersDeclined: false,
  tierExtensionPick: null,
  notes: "",
  leadId: "",
  leadServiceInterest: "",
});

// The old estimate's services on the default form: the recurring ones that
// move stay on, every other svc* flag goes off, misting sizing returns to the
// defaults, and the builder's bookkeeping flags (_homeSqFtEdited and the like)
// are dropped because they describe the old house.
function movedServices(base, inputs) {
  const form = { ...base, ...inputs };
  for (const key of Object.keys(form)) {
    if (key.startsWith("_") && !(key in base)) delete form[key];
    else if (key.startsWith("svc")) form[key] = MOVE_KEPT_SERVICE_FLAGS.includes(key) && inputs[key] === true;
    else if (key.startsWith("misting")) form[key] = base[key];
  }
  // A saved retired Tree & Shrub program (4x light) opens as the standard program.
  if (inputs.tsTier !== undefined) form.tsTier = inputs.tsTier === "enhanced" ? "enhanced" : "standard";
  return form;
}

// Who and where: the customer on file and the move's new address.
function contactFields(data) {
  const customer = data?.customer || {};
  return {
    customerId: customer.id || "",
    customerName: customer.name || "",
    customerPhone: customer.phone || "",
    customerEmail: customer.email || "",
    address: data?.move?.address || "",
    isRecurringCustomer: data?.isRecurringCustomer ? "YES" : "NO",
  };
}

/**
 * @param data   the estimate-source answer: { move, customer, isRecurringCustomer, source: { inputs } | null }
 * @param base   the builder's default form (buildDefaultEstimateForm())
 * @param clearedProperty  the builder's property reset fields (clearedPropertyFields())
 * @returns { form, droppedDiscountLabel }  droppedDiscountLabel is "" when the old estimate had no discount
 */
export function moveEstimateForm(data, { base, clearedProperty = {} }) {
  const inputs = data?.source?.inputs && typeof data.source.inputs === "object" ? data.source.inputs : {};
  // The new house is measured again (clearedProperty), so nothing sized for the old one carries over.
  const form = {
    ...movedServices(base, inputs),
    ...CLEAN_FIELDS,
    // Fresh containers each time: the form's lists are never shared between estimates.
    serviceSpecificDiscountKeys: [],
    linePriceOverrides: {},
    ...clearedProperty,
    ...contactFields(data),
  };
  return { form, droppedDiscountLabel: hadDiscount(inputs) ? discountLabel(inputs) : "" };
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-11-14" -> "Nov 14, 2026". A calendar date: never through new Date(iso),
// which reads it as UTC and shows the day before in US time zones.
export function formatCalendarDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return "";
  return `${MONTH_NAMES[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

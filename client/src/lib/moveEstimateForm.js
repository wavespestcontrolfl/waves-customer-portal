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

// Recurring services that move with the customer, and the only settings each
// one carries over: its schedule or program. Everything else starts from the
// builder's defaults, because it describes the old house or the old sale
// (sizes, grass type, station counts, roach condition, price overrides,
// one-time work, termite, recurring termite foam, misting, and palm
// injection, whose program depends on the palms at each house).
const MOVE_PROGRAM_KEYS = Object.freeze({
  svcLawn: ["lawnFreq"],
  svcPest: ["pestFreq"],
  svcTs: ["tsTier"],
  svcMosquito: ["mosquitoProgram"],
  svcRodentBait: [],
});
export const MOVE_KEPT_SERVICE_FLAGS = Object.keys(MOVE_PROGRAM_KEYS);

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

// The default form with the kept services switched on and their schedules copied.
function movedServices(base, inputs) {
  const form = { ...base };
  for (const [flag, keys] of Object.entries(MOVE_PROGRAM_KEYS)) {
    if (inputs[flag] !== true) continue;
    form[flag] = true;
    for (const key of keys) {
      if (inputs[key] !== undefined && inputs[key] !== null && inputs[key] !== "") form[key] = inputs[key];
    }
  }
  // A saved retired Tree & Shrub program (4x light) opens as the standard program.
  if (form.svcTs) form.tsTier = form.tsTier === "enhanced" ? "enhanced" : "standard";
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
  const form = { ...movedServices(base, inputs), ...clearedProperty, ...contactFields(data) };
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

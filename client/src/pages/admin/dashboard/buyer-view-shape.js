// The containers BuyerViewRow reads from /admin/dashboard/buyer-view. A response missing any of them is malformed, and the
// row shows its unavailable state instead of reading a field of undefined. (planRevenueKept may be { error }, still a record.)
const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const CONTAINERS = ["months", "revenue", "recurring", "planRevenueKept", "grossMargin", "ownerProfit", "officeCost"];

export function isBuyerViewPayload(value) {
  return isRecord(value) && !value.error && CONTAINERS.every((key) => isRecord(value[key]));
}

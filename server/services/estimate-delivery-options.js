function validateEstimateDeliveryOptions({
  showOneTimeOption,
  billByInvoice,
  onetimeTotal,
  monthlyTotal,
  annualTotal,
}) {
  const oneTimeAmount = Number(onetimeTotal || 0);
  const recurringAmount = Math.max(Number(monthlyTotal || 0), Number(annualTotal || 0));
  if (showOneTimeOption && oneTimeAmount <= 0) {
    return 'Offer one-time option requires a one-time total on the estimate.';
  }
  if (billByInvoice && oneTimeAmount <= 0 && recurringAmount <= 0) {
    return 'Bill by invoice requires a billable recurring or one-time total.';
  }
  return null;
}

module.exports = {
  validateEstimateDeliveryOptions,
};

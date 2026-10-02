// Annual rate review: the renewal writers (Customer 360 → Annual prepay, both
// routes, and Invoices → Mark as annual prepay) refuse with 409
// RENEWAL_AMOUNT_NOTICED when the amount being charged differs from the one
// the rate-review notice told the customer. Owner ruling 2026-10-01: staff
// may charge the different amount on purpose — ask once, and on confirm
// resend with acknowledgeNoticedAmount: true (the server records who did it
// and both amounts). Cancel sends nothing more.

export const NOTICED_AMOUNT_DECLINED = 'NOTICED_AMOUNT_DECLINED';

const money = (n) => `$${Number(n).toFixed(2)}`;

// The parsed 409 body rides on err.body (or err.details, utils/admin-fetch).
export function noticedRenewalAmountRefusal(err) {
  const body = err?.body || err?.details;
  if (err?.status !== 409 || body?.code !== 'RENEWAL_AMOUNT_NOTICED') return null;
  const noticedAmount = Number(body.noticedAmount);
  const chargedAmount = Number(body.chargedAmount);
  // $0 is a real charged amount (never "missing"); a blank one is not.
  if (body.chargedAmount == null || body.chargedAmount === '') return null;
  if (!(noticedAmount > 0) || !Number.isFinite(chargedAmount) || chargedAmount < 0) return null;
  return { noticedAmount, chargedAmount };
}

export function noticedRenewalAmountPrompt({ noticedAmount, chargedAmount }) {
  return `The customer was told ${money(noticedAmount)}. Charge ${money(chargedAmount)} instead?`;
}

// `send(extra)` posts the request with `extra` merged into its body.
export async function sendWithNoticedAmountConfirm(send, confirmFn = (msg) => window.confirm(msg)) {
  try {
    return await send({});
  } catch (err) {
    const refusal = noticedRenewalAmountRefusal(err);
    if (!refusal) throw err;
    if (!confirmFn(noticedRenewalAmountPrompt(refusal))) {
      const declined = new Error(`Not saved. The customer was told ${money(refusal.noticedAmount)} for this renewal.`);
      declined.code = NOTICED_AMOUNT_DECLINED;
      throw declined;
    }
    return send({ acknowledgeNoticedAmount: true });
  }
}

// useCustomerCards — loads a customer's saved payment methods from
// GET /api/admin/customers/:id/cards (the same lightweight endpoint the
// Card on File tender sheet uses) so surfaces like the appointment detail
// sheet and the checkout sheet can tell the tech whether a card is on
// file BEFORE they pick a tender.
//
// Returns { cards }:
//   cards  null  — unknown (no customer id, still loading, or the fetch
//                  failed). Callers must render NOTHING in this state: a
//                  false "No card on file" would send the tech chasing
//                  cash from an autopay customer.
//          array — resolved payment_methods rows (server orders default
//                  first): { id, method_type, brand, last_four,
//                  exp_month, exp_year, bank_name, is_default }.
import { useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

// End-of-month expiry check; rows without expiry data (ACH) never expire.
export function isCardExpired(card, now = new Date()) {
  if (!card?.exp_month || !card?.exp_year) return false;
  return new Date(card.exp_year, card.exp_month, 0, 23, 59, 59) < now;
}

// The card a charge would realistically use: the first non-expired method
// (server puts the default first), falling back to the expired default so
// the caller can label it as expired rather than claiming nothing is saved.
export function chargeableCardOnFile(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return null;
  return cards.find((c) => !isCardExpired(c)) || cards[0];
}

// "Visa 9710" / "Chase 1234" — same wording as the Card on File tender rows.
export function cardOnFileTitle(card) {
  if (!card) return '';
  if (card.method_type === 'ach') {
    return `${card.bank_name || 'Bank'} ${card.last_four}`;
  }
  const brand = card.brand
    ? card.brand.charAt(0).toUpperCase() + card.brand.slice(1).toLowerCase()
    : 'Card';
  return `${brand} ${card.last_four}`;
}

export function useCustomerCards(customerId) {
  const [cards, setCards] = useState(null);

  useEffect(() => {
    setCards(null);
    if (!customerId) return undefined;
    let cancelled = false;
    fetch(`${API_BASE}/admin/customers/${customerId}/cards`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` },
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { if (!cancelled) setCards(Array.isArray(d.cards) ? d.cards : null); })
      .catch(() => {}); // stay null — unknown, not "none"
    return () => { cancelled = true; };
  }, [customerId]);

  return { cards };
}

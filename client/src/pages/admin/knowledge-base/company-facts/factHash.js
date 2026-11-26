// The hash the server expects on Approve: SHA-256 (hex) of the UTF-8 bytes of the fact text, trimmed.
// Server side (company-facts-bank.js approveFact): sha256(String(row.fact_text || '').trim()), where sha256 hashes the
// string as UTF-8. String.prototype.trim is the same function on both sides, so the two always agree.
// factHash.test.jsx and server/tests/company-facts-bank.test.js assert the same fixed vectors.
export async function factTextSha256(text) {
  const bytes = new TextEncoder().encode(String(text == null ? "" : text).trim());
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

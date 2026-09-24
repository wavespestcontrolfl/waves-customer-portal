// @vitest-environment jsdom
// Codex P2 (CommunicationsPageV2.jsx ~:788): the full Communications
// composer tracked an inserted consultation link by exact URL. Every
// consultation mint is a FRESH short code (a new 14-day token), and an
// operator edit to even one character of the inserted URL made that
// insert's OWN url unrecognizable too — so a repeat "Free consultation"
// pick had no prior clause to strip and appended a SECOND full invitation
// (with its own "Reply STOP to opt out." line) while the edited, now-dead
// link and its copy lingered in the draft. Fixed by sharing
// CustomerSmsPanel's combineAppendedDraft merge (client/src/lib/
// composerLinks.js): exact remembered line -> remembered line's URL still
// present -> wording+host heuristic, with the replaced invite's own footer
// lines dropped so they're never doubled.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SmsTab } from "./CommunicationsPageV2";

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useOutletContext: () => ({ user: { role: "admin" } }) };
});

let responses;
const response = (data) => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
const requests = (path) => fetch.mock.calls.filter(([url]) => String(url).endsWith(path));

beforeEach(() => {
  responses = {};
  localStorage.setItem("waves_admin_token", "test-token");
  window.history.replaceState({}, "", "/?phone=9415551234");
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const value = responses[String(url).replace(/^\/api/, "")];
    return response(typeof value === "function" ? await value() : value || {});
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });

it("replaces an edited consultation link on re-insert instead of appending a second invitation", async () => {
  // Every consultation mint is a fresh short code — the second insert's
  // link is a DIFFERENT token from the first, same as production.
  let consultCalls = 0;
  responses["/admin/communications/customer-link"] = () => {
    consultCalls += 1;
    const token = consultCalls === 1 ? "token1" : "token2";
    return {
      kind: "consultation",
      url: `https://waves.link/l/${token}`,
      line: `Hi Jamie, it's Waves. Pick a time for us to stop by for a free consultation: https://waves.link/l/${token}\n\nReply STOP to opt out.\n\n`,
      standalone: true,
      firstName: "Jamie",
      leadId: "lead-99",
    };
  };
  responses["/admin/communications/link-library"] = { links: [], consultationLinksEnabled: true };

  render(<SmsTab active onSent={vi.fn()} />, { wrapper: MemoryRouter });

  // First insert.
  fireEvent.click(await screen.findByRole("button", { name: "Quick Links" }));
  fireEvent.click(await screen.findByRole("button", { name: /Free consultation/i }));
  await waitFor(() => expect(requests("/admin/communications/customer-link")).toHaveLength(1));
  const textbox = await screen.findByRole("textbox", { name: "Text message" });
  await waitFor(() => expect(textbox.value).toContain("token1"));

  // Operator edits one character inside the inserted short link, leaving a
  // dead token — the tracking effect (bodyHasLink) forgets the exact-URL
  // entry the instant this fires.
  const edited = textbox.value.replace("token1", "tokenX1");
  fireEvent.change(textbox, { target: { value: edited } });
  await waitFor(() => expect(textbox.value).toBe(edited));

  // Second insert, same kind — must replace the (now-edited, dead) prior
  // clause rather than stack a second one.
  fireEvent.click(await screen.findByRole("button", { name: "Quick Links" }));
  fireEvent.click(await screen.findByRole("button", { name: /Free consultation/i }));
  await waitFor(() => expect(requests("/admin/communications/customer-link")).toHaveLength(2));
  await waitFor(() => expect(textbox.value).toContain("token2"));

  const finalBody = textbox.value;
  // The edited, dead link (and its copy) are gone.
  expect(finalBody).not.toContain("tokenX1");
  expect(finalBody).not.toContain("token1");
  // Exactly one invitation and exactly one STOP disclosure — never doubled.
  expect(finalBody.match(/free consultation/gi) || []).toHaveLength(1);
  expect(finalBody.match(/Reply STOP to opt out\./g) || []).toHaveLength(1);
  expect(finalBody.match(/token2/g) || []).toHaveLength(1);
});


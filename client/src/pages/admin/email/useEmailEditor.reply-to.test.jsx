// @vitest-environment jsdom
// Audit repro r1-comms-2: the manual reply from the admin Email tab posts
// `to: email.from_address` and never consults the stored `reply_to`, so a
// relayed message (contact form / ticketing, From = provider no-reply,
// Reply-To = the customer) is answered to the no-reply mailbox.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const adminFetch = vi.fn();
vi.mock("./emailApi", () => ({ adminFetch: (...args) => adminFetch(...args) }));

import useEmailEditor from "./useEmailEditor";

const json = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  adminFetch.mockImplementation(() => json({ success: true, status: "provider_accepted", messageId: "m1" }));
});
afterEach(() => { cleanup(); adminFetch.mockReset(); });

it("manual reply targets From, ignoring the stored Reply-To", async () => {
  const email = {
    id: "e1",
    from_address: "noreply@relay.example",
    from_name: "Forms Relay",
    reply_to: "customer@example.com",
    subject: "New inquiry",
    gmail_thread_id: "t1",
  };
  const { result } = renderHook(() => useEmailEditor("u1"));
  await act(async () => { result.current.setReplyDraft(email.id, "Thanks, we can come Tuesday."); });
  await act(async () => { await result.current.handleReply(email, async () => {}); });

  const sends = adminFetch.mock.calls.filter(([path, opts]) => path === "/api/admin/email/send" && opts?.method === "POST");
  expect(sends).toHaveLength(1);
  const body = JSON.parse(sends[0][1].body);
  // Expected (server draft rule, email-actions.js): reply_to || from_address.
  expect(body.to).toBe("customer@example.com");
});

// composerAcceptsServerSender gates the home-line sender preselect (PR 3):
// SmsTab checks it before asking GET /admin/communications/sender AND again
// when the response lands, so a line staff picked or a draft started while
// the request was in flight is never overwritten.
import { describe, expect, it } from "vitest";
import { composerAcceptsServerSender } from "./CommunicationsPageV2";

const fresh = { line: "+19412975749", body: "", attachmentCount: 0, loadedDraft: false };

describe("composerAcceptsServerSender", () => {
  it("accepts a fresh composer whose line is unchanged since the request", () => {
    expect(composerAcceptsServerSender(fresh, "+19412975749")).toBe(true);
    expect(composerAcceptsServerSender({ ...fresh, line: "" }, "")).toBe(true);
  });

  it("delayed response: staff changed the sending line meanwhile — keep theirs", () => {
    expect(composerAcceptsServerSender({ ...fresh, line: "+19412972606" }, "+19412975749")).toBe(false);
  });

  it("delayed response: staff started composing meanwhile — keep the line", () => {
    expect(composerAcceptsServerSender({ ...fresh, body: "On my way" }, "+19412975749")).toBe(false);
    expect(composerAcceptsServerSender({ ...fresh, attachmentCount: 1 }, "+19412975749")).toBe(false);
  });

  it("the automatic customer-sender line set meanwhile is initialization, not a staff pick", () => {
    expect(composerAcceptsServerSender({ ...fresh, line: "+19415550199", autoLine: "+19415550199" }, "")).toBe(true);
    expect(composerAcceptsServerSender({ ...fresh, line: "+19412972606", autoLine: "+19415550199" }, "")).toBe(false);
  });

  it("a loaded draft keeps its own line", () => {
    expect(composerAcceptsServerSender({ ...fresh, loadedDraft: true }, "+19412975749")).toBe(false);
  });

  it("whitespace-only body still counts as fresh", () => {
    expect(composerAcceptsServerSender({ ...fresh, body: "   " }, "+19412975749")).toBe(true);
  });
});

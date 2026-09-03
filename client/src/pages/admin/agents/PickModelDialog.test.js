import { describe, expect, it } from "vitest";
import { optionsFor } from "./PickModelDialog";

const catalog = {
  opus: { label: "Opus", provider: "anthropic", caps: ["text", "vision"], status: "current" },
  fable: { label: "Fable", provider: "anthropic", caps: ["text", "vision"], status: "current", requires: "deep" },
  luna: { label: "Luna", provider: "openai", caps: ["text"], status: "current" },
  whisper: { label: "gpt-4o-transcribe", provider: "openai", caps: [], status: "current" },
};
const ids = (list) => list.map((m) => m.id).sort();

describe("optionsFor", () => {
  it("requires the lane's provider and modality; empty caps never fit", () => {
    expect(ids(optionsFor(catalog, { providers: ["openai"], cap: "text" }))).toEqual(["luna"]);
    expect(ids(optionsFor(catalog, { providers: ["openai"], cap: "vision" }))).toEqual([]);
  });

  it("deep-only models are offered only to deep-safe targets", () => {
    expect(ids(optionsFor(catalog, { providers: ["anthropic"], cap: "text" }))).toEqual(["opus"]);
    expect(ids(optionsFor(catalog, { providers: ["anthropic"], cap: "text", deep: true }))).toEqual(["fable", "opus"]);
  });

  it("a migration set offers a model that fits ANY of its envs' requirements", () => {
    const any = [
      { providers: ["anthropic"], cap: "vision" },
      { providers: ["anthropic"], cap: "text", deep: true },
      { providers: ["openai"], cap: "text" },
    ];
    expect(ids(optionsFor(catalog, { providers: ["anthropic", "openai"], cap: "vision", deep: true, any }, "opus"))).toEqual(["fable", "luna"]);
  });
});

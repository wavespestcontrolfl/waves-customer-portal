// @vitest-environment node
import { describe, expect, it } from "vitest";
import { factTextSha256 } from "./factHash";

// The same vectors, with the same digests, sit in server/tests/company-facts-bank.test.js, which hashes them with the
// server's sha256(String(text).trim()). Both suites passing means the page and the server agree, unicode included.
const HASH_VECTORS = [
  ["We service Parrish.", "c57a55f5bdf7d857dde8598b504227e47e0884a02575db5b0e3d4bd3e79e0844"],
  ["  We service Parrish.  \n", "c57a55f5bdf7d857dde8598b504227e47e0884a02575db5b0e3d4bd3e79e0844"],
  ["Café opens early — niño, naïve, 日本語, 🦟 bugs.", "c185faf759bc6a38d33c76975557af29856c3c47e8e4af1003ec6d846f09a311"],
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["Tab\tinside", "a8341bbb0dbef7ce24463a17edf0b5cb2b649f8baf6720de50ca6011d1337859"],
  [" nbsp edge ", "cf76e3929646075b6442b7da2805bad8930fdae9a258df83eac09a64e3ff0b66"],
  ["a​b", "8df62aef5f92e4c30c0c938497f55f60078c361a476e7e0448485194ad79f884"],
  ["é vs é", "832caca12d18b70335221a2f851239bcaf2705d20438fbd146adffdf6099865d"],
];

describe("factTextSha256", () => {
  it.each(HASH_VECTORS)("hashes %j the way the server does", async (text, digest) => {
    expect(await factTextSha256(text)).toBe(digest);
  });

  it("treats a missing text as the empty text, like the server's String(x || '')", async () => {
    expect(await factTextSha256(null)).toBe(HASH_VECTORS[3][1]);
  });
});

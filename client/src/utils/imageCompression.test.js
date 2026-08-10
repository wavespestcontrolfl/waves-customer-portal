import { describe, it, expect, vi } from "vitest";
import {
  fitImagesToBudget,
  isCompressibleImage,
  isAnimatedImage,
  formatBytes,
  totalBytes,
  MMS_TOTAL_BUDGET_BYTES,
  TWILIO_MMS_TOTAL_BYTES,
} from "./imageCompression";

// Build a fake File whose header bytes are sniffable, for animation detection.
function fileWithBytes(name, type, bytes, size = 1024) {
  return {
    name,
    type,
    size,
    slice: (start = 0, end = bytes.length) => ({
      arrayBuffer: async () => bytes.slice(start, end).buffer,
    }),
  };
}

// Real PNG container bytes: 8-byte signature, then length(4, big-endian) +
// type(4) + payload + CRC(4) chunks.
function pngBytes(chunks) {
  const out = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (const { type, payload = [] } of chunks) {
    const n = payload.length;
    out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
    for (const ch of type) out.push(ch.charCodeAt(0));
    out.push(...payload);
    out.push(0, 0, 0, 0); // CRC — not validated by the sniff
  }
  return new Uint8Array(out);
}

const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));

const MB = 1024 * 1024;

// A stand-in for a picked File. jsdom has no canvas, so every test injects a
// fake encoder and asserts on the ladder/budget logic, which is where the
// behavior that matters lives.
function fakeFile(name, size, type = "image/jpeg") {
  return { name, size, type, lastModified: 0 };
}

// Encoder that shrinks by a fixed ratio per rung, mimicking the real ladder:
// later (lower-quality) rungs produce smaller output.
function encoderShrinkingByRung(ratios) {
  const seen = [];
  const encode = vi.fn(async (file, rung) => {
    let idx = seen.findIndex(
      (r) => r.maxEdge === rung.maxEdge && r.quality === rung.quality,
    );
    if (idx === -1) {
      seen.push(rung);
      idx = seen.length - 1;
    }
    const ratio = ratios[Math.min(idx, ratios.length - 1)];
    return {
      ...file,
      name: file.name.replace(/\.[^.]+$/, ".jpg"),
      type: "image/jpeg",
      size: Math.round(file.size * ratio),
    };
  });
  encode.rungs = seen;
  return encode;
}

describe("budget constants", () => {
  it("targets a budget strictly under Twilio’s hard 5MB ceiling", () => {
    expect(MMS_TOTAL_BUDGET_BYTES).toBeLessThan(TWILIO_MMS_TOTAL_BYTES);
    expect(TWILIO_MMS_TOTAL_BYTES).toBe(5 * MB);
  });
});

describe("isCompressibleImage", () => {
  it("accepts the two formats this composer actually sees", () => {
    // iPhone camera photos are JPEG; iOS screenshots are PNG.
    expect(isCompressibleImage(fakeFile("a.jpg", 1, "image/jpeg"))).toBe(true);
    expect(isCompressibleImage(fakeFile("a.png", 1, "image/png"))).toBe(true);
  });

  it("passes every other format through rather than parsing its container", () => {
    // Deliberate scope limit: no per-format animation parser, so these are
    // never re-encoded and can never be silently flattened.
    expect(isCompressibleImage(fakeFile("a.gif", 1, "image/gif"))).toBe(false);
    expect(isCompressibleImage(fakeFile("a.webp", 1, "image/webp"))).toBe(
      false,
    );
    expect(isCompressibleImage(fakeFile("a.heic", 1, "image/heic"))).toBe(
      false,
    );
  });

  it("refuses non-images", () => {
    expect(isCompressibleImage(fakeFile("a.pdf", 1, "application/pdf"))).toBe(
      false,
    );
    expect(isCompressibleImage(null)).toBe(false);
  });
});

describe("isAnimatedImage", () => {
  it("only answers for PNG — every other format is excluded by type", async () => {
    // GIF/WebP never reach this check: isCompressibleImage already refuses
    // them, so they are passed through whatever this returns.
    await expect(
      isAnimatedImage(fakeFile("a.gif", 1, "image/gif")),
    ).resolves.toBe(false);
    await expect(
      isAnimatedImage(fakeFile("a.jpg", 1, "image/jpeg")),
    ).resolves.toBe(false);
  });

  it("detects APNG via the acTL chunk", async () => {
    const bytes = pngBytes([
      { type: "IHDR", payload: new Array(13).fill(0) },
      { type: "acTL", payload: new Array(8).fill(0) },
      { type: "IDAT", payload: [1, 2, 3] },
    ]);
    await expect(
      isAnimatedImage(fileWithBytes("a.png", "image/png", bytes)),
    ).resolves.toBe(true);
  });

  it("is not fooled by 'IDAT' occurring inside an ancillary chunk payload", async () => {
    // A tEXt comment containing the four bytes "IDAT" would bound a raw byte
    // scan at a phantom chunk and misreport this real APNG as a still.
    const bytes = pngBytes([
      { type: "IHDR", payload: new Array(13).fill(0) },
      { type: "tEXt", payload: ascii("Comment: IDAT appears here") },
      { type: "acTL", payload: new Array(8).fill(0) },
      { type: "IDAT", payload: [1, 2, 3] },
    ]);
    await expect(
      isAnimatedImage(fileWithBytes("a.png", "image/png", bytes)),
    ).resolves.toBe(true);
  });

  it("does not treat a still PNG as animated", async () => {
    const bytes = pngBytes([
      { type: "IHDR", payload: new Array(13).fill(0) },
      { type: "IDAT", payload: [1, 2, 3] },
    ]);
    await expect(
      isAnimatedImage(fileWithBytes("a.png", "image/png", bytes)),
    ).resolves.toBe(false);
  });

  it("is not fooled by 'acTL' bytes inside compressed pixel data", async () => {
    // Past the first IDAT, those four characters are just pixel bytes.
    const bytes = pngBytes([
      { type: "IHDR", payload: new Array(13).fill(0) },
      { type: "IDAT", payload: ascii("acTL and more pixels") },
    ]);
    await expect(
      isAnimatedImage(fileWithBytes("a.png", "image/png", bytes)),
    ).resolves.toBe(false);
  });

  it("fails safe when a PNG prefix ends before IDAT", async () => {
    // Header + IHDR only: neither acTL nor IDAT was reached, so the answer is
    // "unknown" and must not be reported as a still.
    const bytes = pngBytes([{ type: "IHDR", payload: new Array(13).fill(0) }]);
    await expect(
      isAnimatedImage(fileWithBytes("a.png", "image/png", bytes)),
    ).resolves.toBe(true);
  });

  it("treats a file that is not really a PNG as still", async () => {
    // Wrong signature: nothing to parse, and canvas will either decode it
    // (harmlessly, it can't animate) or fail and pass the original through.
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await expect(
      isAnimatedImage(fileWithBytes("a.png", "image/png", bytes)),
    ).resolves.toBe(false);
  });

  it("fails safe — an unreadable header counts as animated", async () => {
    const broken = {
      name: "x.png",
      type: "image/png",
      size: 10,
      slice: () => ({
        arrayBuffer: async () => {
          throw new Error("unreadable");
        },
      }),
    };
    await expect(isAnimatedImage(broken)).resolves.toBe(true);
  });

  it("ignores formats that cannot animate", async () => {
    await expect(
      isAnimatedImage(fakeFile("a.jpg", 1, "image/jpeg")),
    ).resolves.toBe(false);
  });
});

describe("fitImagesToBudget", () => {
  it("encodes sequentially so only one raster is live at a time", async () => {
    // A concurrent implementation would let both calls overlap; this asserts
    // call N finishes before call N+1 starts.
    let inFlight = 0;
    let maxInFlight = 0;
    const encode = vi.fn(async (file) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { ...file, size: Math.round(file.size * 0.2) };
    });

    const files = Array.from({ length: 5 }, (_, i) =>
      fakeFile(`p${i}.jpg`, 2 * MB),
    );
    const res = await fitImagesToBudget(files, {
      availableBytes: 4.5 * MB,
      encodeImage: encode,
      detectAnimated: async () => false,
    });

    expect(res.ok).toBe(true);
    expect(maxInFlight).toBe(1);
  });

  it("fails immediately when preserved files alone exhaust the budget", async () => {
    // A 4.1MB GIF can't be recompressed, so with 4MB available no rung can
    // ever fit — the encoder must never run.
    const encode = vi.fn();
    const gif = fakeFile("big.gif", 4.1 * MB, "image/gif");
    const photos = Array.from({ length: 5 }, (_, i) =>
      fakeFile(`p${i}.jpg`, 3 * MB),
    );

    const res = await fitImagesToBudget([gif, ...photos], {
      availableBytes: 4 * MB,
      encodeImage: encode,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("over-budget");
    expect(encode).not.toHaveBeenCalled();
    expect(res.bestBytes).toBe(4.1 * MB);
    // The five photos necessarily add to that subtotal, so the caller must
    // present it as "at least" rather than as the achievable total.
    expect(res.bestBytesIsFloor).toBe(true);
  });

  it("marks a ladder-exhausted total as exact, not a floor", async () => {
    // Here bestBytes is a total some rung actually produced, so there is no
    // "at least" hedge to add.
    const encode = encoderShrinkingByRung([0.9]);
    const files = [fakeFile("a.jpg", 5 * MB), fakeFile("b.jpg", 5 * MB)];

    const res = await fitImagesToBudget(files, {
      availableBytes: 2 * MB,
      encodeImage: encode,
      detectAnimated: async () => false,
    });

    expect(res.ok).toBe(false);
    expect(res.bestBytesIsFloor).toBe(false);
    expect(res.bestBytes).toBe(9 * MB);
  });

  it("still runs the ladder when preserved files leave room", async () => {
    const encode = vi.fn(async (file) => ({ ...file, size: 0.5 * MB }));
    const gif = fakeFile("small.gif", 1 * MB, "image/gif");
    const photo = fakeFile("p.jpg", 8 * MB);

    const res = await fitImagesToBudget([gif, photo], {
      availableBytes: 4 * MB,
      encodeImage: encode,
    });

    expect(res.ok).toBe(true);
    expect(encode).toHaveBeenCalled();
    expect(res.files[0]).toBe(gif);
  });

  it("passes an animated PNG through instead of flattening it", async () => {
    const encode = vi.fn(async (file) => ({
      ...file,
      size: Math.round(file.size * 0.1),
    }));
    const apng = fakeFile("loop.png", 2 * MB, "image/png");
    const jpg = fakeFile("photo.jpg", 4 * MB);

    const res = await fitImagesToBudget([apng, jpg], {
      availableBytes: 4.5 * MB,
      encodeImage: encode,
      detectAnimated: async (f) => f.name === "loop.png",
    });

    expect(res.ok).toBe(true);
    expect(res.files[0]).toBe(apng); // untouched, animation intact
    expect(encode).not.toHaveBeenCalledWith(apng, expect.anything());
  });

  it("restores originals whose extra bytes fit the leftover headroom", async () => {
    // Budget 5MB. Originals 3MB + 3MB = 6MB, over. At the winning rung each
    // compresses to 1MB (total 2MB), leaving 3MB of headroom — enough to put
    // ONE 3MB original back byte-for-byte (1 + 3 = 4MB <= 5MB).
    const encode = vi.fn(async (file) => ({ ...file, size: 1 * MB }));
    const a = fakeFile("a.jpg", 3 * MB);
    const b = fakeFile("b.jpg", 3 * MB);

    const res = await fitImagesToBudget([a, b], {
      availableBytes: 5 * MB,
      encodeImage: encode,
      detectAnimated: async () => false,
    });

    expect(res.ok).toBe(true);
    expect(res.finalBytes).toBeLessThanOrEqual(5 * MB);
    const restored = res.files.filter((f, i) => f === [a, b][i]);
    expect(restored).toHaveLength(1); // one original survives losslessly
  });

  it("never restores so much that the batch goes back over budget", async () => {
    // Reaching the ladder means the originals exceed the budget, so restoring
    // ALL of them is by definition impossible — the invariant that matters is
    // that greedy restoration never overshoots.
    const encode = vi.fn(async (file) => ({ ...file, size: 1 * MB }));
    const files = [
      fakeFile("a.jpg", 3 * MB),
      fakeFile("b.jpg", 3 * MB),
      fakeFile("c.jpg", 3 * MB),
    ];

    const res = await fitImagesToBudget(files, {
      availableBytes: 5 * MB,
      encodeImage: encode,
      detectAnimated: async () => false,
    });

    expect(res.ok).toBe(true);
    expect(res.finalBytes).toBeLessThanOrEqual(5 * MB);
    expect(res.compressed).toBe(true);
  });

  it("leaves a batch that already fits completely untouched", async () => {
    const encode = vi.fn();
    const files = [fakeFile("a.jpg", 1 * MB), fakeFile("b.jpg", 2 * MB)];

    const res = await fitImagesToBudget(files, {
      availableBytes: MMS_TOTAL_BUDGET_BYTES,
      encodeImage: encode,
    });

    expect(res.ok).toBe(true);
    expect(res.compressed).toBe(false);
    expect(res.files).toEqual(files); // same objects, not re-encoded copies
    expect(encode).not.toHaveBeenCalled();
  });

  it("stops at the FIRST rung that fits rather than compressing all the way down", async () => {
    // Rung 0 gets it to 4.0MB, which is already under budget — we must not
    // walk further down the ladder and shed quality we did not need to.
    const encode = encoderShrinkingByRung([0.4, 0.2, 0.1]);
    const files = [fakeFile("a.jpg", 5 * MB), fakeFile("b.jpg", 5 * MB)];

    const res = await fitImagesToBudget(files, {
      availableBytes: 4.5 * MB,
      encodeImage: encode,
    });

    expect(res.ok).toBe(true);
    expect(res.compressed).toBe(true);
    expect(res.finalBytes).toBe(4 * MB);
    expect(encode.rungs).toHaveLength(1); // only the top rung was tried
  });

  it("descends the ladder until it fits when the top rung is not enough", async () => {
    const encode = encoderShrinkingByRung([0.9, 0.6, 0.3]);
    const files = [fakeFile("a.jpg", 5 * MB), fakeFile("b.jpg", 5 * MB)];

    const res = await fitImagesToBudget(files, {
      availableBytes: 4.5 * MB,
      encodeImage: encode,
    });

    expect(res.ok).toBe(true);
    expect(res.finalBytes).toBe(3 * MB); // 10MB at the third rung's 0.3
    expect(encode.rungs).toHaveLength(3);
  });

  it("keeps the original when a re-encode comes out bigger", async () => {
    // Small already-optimized images routinely inflate on re-encode. The
    // 4MB file shrinks, the 200KB one bloats and must be left alone.
    const encode = vi.fn(async (file) =>
      file.size > MB
        ? { ...file, size: Math.round(file.size * 0.3) }
        : { ...file, size: file.size * 3 },
    );
    const small = fakeFile("small.png", 200 * 1024, "image/png");
    const big = fakeFile("big.jpg", 4 * MB);

    const res = await fitImagesToBudget([small, big], {
      availableBytes: 2 * MB,
      encodeImage: encode,
    });

    expect(res.ok).toBe(true);
    expect(res.files[0]).toBe(small); // identity preserved — original kept
    expect(res.files[1].size).toBe(Math.round(4 * MB * 0.3));
  });

  it("passes GIFs through uncompressed but still counts them against the budget", async () => {
    const encode = vi.fn(async (file) => ({
      ...file,
      size: Math.round(file.size * 0.1),
    }));
    const gif = fakeFile("loop.gif", 3 * MB, "image/gif");
    const jpg = fakeFile("photo.jpg", 4 * MB);

    const res = await fitImagesToBudget([gif, jpg], {
      availableBytes: 4.5 * MB,
      encodeImage: encode,
    });

    expect(res.ok).toBe(true);
    expect(res.files[0]).toBe(gif);
    expect(encode).not.toHaveBeenCalledWith(gif, expect.anything());
    expect(res.finalBytes).toBe(3 * MB + Math.round(4 * MB * 0.1));
  });

  it("reports failure instead of silently overshooting when nothing fits", async () => {
    const gif = fakeFile("huge.gif", 9 * MB, "image/gif"); // never compressible

    const res = await fitImagesToBudget([gif], {
      availableBytes: 4.5 * MB,
      encodeImage: vi.fn(),
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("over-budget");
    expect(res.bestBytes).toBe(9 * MB);
  });

  it("treats an undecodable file (HEIC outside Safari) as pass-through, not a crash", async () => {
    const encode = vi.fn(async () => null);
    const heic = fakeFile("IMG_1.heic", 2 * MB, "image/heic");

    const res = await fitImagesToBudget([heic], {
      availableBytes: 4.5 * MB,
      encodeImage: encode,
    });

    // 2MB already fits, so it short-circuits before touching the encoder.
    expect(res.ok).toBe(true);
    expect(res.files[0]).toBe(heic);
  });

  it("accounts for already-attached bytes via the caller’s available budget", async () => {
    const encode = encoderShrinkingByRung([0.2]);
    const files = [fakeFile("a.jpg", 2 * MB)];

    // 4MB already attached out of a 4.5MB budget leaves only 0.5MB.
    const res = await fitImagesToBudget(files, {
      availableBytes: 0.5 * MB,
      encodeImage: encode,
    });

    expect(res.ok).toBe(true);
    expect(res.finalBytes).toBeLessThanOrEqual(0.5 * MB);
  });

  it("fails closed when the tray is already at budget", async () => {
    const res = await fitImagesToBudget([fakeFile("a.jpg", MB)], {
      availableBytes: 0,
      encodeImage: vi.fn(),
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no-budget");
  });

  it("handles an empty selection", async () => {
    const res = await fitImagesToBudget([], {
      availableBytes: MMS_TOTAL_BUDGET_BYTES,
    });
    expect(res).toMatchObject({ ok: true, compressed: false, finalBytes: 0 });
  });

  it("returns files index-aligned with the input so callers can zip previews", async () => {
    const encode = encoderShrinkingByRung([0.2]);
    const files = [
      fakeFile("a.jpg", 3 * MB),
      fakeFile("b.gif", MB, "image/gif"),
      fakeFile("c.png", 3 * MB, "image/png"),
    ];

    const res = await fitImagesToBudget(files, {
      availableBytes: 4.5 * MB,
      encodeImage: encode,
    });

    expect(res.files).toHaveLength(3);
    expect(res.files[1]).toBe(files[1]);
    expect(res.files[0].name).toBe("a.jpg");
    expect(res.files[2].name).toBe("c.jpg"); // re-encoded to JPEG
  });
});

describe("helpers", () => {
  it("sums sizes defensively", () => {
    expect(totalBytes([{ size: 10 }, { size: 5 }, {}, null])).toBe(15);
    expect(totalBytes()).toBe(0);
  });

  it("formats bytes at human scale", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(4.5 * MB)).toBe("4.5 MB");
  });
});

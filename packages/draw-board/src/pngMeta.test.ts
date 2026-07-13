import { describe, expect, it } from "vitest";
import { BOARD_KEYWORD, crc32, embedPngText, isPng, readPngText } from "./pngMeta.ts";

/** Minimal structurally-valid PNG: signature + IHDR(1×1) + IDAT(dummy) + IEND,
 *  each with a correct CRC. Not a decodable image (IDAT is junk) — chunk
 *  surgery only cares about structure; real-image round-trips run in the
 *  browser suite. */
function tinyPng(): Uint8Array {
  const enc: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const chunk = (type: string, data: number[]) => {
    const t = [...type].map((ch) => ch.charCodeAt(0));
    const body = new Uint8Array([...t, ...data]);
    const len = data.length;
    enc.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
    enc.push(...body);
    const crc = crc32(body);
    enc.push((crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff);
  };
  chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  chunk("IDAT", [1, 2, 3, 4]);
  chunk("IEND", []);
  return new Uint8Array(enc);
}

describe("pngMeta", () => {
  it("crc32 matches the PNG reference value for 'IEND'", () => {
    expect(crc32(new Uint8Array([0x49, 0x45, 0x4e, 0x44]))).toBe(0xae426082);
  });

  it("embed → read round-trips UTF-8 JSON", () => {
    const doc = JSON.stringify({ v: 1, note: "héllo ✏️", shapes: [{ id: "a" }] });
    const out = embedPngText(tinyPng(), BOARD_KEYWORD, doc);
    expect(isPng(out)).toBe(true);
    expect(readPngText(out, BOARD_KEYWORD)).toBe(doc);
  });

  it("re-embedding replaces the existing chunk (no duplicates, size stays bounded)", () => {
    const once = embedPngText(tinyPng(), BOARD_KEYWORD, "first-payload");
    const twice = embedPngText(once, BOARD_KEYWORD, "second");
    expect(readPngText(twice, BOARD_KEYWORD)).toBe("second");
    expect(twice.length).toBeLessThan(once.length); // shorter text → smaller file
  });

  it("chunk goes BEFORE IEND and the tail structure stays valid", () => {
    const out = embedPngText(tinyPng(), BOARD_KEYWORD, "x");
    // Last 12 bytes: IEND chunk (len 0 + type + CRC).
    const tail = out.subarray(out.length - 12);
    expect(String.fromCharCode(tail[4], tail[5], tail[6], tail[7])).toBe("IEND");
  });

  it("foreign keywords and non-PNG bytes are handled gracefully", () => {
    const out = embedPngText(tinyPng(), BOARD_KEYWORD, "payload");
    expect(readPngText(out, "other-keyword")).toBeNull();
    expect(readPngText(new Uint8Array([1, 2, 3]), BOARD_KEYWORD)).toBeNull();
    expect(isPng(new Uint8Array([1, 2, 3]))).toBe(false);
    expect(() => embedPngText(new Uint8Array([1, 2, 3]), BOARD_KEYWORD, "x")).toThrow();
  });
});

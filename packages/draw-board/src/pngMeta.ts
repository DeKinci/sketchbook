/**
 * PNG text-chunk metadata — the "rich export" carrier. A rich PNG is a normal
 * image everywhere, plus an iTXt chunk holding the serialized board doc, so the
 * file re-imports as a fully editable board.
 *
 * Pure byte-level PNG surgery (no canvas, no deps): parse the chunk stream,
 * insert/read an iTXt chunk keyed {@link BOARD_KEYWORD} right before IEND.
 * iTXt is used (not tEXt) because the payload is UTF-8 JSON.
 */

/** iTXt keyword identifying a board-doc payload. */
export const BOARD_KEYWORD = "draw-board-doc";

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** CRC-32 (PNG polynomial), table-based. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  return PNG_SIG.every((b, i) => bytes[i] === b);
}

function u32(bytes: Uint8Array, off: number): number {
  return ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
}

function writeU32(target: Uint8Array, off: number, v: number): void {
  target[off] = (v >>> 24) & 0xff;
  target[off + 1] = (v >>> 16) & 0xff;
  target[off + 2] = (v >>> 8) & 0xff;
  target[off + 3] = v & 0xff;
}

type Chunk = { type: string; start: number; length: number };

/** Walk the chunk stream. Returns null for a malformed file (never throws on
 *  foreign bytes — import paths probe arbitrary files). */
function chunks(bytes: Uint8Array): Chunk[] | null {
  if (!isPng(bytes)) return null;
  const out: Chunk[] = [];
  let off = 8;
  while (off + 12 <= bytes.length) {
    const length = u32(bytes, off);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    if (off + 12 + length > bytes.length) return null;
    out.push({ type, start: off, length });
    off += 12 + length;
    if (type === "IEND") return out;
  }
  return null;
}

/** Build an iTXt chunk: keyword \0 compressionFlag(0) method(0) \0lang \0translated, then UTF-8 text. */
function buildITxt(keyword: string, text: string): Uint8Array {
  const enc = new TextEncoder();
  const kw = enc.encode(keyword);
  const body = enc.encode(text);
  const data = new Uint8Array(kw.length + 5 + body.length);
  data.set(kw, 0);
  // \0 compression-flag \0? layout: keyword, 0, compFlag, compMethod, langTag, 0, translatedKw, 0, text
  let o = kw.length;
  data[o++] = 0; // keyword terminator
  data[o++] = 0; // compression flag: uncompressed
  data[o++] = 0; // compression method
  data[o++] = 0; // empty language tag terminator
  data[o++] = 0; // empty translated keyword terminator
  data.set(body, o);
  const chunk = new Uint8Array(12 + data.length);
  writeU32(chunk, 0, data.length);
  chunk[4] = 0x69; // i
  chunk[5] = 0x54; // T
  chunk[6] = 0x58; // X
  chunk[7] = 0x74; // t
  chunk.set(data, 8);
  const crcInput = chunk.subarray(4, 8 + data.length);
  writeU32(chunk, 8 + data.length, crc32(crcInput));
  return chunk;
}

/** Insert (or replace) the board iTXt chunk before IEND. Returns new bytes. */
export function embedPngText(bytes: Uint8Array, keyword: string, text: string): Uint8Array {
  const list = chunks(bytes);
  if (!list) throw new Error("not a PNG");
  const iend = list.find((c) => c.type === "IEND");
  if (!iend) throw new Error("PNG missing IEND");
  // Drop any existing chunk with this keyword (re-export replaces).
  const drop = list.filter((c) => c.type === "iTXt" && readKeywordAt(bytes, c) === keyword);
  const chunk = buildITxt(keyword, text);
  const dropped = drop.reduce((n, c) => n + 12 + c.length, 0);
  const out = new Uint8Array(bytes.length - dropped + chunk.length);
  let w = 0;
  let r = 0;
  for (const c of list) {
    if (drop.includes(c)) {
      // copy everything before it that isn't already copied
      out.set(bytes.subarray(r, c.start), w);
      w += c.start - r;
      r = c.start + 12 + c.length;
      continue;
    }
    if (c.type === "IEND") {
      out.set(bytes.subarray(r, c.start), w);
      w += c.start - r;
      out.set(chunk, w);
      w += chunk.length;
      r = c.start;
    }
  }
  out.set(bytes.subarray(r), w);
  return out;
}

function readKeywordAt(bytes: Uint8Array, c: Chunk): string {
  const data = bytes.subarray(c.start + 8, c.start + 8 + c.length);
  const nul = data.indexOf(0);
  if (nul < 0) return "";
  return new TextDecoder().decode(data.subarray(0, nul));
}

/** Read the text of the first iTXt chunk with `keyword`, or null. */
export function readPngText(bytes: Uint8Array, keyword: string): string | null {
  const list = chunks(bytes);
  if (!list) return null;
  for (const c of list) {
    if (c.type !== "iTXt") continue;
    const data = bytes.subarray(c.start + 8, c.start + 8 + c.length);
    const nul = data.indexOf(0);
    if (nul < 0 || new TextDecoder().decode(data.subarray(0, nul)) !== keyword) continue;
    // keyword \0, compFlag, compMethod, then two \0-terminated strings, then text.
    let o = nul + 1;
    const compFlag = data[o];
    o += 2; // compFlag + compMethod
    while (o < data.length && data[o] !== 0) o++; // language tag
    o++;
    while (o < data.length && data[o] !== 0) o++; // translated keyword
    o++;
    if (compFlag !== 0) return null; // compressed payloads not produced by us
    return new TextDecoder().decode(data.subarray(o));
  }
  return null;
}

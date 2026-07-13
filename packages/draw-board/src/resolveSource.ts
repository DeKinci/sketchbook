import type { DrawDoc } from "./drawModel.ts";

/** What the editor was opened on. */
export type DrawSource =
  | { kind: "blank" }
  | { kind: "image"; dataBase64: string; mediaType: string; name?: string }
  | { kind: "doc"; doc: DrawDoc; name?: string };

export interface ResolvedSource {
  doc: DrawDoc;
  /** Decoded background raster, or null for a blank sketch. */
  bgImage: HTMLImageElement | null;
  /** Suggested export file name stem. */
  name: string;
}

const MIN = 320;
const MAX_UPSCALE = 2; // don't blow a tiny screenshot up past 2× on screen

/** Fit natural dimensions into the available box, allowing modest upscale so a
 *  small image is still annotatable, never enlarging past {@link MAX_UPSCALE}. */
function fit(nw: number, nh: number, box: { width: number; height: number }): { width: number; height: number } {
  if (nw <= 0 || nh <= 0) return { width: box.width, height: box.height };
  const scale = Math.min(box.width / nw, box.height / nh, MAX_UPSCALE);
  return { width: Math.round(nw * scale), height: Math.round(nh * scale) };
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not decode image"));
    img.src = dataUrl;
  });
}

/**
 * Resolve a {@link DrawSource} into a concrete {@link DrawDoc} + decoded
 * background, sized to fit the measured canvas `box`. Async because annotating
 * an image (or reopening a doc with a background) must decode the raster to know
 * its natural size and to render it.
 */
export async function resolveSource(source: DrawSource, box: { width: number; height: number }): Promise<ResolvedSource> {
  const w = Math.max(MIN, Math.floor(box.width));
  const h = Math.max(240, Math.floor(box.height));

  if (source.kind === "blank") {
    return { doc: { shapes: [], width: w, height: h }, bgImage: null, name: "" };
  }

  if (source.kind === "image") {
    const img = await loadImage(`data:${source.mediaType};base64,${source.dataBase64}`);
    const size = fit(img.naturalWidth, img.naturalHeight, { width: w, height: h });
    return {
      doc: {
        background: {
          dataBase64: source.dataBase64,
          mediaType: source.mediaType,
          width: img.naturalWidth,
          height: img.naturalHeight,
        },
        shapes: [],
        width: size.width,
        height: size.height,
      },
      bgImage: img,
      name: source.name ?? "",
    };
  }

  // Reopen an existing editable doc (may carry a background + shapes).
  const bg = source.doc.background;
  const bgImage = bg ? await loadImage(`data:${bg.mediaType};base64,${bg.dataBase64}`) : null;
  return { doc: source.doc, bgImage, name: source.name ?? "" };
}

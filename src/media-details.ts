/**
 * The media contract get_media reports: the decrypted file the service
 * writes, plus the metadata the envelope carried — the caption and the
 * original filename — which the saved-file result did not name before.
 */

import type { MessageView } from "./wa-types.js";

/** Types whose envelope can carry a caption: image, video (incl. GIF/ptv) and document. */
const CAPTIONED = new Set(["image", "video", "document"]);

/**
 * The caption a sender wrote under their media. The rendered text carries it
 * right after the "[type]" tag — except a document without one shows its
 * filename there instead, so a tail that is the filename is not a caption.
 * Audio and voice notes cannot carry captions; a view-once message's inner
 * caption is not rendered, so it reports null rather than a guess.
 */
export function mediaCaptionOf(view: MessageView): string | null {
  if (!CAPTIONED.has(view.type)) return null;
  const tail = view.text.replace(/^\[[^\]]*\]\s*/, "").trim();
  if (tail === "" || tail === view.media?.filename) return null;
  return tail;
}

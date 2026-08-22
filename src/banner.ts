import { brand, dim } from "./ui.js";

export const BANNER_ART = `██╗    ██╗ █████╗ ███████╗ █████╗ ██████╗
██║    ██║██╔══██╗╚══███╔╝██╔══██╗██╔══██╗
██║ █╗ ██║███████║  ███╔╝ ███████║██████╔╝
██║███╗██║██╔══██║ ███╔╝  ██╔══██║██╔═══╝
╚███╔███╔╝██║  ██║███████╗██║  ██║██║
 ╚══╝╚══╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝`;

export const TAGLINE = "WhatsApp for your AI agent.";

export const BANNER = `${BANNER_ART}\n${TAGLINE}`;

/** Painted per line, so a wrapped terminal cannot bleed the colour onward. */
export function banner(): string {
  return `${BANNER_ART.split("\n").map(brand).join("\n")}\n${dim(TAGLINE)}`;
}

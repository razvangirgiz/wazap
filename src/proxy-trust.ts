import { isIP } from "node:net";
import { WazapError } from "./errors.js";

/** Trust explicit proxy addresses, not every private/LAN peer or an arbitrary hop count. */
export function trustedProxies(value: string | undefined): string[] {
  const input = value?.trim();
  if (!input) return ["loopback"];
  if (input === "none") return [];
  const entries = input.split(",").map((entry) => entry.trim());
  for (const entry of entries) {
    if (entry === "loopback") continue;
    const [address, prefix, extra] = entry.split("/");
    const family = isIP(address ?? "");
    if (
      family &&
      extra === undefined &&
      (prefix === undefined ||
        (/^\d{1,3}$/.test(prefix) && Number(prefix) > 0 && Number(prefix) <= (family === 4 ? 32 : 128)))
    )
      continue;
    throw new WazapError(
      "INVALID_ID",
      "Invalid WAZAP_TRUST_PROXY: use none, loopback, or comma-separated proxy IPs/CIDRs (not /0).",
      "Trust only the exact reverse proxies that sanitize X-Forwarded-For, then restart the server"
    );
  }
  return entries;
}

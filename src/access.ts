import { AsyncLocalStorage } from "node:async_hooks";
import { WazapError } from "./errors.js";

export interface AccessContext {
  accountAccess?: { ids: string[]; fingerprint: string };
  principal: string;
  allowWrite: boolean;
  local: boolean;
}
export const accessContext = new AsyncLocalStorage<AccessContext>();
export function caller(): AccessContext {
  return accessContext.getStore() ?? { principal: "local", allowWrite: true, local: true };
}
export function requireWrite(): void {
  if (!caller().allowWrite) throw new WazapError("READ_ONLY", "This client has read-only access.");
}

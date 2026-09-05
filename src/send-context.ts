import { AsyncLocalStorage } from "node:async_hooks";
export const sendContext = new AsyncLocalStorage<{ messageId: string; dispatch: () => Promise<void> }>();

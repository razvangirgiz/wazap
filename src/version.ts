import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const WAZAP_VERSION: string = require("../package.json").version;
export const BAILEYS_VERSION: string = require("baileys/package.json").version;
export const WAZAP_NPX = `npx wazap-mcp@${WAZAP_VERSION}`;

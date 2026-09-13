/** The only entry point the rest of wazap imports. */
export {
  EMBED_MODELS,
  downloadEmbed,
  embedModelPath,
  embedModelSpec,
  type EmbedModelSpec,
} from "./models.js";
export { readRecallSettings } from "./settings.js";
export type {
  EmbedModelAlias,
  RankedHit,
  RecallItem,
  RecallQuery,
  RecallRecord,
  RecallSettings,
  RecallState,
  RecallStatus,
} from "./types.js";

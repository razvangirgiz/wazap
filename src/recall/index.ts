/** The only entry point the rest of wazap imports. */
export { EmbedEngine, embedReady, findLlama, type EmbedReadiness } from "./engine.js";
export {
  EMBED_MODELS,
  downloadEmbed,
  embedModelPath,
  embedModelSpec,
  RECALL_TEXT_CAP,
  type EmbedModelSpec,
} from "./models.js";
export { readRecallSettings } from "./settings.js";
export { EmbedFeed, type EmbedFeedOptions } from "./feed.js";
export type {
  EmbedModelAlias,
  RecallSettings,
  RecallState,
  RecallStatus,
} from "./types.js";

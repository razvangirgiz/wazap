/** The shapes semantic recall is built from. No logic lives here. */

/** The embedding model aliases wazap knows how to fetch and run. */
export type EmbedModelAlias = "embeddinggemma-300m" | "e5-base-multilingual";

/**
 * One queued message, carrying everything the index needs so the queue's slow
 * step — the embedding call — is the only thing left to do at write time.
 */
export interface RecallItem {
  sid: string;
  jid: string;
  /** epoch ms */
  ts: number;
  sender: string;
  type: string;
  text: string;
  /** Absolute message expiry, epoch ms; absent only for ordinary messages. */
  expiresAt?: number;
}

/** A live index row: one meta.jsonl "put" plus its row in vectors.bin. */
export interface RecallRecord extends RecallItem {
  row: number;
}

/** What a search is narrowed by — the same filters search_messages takes. */
export interface RecallQuery {
  vector: number[];
  /**
   * The raw query text. When present, a rare literal token in it — a name, a
   * number, a time — earns a hit carrying it verbatim a small bounded bonus.
   */
  text?: string;
  chatId?: string;
  sinceMs?: number;
  untilMs?: number;
  /** Canonical sender jid; "me" is already resolved by the caller. */
  from?: string;
  /** Raw cosine floor; hits under it are noise, not answers. 0 keeps everything. */
  minSimilarity?: number;
  limit: number;
}

export interface RankedHit {
  record: RecallRecord;
  /** Raw cosine similarity against the query vector; the floor applies to this. */
  similarity: number;
  /** Similarity after recency decay plus the bounded rare-token bonus; what the hits are sorted by. */
  score: number;
}

export type RecallState = "off" | "indexing" | "ready" | "degraded";

/** What get_status and the tool report about the index. */
export interface RecallStatus {
  state: RecallState;
  indexed: number;
  pending: number;
  detail?: string;
  fix?: string;
}

/** The whole recall environment, parsed once at the boundary. */
export interface RecallSettings {
  /** false means recall is off and nothing downstream may run. */
  enabled: boolean;
  model: EmbedModelAlias;
  /** WAZAP_EMBED_BIN override. */
  embedBin: string | null;
  /** WAZAP_EMBED_URL: an already-running server; the test seam, not a user option. */
  embedUrl: string | null;
  modelsDir: string;
  /** WAZAP_EMBED_IDLE_MINUTES, in ms: the shared sidecar is reaped after this long without an embed; 0 keeps it resident. */
  embedIdleMs: number;
  /** Index rows one account keeps; the oldest are evicted past this. */
  maxRows: number;
  /** Cosine floor for a hit to count; model-dependent, tuned on the default. */
  minSimilarity: number;
}

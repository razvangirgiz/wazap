/**
 * Reads how SQLite's FTS5 trigram tokenizer with remove_diacritics 1 folds
 * code points, straight from the tokenizer: each code point goes into a
 * throwaway in-memory index between two characters that fold to themselves,
 * and fts5vocab reports the trigram it became. The fold table is generated
 * from this, and a test compares the table with the SQLite actually running.
 */
import { sqlite } from "./sqlite.js";

export type FoldPairs = Array<[number, number]> & { sqliteVersion: string };

const PAD = "~";

export function foldTableFromSqlite(from: number, to: number): FoldPairs {
  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE VIRTUAL TABLE t USING fts5(x, tokenize = 'trigram remove_diacritics 1'); " +
        "CREATE VIRTUAL TABLE v USING fts5vocab(t, 'instance');"
    );
    const insert = db.prepare("INSERT INTO t(rowid, x) VALUES (?, ?)");
    db.exec("BEGIN");
    for (let cp = from; cp < to; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      insert.run(cp, `${PAD}${String.fromCodePoint(cp)}${PAD}`);
    }
    db.exec("COMMIT");
    const pairs = [] as unknown as FoldPairs;
    for (const row of db.prepare("SELECT term, doc FROM v ORDER BY doc").iterate() as Iterable<{ term: string; doc: number }>) {
      const chars = [...row.term];
      if (chars.length !== 3 || chars[0] !== PAD || chars[2] !== PAD) continue;
      const folded = chars[1]!.codePointAt(0)!;
      if (folded !== row.doc) pairs.push([row.doc, folded]);
    }
    pairs.sqliteVersion = (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
    return pairs;
  } finally {
    db.close();
  }
}

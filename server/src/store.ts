// The spent store: every challenge id and token id may be used once. A row is kept until its
// expiry plus a minute, then pruned. If the store cannot be reached the callers fail closed.

import Database from 'better-sqlite3';

export type SpentKind = 'challenge' | 'token';

export interface SpentStore {
  /** True for the first use of (kind, id); false for every later one. Throws when unavailable. */
  spend(kind: SpentKind, id: string, expiresAtMs: number): Promise<boolean>;
  /** Deletes rows whose expiry plus the grace period has passed; returns how many. */
  prune(nowMs: number): Promise<number>;
  healthy(): Promise<boolean>;
  close(): void;
  readonly name: string;
}

/** Kept after expiry so a token that is just past its exp still reads as a duplicate. */
export const PRUNE_GRACE_MS = 60_000;

export class SqliteSpentStore implements SpentStore {
  readonly name = 'sqlite';
  readonly #db: Database.Database;
  readonly #insert: Database.Statement<[string, number]>;
  readonly #prune: Database.Statement<[number]>;

  /** `path` is a file, or ":memory:" for tests. */
  constructor(path: string) {
    this.#db = new Database(path);
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('busy_timeout = 2000');
    this.#db.pragma('synchronous = NORMAL');
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS spent (
         id  TEXT    PRIMARY KEY,
         exp INTEGER NOT NULL
       ) WITHOUT ROWID;
       CREATE INDEX IF NOT EXISTS spent_exp ON spent (exp);`,
    );
    this.#insert = this.#db.prepare(
      'INSERT INTO spent (id, exp) VALUES (?, ?) ON CONFLICT (id) DO NOTHING',
    );
    this.#prune = this.#db.prepare('DELETE FROM spent WHERE exp < ?');
  }

  async spend(kind: SpentKind, id: string, expiresAtMs: number): Promise<boolean> {
    return this.#insert.run(`${kind}:${id}`, expiresAtMs).changes === 1;
  }

  async prune(nowMs: number): Promise<number> {
    return this.#prune.run(nowMs - PRUNE_GRACE_MS).changes;
  }

  async healthy(): Promise<boolean> {
    try {
      this.#db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.#db.close();
  }
}

/** Parses BC_STORE: `sqlite:/data/bc.sqlite` or `sqlite::memory:`. Redis is phase 3. */
export function openStore(spec: string): SpentStore {
  if (spec.startsWith('sqlite:')) return new SqliteSpentStore(spec.slice('sqlite:'.length));
  throw new Error(`BC_STORE: unsupported store "${spec.split(':')[0]}" (only sqlite in phase 1)`);
}

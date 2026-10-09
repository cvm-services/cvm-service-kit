import { Database } from "bun:sqlite";

export interface StoredProof {
  amount: number;
  secret: string;
  [k: string]: unknown;
}

export interface ProofStore {
  add(proofs: StoredProof[]): void;
  removeBySecrets(secrets: string[]): void;
  all(): StoredProof[];
  sum(): number;
}

/** In-memory proof store (tests). */
export class MemoryProofStore implements ProofStore {
  private readonly m = new Map<string, StoredProof>();
  add(proofs: StoredProof[]): void {
    for (const p of proofs) this.m.set(p.secret, p);
  }
  removeBySecrets(secrets: string[]): void {
    for (const s of secrets) this.m.delete(s);
  }
  all(): StoredProof[] {
    return [...this.m.values()];
  }
  sum(): number {
    return this.all().reduce((s, p) => s + p.amount, 0);
  }
}

/** Durable proof store backed by SQLite (single-writer per wallet DB). */
export class SqliteProofStore implements ProofStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS proofs (
        secret TEXT PRIMARY KEY,
        amount INTEGER NOT NULL,
        proof_json TEXT NOT NULL
      )`);
  }

  add(proofs: StoredProof[]): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO proofs (secret, amount, proof_json) VALUES (?, ?, ?)`,
    );
    for (const p of proofs) stmt.run(p.secret, p.amount, JSON.stringify(p));
  }

  removeBySecrets(secrets: string[]): void {
    const stmt = this.db.prepare(`DELETE FROM proofs WHERE secret = ?`);
    for (const s of secrets) stmt.run(s);
  }

  all(): StoredProof[] {
    return (this.db.query(`SELECT proof_json FROM proofs`).all() as any[]).map(
      (r) => JSON.parse(r.proof_json),
    );
  }

  sum(): number {
    const row = this.db.query(`SELECT COALESCE(SUM(amount),0) AS s FROM proofs`).get() as any;
    return row?.s ?? 0;
  }
}

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface JobRecord {
  id: string;
  owner: string;
  language: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  exitCode: number | null;
  durationMs: number | null;
  stdout: string | null;
  stderr: string | null;
  error: string | null;
}

export interface JobResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

/**
 * Durable job store + bounded worker queue for the async half of the API.
 * SQLite so submitted jobs survive a control-plane restart.
 */
export class JobManager {
  private readonly db: Database;
  private active = 0;

  constructor(
    dbPath: string,
    private readonly concurrency = 2,
  ) {
    this.db = new Database(dbPath);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        language TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        exit_code INTEGER,
        duration_ms INTEGER,
        stdout TEXT,
        stderr TEXT,
        error TEXT
      )`);
  }

  submit(owner: string, language: string): string {
    const id = randomUUID();
    const now = Date.now();
    this.db.run(
      `INSERT INTO jobs (id, owner, language, status, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, ?)`,
      [id, owner, language, now, now],
    );
    return id;
  }

  private set(id: string, patch: Partial<JobRecord>): void {
    const cur = this.get(id);
    if (!cur) return;
    const next = { ...cur, ...patch, updatedAt: Date.now() };
    this.db.run(
      `UPDATE jobs SET status=?, updated_at=?, exit_code=?, duration_ms=?, stdout=?, stderr=?, error=? WHERE id=?`,
      [
        next.status,
        next.updatedAt,
        next.exitCode,
        next.durationMs,
        next.stdout,
        next.stderr,
        next.error,
        id,
      ],
    );
  }

  get(id: string): JobRecord | null {
    const row = this.db
      .query(`SELECT * FROM jobs WHERE id = ?`)
      .get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      owner: row.owner,
      language: row.language,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      exitCode: row.exit_code,
      durationMs: row.duration_ms,
      stdout: row.stdout,
      stderr: row.stderr,
      error: row.error,
    };
  }

  /** Run `work` under the concurrency cap; records status transitions. */
  async run(id: string, work: () => Promise<JobResult>): Promise<void> {
    while (this.active >= this.concurrency) {
      await new Promise((r) => setTimeout(r, 50));
    }
    this.active++;
    this.set(id, { status: "running" });
    try {
      const r = await work();
      this.set(id, {
        status: "succeeded",
        exitCode: r.exit_code,
        durationMs: r.duration_ms,
        stdout: r.stdout,
        stderr: r.stderr,
        error: null,
      });
    } catch (e: any) {
      this.set(id, {
        status: "failed",
        error: String(e?.message ?? e),
      });
    } finally {
      this.active--;
    }
  }
}

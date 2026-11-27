import { db, issue, type DbExecutor } from '@repo/db';
import { asc, eq, inArray, sql } from 'drizzle-orm';

// Default per-transaction timeouts for issue writes and snapshot reads.
// SET LOCAL scopes both settings to the current transaction, so they never leak
// across pooled postgres.js connections.
export const DEFAULT_LOCK_TIMEOUT_MS = 5000;
export const DEFAULT_STATEMENT_TIMEOUT_MS = 10000;

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type IssueExecutor = DbExecutor;

export interface TxTimeoutOptions {
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
}

function formatTimeoutMs(value: number, name: string): string {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return `'${value}'`;
}

// Applies SET LOCAL lock_timeout and statement_timeout at the start of a write
// transaction so lock contention fails cleanly instead of stalling connections.
export async function setTxTimeouts(tx: Tx, opts: TxTimeoutOptions = {}): Promise<void> {
  const lockTimeout = formatTimeoutMs(
    opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    'lockTimeoutMs',
  );
  const statementTimeout = formatTimeoutMs(
    opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
    'statementTimeoutMs',
  );
  await tx.execute(sql`SET LOCAL lock_timeout = ${sql.raw(lockTimeout)}`);
  await tx.execute(sql`SET LOCAL statement_timeout = ${sql.raw(statementTimeout)}`);
}

// Locks the given issue rows in ascending id order inside an existing transaction
// to prevent deadlocks whenever a write touches more than one issue.
export async function lockIssuesInTx(tx: Tx, issueIds: number[]): Promise<number[]> {
  const sortedIds = [...new Set(issueIds)].sort((a, b) => a - b);
  if (sortedIds.length === 0) return [];
  const rows = await tx
    .select({ id: issue.id })
    .from(issue)
    .where(inArray(issue.id, sortedIds))
    .orderBy(asc(issue.id))
    .for('update');
  return rows.map((row) => row.id);
}

// Runs a write transaction serialized on one issue row (SELECT ... FOR UPDATE).
// `locked` is false when no issue row with `issueId` exists, allowing callers to
// preserve their existing 404/null handling.
export async function withIssueLockTx<T>(
  issueId: number,
  fn: (tx: Tx, locked: boolean) => Promise<T>,
  opts: TxTimeoutOptions = {},
): Promise<T> {
  return db.transaction(async (tx) => {
    await setTxTimeouts(tx, opts);
    const rows = await tx
      .select({ id: issue.id })
      .from(issue)
      .where(eq(issue.id, issueId))
      .for('update');
    return fn(tx, rows.length > 0);
  });
}

// Runs a write transaction locking multiple issues in ascending id order
// (ORDER BY id ASC FOR UPDATE) to prevent deadlocks across concurrent multi-issue writes.
export async function withMultiIssueLockTx<T>(
  issueIds: number[],
  fn: (tx: Tx, lockedIds: number[]) => Promise<T>,
  opts: TxTimeoutOptions = {},
): Promise<T> {
  return db.transaction(async (tx) => {
    await setTxTimeouts(tx, opts);
    const lockedIds = await lockIssuesInTx(tx, issueIds);
    return fn(tx, lockedIds);
  });
}

// Runs a read-only transaction at REPEATABLE READ isolation so every query inside
// `fn` observes one consistent PostgreSQL MVCC snapshot.
export async function withSnapshotReadTx<T>(
  fn: (tx: Tx) => Promise<T>,
  opts: { statementTimeoutMs?: number } = {},
): Promise<T> {
  const statementTimeout = formatTimeoutMs(
    opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
    'statementTimeoutMs',
  );
  return db.transaction(
    async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = ${sql.raw(statementTimeout)}`);
      return fn(tx);
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

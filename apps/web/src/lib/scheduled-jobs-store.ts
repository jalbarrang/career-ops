import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { acquireDirLock, lockRecoveryVerdict, readLockOwner, RECOVER_STALE } from "./core/dir-lock.ts";

const OWNERLESS_GRACE_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_RETRY_MS = 80;
const DEFAULT_STALE_MS = 30_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A job's lifecycle state. */
export type ScheduledJobStatus = "active" | "paused" | "deleted";

/** A run's lifecycle state. */
export type ScheduledRunState = "queued" | "running" | "success" | "failed" | "cancelled";

/** One scheduled job as `scheduled-jobs.json` stores it. */
export interface ScheduledJob {
  id: string;
  name: string;
  engine: string;
  filters: Record<string, unknown>;
  timezone?: string;
  startAt: string;
  every: number;
  unit: string;
  status: ScheduledJobStatus;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  [key: string]: unknown;
}

/** One execution record. */
export interface ScheduledRun {
  id: string;
  jobId: string;
  at: string;
  state: ScheduledRunState;
  attempt?: number;
  engine?: string;
  message?: string;
  [key: string]: unknown;
}

/** One queue entry, including an in-progress worker claim. */
export interface ScheduledQueueItem {
  id: string;
  jobId: string;
  queuedAt: string;
  claimToken?: string;
  claimedAt?: string;
  runId?: string;
  [key: string]: unknown;
}

/** The persisted document. */
export interface ScheduledStore {
  jobs: ScheduledJob[];
  runs: ScheduledRun[];
  queue: ScheduledQueueItem[];
}

export function isSafeScheduledId(value: unknown): boolean {
  return typeof value === "string" && UUID_RE.test(value);
}

export function emptyScheduledStore(): ScheduledStore {
  return { jobs: [], runs: [], queue: [] };
}

export function readScheduledStore(storePath: string): ScheduledStore {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(storePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("store root must be an object");
    const record = parsed as Record<string, unknown>;
    for (const key of ["jobs", "runs", "queue"]) {
      if (record[key] !== undefined && !Array.isArray(record[key])) {
        throw new Error(key + " must be an array");
      }
    }
    const store: ScheduledStore = {
      jobs: Array.isArray(record.jobs) ? (record.jobs as ScheduledJob[]) : [],
      runs: Array.isArray(record.runs) ? (record.runs as ScheduledRun[]) : [],
      queue: Array.isArray(record.queue) ? (record.queue as ScheduledQueueItem[]) : [],
    };
    validateScheduledStore(store);
    return store;
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "ENOENT") return emptyScheduledStore();
    throw new Error(`Invalid scheduled-jobs store at ${storePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertIso(value: unknown, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
}

export function validateScheduledStore(store: ScheduledStore): void {
  for (const job of store.jobs) {
    if (!isObject(job) || !isSafeScheduledId(job.id)) throw new Error("Invalid scheduled job identifier");
    if (!["active", "paused", "deleted"].includes(job.status)) throw new Error(`Invalid status for scheduled job ${job.id}`);
    if (typeof job.name !== "string" || typeof job.startAt !== "string") throw new Error(`Invalid scheduled job ${job.id}`);
    assertIso(job.startAt, `scheduled job ${job.id}.startAt`);
    assertIso(job.createdAt, `scheduled job ${job.id}.createdAt`);
    assertIso(job.updatedAt, `scheduled job ${job.id}.updatedAt`);
    if (job.nextRunAt !== undefined) assertIso(job.nextRunAt, `scheduled job ${job.id}.nextRunAt`);
  }
  for (const run of store.runs) {
    if (!isObject(run) || !isSafeScheduledId(run.id) || !isSafeScheduledId(run.jobId)) throw new Error("Invalid scheduled run identifier");
    if (!["queued", "running", "success", "failed", "cancelled"].includes(run.state)) throw new Error(`Invalid state for scheduled run ${run.id}`);
    assertIso(run.at, `scheduled run ${run.id}.at`);
  }
  for (const item of store.queue) {
    if (!isObject(item) || !isSafeScheduledId(item.id) || !isSafeScheduledId(item.jobId)) throw new Error("Invalid scheduled queue identifier");
    assertIso(item.queuedAt, `scheduled queue item ${item.id}.queuedAt`);
    if (item.claimToken !== undefined && !isSafeScheduledId(item.claimToken)) throw new Error(`Invalid claim token for ${item.id}`);
    if (item.claimedAt !== undefined) assertIso(item.claimedAt, `scheduled queue item ${item.id}.claimedAt`);
  }
}

export function writeScheduledStoreAtomic(storePath: string, store: ScheduledStore): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const tempPath = `${storePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, storePath);
  } finally {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // The atomic rename already succeeded, or best-effort cleanup failed.
    }
  }
}

/**
 * The state of a resource's lock, for the UI and for stale-lock diagnostics.
 *
 * The verdict comes from the shared protocol (core/dir-lock.ts): a dead owner
 * PID is stale, an unreadable stamp is never condemned, and only a genuine
 * stale verdict licenses a takeover.
 */
export function readLockStatus(resourcePath: string, options: { staleMs?: number } = {}): { exists: boolean; active: boolean; stale: boolean; owner: unknown } {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const lockDir = `${resourcePath}.lock`;
  if (!fs.existsSync(lockDir)) return { exists: false, active: false, stale: false, owner: null };
  const { owner } = readLockOwner(lockDir);
  const verdict = lockRecoveryVerdict(lockDir, staleMs);
  const stale = verdict === RECOVER_STALE;
  return { exists: true, active: !stale, stale, owner };
}

/**
 * Run `fn` under the shared directory lock for `resourcePath`.
 *
 * One protocol for the whole web (#5358): acquire/release, stale-owner
 * recovery and the owner stamp live in core/dir-lock.ts, so this store cannot
 * drift from the tracker, pipeline and chat writers.
 */
export interface ResourceLockOptions {
  timeoutMs?: number;
  retryMs?: number;
  staleMs?: number;
}

export async function withResourceLock<T>(
  resourcePath: string,
  fn: () => Promise<T> | T,
  options: ResourceLockOptions = {},
): Promise<T> {
  const lock = await acquireDirLock(`${resourcePath}.lock`, {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retryMs: options.retryMs ?? DEFAULT_RETRY_MS,
    staleMs: options.staleMs ?? DEFAULT_STALE_MS,
    createParent: true,
    timeoutError: () => new Error(`scheduled-jobs lock timeout: ${resourcePath}`),
  });
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

export async function withScheduledStore<T>(
  storePath: string,
  mutate: (store: ScheduledStore) => Promise<T> | T,
  options: ResourceLockOptions = {},
): Promise<T> {
  return withResourceLock<T>(
    storePath,
    async () => {
      const store = readScheduledStore(storePath);
      const result = await mutate(store);
      validateScheduledStore(store);
      writeScheduledStoreAtomic(storePath, store);
      return result;
    },
    options,
  );
}

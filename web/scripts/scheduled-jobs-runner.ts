#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import {
  isSafeScheduledId,
  withResourceLock,
  withScheduledStore,
  type ScheduledJob,
  type ScheduledQueueItem,
  type ScheduledStore,
} from "../src/lib/scheduled-jobs-store.ts";
import { nextScheduledRun } from "../src/lib/scheduled-cadence.ts";
import { isMainModule } from "../../lib/is-main-module.ts";
import { scheduledRunnerResourcePath, scheduledStorePath } from "../src/lib/scheduled-runner-path.ts";
import { getCareerOpsRoot } from "../../path-resolver.ts";

const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const MAX_RUNS = 100;
export const MAX_ATTEMPTS = 3;
export const SCAN_TIMEOUT_MS = 25 * 60 * 1_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
export const QUEUE_CLAIM_STALE_MS = 30 * 1_000;

const nowIso = (): string => new Date().toISOString();

/** What a scanner child reports back; the test suite substitutes this. */
export interface SpawnResult {
  status?: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: { message?: string } | null;
}

/** How the scanner is started; injected so tests never spawn a process. */
export type RunnerSpawn = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
    windowsHide: boolean;
  },
) => SpawnResult;

/** One scanner invocation: a root script plus its argv. */
export interface ScanCommand {
  script: string;
  args: string[];
}

/** A queue item claimed for one worker, with the job it belongs to. */
export interface JobClaim {
  job: ScheduledJob;
  queueId: string;
  runId: string;
  claimToken: string;
}

/** What one execution produced. */
export interface JobResult {
  state: "success" | "failed";
  attempt: number;
  rolesFound: number;
  durationMs: number;
  message: string;
}

/** Narrow an unknown YAML/JSON value to a record. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The non-empty strings in an unknown list. */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
}

export const nextFutureRun = nextScheduledRun;

export function enqueueDueJobs(store: ScheduledStore, nowMs: number = Date.now()): number {
  let queued = 0;
  for (const job of store.jobs) {
    if (job.status !== "active") continue;
    const dueAt = job.nextRunAt || job.startAt;
    const dueMs = Date.parse(dueAt);
    if (!Number.isFinite(dueMs) || dueMs > nowMs) continue;

    if (!store.queue.some((item) => item.jobId === job.id)) {
      store.queue.push({ id: randomUUID(), jobId: job.id, queuedAt: new Date(nowMs).toISOString() });
      queued += 1;
    }

    const nextRunAt = nextScheduledRun(dueAt, job.every, job.unit, nowMs, job.timezone || "UTC");
    if (nextRunAt) job.nextRunAt = nextRunAt;
    job.updatedAt = new Date(nowMs).toISOString();
  }
  return queued;
}

function claimIsStale(item: ScheduledQueueItem, nowMs: number): boolean {
  if (!item.claimToken || !item.claimedAt) return false;
  const claimedMs = Date.parse(item.claimedAt);
  return !Number.isFinite(claimedMs) || nowMs - claimedMs >= QUEUE_CLAIM_STALE_MS;
}

function claimQueueItem(store: ScheduledStore, item: ScheduledQueueItem, job: ScheduledJob, nowMs: number): JobClaim | null {
  if (item.claimToken && !claimIsStale(item, nowMs)) return null;
  if (item.claimToken) {
    const staleRun = item.runId && store.runs.find((run) => run.id === item.runId);
    if (staleRun) {
      staleRun.state = "queued";
      staleRun.message = "Requeued after an interrupted worker.";
    }
  }
  const claimToken = randomUUID();
  item.claimToken = claimToken;
  item.claimedAt = new Date(nowMs).toISOString();
  if (!item.runId || !isSafeScheduledId(item.runId)) item.runId = randomUUID();
  const run = store.runs.find((candidate) => candidate.id === item.runId);
  if (run) {
    run.state = "running";
    run.at = new Date(nowMs).toISOString();
    run.attempt = (run.attempt || 0) + 1;
  } else {
    store.runs.unshift({ id: item.runId, jobId: job.id, at: new Date(nowMs).toISOString(), state: "running", attempt: 1, engine: job.engine || "full" });
  }
  return { job: structuredClone(job), queueId: item.id, runId: item.runId, claimToken };
}

export function claimDueJob(store: ScheduledStore, nowMs: number = Date.now()): JobClaim | null {
  for (const item of store.queue) {
    const job = store.jobs.find((candidate) => candidate.id === item.jobId && candidate.status === "active");
    if (!job) continue;
    const claim = claimQueueItem(store, item, job, nowMs);
    if (claim) return claim;
  }
  return null;
}

export function claimManualJob(store: ScheduledStore, jobId: string, nowMs: number = Date.now()): JobClaim | null {
  const job = store.jobs.find((candidate) => candidate.id === jobId && candidate.status !== "deleted");
  if (!job) return null;
  let item = store.queue.find((candidate) => candidate.jobId === jobId);
  if (!item) {
    item = { id: randomUUID(), jobId, queuedAt: new Date(nowMs).toISOString() };
    store.queue.push(item);
  }
  return claimQueueItem(store, item, job, nowMs);
}

export const runnerResourcePath = scheduledRunnerResourcePath;

function numericFilter(value: unknown, fallback: number, minimum: number, maximum: number = Number.POSITIVE_INFINITY): number {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

export function buildScanCommand(job: ScheduledJob): ScanCommand {
  const filters = job.filters || {};
  const sinceDays = numericFilter(filters.sinceDays, 7, 1);
  if (job.engine === "portals") {
    return {
      script: "scan.ts",
      args: ["--since", String(sinceDays), "--quiet"],
    };
  }

  const atsList = stringList(filters.ats);
  const ats = atsList.length ? atsList.join(",") : "greenhouse,lever,ashby,workday";
  const limit = numericFilter(filters.limitPerAts, 150, 50, 500);
  return {
    script: "scan-ats-full.ts",
    args: ["--since", String(sinceDays), "--ats", ats, "--limit", String(limit), "--json"],
  };
}

export function extractRolesFound(engine: string, stdout: string): number {
  if (engine === "full") {
    try {
      const result = JSON.parse(stdout) as Record<string, unknown>;
      return Number.isFinite(Number(result.postingsKept)) ? Number(result.postingsKept) : 0;
    } catch {
      return 0;
    }
  }
  const match = stdout.match(/New offers added:\s*(\d+)/i);
  return match ? Number(match[1]) : 0;
}

function writeJobPortals(root: string, job: ScheduledJob): string {
  if (!isSafeScheduledId(job.id)) throw new Error("Invalid scheduled job identifier.");
  const portalsPath = path.join(root, "portals.yml");
  const parsed = yaml.load(fs.readFileSync(portalsPath, "utf8"));
  const base = asRecord(parsed);
  if (!base) throw new Error("portals.yml must contain a mapping");

  const filters = job.filters || {};
  const positive = stringList(filters.positive);
  const fallbackPositive = stringList(asRecord(base.title_filter)?.positive);
  if (!positive.length && !fallbackPositive.length) {
    throw new Error("Scheduled scans require title keywords in the job or portals.yml title_filter.positive.");
  }
  base.title_filter = {
    ...(base.title_filter || {}),
    positive: positive.length ? positive : fallbackPositive,
    negative: Array.isArray(filters.negative) ? filters.negative : [],
  };
  const titleFilterFull = asRecord(base.title_filter_full);
  if (titleFilterFull) base.title_filter_full = { ...titleFilterFull, ...(base.title_filter as Record<string, unknown>) };
  base.location_filter = {
    ...(base.location_filter || {}),
    allow: Array.isArray(filters.allow) ? filters.allow : [],
    block: Array.isArray(filters.block) ? filters.block : [],
    block_hard: Array.isArray(filters.blockHard) ? filters.blockHard : [],
    always_allow: Array.isArray(filters.alwaysAllow) ? filters.alwaysAllow : [],
  };

  const tempDir = path.join(root, "data", "tmp");
  fs.mkdirSync(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, `scheduled-${job.id}-${randomUUID()}.yml`);
  fs.writeFileSync(tempPath, yaml.dump(base, { lineWidth: 120, noRefs: true }), "utf8");
  return tempPath;
}

function firstErrorLine(result: SpawnResult): string {
  const raw = String(result.stderr ?? "") || result.error?.message || `scanner exit ${result.status ?? "unknown"}`;
  return String(raw).split(/\r?\n/).find(Boolean)?.slice(0, 300) || "Scan failed";
}

/*
 * Keep the temporary portal overlay scoped to each retry. A thrown setup or
 * spawn error is retryable just like a non-zero scanner exit, while cleanup
 * still runs before the next attempt.
 */

export function executeJob(root: string, job: ScheduledJob, options: { spawnFn?: RunnerSpawn } = {}): JobResult {
  const spawnFn: RunnerSpawn = options.spawnFn || (spawnSync as unknown as RunnerSpawn);
  const startedAt = Date.now();
  let lastError = "Scan failed";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let tempPortals = null;
    try {
      tempPortals = writeJobPortals(root, job);
      const command = buildScanCommand(job);
      const result = spawnFn(
        process.execPath,
        [command.script, ...command.args],
        {
          cwd: CODE_ROOT,
          env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_PORTALS: tempPortals },
          encoding: "utf8",
          timeout: SCAN_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
        },
      );

      if (result.status === 0) {
        const rolesFound = extractRolesFound(job.engine || "full", String(result.stdout ?? ""));
        return {
          state: "success",
          attempt,
          rolesFound,
          durationMs: Date.now() - startedAt,
          message: `Scan finished with ${rolesFound} matching role${rolesFound === 1 ? "" : "s"}.`,
        };
      }
      lastError = firstErrorLine(result);
    } catch (error) {
      lastError = firstErrorLine({ error: { message: error instanceof Error ? error.message : String(error) } });
    } finally {
      if (tempPortals) {
        try {
          fs.rmSync(tempPortals, { force: true });
        } catch {
          // Temporary filter cleanup is best effort.
        }
      }
    }
  }

  return {
    state: "failed",
    attempt: MAX_ATTEMPTS,
    rolesFound: 0,
    durationMs: Date.now() - startedAt,
    message: lastError,
  };
}

export async function recordCompletion(storePath: string, claim: JobClaim, result: JobResult, inMemoryStore: ScheduledStore | null = null): Promise<void> {
  const at = nowIso();
  const apply = (store: ScheduledStore): void => {
    const job = claim.job;
    const queueItem = claim.queueId && store.queue.find((item) => item.id === claim.queueId && item.claimToken === claim.claimToken);
    // A stale worker may finish after another worker reclaimed the item. Its
    // result must not overwrite the newer claim's run or job metadata.
    if (claim.queueId && !queueItem) return;
    const current = store.jobs.find((item) => item.id === job.id);
    if (current) {
      current.lastRunAt = at;
      current.rolesFoundCount = result.rolesFound;
      current.updatedAt = at;
      if (result.state === "failed") current.lastError = result.message;
      else delete current.lastError;
    }

    const run = store.runs.find((item) => item.id === claim.runId && item.jobId === job.id);
    if (run) Object.assign(run, { at, durationMs: result.durationMs, state: result.state, attempt: result.attempt, message: result.message, rolesFound: result.rolesFound, engine: job.engine || "full" });
    else store.runs.unshift({ id: claim.runId || randomUUID(), jobId: job.id, at, durationMs: result.durationMs, state: result.state, attempt: result.attempt, message: result.message, rolesFound: result.rolesFound, engine: job.engine || "full" });
    store.queue = store.queue.filter((item) => !(item.id === claim.queueId && item.claimToken === claim.claimToken));
    if (store.runs.length > MAX_RUNS) store.runs = store.runs.slice(0, MAX_RUNS);
  };
  if (inMemoryStore) apply(inMemoryStore);
  else await withScheduledStore(storePath, apply);
}

async function takeDueJob(storePath: string): Promise<JobClaim | null> {
  return withScheduledStore(storePath, (store) => {
    enqueueDueJobs(store);
    return claimDueJob(store);
  });
}

function requestedJobId(args: string[]): string | null {
  const index = args.indexOf("--job");
  return index >= 0 ? args[index + 1] || null : null;
}

async function main() {
  const root = getCareerOpsRoot();
  const storePath = scheduledStorePath(root);
  const runnerResource = runnerResourcePath(storePath);
  const manualJobId = requestedJobId(process.argv.slice(2));

  return withResourceLock(
    runnerResource,
    async () => {
      let claim;
      if (manualJobId) {
        if (!isSafeScheduledId(manualJobId)) throw new Error("Invalid scheduled job identifier.");
        claim = await withScheduledStore<JobClaim>(storePath, (store) => {
          const job = store.jobs.find((item) => item.id === manualJobId && item.status !== "deleted");
          if (!job) throw new Error("Scheduled job not found.");
          const manualClaim = claimManualJob(store, manualJobId);
          if (!manualClaim) throw new Error("Scheduled job is already running.");
          return manualClaim;
        });
      } else {
        claim = await takeDueJob(storePath);
      }

      if (!claim) return { status: "idle" };

      const result = executeJob(root, claim.job);
      await recordCompletion(storePath, claim, result);
      if (result.state === "failed") throw new Error(result.message);
      return { status: "success", jobId: claim.job.id, ...result };
    },
    { timeoutMs: 1_000, staleMs: SCAN_TIMEOUT_MS * MAX_ATTEMPTS + 60_000 },
  );
}

if (isMainModule(import.meta.url)) {
  main()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}

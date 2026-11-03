import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { json } from "@sveltejs/kit";
import { resolveCodeRoot } from "@/lib/core/code-root.mjs";
import { schedulerStatus } from "@/lib/scheduler-status";

function runnerScript() {
  return path.join(resolveCodeRoot(process.cwd(), process.env), "web", "scripts", "scheduled-jobs-runner.mjs");
}

export async function GET() {
  return json(await schedulerStatus(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST() {
  const script = runnerScript();
  if (!fs.existsSync(script)) {
    return json({ error: "Scheduled job runner is not installed." }, { status: 404 });
  }

  try {
    const child = spawn(process.execPath, [script], {
      cwd: resolveCodeRoot(process.cwd(), process.env),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      child.once("spawn", () => {
        settled = true;
        resolve();
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
    child.unref();
    return json({ accepted: true }, { status: 202 });
  } catch {
    return json({ error: "Could not start the local scheduled-job runner." }, { status: 500 });
  }
}

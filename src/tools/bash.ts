import { spawn, type ChildProcess } from "node:child_process";
import { defineTool, assertObject, assertOnlyKeys, requireString } from "./types.ts";
import { ToolError } from "../utils/errors.ts";
import { BoundedProcessOutput } from "../utils/truncate.ts";

export interface BashArgs { command: string; timeoutMs?: number }
export interface BashResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  durationMs: number;
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("close", () => resolve());
      killer.once("error", () => resolve());
    });
    return;
  }

  try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (child.exitCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}

export const bashTool = defineTool<BashArgs, BashResult>({
  name: "bash",
  description: "Run a shell command from the project root and return bounded stdout, stderr, and exit status.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeoutMs: { type: "number", minimum: 1, maximum: 300000 },
    },
    required: ["command"],
    additionalProperties: false,
  },
  parseArgs(input) {
    const value = assertObject(input);
    assertOnlyKeys(value, ["command", "timeoutMs"]);
    const command = requireString(value, "command", { nonEmpty: true });
    const timeout = value.timeoutMs;
    if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 || timeout > 300000)) {
      throw new ToolError("INVALID_ARGUMENTS", "timeoutMs must be a finite number between 1 and 300000.");
    }
    return { command, ...(timeout === undefined ? {} : { timeoutMs: timeout }) };
  },
  async execute(args, context) {
    const timeoutMs = args.timeoutMs ?? context.bashTimeoutMs;
    if (timeoutMs > 300000) {
      throw new ToolError("INVALID_ARGUMENTS", "Bash timeout must not exceed 300000 ms.");
    }

    const started = Date.now();
    const output = new BoundedProcessOutput(context.maxOutputBytes);
    const shell = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh";
    const shellArgs = process.platform === "win32" ? ["/d", "/s", "/c", args.command] : ["-c", args.command];
    const child = spawn(shell, shellArgs, {
      cwd: context.rootDir,
      env: process.env,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk: Buffer) => output.append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => output.append("stderr", chunk));

    let timedOut = false;
    let aborted = false;
    let spawnError: Error | undefined;
    let termination: Promise<void> | undefined;

    const requestTermination = (reason: "timeout" | "abort"): void => {
      if (reason === "timeout") timedOut = true;
      else aborted = true;
      termination ??= terminateProcessTree(child);
    };

    const timer = setTimeout(() => requestTermination("timeout"), timeoutMs);
    const abortHandler = (): void => requestTermination("abort");
    if (context.signal) {
      if (context.signal.aborted) abortHandler();
      else context.signal.addEventListener("abort", abortHandler, { once: true });
    }

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("error", (error) => { spawnError = error; resolve(null); });
      child.once("close", (code) => resolve(code));
    });

    clearTimeout(timer);
    context.signal?.removeEventListener("abort", abortHandler);
    if (termination) await termination;
    if (spawnError) {
      throw new ToolError("COMMAND_FAILED", `Could not start shell command: ${spawnError.message}`);
    }

    const captured = output.result();
    return {
      command: args.command,
      exitCode,
      stdout: captured.stdout,
      stderr: captured.stderr,
      timedOut,
      aborted,
      truncated: captured.truncated,
      durationMs: Date.now() - started,
    };
  },
});

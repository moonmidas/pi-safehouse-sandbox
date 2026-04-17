/**
 * Safehouse Sandbox extension for Pi.
 *
 * Requires the Safehouse CLI (`safehouse`) to be installed and available on PATH.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createBashTool,
  createLocalBashOperations,
  isToolCallEventType,
  type BashOperations,
} from "@mariozechner/pi-coding-agent";
import {
  buildPreflightBlockMessage,
  buildSafehouseArgs,
  getStatePath,
  getStateRoot,
  normalizeAllowedDirPath,
  parseAllowedDirCommand,
  preflightCheckCommand,
  readSandboxState,
  removeAllowedDir,
  upsertAllowedDir,
  writeSandboxState,
  type ProjectSandbox,
  type SandboxState,
} from "./shared.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAFEHOUSE_CANDIDATES = [process.env.SAFEHOUSE_BIN, "safehouse", "/opt/homebrew/bin/safehouse", "/usr/local/bin/safehouse"].filter(
  (value): value is string => typeof value === "string" && value.length > 0,
);
const LOCALHOST_PROFILE_PATH = resolve(__dirname, "localhost-only.sb");

function findSafehouseBinary(): string | null {
  for (const candidate of SAFEHOUSE_CANDIDATES) {
    if (candidate.includes("/")) {
      if (existsSync(candidate)) return candidate;
      continue;
    }

    try {
      const resolved = execFileSync("bash", ["-lc", `command -v ${candidate}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (resolved.length > 0) return resolved;
    } catch {
      // Keep searching.
    }
  }
  return null;
}

function ensureDirectory(path: string): void {
  const stats = statSync(path);
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${path}`);
  }
}

function getProjectSandbox(cwd: string): ProjectSandbox {
  const stateRoot = getStateRoot(cwd);
  const statePath = getStatePath(stateRoot);
  return {
    stateRoot,
    statePath,
    state: readSandboxState(statePath),
  };
}

function saveProjectSandbox(project: ProjectSandbox): void {
  writeSandboxState(project.statePath, project.state);
}

function describeState(project: ProjectSandbox): string[] {
  const lines = [
    `Sandbox: ${project.state.enabled ? "on" : "off"}`,
    `Project root: ${project.stateRoot}`,
    `State file: ${project.statePath}`,
    `Web access: ${project.state.allowWeb ? "unrestricted outbound" : "localhost only"}`,
    "Allowed dirs:",
  ];

  if (project.state.allowedDirs.length === 0) {
    lines.push("  (none)");
  } else {
    for (const entry of project.state.allowedDirs) {
      lines.push(`  - ${entry.mode}: ${entry.path}`);
    }
  }

  lines.push("Effective defaults:");
  lines.push(`  - rw: ${project.stateRoot}`);
  lines.push("  - rw: /tmp, /private/tmp, /var/folders, /private/var/folders");
  return lines;
}

function updateStatus(ctx: { ui: { setStatus: (id: string, value: string | undefined) => void; theme: { fg: (color: string, text: string) => string } } }, project: ProjectSandbox): void {
  const state = project.state;
  const status = state.enabled
    ? `🔒 sandbox on • web ${state.allowWeb ? "full" : "localhost"} • extra dirs ${state.allowedDirs.length}`
    : "🔓 sandbox off";
  ctx.ui.setStatus("safehouse-sandbox", ctx.ui.theme.fg(state.enabled ? "accent" : "muted", status));
}

function safehouseArgsForProject(project: ProjectSandbox): string[] {
  return buildSafehouseArgs({
    projectRoot: project.stateRoot,
    cwd: project.stateRoot,
    state: project.state,
    localhostProfilePath: LOCALHOST_PROFILE_PATH,
  });
}

function createSafehouseBashOps(): BashOperations {
  const localOps = createLocalBashOperations();

  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      const project = getProjectSandbox(cwd);
      if (!project.state.enabled) {
        return localOps.exec(command, cwd, { onData, signal, timeout });
      }

      const safehouse = findSafehouseBinary();
      if (!safehouse) {
        throw new Error("Sandbox is enabled but Safehouse is not installed or not on PATH.");
      }

      const args = [...safehouseArgsForProject(project), "--", "/bin/bash", "-lc", command];

      return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(safehouse, args, {
          cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        const terminate = () => {
          if (!child.pid) return;
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        };

        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            terminate();
          }, timeout * 1000);
        }

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        child.on("error", (error) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          rejectPromise(error);
        });

        const onAbort = () => terminate();
        signal?.addEventListener("abort", onAbort, { once: true });

        child.on("close", (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);

          if (signal?.aborted) {
            rejectPromise(new Error("aborted"));
            return;
          }
          if (timedOut) {
            rejectPromise(new Error(`timeout:${timeout}`));
            return;
          }
          resolvePromise({ exitCode: code });
        });
      });
    },
  };
}

function localhostProfileExists(): boolean {
  return existsSync(LOCALHOST_PROFILE_PATH);
}

function parseToggleArg(args: string): boolean | null {
  const trimmed = args.trim().toLowerCase();
  if (trimmed === "on") return true;
  if (trimmed === "off") return false;
  return null;
}

export default function safehouseSandboxExtension(pi: ExtensionAPI) {
  const localCwd = process.cwd();
  const localBash = createBashTool(localCwd);
  const sandboxedBash = createBashTool(localCwd, { operations: createSafehouseBashOps() });

  pi.registerTool({
    ...localBash,
    label: "bash (safehouse)",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const project = getProjectSandbox(ctx.cwd);
      if (project.state.enabled && !localhostProfileExists()) {
        throw new Error(`Missing Safehouse localhost profile: ${LOCALHOST_PROFILE_PATH}`);
      }
      if (project.state.enabled && !findSafehouseBinary()) {
        throw new Error("Sandbox is enabled but Safehouse is not installed or not on PATH.");
      }
      return project.state.enabled
        ? sandboxedBash.execute(toolCallId, params, signal, onUpdate)
        : localBash.execute(toolCallId, params, signal, onUpdate);
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    const project = getProjectSandbox(ctx.cwd);
    if (!project.state.enabled) return;
    if (!localhostProfileExists()) {
      return { block: true, reason: `Missing Safehouse localhost profile: ${LOCALHOST_PROFILE_PATH}` };
    }
    if (!findSafehouseBinary()) {
      return { block: true, reason: "Sandbox is enabled but Safehouse is not installed or not on PATH." };
    }

    const preflight = preflightCheckCommand(event.input.command, ctx.cwd, project);
    if (preflight.action === "block") {
      return { block: true, reason: buildPreflightBlockMessage(preflight) };
    }
  });

  pi.on("user_bash", (event, ctx) => {
    const project = getProjectSandbox(ctx.cwd);
    if (!project.state.enabled) return;

    const preflight = preflightCheckCommand(event.command, ctx.cwd, project);
    if (preflight.action === "block") {
      return {
        result: {
          output: `${buildPreflightBlockMessage(preflight)}\n`,
          exitCode: 126,
          cancelled: false,
          truncated: false,
        },
      };
    }

    return { operations: createSafehouseBashOps() };
  });

  pi.on("session_start", async (_event, ctx) => {
    const project = getProjectSandbox(ctx.cwd);
    updateStatus(ctx, project);
    if (!project.state.enabled) return;

    if (!localhostProfileExists()) {
      ctx.ui.notify(`Sandbox is enabled, but required Safehouse profile is missing: ${LOCALHOST_PROFILE_PATH}`, "error");
      return;
    }

    if (!findSafehouseBinary()) {
      ctx.ui.notify("Sandbox is enabled, but Safehouse is required and was not found on PATH.", "error");
      return;
    }

    ctx.ui.notify(`Safehouse sandbox active for ${project.stateRoot}`, "info");
  });

  pi.registerCommand("sandbox", {
    description: "Show sandbox status or toggle sandbox on/off for this project",
    handler: async (args, ctx) => {
      const project = getProjectSandbox(ctx.cwd);
      const toggle = parseToggleArg(args);

      if (toggle === null) {
        if (args.trim().length > 0) {
          ctx.ui.notify("Usage: /sandbox [on|off]", "error");
          return;
        }
        updateStatus(ctx, project);
        ctx.ui.notify(describeState(project).join("\n"), "info");
        return;
      }

      project.state.enabled = toggle;
      saveProjectSandbox(project);
      updateStatus(ctx, project);
      ctx.ui.notify(`Sandbox ${toggle ? "enabled" : "disabled"} for ${project.stateRoot}`, "info");
    },
  });

  pi.registerCommand("sandbox-allow-web", {
    description: "Toggle unrestricted outbound web access for this project sandbox",
    handler: async (args, ctx) => {
      const project = getProjectSandbox(ctx.cwd);
      const toggle = parseToggleArg(args);

      if (toggle === null) {
        if (args.trim().length > 0) {
          ctx.ui.notify("Usage: /sandbox-allow-web [on|off]", "error");
          return;
        }
        ctx.ui.notify(`Sandbox web access is ${project.state.allowWeb ? "on" : "off"}`, "info");
        return;
      }

      project.state.allowWeb = toggle;
      saveProjectSandbox(project);
      updateStatus(ctx, project);
      ctx.ui.notify(`Sandbox web access ${toggle ? "enabled" : "disabled"} for ${project.stateRoot}`, "info");
    },
  });

  pi.registerCommand("sandbox-allowed-dir", {
    description: "Manage extra project sandbox directories: add <path> ro|rw, remove <path>, list",
    handler: async (args, ctx) => {
      const project = getProjectSandbox(ctx.cwd);
      const parsed = parseAllowedDirCommand(args);
      if (!parsed) {
        ctx.ui.notify("Usage: /sandbox-allowed-dir add <path> ro|rw | remove <path> | list", "error");
        return;
      }

      if (parsed.action === "list") {
        const lines = project.state.allowedDirs.length
          ? project.state.allowedDirs.map((entry) => `- ${entry.mode}: ${entry.path}`)
          : ["(none)"];
        ctx.ui.notify(`Sandbox allowed dirs:\n${lines.join("\n")}`, "info");
        return;
      }

      const absolutePath = normalizeAllowedDirPath(ctx.cwd, parsed.path);

      if (parsed.action === "add") {
        if (!existsSync(absolutePath)) {
          ctx.ui.notify(`Directory does not exist: ${absolutePath}`, "error");
          return;
        }
        try {
          ensureDirectory(absolutePath);
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          return;
        }

        const existing = project.state.allowedDirs.find((entry) => entry.path === absolutePath);
        if (existing?.mode === parsed.mode) {
          ctx.ui.notify(`Sandbox already allows ${absolutePath} as ${parsed.mode}`, "info");
          return;
        }

        project.state.allowedDirs = upsertAllowedDir(project.state.allowedDirs, {
          path: absolutePath,
          mode: parsed.mode,
        });
        saveProjectSandbox(project);
        updateStatus(ctx, project);
        ctx.ui.notify(`Sandbox allowed ${absolutePath} as ${parsed.mode}`, "info");
        return;
      }

      const before = project.state.allowedDirs.length;
      project.state.allowedDirs = removeAllowedDir(project.state.allowedDirs, absolutePath);
      if (project.state.allowedDirs.length === before) {
        ctx.ui.notify(`Sandbox did not contain ${absolutePath}`, "info");
        return;
      }

      saveProjectSandbox(project);
      updateStatus(ctx, project);
      ctx.ui.notify(`Sandbox removed ${absolutePath}`, "info");
    },
  });
}

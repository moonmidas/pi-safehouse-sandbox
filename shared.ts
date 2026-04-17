import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type AllowedDirMode = "ro" | "rw";

export interface AllowedDirEntry {
  path: string;
  mode: AllowedDirMode;
}

export interface SandboxState {
  version: 1;
  enabled: boolean;
  allowWeb: boolean;
  allowedDirs: AllowedDirEntry[];
}

export interface ParsedAllowedDirAddCommand {
  action: "add";
  path: string;
  mode: AllowedDirMode;
}

export interface ParsedAllowedDirRemoveCommand {
  action: "remove";
  path: string;
}

export interface ParsedAllowedDirListCommand {
  action: "list";
}

export type ParsedAllowedDirCommand =
  | ParsedAllowedDirAddCommand
  | ParsedAllowedDirRemoveCommand
  | ParsedAllowedDirListCommand;

export interface BuildSafehouseArgsInput {
  projectRoot: string;
  cwd: string;
  state: SandboxState;
  localhostProfilePath: string;
}

export interface ProjectSandbox {
  stateRoot: string;
  statePath: string;
  state: SandboxState;
}

export type SandboxAccess = "read" | "write";

export interface AllowedRoots {
  projectRoot: string;
  readRoots: string[];
  writeRoots: string[];
}

export type PreflightCheckResult =
  | { action: "allow" }
  | { action: "block"; access: SandboxAccess; path: string; reason: string };

export const TEMP_RW_DIRS = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"] as const;

export const LOCALHOST_ONLY_PROFILE = [
  ";; Tighten Safehouse default network policy to localhost-only access.",
  "(deny network*)",
  '(allow network-outbound (remote ip "localhost:*"))',
  '(allow network-bind (local ip "localhost:*"))',
  '(allow network-inbound (local ip "localhost:*"))',
  "",
].join("\n");

export function defaultSandboxState(): SandboxState {
  return {
    version: 1,
    enabled: false,
    allowWeb: false,
    allowedDirs: [],
  };
}

export function findGitRootFromFilesystem(cwd: string): string | null {
  let current = resolve(cwd);

  while (true) {
    if (existsSync(resolve(current, ".git"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function getGitRoot(cwd: string): string | null {
  try {
    const stdout = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return stdout.length > 0 ? stdout : findGitRootFromFilesystem(cwd);
  } catch {
    return findGitRootFromFilesystem(cwd);
  }
}

export function getStateRoot(cwd: string, gitRoot = getGitRoot(cwd)): string {
  return gitRoot ?? findGitRootFromFilesystem(cwd) ?? cwd;
}

export function getStatePath(stateRoot: string): string {
  return resolve(stateRoot, ".pi", "sandbox-state.json");
}

function normalizeAllowedDirEntry(value: unknown): AllowedDirEntry | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { path?: unknown; mode?: unknown };
  if (typeof candidate.path !== "string") return null;
  if (candidate.mode !== "ro" && candidate.mode !== "rw") return null;
  return {
    path: candidate.path,
    mode: candidate.mode,
  };
}

export function readSandboxState(statePath: string): SandboxState {
  if (!existsSync(statePath)) return defaultSandboxState();

  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as {
      version?: unknown;
      enabled?: unknown;
      allowWeb?: unknown;
      allowedDirs?: unknown;
    };

    const allowedDirs = Array.isArray(raw.allowedDirs)
      ? raw.allowedDirs
          .map((entry) => normalizeAllowedDirEntry(entry))
          .filter((entry): entry is AllowedDirEntry => entry !== null)
      : [];

    return {
      version: 1,
      enabled: raw.enabled === true,
      allowWeb: raw.allowWeb === true,
      allowedDirs,
    };
  } catch {
    return defaultSandboxState();
  }
}

export function writeSandboxState(statePath: string, state: SandboxState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function parseAllowedDirCommand(args: string): ParsedAllowedDirCommand | null {
  const trimmed = args.trim();
  if (trimmed === "list" || trimmed.length === 0) return { action: "list" };

  if (trimmed.startsWith("add ")) {
    const remainder = trimmed.slice(4).trim();
    const lastSpace = remainder.lastIndexOf(" ");
    if (lastSpace <= 0) return null;
    const path = remainder.slice(0, lastSpace).trim();
    const mode = remainder.slice(lastSpace + 1).trim();
    if (!path || (mode !== "ro" && mode !== "rw")) return null;
    return { action: "add", path, mode };
  }

  if (trimmed.startsWith("remove ")) {
    const path = trimmed.slice(7).trim();
    if (!path) return null;
    return { action: "remove", path };
  }

  return null;
}

function dedupePreserveOrder(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}

export function buildSafehouseArgs(input: BuildSafehouseArgsInput): string[] {
  const extraRwDirs = input.state.allowedDirs.filter((entry) => entry.mode === "rw").map((entry) => entry.path);
  const extraRoDirs = input.state.allowedDirs.filter((entry) => entry.mode === "ro").map((entry) => entry.path);

  const args = ["--workdir", input.projectRoot, "--add-dirs", dedupePreserveOrder([...TEMP_RW_DIRS, ...extraRwDirs]).join(":" )];

  const roDirs = dedupePreserveOrder(extraRoDirs);
  if (roDirs.length > 0) {
    args.push("--add-dirs-ro", roDirs.join(":"));
  }

  if (!input.state.allowWeb) {
    args.push("--append-profile", input.localhostProfilePath);
  }

  args.push("--env");
  return args;
}

export function normalizeAllowedDirPath(baseDir: string, inputPath: string): string {
  return resolve(baseDir, inputPath);
}

export function getAllowedRoots(input: { projectRoot: string; state: SandboxState }): AllowedRoots {
  const readRoots = dedupePreserveOrder([
    input.projectRoot,
    ...TEMP_RW_DIRS,
    ...input.state.allowedDirs.map((entry) => entry.path),
  ]);
  const writeRoots = dedupePreserveOrder([
    input.projectRoot,
    ...TEMP_RW_DIRS,
    ...input.state.allowedDirs.filter((entry) => entry.mode === "rw").map((entry) => entry.path),
  ]);
  return {
    projectRoot: input.projectRoot,
    readRoots,
    writeRoots,
  };
}

function isWithinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

export function isPathAllowedForAccess(path: string, access: SandboxAccess, roots: AllowedRoots): boolean {
  const allowedRoots = access === "write" ? roots.writeRoots : roots.readRoots;
  return allowedRoots.some((root) => isWithinRoot(path, root));
}

function normalizeCandidatePath(candidate: string, cwd: string): string {
  if (candidate.startsWith("~/")) {
    const home = process.env.HOME ?? "~";
    return resolve(home, candidate.slice(2));
  }
  if (candidate.startsWith("/")) {
    return resolve(candidate);
  }
  return resolve(cwd, candidate);
}

function shellTokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    if ((char === ">" || char === "<") && current.length === 0) {
      if (char === ">" && command[i + 1] === ">") {
        tokens.push(">>");
        i += 1;
      } else {
        tokens.push(char);
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) tokens.push(current);
  return tokens;
}

function looksLikePath(token: string): boolean {
  return token.startsWith("/") || token.startsWith("~/") || token.startsWith("../") || token.startsWith("./");
}

function blockIfOutside(candidate: string, access: SandboxAccess, cwd: string, roots: AllowedRoots): PreflightCheckResult | null {
  const normalizedPath = normalizeCandidatePath(candidate, cwd);
  if (isPathAllowedForAccess(normalizedPath, access, roots)) return null;
  return {
    action: "block",
    access,
    path: normalizedPath,
    reason: `outside allowed ${access} roots`,
  };
}

function extractInterpreterInlineCheck(token: string): SandboxAccess {
  return /(unlink|remove|rm\(|writeFile|appendFile|mkdir|rmdir|open\([^)]*,\s*['"](?:w|a|x))/.test(token)
    ? "write"
    : "read";
}

function findQuotedPathLiterals(code: string): string[] {
  const matches = code.match(/(['"])(\/[^'"\n]*|~\/[^'"\n]*|\.\.\/[^'"\n]*|\.\/[^'"\n]*)\1/g) ?? [];
  return matches.map((match) => match.slice(1, -1));
}

export function preflightCheckCommand(command: string, cwd: string, project: ProjectSandbox): PreflightCheckResult {
  const roots = getAllowedRoots({ projectRoot: project.stateRoot, state: project.state });
  const tokens = shellTokenize(command);
  if (tokens.length === 0) return { action: "allow" };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const next = tokens[i + 1];

    if ((token === ">" || token === ">>") && next && looksLikePath(next)) {
      return blockIfOutside(next, "write", cwd, roots) ?? { action: "allow" };
    }
    if (token === "<" && next && looksLikePath(next)) {
      return blockIfOutside(next, "read", cwd, roots) ?? { action: "allow" };
    }
  }

  const commandName = tokens[0];
  if (["rm", "mv", "touch", "mkdir", "rmdir", "ln", "chmod", "chown"].includes(commandName)) {
    for (const token of tokens.slice(1)) {
      if (!looksLikePath(token)) continue;
      const blocked = blockIfOutside(token, "write", cwd, roots);
      if (blocked) return blocked;
    }
    return { action: "allow" };
  }

  if (["cat", "less", "head", "tail", "grep", "rg", "sed"].includes(commandName)) {
    for (const token of tokens.slice(1)) {
      if (!looksLikePath(token)) continue;
      const blocked = blockIfOutside(token, "read", cwd, roots);
      if (blocked) return blocked;
    }
    return { action: "allow" };
  }

  if (commandName === "cp" || commandName === "mv") {
    const pathTokens = tokens.slice(1).filter(looksLikePath);
    if (pathTokens.length >= 2) {
      const sourceBlocked = blockIfOutside(pathTokens[0], "read", cwd, roots);
      if (sourceBlocked) return sourceBlocked;
      const destBlocked = blockIfOutside(pathTokens[pathTokens.length - 1], "write", cwd, roots);
      if (destBlocked) return destBlocked;
    }
    return { action: "allow" };
  }

  if (["python", "python3", "node", "ruby", "perl"].includes(commandName)) {
    const inlineFlagIndex = tokens.findIndex((token) => token === "-c" || token === "-e");
    if (inlineFlagIndex >= 0 && tokens[inlineFlagIndex + 1]) {
      const code = tokens[inlineFlagIndex + 1];
      for (const path of findQuotedPathLiterals(code)) {
        const access = extractInterpreterInlineCheck(code);
        const blocked = blockIfOutside(path, access, cwd, roots);
        if (blocked) return blocked;
      }
      return { action: "allow" };
    }

    const scriptPath = tokens[1];
    if (scriptPath && looksLikePath(scriptPath)) {
      const blocked = blockIfOutside(scriptPath, "read", cwd, roots);
      if (blocked) return blocked;
    }
    return { action: "allow" };
  }

  return { action: "allow" };
}

export function buildPreflightBlockMessage(result: Extract<PreflightCheckResult, { action: "block" }>): string {
  return `Sandbox preflight blocked ${result.access} access to ${result.path} because it is ${result.reason}. If intentional, add its directory with /sandbox-allowed-dir add <path> ro|rw.`;
}

export function upsertAllowedDir(allowedDirs: AllowedDirEntry[], nextEntry: AllowedDirEntry): AllowedDirEntry[] {
  const filtered = allowedDirs.filter((entry) => entry.path !== nextEntry.path);
  return [...filtered, nextEntry];
}

export function removeAllowedDir(allowedDirs: AllowedDirEntry[], path: string): AllowedDirEntry[] {
  return allowedDirs.filter((entry) => entry.path !== path);
}

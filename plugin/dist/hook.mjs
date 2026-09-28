#!/usr/bin/env node
import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);

// packages/cli/src/agent/hooks/main.ts
import { realpathSync as realpathSync2 } from "node:fs";
import { fileURLToPath } from "node:url";

// packages/cli/src/agent/deps.ts
import { spawn } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
var NPM_ARGS = ["install", "--omit=dev", "--no-audit", "--no-fund"];
var RETRY_MS = 10 * 6e4;
var MARKER = "deps-install.json";
var LOG = "deps-install.log";
function npmSpawnSpec(platform, env) {
  if (platform === "win32") {
    return { command: env.ComSpec ?? env.COMSPEC ?? "cmd.exe", args: ["/d", "/s", "/c", `npm.cmd ${NPM_ARGS.join(" ")}`], windowsVerbatimArguments: true };
  }
  return { command: "npm", args: [...NPM_ARGS] };
}
var WRAPPER_SCRIPT = [
  "const { spawn } = require('child_process');",
  "const fs = require('fs');",
  "const spec = JSON.parse(process.argv[1]);",
  "const startedAt = Number(process.argv[2]);",
  "let recorded = false;",
  "const done = (exitCode) => {",
  "  if (recorded) return;",
  "  recorded = true;",
  `  const tmp = ${JSON.stringify(MARKER)} + '.' + process.pid + '.tmp';`,
  "  fs.writeFileSync(tmp, JSON.stringify({ startedAt, finishedAt: Date.now(), exitCode }));",
  `  fs.renameSync(tmp, ${JSON.stringify(MARKER)});`,
  "};",
  "let child;",
  "try {",
  "  child = spawn(spec.command, spec.args, { stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: !!spec.windowsVerbatimArguments });",
  "} catch (err) { console.error(String(err)); done(-1); process.exit(0); }",
  "child.on('error', (err) => { console.error(String(err)); done(-1); });",
  "child.on('close', (code) => done(code === null ? -1 : code));"
].join("\n");
function pluginRootFrom(env, selfPath = process.argv[1] ?? "") {
  return env.CLAUDE_PLUGIN_ROOT || dirname(dirname(selfPath));
}
function defaultCanLoad(dataDir) {
  try {
    createRequire(join(dataDir, "package.json"))("@napi-rs/keyring");
    return true;
  } catch {
    return false;
  }
}
function depsInstalled(dataDir, canLoad = defaultCanLoad) {
  return existsSync(join(dataDir, "node_modules", "@napi-rs", "keyring", "package.json")) && canLoad(dataDir);
}
function readMarker(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed.startedAt !== "number") return null;
    return {
      startedAt: parsed.startedAt,
      finishedAt: typeof parsed.finishedAt === "number" ? parsed.finishedAt : void 0,
      exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : void 0
    };
  } catch {
    return null;
  }
}
function claimMarker(path, startedAt) {
  let fd;
  try {
    fd = openSync(path, "wx", 384);
  } catch (err) {
    if (err.code === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, JSON.stringify({ startedAt }));
  } finally {
    closeSync(fd);
  }
  return true;
}
function ensureDeps(opts) {
  const { dataDir, pluginRoot } = opts;
  const now = opts.now ?? Date.now;
  const markerPath = join(dataDir, MARKER);
  const logPath = join(dataDir, LOG);
  try {
    if (depsInstalled(dataDir, opts.canLoad)) return void 0;
    const pkg = join(pluginRoot, "package.json");
    if (!existsSync(pkg) || !existsSync(join(pluginRoot, ".claude-plugin", "plugin.json"))) return void 0;
    const marker = existsSync(markerPath) ? readMarker(markerPath) : null;
    if (marker) {
      const running = marker.exitCode === void 0;
      const since = running ? marker.startedAt : marker.finishedAt ?? marker.startedAt;
      const age = now() - since;
      if (age >= 0 && age < RETRY_MS) {
        if (running) {
          return `pidb: plugin dependencies are still installing (started ${Math.round(age / 1e3)}s ago) — \`pidb connect\` and token access work once npm finishes.`;
        }
        const retryMin = Math.max(1, Math.ceil((RETRY_MS - age) / 6e4));
        return `pidb: plugin dependency install failed (npm exit ${marker.exitCode}) — see ${logPath}; it is retried on a session start in ~${retryMin} min, or the user can run \`npm install --omit=dev\` in ${dataDir}.`;
      }
    }
    if (existsSync(markerPath)) unlinkSync(markerPath);
    mkdirSync(dataDir, { recursive: true });
    const startedAt = now();
    if (!claimMarker(markerPath, startedAt)) {
      return "pidb: plugin dependencies are being installed by another session — `pidb connect` and token access work once npm finishes.";
    }
    try {
      copyFileSync(pkg, join(dataDir, "package.json"));
      const spec = npmSpawnSpec(opts.platform ?? process.platform, opts.env ?? process.env);
      const logFd = openSync(logPath, "a");
      try {
        const child = (opts.spawnImpl ?? spawn)(
          opts.nodePath ?? process.execPath,
          ["-e", WRAPPER_SCRIPT, JSON.stringify(spec), String(startedAt)],
          { cwd: dataDir, detached: true, stdio: ["ignore", logFd, logFd], windowsHide: true }
        );
        child.on("error", () => {
        });
        child.unref();
      } finally {
        closeSync(logFd);
      }
    } catch (err) {
      try {
        unlinkSync(markerPath);
      } catch {
      }
      throw err;
    }
    return "pidb: installing plugin dependencies (@napi-rs/keyring) in the background — `pidb connect` and token access work once it finishes (usually under a minute; otherwise next session).";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `pidb: could not start the plugin dependency install (${message}) — ask the user to run \`npm install --omit=dev\` in the plugin data dir (${dataDir}).`;
  }
}

// packages/cli/src/agent/datadir.ts
import { homedir } from "node:os";
import { join as join2 } from "node:path";
var PLUGIN_CACHE_PATH = /^(.*[\\/]plugins)([\\/])cache[\\/]([^\\/]+)[\\/]([^\\/]+)[\\/]([^\\/]+)[\\/]dist[\\/][^\\/]+$/;
function derivedDataDir(selfPath) {
  const m = PLUGIN_CACHE_PATH.exec(selfPath);
  if (!m) return null;
  const [, pluginsDir, sep2, marketplace, plugin, version] = m;
  if (!pluginsDir || !sep2 || !marketplace || !plugin || !version) return null;
  return `${pluginsDir}${sep2}data${sep2}${plugin}-${marketplace}`;
}
function resolveDataDir(env = process.env, selfPath = process.argv[1] ?? "") {
  if (env.PIDB_PLUGIN_DATA) return env.PIDB_PLUGIN_DATA;
  const claudeDir = env.CLAUDE_CONFIG_DIR || join2(env.HOME ?? homedir(), ".claude");
  return derivedDataDir(selfPath) ?? join2(claudeDir, "plugins", "data", "pidb-pidb");
}

// packages/cli/src/agent/hooks/index.ts
import { appendFileSync } from "node:fs";
import { homedir as homedir2 } from "node:os";

// packages/cli/src/agent/state.ts
import { execFileSync } from "node:child_process";
import { mkdirSync as mkdirSync2, readFileSync as readFileSync2, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname as dirname2, isAbsolute, join as join3, relative, resolve, sep } from "node:path";
import nodePath from "node:path";

// packages/cli/src/errors.ts
var EXIT_GENERIC = 1;
var EXIT_AUTH = 3;
var EXIT_NOT_FOUND = 4;
var CliError = class extends Error {
  constructor(message, exitCode = EXIT_GENERIC) {
    super(message);
    this.exitCode = exitCode;
    this.name = "CliError";
  }
  exitCode;
};

// packages/cli/src/agent/state.ts
function readJsonFile(path, fallback) {
  let raw;
  try {
    raw = readFileSync2(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw new CliError(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new CliError(`${path} is not valid JSON`);
  }
}
function profilesPath(dataDir) {
  return join3(dataDir, "profiles.json");
}
function bindingsPath(dataDir) {
  return join3(dataDir, "bindings.json");
}
function loadProfiles(dataDir) {
  return readJsonFile(profilesPath(dataDir), { default: null, profiles: {} });
}
function loadBindings(dataDir) {
  return readJsonFile(bindingsPath(dataDir), {});
}
function writtenPath(dataDir) {
  return join3(dataDir, "written.json");
}
function loadWritten(dataDir) {
  return readJsonFile(writtenPath(dataDir), { paths: [] });
}
function defaultGitTopLevel(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}
function repoKey(cwd, opts = {}) {
  const pathMod = opts.pathMod ?? nodePath;
  const top = (opts.gitTopLevel ?? defaultGitTopLevel)(cwd) ?? cwd;
  const resolved = pathMod.resolve(top).replace(/\\/g, "/");
  return resolved.replace(/^([A-Za-z]):/, (_m, drive) => `${drive.toLowerCase()}:`);
}

// packages/cli/src/agent/tokenstore.ts
import { createRequire as createRequire2 } from "node:module";
import { join as join4 } from "node:path";
var SERVICE = "pidb";
var account = (profile) => `profile:${profile}`;
function defaultLoader(dataDir) {
  return () => {
    try {
      return createRequire2(join4(dataDir, "package.json"))("@napi-rs/keyring");
    } catch {
      return createRequire2(import.meta.url)("@napi-rs/keyring");
    }
  };
}
function keyringStore(dataDir, loader = defaultLoader(dataDir)) {
  let mod;
  function load() {
    if (!mod) {
      try {
        mod = loader();
      } catch {
        throw new CliError("no OS credential store available — run a Claude Code session so the plugin installs its dependencies");
      }
    }
    return mod;
  }
  return {
    async get(profile) {
      const { Entry } = load();
      return new Entry(SERVICE, account(profile)).getPassword();
    },
    async set(profile, token) {
      const { Entry } = load();
      new Entry(SERVICE, account(profile)).setPassword(token);
    },
    async delete(profile) {
      const { Entry } = load();
      new Entry(SERVICE, account(profile)).deletePassword();
    }
  };
}

// packages/cli/src/agent/hooks/shell.ts
function skipParenGroup(text, open) {
  let depth = 1;
  let i = open + 1;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === "'") {
      const close = text.indexOf("'", i + 1);
      i = close === -1 ? text.length : close + 1;
      continue;
    }
    if (ch === '"') {
      i = skipDoubleQuoted(text, i);
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    i++;
  }
  return i;
}
function skipDoubleQuoted(text, open) {
  let i = open + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (ch === "$" && text[i + 1] === "(") {
      i = skipParenGroup(text, i + 1);
      continue;
    }
    if (ch === '"') return i + 1;
    i++;
  }
  return text.length;
}
var DQ_ESCAPABLE = /* @__PURE__ */ new Set(['"', "\\", "$", "`"]);
function tokenizeSpans(text) {
  const tokens = [];
  let value = "";
  let start = -1;
  let quoted = false;
  const n = text.length;
  const push = (end) => {
    if (start !== -1) tokens.push({ value, start, end, quoted });
    value = "";
    start = -1;
    quoted = false;
  };
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      push(i);
      i++;
      continue;
    }
    if (start === -1) start = i;
    if (ch === "'") {
      const close = text.indexOf("'", i + 1);
      const end = close === -1 ? n : close;
      value += text.slice(i + 1, end);
      quoted = true;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      const end = skipDoubleQuoted(text, i);
      const body = text.slice(i + 1, text[end - 1] === '"' && end - 1 > i ? end - 1 : end);
      value += body.replace(/\\(.)/g, (whole, c) => DQ_ESCAPABLE.has(c) ? c : whole);
      quoted = true;
      i = end;
      continue;
    }
    if (ch === "\\" && i + 1 < n && /["'\s]/.test(text[i + 1])) {
      value += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === "$" && text[i + 1] === "(") {
      const end = skipParenGroup(text, i + 1);
      value += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "`") {
      const close = text.indexOf("`", i + 1);
      const end = close === -1 ? n : close + 1;
      value += text.slice(i, end);
      i = end;
      continue;
    }
    value += ch;
    i++;
  }
  push(n);
  return tokens;
}
function tokenize(text) {
  return tokenizeSpans(text).map((t) => t.value);
}
function splitSegments(text) {
  const out = [];
  let current = "";
  const n = text.length;
  const flush = () => {
    const t = current.trim();
    if (t) out.push(t);
    current = "";
  };
  const substitutions = [];
  const scanDoubleQuoted = (open) => {
    const end = skipDoubleQuoted(text, open);
    const closeIdx = text[end - 1] === '"' && end - 1 > open ? end - 1 : end;
    let j = open + 1;
    while (j < closeIdx) {
      const c = text[j];
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === "$" && text[j + 1] === "(") {
        const e = skipParenGroup(text, j + 1);
        substitutions.push(text.slice(j + 2, Math.max(e - 1, j + 2)));
        j = e;
        continue;
      }
      if (c === "`") {
        const close = text.indexOf("`", j + 1);
        if (close !== -1 && close < closeIdx) {
          substitutions.push(text.slice(j + 1, close));
          j = close + 1;
          continue;
        }
      }
      j++;
    }
    return end;
  };
  const heredocs = [];
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === "<" && text[i + 1] === "<" && text[i + 2] !== "<") {
      const m = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([A-Za-z0-9_.-]+))/.exec(text.slice(i));
      if (m) {
        heredocs.push({ delim: m[2] ?? m[3] ?? m[4] ?? "", strip: m[1] === "-", owner: current });
        current += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (ch === "\n" && heredocs.length > 0) {
      flush();
      i = consumeHeredocBodies(text, i + 1, heredocs.splice(0), out);
      continue;
    }
    if (ch === "'") {
      const close = text.indexOf("'", i + 1);
      const end = close === -1 ? n : close + 1;
      current += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '"') {
      const end = scanDoubleQuoted(i);
      current += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "\\" && i + 1 < n && /["'\s;&|()`$]/.test(text[i + 1])) {
      current += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "$" && text[i + 1] === "(") {
      const end = skipParenGroup(text, i + 1);
      substitutions.push(text.slice(i + 2, Math.max(end - 1, i + 2)));
      current += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "`") {
      const close = text.indexOf("`", i + 1);
      const end = close === -1 ? n : close + 1;
      substitutions.push(text.slice(i + 1, close === -1 ? n : close));
      current += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "&" && (text[i - 1] === ">" || text[i - 1] === "<" || text[i + 1] === ">")) {
      current += ch;
      i++;
      continue;
    }
    if (ch === "\n" || ch === ";" || ch === "&" || ch === "|" || ch === "(" || ch === ")") {
      flush();
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  flush();
  for (const sub of substitutions) out.push(...splitSegments(sub));
  return out;
}
var SCRIPT_CONSUMERS = /* @__PURE__ */ new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish", "powershell", "pwsh", "cmd", "source", ".", "eval"]);
function consumeHeredocBodies(text, from, docs, out) {
  let i = from;
  for (const doc of docs) {
    const lines = [];
    while (i < text.length) {
      const nl = text.indexOf("\n", i);
      const line = text.slice(i, nl === -1 ? text.length : nl);
      i = nl === -1 ? text.length : nl + 1;
      if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.delim) break;
      lines.push(line);
    }
    const ownerTokens = tokenize(doc.owner);
    let owner = commandWordOf(ownerTokens).word;
    const dd = ownerTokens.indexOf("--");
    if (owner === "pidb" && dd !== -1) owner = commandWordOf(ownerTokens.slice(dd + 1)).word;
    if (owner && SCRIPT_CONSUMERS.has(owner)) out.push(...splitSegments(lines.join("\n")));
  }
  return i;
}
function commandBasename(token) {
  const lower = token.toLowerCase();
  const cut = Math.max(lower.lastIndexOf("/"), lower.lastIndexOf("\\"));
  const base = cut === -1 || cut === lower.length - 1 ? lower : lower.slice(cut + 1);
  return base.replace(/\.(exe|cmd|bat|com)$/, "");
}
var ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
var KEYWORD_PREFIXES = /* @__PURE__ */ new Set(["!", "{", "}", "then", "do", "else", "elif", "if", "while", "until", "builtin", "nohup", "exec"]);
var PREFIX_ARG_FLAGS = {
  sudo: /* @__PURE__ */ new Set(["-u", "-g", "-C", "-p", "-h", "-U", "-r", "-t", "-D", "--user", "--group"]),
  time: /* @__PURE__ */ new Set(["-f", "-o", "--format", "--output"]),
  command: /* @__PURE__ */ new Set(),
  nice: /* @__PURE__ */ new Set(["-n", "--adjustment"]),
  env: /* @__PURE__ */ new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
  npx: /* @__PURE__ */ new Set(["-p", "--package", "-c", "--call"]),
  bunx: /* @__PURE__ */ new Set(["-p", "--package"]),
  timeout: /* @__PURE__ */ new Set(["-s", "--signal", "-k", "--kill-after"]),
  stdbuf: /* @__PURE__ */ new Set(["-i", "-o", "-e"]),
  doas: /* @__PURE__ */ new Set(["-u", "-C"])
};
var REDIRECT_RE = /^(\d*|&)(>>?|<<?<?|>&|<&)/;
function skipRedirections(tokens, j) {
  while (j < tokens.length) {
    const m = REDIRECT_RE.exec(tokens[j]);
    if (!m) break;
    j += m[0].length === tokens[j].length ? 2 : 1;
  }
  return j;
}
function commandWordOf(tokens) {
  let i = 0;
  for (; ; ) {
    i = skipRedirections(tokens, i);
    const tok = tokens[i];
    if (tok === void 0) return { word: null, index: i };
    const base = commandBasename(tok);
    if (KEYWORD_PREFIXES.has(base)) {
      i++;
      continue;
    }
    if (ENV_ASSIGNMENT_RE.test(tok)) {
      i++;
      continue;
    }
    let next = -1;
    if (base in PREFIX_ARG_FLAGS) {
      const argFlags = PREFIX_ARG_FLAGS[base];
      let j = i + 1;
      if (base === "timeout") {
        while (j < tokens.length && tokens[j].startsWith("-")) j += argFlags.has(tokens[j]) ? 2 : 1;
        j++;
      } else {
        while (j < tokens.length) {
          const t = tokens[j];
          if (t === "--") {
            j++;
            break;
          }
          if (base === "nice" && /^-\d+$/.test(t)) {
            j++;
            continue;
          }
          if (!t.startsWith("-") || t === "-") break;
          j += argFlags.has(t) ? 2 : 1;
        }
        if (base === "env") while (j < tokens.length && ENV_ASSIGNMENT_RE.test(tokens[j])) j++;
      }
      next = j;
    } else if (base === "npm" && ["exec", "x"].includes((tokens[i + 1] ?? "").toLowerCase())) {
      next = i + 2;
      while (next < tokens.length && tokens[next].startsWith("-")) next++;
    } else if (base === "pnpm" || base === "yarn") {
      next = ["exec", "dlx"].includes((tokens[i + 1] ?? "").toLowerCase()) ? i + 2 : i + 1;
      while (next < tokens.length && tokens[next].startsWith("-")) next++;
    }
    if (next === -1) return { word: base, index: i };
    next = skipRedirections(tokens, next);
    if (next >= tokens.length) return { word: base, index: i };
    i = next;
  }
}
var POSIX_SHELLS = /* @__PURE__ */ new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish"]);
var POWERSHELLS = /* @__PURE__ */ new Set(["powershell", "pwsh"]);
var PS_COMMAND_FLAG_RE = /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i;
var PS_ENCODED_FLAG_RE = /^-(e|ec|en|enc|encodedcommand|encodedc\w*)$/i;
var PS_ARG_FLAGS = /* @__PURE__ */ new Set(["-executionpolicy", "-ep", "-ex", "-file", "-f", "-windowstyle", "-w", "-configurationname", "-workingdirectory", "-wd", "-inputformat", "-outputformat", "-psconsolefile", "-version", "-v", "-settingsfile"]);
function scriptFrom(raw, spans, k) {
  if (k >= spans.length) return null;
  if (k === spans.length - 1) return spans[k].value;
  return raw.slice(spans[k].start);
}
function unwrapInterpreter(raw, spans, cw) {
  const word = cw.word;
  if (!word) return null;
  const tokens = spans.map((s) => s.value);
  if (POSIX_SHELLS.has(word)) {
    let sawC = false;
    for (let k = cw.index + 1; k < tokens.length; k++) {
      const t = tokens[k];
      if (t === "--" || t === "-") continue;
      if (/^[-+][oO]$/.test(t)) {
        k++;
        continue;
      }
      if (t.startsWith("--")) continue;
      if (/^[-+][a-zA-Z]+$/.test(t)) {
        if (t.startsWith("-") && t.includes("c")) sawC = true;
        continue;
      }
      return sawC ? t : null;
    }
    return null;
  }
  if (POWERSHELLS.has(word)) {
    for (let k = cw.index + 1; k < tokens.length; k++) {
      const t = tokens[k];
      if (PS_COMMAND_FLAG_RE.test(t)) return scriptFrom(raw, spans, k + 1);
      if (PS_ENCODED_FLAG_RE.test(t)) {
        const b64 = tokens[k + 1];
        if (!b64) return null;
        try {
          return Buffer.from(b64, "base64").toString("utf16le");
        } catch {
          return null;
        }
      }
      if (t.startsWith("-")) {
        if (PS_ARG_FLAGS.has(t.toLowerCase())) k++;
        continue;
      }
      return word === "powershell" ? scriptFrom(raw, spans, k) : null;
    }
    return null;
  }
  if (word === "cmd") {
    for (let k = cw.index + 1; k < tokens.length; k++) {
      const t = tokens[k];
      const m = /^\/[ck](.*)$/i.exec(t);
      if (m) {
        if (m[1]) return raw.slice(spans[k].start + 2);
        return scriptFrom(raw, spans, k + 1);
      }
      if (!t.startsWith("/")) return null;
    }
    return null;
  }
  return null;
}

// packages/cli/src/agent/hooks/paths.ts
import { posix as posixPath, win32 as win32Path } from "node:path";
function pathModFor(platform) {
  return platform === "win32" ? win32Path : posixPath;
}
function appDataOf(ctx) {
  if (ctx.appData) return ctx.appData;
  return pathModFor(ctx.platform).join(ctx.home, "AppData", "Roaming");
}
function protectedRoots(ctx) {
  const pm = pathModFor(ctx.platform);
  return [ctx.dataDir, pm.join(ctx.home, ".config", "pidb"), pm.join(appDataOf(ctx), "pidb")].map((p) => pm.resolve(p));
}
function writtenFiles(ctx) {
  const pm = pathModFor(ctx.platform);
  return ctx.written.map((w) => pm.resolve(w));
}
function normalizeForCompare(p, platform) {
  const s = p.replace(/\\/g, "/");
  return platform === "win32" ? s.toLowerCase() : s;
}
function withTrailingSlash(p) {
  return p.endsWith("/") ? p : `${p}/`;
}
function overlapNested(a, b) {
  return a === b || a.startsWith(withTrailingSlash(b));
}
function overlapEither(a, b) {
  return overlapNested(a, b) || b.startsWith(withTrailingSlash(a));
}
function protectedTargets(ctx) {
  return [...protectedRoots(ctx), ...writtenFiles(ctx)].map((p) => normalizeForCompare(p, ctx.platform));
}
function isProtectedPath(resolved, ctx, overlap) {
  const target = normalizeForCompare(resolved, ctx.platform);
  return protectedTargets(ctx).some((p) => overlap(target, p));
}
function expandPlaceholders(text, ctx, cwd) {
  const pm = pathModFor(ctx.platform);
  const appData = appDataOf(ctx);
  const xdgConfigHome = pm.join(ctx.home, ".config");
  let out = text.replace(/(^|[\s"'([{=:])~(?=[\\/]|$)/g, `$1${ctx.home}`).replace(/%APPDATA%/gi, appData).replace(/\$\{?env:APPDATA\}?/gi, appData).replace(/%USERPROFILE%/gi, ctx.home).replace(/\$\{?env:(USERPROFILE|HOME)\}?/gi, ctx.home).replace(/\$\{HOME\}/g, ctx.home).replace(/\$HOME\b/g, ctx.home).replace(/\$\{XDG_CONFIG_HOME\}/g, xdgConfigHome).replace(/\$XDG_CONFIG_HOME\b/g, xdgConfigHome);
  if (cwd !== void 0) {
    out = out.replace(/\$\(\s*(pwd|Get-Location|gl)\s*\)/gi, cwd).replace(/`\s*pwd\s*`/g, cwd).replace(/\$\{PWD\}/gi, cwd).replace(/\$PWD\b/gi, cwd).replace(/%CD%/gi, cwd);
  }
  return out;
}
function resolveArgPath(raw, baseDir, ctx) {
  const pm = pathModFor(ctx.platform);
  const expanded = expandPlaceholders(raw, ctx, baseDir);
  return pm.isAbsolute(expanded) ? pm.resolve(expanded) : pm.resolve(baseDir, expanded);
}
function hasWildcard(token) {
  return /[*?[]/.test(token);
}
function globToRegExp(rawGlob, platform) {
  const glob = rawGlob.replace(/\*{3,}/g, "**").replace(/(?:\*\*\/)+/g, "**/").replace(/(?:\*\*\/)+\*\*(?![^/])/g, "**");
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else if (ch === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close === -1) re += "\\[";
      else {
        re += `[${glob.slice(i + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
        i = close;
      }
    } else re += ch.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, platform === "win32" ? "i" : "");
}
function globHitsProtected(token, baseDir, ctx, recursive) {
  const resolvedGlob = normalizeForCompare(resolveArgPath(token, baseDir, ctx), ctx.platform);
  const re = globToRegExp(resolvedGlob, ctx.platform);
  const targets = protectedTargets(ctx);
  for (const t of targets) {
    if (re.test(t)) return true;
    if (!recursive) continue;
    for (let cut = t.lastIndexOf("/"); cut > 0; cut = t.lastIndexOf("/", cut - 1)) {
      if (re.test(t.slice(0, cut))) return true;
    }
  }
  const wildcardIdx = resolvedGlob.search(/[*?[]/);
  const staticDir = resolvedGlob.slice(0, resolvedGlob.lastIndexOf("/", wildcardIdx) + 1).replace(/\/$/, "") || "/";
  return protectedRoots(ctx).some((r) => overlapNested(staticDir, normalizeForCompare(r, ctx.platform)));
}

// packages/cli/src/agent/hooks/guard.ts
var ALLOW = { deny: false };
function deny(reason) {
  return { deny: true, reason };
}
var MAX_DEPTH = 8;
var CD_WORDS = /* @__PURE__ */ new Set(["cd", "pushd", "chdir", "set-location", "sl"]);
function isPidbWord(word) {
  return word === "pidb";
}
function pidbArgs(seg) {
  const after = seg.tokens.slice(seg.index + 1);
  const dd = after.indexOf("--");
  if (dd === -1) return { own: after, childStart: null, hasDashDash: false };
  const childTok = seg.spans[seg.index + 1 + dd + 1];
  return { own: after.slice(0, dd), childStart: childTok ? childTok.start : null, hasDashDash: true };
}
function isSecretExec(seg) {
  if (!isPidbWord(seg.word)) return false;
  const own = pidbArgs(seg).own.map((t) => t.toLowerCase());
  const s = own.indexOf("secret");
  return s !== -1 && own[s + 1] === "exec";
}
function expandSegments(text, cwd, ctx, inExec = false, depth = 0, out = []) {
  let effectiveCwd = cwd;
  let execSeen = inExec;
  const group = [];
  for (const raw of splitSegments(text)) {
    const spans = tokenizeSpans(raw);
    const tokens = spans.map((s) => s.value);
    const cw = commandWordOf(tokens);
    const seg = { raw, spans, tokens, word: cw.word, index: cw.index, cwd: effectiveCwd, inExec: execSeen, group };
    out.push(seg);
    group.push(seg);
    const target = tokens[cw.index + 1];
    if (cw.word && CD_WORDS.has(cw.word) && target && target !== "-") effectiveCwd = resolveArgPath(target, effectiveCwd, ctx);
    if (depth >= MAX_DEPTH) continue;
    const script = unwrapInterpreter(raw, spans, cw);
    if (script && script.trim() && script.trim() !== raw) expandSegments(script, seg.cwd, ctx, seg.inExec, depth + 1, out);
    if (isSecretExec(seg)) {
      execSeen = true;
      const { childStart } = pidbArgs(seg);
      if (childStart !== null) expandSegments(raw.slice(childStart), seg.cwd, ctx, true, depth + 1, out);
    }
  }
  return out;
}
function runsDisabledPidbCommand(segments) {
  return segments.some((seg) => {
    if (!isPidbWord(seg.word)) return false;
    const own = pidbArgs(seg).own;
    const next = (own[0] ?? "").toLowerCase();
    if (next === "login" || next === "token") return true;
    if (next !== "secret") return false;
    return own.slice(1).some((t) => t.toLowerCase() === "get" || t === "--print");
  });
}
var PIDB_VAR_REF = /\$\{?PIDB_[A-Za-z0-9_]*\}?|%PIDB_[A-Za-z0-9_]*%|\$\{?env:PIDB_[A-Za-z0-9_]*\}?/i;
var PRINT_WORDS = /* @__PURE__ */ new Set([
  "echo",
  "printf",
  "print",
  "write-output",
  "write",
  "write-host",
  "write-information",
  "write-error",
  "write-warning",
  "write-verbose",
  "out-host",
  "out-default",
  "echo.",
  "cat",
  "type",
  "tee",
  "say"
]);
var ENV_PROVIDER_WORDS = /* @__PURE__ */ new Set([
  "get-item",
  "gi",
  "get-childitem",
  "gci",
  "dir",
  "ls",
  "get-content",
  "gc",
  "cat",
  "type",
  "get-itemproperty",
  "gp",
  "get-itempropertyvalue",
  "gpv"
]);
var DOTNET_GETENV_RE = /\[(System\.)?Environment\]::GetEnvironmentVariables?\b/i;
var PROC_ENVIRON_RE = /\/proc\/[^/\s]+\/environ\b/i;
var ENV_ACCESS_IN_CODE_RE = /process\.env|Deno\.env|Bun\.env|os\.environ|os\.getenv|getenv\(|\bENV\[|\bENV\{|\$ENV\{|%ENV\b|\bENV\.|ENVIRON\b|System\.getenv/;
var WHOLE_ENV_IN_CODE_RE = /process\.env(?![.[\w])|Deno\.env\.toObject|os\.environ(?![[.\w])|os\.environ\.(items|keys|values|copy)|%ENV\b|\bENV\.(to_h|to_a|each|inspect|keys)|\bENVIRON\b(?!\[)|getenv\(\s*\)/;
var PRINTS_ENV_IN_CODE_RE = /(console\.\w+|\bprint(ln|f)?\b|\bputs\b|\bpp\b|\bp[ (]|\bsay\b|\becho\b|std(out|err)\.write|\$stdout|\bSTDOUT\b|\bwarn\b|\bdie\b|\bdump\b|\balert\b)[^;\n]*?(process\.env|Deno\.env|Bun\.env|os\.environ|os\.getenv|getenv\(|\bENV\b|\$ENV\{|%ENV\b|ENVIRON\b|System\.getenv)/;
function inlineCodeOf(seg) {
  const w = seg.word ?? "";
  const args = seg.tokens.slice(seg.index + 1);
  let flagRe = null;
  let printRe = null;
  if (w === "node" || w === "bun" || w === "nodejs") {
    flagRe = /^(-e|-p|-pe|-ep|--eval|--print)$/;
    printRe = /^(-p|-pe|-ep|--print)$/;
  } else if (/^(python[\d.]*|py|pypy[\d.]*)$/.test(w)) flagRe = /^-[a-zA-Z]*c$/;
  else if (w === "ruby") flagRe = /^-[a-zA-Z]*e$/;
  else if (w === "perl") {
    flagRe = /^-[a-zA-Z]*[eE]$/;
    printRe = /^-[a-zA-Z]*p[a-zA-Z]*$/;
  } else if (w === "php") flagRe = /^-r$/;
  else if (w === "deno") {
    const i = args.findIndex((t) => t === "eval");
    if (i === -1) return null;
    const code = args.slice(i + 1).find((t) => !t.startsWith("-"));
    return code === void 0 ? null : { code, printFlag: args.some((t) => t === "-p" || t === "--print") };
  } else if (/^(awk|gawk|mawk|nawk)$/.test(w)) {
    for (let k = 0; k < args.length; k++) {
      const t = args[k];
      if (t === "-f") return null;
      if (t === "-v" || t === "-F") {
        k++;
        continue;
      }
      if (t.startsWith("-")) continue;
      return { code: t, printFlag: false };
    }
    return null;
  }
  if (!flagRe) return null;
  for (let k = 0; k < args.length; k++) {
    const t = args[k];
    const eq = /^(--eval|--print)=(.*)$/s.exec(t);
    if (eq) return { code: eq[2], printFlag: eq[1] === "--print" };
    if (flagRe.test(t) && args[k + 1] !== void 0) {
      return { code: args[k + 1], printFlag: args.some((a) => printRe?.test(a) ?? false) };
    }
  }
  return null;
}
function segmentPrintsEnvironment(seg) {
  const word = seg.word ?? "";
  const args = seg.tokens.slice(seg.index + 1);
  if (/^\$\{?env:pidb_[a-z0-9_]*\}?$/i.test(word)) return true;
  if (word === "env" || word === "printenv" || word === "typeset") return true;
  if (word === "export" && (args.length === 0 || args[0] === "-p")) return true;
  if (word === "declare" && args.every((a) => a.startsWith("-"))) return true;
  if (word === "compgen" && args.some((a) => a === "-v" || a === "-e")) return true;
  if (word === "set" && (args.length === 0 || /^pidb/i.test(args[0]))) return true;
  if (PRINT_WORDS.has(word) && PIDB_VAR_REF.test(seg.raw)) return true;
  if (ENV_PROVIDER_WORDS.has(word) && args.some((a) => /^env:/i.test(a))) return true;
  if (DOTNET_GETENV_RE.test(seg.raw) || PROC_ENVIRON_RE.test(seg.raw)) return true;
  const inline = inlineCodeOf(seg);
  if (inline && ENV_ACCESS_IN_CODE_RE.test(inline.code)) {
    if (inline.printFlag || PRINTS_ENV_IN_CODE_RE.test(inline.code) || WHOLE_ENV_IN_CODE_RE.test(inline.code)) return true;
  }
  return false;
}
var READ_WORDS = /* @__PURE__ */ new Set([
  "cat",
  "type",
  "get-content",
  "gc",
  "less",
  "more",
  "bat",
  "batcat",
  "head",
  "tail",
  "sed",
  "awk",
  "gawk",
  "cp",
  "mv",
  "copy",
  "copy-item",
  "cpi",
  "move-item",
  "xcopy",
  "robocopy",
  "base64",
  "xxd",
  "od",
  "hexdump",
  "strings",
  "vim",
  "vi",
  "nvim",
  "nano",
  "emacs",
  "jq",
  "yq",
  "source",
  ".",
  "tar",
  "zip",
  "7z",
  "gzip",
  "bzip2",
  "xz",
  "diff",
  "cmp",
  "sort",
  "nl",
  "tac",
  "uniq",
  "cut",
  "paste",
  "rev",
  "fold",
  "column",
  "iconv",
  "openssl",
  "scp",
  "rsync",
  "import-csv",
  "curl",
  "http",
  "https",
  "node",
  "nodejs",
  "bun",
  "deno",
  "ruby",
  "perl",
  "php",
  // grep family (pattern-aware below)
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "select-string",
  "sls",
  "findstr"
]);
var GREP_FAMILY = /* @__PURE__ */ new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "findstr"]);
var ALWAYS_RECURSIVE = /* @__PURE__ */ new Set(["rg", "ag", "ack"]);
var GIT_READ_SUBCOMMANDS = /* @__PURE__ */ new Set(["add", "diff", "show", "blame", "cat-file", "hash-object", "apply", "grep"]);
var SEARCH_ARG_FLAGS = {
  grep: /* @__PURE__ */ new Set(["-e", "-f", "-m", "-A", "-B", "-C", "-d", "-D", "--regexp", "--file", "--max-count", "--after-context", "--before-context", "--context", "--include", "--exclude", "--exclude-dir", "--label"]),
  rg: /* @__PURE__ */ new Set(["-e", "-f", "-g", "-t", "-T", "-m", "-A", "-B", "-C", "-j", "-M", "-r", "-E", "-d", "--glob", "--iglob", "--type", "--type-not", "--regexp", "--file", "--max-count", "--replace", "--encoding", "--max-columns", "--context", "--after-context", "--before-context", "--threads", "--sort", "--sortr", "--max-depth", "--type-add", "--ignore-file", "--pre", "--pre-glob", "--color", "--colors", "--max-filesize", "--path-separator"]),
  ag: /* @__PURE__ */ new Set(["-G", "-m", "-A", "-B", "-C", "--ignore", "--ignore-dir", "--file-search-regex"]),
  git: /* @__PURE__ */ new Set(["-e", "-f", "-m", "-A", "-B", "-C", "--max-depth", "--threads", "-O"])
};
SEARCH_ARG_FLAGS.egrep = SEARCH_ARG_FLAGS.grep;
SEARCH_ARG_FLAGS.fgrep = SEARCH_ARG_FLAGS.grep;
SEARCH_ARG_FLAGS.ack = SEARCH_ARG_FLAGS.ag;
var EXEMPT_TOKENS = /* @__PURE__ */ new Set([".", "..", "", "~", "-", "/dev/null", "nul"]);
function operandsOf(args, argFlags, windowsSlashFlags) {
  const out = { positional: [], inputs: [], flagValues: /* @__PURE__ */ new Map(), patternViaFlag: false };
  let afterDashDash = false;
  for (let k = 0; k < args.length; k++) {
    let t = args[k];
    if (/^\d*<<-?$|^\d*<<</.test(t) || t.startsWith("<(")) {
      if (/^\d*<<-?$|^<<<$/.test(t)) k++;
      continue;
    }
    if (/^\d*<<\S/.test(t)) continue;
    const inRedir = /^\d*<(.*)$/s.exec(t);
    if (inRedir) {
      const target = inRedir[1] ? inRedir[1] : args[++k];
      if (target !== void 0) out.inputs.push(target);
      continue;
    }
    const outRedir = /^(\d*|&)>>?(.*)$/s.exec(t);
    if (outRedir) {
      if (!outRedir[2]) k++;
      continue;
    }
    const glued = t.search(/\d*>/);
    if (glued > 0) t = t.slice(0, glued);
    if (!afterDashDash && t === "--") {
      afterDashDash = true;
      continue;
    }
    if (!afterDashDash && t.length > 1 && (t.startsWith("-") || windowsSlashFlags && /^\/[a-zA-Z]{1,2}(:.*)?$/.test(t))) {
      if (/^(-e|-f|--regexp|--file)(=|$)|^-e.|^\/[cg]:/i.test(t)) out.patternViaFlag = true;
      if (argFlags.has(t) && args[k + 1] !== void 0) {
        const list = out.flagValues.get(t) ?? [];
        list.push(args[++k]);
        out.flagValues.set(t, list);
      } else {
        const eq = /^(--[\w-]+)=(.*)$/s.exec(t);
        if (eq) out.flagValues.set(eq[1], [...out.flagValues.get(eq[1]) ?? [], eq[2]]);
      }
      continue;
    }
    out.positional.push(t);
  }
  return out;
}
function filtersAdmitProtected(root, globs, types, ctx) {
  return admittedProtected(root, globs, types, ctx).length > 0;
}
function admittedProtected(root, globs, types, ctx) {
  const pm = pathModFor(ctx.platform);
  const rootN = normalizeForCompare(root, ctx.platform);
  const roots = protectedRoots(ctx).filter((r) => overlapEither(rootN, normalizeForCompare(r, ctx.platform)));
  const files = writtenFiles(ctx).filter((w) => overlapEither(rootN, normalizeForCompare(w, ctx.platform)));
  if (roots.length > 0 || globs.length === 0 && types.length === 0) return [...roots, ...files];
  const positive = globs.filter((g) => !g.startsWith("!"));
  const negative = globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1));
  return files.filter((file) => {
    const fileN = normalizeForCompare(file, ctx.platform);
    const base = pm.basename(file);
    const rel = fileN.startsWith(`${rootN.replace(/\/$/, "")}/`) ? fileN.slice(rootN.replace(/\/$/, "").length + 1) : base;
    const matches = (g) => globToRegExp(g.includes("/") ? g.replace(/^\.\//, "") : g, ctx.platform).test(g.includes("/") ? rel : base);
    if (negative.some(matches)) return false;
    if (positive.length > 0 && !positive.some(matches)) return false;
    if (types.length > 0) {
      const ext = (base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : base).toLowerCase();
      if (!types.some((t) => ["all", "env", "dotenv", "config", ext].includes(t.toLowerCase()))) return false;
    }
    return true;
  });
}
function pathHitsProtected(raw, cwd, ctx, recursive) {
  if (hasWildcard(raw)) return globHitsProtected(raw, cwd, ctx, recursive);
  if (!recursive && EXEMPT_TOKENS.has(raw.toLowerCase())) return false;
  const overlap = recursive ? overlapEither : overlapNested;
  return isProtectedPath(resolveArgPath(raw, cwd, ctx), ctx, overlap);
}
function inlineCodeNamesProtected(code, cwd, ctx) {
  const pm = pathModFor(ctx.platform);
  const basenames = new Set(writtenFiles(ctx).map((w) => normalizeForCompare(pm.basename(w), ctx.platform)));
  for (const m of code.matchAll(/(['"`])([^'"`\n]{1,260})\1/g)) {
    const lit = m[2].trim();
    if (!lit || /\s/.test(lit)) continue;
    if (pathHitsProtected(lit, cwd, ctx, false)) return true;
    const base = lit.split(/[\\/]/).pop() ?? "";
    if (basenames.has(normalizeForCompare(base, ctx.platform))) return true;
  }
  return false;
}
function findReadRoots(seg) {
  if (seg.word !== "find") return null;
  const args = seg.tokens.slice(seg.index + 1);
  const execIdx = args.findIndex((t) => ["-exec", "-execdir", "-ok", "-okdir"].includes(t));
  let reads = execIdx !== -1 && READ_WORDS.has(commandWordOf(args.slice(execIdx + 1)).word ?? "");
  if (!reads) {
    reads = seg.group.some((s) => {
      if (s.word !== "xargs") return false;
      const xa = s.tokens.slice(s.index + 1);
      let k = 0;
      while (k < xa.length && xa[k].startsWith("-")) k += /^-[IaLndPsE]$/.test(xa[k]) ? 2 : 1;
      return READ_WORDS.has(commandWordOf(xa.slice(k)).word ?? "");
    });
  }
  if (!reads) return null;
  const roots = [];
  for (const t of args) {
    if (t.startsWith("-") || t === "(" || t === "!" || t === "\\(") break;
    roots.push(t);
  }
  return roots.length > 0 ? roots : ["."];
}
var COPY_WORDS = /* @__PURE__ */ new Set(["cp", "mv", "copy", "copy-item", "cpi", "move-item", "xcopy", "scp", "rsync"]);
function segmentReadsProtected(seg, ctx) {
  const word = seg.word ?? "";
  const winFlags = ctx.platform === "win32" && word === "findstr";
  let args = seg.tokens.slice(seg.index + 1);
  let searchWord = word === "git" ? "" : word;
  let recursive = false;
  let checkAll = READ_WORDS.has(word);
  if (word === "git") {
    let k = 0;
    while (k < args.length && args[k].startsWith("-")) k += ["-C", "-c", "--git-dir", "--work-tree"].includes(args[k]) ? 2 : 1;
    const sub = (args[k] ?? "").toLowerCase();
    args = args.slice(k + 1);
    checkAll = GIT_READ_SUBCOMMANDS.has(sub);
    if (sub === "grep") {
      searchWord = "git";
      recursive = true;
    }
  }
  const argFlags = SEARCH_ARG_FLAGS[searchWord] ?? /* @__PURE__ */ new Set();
  const ops = operandsOf(args, argFlags, winFlags);
  if (ops.inputs.some((p) => pathHitsProtected(p, seg.cwd, ctx, false))) return "read";
  const findRoots = findReadRoots(seg);
  if (findRoots) return findRoots.some((p) => pathHitsProtected(p, seg.cwd, ctx, true)) ? "read" : false;
  const inline = inlineCodeOf(seg);
  if (inline && inlineCodeNamesProtected(inline.code, seg.cwd, ctx)) return "read";
  if (!checkAll) return false;
  let paths = ops.positional.map((p) => /^(curl|https?)$/.test(word) ? p.replace(/^@/, "") : p);
  if (GREP_FAMILY.has(searchWord) || searchWord === "git") {
    if (word !== "git") {
      recursive = ALWAYS_RECURSIVE.has(word) || args.some((a) => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(a) || a === "--recursive" || a === "--dereference-recursive" || /^--directories=recurse$|^-d\s*recurse$/.test(a)) || word === "findstr" && args.some((a) => /^\/s$/i.test(a));
    }
    if (!ops.patternViaFlag && !(word === "rg" && args.includes("--files"))) paths = paths.slice(1);
    if (recursive && paths.length === 0) paths = ["."];
  }
  if (!recursive) {
    if (COPY_WORDS.has(word) && paths.length >= 2) {
      if (paths.slice(0, -1).some((p) => pathHitsProtected(p, seg.cwd, ctx, false))) return "read";
      return pathHitsProtected(paths[paths.length - 1], seg.cwd, ctx, false) ? "overwrite" : false;
    }
    return paths.some((p) => pathHitsProtected(p, seg.cwd, ctx, false)) ? "read" : false;
  }
  const globs = [...ops.flagValues.get("-g") ?? [], ...ops.flagValues.get("--glob") ?? [], ...ops.flagValues.get("--iglob") ?? [], ...ops.flagValues.get("--include") ?? []];
  const types = [...ops.flagValues.get("-t") ?? [], ...ops.flagValues.get("--type") ?? []];
  const hit = paths.some((p) => {
    if (!pathHitsProtected(p, seg.cwd, ctx, true)) return false;
    if (hasWildcard(p)) return true;
    const resolved = resolveArgPath(p, seg.cwd, ctx);
    if (isProtectedPath(resolved, ctx, overlapNested)) return true;
    return filtersAdmitProtected(resolved, globs, types, ctx);
  });
  return hit ? "read" : false;
}
var CREDENTIAL_STORE_PATTERNS = [
  /security\s+find-generic-password/i,
  /security\s+find-internet-password/i,
  /security\s+dump-keychain/i,
  /cmdkey(\.exe)?\s+\/list/i,
  /Get-StoredCredential/i,
  /secret-tool\s+lookup/i,
  /secret-tool\s+search/i,
  /keyring\s+get/i,
  /@napi-rs\/keyring/i
];
function readsCredentialStore(command, segments) {
  const texts = [command, ...segments.map((s) => s.raw)];
  if (texts.some((t) => CREDENTIAL_STORE_PATTERNS.some((re) => re.test(t)))) return true;
  return segments.some((s) => {
    const inline = inlineCodeOf(s);
    return inline !== null && /\bkeyring\b/i.test(inline.code);
  });
}
var NETWORK_WORDS = /* @__PURE__ */ new Set([
  "curl",
  "wget",
  "wget2",
  "invoke-webrequest",
  "iwr",
  "invoke-restmethod",
  "irm",
  "http",
  "https",
  "xh",
  "xhs",
  "httpie",
  "aria2c",
  "lwp-request",
  "fetch"
]);
function hostAliases(hostname) {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "localhost" || lower === "127.0.0.1" || lower === "::1") return ["localhost", "127.0.0.1", "::1"];
  return [lower];
}
function commandMentionsUrl(command, url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return command.toLowerCase().includes(url.toLowerCase());
  }
  const portSuffix = parsed.port ? `:${parsed.port}` : "";
  const lowerCmd = command.toLowerCase();
  return hostAliases(parsed.hostname).some((host) => lowerCmd.includes(`${host}${portSuffix}`) || lowerCmd.includes(`[${host}]${portSuffix}`));
}
function targetsConfiguredServer(command, segments, ctx) {
  if (!segments.some((s) => NETWORK_WORDS.has(s.word ?? ""))) return false;
  return ctx.serverUrls.some((url) => commandMentionsUrl(command, url));
}
var AGENT_MODE_ESCAPE_RE = /\bPIDB_ALLOW_USER_MODE\b|\bCLAUDECODE\s*=|(?:\s-u\s*|--unset[=\s]\s*|\bunset\s+(?:-v\s+)?)CLAUDECODE\b|env:CLAUDECODE\b/i;
function guardBashCommand(command, cwd, ctx) {
  if (AGENT_MODE_ESCAPE_RE.test(command)) {
    return deny("switching pidb out of agent mode (PIDB_ALLOW_USER_MODE / CLAUDECODE) is for the user only — ask the user to run this themselves.");
  }
  const segments = expandSegments(command, cwd, ctx);
  if (runsDisabledPidbCommand(segments)) {
    return deny(
      "pidb login/token/secret get/--print are not available to the Claude agent — ask the user to run this themselves, or use `pidb connect`/`pidb secret exec` instead."
    );
  }
  if (segments.some((s) => s.inExec && segmentPrintsEnvironment(s))) {
    return deny(
      'this looks like it would print the environment inside `pidb secret exec`, which would leak the substituted secret — use the value only inside the invoked program, e.g. `pidb secret exec <target> "<name>" -- npm test`.'
    );
  }
  const access = segments.map((s) => segmentReadsProtected(s, ctx));
  if (!access.includes("read") && access.includes("overwrite")) {
    return deny(
      "this would overwrite a pidb-written secret file (produced by `pidb secret write|env`) — regenerate it with `pidb secret write|env --out <file>` instead, or write to a different path."
    );
  }
  if (access.includes("read")) {
    return deny(
      "this command reads pidb's protected data (the plugin data dir, its config, or a file `pidb secret write|env` produced) — use the pidb CLI/MCP tools instead of reading it directly."
    );
  }
  if (readsCredentialStore(command, segments)) {
    return deny("reading the OS credential store directly is not available to the agent — use `pidb connect` (or the MCP tools) instead.");
  }
  if (targetsConfiguredServer(command, segments, ctx)) {
    return deny("direct HTTP calls to the pidb server are not available to the agent — use the pidb MCP tools or CLI instead.");
  }
  return ALLOW;
}
var PATH_KEYS = ["file_path", "path", "notebook_path"];
var PROTECTED_PATH_REASON = "this path is inside pidb's protected data (the plugin data dir, its config, or a file `pidb secret write|env` produced) — use the pidb CLI/MCP tools instead of reading it directly.";
function collectStrings(value, depth = 0) {
  if (depth > 8) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((v) => collectStrings(v, depth + 1));
  if (value && typeof value === "object") return Object.values(value).flatMap((v) => collectStrings(v, depth + 1));
  return [];
}
function couldBePath(s) {
  return s !== "" && s !== "." && s.length <= 260 && !/\s/.test(s);
}
function guardMcp(toolInput, cwd, ctx) {
  for (const raw of collectStrings(toolInput)) {
    if (!couldBePath(raw)) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) continue;
    if (isProtectedPath(resolveArgPath(raw, cwd, ctx), ctx, overlapNested)) return deny(PROTECTED_PATH_REASON);
  }
  return ALLOW;
}
function guardGrepTool(toolInput, cwd, ctx) {
  const root = typeof toolInput.path === "string" && toolInput.path !== "" ? resolveArgPath(toolInput.path, cwd, ctx) : cwd;
  if (isProtectedPath(root, ctx, overlapNested)) return deny(PROTECTED_PATH_REASON);
  if (!isProtectedPath(root, ctx, overlapEither)) return ALLOW;
  const globs = typeof toolInput.glob === "string" && toolInput.glob ? toolInput.glob.split(/[\s,]+/).filter(Boolean) : [];
  const types = typeof toolInput.type === "string" && toolInput.type ? [toolInput.type] : [];
  const hits = admittedProtected(root, globs, types, ctx);
  if (hits.length === 0) return ALLOW;
  return deny(
    `this search would reach a file \`pidb secret write|env\` produced (${hits.slice(0, 5).join(", ")}) — pass a \`path\` that does not contain it, or a \`glob\`/\`type\` that excludes it (e.g. \`glob: "*.ts"\`), and never read that file.`
  );
}
function guardPathArgs(toolName, toolInput, cwd, ctx) {
  if (toolName.startsWith("mcp__")) return guardMcp(toolInput, cwd, ctx);
  if (toolName === "Grep") return guardGrepTool(toolInput, cwd, ctx);
  for (const key of PATH_KEYS) {
    const v = toolInput[key];
    if (typeof v === "string" && v !== "" && isProtectedPath(resolveArgPath(v, cwd, ctx), ctx, overlapNested)) return deny(PROTECTED_PATH_REASON);
  }
  if (toolName === "Glob" && typeof toolInput.pattern === "string") {
    const base = typeof toolInput.path === "string" ? resolveArgPath(toolInput.path, cwd, ctx) : cwd;
    if (isProtectedPath(resolveArgPath(toolInput.pattern, base, ctx), ctx, overlapNested)) return deny(PROTECTED_PATH_REASON);
  }
  return ALLOW;
}
function guardDecision(input, ctx) {
  const toolName = input.tool_name ?? "";
  const toolInput = input.tool_input ?? {};
  if (toolName === "Bash") {
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    return guardBashCommand(command, input.cwd, ctx);
  }
  return guardPathArgs(toolName, toolInput, input.cwd, ctx);
}

// packages/cli/src/agent/hooks/redact.ts
var REDACTED = "[pidb:redacted]";
var PIDB_TOKEN_RE = /pidb_[A-Za-z0-9_-]{20,}/g;
var PEM_BLOCK_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
var AKIA_RE = /AKIA[0-9A-Z]{16}/g;
var SENSITIVE_KEY_NAME_RE = /(PASS(WORD)?|SECRET|TOKEN|API_?KEY|PRIVATE)/i;
var KEY_VALUE_LINE_RE = /^([ \t]*(?:export\s+)?)([A-Z][A-Z0-9_]*)=(.*)$/gm;
function redactOutput(text) {
  let out = text.replace(PEM_BLOCK_RE, REDACTED);
  out = out.replace(PIDB_TOKEN_RE, REDACTED);
  out = out.replace(AKIA_RE, REDACTED);
  out = out.replace(KEY_VALUE_LINE_RE, (whole, prefix, key, value) => {
    if (!SENSITIVE_KEY_NAME_RE.test(key)) return whole;
    if (value.length === 0) return whole;
    return `${prefix}${key}=${REDACTED}`;
  });
  return out;
}
function redactToolResponse(toolResponse) {
  if (typeof toolResponse === "string") {
    const value = redactOutput(toolResponse);
    return { changed: value !== toolResponse, value };
  }
  if (toolResponse && typeof toolResponse === "object" && !Array.isArray(toolResponse)) {
    const obj = toolResponse;
    const out = { ...obj };
    let changed = false;
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value !== "string") continue;
      const redacted = redactOutput(value);
      if (redacted !== value) {
        changed = true;
        out[key] = redacted;
      }
    }
    return { changed, value: out };
  }
  return { changed: false, value: toolResponse };
}

// packages/cli/src/client.ts
function exitCodeFor(status) {
  if (status === 401 || status === 403) return EXIT_AUTH;
  if (status === 404) return EXIT_NOT_FOUND;
  return EXIT_GENERIC;
}
function describeError(status, body) {
  if (status === 401 && body.error === "token_expired") return "token expired — run `pidb login <url>` again";
  const head = body.message && body.message !== body.error ? `${body.error}: ${body.message}` : body.error;
  const lines = [`${head} (HTTP ${status})`];
  if (typeof body.scope === "string") lines.push(`  required scope: ${body.scope}`);
  if (Array.isArray(body.findings)) {
    for (const f of body.findings) {
      const finding = f;
      lines.push(`  line ${finding.line ?? "?"}: ${finding.reason ?? "possible secret value"}`);
    }
    lines.push("  re-run with --force to save anyway");
  }
  if (Array.isArray(body.unresolved)) {
    lines.push(`  unresolved refs: ${body.unresolved.join(", ")}`);
    lines.push("  re-run with --force to save anyway");
  }
  if (Array.isArray(body.issues)) {
    for (const i of body.issues) {
      const issue = i;
      const path = (issue.path ?? []).join(".") || "(root)";
      lines.push(`  ${path}: ${issue.message ?? "invalid"}`);
    }
  }
  return lines.join("\n");
}
var ApiError = class extends CliError {
  constructor(status, body) {
    super(describeError(status, body), exitCodeFor(status));
    this.status = status;
    this.body = body;
    this.name = "ApiError";
  }
  status;
  body;
};
var PidbClient = class {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }
  config;
  fetchImpl;
  get url() {
    return this.config.url;
  }
  target(path, query) {
    const u = new URL(this.config.url + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== void 0) u.searchParams.set(key, String(value));
    }
    return u.toString();
  }
  async send(method, path, opts = {}) {
    const headers = { accept: opts.accept ?? "application/json" };
    if (this.config.token) headers.authorization = `Bearer ${this.config.token}`;
    if (opts.body !== void 0) headers["content-type"] = "application/json";
    let res;
    try {
      res = await this.fetchImpl(this.target(path, opts.query), {
        method,
        headers,
        body: opts.body === void 0 ? void 0 : JSON.stringify(opts.body)
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new CliError(`cannot reach ${this.config.url}: ${reason}`);
    }
    if (!res.ok) {
      const text = await res.text();
      let body = { error: "http_error", message: text.slice(0, 500) };
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && typeof parsed.error === "string") {
          body = parsed;
        }
      } catch {
      }
      throw new ApiError(res.status, body);
    }
    return res;
  }
  async json(method, path, opts) {
    const res = await this.send(method, path, opts);
    return await res.json();
  }
  /** Same as json(), but keeps the status code — `PUT /docs/:doc` answers 201 on create and 200 on update. */
  async jsonStatus(method, path, opts) {
    const res = await this.send(method, path, opts);
    return { status: res.status, data: await res.json() };
  }
  async text(method, path, opts) {
    const res = await this.send(method, path, { ...opts, accept: "text/plain" });
    return await res.text();
  }
  async empty(method, path, opts) {
    await this.send(method, path, opts);
  }
};

// packages/cli/src/agent/hooks/session-start.ts
var MAX_CONTEXT_CHARS = 4096;
var MAX_LIST_ITEMS = 20;
var GOLDEN_RULES = [
  "Never ask the user to paste a secret or token into chat; never print, echo, log, cat or base64 a secret.",
  'Use values only via `pidb secret exec <target> "<name>" -- <cmd>` (env PIDB_<KEY>), or `pidb secret write|env --out <file>` for tools that need files; never read those files back.',
  "Missing secret → call `secret_request_link` and give the user the link; wait; verify with `list_secrets`.",
  'Keep project docs current with `write_document` (architecture, runbooks, decisions — the project "memory"); update project summary/tags with `update_project`; non-secret connection facts (host, port, url, username, database, public_key) go into non-sensitive fields via `upsert_secret_meta`; any other key → `secret_request_link`.',
  "401/expired → run `pidb connect` (the user approves in the browser); 403 on a project → `pidb connect` to widen.",
  "Never use curl against the pidb server; use MCP tools / the CLI."
];
var GOLDEN_RULES_BLOCK = ["", "Golden rules:", ...GOLDEN_RULES.map((r, i) => `${i + 1}. ${r}`)].join("\n");
function bulletedList(items, max) {
  if (items.length <= max) return items.map((i) => `- ${i}`);
  const shown = items.slice(0, max).map((i) => `- ${i}`);
  shown.push(`… ${items.length - max} more`);
  return shown;
}
async function fetchProjectDetail(url, token, project, deps, deadline) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const client = new PidbClient({ url, token }, fetchImpl);
    return await withDeadline(client.json("GET", `/api/v1/projects/${encodeURIComponent(project)}`), deadline);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 404)) return err.status;
    return "down";
  }
}
function withDeadline(p, deadline) {
  const ms = Math.max(deadline - Date.now(), 0);
  return new Promise((resolve2, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve2(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}
async function buildBody(deps, deadline) {
  const profiles = loadProfiles(deps.dataDir);
  const bindings = loadBindings(deps.dataDir);
  const binding = bindings[repoKey(deps.cwd)];
  const profileName = binding?.profile ?? profiles.default;
  const profile = profileName ? profiles.profiles[profileName] : void 0;
  if (!profileName || !profile) {
    return [
      "pidb: no server configured for this agent.",
      "Ask the user to run `/pidb:server <name> <url>` and then `/pidb:connect` (or `pidb profile add <name> <url>` / `pidb connect` directly)."
    ];
  }
  const lines = [`pidb: profile "${profileName}" — ${profile.url}`];
  const token = await withDeadline(Promise.resolve(deps.store.get(profileName)), deadline);
  if (!token) {
    lines.push("Not connected — run `pidb connect` (browser approval), or ask the user to run `/pidb:connect`.");
    return lines;
  }
  lines.push("Connected.");
  if (!binding?.project) {
    lines.push("This repo is not bound to a pidb project — call `pidb_bind` or ask the user which project this is.");
    return lines;
  }
  lines.push(`Bound project: ${binding.project}`);
  const detail = await fetchProjectDetail(profile.url, token, binding.project, deps, deadline);
  if (detail === "down") {
    lines.push(`pidb server (${profile.url}) is unreachable right now — project details unavailable this session.`);
    return lines;
  }
  if (detail === 401) {
    lines.push("pidb: token expired or revoked — run `pidb connect`.");
    return lines;
  }
  if (detail === 403) {
    lines.push(`pidb: the token lacks access to project "${binding.project}" — run \`pidb connect\` to widen.`);
    return lines;
  }
  if (detail === 404) {
    lines.push(
      `Project "${binding.project}" not found or not approved for this token — run \`pidb connect\` to approve it, or \`pidb bind\` another.`
    );
    return lines;
  }
  if (detail.summary) lines.push(`Summary: ${detail.summary}`);
  if (detail.tags.length > 0) lines.push(`Tags: ${detail.tags.join(", ")}`);
  if (detail.documents.length > 0) {
    lines.push("Documents:", ...bulletedList(detail.documents.map((d) => `${d.slug} — ${d.title}`), MAX_LIST_ITEMS));
  } else {
    lines.push("Documents: none yet.");
  }
  if (detail.secrets.length > 0) {
    lines.push(
      "Secrets:",
      ...bulletedList(
        detail.secrets.map((s) => `${s.name} (${s.fields.map((f) => f.sensitive ? `${f.key}*` : f.key).join(", ") || "no fields"})`),
        MAX_LIST_ITEMS
      )
    );
  } else {
    lines.push("Secrets: none yet.");
  }
  return lines;
}
function finalize(bodyLines) {
  const budget = Math.max(MAX_CONTEXT_CHARS - GOLDEN_RULES_BLOCK.length - 1, 0);
  let body = bodyLines.join("\n");
  if (body.length > budget) {
    body = budget > 0 ? `${body.slice(0, Math.max(budget - 1, 0))}…` : "";
  }
  return `${body}
${GOLDEN_RULES_BLOCK}`;
}
function fallbackContext(message, notes = []) {
  return finalize([...notes, `pidb: session context unavailable (${message}).`]);
}
async function sessionContext(deps) {
  const deadline = Date.now() + Math.min(deps.timeoutMs ?? 4e3, 4e3);
  const notes = [];
  if (deps.ensureDeps) {
    try {
      const note = await withDeadline(Promise.resolve(deps.ensureDeps()), deadline);
      if (typeof note === "string" && note) notes.push(note);
    } catch {
    }
  }
  try {
    return finalize([...notes, ...await buildBody(deps, deadline)]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fallbackContext(message, notes);
  }
}

// packages/cli/src/agent/hooks/index.ts
function parseHookInput(stdinText) {
  const trimmed = stdinText.trim();
  if (!trimmed) throw new Error("empty stdin (expected a JSON hook payload)");
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("hook input is not a JSON object");
  }
  const obj = parsed;
  return {
    hook_event_name: typeof obj.hook_event_name === "string" ? obj.hook_event_name : "",
    session_id: typeof obj.session_id === "string" ? obj.session_id : void 0,
    cwd: typeof obj.cwd === "string" ? obj.cwd : process.cwd(),
    tool_name: typeof obj.tool_name === "string" ? obj.tool_name : void 0,
    tool_input: obj.tool_input && typeof obj.tool_input === "object" && !Array.isArray(obj.tool_input) ? obj.tool_input : {},
    tool_response: obj.tool_response
  };
}
function collectServerUrls(dataDir) {
  try {
    return Object.values(loadProfiles(dataDir).profiles).map((p) => p.url);
  } catch {
    return [];
  }
}
function loadWrittenPathsSafe(dataDir) {
  try {
    return { paths: loadWritten(dataDir).paths };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { paths: [], note: `pidb hook (guard): written.json unreadable (${message}) — treating as empty` };
  }
}
function guardOutput(reason) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason }
  });
}
function redactHookOutput(updatedToolOutput) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput } });
}
function sessionStartOutput(additionalContext) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } });
}
function exportDataDir(env, dataDir) {
  const file = env.CLAUDE_ENV_FILE;
  if (!file) return;
  const quoted = `'${dataDir.replace(/'/g, `'\\''`)}'`;
  try {
    appendFileSync(file, `export PIDB_PLUGIN_DATA=${quoted}
`);
  } catch {
  }
}
async function dispatch(kind, stdinText, env, deps) {
  const dataDir = env.CLAUDE_PLUGIN_DATA || resolveDataDir(env);
  if (kind === "session-start") {
    let cwd = process.cwd();
    try {
      cwd = parseHookInput(stdinText).cwd;
    } catch {
    }
    exportDataDir(env, dataDir);
    const store = deps.store ?? keyringStore(dataDir);
    const context = await sessionContext({
      cwd,
      dataDir,
      store,
      fetchImpl: deps.fetchImpl,
      timeoutMs: deps.timeoutMs,
      ensureDeps: deps.ensureDeps
    });
    return { stdout: sessionStartOutput(context), exitCode: 0 };
  }
  const input = parseHookInput(stdinText);
  if (kind === "guard") {
    const written = loadWrittenPathsSafe(dataDir);
    const ctx = {
      dataDir,
      written: written.paths,
      serverUrls: collectServerUrls(dataDir),
      home: env.HOME ?? homedir2(),
      platform: deps.platform ?? process.platform,
      // Fix round 1 Minor #8: production reads the real `%APPDATA%` from the environment rather than
      // always falling back to the `<home>\AppData\Roaming` convention `guard.ts` uses when unset.
      appData: env.APPDATA
    };
    const decision = guardDecision(input, ctx);
    const stdout = decision.deny ? guardOutput(decision.reason) : "";
    return { stdout, exitCode: 0, stderr: written.note };
  }
  const { changed, value } = redactToolResponse(input.tool_response);
  return changed ? { stdout: redactHookOutput(value), exitCode: 0 } : { stdout: "", exitCode: 0 };
}
async function runHook(kind, stdinText, env = process.env, deps = {}) {
  try {
    return await dispatch(kind, stdinText, env, deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (kind === "session-start") {
      return { stdout: sessionStartOutput(fallbackContext(message)), exitCode: 0, stderr: `pidb hook (session-start): ${message}` };
    }
    return { stdout: "", exitCode: 0, stderr: `pidb hook (${kind}): ${message} — allowing by default` };
  }
}

// packages/cli/src/agent/hooks/main.ts
var VALID_KINDS = ["guard", "redact", "session-start"];
function isValidKind(k) {
  return k !== void 0 && VALID_KINDS.includes(k);
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function main() {
  const kindArg = process.argv[2];
  if (!isValidKind(kindArg)) {
    console.error(`pidb hook: unknown or missing kind "${kindArg ?? ""}" (expected guard|redact|session-start)`);
    process.exit(0);
  }
  let stdinText = "";
  try {
    stdinText = await readStdin();
  } catch {
  }
  const env = process.env;
  const deps = kindArg === "session-start" ? { ensureDeps: () => ensureDeps({ dataDir: env.CLAUDE_PLUGIN_DATA || resolveDataDir(env), pluginRoot: pluginRootFrom(env) }) } : {};
  const result = await runHook(kindArg, stdinText, env, deps);
  if (result.stderr) console.error(result.stderr);
  exitAfterWrite(result.stdout);
}
function exitAfterWrite(text) {
  process.exitCode = 0;
  if (!text) {
    process.exit(0);
  }
  process.stdout.write(text, () => process.exit(0));
}
function isEntryPoint() {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync2(arg);
  } catch {
    return false;
  }
}
if (isEntryPoint()) {
  void main().catch((err) => {
    console.error(`pidb hook: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(0);
  });
}
export {
  main
};

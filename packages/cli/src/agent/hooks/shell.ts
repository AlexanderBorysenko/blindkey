// Shell-text model for the PreToolUse guard (Fix round 4): a quote-aware tokenizer with source spans,
// a segment splitter, command-word resolution (prefix skipping, basename), and interpreter unwrapping
// (`sh -lc '...'`, `pwsh -Command "..."`, `cmd /c ...`). Deliberately *not* a full shell parser — it
// only has to be good enough for a heuristic, defense-in-depth guard (spec §3.1), and every
// approximation errs toward producing *more* segments (never fewer).

export interface Token {
  /** The token's value with quotes removed and simple escapes resolved. */
  value: string;
  /** Offsets of the token's raw text in the source string. */
  start: number;
  end: number;
  /** Whether any part of the token was quoted. */
  quoted: boolean;
}

/** Index just past the `)` matching the `$(` whose `(` sits at `open` (quote-aware, nested). */
function skipParenGroup(text: string, open: number): number {
  let depth = 1;
  let i = open + 1;
  while (i < text.length && depth > 0) {
    const ch = text[i]!;
    if (ch === "'") {
      const close = text.indexOf("'", i + 1);
      i = close === -1 ? text.length : close + 1;
      continue;
    }
    if (ch === '"') {
      i = skipDoubleQuoted(text, i);
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    i++;
  }
  return i;
}

/** Index just past the closing `"` of the double-quoted span starting at `open`. */
function skipDoubleQuoted(text: string, open: number): number {
  let i = open + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\' && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (ch === '$' && text[i + 1] === '(') {
      i = skipParenGroup(text, i + 1);
      continue;
    }
    if (ch === '"') return i + 1;
    i++;
  }
  return text.length;
}

const DQ_ESCAPABLE = new Set(['"', '\\', '$', '`']);

/**
 * Quote-aware tokenizer. A `'...'`/`"..."` span becomes part of the current token with its quotes
 * stripped (`"get token"` is ONE token, `''` is an explicit empty token); `$(...)` and `` `...` `` are
 * kept whole inside their token. Backslash escapes are resolved only where POSIX and Windows paths
 * can't be confused: inside double quotes before `"`/`\`/`$`/`` ` ``, and unquoted before a quote or
 * whitespace — so `.\.env` and `%APPDATA%\pidb` survive intact.
 */
export function tokenizeSpans(text: string): Token[] {
  const tokens: Token[] = [];
  let value = '';
  let start = -1;
  let quoted = false;
  const n = text.length;
  const push = (end: number): void => {
    if (start !== -1) tokens.push({ value, start, end, quoted });
    value = '';
    start = -1;
    quoted = false;
  };
  let i = 0;
  while (i < n) {
    const ch = text[i]!;
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
      value += body.replace(/\\(.)/g, (whole, c: string) => (DQ_ESCAPABLE.has(c) ? c : whole));
      quoted = true;
      i = end;
      continue;
    }
    if (ch === '\\' && i + 1 < n && /["'\s]/.test(text[i + 1]!)) {
      value += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === '$' && text[i + 1] === '(') {
      const end = skipParenGroup(text, i + 1);
      value += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '`') {
      const close = text.indexOf('`', i + 1);
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

export function tokenize(text: string): string[] {
  return tokenizeSpans(text).map((t) => t.value);
}

/**
 * Splits `text` into segments on newlines, `;`, `&`, `&&`, `|`, `||`, `(`, `)` — quote-aware, and not
 * on the `&` of a `2>&1`/`>&2`/`&>` redirection. Command substitutions (`$(...)`, backticks) are kept
 * in their enclosing segment's text AND their contents are split into additional segments — including
 * substitutions *inside double quotes* (`echo "$(env)"`), which the shell still executes. Single
 * quotes are fully literal.
 */
export function splitSegments(text: string): string[] {
  const out: string[] = [];
  let current = '';
  const n = text.length;
  const flush = (): void => {
    const t = current.trim();
    if (t) out.push(t);
    current = '';
  };
  const substitutions: string[] = [];
  const scanDoubleQuoted = (open: number): number => {
    const end = skipDoubleQuoted(text, open);
    const closeIdx = text[end - 1] === '"' && end - 1 > open ? end - 1 : end;
    let j = open + 1;
    while (j < closeIdx) {
      const c = text[j]!;
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '$' && text[j + 1] === '(') {
        const e = skipParenGroup(text, j + 1);
        substitutions.push(text.slice(j + 2, Math.max(e - 1, j + 2)));
        j = e;
        continue;
      }
      if (c === '`') {
        const close = text.indexOf('`', j + 1);
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
  const heredocs: Array<{ delim: string; strip: boolean; owner: string }> = [];
  let i = 0;
  while (i < n) {
    const ch = text[i]!;
    if (ch === '<' && text[i + 1] === '<' && text[i + 2] !== '<') {
      const m = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([A-Za-z0-9_.-]+))/.exec(text.slice(i));
      if (m) {
        heredocs.push({ delim: m[2] ?? m[3] ?? m[4] ?? '', strip: m[1] === '-', owner: current });
        current += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (ch === '\n' && heredocs.length > 0) {
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
    if (ch === '\\' && i + 1 < n && /["'\s;&|()`$]/.test(text[i + 1]!)) {
      current += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '$' && text[i + 1] === '(') {
      const end = skipParenGroup(text, i + 1);
      substitutions.push(text.slice(i + 2, Math.max(end - 1, i + 2)));
      current += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '`') {
      const close = text.indexOf('`', i + 1);
      const end = close === -1 ? n : close + 1;
      substitutions.push(text.slice(i + 1, close === -1 ? n : close));
      current += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '&' && (text[i - 1] === '>' || text[i - 1] === '<' || text[i + 1] === '>')) {
      current += ch;
      i++;
      continue;
    }
    if (ch === '\n' || ch === ';' || ch === '&' || ch === '|' || ch === '(' || ch === ')') {
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

const SCRIPT_CONSUMERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'powershell', 'pwsh', 'cmd', 'source', '.', 'eval']);

/**
 * Consumes here-document bodies starting at `from` (the char after the newline that ends the `<<`
 * line); returns the index after the last delimiter line. A body fed to a shell (`bash <<EOF`) is
 * code, so its lines become segments; any other body (`cat <<EOF > notes.md`) is data and is dropped
 * — so documentation text in a heredoc never trips a rule.
 */
function consumeHeredocBodies(text: string, from: number, docs: Array<{ delim: string; strip: boolean; owner: string }>, out: string[]): number {
  let i = from;
  for (const doc of docs) {
    const lines: string[] = [];
    while (i < text.length) {
      const nl = text.indexOf('\n', i);
      const line = text.slice(i, nl === -1 ? text.length : nl);
      i = nl === -1 ? text.length : nl + 1;
      if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delim) break;
      lines.push(line);
    }
    const ownerTokens = tokenize(doc.owner);
    let owner = commandWordOf(ownerTokens).word;
    const dd = ownerTokens.indexOf('--');
    if (owner === 'pidb' && dd !== -1) owner = commandWordOf(ownerTokens.slice(dd + 1)).word; // `pidb secret exec ... -- sh <<EOF`
    if (owner && SCRIPT_CONSUMERS.has(owner)) out.push(...splitSegments(lines.join('\n')));
  }
  return i;
}

/** Lower-cased basename of a command token, minus a Windows executable extension. */
export function commandBasename(token: string): string {
  const lower = token.toLowerCase();
  const cut = Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\'));
  const base = cut === -1 || cut === lower.length - 1 ? lower : lower.slice(cut + 1);
  return base.replace(/\.(exe|cmd|bat|com)$/, '');
}

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const KEYWORD_PREFIXES = new Set(['!', '{', '}', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'builtin', 'nohup', 'exec']);

/**
 * Per-prefix option handling: which flags take a separate argument. A prefix is skipped together with
 * its options; what follows is the real command (`sudo -E env` → `env`, `nice -n 5 make` → `make`).
 */
const PREFIX_ARG_FLAGS: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-C', '-p', '-h', '-U', '-r', '-t', '-D', '--user', '--group']),
  time: new Set(['-f', '-o', '--format', '--output']),
  command: new Set(),
  nice: new Set(['-n', '--adjustment']),
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  npx: new Set(['-p', '--package', '-c', '--call']),
  bunx: new Set(['-p', '--package']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  stdbuf: new Set(['-i', '-o', '-e']),
  doas: new Set(['-u', '-C']),
};

export interface CommandWord {
  /** Basename of the effective command (lower-cased, `.exe`/`.cmd` stripped), or null. */
  word: string | null;
  /** Index of that command's token in the segment's token list. */
  index: number;
}

/**
 * The segment's effective command word: skips `!`, shell keywords (`then`, `do`, ...), `NAME=value`
 * assignments, and runner prefixes with their options — `env [-i] [-u X] [VAR=x]`, `sudo [-E] [-u u]`,
 * `time`, `command`, `nohup`, `nice [-n N]`, `exec`, `timeout <dur>`, `npx`, `bunx`, `npm exec|x`,
 * `pnpm [exec|dlx]`, `yarn [dlx|exec]`. A prefix with nothing after it IS the command (`env`,
 * `sudo -E env`, `time env` all resolve to `env`).
 */
const REDIRECT_RE = /^(\d*|&)(>>?|<<?<?|>&|<&)/;

/** Index of the first token at/after `j` that isn't a redirection (`>out`, `2>&1`, `> file`, `<in`). */
function skipRedirections(tokens: string[], j: number): number {
  while (j < tokens.length) {
    const m = REDIRECT_RE.exec(tokens[j]!);
    if (!m) break;
    j += m[0].length === tokens[j]!.length ? 2 : 1;
  }
  return j;
}

export function commandWordOf(tokens: string[]): CommandWord {
  let i = 0;
  for (;;) {
    i = skipRedirections(tokens, i);
    const tok = tokens[i];
    if (tok === undefined) return { word: null, index: i };
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
      const argFlags = PREFIX_ARG_FLAGS[base]!;
      let j = i + 1;
      if (base === 'timeout') {
        while (j < tokens.length && tokens[j]!.startsWith('-')) j += argFlags.has(tokens[j]!) ? 2 : 1;
        j++; // the duration
      } else {
        while (j < tokens.length) {
          const t = tokens[j]!;
          if (t === '--') {
            j++;
            break;
          }
          if (base === 'nice' && /^-\d+$/.test(t)) {
            j++;
            continue;
          }
          if (!t.startsWith('-') || t === '-') break;
          j += argFlags.has(t) ? 2 : 1;
        }
        if (base === 'env') while (j < tokens.length && ENV_ASSIGNMENT_RE.test(tokens[j]!)) j++;
      }
      next = j;
    } else if (base === 'npm' && ['exec', 'x'].includes((tokens[i + 1] ?? '').toLowerCase())) {
      next = i + 2;
      while (next < tokens.length && tokens[next]!.startsWith('-')) next++;
    } else if (base === 'pnpm' || base === 'yarn') {
      next = ['exec', 'dlx'].includes((tokens[i + 1] ?? '').toLowerCase()) ? i + 2 : i + 1;
      while (next < tokens.length && tokens[next]!.startsWith('-')) next++;
    }
    if (next === -1) return { word: base, index: i };
    next = skipRedirections(tokens, next);
    if (next >= tokens.length) return { word: base, index: i }; // prefix with nothing after it
    i = next;
  }
}

const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish']);
const POWERSHELLS = new Set(['powershell', 'pwsh']);
const PS_COMMAND_FLAG_RE = /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i;
const PS_ENCODED_FLAG_RE = /^-(e|ec|en|enc|encodedcommand|encodedc\w*)$/i;
const PS_ARG_FLAGS = new Set(['-executionpolicy', '-ep', '-ex', '-file', '-f', '-windowstyle', '-w', '-configurationname', '-workingdirectory', '-wd', '-inputformat', '-outputformat', '-psconsolefile', '-version', '-v', '-settingsfile']);

/** The rest of the segment from token `k` on, as script text: a single token's value, else the raw slice. */
function scriptFrom(raw: string, spans: Token[], k: number): string | null {
  if (k >= spans.length) return null;
  if (k === spans.length - 1) return spans[k]!.value;
  return raw.slice(spans[k]!.start);
}

/**
 * If the segment runs an interpreter on an inline script — `sh|bash|zsh|dash|ksh -<flags with c>
 * '<script>'` (flag clusters `-lc`/`-ec`/`-ic`/`-xc` included), `powershell|pwsh -c|-Command <script>`
 * (or `-EncodedCommand <base64>`), `cmd[.exe] /c|/k <script>` — returns that script text (outer quotes
 * stripped); otherwise null.
 */
export function unwrapInterpreter(raw: string, spans: Token[], cw: CommandWord): string | null {
  const word = cw.word;
  if (!word) return null;
  const tokens = spans.map((s) => s.value);
  if (POSIX_SHELLS.has(word)) {
    let sawC = false;
    for (let k = cw.index + 1; k < tokens.length; k++) {
      const t = tokens[k]!;
      if (t === '--' || t === '-') continue;
      if (/^[-+][oO]$/.test(t)) {
        k++;
        continue;
      }
      if (t.startsWith('--')) continue;
      if (/^[-+][a-zA-Z]+$/.test(t)) {
        if (t.startsWith('-') && t.includes('c')) sawC = true;
        continue;
      }
      return sawC ? t : null;
    }
    return null;
  }
  if (POWERSHELLS.has(word)) {
    for (let k = cw.index + 1; k < tokens.length; k++) {
      const t = tokens[k]!;
      if (PS_COMMAND_FLAG_RE.test(t)) return scriptFrom(raw, spans, k + 1);
      if (PS_ENCODED_FLAG_RE.test(t)) {
        const b64 = tokens[k + 1];
        if (!b64) return null;
        try {
          return Buffer.from(b64, 'base64').toString('utf16le');
        } catch {
          return null;
        }
      }
      if (t.startsWith('-')) {
        if (PS_ARG_FLAGS.has(t.toLowerCase())) k++;
        continue;
      }
      // `powershell <script>` defaults to -Command (pwsh defaults to -File — a script path, not code).
      return word === 'powershell' ? scriptFrom(raw, spans, k) : null;
    }
    return null;
  }
  if (word === 'cmd') {
    for (let k = cw.index + 1; k < tokens.length; k++) {
      const t = tokens[k]!;
      const m = /^\/[ck](.*)$/i.exec(t);
      if (m) {
        if (m[1]) return raw.slice(spans[k]!.start + 2);
        return scriptFrom(raw, spans, k + 1);
      }
      if (!t.startsWith('/')) return null;
    }
    return null;
  }
  return null;
}

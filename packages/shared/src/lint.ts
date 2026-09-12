export interface LintFinding {
  line: number;
  reason: string;
}

interface Pattern {
  re: RegExp;
  reason: string;
}

const PATTERNS: Pattern[] = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, reason: 'PEM private key block' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, reason: 'AWS access key id' },
  { re: /\bsk_(?:live|test)_[A-Za-z0-9]{10,}/, reason: 'Stripe secret key' },
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/, reason: 'GitHub token' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, reason: 'Slack token' },
  { re: /\bsk-[A-Za-z0-9_-]{20,}\b/, reason: 'API secret key (sk-...)' },
];

const ASSIGN_RE = /(?<![A-Za-z])(password|passwd|pwd|secret|token|api[_-]?key)\b\s*[:=]\s*["']?([^\s"'{}<>$]{6,})/gi;
const BASE64_RE = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/=])/;
const HEX_RE = /\b[0-9a-fA-F]{32,}\b/;
const FENCE_RE = /^\s*(```|~~~)\s*([A-Za-z0-9_-]*)/;
const GIT_SHA1_LEN = 40;

function looksLikeRealValue(v: string): boolean {
  if (v.length >= 12) return true;
  return /[0-9!@#%^&*()_+\-=[\]|;,.?/\\]/.test(v);
}

export function lintForSecrets(md: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const lines = md.split(/\r?\n/);

  // First pass: identify lines inside closed example fences
  const exampleFenceLines = new Set<number>();
  let inFence = false;
  let fenceIsExample = false;
  let fenceMarker = '';
  let fenceStartIdx = -1;

  lines.forEach((line, idx) => {
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1] ?? '';
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
        fenceIsExample = (fence[2] ?? '').toLowerCase() === 'example';
        fenceStartIdx = idx;
      } else if (marker === fenceMarker) {
        // Fence is properly closed
        if (fenceIsExample) {
          // Mark all lines between fenceStartIdx and idx as inside example fence (exclude the fence lines themselves)
          for (let i = fenceStartIdx + 1; i < idx; i++) {
            exampleFenceLines.add(i);
          }
        }
        inFence = false;
        fenceIsExample = false;
      }
    }
  });

  // Main linting pass
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const fence = FENCE_RE.exec(line);
    if (fence) {
      // Skip fence marker lines
      return;
    }
    if (exampleFenceLines.has(idx)) {
      // Skip lines inside closed example fences
      return;
    }

    for (const p of PATTERNS) {
      if (p.re.test(line)) findings.push({ line: lineNo, reason: p.reason });
    }
    for (const m of line.matchAll(ASSIGN_RE)) {
      const value = m[2] ?? '';
      if (looksLikeRealValue(value)) {
        findings.push({ line: lineNo, reason: 'credential assignment' });
        break;
      }
    }
    const b64 = BASE64_RE.exec(line);
    const isB64Blob = b64 !== null && !/^[0-9a-fA-F]+={0,2}$/.test(b64[0]);
    const hexMatch = HEX_RE.exec(line);
    const isHex = hexMatch !== null && hexMatch[0].length !== GIT_SHA1_LEN;
    if (isB64Blob || isHex) {
      findings.push({ line: lineNo, reason: 'long base64/hex string' });
    }
  });
  return findings;
}

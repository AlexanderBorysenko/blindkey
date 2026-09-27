import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const CTRL_C = '\u0003';
const BACKSPACE = '\u007f';

/**
 * A piped (non-TTY) stdin can only be read by one consumer: the underlying
 * stream has no "peek", so giving each prompt its own readline interface
 * swallows the whole buffered input on the first read and starves every
 * later prompt. Worse, `Interface#question()` itself never settles once the
 * input stream has ended (its answer resolver is silently dropped on close),
 * so a naive "one shared interface, call .question() again" fix just hangs
 * on the second prompt instead of misreading it.
 *
 * Instead, every non-TTY prompt in the process reads from one shared queue
 * fed by a single `line` listener: buffered lines that arrive before anyone
 * asks for them wait in `queue`; a prompt that arrives first registers a
 * `waiter` that the next `line` (or `close`, meaning no more input) resolves.
 * This lets username, password and a 2FA code — three separate prompts —
 * each pull the next line of one piped answer stream, in order.
 *
 * Between prompts (no waiter registered), the reader is paused and `stdin` is
 * unref'd: a caller that keeps its end of the pipe open (a `spawn` with the
 * default `stdio: 'pipe'`, `docker exec -i`, a CI harness) must not force
 * `pidb login` to keep running until that pipe closes once it already has
 * every answer it asked for. `nextNonTtyLine` re-arms both when a waiter
 * needs a line. Pausing the reader can still let an already-received chunk
 * finish emitting any further `line` events it contains (Node parses a
 * chunk's lines synchronously as it arrives, before an in-handler `pause()`
 * takes effect) — those extra lines land in `queue`, not lost.
 */
interface NonTtyLineSource {
  rl: readline.Interface;
  queue: string[];
  waiters: ((line: string | null) => void)[];
  ended: boolean;
}

let sharedSource: NonTtyLineSource | undefined;

function goIdle(source: NonTtyLineSource): void {
  source.rl.pause();
  stdin.unref();
}

function wake(source: NonTtyLineSource): void {
  stdin.ref();
  source.rl.resume();
}

function nonTtySource(): NonTtyLineSource {
  if (sharedSource) return sharedSource;
  const rl = readline.createInterface({ input: stdin, terminal: false });
  const source: NonTtyLineSource = { rl, queue: [], waiters: [], ended: false };
  rl.on('line', (line: string) => {
    const waiter = source.waiters.shift();
    if (!waiter) {
      source.queue.push(line);
      return;
    }
    waiter(line);
    if (source.waiters.length === 0) goIdle(source);
  });
  rl.on('close', () => {
    source.ended = true;
    let waiter: ((line: string | null) => void) | undefined;
    while ((waiter = source.waiters.shift())) waiter(null);
  });
  goIdle(source); // nobody has asked for a line yet
  sharedSource = source;
  return source;
}

/** Resolves with the next line of piped stdin, or null once it has ended. */
function nextNonTtyLine(): Promise<string | null> {
  const source = nonTtySource();
  if (source.queue.length > 0) return Promise.resolve(source.queue.shift()!);
  if (source.ended) return Promise.resolve(null);
  wake(source);
  return new Promise((resolve) => source.waiters.push(resolve));
}

export async function prompt(question: string): Promise<string> {
  if (!stdin.isTTY) {
    stdout.write(question);
    return ((await nextNonTtyLine()) ?? '').trim();
  }
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export function promptHidden(question: string): Promise<string> {
  stdout.write(question);
  if (!stdin.isTTY) {
    return nextNonTtyLine().then((line) => (line ?? '').trim());
  }
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise<string>((resolve) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\n' || ch === '\r') {
          stdin.setRawMode(false);
          stdin.off('data', onData);
          stdin.pause();
          stdout.write('\n');
          resolve(buf.trim());
          return;
        }
        if (ch === CTRL_C) {
          stdin.setRawMode(false);
          stdout.write('\n');
          process.exit(130);
        }
        if (ch === BACKSPACE) buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

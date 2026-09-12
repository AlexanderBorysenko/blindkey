import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const CTRL_C = '\u0003';
const BACKSPACE = '\u007f';

export async function prompt(question: string): Promise<string> {
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
    // terminal:false — readline echoes input when stdout is a TTY, which would
    // print the password for a piped stdin.
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: false });
    return rl.question('').then((answer) => {
      rl.close();
      return answer.trim();
    });
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

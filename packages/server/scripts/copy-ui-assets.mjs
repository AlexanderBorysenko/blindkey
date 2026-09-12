import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const dir of ['views', 'public']) {
  const to = join(root, 'dist/ui', dir);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(join(root, 'src/ui', dir), to, { recursive: true });
}
console.log('ui assets copied to dist/ui');

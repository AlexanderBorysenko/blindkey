export interface CommandResult {
  json: unknown;
  text: string;
}

type Cell = string | number | null | undefined;

export function table(columns: string[], rows: Cell[][]): string {
  // A columnar table can't contain embedded newlines/tabs without breaking alignment,
  // so collapse any run of whitespace in a cell to a single space.
  const cells = rows.map((row) =>
    columns.map((_, i) => (row[i] === null || row[i] === undefined ? '' : String(row[i]).replace(/\s+/g, ' '))),
  );
  const widths = columns.map((column, i) => Math.max(column.length, ...cells.map((row) => (row[i] ?? '').length)));
  const line = (row: string[]) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  return [line(columns), line(widths.map((w) => '-'.repeat(w))), ...cells.map(line)].join('\n');
}

export function fmtTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '';
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

export function emit(result: CommandResult, asJson: boolean, out: NodeJS.WritableStream = process.stdout): void {
  if (asJson) {
    out.write(`${JSON.stringify(result.json, null, 2)}\n`);
    return;
  }
  if (result.text) out.write(`${result.text}\n`);
}

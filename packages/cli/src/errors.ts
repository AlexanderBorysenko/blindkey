/** Exit codes, spec §13: 1 generic, 2 refused, 3 auth, 4 not found. */
export const EXIT_GENERIC = 1;
export const EXIT_REFUSED = 2;
export const EXIT_AUTH = 3;
export const EXIT_NOT_FOUND = 4;

export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number = EXIT_GENERIC,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

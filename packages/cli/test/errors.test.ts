import { describe, it, expect } from 'vitest';
import { CliError, EXIT_AUTH, EXIT_GENERIC, EXIT_NOT_FOUND, EXIT_REFUSED } from '../src/errors.js';

describe('CliError', () => {
  it('defaults to the generic exit code', () => {
    const err = new CliError('boom');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CliError');
    expect(err.message).toBe('boom');
    expect(err.exitCode).toBe(EXIT_GENERIC);
  });

  it('carries the exit code it was given', () => {
    expect(new CliError('nope', EXIT_REFUSED).exitCode).toBe(2);
  });

  it('uses the exit codes from the spec', () => {
    expect([EXIT_GENERIC, EXIT_REFUSED, EXIT_AUTH, EXIT_NOT_FOUND]).toEqual([1, 2, 3, 4]);
  });
});

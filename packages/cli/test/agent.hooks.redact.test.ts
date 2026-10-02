import { describe, it, expect } from 'vitest';
import { redactOutput, redactToolResponse, REDACTED } from '../src/agent/hooks/redact.js';

describe('redactOutput', () => {
  it('redacts a Blindkey token', () => {
    const token = `bk_a1B2c3D4_${'e5F6g7H8i9J0'.repeat(2)}`; // bk_<8>_ + 24 chars
    expect(redactOutput(`Authorization: Bearer ${token}`)).toBe(`Authorization: Bearer ${REDACTED}`);
  });

  it('redacts a full-format bk_<8>_<43> API token', () => {
    const token = `bk_AbCdEfGh_${'x1Y2z3'.repeat(7)}a`;
    expect(redactOutput(`token: ${token}\n`)).toBe(`token: ${REDACTED}\n`);
  });

  it('does not redact ordinary text that merely contains bk_ (backup names, identifiers)', () => {
    const text = 'db_bk_2026_10_02_full_dump.sql feedbk_handler_registration_module bk_backup_of_production_database_2026';
    expect(redactOutput(text)).toBe(text);
  });

  it('still redacts a cut-off bk_<8>_ token (at least 20 secret chars)', () => {
    const cut = `bk_AbCdEfGh_${'z'.repeat(20)}`;
    expect(redactOutput(`t=${cut}`)).toBe(`t=${REDACTED}`);
  });

  it('does not redact a bk_-prefixed string shorter than the minimum length', () => {
    const short = 'bk_short';
    expect(redactOutput(`x=${short}`)).toBe(`x=${short}`);
  });

  it('redacts a PEM private key block', () => {
    const pem = ['-----BEG' + 'IN RSA PRIVATE KEY-----', 'MIIEpQIBAAKCAQEA1234567890abcdef', 'more base64 lines here', '-----E' + 'ND RSA PRIVATE KEY-----'].join(
      '\n',
    );
    expect(redactOutput(`before\n${pem}\nafter`)).toBe(`before\n${REDACTED}\nafter`);
  });

  it('redacts a plain (non-RSA) PEM private key block', () => {
    const pem = ['-----BEG' + 'IN PRIVATE KEY-----', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEA', '-----E' + 'ND PRIVATE KEY-----'].join('\n');
    expect(redactOutput(pem)).toBe(REDACTED);
  });

  it('redacts two adjacent PEM blocks independently (non-greedy)', () => {
    const block = (label: string) => `-----BEGIN ${label} PRIVATE KEY-----\nABCDEF\n-----END ${label} PRIVATE KEY-----`;
    const text = `${block('RSA')}\n${block('EC')}`;
    expect(redactOutput(text)).toBe(`${REDACTED}\n${REDACTED}`);
  });

  it('redacts an AWS-style access key id', () => {
    expect(redactOutput('AWS_ACCESS_KEY_ID=AK' + 'IAABCDEFGHIJKLMNOP')).toBe(`AWS_ACCESS_KEY_ID=${REDACTED}`);
  });

  it.each([
    ['PASSWORD=hunter2', 'PASSWORD', `PASSWORD=${REDACTED}`],
    ['DB_PASS=hunter2', 'DB_PASS', `DB_PASS=${REDACTED}`],
    ['STRIPE_SECRET=sk_' + 'live_abc123', 'STRIPE_SECRET', `STRIPE_SECRET=${REDACTED}`],
    ['API_TOKEN=xyz', 'API_TOKEN', `API_TOKEN=${REDACTED}`],
    ['API_KEY=xyz', 'API_KEY', `API_KEY=${REDACTED}`],
    ['APIKEY=xyz', 'APIKEY', `APIKEY=${REDACTED}`],
    ['PRIVATE_TOKEN=xyz', 'PRIVATE_TOKEN', `PRIVATE_TOKEN=${REDACTED}`],
  ])('redacts a %s line by its key name', (line, _key, expected) => {
    expect(redactOutput(line)).toBe(expected);
  });

  it('redacts an `export KEY=value` line, keeping the export/key prefix', () => {
    expect(redactOutput('export DB_PASSWORD=hunter2')).toBe(`export DB_PASSWORD=${REDACTED}`);
  });

  it('leaves a non-sensitive KEY=value line untouched', () => {
    expect(redactOutput('NODE_ENV=production')).toBe('NODE_ENV=production');
  });

  it('leaves an empty-valued sensitive line untouched (nothing to redact)', () => {
    expect(redactOutput('DB_SECRET=')).toBe('DB_SECRET=');
  });

  it('leaves a spaced-around-= assignment untouched, even with a sensitive-looking key (Fix round 1 Minor #7)', () => {
    expect(redactOutput('MAX_TOKENS = 4096')).toBe('MAX_TOKENS = 4096');
    expect(redactOutput('API_KEY = "xyz"')).toBe('API_KEY = "xyz"');
  });

  it('leaves a lowercase-key assignment untouched, even with a sensitive-looking name', () => {
    expect(redactOutput('api_key = os.environ["STRIPE_KEY"]')).toBe('api_key = os.environ["STRIPE_KEY"]');
    expect(redactOutput('password=hunter2')).toBe('password=hunter2');
  });

  it('redacts a sensitive KEY=value line among several unrelated lines, multi-line safe', () => {
    const text = ['NODE_ENV=production', 'DB_HOST=localhost', 'DB_PASSWORD=hunter2', 'PORT=5432'].join('\n');
    expect(redactOutput(text)).toBe(['NODE_ENV=production', 'DB_HOST=localhost', `DB_PASSWORD=${REDACTED}`, 'PORT=5432'].join('\n'));
  });

  it('redacts multiple distinct pattern kinds in the same text', () => {
    const token = `bk_Prefix01_${'x'.repeat(43)}`;
    const text = `${token}\nAKIAABCDEFGHIJKLMNOP\nSECRET=hunter2`;
    expect(redactOutput(text)).toBe(`${REDACTED}\n${REDACTED}\nSECRET=${REDACTED}`);
  });

  it('is a no-op on text with nothing to redact', () => {
    expect(redactOutput('just some ordinary build output\nnpm test passed')).toBe('just some ordinary build output\nnpm test passed');
  });
});

describe('redactToolResponse', () => {
  it('redacts a plain string tool_response and reports changed:true', () => {
    const token = `bk_Prefix01_${'y'.repeat(43)}`;
    const result = redactToolResponse(`token is ${token}`);
    expect(result).toEqual({ changed: true, value: `token is ${REDACTED}` });
  });

  it('reports changed:false for a plain string with nothing to redact', () => {
    const result = redactToolResponse('ordinary output');
    expect(result).toEqual({ changed: false, value: 'ordinary output' });
  });

  it('redacts stdout and stderr independently in a {stdout, stderr, ...} shape', () => {
    const token = `bk_Prefix01_${'z'.repeat(43)}`;
    const result = redactToolResponse({ stdout: `out: ${token}`, stderr: 'SECRET=hunter2', interrupted: false });
    expect(result).toEqual({ changed: true, value: { stdout: `out: ${REDACTED}`, stderr: `SECRET=${REDACTED}`, interrupted: false } });
  });

  it('reports changed:false when an object has nothing to redact, and leaves non-string fields alone', () => {
    const result = redactToolResponse({ stdout: 'ok', stderr: '', interrupted: false, exitCode: 0 });
    expect(result).toEqual({ changed: false, value: { stdout: 'ok', stderr: '', interrupted: false, exitCode: 0 } });
  });

  it('passes through non-string, non-object tool_response unchanged (number, null, undefined, array)', () => {
    expect(redactToolResponse(42)).toEqual({ changed: false, value: 42 });
    expect(redactToolResponse(null)).toEqual({ changed: false, value: null });
    expect(redactToolResponse(undefined)).toEqual({ changed: false, value: undefined });
    expect(redactToolResponse(['a', 'b'])).toEqual({ changed: false, value: ['a', 'b'] });
  });
});

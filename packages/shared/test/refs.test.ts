import { describe, it, expect } from 'vitest';
import { parseSecretRefs } from '../src/index.js';

describe('parseSecretRefs', () => {
  it('parses project-local refs', () => {
    expect(parseSecretRefs('Use {{secret:Staging server}} to deploy.')).toEqual([
      { raw: '{{secret:Staging server}}', project: null, global: false, name: 'Staging server' },
    ]);
  });
  it('parses global and cross-project refs and tolerates whitespace', () => {
    const refs = parseSecretRefs('{{ secret:global/GitHub PAT }} and {{secret:critter-hero/Prod DB}}');
    expect(refs).toEqual([
      { raw: '{{ secret:global/GitHub PAT }}', project: null, global: true, name: 'GitHub PAT' },
      { raw: '{{secret:critter-hero/Prod DB}}', project: 'critter-hero', global: false, name: 'Prod DB' },
    ]);
  });
  it('deduplicates identical targets', () => {
    expect(parseSecretRefs('{{secret:A}} {{secret:A}} {{secret:global/A}}')).toHaveLength(2);
  });
  it('ignores malformed refs', () => {
    expect(parseSecretRefs('{{secret:}} {{secret:/x}} {{secret:x/}} {{secrets:A}} {{ secret }}')).toEqual([]);
  });
});

export const GUIDELINES_MD = `# Documentation guidelines

This server stores two kinds of things per project:

- **Secrets** — named, flat key/value maps (all strings). Example names: "Staging server", "Admin login", "Production DB", "GitHub PAT" (global).
- **Documents** — free-form Markdown, grouped by category.

## Categories

| category | use for |
|---|---|
| context | what the project is, who it is for, current state, priorities |
| architecture | stack, structure, key modules, data flow |
| deploy | environments, hosts, how to build/deploy/rollback |
| conventions | coding style, branching, commit rules, review process |
| client | client contacts, billing notes, communication preferences |
| notes | anything else, meeting notes, decisions |
| guidelines | this document (global) |

Recommended per-project documents: \`context\`, \`architecture\`, \`deploy\`, \`conventions\`.

## Referencing secrets

Never paste a secret value into a document. Reference it by name instead:

- \`{{secret:Staging server}}\` — secret in the same project
- \`{{secret:global/GitHub PAT}}\` — global secret
- \`{{secret:other-project/Prod DB}}\` — secret in another project

Saving a document that looks like it contains a real credential is rejected; fix the text or save with \`force\` if it is a false positive.

## How agents use secrets

Agents read documents and secret *metadata* (names, field keys, non-sensitive fields like host/username). Values are consumed through the CLI so they never enter the model context:

\`\`\`example
blindkey secret exec my-project "Staging server" -- ssh $BLINDKEY_USERNAME@$BLINDKEY_HOST
blindkey secret write my-project "Staging server" private_key --out ~/.ssh/staging_key --mode 600
blindkey secret env my-project "App env" --out .env
\`\`\`

## Writing style

- Start each document with a one-paragraph summary.
- Use headings for sections, bullet lists for facts, tables for structured data.
- Keep commands in fenced code blocks. Use \`\`\`example fences for illustrative values so the lint ignores them.
- Prefer updating an existing document over creating a new one.
`;

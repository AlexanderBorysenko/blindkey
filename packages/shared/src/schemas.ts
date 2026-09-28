import { z } from 'zod';

export const SCOPES = [
  'projects:read',
  'projects:write',
  'projects:create',
  'docs:read',
  'docs:write',
  'secrets:meta',
  'secrets:meta-write',
  'secrets:reveal',
  'secrets:use',
  'secrets:write',
  'admin',
] as const;
export type Scope = (typeof SCOPES)[number];

/**
 * The scopes an agent token (Claude Code plugin, spec §1.1) may ever carry. An agent token can
 * never hold `admin`, `secrets:reveal` or `secrets:write` — enforced server-side where agent
 * tokens are minted (the device-connect flow, spec §1.3), not by this list alone.
 */
export const AGENT_SCOPES = [
  'projects:read',
  'projects:write',
  'projects:create',
  'docs:read',
  'docs:write',
  'secrets:meta',
  'secrets:meta-write',
  'secrets:use',
] as const satisfies readonly Scope[];

export const PROJECT_STATUSES = ['active', 'paused', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const DOC_CATEGORIES = [
  'context',
  'architecture',
  'deploy',
  'conventions',
  'client',
  'notes',
  'guidelines',
] as const;
export type DocCategory = (typeof DOC_CATEGORIES)[number];

export const NON_SENSITIVE_KEYS = ['host', 'port', 'url', 'username', 'database', 'public_key'] as const;

export function defaultSensitive(key: string): boolean {
  return !(NON_SENSITIVE_KEYS as readonly string[]).includes(key);
}

/**
 * Whether a field key looks like it holds a credential. An agent (meta-write) may declare a field
 * non-sensitive only when this is false — otherwise it could create a visible `password` field and
 * have the user type a real password into it. The key is split into words (`db_password`,
 * `apiToken`, `SSH-Key` → db/password, api/token, ssh/key); a word matches exactly (`auth` but not
 * `author`, `pin` but not `ping`), and a few stems match anywhere (`passphrase`, `apitoken`).
 * This is a guard against the obvious, not a proof: the admin UI shows every field's sensitivity.
 */
const CREDENTIAL_WORDS = new Set([
  'pass', 'passwd', 'password', 'passphrase', 'pw', 'pwd', 'pin', 'otp', 'totp', 'mfa', '2fa',
  'secret', 'token', 'jwt', 'bearer', 'auth', 'authorization', 'credential', 'credentials', 'cred', 'creds',
  'key', 'apikey', 'privkey', 'private', 'priv', 'salt', 'nonce', 'hmac', 'signature', 'sig', 'cert', 'pem', 'pfx', 'p12',
  'cookie', 'session', 'sid', 'dsn', 'conn', 'connection', 'connstr', 'seed', 'mnemonic', 'recovery', 'backup_codes',
  'cvv', 'cvc', 'iban', 'card', 'ssn', 'license', 'licence',
]);
const CREDENTIAL_STEMS = /pass(?:word|wd|phrase)|secret|token|credential|private|apikey|mnemonic/i;

export function secretLookingKey(key: string): boolean {
  if ((NON_SENSITIVE_KEYS as readonly string[]).includes(key)) return false;
  if (CREDENTIAL_STEMS.test(key)) return true;
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.some((w) => CREDENTIAL_WORDS.has(w));
}

/** A URL carrying a password in its userinfo (`scheme://user:pass@host`) — never a non-sensitive value. */
export function urlWithPassword(value: string): boolean {
  return /[a-z][a-z0-9+.-]*:\/\/[^\s/@:]*:[^\s/@]+@/i.test(value);
}

export const scopeSchema = z.enum(SCOPES);

/** A single scope an agent token may hold (spec §1.1/§1.3): always a subset of `AGENT_SCOPES`. */
export const agentScopeSchema = z.enum(AGENT_SCOPES);

/** Non-empty set of agent scopes, reused by the device-connect start body and the approve step. */
export const agentScopesSchema = z.array(agentScopeSchema).min(1);

export const slugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, 'slug must be lowercase letters, digits and dashes');

export const tagsSchema = z.array(z.string().min(1).max(50)).max(50);

export const projectInputSchema = z.strictObject({
  slug: slugSchema,
  name: z.string().min(1).max(200),
  status: z.enum(PROJECT_STATUSES).default('active'),
  tags: tagsSchema.default([]),
  summary: z.string().max(5000).default(''),
});
export type ProjectInput = z.infer<typeof projectInputSchema>;

export const projectPatchSchema = z.strictObject({
  slug: slugSchema.optional(),
  name: z.string().min(1).max(200).optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  tags: tagsSchema.optional(),
  summary: z.string().max(5000).optional(),
});
export type ProjectPatch = z.infer<typeof projectPatchSchema>;

export const secretNameSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((n) => !n.includes('/'), 'secret name must not contain "/"');

export const secretKeySchema = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, 'key must match [A-Za-z0-9_.-]{1,64}');

export const secretFieldInputSchema = z.strictObject({
  key: secretKeySchema,
  value: z.string().max(1_000_000),
  sensitive: z.boolean().optional(),
});
export type SecretFieldInput = z.infer<typeof secretFieldInputSchema>;

const uniqueKeys = (fields: { key: string }[]) => new Set(fields.map((f) => f.key)).size === fields.length;

export const secretInputSchema = z.strictObject({
  name: secretNameSchema,
  description: z.string().max(5000).default(''),
  tags: tagsSchema.default([]),
  fields: z.array(secretFieldInputSchema).min(1).max(200).refine(uniqueKeys, 'duplicate field keys'),
});
export type SecretInput = z.infer<typeof secretInputSchema>;

export const secretPatchSchema = z.strictObject({
  name: secretNameSchema.optional(),
  description: z.string().max(5000).optional(),
  tags: tagsSchema.optional(),
  fields: z.array(secretFieldInputSchema).max(200).refine(uniqueKeys, 'duplicate field keys').optional(),
  removeFields: z.array(secretKeySchema).optional(),
  /** Field keys in display order; unknown keys are ignored, unlisted fields keep their relative order after these. */
  order: z.array(secretKeySchema).max(200).optional(),
});
export type SecretPatch = z.infer<typeof secretPatchSchema>;

/** Body for `POST .../secrets/:name/use` (spec §1.2): substitution-only access, never returns via reveal endpoints. */
export const secretUseSchema = z.strictObject({
  purpose: z.enum(['exec', 'write', 'env']),
  fields: z.array(secretKeySchema).max(200).optional(),
});
export type SecretUseInput = z.infer<typeof secretUseSchema>;

export const docSlugSchema = slugSchema;

export const documentInputSchema = z.strictObject({
  title: z.string().min(1).max(300),
  category: z.enum(DOC_CATEGORIES),
  body_md: z.string().max(2_000_000),
  force: z.boolean().default(false),
});
export type DocumentInput = z.infer<typeof documentInputSchema>;

export const tokenInputSchema = z.strictObject({
  name: z.string().min(1).max(100),
  scopes: z.array(scopeSchema).min(1),
  projects: z.array(slugSchema).nullable().default(null),
  // Omitted → the server applies its default lifetime; an explicit null means "never expires".
  expires_at: z.number().int().positive().nullable().optional(),
});
export type TokenInput = z.infer<typeof tokenInputSchema>;

export const authTokenRequestSchema = z.strictObject({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(1000),
  name: z.string().min(1).max(100).default('cli'),
  expires_days: z.number().int().min(1).max(365).default(30),
  totp: z.string().min(1).max(32).optional(),
});
export type AuthTokenRequest = z.infer<typeof authTokenRequestSchema>;

/** Body for `POST /api/v1/connect/start` (spec §1.3): begins the browser device flow. */
export const connectStartSchema = z.strictObject({
  name: z.string().min(1).max(100),
  scopes: agentScopesSchema,
  projects: z.array(slugSchema).max(200).default([]),
  expires_days: z.number().int().min(1).max(365).default(90),
});
export type ConnectStartInput = z.infer<typeof connectStartSchema>;

/** Body for `POST /api/v1/connect/poll` (spec §1.3). */
export const connectPollSchema = z.strictObject({
  device_code: z.string().min(1).max(500),
});
export type ConnectPollInput = z.infer<typeof connectPollSchema>;

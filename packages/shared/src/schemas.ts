import { z } from 'zod';

export const SCOPES = [
  'projects:read',
  'docs:read',
  'docs:write',
  'secrets:meta',
  'secrets:reveal',
  'secrets:write',
  'admin',
] as const;
export type Scope = (typeof SCOPES)[number];

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

export const scopeSchema = z.enum(SCOPES);

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

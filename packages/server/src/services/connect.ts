import { createHash, randomBytes, randomInt } from 'node:crypto';
import { z } from 'zod';
import { AGENT_SCOPES, agentScopesSchema, type ConnectStartInput, type Scope } from '@pidb/shared';
import type { AppContext } from '../http/context.js';
import type { Actor } from '../auth/principal.js';
import { AppError, NotFoundError, ValidationError } from '../errors.js';
import { auditAs } from './common.js';
import { writeAudit } from '../repos/audit.js';
import { isUniqueViolation } from '../repos/util.js';
import { getProjectBySlug, listProjects, type ProjectRow } from '../repos/projects.js';
import { createToken, revokeAgentTokensByName, DAY_MS } from '../repos/tokens.js';
import {
  approveConnectRequest,
  claimApprovedConnectRequest,
  createConnectRequest,
  deleteConnectRequest,
  denyConnectRequest,
  getConnectRequestByDeviceHash,
  getConnectRequestByUserCode,
  purgeExpiredConnectRequests,
  type ConnectRequestRow,
} from '../repos/connect.js';

/** Excludes visually ambiguous letters (spec §1.3): no A, E, I, O, U, Y, and no 0/1. */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const DEVICE_CODE_TTL_MS = 10 * 60_000; // expires_in: 600
const POLL_INTERVAL_S = 3;
const MAX_CODE_ATTEMPTS = 5;

/** The approve form's `expires_days` field: coerced from the submitted string, same bounds as the start body. */
const expiresDaysSchema = z.coerce.number().int().min(1).max(365);

function randomUserCodePart(len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return s;
}

function generateUserCode(): string {
  return `${randomUserCodePart(4)}-${randomUserCodePart(4)}`;
}

function generateDeviceCode(): string {
  return randomBytes(32).toString('base64url');
}

export function hashDeviceCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

function normalizeUserCode(code: string): string {
  return code.trim().toUpperCase();
}

export interface StartConnectResult {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

/** `POST /api/v1/connect/start` (spec §1.3): begins the device flow, public + rate limited. */
export function startConnect(
  ctx: AppContext,
  input: ConnectStartInput,
  ip: string,
  userAgent: string,
  origin: string,
): StartConnectResult {
  purgeExpiredConnectRequests(ctx.db);
  let deviceCode = '';
  let row: ConnectRequestRow | null = null;
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS && !row; attempt++) {
    deviceCode = generateDeviceCode();
    const userCode = generateUserCode();
    try {
      row = createConnectRequest(ctx.db, {
        deviceHash: hashDeviceCode(deviceCode),
        userCode,
        name: input.name,
        scopes: input.scopes,
        projects: input.projects,
        expiresDays: input.expires_days,
        ip,
        userAgent,
        ttlMs: DEVICE_CODE_TTL_MS,
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  if (!row) throw new AppError(500, 'internal', 'could not allocate a connect code');
  writeAudit(ctx.db, {
    actor_type: 'token',
    actor_id: null,
    action: 'connect.started',
    target_type: 'connect_request',
    target_id: row.id,
    ip,
    user_agent: userAgent,
    meta: { name: row.name, user_code: row.user_code, scopes: row.scopes, projects: row.projects },
  });
  return {
    device_code: deviceCode,
    user_code: row.user_code,
    verification_url: `${origin}/connect?code=${encodeURIComponent(row.user_code)}`,
    expires_in: Math.floor(DEVICE_CODE_TTL_MS / 1000),
    interval: POLL_INTERVAL_S,
  };
}

export interface PollConnectResult {
  token: string;
  id: number;
  name: string;
  scopes: Scope[];
  projects: string[];
  expires_at: number;
}

function issueAgentToken(ctx: AppContext, requestId: number, ip: string, userAgent: string): PollConnectResult {
  return ctx.db.transaction(() => {
    const claimed = claimApprovedConnectRequest(ctx.db, requestId);
    // Lost the race to another (or replayed) claim on the same row (Review Focus 3): the row is
    // gone or was no longer `approved` by the time this transaction ran.
    if (!claimed) throw new AppError(400, 'invalid_request', 'this request was already used');
    revokeAgentTokensByName(ctx.db, claimed.name);
    const expiresAt = Date.now() + (claimed.approved_expires_days ?? claimed.expires_days) * DAY_MS;
    const { token, row: tokenRow } = createToken(ctx.db, {
      name: claimed.name,
      scopes: claimed.approved_scopes ?? [],
      projectIds: claimed.approved_project_ids ?? [],
      expiresAt,
      kind: 'agent',
    });
    writeAudit(ctx.db, {
      actor_type: 'token',
      actor_id: tokenRow.id,
      action: 'connect.token_issued',
      target_type: 'token',
      target_id: tokenRow.id,
      ip,
      user_agent: userAgent,
      meta: { name: tokenRow.name },
    });
    const slugs = listProjects(ctx.db, tokenRow.project_ids ?? []).map((p) => p.slug);
    return {
      token,
      id: tokenRow.id,
      name: tokenRow.name,
      scopes: tokenRow.scopes,
      projects: slugs,
      expires_at: tokenRow.expires_at as number,
    };
  })();
}

/** `POST /api/v1/connect/poll` (spec §1.3): public + rate limited. */
export function pollConnect(ctx: AppContext, deviceCode: string, ip: string, userAgent: string): PollConnectResult {
  const row = getConnectRequestByDeviceHash(ctx.db, hashDeviceCode(deviceCode));
  if (!row) {
    purgeExpiredConnectRequests(ctx.db);
    throw new AppError(400, 'invalid_request', 'unknown device code');
  }
  const nowTs = Date.now();
  if (row.expires_at <= nowTs) {
    deleteConnectRequest(ctx.db, row.id);
    throw new AppError(410, 'expired', 'device code expired');
  }
  if (row.status === 'denied') {
    deleteConnectRequest(ctx.db, row.id);
    throw new AppError(403, 'access_denied', 'the request was denied');
  }
  if (row.status === 'pending') {
    throw new AppError(428, 'authorization_pending', 'not yet approved');
  }
  purgeExpiredConnectRequests(ctx.db, nowTs);
  return issueAgentToken(ctx, row.id, ip, userAgent);
}

function mustPendingConnectRequest(ctx: AppContext, code: string): ConnectRequestRow {
  const row = getConnectRequestByUserCode(ctx.db, normalizeUserCode(code));
  if (!row || row.status !== 'pending' || row.expires_at <= Date.now()) {
    throw new NotFoundError('connect request not found or already decided');
  }
  return row;
}

export type ConnectView =
  | { state: 'error'; message: string }
  | { state: 'form'; row: ConnectRequestRow; allScopes: readonly Scope[]; allProjects: ProjectRow[] };

/** Backs `GET /connect?code=` (spec §1.3): unknown/expired/already-decided codes render as an error state. */
export function viewConnectRequest(ctx: AppContext, code: string): ConnectView {
  const row = getConnectRequestByUserCode(ctx.db, normalizeUserCode(code));
  if (!row || row.status !== 'pending' || row.expires_at <= Date.now()) {
    return { state: 'error', message: 'This code is invalid, expired, or already used.' };
  }
  return { state: 'form', row, allScopes: AGENT_SCOPES, allProjects: listProjects(ctx.db, null) };
}

/**
 * `POST /connect/approve`: requires >=1 valid scope and >=1 known project, and a 1-365 day expiry
 * (editable by the approver — prefilled with the request's own `expires_days`, but the approver
 * may shorten or lengthen it before granting). Scopes are validated against `AGENT_SCOPES` here
 * regardless of what was originally requested (Review: a tampered form cannot add
 * `admin`/`secrets:reveal`/`secrets:write` — those are not valid members of `agentScopesSchema`
 * and fail parsing outright, so the request is rejected, not silently filtered). Submitted scopes
 * and projects are de-duplicated (a repeated checkbox value, tampered or not, is stored once).
 */
export function approveConnect(
  ctx: AppContext,
  actor: Actor,
  code: string,
  scopeInputs: string[],
  projectSlugInputs: string[],
  expiresDaysInput: string,
): void {
  const row = mustPendingConnectRequest(ctx, code);
  const parsedScopes = agentScopesSchema.safeParse(scopeInputs);
  if (!parsedScopes.success) throw new ValidationError(parsedScopes.error.issues);
  const scopes = Array.from(new Set(parsedScopes.data));
  const seenProjectIds = new Set<number>();
  const projectIds: number[] = [];
  const matchedSlugs: string[] = [];
  for (const slug of projectSlugInputs) {
    const p = getProjectBySlug(ctx.db, slug);
    if (p && !seenProjectIds.has(p.id)) {
      seenProjectIds.add(p.id);
      projectIds.push(p.id);
      matchedSlugs.push(slug);
    }
  }
  if (projectIds.length === 0) throw new ValidationError([{ path: ['projects'], message: 'at least one project is required' }]);
  const parsedExpiresDays = expiresDaysSchema.safeParse(expiresDaysInput);
  if (!parsedExpiresDays.success) throw new ValidationError(parsedExpiresDays.error.issues);
  const ok = approveConnectRequest(ctx.db, row.id, { scopes, projectIds, expiresDays: parsedExpiresDays.data });
  if (!ok) throw new NotFoundError('connect request not found or already decided');
  auditAs(ctx, actor, {
    action: 'connect.approved',
    target_type: 'connect_request',
    target_id: row.id,
    meta: { name: row.name, scopes, projects: matchedSlugs, expires_days: parsedExpiresDays.data },
  });
}

export function denyConnect(ctx: AppContext, actor: Actor, code: string): void {
  const row = mustPendingConnectRequest(ctx, code);
  const ok = denyConnectRequest(ctx.db, row.id);
  if (!ok) throw new NotFoundError('connect request not found or already decided');
  auditAs(ctx, actor, { action: 'connect.denied', target_type: 'connect_request', target_id: row.id, meta: { name: row.name } });
}

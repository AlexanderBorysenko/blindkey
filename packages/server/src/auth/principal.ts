import type { Scope } from '@blindkey/shared';
import { ForbiddenError } from '../errors.js';

export interface Principal {
  kind: 'admin' | 'token';
  /** Session: the user id. Token: the token id. */
  id: number;
  /** The user the request acts as (token owner / session user). */
  userId: number;
  isSuper: boolean;
  /** Set when a super user is acting as `userId` through an impersonation session. */
  impersonatorId: number | null;
  scopes: Scope[];
  projectIds: number[] | null;
  /** Browser sessions only: the workspace slug the UI has selected (cookie); API callers always name theirs. */
  workspaceHint?: string | null;
  /** True for an agent-kind API token (Claude Code plugin, spec §1.1); always false for an admin session. */
  agent: boolean;
}

export interface Actor {
  principal: Principal;
  ip: string;
  userAgent: string;
}

export function hasScope(p: Principal, scope: Scope): boolean {
  return p.scopes.includes('admin') || p.scopes.includes(scope);
}

export function assertScope(p: Principal, scope: Scope): void {
  if (!hasScope(p, scope)) throw new ForbiddenError(scope);
}

export function canAccessProject(p: Principal, projectId: number): boolean {
  return p.projectIds === null || p.projectIds.includes(projectId);
}

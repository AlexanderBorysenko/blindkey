export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message ?? code);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'not found') {
    super(404, 'not_found', message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'unauthorized') {
    super(401, 'unauthorized', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(scope: string) {
    super(403, 'missing_scope', `missing scope ${scope}`, { scope });
  }
}

export class ValidationError extends AppError {
  constructor(issues: unknown) {
    super(400, 'validation', 'validation failed', { issues });
  }
}

export class ConflictError extends AppError {
  constructor(message = 'conflict') {
    super(409, 'conflict', message);
  }
}

export class UnprocessableError extends AppError {
  constructor(code: string, details: Record<string, unknown>, message?: string) {
    super(422, code, message ?? code, details);
  }
}

export class CryptoError extends AppError {
  constructor(message = 'decrypt failed') {
    super(500, 'decrypt_failed', message);
  }
}

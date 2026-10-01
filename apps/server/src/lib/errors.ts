/** Errors that map to a specific HTTP status. Business-rule errors use DomainError from @lounge/core (→ 409). */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message?: string, details?: Record<string, unknown>) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`, { what });
export const unauthorized = (msg = 'Login required') => new HttpError(401, 'unauthorized', msg);
export const forbidden = (msg = 'Not allowed for your role') => new HttpError(403, 'forbidden', msg);

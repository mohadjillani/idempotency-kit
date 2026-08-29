import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { RequestAbortedError } from './errors.js';
import { fingerprint as hashFingerprint } from './fingerprint.js';
import { createIdempotency, type IdempotencyOptions, type Outcome } from './idempotency.js';

/** What the binding stores for a completed request and replays on a repeat. */
export interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** `utf8` for text bodies; `base64` when the bytes were not valid UTF-8. */
  encoding: 'utf8' | 'base64';
}

export type ProblemCode =
  | 'idempotency_key_missing'
  | 'idempotency_key_invalid'
  | 'idempotency_key_in_flight'
  | 'idempotency_key_reused'
  | 'idempotency_store_unavailable';

export interface IdempotencyProblem {
  status: 400 | 409 | 422 | 503;
  code: ProblemCode;
  message: string;
  /** Present for 409: seconds until the in-flight lock expires. */
  retryAfterSeconds?: number;
}

export interface ExpressIdempotencyOptions extends IdempotencyOptions<CapturedResponse> {
  /** Request header carrying the key. Default `Idempotency-Key`. */
  header?: string;
  /** Reject requests without a key (400) instead of letting them through unprotected. Default false. */
  required?: boolean;
  /** Methods the middleware applies to. Default `['POST', 'PATCH']`. */
  methods?: readonly string[];
  /** Accept or reject a raw key. Default: 1–255 printable ASCII characters, no spaces. */
  validateKey?: (key: string) => boolean;
  /**
   * Namespace for the key, typically the authenticated caller. Without it a
   * key is global, so one tenant could observe another's replay. Returning
   * `undefined` leaves the key unscoped.
   */
  scope?: (req: Request) => string | undefined;
  /** Identify "the same request". Default: SHA-256 of method, URL and parsed body. */
  fingerprint?: (req: Request) => string;
  /** Which captured headers to send again on replay. Default drops hop-by-hop headers and `Set-Cookie`. */
  replayHeaders?: (name: string) => boolean;
  /** Write a problem response. Default: JSON body `{ error, message }` plus `Retry-After` when present. */
  render?: (problem: IdempotencyProblem, req: Request, res: Response) => void;
}

const DEFAULT_METHODS = ['POST', 'PATCH'];
const KEY_PATTERN = /^[\x21-\x7E]{1,255}$/;
const NEVER_REPLAYED = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'date',
  'set-cookie',
]);

export const defaultValidateKey = (key: string): boolean => KEY_PATTERN.test(key);

/** Method, full URL (with query) and the parsed body. Mount a body parser first. */
export const defaultFingerprint = (req: Request): string =>
  hashFingerprint({ method: req.method, url: req.originalUrl, body: req.body as unknown });

export const defaultReplayHeaders = (name: string): boolean =>
  !NEVER_REPLAYED.has(name.toLowerCase());

export const defaultRender = (problem: IdempotencyProblem, _req: Request, res: Response): void => {
  if (problem.retryAfterSeconds !== undefined) {
    res.setHeader('Retry-After', String(problem.retryAfterSeconds));
  }
  res.status(problem.status).json({ error: problem.code, message: problem.message });
};

/** Express 5 middleware. Mount after the body parser, before the handlers it protects. */
export function idempotency(options: ExpressIdempotencyOptions): RequestHandler {
  const {
    header = 'Idempotency-Key',
    required = false,
    methods = DEFAULT_METHODS,
    validateKey = defaultValidateKey,
    scope,
    fingerprint = defaultFingerprint,
    replayHeaders = defaultReplayHeaders,
    render = defaultRender,
    ...core
  } = options;
  const applies = new Set(methods.map((m) => m.toUpperCase()));
  const idem = createIdempotency<CapturedResponse>({
    ...core,
    shouldStore: core.shouldStore ?? ((response) => response.status < 500),
  });

  const problem = (p: IdempotencyProblem, req: Request, res: Response) => {
    render(p, req, res);
  };

  return function idempotencyMiddleware(req, res, next) {
    if (!applies.has(req.method)) {
      next();
      return;
    }
    const raw = req.get(header);
    if (raw === undefined) {
      if (required) {
        problem(
          {
            status: 400,
            code: 'idempotency_key_missing',
            message: `The ${header} header is required for this request.`,
          },
          req,
          res,
        );
        return;
      }
      next();
      return;
    }
    if (!validateKey(raw)) {
      problem(
        {
          status: 400,
          code: 'idempotency_key_invalid',
          message: `The ${header} header must be 1–255 printable ASCII characters.`,
        },
        req,
        res,
      );
      return;
    }

    const ns = scope?.(req);
    const key = ns === undefined ? raw : `${ns}:${raw}`;

    idem
      .handle(key, fingerprint(req), () => capture(res, next))
      .then(
        (outcome) => {
          respond(outcome, req, res);
        },
        (error: unknown) => {
          // The handler's own errors were already turned into a response by
          // Express; what reaches here is a closed connection or a broken store.
          if (error instanceof RequestAbortedError || res.headersSent) return;
          next(error);
        },
      );
  };

  function respond(outcome: Outcome<CapturedResponse>, req: Request, res: Response): void {
    switch (outcome.outcome) {
      case 'executed':
        return;
      case 'replayed':
        replay(outcome.response, res, replayHeaders);
        return;
      case 'in-flight':
        problem(
          {
            status: 409,
            code: 'idempotency_key_in_flight',
            message: 'A request with this idempotency key is still being processed.',
            retryAfterSeconds: Math.max(1, Math.ceil(outcome.retryAfterMs / 1000)),
          },
          req,
          res,
        );
        return;
      case 'mismatch':
        problem(
          {
            status: 422,
            code: 'idempotency_key_reused',
            message: 'This idempotency key was already used for a different request.',
          },
          req,
          res,
        );
        return;
      case 'store-unavailable':
        problem(
          {
            status: 503,
            code: 'idempotency_store_unavailable',
            message: 'The idempotency store is unavailable; the request was not processed.',
          },
          req,
          res,
        );
        return;
    }
  }
}

/**
 * Run the rest of the chain and resolve with what it sent. Every byte passes
 * through `write`/`end`, so `res.json`, `res.send`, streams and manual writes
 * are all captured. Rejects if the socket closes before the response ends.
 */
function capture(res: Response, next: NextFunction): Promise<CapturedResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const push = (chunk: unknown, encoding: unknown) => {
      if (typeof chunk === 'string') {
        chunks.push(
          Buffer.from(chunk, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8'),
        );
      } else if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk));
      }
    };
    const write = res.write.bind(res) as (...args: unknown[]) => boolean;
    const end = res.end.bind(res) as (...args: unknown[]) => Response;

    res.write = ((chunk: unknown, ...rest: unknown[]) => {
      push(chunk, rest[0]);
      return write(chunk, ...rest);
    }) as typeof res.write;

    res.end = ((chunk?: unknown, ...rest: unknown[]) => {
      if (typeof chunk !== 'function') push(chunk, rest[0]);
      const result = end(chunk, ...rest);
      resolve(snapshot(res, Buffer.concat(chunks)));
      return result;
    }) as typeof res.end;

    res.once('close', () => {
      if (!res.writableFinished) reject(new RequestAbortedError());
    });

    next();
  });
}

function snapshot(res: Response, body: Buffer): CapturedResponse {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(res.getHeaders())) {
    if (value === undefined) continue;
    headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  const text = body.toString('utf8');
  const isText = Buffer.from(text, 'utf8').equals(body);
  return {
    status: res.statusCode,
    headers,
    body: isText ? text : body.toString('base64'),
    encoding: isText ? 'utf8' : 'base64',
  };
}

function replay(
  captured: CapturedResponse,
  res: Response,
  replayHeaders: (name: string) => boolean,
): void {
  res.status(captured.status);
  for (const [name, value] of Object.entries(captured.headers)) {
    if (replayHeaders(name)) res.setHeader(name, value);
  }
  res.setHeader('Idempotent-Replayed', 'true');
  res.end(Buffer.from(captured.body, captured.encoding));
}

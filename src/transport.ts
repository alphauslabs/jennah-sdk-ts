/**
 * The interceptors every call passes through: transport retry outside,
 * credential inside.
 *
 * Retry wraps the credential interceptor, not the other way round, so a replay
 * after a transport failure asks the source for the credential again instead of
 * reusing the one the failed attempt carried.
 *
 * @module
 */

import { Code, ConnectError, createContextKey, type Interceptor } from "@connectrpc/connect";

import type { CredentialSource } from "./credentials.js";
import { JennahError } from "./errors.js";
import { RETRYABLE_CODES, safeToReplay } from "./retry.js";

/**
 * Marks the one call the credential interceptor must keep its hands off: the
 * renewal it is itself performing. It carries no bearer, because the refresh
 * method is on the platform's unauthenticated allowlist and the refresh token
 * in the body is the credential; and it must not renew, because that would
 * re-enter the source it is already inside (a deadlock on the first attempt,
 * unbounded recursion if the refresh token is what was rejected).
 */
export const renewing = createContextKey(false, { description: "jennah renewing" });

/**
 * Automatic retries after a transient failure.
 *
 * The default retries a call up to three times in total, 100ms apart doubling
 * to 2s with jitter, only when the failure is UNAVAILABLE, and only when
 * replaying the call cannot produce a second effect (see `retry.ts`). A call's
 * `timeoutMs` or `signal` bounds all of its attempts together, not each one.
 */
export interface RetryPolicy {
  disabled?: boolean;
  /** Counts the first try; 1 means no retry. */
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

const DEFAULT_RETRY: Required<RetryPolicy> = {
  disabled: false,
  maxAttempts: 3,
  baseBackoffMs: 100,
  maxBackoffMs: 2000,
};

function isUnauthenticatedRejection(e: unknown): e is ConnectError {
  return e instanceof ConnectError && e.code === Code.Unauthenticated;
}

// Keep the platform's UNAUTHENTICATED reachable (errors.code follows causes)
// when the source raised without a cause of its own.
function chainRejection(err: unknown, rejection: ConnectError): unknown {
  if (err instanceof JennahError && err.cause === undefined) {
    Object.defineProperty(err, "cause", { value: rejection, writable: true, configurable: true });
  }
  return err;
}

/**
 * Attaches the credential to every call, asking the source each time, and on
 * an UNAUTHENTICATED answer renews once and reissues the call exactly once.
 *
 * The reissue asks for none of the evidence a transport retry demands: a call
 * refused before it reached the operation had no effect, so even a write that
 * is never otherwise replayed is safe to send again.
 */
export function bearerInterceptor(source: CredentialSource): Interceptor {
  return (next) => async (req) => {
    if (req.contextValues.get(renewing)) {
      req.header.delete("authorization");
      return next(req);
    }
    const cred = source.token();
    req.header.set("authorization", `Bearer ${cred}`);
    // A streamed request body cannot be sent twice. The platform refuses every
    // tenant-facing stream anyway, so there is nothing to renew for.
    if (req.stream) return next(req);
    try {
      return await next(req);
    } catch (e) {
      if (!isUnauthenticatedRejection(e)) throw e;
      let renewed: string;
      try {
        renewed = await source.renew(cred);
      } catch (err) {
        throw chainRejection(err, e);
      }
      req.header.set("authorization", `Bearer ${renewed}`);
      // Exactly once: a second rejection is the platform's answer.
      return next(req);
    }
  };
}

// Resolves true after ms, or false as soon as the call's signal aborts.
function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function retryInterceptor(policy: RetryPolicy = {}): Interceptor {
  const p = { ...DEFAULT_RETRY, ...policy };
  return (next) => async (req) => {
    if (req.stream || p.maxAttempts < 2 || !safeToReplay(`/${req.service.typeName}/${req.method.name}`, req.message)) {
      return next(req);
    }
    let ceiling = p.baseBackoffMs;
    for (let attempt = 1; ; attempt++) {
      try {
        return await next(req);
      } catch (e) {
        if (attempt >= p.maxAttempts || !(e instanceof ConnectError) || !RETRYABLE_CODES.has(e.code)) throw e;
        const ms = Math.random() * ceiling;
        ceiling = Math.min(ceiling * 2, p.maxBackoffMs);
        // The caller's budget ran out during the pause: its last answer stands.
        if (!(await pause(ms, req.signal))) throw e;
      }
    }
  };
}

/** The interceptors a client installs, outermost first. */
export function credentialedInterceptors(source: CredentialSource, retry?: RetryPolicy): Interceptor[] {
  const chain: Interceptor[] = [];
  if (!retry?.disabled) chain.push(retryInterceptor(retry));
  chain.push(bearerInterceptor(source));
  return chain;
}

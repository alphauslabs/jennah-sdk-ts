/**
 * Errors the SDK raises itself, and how to read a platform status out of any
 * error.
 *
 * Calls through the SDK reject with a `ConnectError` for the platform's
 * answers. The classes here are for the conditions the SDK decides on its own:
 * no credential, an unreadable session file, a session that cannot be renewed,
 * a refused key. When one of them is raised because of a platform rejection,
 * the rejection is kept as its `cause`, so {@link code} still reports
 * `Unauthenticated` for it and a caller branching on the status keeps working.
 *
 * @module
 */

import { Code, ConnectError } from "@connectrpc/connect";

export const ENV_API_KEY = "JENNAH_API_KEY";

/** Base class for errors raised by the SDK itself. */
export class JennahError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * No source yielded a credential.
 *
 * Raised when the client is constructed, not on its first call, and names
 * every way to supply one, because a caller seeing it has not chosen between
 * them.
 */
export class NoCredentialError extends JennahError {
  constructor(detail = "") {
    const msg = `jennah: no credential found (set one explicitly, set $${ENV_API_KEY}, or run: jnh login)`;
    super(detail ? `${msg}: ${detail}` : msg);
  }
}

/**
 * The stored session exists but cannot be interpreted.
 *
 * Distinct from having no session: the machine is logged in and something ate
 * the file, so it is reported with its path rather than treated as logged out.
 */
export class CorruptSessionError extends JennahError {
  readonly path: string;

  constructor(path: string, reason: unknown) {
    super(`jennah: stored session at ${path} is unreadable: ${reasonText(reason)}`);
    this.path = path;
  }
}

/** The session can no longer authenticate and could not be renewed. */
export class SessionExpiredError extends JennahError {
  constructor(detail = "", options?: { cause?: unknown }) {
    const msg = "jennah: the stored session has expired (run: jnh login)";
    super(detail ? `${msg}: ${detail}` : msg, options);
  }
}

/**
 * A non-renewable credential (an API key) was rejected.
 *
 * A key does not expire, so this is the key itself being refused: revoked,
 * expired at the server, or wrong. It is never a reason to attempt a renewal.
 */
export class CredentialRefusedError extends JennahError {
  constructor(options?: { cause?: unknown }) {
    super(`jennah: the API key was refused (check the configured key or $${ENV_API_KEY})`, options);
  }
}

/**
 * A renewed session could not be written back to the shared location.
 *
 * Raised rather than ignored: the renewal spent the previous refresh token, so
 * a session held only in memory is lost when the process exits and leaves
 * every other client on the machine holding a token nothing accepts.
 */
export class SessionPersistError extends JennahError {}

function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Return the platform status carried by `err`, or undefined if it carries
 * none.
 *
 * Follows the error's cause chain, so an SDK error raised because of a
 * platform rejection reports that rejection's status.
 */
export function code(err: unknown): Code | undefined {
  const seen = new Set<unknown>();
  while (err != null && !seen.has(err)) {
    seen.add(err);
    if (err instanceof ConnectError) {
      return err.code;
    }
    err = (err as { cause?: unknown }).cause;
  }
  return undefined;
}

export function isUnauthenticated(err: unknown): boolean {
  return code(err) === Code.Unauthenticated;
}

/** Whether `err` is the transient status the SDK's own retry acts on. */
export function isTransient(err: unknown): boolean {
  return code(err) === Code.Unavailable;
}

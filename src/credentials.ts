/**
 * Credential resolution, and the stored session that clients on one machine
 * share.
 *
 * This module implements the platform's `client-credentials` contract, the
 * same one `jnh` implements, and is held to it by the shared conformance suite.
 * Three parts of that contract are easy to get quietly wrong, so they are worth
 * stating where the code is:
 *
 * - Renewal always rotates. The refresh token that renewed is dead the moment
 *   the platform answers, so writing the renewed session back is correctness,
 *   not an optimization: a client that kept it in memory would strand every
 *   other client on the machine, `jnh` included, on a token nothing accepts.
 * - The renewal call must not pass through the client's own credential
 *   interceptor, or it would ask this module for a token while holding the lock
 *   it took to renew.
 * - A call rejected as unauthenticated never reached the operation, so
 *   reissuing it once after a renewal is safe even for a write that is
 *   otherwise never replayed.
 *
 * @module
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import {
  CorruptSessionError,
  CredentialRefusedError,
  ENV_API_KEY,
  NoCredentialError,
  SessionExpiredError,
  SessionPersistError,
} from "./errors.js";

// The reserved prefix the platform's API keys carry. The server branches on it
// to decide which credential it was handed, so it is also how a client can tell
// what it resolved without asking anyone.
const API_KEY_PREFIX = "jennah_sk_";

/** What sort of credential was resolved. */
export const Kind = {
  /** An opaque service credential. It does not expire and cannot be renewed. */
  ApiKey: "api key",
  /** A signed-in user's access token, ordinarily backed by a refresh token. */
  Session: "session",
} as const;
export type Kind = (typeof Kind)[keyof typeof Kind];

/** Where a resolved credential came from. */
export const Origin = {
  Explicit: "explicit configuration",
  Environment: `$${ENV_API_KEY}`,
  File: "stored session",
} as const;
export type Origin = (typeof Origin)[keyof typeof Origin];

function kindOf(credential: string): Kind {
  return credential.startsWith(API_KEY_PREFIX) ? Kind.ApiKey : Kind.Session;
}

// --- The stored session ------------------------------------------------------

/**
 * A stored login, persisted as JSON at {@link sessionPath}.
 *
 * The shape is fixed by the file `jnh` writes: field names, their order, the
 * two-space indent and the absence of a trailing newline are all part of the
 * format, because every client reads and writes the same file and a session
 * written by one must load in another with every field intact.
 */
export interface Session {
  /**
   * The address the tokens were obtained from. Provenance only: it is NOT
   * where this client connects, because the platform publishes more than one
   * front door and the address a client using one recorded is unreachable for
   * another.
   */
  endpoint: string;
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  /**
   * When `accessToken` expires, in unix seconds. Advisory: zero means unknown,
   * which is not the same as expired.
   */
  expiresAt: number;
}

// File field name, in file order, paired with the Session property.
const FIELDS = [
  ["endpoint", "endpoint"],
  ["access_token", "accessToken"],
  ["refresh_token", "refreshToken"],
  ["token_type", "tokenType"],
  ["expires_at", "expiresAt"],
] as const;

export function newSession(fields: Partial<Session> = {}): Session {
  return { endpoint: "", accessToken: "", refreshToken: "", tokenType: "", expiresAt: 0, ...fields };
}

export function sessionExpired(s: Session, nowSeconds = Date.now() / 1000): boolean {
  return s.expiresAt !== 0 && nowSeconds > s.expiresAt;
}

export function sessionRenewable(s: Session): boolean {
  return s.refreshToken !== "";
}

/**
 * The stored session's location, one per user account.
 *
 * Derived from the per-user configuration directory exactly as Go's
 * `os.UserConfigDir` derives it, because `jnh` finds the file that way and
 * every client must agree on one location. On Linux that honors
 * `XDG_CONFIG_HOME`, so relocating the config directory relocates the session.
 */
export function sessionPath(): string {
  let base: string;
  if (process.platform === "win32") {
    base = process.env.APPDATA ?? "";
    if (!base) throw new NoCredentialError("%AppData% is not defined");
  } else if (process.platform === "darwin") {
    const home = process.env.HOME ?? "";
    if (!home) throw new NoCredentialError("$HOME is not defined");
    base = path.join(home, "Library", "Application Support");
  } else {
    base = process.env.XDG_CONFIG_HOME ?? "";
    if (!base) {
      const home = process.env.HOME ?? "";
      if (!home) throw new NoCredentialError("neither $XDG_CONFIG_HOME nor $HOME is defined");
      base = path.join(home, ".config");
    } else if (!path.isAbsolute(base)) {
      throw new NoCredentialError("path in $XDG_CONFIG_HOME is relative");
    }
  }
  return path.join(base, "jennah", "credentials");
}

function parse(file: string, data: Buffer): Session {
  let obj: unknown;
  try {
    obj = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch (e) {
    throw new CorruptSessionError(file, e);
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new CorruptSessionError(file, "not a JSON object");
  }
  const s = newSession();
  for (const [name, prop] of FIELDS) {
    const v = (obj as Record<string, unknown>)[name];
    if (v === undefined || v === null) continue;
    if (prop === "expiresAt") {
      if (typeof v !== "number" || !Number.isInteger(v)) {
        throw new CorruptSessionError(file, `${name} is not an integer`);
      }
      s.expiresAt = v;
    } else {
      if (typeof v !== "string") throw new CorruptSessionError(file, `${name} is not a string`);
      s[prop] = v;
    }
  }
  return s;
}

function isNotFound(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === "ENOENT";
}

/**
 * Read the stored session, or return undefined if there is none.
 *
 * A file that will not parse raises {@link CorruptSessionError}. Every other
 * read failure (a permission problem, an unreadable directory) is raised as
 * itself, because silently treating it as "not logged in" would hide it.
 */
export async function loadSession(): Promise<Session | undefined> {
  const file = sessionPath();
  let data: Buffer;
  try {
    data = await fsp.readFile(file);
  } catch (e) {
    if (isNotFound(e)) return undefined;
    throw e;
  }
  return parse(file, data);
}

/** The synchronous form of {@link loadSession}, for client construction. */
export function loadSessionSync(): Session | undefined {
  const file = sessionPath();
  let data: Buffer;
  try {
    data = fs.readFileSync(file);
  } catch (e) {
    if (isNotFound(e)) return undefined;
    throw e;
  }
  return parse(file, data);
}

function encode(s: Session): Buffer {
  const obj: Record<string, string | number> = {};
  for (const [name, prop] of FIELDS) obj[name] = s[prop];
  // Go's encoder escapes these; matching it keeps a load and re-save through
  // any client byte-identical.
  const text = JSON.stringify(obj, null, 2)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
  return Buffer.from(text, "utf-8");
}

/**
 * Write the session, replacing any previous one, atomically and owner-only.
 *
 * The content lands in a uniquely named temporary file in the same directory,
 * is flushed to disk, and is then renamed over the target, so a concurrent
 * reader sees either the whole previous session or the whole new one. The
 * temporary name is unique per write, because two processes renewing at once
 * would otherwise write through each other's half-finished file.
 */
export async function saveSession(s: Session): Promise<void> {
  const file = sessionPath();
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `credentials-${randomBytes(8).toString("hex")}.tmp`);
  let handle: fsp.FileHandle | undefined;
  try {
    // "wx" with 0600: created fresh, owner-only, the mode the session must end
    // up with.
    handle = await fsp.open(tmp, "wx", 0o600);
    await handle.writeFile(encode(s));
    // A rename that beats its own content to disk would lose a rotated refresh
    // token on a crash, and a lost rotation cannot be renewed.
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsp.rename(tmp, file);
  } catch (e) {
    await handle?.close().catch(() => {});
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
}

/** Remove the stored session. Already absent is not an error. */
export async function deleteSession(): Promise<void> {
  try {
    await fsp.unlink(sessionPath());
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
}

// --- Resolution --------------------------------------------------------------

/** The outcome of {@link resolve}. */
export interface Resolved {
  readonly credential: string;
  readonly kind: Kind;
  readonly origin: Origin;
  /** The stored session the credential came from, or undefined. */
  readonly session?: Session;
}

/**
 * Return the first credential that one of the ordered sources yields.
 *
 * The explicit credential, then `$JENNAH_API_KEY`, then the stored session.
 * First match wins and later sources are not consulted, so an explicit
 * credential works on a machine that has never logged in, and a missing or
 * unreadable session file cannot fail a caller who supplied a key.
 */
export function resolve(explicit?: string): Resolved {
  let c = (explicit ?? "").trim();
  if (c) return { credential: c, kind: kindOf(c), origin: Origin.Explicit };
  c = (process.env[ENV_API_KEY] ?? "").trim();
  if (c) return { credential: c, kind: kindOf(c), origin: Origin.Environment };

  const session = loadSessionSync();
  if (session === undefined) throw new NoCredentialError();
  if (!session.accessToken.trim()) throw new NoCredentialError("the stored session holds no access token");
  return { credential: session.accessToken, kind: kindOf(session.accessToken), origin: Origin.File, session };
}

// --- Sources -----------------------------------------------------------------

/**
 * What a renewer returns. `refreshToken` is part of it because renewal
 * rotates: ignoring it would leave the session holding a dead token.
 */
export interface Renewal {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export type Renewer = (refreshToken: string) => Promise<Renewal>;

/**
 * Supplies the bearer to present, per call rather than once.
 *
 * A long-lived client outlives an access token, so a credential captured at
 * construction would be stale hours later however often it had been renewed.
 * A client asks its source on every call.
 */
export interface CredentialSource {
  readonly kind: Kind;
  readonly origin: Origin;
  token(): string;
  renewable(): boolean;
  /**
   * Called after `presented` was rejected as unauthenticated. Resolves to the
   * credential to reissue the call with, or rejects if there is none.
   */
  renew(presented: string): Promise<string>;
}

/**
 * A credential that never changes: an API key, or a token this client will
 * not renew. A server that holds a signed-in user's access token and renews it
 * by its own means presents it through one of these.
 */
export class StaticSource implements CredentialSource {
  readonly #credential: string;
  readonly kind: Kind;
  readonly origin: Origin;

  constructor(credential: string, origin: Origin = Origin.Explicit) {
    this.#credential = credential;
    this.kind = kindOf(credential);
    this.origin = origin;
  }

  token(): string {
    return this.#credential;
  }

  renewable(): boolean {
    return false;
  }

  async renew(_presented: string): Promise<string> {
    if (this.kind === Kind.ApiKey) throw new CredentialRefusedError();
    throw new SessionExpiredError();
  }
}

// Serializes async sections. Renewal awaits the network, so a plain flag would
// let a second call start its own renewal while the first is in flight.
class Mutex {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.#tail;
    let release!: () => void;
    this.#tail = new Promise((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * A renewable session. Its renewals are single-flight: concurrent rejections
 * produce one rotation.
 *
 * Renewal spends a rotation only when it has to. Before renewing it checks
 * whether the credential already moved on, in this process (a concurrent call
 * renewed while this one waited) or on disk (another process did). After a
 * failed renewal it checks the disk once more, because a rotation lost to
 * another process looks exactly like a failure.
 */
export class SessionSource implements CredentialSource {
  readonly kind = Kind.Session;
  readonly origin: Origin;
  #session: Session;
  #renewer: Renewer | undefined;
  readonly #lock = new Mutex();

  constructor(session: Session, origin: Origin, renewer?: Renewer) {
    this.#session = { ...session };
    this.origin = origin;
    this.#renewer = renewer;
  }

  setRenewer(renewer: Renewer): void {
    this.#renewer = renewer;
  }

  token(): string {
    return this.#session.accessToken;
  }

  renewable(): boolean {
    return this.#renewer !== undefined && sessionRenewable(this.#session);
  }

  renew(presented: string): Promise<string> {
    return this.#lock.run(async () => {
      const replaced = await this.#alreadyReplaced(presented);
      if (replaced) return replaced;
      if (this.#renewer === undefined || !this.#session.refreshToken) {
        throw new SessionExpiredError();
      }
      let renewed: Renewal;
      try {
        renewed = await this.#renewer(this.#session.refreshToken);
      } catch (e) {
        const adopted = await this.#adoptFromDisk(presented);
        if (adopted) return adopted;
        throw new SessionExpiredError(e instanceof Error ? e.message : String(e), { cause: e });
      }
      return this.#apply(renewed);
    });
  }

  async #alreadyReplaced(presented: string): Promise<string | undefined> {
    // Someone in this process got there first while we waited for the lock.
    if (this.#session.accessToken && this.#session.accessToken !== presented) {
      return this.#session.accessToken;
    }
    return this.#adoptFromDisk(presented);
  }

  async #adoptFromDisk(presented: string): Promise<string | undefined> {
    // Opportunistic: a read failure means "nobody else renewed", and the
    // caller has its own path for that.
    if (this.origin !== Origin.File) return undefined;
    let stored: Session | undefined;
    try {
      stored = await loadSession();
    } catch {
      return undefined;
    }
    if (stored === undefined || !stored.accessToken || stored.accessToken === presented) {
      return undefined;
    }
    this.#session = stored;
    return stored.accessToken;
  }

  async #apply(renewed: Renewal | undefined): Promise<string> {
    if (renewed === undefined || !renewed.accessToken) throw new SessionExpiredError();
    this.#session.accessToken = renewed.accessToken;
    if (renewed.refreshToken) this.#session.refreshToken = renewed.refreshToken;
    this.#session.expiresAt = renewed.expiresAt;
    // Publish before relying on it: the token just spent is dead, so a renewal
    // kept in memory leaves every other reader of the file unable to renew.
    if (this.origin === Origin.File) {
      try {
        await saveSession(this.#session);
      } catch (e) {
        throw new SessionPersistError(
          `jennah: renewed the session but could not write it back to ${sessionPath()}: ${
            e instanceof Error ? e.message : String(e)
          }`,
          { cause: e },
        );
      }
    }
    return this.#session.accessToken;
  }
}

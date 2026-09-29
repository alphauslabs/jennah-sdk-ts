/**
 * The client.
 *
 * It hands out the generated service clients already bound to a credentialed
 * transport. That is the whole point of how it is built: the proto is the
 * contract, so every operation it expresses is callable the moment the SDK is
 * regenerated, and reaching one never involves building a transport or
 * attaching a credential by hand, which would silently opt a caller out of
 * per-call resolution, renewal, and publishing a rotated session.
 *
 * @module
 */

import type { DescService } from "@bufbuild/protobuf";
import {
  ConnectError,
  createClient,
  createContextValues,
  type Client as ServiceClient,
  type Interceptor,
} from "@connectrpc/connect";
import { createGrpcTransport, Http2SessionManager, type Http2SessionOptions } from "@connectrpc/connect-node";
import type * as http2 from "node:http2";

import {
  Origin,
  resolve,
  sessionExpired,
  sessionRenewable,
  SessionSource,
  StaticSource,
  type CredentialSource,
  type Kind,
  type Renewal,
} from "./credentials.js";
import { JennahError, SessionExpiredError } from "./errors.js";
import { AgentService } from "./gen/jennah/agent/v1/agent_pb.js";
import { MemoryService } from "./gen/jennah/agent/v1/memory_pb.js";
import { ScopeService } from "./gen/jennah/agent/v1/scope_pb.js";
import { ApprovalService } from "./gen/jennah/approval/v1/approval_pb.js";
import { AuthService } from "./gen/jennah/auth/v1/auth_pb.js";
import { BillingService } from "./gen/jennah/billing/v1/billing_pb.js";
import { DataService } from "./gen/jennah/datastore/v1/data_pb.js";
import { DatasetService } from "./gen/jennah/datastore/v1/dataset_pb.js";
import { SchemaService } from "./gen/jennah/datastore/v1/schema_pb.js";
import { PlatformService } from "./gen/jennah/platform/v1/platform_pb.js";
import { credentialedInterceptors, renewing, type RetryPolicy } from "./transport.js";

/**
 * The platform's public gRPC front door. `jennah.alphaus.cloud` is the HTTP
 * gateway and cannot answer a gRPC call.
 */
export const DEFAULT_ENDPOINT = "jennah-grpc.alphaus.cloud:443";

// How long a renewal may take. It runs underneath a caller's own call, which
// has its own deadline; this only stops a hung renewal from hanging forever.
const RENEWAL_TIMEOUT_MS = 30_000;

/**
 * Every generated service, by the property a {@link Client} exposes it under.
 * The client binds exactly these, and a test proves this list covers every
 * service the generated code publishes.
 */
export const SERVICES = {
  agents: AgentService,
  memory: MemoryService,
  scopes: ScopeService,
  datasets: DatasetService,
  schema: SchemaService,
  data: DataService,
  auth: AuthService,
  approvals: ApprovalService,
  billing: BillingService,
  platform: PlatformService,
} as const;

/**
 * What a client authenticates with and where it came from. Never the
 * credential itself, so every field and its rendering are safe to log.
 */
export class CredentialInfo {
  constructor(
    readonly kind: Kind,
    readonly origin: Origin,
  ) {}

  toString(): string {
    return `${this.kind} from ${this.origin}`;
  }
}

export interface ConnectionOptions {
  /** `host:port`. Defaults to {@link DEFAULT_ENDPOINT}. */
  endpoint?: string;
  /** Cleartext HTTP/2, for a local server. */
  insecure?: boolean;
  /** Keep-alive and idle settings for the HTTP/2 connection. */
  http2?: Http2SessionOptions;
  /** Passed to Node's `http2.connect()`, for example a custom CA. */
  nodeOptions?: http2.ClientSessionOptions | http2.SecureClientSessionOptions;
}

/**
 * One HTTP/2 connection to the platform, shareable between clients that each
 * present a different credential. A server acting for many signed-in users
 * builds one of these and a client per request on top of it, so every request
 * reuses the connection while each carries its own credential.
 */
export class Connection {
  readonly endpoint: string;
  readonly baseUrl: string;
  readonly sessionManager: Http2SessionManager;

  constructor(options: ConnectionOptions = {}) {
    this.endpoint = options.endpoint || DEFAULT_ENDPOINT;
    this.baseUrl = `${options.insecure ? "http" : "https"}://${this.endpoint}`;
    this.sessionManager = new Http2SessionManager(this.baseUrl, options.http2, options.nodeOptions);
  }

  /** Close the connection and any calls still open on it. */
  close(): void {
    this.sessionManager.abort();
  }
}

export interface ClientOptions extends ConnectionOptions {
  /** An API key, or an access token this client will present but not renew. */
  apiKey?: string;
  /** A credential source, taking precedence over every other. */
  credentials?: CredentialSource;
  retry?: RetryPolicy;
  /**
   * Share an existing connection instead of opening one. The connection
   * options above are then ignored, and {@link Client.close} leaves the
   * connection open for its other users.
   */
  connection?: Connection;
  /** Extra interceptors, run inside the SDK's retry and credential ones. */
  interceptors?: Interceptor[];
}

// Connect turns anything an interceptor throws into a ConnectError with code
// Unknown, keeping the original only as its cause. The SDK's own errors are
// raised from its interceptors, so without this a caller would see Unknown for
// an expired session and could not branch on SessionExpiredError at all.
function unwrap(e: unknown): unknown {
  if (e instanceof ConnectError && !e.isWireError && e.cause instanceof JennahError) return e.cause;
  return e;
}

function unwrapping<T extends DescService>(client: ServiceClient<T>): ServiceClient<T> {
  const out: Record<string, unknown> = {};
  for (const [name, method] of Object.entries(client as Record<string, unknown>)) {
    if (typeof method !== "function") {
      out[name] = method;
      continue;
    }
    out[name] = (...args: unknown[]) => {
      const result = (method as (...a: unknown[]) => unknown)(...args);
      // Unary calls return a promise. The platform serves no tenant-facing
      // stream, so a streaming method's iterable is handed back untouched.
      return result instanceof Promise ? result.catch((e: unknown) => Promise.reject(unwrap(e))) : result;
    };
  }
  return out as ServiceClient<T>;
}

function sourceFor(apiKey: string | undefined, credentials: CredentialSource | undefined): CredentialSource {
  if (credentials !== undefined) return credentials;
  const resolved = resolve(apiKey);
  if (resolved.session === undefined) {
    // An API key, or an explicit token: nothing to renew with.
    return new StaticSource(resolved.credential, resolved.origin);
  }
  // Refused here only when nothing can renew it. A renewable expired session is
  // an ordinary condition its first call resolves.
  if (sessionExpired(resolved.session) && !sessionRenewable(resolved.session)) {
    throw new SessionExpiredError();
  }
  return new SessionSource(resolved.session, resolved.origin);
}

/**
 * A connection to Jennah, scoped to one credential.
 *
 * With no `apiKey` or `credentials`, the credential is resolved in order from
 * `$JENNAH_API_KEY` and then the session stored by `jnh login`, and a stored
 * session is renewed underneath the client when it expires.
 *
 * Every call is a generated method, for example
 * `await client.agents.listAgents({})`.
 */
export class Client {
  /** Agent workspaces (`AgentService`). */
  readonly agents: ServiceClient<typeof AgentService>;
  /** Commit, query, inspect and form memory (`MemoryService`). */
  readonly memory: ServiceClient<typeof MemoryService>;
  /** Memory scopes of either kind (`ScopeService`). */
  readonly scopes: ServiceClient<typeof ScopeService>;
  readonly datasets: ServiceClient<typeof DatasetService>;
  readonly schema: ServiceClient<typeof SchemaService>;
  readonly data: ServiceClient<typeof DataService>;
  readonly auth: ServiceClient<typeof AuthService>;
  readonly approvals: ServiceClient<typeof ApprovalService>;
  readonly billing: ServiceClient<typeof BillingService>;
  readonly platform: ServiceClient<typeof PlatformService>;

  readonly #source: CredentialSource;
  readonly #connection: Connection;
  readonly #ownsConnection: boolean;
  readonly #transport: ReturnType<typeof createGrpcTransport>;

  constructor(options: ClientOptions = {}) {
    this.#source = sourceFor(options.apiKey, options.credentials);
    // The stored session's endpoint is never used: it records the HTTP gateway
    // a CLI login went through, which cannot answer gRPC.
    this.#ownsConnection = options.connection === undefined;
    this.#connection = options.connection ?? new Connection(options);
    this.#transport = createGrpcTransport({
      baseUrl: this.#connection.baseUrl,
      sessionManager: this.#connection.sessionManager,
      interceptors: [...credentialedInterceptors(this.#source, options.retry), ...(options.interceptors ?? [])],
    });

    this.agents = this.service(SERVICES.agents);
    this.memory = this.service(SERVICES.memory);
    this.scopes = this.service(SERVICES.scopes);
    this.datasets = this.service(SERVICES.datasets);
    this.schema = this.service(SERVICES.schema);
    this.data = this.service(SERVICES.data);
    this.auth = this.service(SERVICES.auth);
    this.approvals = this.service(SERVICES.approvals);
    this.billing = this.service(SERVICES.billing);
    this.platform = this.service(SERVICES.platform);

    if (this.#source instanceof SessionSource) {
      this.#source.setRenewer((refreshToken) => this.#renew(refreshToken));
    }
  }

  /**
   * Bind any generated service to this client's credentialed transport, for a
   * service added to the proto after this SDK version named it.
   */
  service<T extends DescService>(service: T): ServiceClient<T> {
    return unwrapping(createClient(service, this.#transport));
  }

  get endpoint(): string {
    return this.#connection.endpoint;
  }

  get credential(): CredentialInfo {
    return new CredentialInfo(this.#source.kind, this.#source.origin);
  }

  async #renew(refreshToken: string): Promise<Renewal> {
    // No enterprise id: this renews in place. Passing one would switch which
    // enterprise the token is scoped to, which is never a side effect of expiry.
    const resp = await this.auth.refreshToken(
      { refreshToken },
      { timeoutMs: RENEWAL_TIMEOUT_MS, contextValues: createContextValues().set(renewing, true) },
    );
    return {
      accessToken: resp.accessToken,
      refreshToken: resp.refreshToken,
      expiresAt: Math.floor(Date.now() / 1000) + Number(resp.expiresIn),
    };
  }

  /** Close the connection, unless it was passed in to be shared. */
  close(): void {
    if (this.#ownsConnection) this.#connection.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

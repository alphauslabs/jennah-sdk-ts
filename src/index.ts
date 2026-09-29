/**
 * TypeScript SDK for Jennah, the memory and context platform for AI agents.
 *
 * Server-side only: see `browser.ts` for why a web page cannot load it.
 *
 * ```ts
 * import { Client } from "jennah-sdk-ts";
 *
 * const client = new Client(); // $JENNAH_API_KEY, or the session from `jnh login`
 * const { agents } = await client.agents.listAgents({});
 * ```
 *
 * Request and response message types live in the generated modules, under
 * `jennah-sdk-ts/gen/jennah/<package>/v1/<file>_pb`.
 *
 * @module
 */

export { Client, Connection, CredentialInfo, DEFAULT_ENDPOINT, SERVICES } from "./client.js";
export type { ClientOptions, ConnectionOptions } from "./client.js";
export {
  Kind,
  Origin,
  SessionSource,
  StaticSource,
  deleteSession,
  loadSession,
  newSession,
  resolve,
  saveSession,
  sessionPath,
} from "./credentials.js";
export type { CredentialSource, Renewal, Renewer, Resolved, Session } from "./credentials.js";
export {
  CorruptSessionError,
  CredentialRefusedError,
  ENV_API_KEY,
  JennahError,
  NoCredentialError,
  SessionExpiredError,
  SessionPersistError,
  code,
  isTransient,
  isUnauthenticated,
} from "./errors.js";
export type { RetryPolicy } from "./transport.js";
export { version } from "./version.js";

// The runtime the generated code is built on, so a caller does not need a
// second install of it at a version that may not match.
export { clone, create, equals, fromJson, fromJsonString, isMessage, toJson, toJsonString } from "@bufbuild/protobuf";
export { Code, ConnectError } from "@connectrpc/connect";

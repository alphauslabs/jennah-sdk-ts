/**
 * Which calls the SDK replays after a transient failure.
 *
 * A question about the server's write semantics, not the network, and answered
 * per REQUEST for four writes, which is why this is a table and a predicate
 * rather than a per-method retry policy (that sees the method, never the
 * request).
 *
 * test/classification.test.ts fails if any method the generated code publishes
 * is in none or more than one of the three sets, so a new RPC cannot inherit
 * "never replay" without someone deciding it should.
 *
 * @module
 */

import { Code } from "@connectrpc/connect";

/**
 * Only UNAVAILABLE is transient: a dropped connection, a draining instance, a
 * rolling deploy. RESOURCE_EXHAUSTED is an entitlement limit and would answer
 * the same forever; DEADLINE_EXCEEDED means the caller's own budget is spent.
 */
export const RETRYABLE_CODES: ReadonlySet<Code> = new Set([Code.Unavailable]);

const AGENT = "/jennahapi.agent.v1.AgentService/";
const MEMORY = "/jennahapi.agent.v1.MemoryService/";
const SCOPE = "/jennahapi.agent.v1.ScopeService/";
const DATASET = "/jennahapi.datastore.v1.DatasetService/";
const SCHEMA = "/jennahapi.datastore.v1.SchemaService/";
const DATA = "/jennahapi.datastore.v1.DataService/";
const AUTH = "/jennahapi.auth.v1.AuthService/";
const APPROVAL = "/jennahapi.approval.v1.ApprovalService/";
const BILLING = "/jennahapi.billing.v1.BillingService/";
const PLATFORM = "/jennahapi.platform.v1.PlatformService/";

/**
 * Every method that reads without writing: replaying one costs a round trip
 * and nothing else. Enumerated rather than matched on "Get"/"List", which are
 * conventions the server is not obliged to keep.
 */
export const REPLAYABLE_READS: ReadonlySet<string> = new Set([
  AGENT + "GetAgent",
  AGENT + "ListAgents",
  MEMORY + "QueryMemory",
  MEMORY + "InspectMemory",
  MEMORY + "GetMemoryVocabulary",
  SCOPE + "GetScope",
  SCOPE + "ListScopes",
  DATASET + "GetDataset",
  DATASET + "ListDatasets",
  SCHEMA + "GetSchema",
  DATA + "QueryData",
  AUTH + "WhoAmI",
  AUTH + "ListApiKeys",
  AUTH + "ListMembers",
  AUTH + "ListInvitations",
  AUTH + "ListPermissions",
  AUTH + "ListRoles",
  AUTH + "GetRole",
  AUTH + "PollDeviceLogin",
  APPROVAL + "GetApproval",
  APPROVAL + "ListApprovals",
  APPROVAL + "ListApprovers",
  APPROVAL + "DescribeApprovalByToken",
  BILLING + "GetBillingState",
  BILLING + "GetFormationTokenUsage",
  PLATFORM + "ListLocations",
]);

/** Writes whose safety depends on the request; decided in {@link safeToReplay}. */
export const CONDITIONAL_REPLAY: ReadonlySet<string> = new Set([
  MEMORY + "CommitMemory",
  MEMORY + "FormMemory",
  DATA + "CommitData",
  APPROVAL + "CreateApproval",
]);

/**
 * Never replayed automatically. Listed so the classification test can prove
 * nothing was simply overlooked.
 */
export const NEVER_REPLAY: ReadonlySet<string> = new Set([
  // Creating or destroying a resource twice is not the same as once.
  AGENT + "CreateAgent",
  AGENT + "DeleteAgent",
  SCOPE + "CreateScope",
  SCOPE + "DeleteScope",
  DATASET + "CreateDataset",
  DATASET + "DeleteDataset",
  // Schema work is asynchronous; a replay races the declaration already running.
  SCHEMA + "DeclareTables",
  // Closes a validity window and inserts a replacement; a replay finds it closed.
  MEMORY + "SupersedeEdge",
  MEMORY + "SupersedeChunk",
  // Converge when repeated alone, but a replay across another caller's
  // declaration would overwrite it; rare administrative calls the caller retries.
  MEMORY + "DeclareMemoryVocabulary",
  MEMORY + "RemoveMemoryVocabulary",
  // A long poll that reports a pending approval as success.
  APPROVAL + "WaitApproval",
  // Each sends mail, records a decision, or ends an approval.
  APPROVAL + "CancelApproval",
  APPROVAL + "ResendApprovalNotification",
  APPROVAL + "SubmitApprovalDecision",
  APPROVAL + "AddApprover",
  APPROVAL + "RemoveApprover",
  // Session and credential mutations: a replayed refresh or logout can revoke
  // what the first attempt issued, a replayed mint leaves an unheld key.
  AUTH + "StartLogin",
  AUTH + "CompleteLogin",
  AUTH + "ExchangeCode",
  AUTH + "StartDeviceLogin",
  AUTH + "RefreshToken",
  AUTH + "Logout",
  AUTH + "CreateApiKey",
  AUTH + "RevokeApiKey",
  // Membership, role and enterprise administration.
  AUTH + "InviteMember",
  AUTH + "RevokeInvitation",
  AUTH + "AcceptInvitation",
  AUTH + "ChangeMemberRole",
  AUTH + "RemoveMember",
  AUTH + "TransferRoot",
  AUTH + "UpdateEnterprise",
  AUTH + "CreateRole",
  AUTH + "UpdateRole",
  AUTH + "DeleteRole",
  // Commits the enterprise to a paid agreement.
  BILLING + "BindMarketplaceRegistration",
  BILLING + "ResolveMarketplaceRegistration",
]);

/**
 * Whether replaying `request` to `method` (a `/package.Service/Method` path)
 * cannot produce a second effect.
 *
 * - CommitMemory: vector and graph writes are idempotent upserts, but a log
 *   step is append-only, so a commit carrying a log section is not replayed.
 * - FormMemory: only with `formationKey`; extraction is nondeterministic, so a
 *   blind replay forms a second, different set of memory.
 * - CommitData: only with `idempotencyKey`.
 * - CreateApproval: only with `requestKey`; mail cannot be recalled.
 *
 * Anything unclassified is not replayed.
 */
export function safeToReplay(method: string, request: object): boolean {
  if (REPLAYABLE_READS.has(method)) return true;
  const r = request as Record<string, unknown>;
  switch (method) {
    case MEMORY + "CommitMemory":
      return r.log === undefined;
    case MEMORY + "FormMemory":
      return Boolean(r.formationKey);
    case DATA + "CommitData":
      return Boolean(r.idempotencyKey);
    case APPROVAL + "CreateApproval":
      return Boolean(r.requestKey);
  }
  return false;
}

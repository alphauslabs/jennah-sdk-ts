// The shared credential conformance suite.
//
// The cases live in conformance/credentials/cases.json, laid here by
// jennah-api's release/typescript/assemble.sh from the same revision as the
// generated code. This file only translates them onto this SDK: see
// conformance/README.md for what each op and expectation means. A failing case
// is a defect in this SDK, never a reason to edit the case.

import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as util from "node:util";

import { Client, DEFAULT_ENDPOINT } from "../src/client.js";
import { Kind, loadSession, newSession, Origin, saveSession, type Session } from "../src/credentials.js";
import {
  code,
  CorruptSessionError,
  CredentialRefusedError,
  NoCredentialError,
  SessionExpiredError,
} from "../src/errors.js";
import { AgentService } from "../src/gen/jennah/agent/v1/agent_pb.js";
import { AuthService } from "../src/gen/jennah/auth/v1/auth_pb.js";
import { DataService } from "../src/gen/jennah/datastore/v1/data_pb.js";
import { emptyMachine, serve, writeSession, type Machine, type SessionSpec } from "./helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CASES = path.join(ROOT, "conformance", "credentials", "cases.json");

// --- Loading, strictly -------------------------------------------------------

// Unknown keys fail rather than being skipped: a harness that ignores what it
// does not understand passes cases it never ran.
const SESSION_KEYS = new Set(["raw", "endpoint", "access_token", "refresh_token", "token_type", "expires_in", "expires"]);
const SERVER_KEYS = new Set(["accept", "reject_all", "unavailable_first", "refresh", "on_refresh_write_session"]);
const REFRESH_KEYS = new Set(["accept", "access_token", "refresh_token", "expires_in"]);
const STEP_KEYS = new Set(["op", "method", "endpoint", "count", "writes", "raw", "session", "expect"]);
const EXPECT_KEYS = new Set([
  "ok", "error", "not", "mentions", "kind", "origin", "endpoint", "partial_reads", "identical",
  "presented", "refresh_bearers", "refreshes", "refresh_calls", "session", "session_mode",
  "dir_mode", "stray_files",
]);
const CASE_KEYS = new Set(["id", "requirement", "scenario", "requires", "given", "steps"]);
const GIVEN_KEYS = new Set(["explicit", "env", "session", "server"]);

/* eslint-disable @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>;

function strict(obj: Obj, allowed: Set<string>, where: string): void {
  const unknown = Object.keys(obj).filter((k) => !allowed.has(k));
  assert.deepEqual(unknown, [], `${where}: unknown keys ${JSON.stringify(unknown)}`);
}

function load(): Obj[] {
  const suite = JSON.parse(fs.readFileSync(CASES, "utf-8")) as Obj;
  strict(suite, new Set(["suite", "version", "source", "cases"]), "suite");
  assert.ok(suite.suite === "client-credentials" && suite.version === 1, "this harness understands client-credentials version 1");
  const cases = suite.cases as Obj[];
  assert.ok(cases.length > 0, "the shared suite has no cases");
  const ids = cases.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate case ids");
  for (const c of cases) {
    strict(c, CASE_KEYS, c.id);
    const g = (c.given ?? {}) as Obj;
    strict(g, GIVEN_KEYS, `${c.id} given`);
    if (g.session && typeof g.session === "object") strict(g.session, SESSION_KEYS, `${c.id} session`);
    const srv = (g.server ?? {}) as Obj;
    strict(srv, SERVER_KEYS, `${c.id} server`);
    if (srv.refresh) strict(srv.refresh, REFRESH_KEYS, `${c.id} refresh`);
    if (srv.on_refresh_write_session) strict(srv.on_refresh_write_session, SESSION_KEYS, `${c.id} on_refresh`);
    for (const s of c.steps as Obj[]) {
      strict(s, STEP_KEYS, `${c.id} step`);
      if (s.expect) strict(s.expect, EXPECT_KEYS, `${c.id} expect`);
      if (s.session && typeof s.session === "object") strict(s.session, SESSION_KEYS, `${c.id} step session`);
    }
  }
  return cases;
}

// --- The fake platform -------------------------------------------------------

function bearer(ctx: HandlerContext): string {
  const v = ctx.requestHeader.get("authorization") ?? "";
  return v.startsWith("Bearer ") ? v.slice("Bearer ".length) : v;
}

class FakePlatform {
  spec: Obj;
  presented: string[] = [];
  refreshBearers: string[] = [];
  refreshes = 0;
  refreshCalls = 0;
  #held = 0;
  #gateOpen = true;
  #open: () => void = () => {};
  #gate: Promise<void> = Promise.resolve();

  constructor(
    spec: Obj,
    readonly writeSession: (s: SessionSpec) => void,
  ) {
    this.spec = structuredClone(spec);
  }

  holdNext(n: number): void {
    this.#held = n;
    this.#gateOpen = false;
    this.#gate = new Promise((r) => (this.#open = r));
  }

  // Hold each of the next N business attempts until all N have arrived, so
  // every concurrent call is in flight with the same credential before any is
  // rejected.
  async #barrier(): Promise<void> {
    if (this.#gateOpen) return;
    this.#held--;
    if (this.#held === 0) {
      this.#gateOpen = true;
      this.#open();
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const fallback = new Promise<void>((r) => (timer = setTimeout(r, 10_000)));
    await Promise.race([this.#gate, fallback]);
    clearTimeout(timer);
  }

  async business(ctx: HandlerContext): Promise<void> {
    await this.#barrier();
    const got = bearer(ctx);
    this.presented.push(got);
    if ((this.spec.unavailable_first ?? 0) > 0) {
      this.spec.unavailable_first--;
      throw new ConnectError("try again", Code.Unavailable);
    }
    if (this.spec.reject_all || !this.spec.accept || got !== this.spec.accept) {
      throw new ConnectError("the access token is invalid or has expired", Code.Unauthenticated);
    }
  }

  refresh(refreshToken: string, ctx: HandlerContext): { accessToken: string; refreshToken: string; expiresIn: bigint } {
    this.refreshCalls++;
    this.refreshBearers.push(bearer(ctx));
    if (this.spec.on_refresh_write_session) this.writeSession(this.spec.on_refresh_write_session);
    const rf = this.spec.refresh as Obj | undefined;
    if (rf === undefined || refreshToken !== rf.accept) {
      throw new ConnectError("the refresh token is invalid or has expired", Code.Unauthenticated);
    }
    this.refreshes++;
    // Rotate: the refresh token just presented is dead from here on.
    this.spec.accept = rf.access_token;
    this.spec.refresh = { accept: rf.refresh_token, access_token: "", refresh_token: "", expires_in: 0 };
    return { accessToken: rf.access_token, refreshToken: rf.refresh_token, expiresIn: BigInt(rf.expires_in) };
  }
}

// --- Running a case ----------------------------------------------------------

const CATEGORIES: Record<string, (e: unknown) => boolean> = {
  no_credential: (e) => e instanceof NoCredentialError,
  corrupt_session: (e) => e instanceof CorruptSessionError,
  session_expired: (e) => e instanceof SessionExpiredError,
  credential_refused: (e) => e instanceof CredentialRefusedError,
  unauthenticated: (e) => code(e) === Code.Unauthenticated,
  unavailable: (e) => code(e) === Code.Unavailable,
  failed: (e) => e !== undefined,
};

const KIND: Record<Kind, string> = { [Kind.ApiKey]: "api_key", [Kind.Session]: "session" };
const ORIGIN: Record<Origin, string> = {
  [Origin.Explicit]: "explicit",
  [Origin.Environment]: "environment",
  [Origin.File]: "file",
};

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

class Run {
  readonly machine: Machine;
  readonly platform: FakePlatform;
  readonly secrets: string[];
  client: Client | undefined;
  endpoint = "";
  #close: (() => Promise<void>) | undefined;

  constructor(readonly c: Obj) {
    this.machine = emptyMachine();
    const given = (c.given ?? {}) as Obj;
    if (given.env) process.env.JENNAH_API_KEY = given.env;
    if (given.session && typeof given.session === "object") this.writeSession(given.session);
    this.secrets = [given.explicit, given.env, given.session?.access_token, given.session?.refresh_token].filter(
      (s): s is string => typeof s === "string" && s !== "",
    );
    this.platform = new FakePlatform(given.server ?? {}, (s) => this.writeSession(s));
  }

  async start(): Promise<void> {
    const platform = this.platform;
    const served = await serve((router) => {
      router.service(AgentService, {
        async listAgents(_req, ctx) {
          await platform.business(ctx);
          return {};
        },
      });
      router.service(DataService, {
        async commitData(_req, ctx) {
          await platform.business(ctx);
          return {};
        },
      });
      router.service(AuthService, {
        async refreshToken(req, ctx) {
          return platform.refresh(req.refreshToken, ctx);
        },
      });
    });
    this.endpoint = served.endpoint;
    this.#close = served.close;
  }

  async close(): Promise<void> {
    this.client?.close();
    await this.#close?.();
    this.machine.restore();
  }

  writeSession(s: SessionSpec): void {
    writeSession(this.machine.sessionPath, s);
  }

  expectOutcome(where: string, ex: Obj, err: unknown): void {
    if ("ok" in ex) {
      if (ex.ok && err !== undefined) assert.fail(`${where}: want success, got ${util.inspect(err)}`);
      return;
    }
    assert.ok(ex.error, `${where}: expect names neither ok nor error`);
    assert.ok(err !== undefined, `${where}: want error ${JSON.stringify(ex.error)}, got success`);
    for (const cat of ex.error as string[]) {
      const pred = CATEGORIES[cat];
      assert.ok(pred, `${where}: unknown error category ${cat}`);
      assert.ok(pred(err), `${where}: error ${util.inspect(err)} is not ${cat}`);
    }
    for (const cat of (ex.not ?? []) as string[]) {
      const pred = CATEGORIES[cat];
      assert.ok(pred, `${where}: unknown error category ${cat}`);
      assert.ok(!pred(err), `${where}: error ${util.inspect(err)} must not be ${cat}`);
    }
    for (let m of (ex.mentions ?? []) as string[]) {
      if (m === "$SESSION_PATH") m = this.machine.sessionPath;
      assert.ok(message(err).includes(m), `${where}: error ${JSON.stringify(message(err))} does not mention ${m}`);
    }
  }

  async call(method: string): Promise<unknown> {
    const client = this.client;
    assert.ok(client, "call before construct");
    try {
      if (method === "read") await client.agents.listAgents({}, { timeoutMs: 10_000 });
      else if (method === "write_unsafe") await client.data.commitData({}, { timeoutMs: 10_000 });
      else assert.fail(`unknown method ${method}`);
    } catch (e) {
      return e;
    }
    return undefined;
  }

  async step(i: number, s: Obj): Promise<void> {
    const op = s.op as string;
    const ex = (s.expect ?? {}) as Obj;
    const where = `step ${i} (${op})`;
    switch (op) {
      case "construct": {
        const explicit = this.c.given?.explicit as string | undefined;
        let options: ConstructorParameters<typeof Client>[0];
        if (s.endpoint === undefined) options = { apiKey: explicit, endpoint: this.endpoint, insecure: true };
        else if (s.endpoint === "default") options = { apiKey: explicit };
        else assert.fail(`${where}: unknown endpoint ${s.endpoint}`);
        let err: unknown;
        try {
          this.client = new Client(options);
        } catch (e) {
          err = e;
        }
        this.expectOutcome(where, ex, err);
        break;
      }
      case "describe": {
        const client = this.client;
        assert.ok(client, `${where}: describe before construct`);
        const info = client.credential;
        const rendered = [
          String(info),
          JSON.stringify(info),
          util.inspect(info, { showHidden: true, depth: 5 }),
          util.inspect(client, { showHidden: true, depth: 5 }),
        ].join(" ");
        for (const secret of this.secrets) {
          assert.ok(!rendered.includes(secret), `${where}: the credential report leaks a secret`);
        }
        if ("kind" in ex) assert.equal(KIND[info.kind], ex.kind, `${where}: kind = ${info.kind}`);
        if ("origin" in ex) assert.equal(ORIGIN[info.origin], ex.origin, `${where}: origin = ${info.origin}`);
        if ("endpoint" in ex) {
          const want = ex.endpoint === "$DEFAULT_ENDPOINT" ? DEFAULT_ENDPOINT : ex.endpoint;
          assert.equal(client.endpoint, want, `${where}: endpoint`);
        }
        break;
      }
      case "call":
        this.expectOutcome(where, ex, await this.call(s.method));
        break;
      case "call_concurrently": {
        assert.ok(s.count >= 2);
        this.platform.holdNext(s.count);
        const errs = await Promise.all(Array.from({ length: s.count }, () => this.call(s.method)));
        errs.forEach((err, n) => this.expectOutcome(`${where} call ${n}`, ex, err));
        break;
      }
      case "write_session":
        this.writeSession(s.session);
        break;
      case "lock_session_directory":
        assert.ok(
          ((this.c.requires ?? []) as string[]).includes("unwritable_directory"),
          `${where}: case does not declare requires unwritable_directory`,
        );
        fs.chmodSync(path.dirname(this.machine.sessionPath), 0o500);
        break;
      case "atomic_replace": {
        const got = await this.atomicReplace(s.writes);
        assert.equal(got, ex.partial_reads, `${where}: partial reads`);
        break;
      }
      case "round_trip": {
        this.writeSession({ raw: s.raw });
        const loaded = await loadSession();
        assert.ok(loaded, `${where}: nothing loaded`);
        await saveSession(loaded);
        const data = fs.readFileSync(this.machine.sessionPath);
        assert.equal(data.equals(Buffer.from(s.raw, "utf-8")), ex.identical, `${where}: got ${data.toString()}`);
        break;
      }
      case "check":
        await this.check(where, ex);
        break;
      default:
        assert.fail(`${where}: unknown op`);
    }
  }

  async atomicReplace(writes: number): Promise<number> {
    assert.ok(writes >= 1);
    // Lengths vary on purpose, so a torn write cannot parse by accident.
    const token = (n: number) => `at_${n}_` + "x".repeat(n % 37);
    const written = new Set(Array.from({ length: writes }, (_, n) => token(n)));
    let partial = 0;
    let done = false;
    const reader = async () => {
      while (!done) {
        let bad: boolean;
        try {
          const s = await loadSession();
          bad = s !== undefined && !written.has(s.accessToken);
        } catch {
          bad = true;
        }
        if (bad) partial++;
      }
    };
    const readers = Array.from({ length: 4 }, reader);
    for (let n = 0; n < writes; n++) {
      await saveSession(
        newSession({ endpoint: "https://jennah.alphaus.cloud", accessToken: token(n), refreshToken: "rt", tokenType: "Bearer" }),
      );
    }
    done = true;
    await Promise.all(readers);
    return partial;
  }

  async check(where: string, ex: Obj): Promise<void> {
    const p = this.platform;
    if ("presented" in ex) assert.deepEqual(p.presented, ex.presented, `${where}: presented`);
    if ("refresh_bearers" in ex) assert.deepEqual(p.refreshBearers, ex.refresh_bearers, `${where}: refresh bearers`);
    if ("refreshes" in ex) assert.equal(p.refreshes, ex.refreshes, `${where}: refreshes`);
    if ("refresh_calls" in ex) assert.equal(p.refreshCalls, ex.refresh_calls, `${where}: refresh calls`);
    if ("session" in ex) {
      const want = ex.session;
      if (want === "absent") {
        assert.ok(!fs.existsSync(this.machine.sessionPath), `${where}: want no stored session`);
      } else {
        assert.ok(want && typeof want === "object", `${where}: unknown session expectation`);
        const got = (await loadSession()) as Session;
        assert.ok(got, `${where}: no stored session`);
        const props = { endpoint: "endpoint", access_token: "accessToken", refresh_token: "refreshToken", token_type: "tokenType" } as const;
        for (const [k, prop] of Object.entries(props)) {
          if (k in want) assert.equal(got[prop], want[k], `${where}: stored ${k}`);
        }
        if (want.expires === "future") assert.ok(got.expiresAt > Date.now() / 1000, `${where}: stored expires_at not in the future`);
        else if ("expires" in want) assert.fail(`${where}: unknown expires expectation`);
      }
    }
    if (process.platform !== "win32") {
      for (const [key, file] of [
        ["session_mode", this.machine.sessionPath],
        ["dir_mode", path.dirname(this.machine.sessionPath)],
      ] as const) {
        if (key in ex) {
          const mode = (fs.statSync(file).mode & 0o777).toString(8).padStart(4, "0");
          assert.equal(mode, ex[key], `${where}: mode of ${file}`);
        }
      }
    }
    if ("stray_files" in ex) {
      const dir = path.dirname(this.machine.sessionPath);
      const stray = fs.readdirSync(dir).filter((n) => n !== path.basename(this.machine.sessionPath));
      assert.equal(stray.length, ex.stray_files, `${where}: stray files ${JSON.stringify(stray)}`);
    }
  }
}

function skipReason(c: Obj): string | undefined {
  for (const req of (c.requires ?? []) as string[]) {
    if (req === "unwritable_directory") {
      if (process.platform === "win32" || process.getuid?.() === 0) {
        return "directory permissions are not enforced for this runner";
      }
    } else {
      throw new Error(`unknown requirement ${req}`);
    }
  }
  return undefined;
}

for (const c of load()) {
  // A hang is a failure, not a stuck run: a client that deadlocks on renewal
  // would otherwise never report.
  test(c.id as string, { skip: skipReason(c), timeout: 20_000 }, async () => {
    const run = new Run(c);
    try {
      await run.start();
      for (const [i, s] of (c.steps as Obj[]).entries()) await run.step(i, s);
    } finally {
      await run.close();
    }
  });
}

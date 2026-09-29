// Resolution and the stored session file, beyond what the shared suite covers.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { afterEach, beforeEach, test } from "node:test";

import { Client } from "../src/client.js";
import { loadSession, newSession, Origin, resolve, saveSession, sessionPath } from "../src/credentials.js";
import { CorruptSessionError, ENV_API_KEY, NoCredentialError, SessionExpiredError } from "../src/errors.js";
import { emptyMachine, writeSession, type Machine } from "./helpers.js";

let m: Machine;
beforeEach(() => (m = emptyMachine()));
afterEach(() => m.restore());

const STORED = { endpoint: "https://jennah.alphaus.cloud", access_token: "at_stored", refresh_token: "rt", token_type: "Bearer", expires_in: 3600 };

test("the order is explicit, then the environment, then the stored session", () => {
  writeSession(m.sessionPath, STORED);
  process.env[ENV_API_KEY] = "jennah_sk_env";
  assert.equal(resolve("jennah_sk_explicit").origin, Origin.Explicit);
  assert.equal(resolve().origin, Origin.Environment);
  delete process.env[ENV_API_KEY];
  const r = resolve();
  assert.equal(r.origin, Origin.File);
  assert.equal(r.credential, "at_stored");
});

test("blank explicit and environment credentials do not count as supplied", () => {
  writeSession(m.sessionPath, STORED);
  process.env[ENV_API_KEY] = "   ";
  assert.equal(resolve("  ").origin, Origin.File);
});

test("the session path follows XDG_CONFIG_HOME, and a relative one is refused", { skip: process.platform === "win32" || process.platform === "darwin" }, () => {
  assert.equal(sessionPath(), m.sessionPath);
  process.env.XDG_CONFIG_HOME = "relative/dir";
  assert.throws(() => sessionPath(), NoCredentialError);
});

test("a session holding no access token is no credential", () => {
  writeSession(m.sessionPath, { ...STORED, access_token: "" });
  assert.throws(() => resolve(), (e: unknown) => e instanceof NoCredentialError && /no access token/.test((e as Error).message));
});

test("a field of the wrong type is a corrupt session naming the path", () => {
  writeSession(m.sessionPath, { raw: JSON.stringify({ access_token: "at", expires_at: "soon" }) });
  assert.throws(() => resolve(), (e: unknown) => e instanceof CorruptSessionError && e.path === m.sessionPath);
  writeSession(m.sessionPath, { raw: JSON.stringify({ access_token: 42 }) });
  assert.throws(() => resolve(), CorruptSessionError);
  writeSession(m.sessionPath, { raw: "[]" });
  assert.throws(() => resolve(), CorruptSessionError);
});

test("null and unknown fields are ignored", async () => {
  writeSession(m.sessionPath, { raw: JSON.stringify({ access_token: "at", refresh_token: null, extra: 1 }) });
  const s = await loadSession();
  assert.equal(s?.accessToken, "at");
  assert.equal(s?.refreshToken, "");
});

test("an expired session that cannot be renewed fails construction, naming the fix", () => {
  writeSession(m.sessionPath, { ...STORED, refresh_token: "", expires_in: -60 });
  assert.throws(() => new Client(), (e: unknown) => e instanceof SessionExpiredError && /jnh login/.test((e as Error).message));
});

test("an unknown expiry is not treated as expired", () => {
  writeSession(m.sessionPath, { ...STORED, refresh_token: "", expires_in: undefined });
  new Client().close();
});

test("saving escapes as Go's encoder does, so every client round-trips the file", async () => {
  await saveSession(newSession({ accessToken: "a<b>&c d" }));
  const text = fs.readFileSync(m.sessionPath, "utf-8");
  assert.ok(text.includes('"a\\u003cb\\u003e\\u0026c\\u2028d"'), text);
  assert.ok(!text.endsWith("\n"), "the file must not end with a newline");
  assert.equal((await loadSession())?.accessToken, "a<b>&c d");
});

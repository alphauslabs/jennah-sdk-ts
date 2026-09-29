## jennah-sdk-ts

The TypeScript SDK for [Jennah](https://jennah.nightblue.io/), the memory and
context platform for AI agents. It works the same from plain JavaScript: the
package ships compiled JavaScript with its type declarations.

```sh
npm install jennah-sdk-ts
```

Requires Node.js 22.12 or later. It is an ES module that CommonJS code can also
`require()`.

**Server-side only.** The SDK refuses to load in a web browser. A credential in
a web page is readable by its user and by every script on the page, so a
browser application should call your own server, and your server calls Jennah.

## Store and recall a memory

Sign in once with the [`jnh` CLI](https://jennah.nightblue.io/docs/cli/)
(`jnh login`), or set `JENNAH_API_KEY`. Then:

```ts
import { randomUUID } from "node:crypto";
import { Client } from "jennah-sdk-ts";

const client = new Client(); // uses `jnh login`, or $JENNAH_API_KEY
const agentInstanceId = `quickstart-${randomUUID().slice(0, 8)}`;
await client.agents.createAgent({ agentInstanceId });
try {
  // Store a memory. The platform embeds rawContent for you.
  await client.memory.commitMemory({
    agentInstanceId,
    vectors: [
      {
        chunkId: "pref-1",
        rawContent: "The customer prefers invoices in Japanese yen, sent on the 5th.",
      },
    ],
  });

  // Recall it by meaning, not by keyword.
  const { semantic } = await client.memory.queryMemory({
    agentInstanceId,
    semantic: { queryText: "what currency does the customer want to be billed in?", limit: 3 },
  });
  for (const m of semantic?.matches ?? []) {
    console.log(`${m.distance.toFixed(3)}  ${m.rawContent}`);
  }
} finally {
  await client.agents.deleteAgent({ agentInstanceId });
  client.close();
}
```

```
0.235  The customer prefers invoices in Japanese yen, sent on the 5th.
```

## Every operation, already authenticated

Each service in the API is a client property, already bound to the credentialed
connection, so every operation is callable directly:

```ts
await client.scopes.listScopes({});
await client.memory.inspectMemory({ agentInstanceId });
await client.datasets.listDatasets({});
```

The services are `agents`, `memory`, `scopes`, `datasets`, `schema`, `data`,
`auth`, `approvals`, `billing` and `platform`. For a service added after your
SDK version, `client.service(SomeService)` binds it the same way. Never build
your own transport to reach one: you would lose credential renewal.

Requests are plain objects, and the types check them. The message types
themselves live in the generated modules, for example:

```ts
import type { SemanticMatch } from "jennah-sdk-ts/gen/jennah/agent/v1/memory_pb";
```

Every call takes an options object as its second argument, with `timeoutMs`
and `signal` (an `AbortSignal`).

## Errors

A call rejects with a `ConnectError` carrying the platform's status. `code(err)`
reads it, including from the SDK's own errors, which keep the platform's
rejection as their `cause`:

```ts
import { Code, code } from "jennah-sdk-ts";

try {
  await client.agents.getAgent({ agentInstanceId: "no-such-agent" });
} catch (err) {
  if (code(err) === Code.NotFound) {
    // ...
  }
}
```

The SDK's own errors are `NoCredentialError`, `CorruptSessionError`,
`SessionExpiredError`, `CredentialRefusedError` and `SessionPersistError`.
`isUnauthenticated(err)` and `isTransient(err)` cover the two statuses most
callers branch on.

Calls that are safe to repeat are retried automatically after an `Unavailable`
answer: reads, and writes the request proves idempotent (for example a
`commitData` with an `idempotencyKey`). Nothing else is retried. Pass
`retry: { disabled: true }` or your own `maxAttempts` to change that.

## Credentials

The client takes the first credential it finds, in this order:

1. `credentials`, a source your program supplies.
2. `apiKey`.
3. The `JENNAH_API_KEY` environment variable.
4. The session stored by `jnh login`.

A signed-in session renews itself: a rejected call is renewed once and retried,
and the renewed session is written back to the shared credentials file, so `jnh`
on the same machine stays signed in. `client.credential` reports what
authenticated the client, and where it came from, without the secret.

A server acting for many signed-in users shares one connection and presents
each user's own access token:

```ts
import { Client, Connection, StaticSource } from "jennah-sdk-ts";

const connection = new Connection(); // one HTTP/2 connection, reused

function clientFor(accessToken: string): Client {
  return new Client({ connection, credentials: new StaticSource(accessToken) });
}
```

A `StaticSource` token is presented as given and never renewed. Refresh it the
way your server already does.

## Development

The generated code is not committed. With
[jennah-api](https://github.com/alphauslabs/jennah-api) checked out next to this
repository:

```sh
scripts/dev-generate.sh      # generate, and lay the code and conformance suite in place
npm ci
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

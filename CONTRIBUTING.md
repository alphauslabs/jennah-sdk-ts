# Contributing

## Layout

- `src/*.ts`: the hand-written SDK. Flat: `src/gen/` is the only subdirectory,
  and it is generated.
- `src/gen/`, `src/version.ts`, `conformance/`: laid down by jennah-api's
  `release/typescript/assemble.sh` and never committed. Run
  `scripts/dev-generate.sh` (with jennah-api checked out beside this repo) to
  get them locally.
- `test/`: `node:test` suites, compiled to `build/` and run by `npm test`.

## Tests

```bash
scripts/dev-generate.sh
npm ci
npm test
```

`npm test` builds `dist/` first: the browser-refusal tests load the package by
its own name, so they exercise the published `exports` map.

`test/conformance.test.ts` runs the shared credential suite
(`conformance/credentials/cases.json`). A failing case is a defect in this
SDK. Fix the client; never edit the case to accommodate it.

`test/classification.test.ts` fails when an RPC is in none, or more than one,
of the retry classes in `src/retry.ts`, or when a class names an RPC that no
longer exists. A new RPC therefore needs its class decided here before a
release can pass.

## Mutation log

A harness written alongside the client it certifies can share that client's
blind spots. So each behavior the contract requires was broken on purpose, one
at a time, and the tests were run against the broken client. Every mutant
below failed at least one test, and each was reverted. Last run: 2026-09-29.

| Mutant | Caught by |
|---|---|
| Renewal not written back to the stored session | `write-back/rotated-session-is-published`, `write-back/unpersistable-renewal-is-surfaced` |
| Renewal not single-flight | `write-back/concurrent-rejections-renew-once` |
| Renewal call routed through the credential interceptor | the run deadlocks; a per-case timeout plus `--test-force-exit` turn that into a failure |
| Credential captured at construction instead of per call | `per-call/renewed-credential-is-presented-thereafter` |
| Auth retry consults replay safety | `renewal/unsafe-write-renews-and-retries` |
| Pre-renewal re-read of the stored session skipped | `write-back/another-process-renewal-is-adopted-before-renewing` |
| A service left off `Client` | `every generated service is bound on Client` |
| A method dropped from the retry table | `every method is classified exactly once` |
| A nonexistent method added to the retry table | `no classification names a missing method` |
| `CommitMemory` with a log section treated as replayable | `conditional writes are retried only with their replay evidence` |
| Browser entry point no longer throws | `loading the SDK in a browser fails with the reason` |
| `browser` export condition resolves the real SDK | the loading test, and `no credential is used before the refusal` |

Two findings from running it:

- The deadlock mutant hung the whole test process: `node:test` marks a timed-out
  test as failed, but open handles keep the process alive. `--test-force-exit`
  in `npm test` makes the run end.
- The "no credential is used" test first ran its child with `spawnSync`, which
  blocks the event loop the fake server needs. A leaking mutant then hung
  instead of being counted, and the test passed. It now spawns asynchronously.

Rerun the log whenever the credential code changes.

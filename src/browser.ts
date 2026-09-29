/**
 * What a bundler targeting a web browser resolves `jennah-sdk-ts` to. Loading
 * it throws, so the SDK never runs in a page.
 *
 * This is a refusal, not a warning. Any credential a web page holds can be
 * read by the person using the page and by every script it loads, and an API
 * key is long-lived and enterprise-scoped, so an SDK that merely advised
 * against it would still hand out a working credential. A browser also cannot
 * reach the session that `jnh login` stores, which every client on a machine
 * shares.
 *
 * @module
 */

throw new Error(
  "jennah-sdk-ts runs only on a server (Node.js 22.12 or later) and cannot be loaded in a web browser: " +
    "a credential in a web page is readable by its user and by every script on it. " +
    "Call Jennah from your application's own server, and have the page talk to that server.",
);

export {};

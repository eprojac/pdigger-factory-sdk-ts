# Contributing

All four SDKs follow the [same behaviour contract](spec/SDK-DESIGN.md) and [HTTP API](spec/openapi.yaml). The
maintainers sync the specification, fixtures, camera measurements and architecture diagram from the shared project.
Open an issue or pull request here to propose a change to these shared files.

## Setup

```sh
npm ci
npm run check        # types, lint, formatting, tests at 100 % coverage, build, consumer types, API reference
make test            # the same in Docker with no network, as CI runs it
make image-check     # the try-it image: the quickstart against the fake, the viz page's files
```

Run `scripts/smoke.mjs` for the Node 18, Deno and Bun compatibility checks. The
[workflow tests](TESTING.md#workflows) run actionlint in Docker.

Node 20 or newer for the dev tools (the package itself supports Node 18).

## Guidelines

- Async first: promises, async iterables and `AbortSignal`; every stream closes its connection when the caller leaves
  the loop or aborts.
- Keep the core free of runtime dependencies; `three` stays a peer dependency of `/viz` only.
- Every wait goes through the injected `Clock`; tests never sleep for real and never use the network.
- Coverage stays at 100 %. If code truly cannot run in a container, mark it in the source with the reason and list it
  in [TESTING.md](TESTING.md); there is none today.
- Code samples in the docs are regions of `examples/` (`// #region name`), filled with `node scripts/snippets.mjs`;
  the tests run the examples and check the samples.
- Pictures in `docs/img` come from real recordings (`npm run pictures`); say in the docs which recording and frame.
- `fixtures/` and `spec/` are shared by the four languages; do not edit them here: open an issue.
- Formatting is Prettier's (`npm run format`), lint is typescript-eslint's (`npm run lint`).

## Releasing

Use the [release guide](RELEASING.md) to update the two version fields, tag the tested commit and publish the
package.

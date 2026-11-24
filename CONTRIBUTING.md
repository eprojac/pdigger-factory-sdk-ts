# Contributing

Thank you for helping. This SDK is one of four (Go, Python, Rust, TypeScript) that follow one contract,
[spec/SDK-DESIGN.md](spec/SDK-DESIGN.md): behaviour, names, the Interpreter's rules and every sentence it produces are
shared, and the golden files in `fixtures/golden/` hold all four to it. A change of behaviour is made by the maintainers
in all four at once: open an issue or a pull request here.

## Setup

```sh
npm ci
npm run check        # types, lint, formatting, tests at 100 % coverage, build, consumer types, API reference
make test            # the same in Docker with no network, as CI runs it
make image-check     # the try-it image: the quickstart against the fake, the viz page's files
```

Workflows: actionlint in Docker (see [TESTING.md](TESTING.md#workflows)). Runtimes: `scripts/smoke.mjs` on Node 18,
Deno and Bun.

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

1. Update `version` in `package.json` and `src/version.ts`, and `CHANGELOG.md`.
2. Tag `vX.Y.Z` and push the tag. The `release` workflow runs the Docker tests, checks that the tag matches the
   version, publishes to npm with provenance (`npm publish --provenance --access public`, the `NPM_TOKEN` secret of the
   `npm` environment), and creates the GitHub release with the package attached.

# Releasing

Releases are tags `v<version>` on `main`. The version is `"version"` in [package.json](package.json) and `VERSION` in
[src/version.ts](src/version.ts) (the user agent sends it); a unit test checks that the two agree.

1. Check that the site the docs, the examples and the integration workflow link to is live: the Swagger demo at
   https://factory.pdigger.com/developers/api/ and the recordings at https://factory.pdigger.com/developers/data/
   (`curl -fsSI https://factory.pdigger.com/developers/api/ https://factory.pdigger.com/developers/data/recordings.json`).
   Then run the Integration workflow by hand: its recordings job downloads every published recording, checks its
   sha256 and compares its replay with the published summary. Do not release while either fails.
2. Set the version in both places and give `CHANGELOG.md` a section for it (in the commit you tag, the section's
   heading has the release date instead of Unreleased).
3. Merge to `main` and wait for CI.
4. Tag and push: `git tag v<version> && git push origin v<version>`.

[.github/workflows/release.yml](.github/workflows/release.yml) then runs the unit tests in Docker, checks that the tag
is `v` + the package version, builds, publishes the package to npm with provenance, and makes the GitHub release with
the packed tarball.

## What the repository needs

- **An npm token** that may publish `pdigger-factory-sdk` (a granular access token), as the secret `NPM_TOKEN` of the
  GitHub environment `npm`.
- **A GitHub environment `npm`**, ideally with required reviewers, so a tag alone cannot publish.
- **Branch protection** on `main`, with the CI checks required.

The GitHub release uses the workflow's own token.

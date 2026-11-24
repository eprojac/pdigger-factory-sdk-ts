# Releasing

The Git tag triggers an npm publish and a GitHub release.

1. Check that the [API demo](https://factory.pdigger.com/developers/api/) and
   [recording downloads](https://factory.pdigger.com/developers/data/) are available. Run the Integration workflow
   manually. It downloads the recordings, verifies their SHA-256 checksums and compares the replay summaries.
   Continue when both checks pass.

2. Set the same version in [package.json](package.json) and [src/version.ts](src/version.ts). Replace `Unreleased`
   in the changelog heading with the release date.

3. Merge to `main` and wait for CI to pass.
4. Tag the tested commit with `v` followed by the version, then push that tag. For version 0.1.0, run
   `git tag v0.1.0` followed by `git push origin v0.1.0`.

The [release workflow](.github/workflows/release.yml) runs the Docker tests, checks the version and publishes the
npm package with provenance. It attaches the packed tarball to the GitHub release.

## What the repository needs

- Give the `npm` GitHub environment a granular `NPM_TOKEN` that can publish `pdigger-factory-sdk`. Required
  environment reviewers can review each publish.
- Protect `main` with the CI checks required for release.
- The GitHub release uses the workflow’s own token.

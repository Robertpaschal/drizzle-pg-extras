# Releasing

Releases are published to npm by `.github/workflows/release.yml` when a
version tag is pushed. The workflow uses npm trusted publishing (OIDC), so no
npm token is stored on a machine or in repository secrets, and every release
carries a provenance statement linking it to the commit and workflow run.

## One-time setup

On npmjs.com, open the `drizzle-pg-extras` package settings and add a trusted
publisher:

- Provider: GitHub Actions
- Organization or user: `Robertpaschal`
- Repository: `drizzle-pg-extras`
- Workflow filename: `release.yml`
- Environment: leave empty

Until this is set, the publish step fails with an authentication error and
nothing is published. After the first release goes out through the workflow,
revoke any granular publish token used before.

## Cutting a release

1. Bump `version` in `package.json` and add the `CHANGELOG.md` entry, then
   merge to `main` with CI green.
2. Tag the merge commit and push the tag:

   ```sh
   git tag v0.6.4
   git push origin v0.6.4
   ```

3. The workflow checks that the tag matches `package.json`, runs typecheck,
   lint and the test suite against Postgres 16, builds, and publishes.
4. Confirm with `npm view drizzle-pg-extras version` and create the GitHub
   release from the tag.

## Limits

- The release job runs the Postgres suite only. The TimescaleDB and Drizzle 1.0
  jobs run in CI on every push, so make sure CI on `main` is green before
  tagging.
- Trusted publishing needs npm 11.5.1 or later, which the workflow installs.

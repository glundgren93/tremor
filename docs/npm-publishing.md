# npm publishing

Tremor publishes tagged releases to npm and GitHub from `.github/workflows/release.yml`.
The workflow publishes the exact tarball validated by the release job, verifies the registry
integrity and provenance, then makes the prepared GitHub Release public.

## One-time registry bootstrap

npm requires a package to exist before a trusted publisher can be configured. Bootstrap the
package once from the existing checksum-attested GitHub Release:

```sh
npm login

work=$(mktemp -d)
gh release download v0.2.0 \
  --pattern tremor.tgz \
  --pattern tremor.tgz.sha256 \
  --dir "$work"
(cd "$work" && shasum -a 256 -c tremor.tgz.sha256)
npm publish "$work/tremor.tgz" --access public
```

Publishing requires an npm account that owns the `@glundgren93` scope and has account-level 2FA
enabled. The bootstrap version will not have GitHub provenance because it predates trusted
publishing; subsequent workflow publications must have provenance.

After the package exists, configure its npm trusted publisher:

- provider: **GitHub Actions**
- organization or user: **glundgren93**
- repository: **tremor**
- workflow filename: **release.yml**
- environment: leave empty
- allowed action: **npm publish**

The equivalent CLI command requires npm 11.15.0 or newer. It can be run without replacing the system npm:

```sh
npx --yes npm@11.19.0 trust github @glundgren93/tremor \
  --repo glundgren93/tremor \
  --file release.yml \
  --allow-publish \
  --yes
```

Once one tagged release has succeeded through OIDC, set npm package publishing access to
**Require two-factor authentication and disallow tokens**, then revoke any obsolete publish
tokens.

## Security model

- GitHub Actions receives no `NPM_TOKEN`. npm exchanges the job's short-lived OIDC identity for
  permission bound to this repository and `release.yml`.
- Only the `publish` job receives `id-token: write`; its other permission is the `contents: write`
  needed to manage the GitHub Release.
- Every action in the release workflow is pinned to a full commit SHA, and checkout credentials
  are not persisted into later steps.
- The build job validates a clean version-coordinated tag reachable from `main`, tests the browser
  package, and uploads one checksum-attested tarball.
- The publish job downloads that exact artifact, keeps the GitHub Release in draft, publishes the
  tarball, and verifies registry integrity and SLSA provenance before making the release public.
- Active GitHub rulesets allow only repository administrators to create `v*` tags and prevent
  release tags from being moved or deleted after creation.

## Normal release

1. Coordinate `package.json`, `src/version.ts`, and `release.json` for the new version.
2. Merge the release commit to `main` after CI succeeds.
3. From an up-to-date clean `main`, create and push the matching tag:

   ```sh
   git switch main
   git pull --ff-only
   test -z "$(git status --porcelain)"
   version=$(node -p "require('./package.json').version")
   git tag "v$version"
   git push origin "v$version"
   ```

4. Confirm the release workflow verifies source, browser behavior, package installation,
   upgrade behavior, checksums, npm integrity/provenance, and the draft GitHub assets.
5. Confirm both the npm package version and GitHub Release are public.
6. Verify the installed registry package independently:

   ```sh
   version=$(node -p "require('./package.json').version")
   npm view "@glundgren93/tremor@$version" dist.integrity \
     dist.attestations.provenance.predicateType
   npx --yes "@glundgren93/tremor@$version" --version
   ```

Never publish a locally rebuilt tarball for a normal release. The workflow intentionally reuses
the validated artifact from `build-and-validate` for both registries.

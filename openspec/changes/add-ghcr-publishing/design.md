# Design

## Context

See `proposal.md` for motivation and `specs/container-publishing/spec.md` for the behavior contract.

- The GitHub origin is `nikhcevov/order-manager-for-wife`. There is no `.github` workflow directory yet and no durable publishing capability among the five existing main specs.
- `Dockerfile` already builds both TypeScript workspaces using Node 24 and the lockfile, prunes development dependencies, includes SQL migrations and the built frontend, and runs as non-root UID 1000. Reuse it rather than add another image definition.
- Root `npm run typecheck` and `npm test` are existing gates. The behavior harness requires `TEST_DATABASE_URL`, creates isolated schemas, and uses synthetic Telegram identities and temporary media. It does not require real bot credentials.
- `compose.production.yaml` currently builds a local image, loads `.env`, publishes only `127.0.0.1:4893`, and uses PostgreSQL 18 with `${APP_DATA_DIR}/postgres18` plus persistent media. Host-network Caddy targets that loopback port.
- `.dockerignore` excludes `.env`, `.env.*`, `var`, `.git`, `.omp`, and OpenSpec artifacts. Keep these exclusions; the Dockerfile copies only the application's packaging inputs.

## Goals / Non-Goals

**Goals:**
- Publish the exact runnable artifact verified in CI, with explicit source and registry references.
- Keep publication access scoped to GitHub/GHCR, independent of Unraid and shop credentials.
- Switch production image selection without changing application code or persistent storage.

**Non-Goals:**
- Server deployment, automatic updates, SSH, webhooks, update watchers, or self-hosted runners.
- New payment/order behavior, database upgrades, registry retention/deletion, vulnerability dashboards, or multi-platform builds.
- Automatic latest-tag promotion, semantic-version alias expansion, or changing package visibility to public.

## Decisions

### 1. One GitHub-hosted publication workflow

Create `.github/workflows/publish-image.yaml`, triggered by `push` to `main` and all Git tag pushes. Skip deleted-reference events. Use a GitHub-hosted Linux runner and Node 24. Pin reusable actions to full commit SHAs and disable persisted checkout credentials; pass event strings through environment variables rather than interpolating untrusted tag names into shell source.

Use one job for verification, image build, smoke, and publication so the tested local image remains available to the publishing steps. Split verify/publish jobs would require transferring or rebuilding the image, adding complexity without benefit for this single-platform shop.

### 2. Exact source, tag rules, and ordering

Check out the event's source, then derive the full commit from `git rev-parse HEAD`. This avoids confusing an annotated tag object with its application commit. Lower-case `github.repository` for the GHCR namespace; do not hardcode the current owner into the workflow.

References:
- Main: `ghcr.io/<lower-case-repository>:main` and `:sha-<full-commit>`.
- Git tags: their exact tag and `:sha-<full-commit>`; no update to `main` or unrelated aliases.
- Tag names must match Docker's tag grammar, including its 128-character limit. Reject `main`, names starting with `sha-`, and unsupported names rather than sanitize them into collision-prone references.

Serialize publication jobs for this repository using a fixed workflow-specific concurrency group, `cancel-in-progress: false`, and `queue: max`. This keeps distinct queued release tags instead of replacing one pending run with another. GitHub queues are finite and dispatch order alone is not a freshness guarantee; immediately before publication, compare the checked-out commit with the current branch/tag target, peeling annotated tag objects when necessary. A deleted or superseded ref skips publication. A lookup/authentication failure fails the run rather than treating freshness as established.

The shared concurrency group prevents an older run from finishing a channel update after a newer delivered run. A push arriving after the eligibility check may temporarily leave the last verified image selected until the new run passes; no claim is made that an unverified branch head is already delivered.

Use OCI source and revision labels on the build. Commit tags are traceability references, not a guarantee of reproducible byte-identical rebuilds; exact image pinning uses registry digests.

### 3. Reuse gates and smoke the same image that is pushed

Order the job as follows:
1. Resolve and validate the event and image references.
2. `npm ci`, then `npm run typecheck` and `npm test`, with an isolated PostgreSQL 18 service and `TEST_DATABASE_URL` supplied for CI only.
3. Build the existing Dockerfile for `linux/amd64`, assigning a local candidate tag and the source labels. The Dockerfile's existing `npm run build` supplies production compilation.
4. Run the candidate's actual container entrypoint with a temporary writable media directory, the isolated database, and synthetic bot/seller settings. On the Linux runner, host networking can reach the runner-bound test database; exercise `/api/health` and the built frontend on port 4893 with bounded startup waits. Inspect runtime configuration and image files/layers to confirm a canary runtime secret is not incorporated.
5. Check current-ref eligibility, authenticate to GHCR, retag that same local image, push its full-commit reference, and finally push the event's delivery reference. Do not perform another build after the smoke.

Registry writes across multiple tags are not transactional. If a later transfer fails, a verified commit reference may exist without a completed delivery-tag update; the run reports failure. Gates failing before publication produce no registry writes. Existing behavior tests remain the application regression suite; do not add source-text or forwarding tests for workflow wiring.

### 4. Workflow token and package access

Use `contents: read` and `packages: write`; supply `GITHUB_TOKEN` only to steps needing authenticated API/registry access and use password-stdin or a pinned registry-login action. Real `BOT_TOKEN`, database passwords, and Unraid access credentials are not GitHub secrets for this workflow. No production environment file enters the build as a copy, build argument, or artifact.

Publishing with the workflow token and a source label links the package to the repository. If an existing package has incompatible access settings, fix its repository access rather than silently fall back to a broad personal token. Keep initial/default visibility private or preserve existing visibility; do not change it in CI. Public packages allow anonymous pulls; private Unraid pulls require an authorized classic PAT with `read:packages` stored in Docker's credential configuration, not committed in Compose or the environment example.

The GitHub contracts are documented in [GHCR authentication and package visibility](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry) and [concurrency and queued jobs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

### 5. Published-image production consumption

Replace the app's local image/build block in production Compose with `image: ${APP_IMAGE:?Set APP_IMAGE to the published application image}`. Remove `build`; keep all other runtime settings, health checks, port bindings, dependencies, and mounts unchanged. Do not alter local development Compose or Dockerfile runtime defaults.

Add `APP_IMAGE=ghcr.io/nikhcevov/order-manager-for-wife:main` to `.env.production.example`. Operators can instead choose a release tag or `ghcr.io/nikhcevov/order-manager-for-wife@sha256:<digest>`. No real `.env` values are rewritten by this change.

Document initial pulling and deliberate updates:

```sh
docker compose -f compose.production.yaml pull app && \
  docker compose -f compose.production.yaml up -d --no-build --wait
```

For app-only updates on an already healthy stack, use `up -d --no-deps --no-build --wait app` after pulling, so publishing an app does not update PostgreSQL. Remove obsolete `--build` instructions from production deployment and the app-start step of the existing PostgreSQL migration guide, but preserve that guide's data-safety procedure.

## Risks / Trade-offs

- Registry or package permissions unavailable -> fail publication/pull clearly; document GitHub repository package access and private pull authentication. Never substitute an unselected image.
- Actions concurrency queues are limited -> canceled runs are visible and can be rerun if the ref remains eligible; there is no custom durable publication queue.
- A Git tag is force-updated -> the corresponding delivery reference is mutable by explicit request; retain source labels and digests for exact identification. Deleted tags do not delete images.
- Mutable main or commit tags are used for rollback -> recommend a recorded digest; image rollback alone cannot reverse an incompatible future database migration.
- CI only targets amd64 -> matches current Unraid assumptions; arm64 needs separately verified artifacts, not an untested extra platform entry.
- Live Actions/GHCR cannot be proven with YAML validation alone -> implementation must record authorized real main/tag run and pull evidence, or report the exact remaining repository/authentication prerequisite.

## Migration Plan

1. Implement and validate the workflow without changing shop runtime credentials or current containers. Complete a successful main publication and a Git-tag publication before relying on the registry.
2. Update production Compose, environment example, and README as one cutover; remove local-build production paths and never introduce a fallback build.
3. On Unraid, configure `APP_IMAGE`, authenticate only if needed, pull the chosen image, and manually recreate the app. Verify health, Telegram/order access, and protected media without modifying data directories or upgrading PostgreSQL.
4. Record the previous image digest before future updates. For compatible image rollback, select that digest and manually pull/recreate only the app, retaining the database and media. If registry consumption itself must be rolled back before accepting an update, restore the prior Compose configuration with its known local image and unchanged mounts; no data deletion is part of rollback.

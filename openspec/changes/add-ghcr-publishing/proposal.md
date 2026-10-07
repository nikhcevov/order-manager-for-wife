# Proposal

## Why

Production currently builds the application locally on Unraid, so delivering an update requires source checkout and a server-side build. Automatically publishing verified images to GHCR on main-branch and Git-tag pushes will make releases available without giving GitHub access to the running shop.

## What Changes

- Add GitHub Actions publication of the existing production Docker image on pushes to `main` and Git tag creation or updates.
- Publish under `ghcr.io/nikhcevov/order-manager-for-wife`, deriving the lower-case namespace from the executing GitHub repository. Successful main builds update `main`; valid Git tags publish their matching image tags; every publication includes a full-commit `sha-<commit>` reference.
- Require the existing typecheck and PostgreSQL-backed behavior suite, successful image build, and a runnable-container smoke check before pushing any delivery tag.
- Authenticate publication with the workflow's repository-scoped GitHub token; keep real shop credentials and data out of CI, image layers, and logs.
- **BREAKING deployment configuration:** production Compose will pull the explicitly configured `APP_IMAGE` instead of building a local `telegram-order-manager:production` image. Document GHCR access, manual pull/recreation, and digest-based image selection while preserving port 4893, host-network Caddy, PostgreSQL 18, and persistent media/data paths.
- Publication only: no SSH, deployment webhook, self-hosted Unraid runner, update watcher, automatic container restart, database upgrade, or change to customer/order behavior.

## Capabilities

### New Capabilities

- `container-publishing`: Verified event-driven publication, predictable image references, credential-safe registry access, and manual consumption of published production images.

### Modified Capabilities

None. Existing Telegram access, catalog, order, payment, and fulfillment requirements are unchanged.

## Impact

- New `.github/workflows/publish-image.yaml`; reuse `Dockerfile`, `package-lock.json`, root npm verification commands, and `apps/api/test` without introducing another application packaging convention.
- Update `compose.production.yaml`, `.env.production.example`, and `README.md` during implementation to consume GHCR images and describe manual updates. Local development Compose and npm startup remain unchanged.
- GitHub Actions runners and GHCR become publication dependencies. CI uses an isolated PostgreSQL 18 database and synthetic configuration, not the production bot token or database.
- Initial image platform is `linux/amd64`, matching the intended x86-64 Unraid deployment. Package visibility follows GitHub's existing/default policy; private pulls require authorized read access, not automatic public exposure.
- Existing Unraid containers do not change when a new image is published. The operator chooses when to pull and recreate the app; persistent data is neither removed nor migrated by image publication.

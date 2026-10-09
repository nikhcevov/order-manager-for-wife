# Telegram order manager

A single-shop React Telegram Mini App with a Node/Fastify API, PostgreSQL inventory commitments, manual payment review, and automatic fulfillment packages with a seller-chosen delivery or in-person handover.

## Local setup

Requires Node.js 24+, npm, Docker Compose, and a Telegram bot for real Mini App use.

1. Copy `.env.example` to `.env` and supply your own values. `.env` is ignored by Git and excluded from container builds.
2. Set a local PostgreSQL password and the matching `DATABASE_URL`, your BotFather token, numeric `SELLER_IDS`, three-letter shop currency, manual payment instructions, and public origin.
3. Install and start:

```sh
SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm ci
docker compose up -d --wait db
npm run migrate
npm run dev
```

Vite serves `http://localhost:5173` and proxies `/api` to the Node service on port 3000. `GET /api/health` returns `{ "ok": true }`. Development requires valid runtime configuration too; there is no password, username-based admin grant, or development-login bypass. Opening outside Telegram displays launch instructions rather than a fake authenticated shop.

`SHARP_IGNORE_GLOBAL_LIBVIPS=1` selects the bundled image decoder on machines that already have libvips installed. The service decodes uploaded images instead of trusting extensions.

## Runtime configuration

| Variable | Meaning |
|---|---|
| `POSTGRES_PASSWORD` | Password for the local Compose database |
| `DATABASE_URL` | PostgreSQL connection URL; point separately at your deployed database |
| `BOT_TOKEN` | Backend-only BotFather token; never put it in frontend settings |
| `SELLER_IDS` | Comma-separated numeric Telegram user IDs |
| `SHOP_CURRENCY` | One shop currency, such as USD, EUR, or RUB; prices use integer minor units |
| `PAYMENT_INSTRUCTIONS` | Instructions customers follow outside the app |
| `PUBLIC_ORIGIN` | HTTPS frontend origin; HTTP localhost is permitted for local development |
| `MEDIA_DIR` | Persistent image directory; the template path is relative to the API workspace |
| `HOLD_MINUTES` | Unpaid hold duration; proposed default 30 minutes, maximum 1440 |
| `HOST`, `PORT` | API listen address and port |

The service fails startup for invalid or missing required configuration. It applies pending versioned SQL migrations before accepting orders. PostgreSQL data persists in the Compose volume; media must also remain on persistent storage.

## Telegram setup

Create a bot in BotFather and configure its Main Mini App or menu button to open your HTTPS app URL. The web app sends Telegram's signed `initData` to the backend; the backend validates the signature, user, and one-hour launch freshness before creating a 24-hour session. Sessions remain in browser memory, not URLs or local storage. Reopen the Mini App when authentication expires.

The interface language follows the Telegram client's language for the launching user, read before the first render and never stored. `ru` and its regional variants, `uk`, `be`, `kk`, `ky`, `uz`, and `tg` present Russian; every other value, and a missing value, present English. There is no language selector and no saved preference: changing the Telegram client language changes the interface on the next launch. Amounts and dates are formatted for the presented language, and the document language follows it.

Configure your wife's numeric Telegram ID in `SELLER_IDS`. Usernames and display names do not grant permissions. There is no need for a conversational bot, automatic channel posting, or payment/carrier integration.

Real Telegram verification requires a real BotFather token, an HTTPS URL reachable from the Telegram client, and access to that client. Locally generated signed fixtures exercise server cryptography and browser flows but do not prove those external prerequisites. Replace any ignored local verification credentials before connecting a real bot.

## Seller workflow

1. Open **Manage → Products → Create a new product**. Add a name, images, a price, remaining unsold stock, and an optional comment.
2. **Save private draft**. Customers cannot see the draft or retrieve its images.
3. Select ready drafts and **Publish selected drafts**. A batch publishes atomically.
4. Edit live products when needed. Existing accepted order names and prices remain in history. Stock excludes bought units but includes reserved units; reducing it below current reservations is rejected.

Products accept 1–20 images. Supported uploads are single-frame JPEG, PNG, and WebP, at most 10 MiB, 8192 pixels per side, and 25 megapixels. Failed uploads do not create usable attachments. Unreferenced uploads become cleanup candidates after 24 hours. Published product images are public; draft images and payment evidence are authorization-protected.

## Customer orders and payment

Browse products, choose quantities, and add to cart. **A cart does not reserve stock.** In the cart, **Review current prices → Accept prices & reserve order**. The order joins your current package automatically; the seller chooses delivery or in-person handover when shipping.

Confirmation holds every requested item together or rejects the whole selection. Two customers cannot acquire the same final unit. A repeated submission reuses its order rather than purchasing twice. Conflicts retain the customer's selection and explain what changed.

Before submitting payment evidence, customers can **Edit unpaid order** to add/remove/replace items or **Cancel order**. Retained quantities keep accepted prices; additions use current prices. Successful edits retain the original deadline. A failed replacement leaves the entire previous order intact.

Pay outside the app using the displayed instructions and order reference. Upload screenshots, inspect them, then explicitly **Submit evidence for review** before the deadline. Uploading alone is not submission. At or after the deadline, submission cannot revive an expired reservation.

Evidence submitted in time keeps items reserved **until the seller reviews them**, even past the original deadline or after a service restart. In **Manage → Payments**, inspect the private screenshot and check the external account before **Confirm payment received**. A screenshot never verifies a bank transfer automatically. Confirmation marks items bought, not delivered.

**Reject payment & release items** requires a reason, releases holds once, and preserves the evidence/history. Rejection is final for that order; the customer can place a new order against current stock.

## Changes after payment submission

Direct editing stops after evidence is submitted. Before shipment, use **Request an item change** to propose additions, removal, or replacement. A request does not reserve replacement stock or change accepted items. It blocks shipping until approved, rejected, or withdrawn.

In **Manage → Requests**, compare the old selection, requested selection, current prices, and availability. For a nonzero difference, settle the additional payment or refund externally and enter the settlement note before approval. The app records the decision; it does not move money.

Approval checks stock again and applies the correction atomically. Prior revisions, original screenshots, and payment decisions remain visible. Unavailable replacements or unaccepted price changes leave the original purchase unchanged. Full removal records the external refund and a zero-item current revision rather than deleting history.

For another purchase, create a separate order; it joins the same open package automatically. Each order keeps its own reference and payment evidence, while the seller can ship them together.

## Delivery or in-person handover

Your paid orders form one open package per customer automatically — there is no group to create or choose. A new order joins the current package until the seller ships it; the next order after shipment starts a new package. Each order keeps its own reference and payment.

An open package carries one optional shared delivery code. Either the customer or the seller may set or replace it while the package is open; it is consumed by the shipment, so the next package starts without one. Missing codes do not affect payment status.

In **Manage → Shipments**, the paid shipment contents combine paid purchases while unpaid and review-held orders are listed separately. **Ship all paid** completes the shipment in one action, records the seller's chosen method, and moves remaining nonpaid orders to a new open package without cancelling their holds. Pending item-change requests block shipping.

Shipping as delivery records the delivery code; without one, the seller confirms a warning. Shipping as in-person handover never asks for a code and discards any stored one. Shipping does not charge customers or decrease stock again. Shipped packages are read-only history; later purchases start a new package.

## Verification

Use a separate test database. The behavior suite creates a private schema and temporary media directory and never truncates production/public tables:

```sh
docker compose exec -T db createdb -U shop shop_test
TEST_DATABASE_URL='postgresql://shop:your-local-password@127.0.0.1:55432/shop_test' npm test
npm run typecheck
npm run build
npm audit
```

The PostgreSQL-backed suite covers authorization/media privacy, publication, stock contention, idempotency, expiry races, price-preserving edits, manual review, paid corrections, and fulfillment. Browser verification must additionally exercise the actual screens. Signed local fixtures are not a substitute for a real Telegram launch.

The root `shell-quote` override patches a transitive development-launcher dependency. Keep it until the upstream dependency selects a safe version.

### Verified GHCR publication

`.github/workflows/publish-image.yaml` publishes on pushes to `main` and stable Git release tags matching the root package version, or a manual Actions **Run workflow** for those same eligible refs, not other branches or deleted refs. It follows the stable release policy of [obsidian-livesync-publisher](https://github.com/nikhcevov/obsidian-livesync-publisher) and publishes for `linux/amd64` under the lower-case executing repository namespace; for this repository:

| Selection | Reference |
|---|---|
| Latest verified main channel | `ghcr.io/nikhcevov/order-manager-for-wife:latest` or `:main` |
| Stable release (initial release) | `ghcr.io/nikhcevov/order-manager-for-wife:0.2.0` |
| Minor / major release channel | `ghcr.io/nikhcevov/order-manager-for-wife:0.2` or `:0` |
| Full source commit | `ghcr.io/nikhcevov/order-manager-for-wife:sha-` followed by all 40 commit hexadecimal characters |
| Exact registry artifact | `ghcr.io/nikhcevov/order-manager-for-wife@sha256:` followed by the recorded 64-character digest |

Root `package.json` is the single authoritative application version, initially `0.2.0`; workspace versions remain private/internal. Only stable `MAJOR.MINOR.PATCH` versions are supported, without prerelease or build metadata. Ordinary verified main pushes publish `main`, `latest`, and the full-commit reference without incrementing the version. A main push whose root version differs from its first parent (including the initial addition of the version) also publishes unprefixed `X.Y.Z`, `X.Y`, and `X` image aliases. A manual Git tag push must be exactly `vX.Y.Z` matching that commit's root package version; it publishes those version aliases and the full-commit reference, never `latest` or `main`. Unsupported or mismatched tags fail before registry writes. Commit tags provide source traceability but can be rebuilt; use a digest to pin exact image bytes. OCI source/version/revision labels identify the repository, root version, and checked-out commit, including the peeled commit of an annotated Git tag.

One fixed repository-specific concurrency group uses `queue: max` and `cancel-in-progress: false` to serialize delivery while retaining distinct pending releases. Immediately before publishing, an authenticated current-ref check skips deleted or superseded refs; lookup/authentication errors fail closed. GitHub's queue is finite, and a canceled run can be rerun if its ref remains current. A newer push after that check remains undelivered until it passes verification. Deleted Git tags do not delete published images.

CI uses Node 24 and isolated PostgreSQL 18, runs `npm ci`, `npm run typecheck`, and `npm test` (the PostgreSQL-backed suite in `apps/api/test` and release-policy regressions in `scripts/test`), then builds the existing Dockerfile and smokes its actual entrypoint. Smoke checks bounded API health and built frontend startup on port 4893, migrations, UID 1000, and exclusion of canary runtime secrets/data from image files and layers. Only afterward does CI authenticate and push the **same tested local image**, full-commit tag first and delivery aliases afterward, with no second build. Failed gates write nothing to the registry and create no release tag or GitHub Release; a later transfer failure can leave some verified references without completing all aliases.

Only after the full-commit reference and **all** release delivery aliases have been pushed successfully, CI creates an annotated Git tag `vX.Y.Z` at the exact source commit and a GitHub Release with generated notes. The release body records the version image reference and first successful exact image digest. An existing release tag pointing at another commit fails before image publication; a matching tag and existing release are retry-safe and are not duplicated or rewritten, preserving their generated notes and recorded digest. Tags created with `GITHUB_TOKEN` do not trigger another workflow run: the main run performs all image, tag, and release work.

#### Preparing a release

Bump the root package version manually in a **separate release commit**, not automatically for each feature commit. From the repository root, choose one command:

```sh
npm version patch --no-git-tag-version
# Or: npm version minor --no-git-tag-version
# Or: npm version major --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore(release): bump version to X.Y.Z"
```

Push that release commit through the normal main workflow. The initial `0.2.0` version addition qualifies as the first release. Do not create a Git tag as part of the npm bump; CI creates it only after verification and image publication. For a deliberate manual tag publication, use only `vX.Y.Z` matching the root version at its target commit; it does not advance the main/latest channel.

To retry publication, rerun the existing Actions run or use Actions **Run workflow**, selecting current `main` or a matching stable `vX.Y.Z` ref. Manual runs use the same version checks, verification gates, and authenticated current-ref eligibility as pushes. Pushing an already-present unchanged Git tag alone creates no event.

For a reproducible local CI-style smoke on Linux with Docker and Node 24, use an isolated database, not `.env` or the shop database. Ensure port 4893 is free. The helper supplies synthetic bot/seller settings and temporary writable media, uses host networking, and cleans up its container/media:

```sh
(
  set -eu
  db="order-manager-ci-db-$$"
  candidate="order-manager-ci:smoke-$$"
  cleanup() { docker rm -f "$db" >/dev/null 2>&1 || true; docker image rm "$candidate" >/dev/null 2>&1 || true; }
  trap cleanup EXIT
  docker run -d --name "$db" \
    -e POSTGRES_USER=shop -e POSTGRES_PASSWORD=ci-only-password -e POSTGRES_DB=shop_test \
    -p 127.0.0.1:55433:5432 \
    --health-cmd='pg_isready -U shop -d shop_test' \
    --health-interval=1s --health-timeout=5s --health-retries=60 \
    postgres:18-alpine
  ready=false
  for attempt in $(seq 1 60); do
    if [ "$(docker inspect --format '{{.State.Health.Status}}' "$db")" = healthy ]; then
      ready=true
      break
    fi
    sleep 1
  done
  [ "$ready" = true ]
  export TEST_DATABASE_URL='postgresql://shop:ci-only-password@127.0.0.1:55433/shop_test'
  SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm ci
  npm run typecheck
  npm test
  docker build --platform linux/amd64 \
    --label org.opencontainers.image.source=https://github.com/nikhcevov/order-manager-for-wife \
    --label "org.opencontainers.image.revision=$(git rev-parse HEAD)" \
    --label "org.opencontainers.image.version=$(node -p "require('./package.json').version")" \
    -t "$candidate" .
  SMOKE_IMAGE="$candidate" node scripts/smoke-image.mjs
)
```

This requires no real Telegram token or Unraid credentials. Synthetic smoke does not prove a real Telegram launch. Publication is **not deployment**: there is no SSH, webhook, Unraid runner, watcher, automatic restart, database upgrade, or production-data access.

#### Registry permissions and private pulls

Only the publishing job receives `contents: write` and `packages: write`, for release tags/GitHub Releases and GHCR respectively. These job-scoped permissions cover its verification, build, and publication steps; they are not per-step permission isolation. Checkout credentials are not persisted, and repository-scoped `GITHUB_TOKEN` is explicitly supplied in the environment only to authenticated API/login steps. The workflow token and OCI source label link the GHCR package to this repository. If publishing fails on permissions, check repository Actions policy and the package's repository access/Actions access; fix that linkage instead of substituting a broad PAT. Never supply shop bot tokens, database passwords, or Unraid access as publishing secrets or Docker build arguments.

Initial GHCR packages default to private; existing visibility is preserved, and CI never makes them public. Public packages permit anonymous pulls. Private pulls require an authorized **classic PAT** with `read:packages`, access to the package, and any required organization SSO authorization. On Unraid, enter your GitHub username and token interactively, without placing the token in `.env`, Compose, command history, or committed files:

```sh
read -r -p 'GitHub username: ' GHCR_USER
read -r -s -p 'Classic PAT (read:packages): ' GHCR_PAT
printf '\n'
printf '%s' "$GHCR_PAT" | docker login ghcr.io --username "$GHCR_USER" --password-stdin
unset GHCR_PAT GHCR_USER
```

Docker stores login credentials in its credential configuration; use a credential helper and protect that configuration. See [GitHub's GHCR authentication and package access guidance](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

## Production deployment

`npm run build` builds both workspaces; `npm start` runs the compiled API, applies migrations, and serves the built React app from the same origin. Put an HTTPS reverse proxy in front of it and set `PUBLIC_ORIGIN` accordingly. When exposing the Node service in a container, set `HOST=0.0.0.0`.

### Unraid / production Compose

`compose.production.yaml` pulls the explicitly selected `APP_IMAGE` and runs the existing non-root application image with PostgreSQL 18; it never builds application source or falls back to a local image. Missing or empty `APP_IMAGE` is a Compose configuration error. It uses a separate project from local development, persistent host directories, health checks, and restart policies. Use this file on its own, **not** as an override layered on `compose.yaml`; the development file publishes a database port.

Both services load their container settings from `.env` beside the Compose file. Use `.env.production.example` as the complete production template; for an existing deployment, update your existing `.env` without overwriting its credentials. In particular:

```dotenv
APP_IMAGE=ghcr.io/nikhcevov/order-manager-for-wife:latest
APP_DATA_DIR=/mnt/cache/appdata/order-manager
NODE_ENV=production
HOST=0.0.0.0
PORT=4893
MEDIA_DIR=/app/var/media
POSTGRES_USER=shop
POSTGRES_DB=shop
POSTGRES_PASSWORD=your-strong-database-password
DATABASE_URL=postgresql://shop:YOUR_URL_ENCODED_PASSWORD@db:5432/shop
PUBLIC_ORIGIN=https://shop.your-domain.com
```

Keep the Telegram token, seller IDs, currency, payment instructions, and hold duration in the same file. Replace `cache` with your actual Unraid pool name. Use an absolute persistent appdata path. The URL password must match `POSTGRES_PASSWORD`, with reserved characters percent-encoded in the URL only. The development database address (`127.0.0.1:55432`) does not work inside the app container. Single-quote environment values containing literal dollar signs to avoid dotenv interpolation.

Create the directories before startup; missing bind-mount paths deliberately fail rather than creating data in an unintended location:

```sh
mkdir -p /mnt/cache/appdata/order-manager/postgres18 /mnt/cache/appdata/order-manager/media
chown 1000:1000 /mnt/cache/appdata/order-manager/media
chmod 0750 /mnt/cache/appdata/order-manager/media
```

Run the permission commands with sufficient privileges. The app runs as UID/GID `1000:1000` and does not support `PUID`/`PGID` overrides. PostgreSQL initializes its own directory permissions; do not assign its directory to the app's user.

The app publishes **only `127.0.0.1:4893`** on the Unraid host. Caddy running on the host network needs no shared proxy network:

```caddyfile
shop.your-domain.com {
    reverse_proxy 127.0.0.1:4893
}
```

TLS terminates at Caddy. Set `PUBLIC_ORIGIN` and the bot's Mini App/menu-button URL to that same public HTTPS origin. PostgreSQL has no published host port; the app reaches it as `db:5432` on the Compose network.

From the project directory on Unraid:

```sh
docker compose -f compose.production.yaml pull app && \
  docker compose -f compose.production.yaml up -d --no-build --wait
docker compose -f compose.production.yaml ps
docker compose -f compose.production.yaml logs --tail=100 app
```

The container `env_file` is explicitly `.env`; a CLI `--env-file` flag alone does not change which file the containers load. Keep credentials out of source control.

Uploads persist under `${APP_DATA_DIR}/media`. PostgreSQL 18 mounts `${APP_DATA_DIR}/postgres18` at `/var/lib/postgresql`, with database files in its `18/docker` subdirectory, following the [official image storage layout](https://github.com/docker-library/docs/blob/master/postgres/README.md#pgdata). Pulling or recreating containers does not remove these directories. This does not automatically move local development or PostgreSQL 17 data.

#### Deliberate app updates and rollback

Before relying on GHCR, confirm successful authorized main and stable release publication and an isolated pull/start; local smoke alone does not prove live registry access. Choose `APP_IMAGE` in your existing `.env`: `latest`/`main` for the latest verified main commit, `0.2.0` for a release, `0.2` or `0` for moving minor/major release channels, a full `sha-<commit>` reference as described above, or a recorded registry digest for exact bytes. Git release tag `v0.2.0` maps to image tag `0.2.0`, not `v0.2.0`. All updates remain manual, even when a moving alias advances. Never overwrite real credentials with the example template.

Before updating, record the current app's exact image digest in protected operator notes:

```sh
container=$(docker compose -f compose.production.yaml ps -q app)
image_id=$(docker inspect --format '{{.Image}}' "$container")
docker image inspect --format '{{json .RepoDigests}}' "$image_id"
```

Retain a verified database-plus-media backup as well. For an already healthy stack, update only the app after changing `APP_IMAGE`:

```sh
docker compose -f compose.production.yaml pull app && \
  docker compose -f compose.production.yaml up -d --no-deps --no-build --wait app
docker compose -f compose.production.yaml ps
docker compose -f compose.production.yaml logs --tail=100 app
```

The `&&` guard prevents recreation if authentication, image selection, or transfer fails. There is no local-build fallback. The app-only command neither recreates nor upgrades PostgreSQL. Verify health, a real Telegram launch, existing orders, and protected media after the update; publishing alone never runs these server commands.

For a compatible image rollback, set `APP_IMAGE` to the complete previously recorded repository digest reference, then run the same guarded app-only pull/recreate command. Keep `.env`, `${APP_DATA_DIR}/postgres18`, and `${APP_DATA_DIR}/media` unchanged; never reset orders/stock or delete storage to roll back. Image rollback cannot undo incompatible database migrations: consult migration compatibility and restore a consistent database-plus-media backup into an isolated target before any data cutover. If registry consumption itself must be reverted before accepting an update, restore the prior Compose configuration and its known local image with unchanged mounts; that is an explicit operator rollback, not an automatic build fallback.

### Existing PostgreSQL 17 deployments

**Do not upgrade by pointing PostgreSQL 18 at PostgreSQL 17's data files.** The previous `${APP_DATA_DIR}/postgres` directory is deliberately left untouched; PostgreSQL 18 uses the separate `postgres18` directory. If you have existing orders, migrate before starting the new app:

1. While the old PostgreSQL 17 container is still running, stop the app to pause writes, dump the database, and back up `${APP_DATA_DIR}/media`:

   ```sh
   docker compose -f compose.production.yaml stop app
   docker compose -f compose.production.yaml exec -T db pg_dump -U shop -d shop -Fc -f /tmp/shop17.dump
   docker compose -f compose.production.yaml cp db:/tmp/shop17.dump ./shop17.dump
   ```

2. Stop the old stack with `docker compose -f compose.production.yaml down`. Retain its data directory, media, previous Compose/environment configuration, and backups.
3. Create the empty `postgres18` directory, update the production environment, and start **only** the new database:

   ```sh
   docker compose -f compose.production.yaml up -d --wait db
   docker compose -f compose.production.yaml cp ./shop17.dump db:/tmp/shop17.dump
   docker compose -f compose.production.yaml exec -T db pg_restore -U shop -d shop --exit-on-error /tmp/shop17.dump
   ```

4. Start the app only after the restore succeeds, then verify existing order history and protected screenshots:

   ```sh
   docker compose -f compose.production.yaml pull app && \
     docker compose -f compose.production.yaml up -d --no-deps --no-build --wait app
   ```

Restore into a fresh database before the app runs migrations. If restoration fails, keep the app stopped and retry against a fresh PostgreSQL 18 target; never erase the PostgreSQL 17 source to retry. Before accepting new writes, rollback means restoring the prior Compose/environment and using the original PostgreSQL 17 directory and matching media. PostgreSQL 17 cannot open PostgreSQL 18 data files; once new orders are accepted on 18, the old directory alone is no longer an up-to-date rollback.

## Backup and restore

For the local Compose database, pause seller/customer mutations while taking a consistent database-plus-media backup. Replace the example archive paths with your protected backup location:

```sh
docker compose exec -T db pg_dump -U shop -d shop -Fc -f /tmp/shop.dump
docker compose cp db:/tmp/shop.dump ./shop.dump
tar -czf shop-media.tar.gz -C var/media .
```

For a deployed media volume, archive that volume's contents rather than `var/media`. Keep backups encrypted/access-controlled: they include customer identities, delivery codes, and payment screenshots. Back up runtime credentials separately and securely.

For production, use `docker compose -f compose.production.yaml` in the backup and restore database commands, and archive `${APP_DATA_DIR}/media` rather than `var/media`. Do not copy PostgreSQL's live data directory as a substitute for `pg_dump`.

Restore into a separate empty database and media directory first:

```sh
docker compose exec -T db createdb -U shop shop_restore
docker compose cp ./shop.dump db:/tmp/shop-restore.dump
docker compose exec -T db pg_restore -U shop -d shop_restore /tmp/shop-restore.dump
mkdir -p var/restored-media
tar -xzf shop-media.tar.gz -C var/restored-media
```

Point an isolated service at `shop_restore` and the restored media directory, then verify purchase history and protected evidence retrieval before cutover. On rollback, retain the database and media; do not drop purchase tables or reset stock. Image access is authorization-gated, and the application does not log tokens, evidence, or delivery codes.

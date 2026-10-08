# container-publishing Specification

## Purpose

Deliver verified production application images through GHCR with predictable source references, while keeping runtime credentials private and deployment timing under the Unraid operator's control.

## Requirements

### Requirement: Push-driven image publication
The system SHALL initiate application image publication for pushes to the main branch and stable Git release tag creation or updates, and SHALL support manually dispatched runs for those same eligible refs and version policy. Other branch pushes and deleted references SHALL NOT publish or delete images. Automatically created release tags SHALL NOT require a second workflow run.

#### Scenario: Main branch changes
- **WHEN** a commit is pushed to main
- **THEN** a publication run verifies and builds that pushed commit

#### Scenario: Stable Git tag is created or updated
- **WHEN** a Git tag `vX.Y.Z` matching its target commit's root package version is pushed
- **THEN** a publication run verifies and builds the commit identified by that tag event without advancing main or latest

#### Scenario: Operator retries publication
- **WHEN** the operator reruns an Actions run or manually dispatches the workflow for current main or a matching stable release tag
- **THEN** the same verification, version policy, and authenticated current-ref eligibility apply; pushing an already-present unchanged Git tag alone does not create a publication event

#### Scenario: Unrelated branch or deleted reference
- **WHEN** another branch is pushed or a branch or tag is deleted
- **THEN** no application image is published and existing registry references remain unchanged

### Requirement: Predictable image references
The system SHALL use the executing repository's lower-case GHCR namespace. Ordinary main runs SHALL publish main/latest; main releases SHALL also publish unprefixed X.Y.Z, X.Y, and X. Matching tag runs SHALL publish only version aliases. Every publication SHALL include a full sha-prefixed commit reference and repository/version/commit identity.

#### Scenario: Main image is published
- **WHEN** a main publication succeeds for a source commit
- **THEN** the main, latest, and full-commit references identify the same verified image

#### Scenario: Tagged image is published
- **WHEN** a tag publication succeeds for v1.2.3
- **THEN** 1.2.3, 1.2, 1, and its full-commit reference identify the same verified image, and main and latest remain unchanged

#### Scenario: Operator needs exact image bytes
- **WHEN** an operator pins a recorded registry digest
- **THEN** it identifies exact image bytes, unlike moving aliases or rebuildable commit references

### Requirement: Authoritative stable application version
Root package.json SHALL be the sole application version, initially 0.2.0; workspace versions SHALL remain private/internal. Stable MAJOR.MINOR.PATCH SHALL exclude prerelease/build metadata. Releases SHALL use manual root `npm version patch|minor|major --no-git-tag-version` bumps in separate release commits, not automatic feature-commit increments. Main SHALL compare the actual root version with its first parent; an initially absent version SHALL qualify.

#### Scenario: Main version changes
- **WHEN** main introduces 0.2.0 or changes the root version from its first parent
- **THEN** the verified image is published with full, minor, and major version aliases as well as main, latest, and the full-commit reference

#### Scenario: Main version does not change
- **WHEN** main changes application code without changing the root version
- **THEN** publication updates only main, latest, and the full-commit reference and creates no release tag or GitHub Release

### Requirement: Unambiguous stable Git tag handling
The system SHALL accept manual release tags only as vX.Y.Z matching the root package version at the event commit. It SHALL reject unsupported or mismatched tags and malformed or nonstable root versions before registry writes, without sanitizing them into another reference. Before release-image publication, an existing release tag SHALL be resolved through annotated tags and SHALL identify the exact source commit; a tag at another commit SHALL fail without moving or overwriting it.

#### Scenario: Git tag or root version is unsupported
- **WHEN** a pushed tag is not a matching stable vX.Y.Z tag, or the root version includes prerelease/build metadata or is malformed
- **THEN** publication fails explicitly and no delivery or commit image tag is changed

#### Scenario: Release tag conflicts with source
- **WHEN** vX.Y.Z already identifies another commit
- **THEN** the release run fails before publishing images and leaves the existing Git tag unchanged

### Requirement: Release metadata follows verified image publication
After verification and successful publication of all image references, the system SHALL create a missing annotated vX.Y.Z tag at the exact source commit and a missing GitHub Release with generated notes. The release body SHALL record the version image and first successful exact digest. Matching existing records SHALL be reused unchanged. The main run SHALL complete this work itself; GITHUB_TOKEN-created tags do not trigger another workflow run.

#### Scenario: Release succeeds
- **WHEN** a main version-change run passes all gates and successfully pushes its full-commit reference and all release delivery aliases
- **THEN** its annotated release tag and generated-notes GitHub Release are created only afterward at the verified source commit

#### Scenario: Release is retried
- **WHEN** the release tag already identifies the same source commit and its GitHub Release exists
- **THEN** the run reuses those records without duplicates or rewriting their generated notes and first successful digest evidence

### Requirement: Verified runnable artifacts before publication
The system SHALL pass dependency installation, typechecking, PostgreSQL-backed behavior tests, release-policy regressions, the production image build, and a startup smoke check before publishing. It SHALL publish the same smoke-tested image without rebuilding and SHALL support linux/amd64 Unraid hosts.

#### Scenario: Verification or startup fails
- **WHEN** a required check, build, or container startup smoke fails
- **THEN** no image from that run is pushed, no Git release tag or GitHub Release is created, and previously published delivery references are unchanged

#### Scenario: Tested production image is delivered
- **WHEN** the complete verification succeeds
- **THEN** the published image starts the existing application with its built frontend and required database migrations under runtime configuration

### Requirement: Publication ordering protects the main channel
The system SHALL serialize publication in one repository-specific queued concurrency group without canceling in-progress runs. Before publication it SHALL authenticate repository access and check that the event's current branch or peeled tag reference still identifies its exact source commit. Deleted or superseded refs SHALL be skipped; lookup or authentication errors SHALL fail closed. Older main runs already superseded at that check SHALL NOT advance main or latest.

#### Scenario: Older main build finishes late
- **WHEN** an older main run reaches publication after a newer main commit has been delivered
- **THEN** main and latest continue identifying the newer delivered image

### Requirement: Least-privilege and credential-safe publication
Only the publishing job SHALL receive repository-scoped contents-write and packages-write permissions, covering all its steps. Checkout credentials SHALL NOT persist; explicit token environment exposure SHALL be limited to API/login steps. Publication SHALL NOT use production bot/database/Unraid credentials, expose runtime secrets or persistent data in images/logs, or automatically make packages public.

#### Scenario: Runtime configuration is present on a workstation
- **WHEN** the production image is built from a checkout that contains a real environment file and local data
- **THEN** those runtime secrets and data are excluded from the published image

#### Scenario: Registry authorization is unavailable
- **WHEN** GHCR refuses the workflow's publication credentials
- **THEN** publication fails visibly without requesting production credentials or deploying a local-build fallback

### Requirement: Publication does not deploy the shop
Publication SHALL NOT connect to Unraid, pull images on the server, restart containers, or mutate the production database or media. A newly published image SHALL become available for operator-selected deployment without changing the running shop.

#### Scenario: A new main image is available
- **WHEN** GHCR receives a successful main publication
- **THEN** the current Unraid application and its data remain unchanged until the operator initiates an update

### Requirement: Explicit published-image consumption
Production SHALL pull an operator-selected published image without local builds. The example SHALL select latest. Operators SHALL be able to choose main/latest, unprefixed stable/minor/major tags, full-commit refs, or exact digests. Missing selections and pull failures SHALL be exposed. Deployment SHALL preserve loopback port 4893, environment-file settings, PostgreSQL 18 storage, and persistent media/data locations.

#### Scenario: Operator selects and pulls a published image
- **WHEN** the operator supplies a valid GHCR application image and recreates the app after pulling it
- **THEN** the app uses the selected image without rebuilding source or replacing database or media storage

#### Scenario: Image is missing or inaccessible
- **WHEN** no image is configured or the selected private or nonexistent image cannot be pulled
- **THEN** deployment reports the failure without substituting another image or deleting persistent data

#### Scenario: Operator selects an earlier image
- **WHEN** the operator configures an earlier compatible digest for a manual rollback
- **THEN** that exact application image is selected without resetting orders, stock, or media

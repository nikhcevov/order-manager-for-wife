# container-publishing Specification

## Purpose

Deliver verified production application images through GHCR with predictable source references, while keeping runtime credentials private and deployment timing under the Unraid operator's control.

## Requirements

### Requirement: Push-driven image publication
The system SHALL initiate application image publication for pushes to the main branch and Git tag creation or updates. Other branch pushes and deleted references SHALL NOT publish or delete images.

#### Scenario: Main branch changes
- **WHEN** a commit is pushed to main
- **THEN** a publication run verifies and builds that pushed commit

#### Scenario: Git tag is created or updated
- **WHEN** a Git tag is pushed or moved to a different commit
- **THEN** a publication run verifies and builds the commit identified by that tag event

#### Scenario: Unrelated branch or deleted reference
- **WHEN** another branch is pushed or a branch or tag is deleted
- **THEN** no application image is published and existing registry references remain unchanged

### Requirement: Predictable image references
The system SHALL publish under the lower-case GHCR namespace of the executing GitHub repository. Eligible successful main runs SHALL update the main image tag; successful Git tag runs SHALL update their matching image tag without advancing main. Every publication SHALL include a sha-prefixed full source-commit tag and identify the source repository and commit.

#### Scenario: Main image is published
- **WHEN** a main publication succeeds for a source commit
- **THEN** the main and full-commit references identify the same verified image

#### Scenario: Tagged image is published
- **WHEN** a tag publication succeeds for v1.2.3
- **THEN** v1.2.3 and its full-commit reference identify the same verified image, and main remains unchanged

### Requirement: Unambiguous Git tag handling
The system SHALL preserve Docker-compatible Git tag names exactly. It SHALL reject unsupported names, the reserved main name, and names starting with sha- before publishing any image for that event. It SHALL report the invalid name without silently sanitizing it into another delivery reference.

#### Scenario: Git tag cannot be represented safely
- **WHEN** a pushed Git tag contains a slash, exceeds Docker tag limits, or uses a reserved delivery name
- **THEN** publication fails explicitly and no delivery or commit tag is changed

### Requirement: Verified runnable artifacts before publication
The system SHALL pass dependency installation, typechecking, the existing PostgreSQL-backed behavior suite, the production image build, and a startup smoke check before publishing. The published application image SHALL be the image exercised by the smoke check, not an unverified subsequent rebuild, and SHALL run on linux/amd64 Unraid hosts.

#### Scenario: Verification or startup fails
- **WHEN** a required check, build, or container startup smoke fails
- **THEN** no image from that run is pushed and previously published delivery references are unchanged

#### Scenario: Tested production image is delivered
- **WHEN** the complete verification succeeds
- **THEN** the published image starts the existing application with its built frontend and required database migrations under runtime configuration

### Requirement: Publication ordering protects the main channel
The system SHALL prevent overlapping main runs from allowing an older commit to replace a newer delivered main image. It SHALL check current main-head eligibility before publication and SHALL NOT advance the channel for a run already superseded at that check.

#### Scenario: Older main build finishes late
- **WHEN** an older main run reaches publication after a newer main commit has been delivered
- **THEN** the main reference continues identifying the newer delivered image

### Requirement: Least-privilege and credential-safe publication
The publisher SHALL use repository-scoped read access and registry write access without production bot, database, or Unraid credentials. Real runtime environment files and persistent customer/media data SHALL NOT enter the image or publication logs. Publication SHALL NOT automatically change package visibility to public.

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
Production deployment SHALL use an operator-configured published image reference rather than build application source locally. It SHALL accept an image tag or digest, expose a missing selection or pull failure, and preserve the existing loopback port 4893, environment-file configuration, PostgreSQL 18 storage, and persistent media/data locations.

#### Scenario: Operator selects and pulls a published image
- **WHEN** the operator supplies a valid GHCR application image and recreates the app after pulling it
- **THEN** the app uses the selected image without rebuilding source or replacing database or media storage

#### Scenario: Image is missing or inaccessible
- **WHEN** no image is configured or the selected private or nonexistent image cannot be pulled
- **THEN** deployment reports the failure without substituting another image or deleting persistent data

#### Scenario: Operator selects an earlier image
- **WHEN** the operator configures an earlier compatible digest for a manual rollback
- **THEN** that exact application image is selected without resetting orders, stock, or media

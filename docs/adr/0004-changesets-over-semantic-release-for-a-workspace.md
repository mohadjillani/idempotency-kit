# 0004 — Changesets over semantic-release for a workspace

**Status:** accepted · **Date:** 2026-08-29

## Context

Three packages ship from this repository and version independently: the core, the Redis store and the MongoDB store. A fix in the Lua script must not bump the core; a new core option must not force a MongoDB release. The release tooling has to understand that, and it has to publish with npm provenance from GitHub Actions.

semantic-release derives versions from commit messages and is built around one package per repository; its monorepo support is a third-party plugin that scopes commits by path. Changesets keeps release intent in small files committed with the change, per package.

## Decision

Changesets. A change to a published package comes with a `.changeset/*.md` naming the packages and the bump; the release workflow keeps a "Version Packages" pull request open while changesets are pending and publishes every changed package with `--provenance` when it merges. The private contract and example packages are ignored. `onlyUpdatePeerDependentsWhenOutOfRange` is set so a minor bump of the core does not force a major on the stores, whose peer range is `0.x`.

## Consequences

- Version bumps are reviewed as part of the pull request rather than inferred later from commit prefixes; commit messages stay free to describe the change rather than encode the release.
- Contributors have one extra step (`npx changeset`), which the PR template lists.
- The Version Packages commits are authored by the release bot; everything else in the history is authored by a person.
- Publishing needs `NPM_TOKEN` until npm Trusted Publishing is configured for the repository, after which the `id-token: write` permission in the workflow is sufficient.

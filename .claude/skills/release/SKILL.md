---
name: release
description: Create a release from develop to main. Bumps version, creates PR, and merges with correct flags. Merging to main fires the full build + publish pipeline. NEVER deletes develop branch.
---

# Create Release

Merging to `main` triggers `.github/workflows/release.yml`: signed mac+win builds, upload to Polar, auto-update feed, private releases repo. A release is a **publish event** — the human go/no-go sits between the script's two destructive-capable phases.

The mechanics live in `scripts/release.sh` (relative to this skill's base directory). Run each phase in **one** Bash call — do not reimplement the steps manually.

## Instructions

### 1. Status (read-only)

```bash
bash <skill-base-dir>/scripts/release.sh status
```

Prints current versions (root + desktop, must stay aligned), any already-open release PR, and `git log main..develop` (the changelog input). Nothing destructive.

### 2. Determine version bump (judgment)

Ask the user for the new version (or suggest from the changes):
- **Patch** (1.16.3 → 1.16.4): bug fixes only
- **Minor** (1.16.3 → 1.17.0): new features (default)
- **Major** (1.16.3 → 2.0.0): breaking changes

Optionally write a curated release-PR body to a temp file (changes list + checklist); without it the script auto-generates a changelog body from `git log`.

### 3. Prepare (reversible — touches develop only)

```bash
bash <skill-base-dir>/scripts/release.sh prepare <new-version> [--body-file <f>] --model "<current Claude model>"
```

Checks out develop + pulls, verifies clean tree, bumps the version in root `package.json` **and** `apps/desktop/package.json`, commits (`chore: bump version to X` with co-author), pushes develop, opens the `Release vX` PR develop → main. Idempotent: version already bumped → skips; release PR already open → reuses it.

### 4. Confirm with the user — MANDATORY

Ask explicitly: merging this PR **publishes the release**. Do not run `publish` without a clear yes.

### 5. Publish (destructive — fires the pipeline)

```bash
bash <skill-base-dir>/scripts/release.sh publish <pr-number>
```

Verifies the PR is develop → main and titled `Release v*`, regular-merges it (**never** `--delete-branch` — develop must survive; 502-poll safety included), then syncs: main pulled, develop pulled, `git merge main`, develop pushed.

### 6. Output summary

```
## Release Created

**Version**: v<NEW_VERSION>
**PR**: #XX - Release v<NEW_VERSION>
**Status**: Merged to main — release pipeline running

Watch the build: gh run list --workflow=release.yml
develop is synced with main and ready for continued development.
```

## Notes

- **NEVER delete develop branch** — the script never does; don't do it manually either
- Version lives in root `package.json` **and** `apps/desktop/package.json` (script keeps them aligned)
- The push to `main` runs the whole pipeline automatically: build, sign, notarize, upload to Polar, publish update feed, create the release on the private `skipper-releases` repo (placeholder until the #17 cutover)
- Version bumping is **manual only** (no CI automation) — this skill is the only way to bump versions
- If the pipeline has CI failures, fix on develop first, then release again

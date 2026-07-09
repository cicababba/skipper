---
name: release
description: Create a release from develop to main. Bumps version, creates PR, and merges with correct flags. Merging to main fires the full build + publish pipeline. NEVER deletes develop branch.
---

# Create Release

Merging to `main` triggers `.github/workflows/release.yml`: signed mac+win builds, upload to Polar, auto-update feed, private releases repo. A release here is a **publish event** — always confirm with the user before the final merge.

## Instructions

### 1. Ensure develop is up to date

```bash
git checkout develop
git pull origin develop
```

### 2. Determine version bump

Check current version:
```bash
node -p "require('./package.json').version"
```

Ask the user what the new version should be (or suggest based on changes):
- **Patch** (1.16.3 → 1.16.4): Bug fixes only
- **Minor** (1.16.3 → 1.17.0): New features (default)
- **Major** (1.16.3 → 2.0.0): Breaking changes

### 3. Bump version

The version lives in **two** files that must stay aligned: the root `package.json` (used by CI for the release tag) and `apps/desktop/package.json` (used by electron-builder for the installer/app version).

```bash
for f in package.json apps/desktop/package.json; do
  node -e "
  const pkg = require('./$f');
  pkg.version = '<NEW_VERSION>';
  require('fs').writeFileSync('./$f', JSON.stringify(pkg, null, 2) + '\n');
  "
done
```

### 4. Commit version bump

```bash
git add package.json apps/desktop/package.json
git commit -m "$(cat <<'EOF'
chore: bump version to <NEW_VERSION>

Co-Authored-By: <current model> <noreply@anthropic.com>
EOF
)"
```

### 5. Push develop

```bash
git push origin develop
```

### 6. Create PR from develop → main

```bash
gh pr create \
  --base main \
  --head develop \
  --title "Release v<NEW_VERSION>" \
  --body "$(cat <<'EOF'
## Release v<NEW_VERSION>

### Changes since last release

<List of PRs/changes merged into develop since last release>

### Checklist

- [ ] All CI checks pass
- [ ] Version bumped in package.json + apps/desktop/package.json

---
Generated with Claude Code
EOF
)"
```

To get changes since last release:
```bash
git log main..develop --oneline --no-merges
```

### 7. Merge the PR

**CRITICAL**: NEVER use `--delete-branch` for develop → main! And confirm with the user — this merge publishes the release.

```bash
gh pr merge <PR_NUMBER> --merge
```

### 8. Sync local branches and merge main back into develop

This step ensures develop absorbs the merge commit from main, so main is never ahead of develop.

```bash
git checkout main
git pull origin main
git checkout develop
git pull origin develop
git merge main
git push origin develop
```

### 9. Output summary

```
## Release Created

**Version**: v<NEW_VERSION>
**PR**: #XX - Release v<NEW_VERSION>
**Status**: Merged to main — release pipeline running

Watch the build: gh run list --workflow=release.yml
develop is synced with main and ready for continued development.
```

## Notes

- **NEVER delete develop branch** - this is the most critical rule
- Version is bumped in root `package.json` **and** `apps/desktop/package.json` (keep aligned)
- The push to `main` runs the whole pipeline automatically: build, sign, notarize, upload to Polar, publish update feed, create the release on the private `nestbrain-releases` repo
- Version bumping is **manual only** (no CI automation) - this skill is the only way to bump versions
- If the pipeline has CI failures, fix on develop first, then release again

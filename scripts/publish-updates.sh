#!/usr/bin/env bash
# Publish the auto-update feed for the latest CI build to updates.skipper.app.
#
# Downloads the release artifacts of the most recent successful "Build &
# Release" run (or the run id passed as $1), assembles the generic-provider
# feed layout and rsyncs it to forge:
#
#   /var/www/updates.skipper.app/mac/  ← Skipper-x.y.z-arm64-mac.zip + .blockmap + latest-mac.yml
#   /var/www/updates.skipper.app/win/  ← Skipper Setup x.y.z.exe + latest.yml
#
# Requires: gh CLI authenticated, ssh access to forge.
set -euo pipefail
cd "$(dirname "$0")/.."

RUN_ID="${1:-$(gh run list --workflow=release.yml --status=success --limit 1 --json databaseId -q '.[0].databaseId')}"
[ -n "$RUN_ID" ] || { echo "✗ no successful release run found"; exit 1; }
echo "▶ Publishing update feed from run $RUN_ID"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# `gh run download` 401s on artifact zips even with a valid token (CLI quirk);
# the raw REST endpoint works fine, so fetch via gh api + curl instead.
TOK="$(gh auth token)"
fetch_artifact() {
  local name="$1"
  local id
  id="$(gh api "repos/cicababba/skipper/actions/runs/${RUN_ID}/artifacts" \
        -q ".artifacts[] | select(.name==\"$name\") | .id")"
  [ -n "$id" ] || { echo "✗ artifact not found: $name"; exit 1; }
  mkdir -p "$TMP/$name"
  # GitHub intermittently 401s these; retry hard before giving up.
  curl -fSL --retry 6 --retry-all-errors --retry-delay 5 --speed-limit 10240 --speed-time 30 -H "Authorization: Bearer $TOK" \
    "https://api.github.com/repos/cicababba/skipper/actions/artifacts/${id}/zip" \
    -o "$TMP/$name.zip"
  unzip -q "$TMP/$name.zip" -d "$TMP/$name"
}
fetch_artifact skipper-update-mac
fetch_artifact skipper-update-win
fetch_artifact skipper-windows-x64
fetch_artifact skipper-macos-arm64

mkdir -p "$TMP/feed/mac" "$TMP/feed/win"
find "$TMP/skipper-update-mac" -type f -exec cp {} "$TMP/feed/mac/" \;
cp "$TMP/skipper-update-win/latest.yml" "$TMP/feed/win/"
find "$TMP/skipper-windows-x64" -name '*.exe' -exec cp {} "$TMP/feed/win/" \;

echo "▶ Feed contents:"
ls -lh "$TMP/feed/mac" "$TMP/feed/win" | sed 's/^/   /'

echo "▶ Uploading to forge…"
rsync -az --delete "$TMP/feed/mac/" mike@forge.gazzaruso.com:/var/www/updates.skipper.app/mac/
rsync -az --delete "$TMP/feed/win/" mike@forge.gazzaruso.com:/var/www/updates.skipper.app/win/

# Enterprise app distribution: the licensing service serves these installers to
# licensed orgs (GET /download/app/:platform); apps.txt = mac dmg, win exe.
echo "▶ Seeding installers for Enterprise distribution…"
DMG="$(find "$TMP/skipper-macos-arm64" -name '*.dmg' | head -1)"
EXE="$(find "$TMP/skipper-windows-x64" -name '*.exe' | head -1)"
BUNDLES=/home/mike/docker/skipper-licensing/bundles
rsync -az "$DMG" "$EXE" "mike@forge.gazzaruso.com:$BUNDLES/"
ssh mike@forge.gazzaruso.com "printf '%s\n%s\n' \"$(basename "$DMG")\" \"$(basename "$EXE")\" > $BUNDLES/apps.txt && cat $BUNDLES/apps.txt"

echo "✅ Update feed published."
ssh mike@forge.gazzaruso.com 'grep -m1 version /var/www/updates.skipper.app/mac/latest-mac.yml /var/www/updates.skipper.app/win/latest.yml'

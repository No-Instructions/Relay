#!/usr/bin/env bash
# Release helpers for tag-triggered workflows. Run from the repository root.
#
#   release.sh check stable|beta TAG   prints should_release=true|false (and
#                                      sets that step output under Actions)
#   release.sh set-version TAG         writes TAG into manifest.json
#
# A tag equal to manifest.json's version is a stable release; any other tag
# is a beta.
set -euo pipefail

case "${1:-}" in
  check)
    channel="${2:?channel}" tag="${3:?tag}"
    manifest_version=$(jq -r .version manifest.json)
    if { [ "$channel" = stable ] && [ "$tag" = "$manifest_version" ]; } \
      || { [ "$channel" = beta ] && [ "$tag" != "$manifest_version" ]; }; then
      should=true
    else
      should=false
    fi
    echo "Tag $tag, manifest $manifest_version: $channel release $should"
    echo "should_release=$should" | tee -a "${GITHUB_OUTPUT:-/dev/null}"
    ;;
  set-version)
    tag="${2:?tag}"
    tmp="$(mktemp)"
    jq --arg version "$tag" '.version = $version' manifest.json > "$tmp"
    mv "$tmp" manifest.json
    jq -e --arg version "$tag" '.version == $version' manifest.json > /dev/null
    echo "manifest.json version set to $tag"
    ;;
  *) echo "usage: release.sh check stable|beta TAG | release.sh set-version TAG" >&2; exit 2 ;;
esac

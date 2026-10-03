#!/bin/sh
# Git-installed plugins fetch the pinned standalone runtime on first launch.
set -eu
umask 077
VERSION=0.1.0
SHA256=9cd88639aa9740fe279bb0997894efe475e6c3bfc21f647362be3a4863b4afbf

fail() {
    printf 'Terngram: %s\n' "$*" >&2
    exit 1
}

[ "$(/usr/bin/uname -s)" = Darwin ] || fail 'The bundled runtime requires macOS.'
[ "$(/usr/sbin/sysctl -n hw.optional.arm64)" = 1 ] || fail 'The bundled runtime requires Apple Silicon.'
MACOS=$(/usr/bin/sw_vers -productVersion)
[ "${MACOS%%.*}" -ge 27 ] || fail 'The bundled runtime requires macOS 27 or newer.'
CACHE="${XDG_CACHE_HOME:-$HOME/Library/Caches}/terngram"
RUNTIME="$CACHE/$VERSION-$SHA256"
if [ ! -x "$RUNTIME/bin/terngram" ]; then
    /bin/mkdir -p "$CACHE"
    [ ! -L "$CACHE" ] || fail 'Runtime cache must not be a symbolic link.'
    LOCK="$CACHE/.install-$VERSION-$SHA256"
    /bin/mkdir "$LOCK" 2>/dev/null || fail 'Runtime installation is already in progress; try again after it finishes.'
    STAGE=
    cleanup() {
        if [ -n "$STAGE" ]; then /bin/rm -rf "$STAGE"; fi
        /bin/rmdir "$LOCK"
    }
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM HUP
    STAGE=$(/usr/bin/mktemp -d "$CACHE/.download.XXXXXX")
    ARCHIVE="terngram-$VERSION-macos-arm64.zip"
    URL="https://github.com/d3d0n/terngram/releases/download/v$VERSION/$ARCHIVE"
    printf 'Terngram: downloading runtime %s (first launch only)…\n' "$VERSION" >&2
    /usr/bin/curl --fail --location --proto '=https' --proto-redir '=https' \
        --connect-timeout 15 --max-time 300 --output "$STAGE/$ARCHIVE" "$URL"
    (cd "$STAGE" && printf '%s  %s\n' "$SHA256" "$ARCHIVE" | /usr/bin/shasum -a 256 -c -)
    /usr/bin/unzip -q "$STAGE/$ARCHIVE" -d "$STAGE"
    [ -x "$STAGE/terngram/bin/terngram" ] || fail 'The verified release has no executable launcher.'
    [ ! -e "$RUNTIME" ] && [ ! -L "$RUNTIME" ] || fail 'Runtime destination already exists but is incomplete; no files were replaced.'
    /bin/mv "$STAGE/terngram" "$RUNTIME"
    cleanup
    trap - EXIT INT TERM HUP
fi
exec "$RUNTIME/bin/terngram" "$@"

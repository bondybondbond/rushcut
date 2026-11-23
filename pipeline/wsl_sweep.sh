#!/bin/bash
# #287: WSL-side scratch sweep. Run by RushCut at startup ONLY when no render or proxy
# work is in flight (the Rust caller checks the shared DB first). Also safe to run by hand:
#   wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/apps/rushcut/pipeline/wsl_sweep.sh --dry-run
#
# Deletes ONLY, and only when older than 1 day (mtime):
#   1. directories directly under /tmp named exactly <uuid> (a leaked render job dir)
#   2. the CONTENTS (not the dir itself) of four RushCut fallback dirs:
#        /tmp/rushcut-render  /tmp/rushcut-render-cache  /tmp/rushcut-thumbs  /tmp/rushcut
# Every target is an explicit allowlist match, re-checked against a resolved path before
# removal. Anything else under /tmp is never touched. No variable is ever expanded into a
# bare "rm -rf": paths are validated first and passed after "--".
set -u
cd / || exit 1

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

MIN_AGE_MIN=1440
UUID_RE='/tmp/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
FALLBACKS="/tmp/rushcut-render /tmp/rushcut-render-cache /tmp/rushcut-thumbs /tmp/rushcut"

removed=0
freed_kb=0

remove_one() {
    # $1 = absolute path already matched by the allowlist
    local p="$1" real kb
    case "$p" in
        /tmp/?*) ;;
        *) echo "REFUSE (not under /tmp): $p"; return ;;
    esac
    real=$(realpath -- "$p" 2>/dev/null) || return
    case "$real" in
        /tmp/?*) ;;
        *) echo "REFUSE (resolves outside /tmp): $p -> $real"; return ;;
    esac
    [ "$real" = "/tmp" ] && { echo "REFUSE (/tmp itself)"; return; }
    kb=$(du -sk -- "$real" 2>/dev/null | cut -f1)
    kb=${kb:-0}
    if [ "$DRY" = 1 ]; then
        echo "WOULD REMOVE ${kb}KB $real"
        removed=$((removed + 1))
        freed_kb=$((freed_kb + kb))
        return
    fi
    if rm -rf -- "$real"; then
        removed=$((removed + 1))
        freed_kb=$((freed_kb + kb))
    fi
}

# 1. leaked <uuid> job dirs
while IFS= read -r p; do
    [ -n "$p" ] && remove_one "$p"
done < <(find /tmp -mindepth 1 -maxdepth 1 -type d -mmin +"$MIN_AGE_MIN" \
            -regextype posix-extended -regex "$UUID_RE" 2>/dev/null)

# 2. contents of the known fallback dirs (the dirs themselves are kept)
for base in $FALLBACKS; do
    [ -d "$base" ] || continue
    [ -L "$base" ] && continue
    while IFS= read -r p; do
        [ -n "$p" ] && remove_one "$p"
    done < <(find "$base" -mindepth 1 -maxdepth 1 ! -type l -mmin +"$MIN_AGE_MIN" 2>/dev/null)
done

echo "wsl-sweep dry=$DRY removed=$removed freed_mb=$((freed_kb / 1024))"

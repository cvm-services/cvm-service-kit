#!/bin/bash
# Build the pinned Loom adapter binaries on the controller (needs cargo).
# Applies local patches (files/*.patch) after checking out the pinned commit.
# Usage: build-artifacts.sh <commit> <out-dir>
# Idempotent: rebuilds only when the commit or a patch changes.
set -euo pipefail

# Non-interactive shells (Ansible) may not source the toolchain env.
export PATH="$HOME/.cargo/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH"

COMMIT="${1:?commit required}"
OUT="${2:?out dir required}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REMOTE_DEFAULT="nostr://npub1gl4q43rngdc7mnrflz98kan6dq5h76xepfpe0cvmapr0sc0wdpas0kd86j/relay.ngit.dev/loom-adapter-firecracker"
REMOTE="${LOOM_ADAPTER_REMOTE:-$REMOTE_DEFAULT}"
SRC_DIR="${LOOM_SRC_DIR:-$HOME/repos/loom-adapter-firecracker}"

mapfile -t PATCHES < <(ls "$SCRIPT_DIR"/*.patch 2>/dev/null || true)
STAMP="$OUT/.stamp"
WANT="$COMMIT"
for p in "${PATCHES[@]:-}"; do
  [ -n "$p" ] || continue
  WANT="$WANT:$(sha256sum "$p" | cut -d' ' -f1)"
done

if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$WANT" ] \
   && [ -x "$OUT/loom-adapter-firecracker" ] && [ -x "$OUT/loom-vsock-agent" ]; then
  echo "up-to-date ($WANT)"
  exit 0
fi

if [ ! -d "$SRC_DIR/.git" ]; then
  mkdir -p "$(dirname "$SRC_DIR")"
  git clone "$REMOTE" "$SRC_DIR"
fi
git -C "$SRC_DIR" fetch --all --tags --prune || true
git -C "$SRC_DIR" checkout -f "$COMMIT"
for p in "${PATCHES[@]:-}"; do
  [ -n "$p" ] || continue
  echo "applying $(basename "$p")"
  git -C "$SRC_DIR" apply --whitespace=nowarn "$p"
done

rustup target add x86_64-unknown-linux-musl >/dev/null 2>&1 || true

(
  cd "$SRC_DIR"
  cargo build --release --bin loom-adapter-firecracker
  cargo build --release --bin loom-vsock-agent --target x86_64-unknown-linux-musl
)

mkdir -p "$OUT"
install -m 0755 "$SRC_DIR/target/release/loom-adapter-firecracker" "$OUT/loom-adapter-firecracker"
install -m 0755 "$SRC_DIR/target/x86_64-unknown-linux-musl/release/loom-vsock-agent" "$OUT/loom-vsock-agent"
echo "$WANT" > "$STAMP"
echo "rebuilt ($WANT)"

#!/bin/bash
#
# build-rootfs.sh — Build a rootfs image for the Loom Firecracker adapter.
#
# Creates an ext4 rootfs with:
#   - Ubuntu 24.04 userspace
#   - Python 3, Node.js, Docker, Git, build-essential, jq
#   - ngit (Nostr git)
#   - nak (Nostr Swiss Army Knife)
#   - act (run GitHub Actions locally)
#   - loom-vsock-agent (static binary from this crate; listens on vsock port 1024)
#
# Usage:
#   ./scripts/build-rootfs.sh [output-path] [size-in-GiB]
#
# Defaults:
#   output: /var/lib/loom/firecracker/rootfs.ext4
#   size: 5 GiB
#
# Environment:
#   DEBOOTSTRAP_KEYRING  Ubuntu archive keyring for signature checks. Defaults
#                        to the path the ubuntu-keyring package installs; set
#                        it on hosts that don't have that package (e.g. NixOS,
#                        where `nix run .#build-rootfs` sets it for you).
#   LOOM_VSOCK_AGENT     Prebuilt static loom-vsock-agent binary to install
#                        into the guest. Unset: built here with cargo for the
#                        <arch>-unknown-linux-musl target (`rustup target add`
#                        it first). Must be static — the guest is Ubuntu and
#                        cannot load the host's libc.
#
set -euxo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Build the guest agent before escalating so cargo runs as the invoking user
# with their toolchain and cache, not as root.
if [[ -z "${LOOM_VSOCK_AGENT:-}" ]]; then
    TARGET="$(uname -m)-unknown-linux-musl"
    if ! command -v cargo >/dev/null; then
        echo "cargo not found; set LOOM_VSOCK_AGENT to a static loom-vsock-agent binary" >&2
        exit 1
    fi
    (cd "$REPO_DIR" && cargo build --release --bin loom-vsock-agent --target "$TARGET")
    export LOOM_VSOCK_AGENT="$REPO_DIR/target/$TARGET/release/loom-vsock-agent"
fi
[[ -x "$LOOM_VSOCK_AGENT" ]] || { echo "not executable: $LOOM_VSOCK_AGENT" >&2; exit 1; }

# Everything below needs root: mount, debootstrap, chroot. Re-exec once,
# keeping PATH so tools supplied by a Nix shell or `nix run` stay visible —
# sudo's secure_path would otherwise drop them.
if [[ $EUID -ne 0 ]]; then
    exec sudo --preserve-env=PATH,DEBOOTSTRAP_KEYRING,LOOM_VSOCK_AGENT "$0" "$@"
fi

OUTPUT="${1:-/var/lib/loom/firecracker/rootfs.ext4}"
SIZE_GIB="${2:-5}"
KEYRING="${DEBOOTSTRAP_KEYRING:-/usr/share/keyrings/ubuntu-archive-keyring.gpg}"
MOUNT_DIR=$(mktemp -d /tmp/loom-rootfs-XXXXXX)
# Assemble next to the target and move into place only once the image is
# unmounted and complete. The adapter copies whatever sits at $OUTPUT for every
# VM, so a failed build must not leave a formatted-but-empty image there.
TMP_OUTPUT="$OUTPUT.tmp"

echo "=== Building Loom Firecracker rootfs ==="
echo "Output: $OUTPUT"
echo "Size: ${SIZE_GIB} GiB"

# Ensure output directory exists
mkdir -p "$(dirname "$OUTPUT")"

# Create ext4 image. Sparse: the file only takes the space the guest uses,
# and the adapter's per-VM `cp --reflink=auto` copies keep it that way.
rm -f "$TMP_OUTPUT"
truncate -s "${SIZE_GIB}G" "$TMP_OUTPUT"
mkfs.ext4 -F -q "$TMP_OUTPUT"

# Mount the image, then the kernel filesystems apt and the installer scripts
# expect inside the chroot. Unmount in reverse on exit, whatever happens.
mount "$TMP_OUTPUT" "$MOUNT_DIR"
unmount_all() {
    for m in dev/pts dev sys proc; do
        umount "$MOUNT_DIR/$m" 2>/dev/null || true
    done
    umount "$MOUNT_DIR" 2>/dev/null || true
}
cleanup() {
    unmount_all
    rm -rf "$MOUNT_DIR"
    # Still present only if the build did not get as far as the final mv.
    rm -f "$TMP_OUTPUT"
}
trap cleanup EXIT

# Run a command inside the guest tree. `chroot` resolves its command through
# the *host* PATH after switching root, so a bare `bash` only works when the
# host PATH happens to contain directories that also exist in the guest —
# true on Ubuntu, false under `nix run`, where PATH is all /nix/store. Exec an
# absolute /bin/bash and start from a clean environment with a guest PATH so
# nothing the guest runs by name (apt-get, curl, npm, …) inherits the host's.
in_chroot() {
    chroot "$MOUNT_DIR" /usr/bin/env -i \
        PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
        HOME=/root \
        TERM="${TERM:-dumb}" \
        DEBIAN_FRONTEND=noninteractive \
        /bin/bash -c "$1"
}

# Install Ubuntu base
echo "=== Installing Ubuntu 24.04 base ==="
debootstrap --variant=minbase --keyring="$KEYRING" noble "$MOUNT_DIR" http://archive.ubuntu.com/ubuntu/

mount -t proc proc "$MOUNT_DIR/proc"
mount -t sysfs sys "$MOUNT_DIR/sys"
mount --bind /dev "$MOUNT_DIR/dev"
mount --bind /dev/pts "$MOUNT_DIR/dev/pts"
# DNS for apt and the curl|bash installers below. Copies the content, not the
# symlink — on systemd-resolved hosts /etc/resolv.conf points into /run.
cat /etc/resolv.conf > "$MOUNT_DIR/etc/resolv.conf"

# Configure apt sources
mkdir -p "$MOUNT_DIR/etc/apt/sources.list.d"
cat << 'SOURCES' > "$MOUNT_DIR/etc/apt/sources.list"
deb http://archive.ubuntu.com/ubuntu/ noble main restricted universe multiverse
deb http://archive.ubuntu.com/ubuntu/ noble-updates main restricted universe multiverse
deb http://security.ubuntu.com/ubuntu/ noble-security main restricted universe multiverse
SOURCES

# Install packages inside the rootfs
echo "=== Installing packages ==="
in_chroot '
    set -euxo pipefail
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y \
        python3 python3-pip python3-venv \
        nodejs npm \
        git curl wget bash \
        build-essential \
        jq vim nano \
        ca-certificates \
        ffmpeg \
        golang \
        rustc cargo \
        \
        socat \
        init \
        systemd \
        openssh-server \
        iproute2 \
        iputils-ping \
        dnsutils
'

# Install Docker inside the rootfs
echo "=== Installing Docker ==="
in_chroot '
    set -euxo pipefail
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    sh /tmp/get-docker.sh
    rm /tmp/get-docker.sh
    # Docker is installed but NOT started: it is heavy and pulls
    # network-online.target -> systemd-networkd-wait-online, which blocks boot
    # in a vsock-only guest. Enable it only if a workload requires nested docker.
    systemctl disable docker containerd 2>/dev/null || true
    chmod 666 /var/run/docker.sock || true
    mkdir -p /etc/systemd/system/docker.service.d
    cat > /etc/systemd/system/docker.service.d/override.conf << EOF
[Service]
ExecStartPost=/bin/chmod 666 /var/run/docker.sock
EOF
'

# Install ngit
echo "=== Installing ngit ==="
in_chroot '
    set -euxo pipefail
    curl -Ls https://ngit.dev/install.sh | bash
'

# Install nak
echo "=== Installing nak ==="
in_chroot '
    set -euxo pipefail
    export HOME=/root
    export GOPATH=$HOME/go
    export PATH=$PATH:$GOPATH/bin
    go install github.com/fiatjaf/nak@v0.18.1
    cp $GOPATH/bin/nak /usr/local/bin/
'

# Install act
echo "=== Installing act ==="
in_chroot '
    set -euxo pipefail
    curl --proto "=https" --tlsv1.2 -sSf https://raw.githubusercontent.com/nektos/act/master/install.sh | bash
    mkdir -p /etc/skel
    echo "-P ubuntu-latest=catthehacker/ubuntu:act-latest" > /etc/skel/.actrc
'

# No `docker pull` here: there is no daemon inside a chroot. act pulls its
# image on first use in the guest.

# Install the vsock agent
echo "=== Installing loom-vsock-agent ==="
install -m 0755 "$LOOM_VSOCK_AGENT" "$MOUNT_DIR/usr/local/bin/loom-vsock-agent"

# Create the init system — systemd service that runs the vsock agent
echo "=== Configuring init ==="
cat << 'INIT' > "$MOUNT_DIR/etc/systemd/system/loom-vsock-agent.service"
[Unit]
Description=Loom Vsock Agent
# Start early and independently: the adapter expects the agent shortly after
# boot, but multi-user.target waits on slow/absent device + network-online jobs.
DefaultDependencies=no
After=systemd-tmpfiles-setup.service
Before=basic.target

[Service]
Type=simple
ExecStart=/usr/local/bin/loom-vsock-agent
Restart=always
RestartSec=2

[Install]
WantedBy=sysinit.target
INIT

# Enable the service
in_chroot 'systemctl enable loom-vsock-agent'

# Configure auto-login on ttyS0 (serial console = firecracker console)
echo "=== Configuring serial console ==="
mkdir -p "$MOUNT_DIR/etc/systemd/system/serial-getty@ttyS0.service.d"
cat << 'AUTOLOGIN' > "$MOUNT_DIR/etc/systemd/system/serial-getty@ttyS0.service.d/autologin.conf"
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin root --noclear %I $TERM
AUTOLOGIN

# Configure networking: the static address the adapter's TAP side expects
# (see setup_tap in src/firecracker.rs — host 172.16.0.1/24, NAT out).
#
# systemd-networkd, not netplan: --variant=minbase installs neither
# netplan.io nor a renderer for it, so a netplan file here was never read
# and the build died on the missing /etc/netplan directory. networkd ships
# in the systemd package that is already installed.
echo "=== Configuring network ==="
mkdir -p "$MOUNT_DIR/etc/systemd/network"
cat << 'NETWORK' > "$MOUNT_DIR/etc/systemd/network/10-eth0.network"
[Match]
# With --enable-pci the virtio-net NIC may get a predictable name (enp0sN).
Name=en* eth0

[Network]
Address=172.16.0.2/24
Gateway=172.16.0.1
NETWORK
in_chroot 'systemctl enable systemd-networkd'

# The host's resolv.conf was copied in for the build (above) and names the
# host's resolver, which the guest cannot reach through the NAT. Replace it
# with public resolvers; systemd-resolved is not part of minbase either.
cat << 'RESOLV' > "$MOUNT_DIR/etc/resolv.conf"
nameserver 1.1.1.1
nameserver 8.8.8.8
RESOLV

# FQDN
echo "loom-vm" > "$MOUNT_DIR/etc/hostname"

# Cleanup
echo "=== Cleaning up ==="
in_chroot '
    apt-get clean
    rm -rf /var/lib/apt/lists/*
'

# Set root password (empty — no login needed, firecracker console only)
in_chroot 'passwd -d root'

echo "Installed tools:"
in_chroot '
    echo "  Python: $(python3 --version 2>&1)"
    echo "  Node: $(node --version 2>&1)"
    echo "  Docker: $(docker --version 2>&1)"
    echo "  Git: $(git --version 2>&1)"
    echo "  ngit: $(ngit --version 2>&1)"
    echo "  nak: $(nak --version 2>&1)"
    echo "  act: $(act --version 2>&1)"
    echo "  socat: $(socat -V 2>&1 | head -1)"
    echo "  agent: $(/usr/local/bin/loom-vsock-agent --version 2>&1)"
'

# Flush and unmount before the image becomes visible at its final path.
unmount_all
mv -f "$TMP_OUTPUT" "$OUTPUT"

echo "=== Rootfs build complete ==="
echo "Output: $OUTPUT"

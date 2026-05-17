#!/bin/sh
set -e

# macreaper installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/roopen219/macreaper/main/install.sh | bash
#
# Install a specific version:
#   MACREAPER_VERSION=v0.2.0 curl -fsSL https://raw.githubusercontent.com/roopen219/macreaper/main/install.sh | bash
#
# Install somewhere other than the default ~/.macreaper/bin:
#   MACREAPER_INSTALL_DIR=/usr/local/bin curl -fsSL ... | bash
#
# This script strips macOS's quarantine attribute and re-applies an ad-hoc
# code signature so Gatekeeper doesn't block the binary. That's why curl |
# bash works without "unidentified developer" prompts — direct `curl` of
# the binary by itself would trip Gatekeeper.

REPO="roopen219/macreaper"
INSTALL_DIR="${MACREAPER_INSTALL_DIR:-$HOME/.macreaper/bin}"

main() {
  if [ "$(uname -s)" != "Darwin" ]; then
    printf "\033[31mError: macreaper is macOS-only (you're on %s).\033[0m\n" "$(uname -s)" >&2
    exit 1
  fi

  arch=$(detect_arch)
  binary="macreaper-darwin-${arch}"

  if [ -n "$MACREAPER_VERSION" ]; then
    url="https://github.com/${REPO}/releases/download/${MACREAPER_VERSION}/${binary}"
    sums_url="https://github.com/${REPO}/releases/download/${MACREAPER_VERSION}/SHA256SUMS"
  else
    url="https://github.com/${REPO}/releases/latest/download/${binary}"
    sums_url="https://github.com/${REPO}/releases/latest/download/SHA256SUMS"
  fi

  printf "\033[1m> Downloading macreaper (darwin/%s)\033[0m\n" "$arch"

  mkdir -p "$INSTALL_DIR"
  target="${INSTALL_DIR}/macreaper"

  tmp_binary=$(mktemp)
  download "$url" "$tmp_binary"

  # Verify checksum if available — best-effort, don't fail if SHA256SUMS
  # is missing (older releases may not have it).
  tmp_sums=$(mktemp)
  if download "$sums_url" "$tmp_sums" 2>/dev/null; then
    expected=$(awk -v b="$binary" '$2 == b { print $1 }' "$tmp_sums")
    if [ -n "$expected" ]; then
      actual=$(shasum -a 256 "$tmp_binary" | awk '{print $1}')
      if [ "$expected" != "$actual" ]; then
        printf "\033[31mError: SHA256 checksum mismatch.\033[0m\n" >&2
        printf "  expected: %s\n" "$expected" >&2
        printf "  actual:   %s\n" "$actual" >&2
        rm -f "$tmp_binary" "$tmp_sums"
        exit 1
      fi
      printf "  SHA256 verified.\n"
    fi
  fi
  rm -f "$tmp_sums"

  mv "$tmp_binary" "$target"
  chmod +x "$target"

  # Strip quarantine (set by curl) + ad-hoc resign so Gatekeeper allows
  # execution. Either operation can silently no-op on a system that's
  # already happy with the binary, hence the `|| true`.
  xattr -d com.apple.quarantine "$target" 2>/dev/null || true
  codesign --sign - --force "$target" 2>/dev/null || true

  add_to_path

  printf "\n\033[32m✓ macreaper installed to %s\033[0m\n" "$target"
  printf "  Run '\033[1mmacreaper scan\033[0m' to see what's eating your disk\n"
  printf "  Run '\033[1mmacreaper --help\033[0m' for all commands\n"

  if ! command -v macreaper >/dev/null 2>&1; then
    printf "\n  \033[33mRestart your shell or run:\033[0m\n"
    printf "    export PATH=\"%s:\$PATH\"\n" "$INSTALL_DIR"
  fi
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)  echo "x64" ;;
    aarch64|arm64) echo "arm64" ;;
    *)
      printf "\033[31mError: Unsupported architecture: %s\033[0m\n" "$(uname -m)" >&2
      printf "macreaper supports arm64 and x64.\n" >&2
      exit 1
      ;;
  esac
}

download() {
  url="$1"
  dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$dest" "$url"
  else
    printf "\033[31mError: curl or wget is required to install macreaper.\033[0m\n" >&2
    exit 1
  fi
}

add_to_path() {
  # If the install dir is already on PATH (e.g. /usr/local/bin), nothing
  # to do. Otherwise append an export line to the user's shell rc files.
  case ":$PATH:" in
    *":${INSTALL_DIR}:"*) return ;;
  esac

  export_line="export PATH=\"${INSTALL_DIR}:\$PATH\""

  for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
    if [ -f "$rc" ]; then
      if ! grep -qF "$INSTALL_DIR" "$rc" 2>/dev/null; then
        printf "\n# macreaper\n%s\n" "$export_line" >> "$rc"
      fi
    fi
  done

  # zsh is the default shell on macOS — create .zshrc if missing.
  if [ ! -f "$HOME/.zshrc" ]; then
    printf "# macreaper\n%s\n" "$export_line" > "$HOME/.zshrc"
  fi
}

main

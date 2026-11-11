#!/bin/sh
# POSIX installer for @plurnk/plurnk with isolated SHA-256-verified Node.js 26 fallback.
set -eu

INSTALL_HOME="${PLURNK_INSTALL_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/plurnk}"
BIN_DIR="${PLURNK_BIN_DIR:-$HOME/.local/bin}"
NODE_DIST_URL="${PLURNK_NODE_DIST_URL:-https://nodejs.org/dist/latest-v26.x}"
NPM_PACKAGE="${PLURNK_NPM_PACKAGE:-@plurnk/plurnk}"
FORCE_ISOLATED="${PLURNK_ISOLATED_NODE:-0}"

STAGE_DIR=""
cleanup() {
    if [ -n "$STAGE_DIR" ] && [ -d "$STAGE_DIR" ]; then
        rm -rf "$STAGE_DIR"
    fi
}
trap cleanup EXIT INT TERM

fetch_url() {
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$1" -o "$2"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO "$2" "$1"
    else
        printf 'plurnk install: curl or wget is required to download Node.js 26.\n' >&2
        exit 1
    fi
}

sha256_file() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print tolower($1)}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print tolower($1)}'
    elif command -v openssl >/dev/null 2>&1; then
        openssl dgst -sha256 "$1" | awk '{print tolower($NF)}'
    else
        printf 'plurnk install: sha256sum, shasum, or openssl is required to verify Node.js.\n' >&2
        exit 1
    fi
}

shell_quote() {
    printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

ISOLATED=1
if [ "$FORCE_ISOLATED" != "1" ] && command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || printf '0')"
    case "$NODE_MAJOR" in
        ''|*[!0-9]*) NODE_MAJOR=0 ;;
    esac
    if [ "$NODE_MAJOR" -ge 26 ]; then
        ISOLATED=0
    fi
fi

mkdir -p "$INSTALL_HOME/app" "$BIN_DIR"

if [ "$ISOLATED" -eq 1 ]; then
    UNAME_S="$(uname -s)"
    case "$UNAME_S" in
        Linux) OS="linux" ;;
        Darwin) OS="darwin" ;;
        *)
            printf 'plurnk install: unsupported operating system: %s\n' "$UNAME_S" >&2
            exit 1
            ;;
    esac

    UNAME_M="$(uname -m)"
    case "$UNAME_M" in
        x86_64|amd64) ARCH="x64" ;;
        aarch64|arm64) ARCH="arm64" ;;
        *)
            printf 'plurnk install: unsupported architecture: %s\n' "$UNAME_M" >&2
            exit 1
            ;;
    esac

    STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/plurnk-install.XXXXXX")"
    DIST_BASE="${NODE_DIST_URL%/}"
    fetch_url "$DIST_BASE/SHASUMS256.txt" "$STAGE_DIR/SHASUMS256.txt"

    MATCH_LINE="$(awk -v os="$OS" -v arch="$ARCH" '
        $2 ~ ("^\\*?node-v26\\.[0-9]+\\.[0-9]+-" os "-" arch "\\.tar\\.gz$") {
            sub(/^\*/, "", $2)
            print tolower($1) " " $2
            exit
        }
    ' "$STAGE_DIR/SHASUMS256.txt")"

    if [ -z "$MATCH_LINE" ]; then
        printf 'plurnk install: could not find node-v26.*-%s-%s.tar.gz in %s/SHASUMS256.txt\n' "$OS" "$ARCH" "$DIST_BASE" >&2
        exit 1
    fi

    EXPECTED_SHA="${MATCH_LINE%% *}"
    ARCHIVE_NAME="${MATCH_LINE#* }"
    fetch_url "$DIST_BASE/$ARCHIVE_NAME" "$STAGE_DIR/$ARCHIVE_NAME"

    ACTUAL_SHA="$(sha256_file "$STAGE_DIR/$ARCHIVE_NAME")"
    if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
        printf 'plurnk install: SHA-256 verification failed for %s (expected %s, got %s)\n' "$ARCHIVE_NAME" "$EXPECTED_SHA" "$ACTUAL_SHA" >&2
        exit 1
    fi

    mkdir -p "$STAGE_DIR/unpack"
    tar -xzf "$STAGE_DIR/$ARCHIVE_NAME" -C "$STAGE_DIR/unpack"
    EXTRACTED_DIR="$(find "$STAGE_DIR/unpack" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
    if [ -z "$EXTRACTED_DIR" ] || [ ! -x "$EXTRACTED_DIR/bin/node" ]; then
        printf 'plurnk install: extracted Node.js archive did not contain bin/node\n' >&2
        exit 1
    fi
    rm -rf "$INSTALL_HOME/node"
    mv "$EXTRACTED_DIR" "$INSTALL_HOME/node"
    PATH="$INSTALL_HOME/node/bin:$PATH"
    export PATH
    NPM_BIN="$INSTALL_HOME/node/bin/npm"
else
    NPM_BIN="npm"
fi

"$NPM_BIN" install --prefix "$INSTALL_HOME/app" --no-fund --no-audit --ignore-scripts "$NPM_PACKAGE" >/dev/null

ENTRY_JS="$INSTALL_HOME/app/node_modules/@plurnk/plurnk/bin/plurnk.js"
if [ ! -f "$ENTRY_JS" ]; then
    printf 'plurnk install: expected entrypoint missing at %s\n' "$ENTRY_JS" >&2
    exit 1
fi

QUOTED_ENTRY="$(shell_quote "$ENTRY_JS")"
WRAPPER="$BIN_DIR/plurnk"
if [ "$ISOLATED" -eq 1 ]; then
    QUOTED_NODE_BIN_DIR="$(shell_quote "$INSTALL_HOME/node/bin")"
    QUOTED_NODE_BIN="$(shell_quote "$INSTALL_HOME/node/bin/node")"
    cat >"$WRAPPER" <<EOF
#!/bin/sh
PATH=${QUOTED_NODE_BIN_DIR}:"\$PATH"
export PATH
exec ${QUOTED_NODE_BIN} ${QUOTED_ENTRY} "\$@"
EOF
else
    cat >"$WRAPPER" <<EOF
#!/bin/sh
exec node ${QUOTED_ENTRY} "\$@"
EOF
fi
chmod 0755 "$WRAPPER"

printf 'Installed plurnk -> %s\n' "$WRAPPER"
case ":${PATH:-}:" in
    *":$BIN_DIR:"*)
        printf 'Run plurnk to start.\n'
        ;;
    *)
        printf 'Add %s to PATH, then run plurnk.\n' "$BIN_DIR"
        ;;
esac

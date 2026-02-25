#!/usr/bin/env bash
set -e

OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
BIN_DIR="$OPENCLAW_HOME/bin"
TOOLS_DIR="$OPENCLAW_HOME/tools/knowledge-graph/skill/scripts"

# Create bin dir if needed
mkdir -p "$BIN_DIR"

# Create symlinks (relative from bin/ to tools/)
ln -sf "../tools/knowledge-graph/skill/scripts/kg" "$BIN_DIR/kg"
ln -sf "../tools/knowledge-graph/skill/scripts/kg-maintenance" "$BIN_DIR/kg-maintenance"

echo "✓ Symlinks created:"
echo "  $BIN_DIR/kg -> ../tools/knowledge-graph/skill/scripts/kg"
echo "  $BIN_DIR/kg-maintenance -> ../tools/knowledge-graph/skill/scripts/kg-maintenance"

# Check PATH
if echo "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
    echo "✓ $BIN_DIR is on your PATH"
else
    echo ""
    echo "⚠️  WARNING: $BIN_DIR is not on your PATH"
    echo "   Add this to your ~/.bashrc or ~/.profile:"
    echo "   export PATH=\"\$HOME/.openclaw/bin:\$PATH\""
fi

echo ""
echo "✓ knowledge-graph setup complete"

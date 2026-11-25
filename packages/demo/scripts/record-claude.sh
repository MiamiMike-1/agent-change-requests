#!/usr/bin/env bash
# Records a real Claude Code run against the demo server, in three headless sessions:
#
#   1. server 1.0.0, a plain question. Nothing tells the agent to file a request.
#   2. the vendor ships 1.1.0, then a new session asks a similar question.
#   3. the same as 2, with a one-line memory note naming the request filed in 1.
#
# Each session sees only the invoices server's tools. The raw stream-json goes to
# $OUT/raw (not committed: it holds session ids and usage data), and
# render-recording.mjs turns it into the committed transcript.
#
#   npm run build --workspaces
#   packages/demo/scripts/record-claude.sh [out-dir]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="${1:-$ROOT/demo-state/recording}"
RAW="$OUT/raw"
rm -rf "$RAW" && mkdir -p "$RAW"
DB="$RAW/requests.db"

config() {
  cat <<EOF
{"mcpServers":{"invoices":{"command":"node","args":["--disable-warning=ExperimentalWarning","$ROOT/packages/demo/dist/stdio.js"],
"env":{"DEMO_VERSION":"$1","DEMO_STORE":"$DB","DEMO_PRINCIPAL":"demo-user"}}}}
EOF
}
config 1.0.0 > "$RAW/mcp-1.0.0.json"
config 1.1.0 > "$RAW/mcp-1.1.0.json"

run() { # name, version, prompt, [extra args]
  local name=$1 version=$2 prompt=$3; shift 3
  claude -p "$prompt" "$@" \
    --mcp-config "$RAW/mcp-$version.json" --strict-mcp-config \
    --tools "" --allowedTools "mcp__invoices__*" \
    --output-format stream-json --verbose --no-session-persistence \
    < /dev/null > "$RAW/$name.jsonl"
}

run session-1 1.0.0 "Using the invoices server, how much does customer cus_007 owe in unpaid invoices?"
node --disable-warning=ExperimentalWarning "$ROOT/packages/demo/dist/ship.js" "$DB" | tee "$RAW/ship.txt"
run session-2 1.1.0 "Using the invoices server, how much does customer cus_012 owe in unpaid invoices?"

REQUEST=$(node -e 'for (const l of require("fs").readFileSync(process.argv[1],"utf8").split("\n")) { const m = l.match(/crq_[0-9a-f]+/); if (m) { console.log(m[0]); break; } }' "$RAW/ship.txt")
MEMORY="Memory from earlier sessions: on the invoices server you filed change request $REQUEST (list_invoices could not filter by customer or status; workaround: page through every invoice and filter locally)."
printf '%s\n' "$MEMORY" > "$RAW/session-3.memory.txt"
run session-3 1.1.0 "Using the invoices server, how much does customer cus_012 owe in unpaid invoices?" --append-system-prompt "$MEMORY"

node "$ROOT/packages/demo/scripts/render-recording.mjs" "$RAW" "$OUT"

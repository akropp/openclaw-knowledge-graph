# openclaw-knowledge-graph

An [OpenClaw](https://github.com/openclaw) plugin that provides a shared knowledge graph for multi-agent systems. Stores entity relationships as triples in SQLite, extracts entities from conversations, traverses relationships via multi-hop queries, and fuses results from multiple knowledge sources.

## Features

- **SQLite-backed graph database** — Entity-relationship triples with full-text search (FTS5)
- **Multi-hop traversal** — Recursive CTE-based graph walks up to N hops
- **Entity extraction** — Lightweight NLP extraction from text (no LLM calls)
- **RRF fusion** — Reciprocal Rank Fusion across graph, memory, and external sources
- **Stability guard** — Loop detection and confabulation catching for agents
- **CLI tool** — Standalone `kg` command for manual graph management

## Installation

```bash
npm install
```

## Usage

### As a CLI tool (skill-only mode)

Agents can use the `kg` CLI directly without the plugin installed. The CLI is a standalone tool that works with any Node.js environment.

#### Basic Operations

```bash
# Add relationships
kg add "Alice" "works_at" "Acme Corp" --type person
kg add "nginx" "proxies_to" "backend-api" --type service

# Set properties
kg prop "Alice" "email" "alice@acme.com"

# Query (multi-hop traversal)
kg query "Alice" --hops 3
kg query "Alice" --format jsonl  # machine-readable output

# Search entities
kg search "backend"
kg search "alice" --format jsonl

# Get full entity details
kg get "Alice"
kg get "nginx" --format jsonl

# Merge duplicates
kg merge "alice" "Alice Smith"

# Maintenance
kg prune --dry-run
kg prune
kg stats

# Export/Import
kg export --format dot | dot -Tpng -o graph.png
kg export --format jsonl > backup.jsonl
kg import backup.jsonl
```

#### Fusion Queries

The `fuse` command queries multiple knowledge sources and merges results using Reciprocal Rank Fusion (RRF):

```bash
# Query with default sources
kg fuse "Alice"

# Use custom sources configuration
kg fuse "backend API" --sources /path/to/sources.json

# Adjust RRF constant (higher = smoother ranking)
kg fuse "nginx" --k 80

# Machine-readable output
kg fuse "Alice" --format jsonl
```

**Default sources config**: `~/.openclaw/kg-fusion-sources.json`

Example sources configuration:

```json
{
  "sources": [
    {
      "id": "factmem",
      "command": "factmem search",
      "format": "jsonl",
      "timeout": 5000
    },
    {
      "id": "grep-notes",
      "command": "grep -r --include='*.md'",
      "format": "lines",
      "timeout": 3000
    }
  ]
}
```

**JSONL Output Contract**: External commands must output one JSON object per line:

```json
{"text": "Alice works at Acme Corp", "score": 0.95, "source": "factmem", "meta": {"timestamp": "2024-01-15"}}
{"text": "Alice's email: alice@acme.com", "score": 0.87, "source": "factmem"}
```

For `"format": "lines"`, each line is treated as a result with score based on position (rank 1 = highest).

#### Maintenance Scripts

Use `kg-maintenance` for cron jobs or periodic cleanup:

```bash
# Full maintenance report
kg-maintenance report

# Prune orphaned entities
kg-maintenance prune --dry-run
kg-maintenance prune

# Find potential duplicates (fuzzy name matching)
kg-maintenance find-duplicates --threshold 0.8
kg-maintenance find-duplicates --threshold 0.9  # stricter matching
```

Recommended cron schedule (daily at 3am):

```cron
0 3 * * * /path/to/kg-maintenance report > /var/log/kg-maintenance.log 2>&1
```

### As an OpenClaw plugin

When installed as a plugin, the knowledge graph provides:

1. **Auto-injection**: Relevant graph context is automatically injected before each agent turn
2. **Stability monitoring**: Loop detection and confabulation checking for agent behavior
3. **Tool registration**: Agents can call `knowledge_graph` tool instead of shelling out to CLI
4. **Fusion integration**: Automatically queries multiple sources and merges results

Add to your OpenClaw configuration:

```json
{
  "plugins": {
    "entries": {
      "knowledge-graph": {
        "enabled": true,
        "config": {
          "dbPath": "/home/clawd/shared/graph.db",
          "autoInject": true,
          "maxHops": 2,
          "maxContextTokens": 500,
          "stability": {
            "loopThreshold": 5,
            "confabulationCheck": true
          },
          "fusion": {
            "enabled": true,
            "k": 60,
            "sources": [
              { "id": "factmem", "command": "factmem search", "format": "jsonl", "timeout": 5000 },
              { "id": "notes", "command": "grep -r --include='*.txt'", "format": "lines", "timeout": 3000 }
            ]
          }
        }
      }
    }
  }
}
```

**Skill-only vs Plugin mode**:

- **Skill-only**: Agents manually call `kg` CLI via exec. No auto-injection, no stability guards. Works without plugin installation.
- **Plugin mode**: Full integration with OpenClaw. Auto-injection, stability monitoring, fusion, and tool registration. Requires plugin configuration.

## Configuration Reference

### Database Path

- **Default**: `/home/clawd/shared/graph.db` (shared across all agents)
- **Override**: Use `--db /path/to/db` flag or `KG_DB_PATH` environment variable
- **Multi-agent**: The shared default ensures all agents access the same knowledge

### Plugin Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dbPath` | string | `/home/clawd/shared/graph.db` | SQLite database path |
| `autoInject` | boolean | `true` | Auto-inject graph context before turns |
| `maxHops` | integer | `2` | Default traversal depth |
| `maxContextTokens` | integer | `500` | Max tokens for injected context |
| `stability.loopThreshold` | integer | `5` | Consecutive identical calls before warning |
| `stability.confabulationCheck` | boolean | `true` | Check for completion claims without tool calls |
| `fusion.enabled` | boolean | `false` | Enable RRF fusion across sources |
| `fusion.k` | integer | `60` | RRF constant (higher = smoother ranking) |
| `fusion.sources` | array | `[]` | External fusion sources (see below) |

### Fusion Source Configuration

Each source in `fusion.sources` is an object with:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | ✓ | Unique identifier for the source |
| `command` | string | ✓ | Shell command to execute (query appended as argument) |
| `format` | string | | Output format: `"jsonl"` (default) or `"lines"` |
| `timeout` | integer | | Timeout in milliseconds (default: 5000) |

**JSONL format**: Each line is a JSON object with `text`, `score`, `source`, and optional `meta`.

**Lines format**: Each line is a result, scored by position (earlier = higher score).

## Testing

```bash
npm test
```

## Architecture

```
index.ts              → Plugin entry (registers tools, hooks)
lib/graph-db.ts       → SQLite graph operations
lib/entity-extract.ts → NLP entity extraction
lib/rrf.ts            → Reciprocal Rank Fusion
lib/stability.ts      → Loop detection + confabulation guard
skills/knowledge-graph/scripts/kg → CLI tool
```

## License

MIT

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

Agents can use the `kg` CLI directly without the plugin:

```bash
# Add relationships
kg add "Alice" "works_at" "Acme Corp" --type person
kg add "nginx" "proxies_to" "backend-api" --type service

# Set properties
kg prop "Alice" "email" "alice@acme.com"

# Query (multi-hop traversal)
kg query "Alice" --hops 3

# Search entities
kg search "backend"

# Get full entity details
kg get "Alice"

# Merge duplicates
kg merge "alice" "Alice Smith"

# Maintenance
kg prune --dry-run
kg stats

# Export/Import
kg export --format dot | dot -Tpng -o graph.png
kg export --format jsonl > backup.jsonl
kg import backup.jsonl
```

### As an OpenClaw plugin

Add to your OpenClaw configuration:

```json
{
  "plugins": {
    "entries": {
      "knowledge-graph": {
        "enabled": true,
        "config": {
          "dbPath": "/path/to/knowledge-graph.db",
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
              { "id": "factmem", "command": "factmem search", "format": "jsonl" }
            ]
          }
        }
      }
    }
  }
}
```

The plugin auto-injects relevant graph context before each agent turn and monitors for loop/confabulation issues.

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dbPath` | string | `~/.openclaw/knowledge-graph.db` | SQLite database path |
| `autoInject` | boolean | `true` | Auto-inject graph context before turns |
| `maxHops` | integer | `2` | Default traversal depth |
| `maxContextTokens` | integer | `500` | Max tokens for injected context |
| `stability.loopThreshold` | integer | `5` | Consecutive identical calls before warning |
| `stability.confabulationCheck` | boolean | `true` | Check for completion claims without tool calls |
| `fusion.enabled` | boolean | `false` | Enable RRF fusion across sources |
| `fusion.k` | integer | `60` | RRF constant (higher = smoother ranking) |
| `fusion.sources` | array | `[]` | External fusion sources |

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

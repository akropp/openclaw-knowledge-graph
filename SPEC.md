# openclaw-knowledge-graph — Build Specification

## Overview

An OpenClaw plugin that provides a shared knowledge graph for multi-agent systems.
Stores entity relationships as triples in SQLite, extracts entities from conversations,
traverses relationships via multi-hop queries, and fuses results from multiple knowledge
sources (graph, memory_search, and arbitrary external sources via CLI commands).

Also includes a lightweight stability guard (loop detection + confabulation catching).

## Architecture

This is a **plugin that ships skills**. It works in two modes:

1. **Skill-only mode**: Agents call the graph CLI manually via exec. No plugin needed.
2. **Plugin mode**: Auto-injection before every agent turn, stability guards, fusion.

## Directory Structure

```
openclaw-knowledge-graph/
├── openclaw.plugin.json          # Plugin manifest (id, configSchema, skills)
├── package.json                  # npm metadata, openclaw.extensions entry
├── tsconfig.json                 # TypeScript config
├── index.ts                      # Plugin entry point
├── lib/
│   ├── graph-db.ts               # SQLite graph operations (CRUD, traversal)
│   ├── entity-extract.ts         # Entity extraction from text
│   ├── rrf.ts                    # Reciprocal Rank Fusion orchestrator
│   └── stability.ts              # Loop detection + confabulation guard
├── skills/
│   └── knowledge-graph/
│       ├── SKILL.md              # Agent instructions for manual CLI use
│       └── scripts/
│           └── kg                # Main CLI entry point (Node.js, chmod +x)
├── test/
│   ├── graph-db.test.ts
│   ├── entity-extract.test.ts
│   ├── rrf.test.ts
│   └── stability.test.ts
└── README.md
```

## Component Specifications

### 1. Graph Database (lib/graph-db.ts)

SQLite database storing entity-relationship triples.

**Schema:**

```sql
CREATE TABLE entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,              -- canonical name (lowercase)
  display_name TEXT NOT NULL,      -- original casing
  entity_type TEXT DEFAULT 'unknown', -- person, place, thing, concept, service, etc.
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(name)
);

CREATE TABLE triples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL REFERENCES entities(id),
  predicate TEXT NOT NULL,         -- relationship type (e.g., "married_to", "works_at", "runs_on")
  object_id INTEGER NOT NULL REFERENCES entities(id),
  confidence REAL DEFAULT 1.0,    -- 0.0-1.0, how certain we are
  source TEXT,                     -- which agent/session added this
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(subject_id, predicate, object_id)
);

-- For literal values that aren't entities (phone numbers, dates, etc.)
CREATE TABLE properties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id INTEGER NOT NULL REFERENCES entities(id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(entity_id, key)
);

CREATE INDEX idx_triples_subject ON triples(subject_id);
CREATE INDEX idx_triples_object ON triples(object_id);
CREATE INDEX idx_triples_predicate ON triples(predicate);
CREATE INDEX idx_properties_entity ON properties(entity_id);
CREATE INDEX idx_entities_name ON entities(name);

-- FTS5 for text search over entity names
CREATE VIRTUAL TABLE entities_fts USING fts5(name, display_name, entity_type);
```

**Key operations:**

- `addEntity(name, type?)` — upsert entity, return id
- `addTriple(subject, predicate, object, opts?)` — upsert triple
- `addProperty(entity, key, value, opts?)` — upsert property
- `query(entityName, hops=2)` — multi-hop traversal via recursive CTE
- `search(text)` — FTS5 search over entity names
- `getEntity(name)` — get entity + all triples + properties
- `merge(entity1, entity2)` — merge duplicate entities (keep both names as aliases)
- `prune(opts?)` — remove orphaned entities with no triples or properties
- `stats()` — entity count, triple count, top predicates, etc.

**Multi-hop traversal (recursive CTE):**

```sql
WITH RECURSIVE hops(entity_id, depth, path) AS (
  SELECT id, 0, name FROM entities WHERE name = ?
  UNION ALL
  SELECT
    CASE WHEN t.subject_id = h.entity_id THEN t.object_id ELSE t.subject_id END,
    h.depth + 1,
    h.path || ' -> ' || t.predicate || ' -> ' || e2.name
  FROM hops h
  JOIN triples t ON t.subject_id = h.entity_id OR t.object_id = h.entity_id
  JOIN entities e2 ON e2.id = CASE WHEN t.subject_id = h.entity_id THEN t.object_id ELSE t.subject_id END
  WHERE h.depth < ? AND e2.name NOT IN (SELECT * FROM used_names)
)
SELECT DISTINCT * FROM hops ORDER BY depth;
```

### 2. Entity Extraction (lib/entity-extract.ts)

Extracts entity names from user messages. Lightweight — no LLM calls.

**Approach:**
- Use `compromise` npm package for NLP (people, places, organizations)
- Pattern matching for known entity types (IPs, hostnames, service names)
- Lookup against existing graph entities (fuzzy match via FTS5)
- Return list of `{ name: string, type: string, confidence: number }`

**Rules:**
- Don't extract common words as entities
- Merge close variants ("Emily" and "emily" → same entity)
- Prioritize entities already in the graph (known > unknown)

### 3. RRF Fusion (lib/rrf.ts)

Reciprocal Rank Fusion across multiple knowledge sources.

**Source types:**

```typescript
interface FusionSource {
  id: string;
  type: 'builtin' | 'command' | 'api';
  // For 'command' type:
  command?: string;           // e.g., "factmem search"
  format?: 'jsonl' | 'lines'; // output format, default jsonl
  timeout?: number;           // ms, default 5000
}

interface FusionResult {
  text: string;
  score: number;
  source: string;
  meta?: Record<string, any>;
}
```

**Built-in sources:**
- `graph` — always present, queries the graph DB directly
- `memory_search` — calls OpenClaw's internal API if available in plugin mode

**External sources (configured):**
- `command` type — shells out, appends query string, reads JSONL/lines from stdout
- Each line of JSONL output: `{"score": 0.9, "text": "...", "source": "factmem", "meta": {}}`
- For `lines` format: each line is a result, scored by position (rank 1 = highest)

**RRF algorithm:**

```typescript
function rrfMerge(resultSets: FusionResult[][], k = 60): FusionResult[] {
  const scores = new Map<string, { score: number; result: FusionResult }>();

  for (const results of resultSets) {
    for (let rank = 0; rank < results.length; rank++) {
      const r = results[rank];
      const key = r.text; // dedup key
      const rrfScore = 1 / (k + rank + 1);
      const existing = scores.get(key);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(key, { score: rrfScore, result: r });
      }
    }
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ score, result }) => ({ ...result, score }));
}
```

### 4. Stability Guard (lib/stability.ts)

Lightweight agent behavior monitoring. Two features:

**Loop detection:**
- Track consecutive identical tool calls within a session
- If same tool called 5+ times in a row, inject warning
- Configurable threshold

**Confabulation detection:**
- Pattern match agent output for completion claims ("I've set up...", "I've configured...", "Done!")
- Cross-reference with actual tool calls in the turn
- If agent claims completion but no relevant tool calls, flag it

Both return warnings as strings that can be injected into context.

### 5. CLI (skills/knowledge-graph/scripts/kg)

Node.js CLI script (hashbang `#!/usr/bin/env node`).

**Commands:**

```
kg add <subject> <predicate> <object> [--type person|place|thing|service|concept]
kg prop <entity> <key> <value>
kg query <entity> [--hops 2] [--format human|jsonl]
kg search <text> [--format human|jsonl]
kg get <entity> [--format human|jsonl]
kg merge <entity1> <entity2>
kg prune [--dry-run]
kg stats
kg export [--format jsonl|dot]
kg import <file>
```

- Default DB path: `~/.openclaw/knowledge-graph.db` (overridable via `--db` or `KG_DB_PATH` env)
- `--format jsonl` outputs fusion-compatible JSONL (for piping to other tools)
- `--format human` outputs readable text (default for interactive use)
- `--format dot` exports Graphviz DOT for visualization

### 6. Plugin Entry (index.ts)

**Registers:**
- `knowledge_graph` agent tool (query/add/search via tool calls, not just exec)
- Pre-turn hook for auto entity extraction + fusion context injection
- Stability hook for loop/confabulation detection
- Background service for nightly maintenance (or expose as cron-friendly command)

**Configuration (via plugin config):**

```json
{
  "plugins": {
    "entries": {
      "knowledge-graph": {
        "enabled": true,
        "config": {
          "dbPath": "/home/clawd/shared/knowledge-graph.db",
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
              { "id": "factmem", "command": "factmem search", "format": "jsonl", "timeout": 5000 }
            ]
          }
        }
      }
    }
  }
}
```

### 7. SKILL.md

The skill instructions should tell agents:
- When to add entities/triples (learning new facts about people/things/services)
- When to query (user asks about relationships, connections, "who/what is X")
- How to use the CLI
- That the graph is shared across agents (be a good citizen)
- Default DB path and how to override

### 8. Plugin Manifest (openclaw.plugin.json)

```json
{
  "id": "knowledge-graph",
  "name": "Knowledge Graph",
  "description": "Shared knowledge graph with entity extraction, multi-hop traversal, and RRF fusion",
  "version": "0.1.0",
  "skills": ["skills/knowledge-graph"],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "dbPath": { "type": "string" },
      "autoInject": { "type": "boolean" },
      "maxHops": { "type": "integer", "minimum": 1, "maximum": 5 },
      "maxContextTokens": { "type": "integer", "minimum": 100 },
      "stability": {
        "type": "object",
        "properties": {
          "loopThreshold": { "type": "integer", "minimum": 2 },
          "confabulationCheck": { "type": "boolean" }
        }
      },
      "fusion": {
        "type": "object",
        "properties": {
          "enabled": { "type": "boolean" },
          "k": { "type": "integer" },
          "sources": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "id": { "type": "string" },
                "command": { "type": "string" },
                "format": { "type": "string", "enum": ["jsonl", "lines"] },
                "timeout": { "type": "integer" }
              },
              "required": ["id", "command"]
            }
          }
        }
      }
    }
  }
}
```

## Dependencies

**npm packages:**
- `better-sqlite3` — SQLite driver (fast, synchronous)
- `compromise` — NLP entity extraction
- `commander` — CLI argument parsing

**Dev dependencies:**
- `vitest` — testing
- `typescript`
- `@types/better-sqlite3`

## Testing

Each module should have unit tests:
- `graph-db.test.ts` — CRUD, traversal, merge, prune (use in-memory SQLite)
- `entity-extract.test.ts` — extraction from sample sentences
- `rrf.test.ts` — fusion scoring, dedup, edge cases
- `stability.test.ts` — loop detection, confabulation patterns

## Build Notes

- TypeScript compiled to JS for distribution
- CLI script (`kg`) should work standalone with just Node.js + better-sqlite3
- Plugin entry loads via jiti (OpenClaw's TS loader), no separate build step needed for plugin mode
- The skill works without the plugin installed (agents just call `kg` via exec)

## What NOT to Build (v1)

- No LLM-based entity extraction (too slow, too expensive per turn)
- No nightshift enrichment yet (save for v2 — just expose `kg prune` and `kg merge` for manual/cron use)
- No embedding-based entity similarity (FTS5 is good enough for now)
- No WebSocket/real-time graph updates
- No graph visualization UI (DOT export is enough)

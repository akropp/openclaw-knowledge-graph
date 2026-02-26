# Knowledge Graph

A shared knowledge graph for storing and querying entity relationships across agents.

## When to Use

**Add entities/triples when you learn NEW, VERIFIED facts:**
- User explicitly tells you about a person, place, organization, or service (e.g., "My name is Alice, I work at Acme Corp")
- You discover relationships between entities through conversation or file inspection
- Configuration facts from actual files/systems: "the API runs on port 8080", "nginx proxies to backend"
- **IMPORTANT**: Only add facts you are CERTAIN about. Do not add speculative or inferred information.
- **IMPORTANT**: Add facts as you learn them, not in bulk afterward. This helps other agents see them sooner.

**Query the graph when:**
- User asks "who is X?", "what is X?", "how is X related to Y?"
- You need context about a person, service, or concept mentioned in conversation
- You want to check if you already know something before asking the user
- Another agent might have already learned this information (check the graph first!)

**When using fusion queries (if enabled in plugin mode):**
- The system automatically queries multiple sources (graph + external tools) and merges results
- Results are ranked by relevance using RRF (Reciprocal Rank Fusion)
- You'll see context injected as `[Knowledge Graph Context]` before your turn
- Use this to avoid re-learning facts that are already known

## CLI Usage

The `kg` command is available at: `scripts/kg`

### Add a relationship
```bash
kg add "Alice" "works_at" "Acme Corp" --type person
kg add "nginx" "proxies_to" "backend-api" --type service
kg add "backend-api" "runs_on" "port 8080"
```

### Set a property
```bash
kg prop "Alice" "email" "alice@acme.com"
kg prop "backend-api" "version" "2.3.1"
```

### Query relationships (multi-hop)
```bash
kg query "Alice"                    # 2-hop default
kg query "Alice" --hops 3           # 3-hop traversal
kg query "Alice" --format jsonl     # machine-readable output
```

### Search entities
```bash
kg search "alice"
kg search "backend" --format jsonl
```

### Get full entity details
```bash
kg get "Alice"
kg get "nginx" --format jsonl
```

### Merge duplicate entities
```bash
kg merge "alice" "Alice Smith"      # Keeps "alice", absorbs "Alice Smith"
```

### Maintenance
```bash
kg prune --dry-run                  # See orphaned entities
kg prune                            # Remove orphans
kg stats                            # Graph statistics
```

### Import/Export
```bash
kg export --format jsonl > backup.jsonl
kg export --format dot | dot -Tpng -o graph.png
kg import backup.jsonl
```

## Configuration

- **Default database**: `/home/clawd/shared/graph.db` (shared across all agents)
- Override with `--db /path/to/db` or `KG_DB_PATH` environment variable
- The shared database ensures all agents have access to the same knowledge

## Best Practices

- **Be a good citizen**: The graph is shared across all agents. Add high-quality, verified facts.
- **Use canonical names**: Lowercase, consistent naming. The graph normalizes names automatically.
- **Set entity types**: Use `--type` when adding to classify entities (person, service, place, concept, etc.).
- **Check before adding**: Use `kg get` or `kg search` to avoid duplicates.
- **Use merge for duplicates**: If you find duplicate entities, merge them with `kg merge`.
- **Add source attribution**: Use `--source` to track which agent/session added a fact.

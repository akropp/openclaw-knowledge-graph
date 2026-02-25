# LLM vs NLP Extraction Comparison

Test file: `gilfoyle/sessions/b00917c0-919d-4a56-aea0-8532845d1cb3.jsonl.reset.2026-02-25T07-50-13.484Z`
Session: 44 messages about building knowledge graph features

## NLP Extraction (compromise.js)

**Command:** `node skills/knowledge-graph/scripts/kg-maintenance test-file <file>`

**Results:**
- 10 unique entities
- No triples extracted (entities only)
- Clean names but missing context

**Entities:**
- Claude Code (person) - 3 mentions
- Emily (person) - 2 mentions
- Matthew (person) - 2 mentions
- github.com (hostname)
- Janine (person)
- Adam (person)
- Chris (person)
- GitHub (organization)
- code.claude.com (hostname)
- Claude (person)

**Issues:**
- No relationships extracted
- Duplicate entities (Claude vs Claude Code)
- Missing full names (Emily vs Emily Kropp)
- Missing key entities (LIM College, photographer role)

## LLM Extraction (Ollama qwen2.5:14b)

**Command:** `node skills/knowledge-graph/scripts/kg-maintenance test-file --llm <file>`

**Results:**
- 20 unique entities
- 24 triples extracted
- Full names and typed relationships

**Key Entities:**
- Emily Kropp (person)
- LIM College (organization)
- Matthew Casey (person)
- photographer (job)
- Claude Code (service)
- factmem (skill)
- memory_search (software_component)

**Sample Triples:**
- Emily Kropp --[studies_at]--> LIM College
- Emily Kropp --[dating]--> Matthew Casey
- Matthew Casey --[works_as]--> photographer
- fusion layer --[works_with]--> graph
- fusion layer --[works_with]--> memory_search

**Advantages:**
- Extracts relationships, not just entities
- Full names (Emily Kropp vs Emily)
- Contextual understanding (photographer as a job, not person)
- Real-world facts vs technical artifacts

**Disadvantages:**
- Slower (~60s for 44 messages in 22 chunks)
- Some false positives (assistant as person, Infrastructure as org)
- Requires Ollama service running

## Configuration

**Ollama Settings:**
- URL: `http://mac-mini.tailcd0984.ts.net:11434`
- Model: `qwen2.5:14b`
- Timeout: 120s (for model loading + inference)
- Temperature: 0 (deterministic)

**Flags:**
- `--llm`: Enable LLM extraction
- `--model <name>`: Override model (default: qwen2.5:14b)
- `--ollama-url <url>`: Override API endpoint

**Chunking:**
- Max chunk size: 2000 characters
- Preserves message boundaries
- 44 messages → 22 chunks

## Recommendation

Use LLM extraction for session files where relationship context matters. Fall back to NLP for:
- Markdown files (simpler structure)
- Quick entity-only extraction
- When Ollama is unavailable

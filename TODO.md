# TODO

## NLP Extraction Quality (Priority: Medium)
The NLP-based entity extraction (compromise.js) works for clean prose but produces
poor results on agent session data and markdown files with mixed technical content.
Current state:
- Text preprocessing strips markdown, code blocks, system metadata — helps a lot
- Post-filter rejects obvious garbage (backticks, arrows, UUIDs, config keys)
- Still misses relationships — only extracts entity names, not triples
- Co-occurrence heuristic creates weak "associated_with" triples but they're noisy

The LLM extraction path (`--llm`) produces dramatically better results — actual
subject/predicate/object triples with correct relationship types. If an LLM endpoint
is configured in `~/.openclaw/kg.json`, it should be the primary extraction method.
NLP is the fallback for environments without LLM access.

### Future improvements to NLP path:
- Better relationship pattern matching (currently very limited regex)
- Train on actual agent conversation patterns
- Smarter co-occurrence: weight by paragraph/section proximity, not just same message
- Entity resolution: "Emily" + "Emily Kropp" should merge
- Predicate normalization: standardize the relationship vocabulary
- Consider switching from compromise.js to a more capable NLP library

## Session Ingest Performance (Priority: Low)
- 10K+ session files with LLM extraction is very slow (~30s per chunk, 22 chunks per file)
- Consider parallel chunk processing (multiple Ollama requests)
- Consider caching — don't re-process sessions that haven't changed
- Add a --since flag to only process sessions newer than a date
- Session file deduplication (*.jsonl.reset.* files may overlap with *.jsonl)

## Plugin Hook API (Priority: Low)
- OpenClaw's plugin SDK has registerHook() but pre_turn/post_turn events may not exist yet
- Once they do, add automatic context injection: query graph before agent turn,
  inject relevant triples as context
- For now, agents use the knowledge_graph tool explicitly

## Graph Visualization (Priority: Low)
- `kg export --format dot` works but could have a web viewer
- Consider adding a simple HTML viewer that renders the graph with d3.js or cytoscape
- Would be useful for debugging and understanding the graph structure

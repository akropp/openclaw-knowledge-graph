import { resolve, basename } from "node:path";
import { createReadStream, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { GraphDB } from "./lib/graph-db.js";
import { loadConfig } from "./lib/config.js";
import { extractEntities, preprocessText } from "./lib/entity-extract.js";
import { extractTriplesWithLLM, type LLMExtractOptions } from "./lib/llm-extract.js";

/**
 * OpenClaw Knowledge Graph Plugin
 *
 * Registers a `knowledge_graph` tool that agents can use to query, add,
 * and search a shared SQLite-backed knowledge graph.
 *
 * Configuration is read from ~/.openclaw/kg.json
 * Use `kg init` or `kg config` to manage settings.
 */

export interface KnowledgeGraphConfig {
  dbPath?: string;
  maxHops?: number;
}

// Build LLMExtractOptions from kg.json config
function getLLMExtractOpts(config: any): LLMExtractOptions | null {
  if (!config.llm?.baseUrl || !config.llm?.model) return null;
  return {
    ollamaUrl: config.llm.baseUrl,
    model: config.llm.model,
    apiKey: config.llm.apiKey,
    verbose: false,
  };
}

// Extract text from a message content field (string or content block array)
function extractTextFromContent(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === "text")
      .map((b) => b.text || "")
      .join("\n");
  }
  return "";
}

// Read messages from a JSONL session file asynchronously
async function readSessionMessages(filePath: string): Promise<Array<{ role: string; text: string }>> {
  const messages: Array<{ role: string; text: string }> = [];
  await new Promise<void>((resolve) => {
    try {
      const rl = createInterface({
        input: createReadStream(filePath, { encoding: "utf-8" }),
        crlfDelay: Infinity,
      });
      rl.on("line", (line) => {
        try {
          const obj = JSON.parse(line);
          if (
            obj.type === "message" &&
            obj.message &&
            (obj.message.role === "user" || obj.message.role === "assistant")
          ) {
            const text = extractTextFromContent(obj.message.content);
            if (text && text.length > 10) {
              messages.push({ role: obj.message.role, text });
            }
          }
        } catch {
          // Skip invalid JSON lines
        }
      });
      rl.on("close", resolve);
      rl.on("error", () => resolve());
    } catch {
      resolve();
    }
  });
  return messages;
}

// Process a single session file: extract triples and ingest into the graph.
// Designed to be called fire-and-forget.
async function processSessionFile(
  filePath: string | undefined,
  graph: GraphDB,
  llmOpts: LLMExtractOptions | null,
  skipIfProcessed: boolean = false,
  logger?: any
): Promise<void> {
  if (!filePath) return;

  // Optionally skip already-processed files (for before_reset)
  if (skipIfProcessed) {
    const state = graph.getIngestState(filePath);
    if (state) {
      logger?.info?.(`kg: skipping already-processed session: ${basename(filePath)}`);
      return;
    }
  }

  // Read messages from the session file
  const messages = await readSessionMessages(filePath);
  if (messages.length === 0) {
    // Mark empty files as processed
    try {
      const st = statSync(filePath);
      graph.setIngestState(filePath, st.mtime.toISOString(), st.size);
    } catch {}
    return;
  }

  const combined = messages.map((m) => `[${m.role}]: ${m.text}`).join("\n\n");
  const cleaned = preprocessText(combined);

  // Pre-filter: if no entities detected, skip LLM call
  const entities = extractEntities(cleaned);
  if (entities.length === 0) {
    logger?.info?.(`kg: no entities in session ${basename(filePath)}, skipping ingestion`);
    try {
      const st = statSync(filePath);
      graph.setIngestState(filePath, st.mtime.toISOString(), st.size);
    } catch {}
    return;
  }

  const source = `session:${basename(filePath)}`;

  if (llmOpts) {
    // LLM-based triple extraction
    const triples = await extractTriplesWithLLM(cleaned, llmOpts);
    if (triples.length > 0) {
      graph.batch(() => {
        for (const triple of triples) {
          graph.addEntity(triple.subject, triple.subject_type || "unknown");
          graph.addEntity(triple.object, triple.object_type || "unknown");
          graph.addTriple(triple.subject, triple.predicate, triple.object, {
            confidence: 0.9,
            source,
          });
        }
      });
      logger?.info?.(`kg: ingested ${triples.length} triples from ${basename(filePath)}`);
    }
  } else {
    // NLP-only fallback: just store the extracted entities (no relationship triples)
    graph.batch(() => {
      for (const entity of entities) {
        graph.addEntity(entity.name, entity.type);
      }
    });
    logger?.info?.(`kg: NLP-only ingestion — ${entities.length} entities from ${basename(filePath)}`);
  }

  // Mark file as processed
  try {
    const st = statSync(filePath);
    graph.setIngestState(filePath, st.mtime.toISOString(), st.size);
  } catch {}
}

// Format KG query results as a concise context block for injection into the prompt.
// Uses graph.getEntity() for clean direct-relationship output.
function formatKGContext(entityNames: string[], graph: GraphDB): string | null {
  const lines: string[] = [];

  for (const name of entityNames) {
    try {
      const detail = graph.getEntity(name);
      if (!detail) continue;

      const parts: string[] = [];

      // Outgoing/incoming relationships (skip pure property predicates)
      for (const t of detail.triples) {
        if (parts.length >= 6) break; // cap at 6 facts per entity
        parts.push(`${t.predicate} ${t.related_name}`);
      }

      // A few properties (phone, email, age, etc.)
      for (const p of detail.properties.slice(0, 2)) {
        parts.push(`${p.key}=${p.value}`);
      }

      if (parts.length > 0) {
        lines.push(`${detail.entity.display_name}: ${parts.join(", ")}`);
      }
    } catch {
      // Ignore per-entity errors
    }
  }

  if (lines.length === 0) return null;
  return `[Knowledge Graph Context]\n${lines.join("\n")}`;
}

// Plugin entry point — matches OpenClaw's real plugin API
export default function register(api: any): void {
  // Load config from ~/.openclaw/kg.json instead of gateway plugin config
  const config = loadConfig();
  const graph = new GraphDB(config.dbPath);
  const llmOpts = getLLMExtractOpts(config);
  const maxHops = config.maxHops ?? 2;

  const log = (level: "info" | "warn", msg: string) => {
    if (api.logger?.[level]) {
      api.logger[level](msg);
    } else {
      console[level === "warn" ? "warn" : "log"](msg);
    }
  };

  // Warn if LLM is not configured — NLP-only ingestion is lower quality
  if (!llmOpts) {
    log("warn", "kg: LLM not configured in ~/.openclaw/kg.json — session ingestion will be NLP-only (lower quality). Set llm.baseUrl and llm.model for full extraction.");
  } else {
    log("info", `kg: LLM configured (model=${llmOpts.model}), hooks active`);
  }

  api.registerTool({
    name: "knowledge_graph",
    label: "Knowledge Graph",
    description:
      "Query, add, or search the shared knowledge graph. Supports entity lookup, triple creation, multi-hop traversal, and text search.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["query", "add", "search", "get", "add_property", "stats"],
          description: "The action to perform",
        },
        entity: {
          type: "string",
          description: "Entity name for query/get/add_property",
        },
        subject: {
          type: "string",
          description: "Subject entity for add",
        },
        predicate: {
          type: "string",
          description: "Relationship type for add",
        },
        object: {
          type: "string",
          description: "Object entity for add",
        },
        entity_type: {
          type: "string",
          description: "Entity type (person, place, service, organization, concept)",
        },
        key: {
          type: "string",
          description: "Property key for add_property",
        },
        value: {
          type: "string",
          description: "Property value for add_property",
        },
        text: {
          type: "string",
          description: "Search text",
        },
        hops: {
          type: "integer",
          description: "Number of hops for query (default 2)",
          default: 2,
        },
        kind: {
          type: "string",
          enum: ["relationships", "properties", "all"],
          description: "Filter query results: relationships (exclude has_* predicates), properties (only has_* predicates), or all (default)",
          default: "all",
        },
        confidence: {
          type: "number",
          description: "Confidence score 0-1 for add (default 1.0)",
          default: 1.0,
        },
        source: {
          type: "string",
          description: "Source identifier (agent name, session, etc.)",
        },
      },
      required: ["action"],
    },
    execute(_toolCallId: string, params: Record<string, unknown>) {
      const json = (payload: unknown) => ({
        content: [
          { type: "text" as const, text: JSON.stringify(payload, null, 2) },
        ],
        details: payload,
      });

      try {
        switch (params.action) {
          case "query": {
            const results = graph.query(
              params.entity as string,
              (params.hops as number) || 2,
              { kind: params.kind as "relationships" | "properties" | "all" | undefined },
            );
            return json(results);
          }
          case "add": {
            const subjectType = params.entity_type as string | undefined;
            if (subjectType) {
              graph.addEntity(params.subject as string, subjectType);
            }
            const id = graph.addTriple(
              params.subject as string,
              params.predicate as string,
              params.object as string,
              {
                confidence: (params.confidence as number) ?? 1.0,
                source: params.source as string,
              },
            );
            return json({
              ok: true,
              tripleId: id,
              subject: params.subject,
              predicate: params.predicate,
              object: params.object,
            });
          }
          case "search": {
            const results = graph.search(params.text as string);
            return json(results);
          }
          case "get": {
            const detail = graph.getEntity(params.entity as string);
            if (!detail) {
              return json({ error: `Entity "${params.entity}" not found` });
            }
            return json(detail);
          }
          case "add_property": {
            const id = graph.addProperty(
              params.entity as string,
              params.key as string,
              params.value as string,
              { source: params.source as string },
            );
            return json({ ok: true, propertyId: id });
          }
          case "stats": {
            return json(graph.stats());
          }
          default:
            return json({ error: `Unknown action: ${params.action}` });
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return json({ error: message });
      }
    },
  });

  // ── Hook: inject KG context before each agent turn ─────────────────────────
  // Fast path: local SQLite queries + NLP only. No LLM calls. No network.
  api.on("before_prompt_build", async (event: any, _ctx: any) => {
    try {
      const prompt: string = event?.prompt;
      if (!prompt || prompt.length < 5) return undefined;

      // Extract entity names from the prompt (NLP, fast)
      const entities = extractEntities(prompt, graph);
      if (entities.length === 0) return undefined;

      // Collect unique entity names sorted by confidence
      const entityNames = entities
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 8) // cap at 8 entities to keep context tight
        .map((e) => e.name);

      const context = formatKGContext(entityNames, graph);
      if (!context) return undefined;

      log("info", `kg: injecting context for ${entityNames.length} entities`);
      return { prependContext: context };
    } catch (err) {
      log("warn", `kg: before_prompt_build error: ${err}`);
      return undefined;
    }
  });

  // ── Hook: ingest session on compaction ─────────────────────────────────────
  // Fire-and-forget — do NOT block the compaction.
  api.on("before_compaction", async (event: any, _ctx: any) => {
    const sessionFile: string | undefined = event?.sessionFile;
    // Fire-and-forget: intentionally not awaited
    processSessionFile(sessionFile, graph, llmOpts, false, api.logger).catch((err) => {
      log("warn", `kg: session ingest failed (compaction): ${err}`);
    });
    // Return immediately — do not block compaction
  });

  // ── Hook: ingest session on reset ──────────────────────────────────────────
  // Same as compaction but skips files already processed.
  api.on("before_reset", async (event: any, _ctx: any) => {
    const sessionFile: string | undefined = event?.sessionFile;
    processSessionFile(sessionFile, graph, llmOpts, true, api.logger).catch((err) => {
      log("warn", `kg: session ingest failed (reset): ${err}`);
    });
    // Return immediately — do not block reset
  });
}

// Re-export library modules for programmatic use
export { GraphDB } from "./lib/graph-db.js";
export { extractEntities } from "./lib/entity-extract.js";
export { rrfMerge, fuse } from "./lib/rrf.js";
export { StabilityGuard } from "./lib/stability.js";

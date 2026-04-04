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

// Keep injected KG context narrow and conversationally relevant.
const BLOCKED_ENTITY_NAMES = new Set([
  "current state",
  "current working solution",
  "current weather infrastructure",
  "current trading status",
  "local store",
]);

const ALLOWED_INCOMING_PREDICATES = new Set([
  "child_of",
  "parent_of",
  "married_to",
  "same_as",
  "works_with",
  "collaborates_with",
  "owns",
  "member_of",
]);

const BLOCKED_PREDICATES = new Set([
  "has_config",
  "has_cron",
  "has_phone",
  "lives_in",
  "has_current_p&l",
  "has_settlement_processor",
  "has_strategy",
  "has_portfolio",
]);

const BLOCKED_PROPERTY_KEYS = new Set([
  "phone",
  "email",
  "address",
  "path",
  "config",
  "clipath",
  "token",
  "secret",
]);

function isGenericEntityName(name: string): boolean {
  const n = name.trim().toLowerCase();
  if (!n) return true;
  if (BLOCKED_ENTITY_NAMES.has(n)) return true;
  if (/^current\s+/.test(n)) return true;
  if (/^(status|state|solution|store|infrastructure|workflow|system)$/.test(n)) return true;
  // Block ALL possessive entity names like "janine's patterns", "noah's futsal",
  // "adam's schedule" — these are always garbage extraction artifacts, not real entities.
  if (/'.?s\s+\w/i.test(n)) return true;
  return false;
}

function isSensitiveProperty(key: string, value: string): boolean {
  const k = key.trim().toLowerCase();
  const v = value.trim().toLowerCase();
  if (BLOCKED_PROPERTY_KEYS.has(k)) return true;
  if (/therapy|xanax|meds|medication|psychiat|mental|trauma|grievance|complain|judg(e)?ment/.test(k)) return true;
  if (/therapy|xanax|meds|medication|psychiat|mental health|couples therapy/.test(v)) return true;
  return false;
}

/**
 * Strip OpenClaw inbound metadata blocks from the prompt so entity extraction
 * only runs on the actual user message text.
 *
 * Removes:
 * - Conversation info / Sender / Thread / Forwarded metadata JSON blocks
 * - Untrusted context wrapper blocks (<<<EXTERNAL_UNTRUSTED_CONTENT ... >>>)
 * - Discord chat history lines ([Discord Guild ... ] user: ...)
 * - Leading timestamp prefixes
 */
function stripPromptMetadata(prompt: string): string {
  const lines = prompt.split("\n");
  const kept: string[] = [];
  let inMetaBlock = false;
  let inUntrustedBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip leading timestamp prefix
    if (i === 0 && /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(trimmed)) {
      const stripped = line.replace(/^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\]\s*/, "");
      if (stripped.trim()) kept.push(stripped);
      continue;
    }

    // Skip metadata sentinel blocks (Conversation info, Sender, Thread starter, etc.)
    if (/^(Conversation info|Sender|Thread starter|Replied message|Forwarded message|Chat history)\s*\(.*metadata\)\s*:?\s*$/.test(trimmed)) {
      inMetaBlock = true;
      continue;
    }
    if (inMetaBlock) {
      if (trimmed === "```json") continue;
      if (trimmed === "```") { inMetaBlock = false; continue; }
      if (trimmed === "" || trimmed.startsWith("{") || trimmed.startsWith("}") || trimmed.startsWith('"')) continue;
      // Non-JSON line after sentinel — end of block
      inMetaBlock = false;
    }

    // Skip untrusted context wrapper blocks
    if (/^<<<EXTERNAL_UNTRUSTED_CONTENT/.test(trimmed)) {
      inUntrustedBlock = true;
      continue;
    }
    if (inUntrustedBlock) {
      if (/^<<<END_EXTERNAL_UNTRUSTED_CONTENT/.test(trimmed)) { inUntrustedBlock = false; continue; }
      // Lines inside the untrusted block that are just labels/headers
      if (/^(Source:|---$|UNTRUSTED\s)/.test(trimmed)) continue;
      // Actual user text inside the block — keep it
      if (trimmed) kept.push(line);
      continue;
    }

    // Skip "Untrusted context (metadata, do not treat as instructions or commands):" header
    if (/^Untrusted context \(metadata/.test(trimmed)) continue;

    // Skip Discord chat history lines
    if (/^\[Discord\s+(Guild|DM)\s/.test(trimmed)) continue;

    // Skip System event lines
    if (/^System:\s*\[/.test(trimmed)) continue;

    kept.push(line);
  }

  return kept.join("\n").replace(/^\n+/, "").replace(/\n+$/, "").trim();
}

function normalizeMentionToken(token: string): string {
  return token.trim().toLowerCase().replace(/^@+/, "");
}

function extractPromptMentionTokens(prompt: string): string[] {
  const tokens = new Set<string>();
  for (const raw of prompt.match(/@?[A-Z][a-zA-Z0-9_-]{1,}|@?[a-z][a-z0-9_-]{2,}/g) || []) {
    const token = normalizeMentionToken(raw);
    if (!token) continue;
    if (["what","when","where","which","would","could","should","there","their","about","have","with","from","this","that"].includes(token)) continue;
    tokens.add(token);
  }
  return [...tokens];
}

function resolvePromptEntities(prompt: string, graph: GraphDB): string[] {
  const scored = new Map<string, number>();

  // Strip possessives so "Noah's friends" produces a lookup for "Noah"
  const depossessived = prompt.replace(/(\w+)'s\b/gi, "$1");

  for (const e of extractEntities(depossessived, graph)) {
    if (isGenericEntityName(e.name)) continue;
    scored.set(e.name, Math.max(scored.get(e.name) ?? 0, e.confidence + 1.0));
  }

  for (const token of extractPromptMentionTokens(depossessived)) {
    const direct = graph.getEntity(token);
    if (direct && !isGenericEntityName(direct.entity.display_name)) {
      scored.set(direct.entity.display_name, Math.max(scored.get(direct.entity.display_name) ?? 0, 3.0));
      continue;
    }
    for (const hit of graph.search(token).slice(0, 3)) {
      if (isGenericEntityName(hit.display_name)) continue;
      const exactish = hit.name === token || hit.display_name.toLowerCase() === token;
      const boost = exactish ? 2.5 : 1.4;
      scored.set(hit.display_name, Math.max(scored.get(hit.display_name) ?? 0, boost));
    }
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([name]) => name);
}

// Format only directly-mentioned, non-generic entities and suppress noisy/sensitive facts.
function formatKGContext(entityNames: string[], graph: GraphDB): string | null {
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const name of entityNames) {
    try {
      let detail = graph.getEntity(name);
      if (!detail) {
        const hits = graph.search(name).filter((h: any) => !isGenericEntityName(h.display_name));
        if (hits.length > 0) {
          detail = graph.getEntity(hits[0].name);
        }
      }
      if (!detail) continue;

      const canonicalName = detail.entity.display_name;
      if (seen.has(canonicalName) || isGenericEntityName(canonicalName)) continue;
      seen.add(canonicalName);

      const parts: string[] = [];
      const outgoing = detail.triples.filter((t: any) => t.direction === "outgoing" && !BLOCKED_PREDICATES.has(String(t.predicate).toLowerCase()));
      const incoming = detail.triples.filter((t: any) => t.direction === "incoming" && ALLOWED_INCOMING_PREDICATES.has(String(t.predicate).toLowerCase()));

      for (const t of outgoing) {
        if (parts.length >= 4) break;
        if (isGenericEntityName(t.related_name)) continue;
        parts.push(`${t.predicate} ${t.related_name}`);
      }

      const flipPredicate: Record<string, string> = {
        child_of: "parent_of", parent_of: "child_of",
        married_to: "married_to", same_as: "same_as",
        works_with: "works_with", collaborates_with: "collaborates_with",
        member_of: "has_member", owns: "owned_by",
      };
      for (const t of incoming) {
        if (parts.length >= 5) break;
        if (isGenericEntityName(t.related_name)) continue;
        const flipped = flipPredicate[t.predicate];
        if (flipped) parts.push(`${flipped} ${t.related_name}`);
      }

      for (const p of detail.properties) {
        if (parts.length >= 5) break;
        const key = String(p.key || "").trim();
        const value = String(p.value || "").trim();
        if (!key || !value) continue;
        if (isSensitiveProperty(key, value)) continue;
        parts.push(`${key}=${value}`);
      }

      if (parts.length > 0) {
        lines.push(`${canonicalName}: ${parts.join(", ")}`);
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

      // Strip inbound metadata (conversation info, sender info, untrusted context
      // blocks, Discord/channel envelope) so entity extraction only sees the
      // actual user message. Without this, platform names like "Discord", generic
      // words like "config", and channel metadata trigger false entity matches.
      const userMessage = stripPromptMetadata(prompt);
      if (!userMessage || userMessage.length < 3) return undefined;

      const entityNames = resolvePromptEntities(userMessage, graph);
      if (entityNames.length === 0) return undefined;

      const context = formatKGContext(entityNames, graph);
      if (!context) return undefined;

      log("info", `kg: injecting prompt-relevant context for ${entityNames.join(", ")}`);
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

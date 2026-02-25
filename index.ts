import { resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { GraphDB } from "./lib/graph-db.js";

/**
 * OpenClaw Knowledge Graph Plugin
 *
 * Registers a `knowledge_graph` tool that agents can use to query, add,
 * and search a shared SQLite-backed knowledge graph.
 *
 * For auto-injection / fusion, use the skill CLI (kg, kg-maintenance)
 * or configure fusion sources in the plugin config.
 */

export interface KnowledgeGraphConfig {
  dbPath?: string;
  maxHops?: number;
}

function getDbPath(config: KnowledgeGraphConfig): string {
  if (config.dbPath) return resolve(config.dbPath);
  // Default: shared multi-agent database
  const sharedDir = resolve(
    process.env.HOME || "/home/clawd",
    "shared",
  );
  if (!existsSync(sharedDir)) mkdirSync(sharedDir, { recursive: true });
  return resolve(sharedDir, "graph.db");
}

// Plugin entry point — matches OpenClaw's real plugin API
export default function register(api: any): void {
  const config: KnowledgeGraphConfig = api.config ?? {};
  const dbPath = getDbPath(config);
  const graph = new GraphDB(dbPath);

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
              (params.hops as number) || config.maxHops || 2,
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
}

// Re-export library modules for programmatic use
export { GraphDB } from "./lib/graph-db.js";
export { extractEntities } from "./lib/entity-extract.js";
export { rrfMerge, fuse } from "./lib/rrf.js";
export { StabilityGuard } from "./lib/stability.js";

import { resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync } from "node:fs";
import { GraphDB } from "./lib/graph-db.js";
import { extractEntities } from "./lib/entity-extract.js";
import { fuse, type FusionSource } from "./lib/rrf.js";
import { StabilityGuard, type ToolCall } from "./lib/stability.js";

export interface KnowledgeGraphConfig {
  dbPath?: string;
  autoInject?: boolean;
  maxHops?: number;
  maxContextTokens?: number;
  stability?: {
    loopThreshold?: number;
    confabulationCheck?: boolean;
  };
  fusion?: {
    enabled?: boolean;
    k?: number;
    sources?: Array<{
      id: string;
      command: string;
      format?: "jsonl" | "lines";
      timeout?: number;
    }>;
  };
}

export interface PluginContext {
  config: KnowledgeGraphConfig;
  registerTool?: (name: string, handler: ToolHandler) => void;
  registerHook?: (event: string, handler: HookHandler) => void;
}

export interface ToolHandler {
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => unknown;
}

export type HookHandler = (ctx: HookContext) => string | null | void;

export interface HookContext {
  userMessage?: string;
  agentOutput?: string;
  toolCalls?: ToolCall[];
}

function getDbPath(config: KnowledgeGraphConfig): string {
  if (config.dbPath) return resolve(config.dbPath);
  const dir = resolve(homedir(), ".openclaw");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return resolve(dir, "knowledge-graph.db");
}

export function activate(ctx: PluginContext): void {
  const config = ctx.config;
  const dbPath = getDbPath(config);
  const graph = new GraphDB(dbPath);
  const guard = new StabilityGuard(config.stability);

  // Register the knowledge_graph tool
  if (ctx.registerTool) {
    ctx.registerTool("knowledge_graph", {
      description:
        "Query, add, or search the shared knowledge graph. Supports entity lookup, triple creation, multi-hop traversal, and text search.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "query",
              "add",
              "search",
              "get",
              "add_property",
              "stats",
            ],
            description: "The action to perform",
          },
          entity: { type: "string", description: "Entity name for query/get/add_property" },
          subject: { type: "string", description: "Subject entity for add" },
          predicate: { type: "string", description: "Relationship type for add" },
          object: { type: "string", description: "Object entity for add" },
          entity_type: { type: "string", description: "Entity type" },
          key: { type: "string", description: "Property key for add_property" },
          value: { type: "string", description: "Property value for add_property" },
          text: { type: "string", description: "Search text" },
          hops: { type: "integer", description: "Number of hops for query", default: 2 },
          confidence: { type: "number", description: "Confidence for add", default: 1.0 },
          source: { type: "string", description: "Source identifier" },
        },
        required: ["action"],
      },
      handler: (args) => {
        switch (args.action) {
          case "query":
            return graph.query(
              args.entity as string,
              (args.hops as number) || config.maxHops || 2
            );
          case "add":
            return graph.addTriple(
              args.subject as string,
              args.predicate as string,
              args.object as string,
              {
                confidence: args.confidence as number,
                source: args.source as string,
              }
            );
          case "search":
            return graph.search(args.text as string);
          case "get":
            return graph.getEntity(args.entity as string);
          case "add_property":
            return graph.addProperty(
              args.entity as string,
              args.key as string,
              args.value as string,
              { source: args.source as string }
            );
          case "stats":
            return graph.stats();
          default:
            return { error: `Unknown action: ${args.action}` };
        }
      },
    });
  }

  // Pre-turn hook: auto entity extraction + fusion context injection
  if (ctx.registerHook && config.autoInject !== false) {
    ctx.registerHook("pre_turn", (hookCtx: HookContext) => {
      if (!hookCtx.userMessage) return null;

      const entities = extractEntities(hookCtx.userMessage, graph);
      if (entities.length === 0) return null;

      const fusionSources: FusionSource[] = (config.fusion?.sources || []).map(
        (s) => ({
          ...s,
          type: "command" as const,
        })
      );

      const queryText = entities.map((e) => e.name).join(" ");

      let context = "";

      if (config.fusion?.enabled && fusionSources.length > 0) {
        const results = fuse(queryText, {
          graph,
          sources: fusionSources,
          k: config.fusion.k,
        });

        if (results.length > 0) {
          context = `[Knowledge Graph Context]\n${results
            .slice(0, 10)
            .map((r) => `- (${r.source}, score: ${r.score.toFixed(3)}) ${r.text}`)
            .join("\n")}`;
        }
      } else {
        // Graph-only mode
        const results: string[] = [];
        for (const entity of entities) {
          const detail = graph.getEntity(entity.name);
          if (detail) {
            const parts = [`${detail.entity.display_name} (${detail.entity.entity_type})`];
            for (const t of detail.triples) {
              parts.push(
                t.direction === "outgoing"
                  ? `  ${t.predicate} -> ${t.related_name}`
                  : `  <- ${t.predicate} - ${t.related_name}`
              );
            }
            for (const p of detail.properties) {
              parts.push(`  ${p.key}: ${p.value}`);
            }
            results.push(parts.join("\n"));
          }
        }

        if (results.length > 0) {
          context = `[Knowledge Graph Context]\n${results.join("\n\n")}`;
        }
      }

      // Rough token limit
      const maxTokens = config.maxContextTokens || 500;
      if (context.length > maxTokens * 4) {
        context = context.slice(0, maxTokens * 4) + "\n...truncated";
      }

      return context || null;
    });
  }

  // Stability hook
  if (ctx.registerHook) {
    ctx.registerHook("post_turn", (hookCtx: HookContext) => {
      const warnings = guard.check(
        hookCtx.agentOutput || "",
        hookCtx.toolCalls || []
      );
      return warnings.length > 0 ? warnings.join("\n") : null;
    });
  }
}

export { GraphDB } from "./lib/graph-db.js";
export { extractEntities } from "./lib/entity-extract.js";
export { rrfMerge, fuse } from "./lib/rrf.js";
export { StabilityGuard } from "./lib/stability.js";

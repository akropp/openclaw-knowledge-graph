import { execSync } from "node:child_process";
import type { GraphDB } from "./graph-db.js";

export interface FusionSource {
  id: string;
  type: "builtin" | "command" | "api";
  command?: string;
  format?: "jsonl" | "lines";
  timeout?: number;
}

export interface FusionResult {
  text: string;
  score: number;
  source: string;
  meta?: Record<string, unknown>;
}

export function rrfMerge(
  resultSets: FusionResult[][],
  k: number = 60
): FusionResult[] {
  const scores = new Map<string, { score: number; result: FusionResult }>();

  for (const results of resultSets) {
    for (let rank = 0; rank < results.length; rank++) {
      const r = results[rank];
      const key = r.text;
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

function queryGraph(graph: GraphDB, queryText: string): FusionResult[] {
  const results: FusionResult[] = [];

  // Search entities
  const entities = graph.search(queryText);
  for (const entity of entities) {
    const detail = graph.getEntity(entity.name);
    if (!detail) continue;

    const parts: string[] = [`${detail.entity.display_name} (${detail.entity.entity_type})`];

    for (const t of detail.triples) {
      if (t.direction === "outgoing") {
        parts.push(`  ${t.predicate} -> ${t.related_name}`);
      } else {
        parts.push(`  <- ${t.predicate} - ${t.related_name}`);
      }
    }

    for (const p of detail.properties) {
      parts.push(`  ${p.key}: ${p.value}`);
    }

    results.push({
      text: parts.join("\n"),
      score: 1.0,
      source: "graph",
      meta: { entity_name: entity.name, entity_type: entity.entity_type },
    });
  }

  // Also try multi-hop queries for each entity found
  for (const entity of entities.slice(0, 3)) {
    const hops = graph.query(entity.name, 2);
    for (const hop of hops) {
      if (hop.depth > 0) {
        results.push({
          text: hop.path,
          score: 0.8 / hop.depth,
          source: "graph",
          meta: { hop_depth: hop.depth },
        });
      }
    }
  }

  return results;
}

function queryCommand(
  source: FusionSource,
  queryText: string
): FusionResult[] {
  if (!source.command) return [];

  try {
    const timeout = source.timeout ?? 5000;
    const output = execSync(`${source.command} ${JSON.stringify(queryText)}`, {
      timeout,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (!output) return [];

    const lines = output.split("\n").filter(Boolean);

    if (source.format === "lines") {
      return lines.map((line, i) => ({
        text: line,
        score: 1.0 / (i + 1),
        source: source.id,
      }));
    }

    // Default: jsonl
    return lines
      .map((line) => {
        try {
          const parsed = JSON.parse(line);
          return {
            text: String(parsed.text || line),
            score: Number(parsed.score) || 0.5,
            source: parsed.source || source.id,
            meta: parsed.meta,
          } as FusionResult;
        } catch {
          return { text: line, score: 0.5, source: source.id } as FusionResult;
        }
      });
  } catch {
    return [];
  }
}

export interface FuseOptions {
  graph?: GraphDB;
  sources?: FusionSource[];
  k?: number;
}

export function fuse(queryText: string, opts: FuseOptions): FusionResult[] {
  const resultSets: FusionResult[][] = [];

  // Built-in: graph
  if (opts.graph) {
    resultSets.push(queryGraph(opts.graph, queryText));
  }

  // External sources
  if (opts.sources) {
    for (const source of opts.sources) {
      if (source.type === "command") {
        resultSets.push(queryCommand(source, queryText));
      }
    }
  }

  return rrfMerge(resultSets, opts.k);
}

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";

export const CONFIG_PATH = resolve(homedir(), ".openclaw", "kg.json");

export interface KGConfig {
  dbPath: string;
  maxHops: number;
  llm?: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    chunkSize?: number;
  };
}

const DEFAULT_CONFIG: KGConfig = {
  dbPath: resolve(homedir(), ".openclaw", "knowledge-graph.db"),
  maxHops: 2,
};

/**
 * Load configuration from ~/.openclaw/kg.json
 * Returns defaults for missing fields
 */
export function loadConfig(): KGConfig {
  if (!existsSync(CONFIG_PATH)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const content = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(content);

    // Merge with defaults for missing fields
    return {
      dbPath: parsed.dbPath ?? DEFAULT_CONFIG.dbPath,
      maxHops: parsed.maxHops ?? DEFAULT_CONFIG.maxHops,
      llm: parsed.llm ? {
        baseUrl: parsed.llm.baseUrl,
        model: parsed.llm.model,
        apiKey: parsed.llm.apiKey,
      } : undefined,
    };
  } catch (err) {
    console.error(`Warning: Failed to parse ${CONFIG_PATH}:`, err);
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Save configuration to ~/.openclaw/kg.json
 */
export function saveConfig(config: KGConfig): void {
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Expand tilde in dbPath if present
  let dbPath = config.dbPath;
  if (dbPath.startsWith("~/")) {
    dbPath = resolve(homedir(), dbPath.slice(2));
  }

  const output: any = {
    dbPath,
    maxHops: config.maxHops,
  };

  if (config.llm && (config.llm.baseUrl || config.llm.model || config.llm.apiKey)) {
    output.llm = config.llm;
  }

  writeFileSync(CONFIG_PATH, JSON.stringify(output, null, 2) + "\n", "utf-8");
}

/**
 * Get a nested config value using dot notation
 * e.g., "llm.baseUrl" => config.llm?.baseUrl
 */
export function getConfigValue(config: KGConfig, key: string): unknown {
  const parts = key.split(".");
  let value: any = config;

  for (const part of parts) {
    if (value === null || value === undefined) {
      return undefined;
    }
    value = value[part];
  }

  return value;
}

/**
 * Set a nested config value using dot notation
 * e.g., "llm.baseUrl" sets config.llm.baseUrl
 */
export function setConfigValue(config: KGConfig, key: string, value: string): void {
  const parts = key.split(".");
  let target: any = config;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in target) || typeof target[part] !== "object") {
      target[part] = {};
    }
    target = target[part];
  }

  const lastKey = parts[parts.length - 1];

  // Type coercion for known numeric fields
  if (lastKey === "maxHops") {
    target[lastKey] = parseInt(value, 10);
  } else {
    target[lastKey] = value;
  }
}

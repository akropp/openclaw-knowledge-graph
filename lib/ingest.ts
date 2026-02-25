import { readdirSync, statSync, readFileSync, existsSync, createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import Database from "better-sqlite3";
import type { GraphDB } from "./graph-db.js";
import { extractEntities } from "./entity-extract.js";
import { extractTriplesWithLLM, chunkMessages, type LLMExtractOptions } from "./llm-extract.js";

export interface IngestStats {
  filesProcessed: number;
  entitiesAdded: number;
  triplesAdded: number;
  propertiesAdded: number;
  factsProcessed: number;
  sessionsProcessed: number;
  messagesProcessed: number;
  errors: string[];
}

export interface IngestOptions {
  dryRun?: boolean;
  verbose?: boolean;
  useLLM?: boolean;
  ollamaUrl?: string;
  model?: string;
}

// Normalize factmem keys to predicates
const FACT_KEY_MAP: Record<string, string> = {
  phone: "has_phone",
  mobile: "has_phone",
  cell: "has_phone",
  email: "has_email",
  school: "studies_at",
  university: "studies_at",
  college: "studies_at",
  work: "works_at",
  employer: "works_at",
  company: "works_at",
  location: "lives_in",
  address: "lives_in",
  city: "lives_in",
  birthday: "born_on",
  birthdate: "born_on",
  age: "has_age",
  spouse: "married_to",
  partner: "married_to",
  child: "parent_of",
  parent: "child_of",
  sibling: "sibling_of",
  friend: "friend_of",
  manager: "reports_to",
  title: "has_title",
  role: "has_role",
};

function normalizePredicate(key: string): string {
  const normalized = key.toLowerCase().trim().replace(/\s+/g, "_");
  return FACT_KEY_MAP[normalized] || `has_${normalized}`;
}

// Find all session JSONL files
function findSessionFiles(baseDir: string = "/home/clawd/.openclaw/agents"): string[] {
  if (!existsSync(baseDir)) return [];

  const results: string[] = [];
  try {
    const agents = readdirSync(baseDir);
    for (const agent of agents) {
      const sessionsDir = join(baseDir, agent, "sessions");
      if (!existsSync(sessionsDir)) continue;

      try {
        const entries = readdirSync(sessionsDir);
        for (const entry of entries) {
          if (entry.endsWith(".jsonl") || entry.match(/\.jsonl\.reset\.\d+$/)) {
            results.push(join(sessionsDir, entry));
          }
        }
      } catch {
        // Skip directories we can't read
      }
    }
  } catch {
    // Skip if base directory can't be read
  }
  return results;
}

// Extract text content from message content (string or content blocks)
function extractTextFromContent(content: any): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((block) => block.type === "text")
      .map((block) => block.text || "")
      .join("\n");
  }
  return "";
}

interface Triple {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
}

interface Property {
  entity: string;
  key: string;
  value: string;
}

/**
 * Extract relationship patterns from text containing multiple entities
 */
function extractRelationships(
  text: string,
  entities: Array<{ name: string; type: string; confidence: number }>
): { triples: Triple[]; properties: Property[] } {
  const triples: Triple[] = [];
  const properties: Property[] = [];

  if (entities.length < 1) return { triples, properties };

  const textLower = text.toLowerCase();

  // Pattern 1: "X is Y's [relationship]"
  for (const entity1 of entities) {
    const regex1 = new RegExp(
      `${entity1.name}\\s+is\\s+([A-Z][a-z]+(?:\\s[A-Z][a-z]+)?)'s\\s+(\\w+)`,
      "gi"
    );
    for (const match of text.matchAll(regex1)) {
      const relatedEntity = match[1];
      const relationship = match[2].toLowerCase();
      triples.push({
        subject: entity1.name,
        predicate: `${relationship}_of`,
        object: relatedEntity,
        confidence: 0.85,
      });
    }
  }

  // Pattern 2: "X works at Y" / "X lives in Y" / "X studies at Y" / "X goes to Y" / "X attends Y"
  const workRelations = [
    { pattern: /(\w+(?:\s+\w+)?)\s+works\s+at\s+([A-Z][\w\s]+)/gi, predicate: "works_at" },
    { pattern: /(\w+(?:\s+\w+)?)\s+lives\s+in\s+([A-Z][\w\s]+)/gi, predicate: "lives_in" },
    { pattern: /(\w+(?:\s+\w+)?)\s+(?:studies|goes|attends)\s+(?:at|to)\s+([A-Z][\w\s]+)/gi, predicate: "studies_at" },
  ];

  for (const { pattern, predicate } of workRelations) {
    for (const match of text.matchAll(pattern)) {
      const subject = match[1].trim();
      const object = match[2].trim();
      // Check if both are in our entity list
      const subjectEntity = entities.find((e) => e.name.toLowerCase() === subject.toLowerCase());
      const objectEntity = entities.find((e) => e.name.toLowerCase() === object.toLowerCase());
      
      if (subjectEntity && objectEntity) {
        triples.push({
          subject: subjectEntity.name,
          predicate,
          object: objectEntity.name,
          confidence: 0.9,
        });
      }
    }
  }

  // Pattern 3: "X is dating Y" / "X's boyfriend/girlfriend Y"
  const relationshipPatterns = [
    { pattern: /(\w+(?:\s+\w+)?)\s+is\s+dating\s+([A-Z][\w\s]+)/gi, predicate: "dating" },
    { pattern: /(\w+(?:\s+\w+)?)'s\s+(?:boyfriend|girlfriend)\s+(?:is\s+)?([A-Z][\w\s]+)/gi, predicate: "dating" },
    { pattern: /(\w+(?:\s+\w+)?)\s+is\s+married\s+to\s+([A-Z][\w\s]+)/gi, predicate: "married_to" },
    { pattern: /(\w+(?:\s+\w+)?)'s\s+(?:wife|husband)\s+(?:is\s+)?([A-Z][\w\s]+)/gi, predicate: "married_to" },
  ];

  for (const { pattern, predicate } of relationshipPatterns) {
    for (const match of text.matchAll(pattern)) {
      const subject = match[1].trim();
      const object = match[2].trim();
      const subjectEntity = entities.find((e) => e.name.toLowerCase() === subject.toLowerCase());
      const objectEntity = entities.find((e) => e.name.toLowerCase() === object.toLowerCase());
      
      if (subjectEntity && objectEntity) {
        triples.push({
          subject: subjectEntity.name,
          predicate,
          object: objectEntity.name,
          confidence: 0.85,
        });
      }
    }
  }

  // Pattern 4: "X is [age]" or "X is [age] years old"
  for (const entity of entities) {
    if (entity.type === "person") {
      const agePattern = new RegExp(
        `${entity.name}\\s+is\\s+(\\d+)(?:\\s+years\\s+old)?`,
        "gi"
      );
      for (const match of text.matchAll(agePattern)) {
        properties.push({
          entity: entity.name,
          key: "age",
          value: match[1],
        });
      }
    }
  }

  // Pattern 5: "X's phone is Y" / "X's number is Y"
  for (const entity of entities) {
    if (entity.type === "person") {
      const phonePattern = new RegExp(
        `${entity.name}'s\\s+(?:phone|number)\\s+is\\s+([\\d-()]+)`,
        "gi"
      );
      for (const match of text.matchAll(phonePattern)) {
        properties.push({
          entity: entity.name,
          key: "phone",
          value: match[1],
        });
      }
    }
  }

  return { triples, properties };
}

/**
 * Create association triples for entities that co-occur in the same message
 * without explicit relationship patterns
 */
function createCooccurrenceTriples(
  entities: Array<{ name: string; type: string; confidence: number }>
): Triple[] {
  const triples: Triple[] = [];

  // Only create co-occurrence triples if we have 2+ entities
  if (entities.length < 2) return triples;

  // Create weak association triples between all pairs
  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const entity1 = entities[i];
      const entity2 = entities[j];

      // Only create association if types are different (person-org, person-place, etc.)
      if (entity1.type !== entity2.type) {
        triples.push({
          subject: entity1.name,
          predicate: "associated_with",
          object: entity2.name,
          confidence: 0.5,
        });
      }
    }
  }

  return triples;
}

// Process a single session file using LLM for triple extraction
async function processSessionFileWithLLM(
  graph: GraphDB,
  filePath: string,
  opts: IngestOptions
): Promise<{ messagesProcessed: number; entitiesAdded: number; triplesAdded: number; propertiesAdded: number; errors: string[] }> {
  const stats = {
    messagesProcessed: 0,
    entitiesAdded: 0,
    triplesAdded: 0,
    propertiesAdded: 0,
    errors: [] as string[]
  };

  // Collect messages
  const messages: Array<{ role: string; text: string }> = [];

  await new Promise<void>((resolve) => {
    const fileStream = createReadStream(filePath, { encoding: "utf-8" });
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

    rl.on("line", (line) => {
      try {
        const obj = JSON.parse(line);

        // Only user/assistant messages, no tool output
        if (
          obj.type === "message" &&
          obj.message &&
          (obj.message.role === "user" || obj.message.role === "assistant")
        ) {
          const text = extractTextFromContent(obj.message.content);
          if (text && text.length > 10) {
            messages.push({ role: obj.message.role, text });
            stats.messagesProcessed++;
          }
        }
      } catch (err) {
        // Skip invalid JSON lines
      }
    });

    rl.on("close", () => resolve());
    rl.on("error", (err) => {
      stats.errors.push(`Error reading ${filePath}: ${err}`);
      resolve();
    });
  });

  if (messages.length === 0) {
    return stats;
  }

  // Chunk messages for LLM processing
  const chunks = chunkMessages(messages, 2000);

  if (opts.verbose) {
    console.log(`    Processing ${messages.length} messages in ${chunks.length} chunks with LLM...`);
  }

  // Collect all entities and triples
  const allEntities = new Map<string, { name: string; type: string }>();
  const allTriples: Array<{ subject: string; predicate: string; object: string; confidence: number }> = [];

  // Extract triples from each chunk using LLM
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    
    if (opts.verbose) {
      console.log(`      Chunk ${i + 1}/${chunks.length}...`);
    }

    try {
      const triples = await extractTriplesWithLLM(chunk, {
        ollamaUrl: opts.ollamaUrl,
        model: opts.model,
        verbose: opts.verbose,
      });

      for (const triple of triples) {
        // Add entities
        const subjectKey = triple.subject.toLowerCase();
        if (!allEntities.has(subjectKey)) {
          allEntities.set(subjectKey, {
            name: triple.subject,
            type: triple.subject_type || "unknown",
          });
          stats.entitiesAdded++;
        }

        const objectKey = triple.object.toLowerCase();
        if (!allEntities.has(objectKey)) {
          allEntities.set(objectKey, {
            name: triple.object,
            type: triple.object_type || "unknown",
          });
          stats.entitiesAdded++;
        }

        // Add triple
        allTriples.push({
          subject: triple.subject,
          predicate: triple.predicate,
          object: triple.object,
          confidence: 0.9, // High confidence from LLM
        });
        stats.triplesAdded++;
      }
    } catch (err: any) {
      stats.errors.push(`LLM extraction failed for chunk ${i + 1}: ${err.message}`);
    }
  }

  // Batch-write all entities and triples
  if (!opts.dryRun && (allEntities.size > 0 || allTriples.length > 0)) {
    graph.batch(() => {
      // Write entities
      for (const entity of allEntities.values()) {
        graph.addEntity(entity.name, entity.type);
      }

      // Write triples
      for (const triple of allTriples) {
        graph.addTriple(triple.subject, triple.predicate, triple.object, {
          confidence: triple.confidence,
          source: `session:${filePath.split("/").slice(-1)[0]}`,
        });
      }
    });
  }

  return stats;
}

// Process a single session file (line by line to handle large files)
// Collects entities AND triples in memory, then batch-writes everything.
// This is the NLP-based approach (fallback when LLM is not available)
async function processSessionFile(
  graph: GraphDB,
  filePath: string,
  opts: IngestOptions
): Promise<{ messagesProcessed: number; entitiesAdded: number; triplesAdded: number; propertiesAdded: number; errors: string[] }> {
  const stats = { 
    messagesProcessed: 0, 
    entitiesAdded: 0,
    triplesAdded: 0,
    propertiesAdded: 0,
    errors: [] as string[]
  };

  // Collect everything in memory
  const allEntities = new Map<string, { name: string; type: string }>();
  const allTriples: Triple[] = [];
  const allProperties: Property[] = [];

  // Track entity co-occurrence across the entire session
  const cooccurrenceMap = new Map<string, Map<string, number>>();

  await new Promise<void>((resolve) => {
    const fileStream = createReadStream(filePath, { encoding: "utf-8" });
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

    rl.on("line", (line) => {
      try {
        const obj = JSON.parse(line);

        // Filter to only message types with user or assistant role
        if (
          obj.type === "message" &&
          obj.message &&
          (obj.message.role === "user" || obj.message.role === "assistant")
        ) {
          const text = extractTextFromContent(obj.message.content);
          if (text && text.length > 0) {
            stats.messagesProcessed++;

            // Extract entities from the message text
            const entities = extractEntities(text, graph);
            
            // Collect entities
            for (const entity of entities) {
              const key = entity.name.toLowerCase();
              if (!allEntities.has(key)) {
                allEntities.set(key, { name: entity.name, type: entity.type });
                stats.entitiesAdded++;
              }
            }

            // Extract explicit relationships
            const { triples, properties } = extractRelationships(text, entities);
            allTriples.push(...triples);
            stats.triplesAdded += triples.length;
            
            allProperties.push(...properties);
            stats.propertiesAdded += properties.length;

            // Create weak co-occurrence triples
            const cooccurrenceTriples = createCooccurrenceTriples(entities);
            allTriples.push(...cooccurrenceTriples);
            stats.triplesAdded += cooccurrenceTriples.length;

            // Track co-occurrence for strengthening relationships
            for (let i = 0; i < entities.length; i++) {
              for (let j = i + 1; j < entities.length; j++) {
                const key1 = entities[i].name.toLowerCase();
                const key2 = entities[j].name.toLowerCase();
                
                if (!cooccurrenceMap.has(key1)) {
                  cooccurrenceMap.set(key1, new Map());
                }
                const map1 = cooccurrenceMap.get(key1)!;
                map1.set(key2, (map1.get(key2) || 0) + 1);

                if (!cooccurrenceMap.has(key2)) {
                  cooccurrenceMap.set(key2, new Map());
                }
                const map2 = cooccurrenceMap.get(key2)!;
                map2.set(key1, (map2.get(key1) || 0) + 1);
              }
            }

            if (opts.verbose && stats.messagesProcessed % 100 === 0) {
              console.log(`    Processed ${stats.messagesProcessed} messages...`);
            }
          }
        }
      } catch (err) {
        // Skip invalid JSON lines (non-fatal)
        if (opts.verbose) {
          stats.errors.push(`Invalid JSON in ${filePath}: ${err}`);
        }
      }
    });

    rl.on("close", () => resolve());
    rl.on("error", (err) => {
      stats.errors.push(`Error reading ${filePath}: ${err}`);
      resolve();
    });
  });

  // Add strengthened relationships based on session-wide co-occurrence
  for (const [entity1Key, cooccurMap] of cooccurrenceMap.entries()) {
    for (const [entity2Key, count] of cooccurMap.entries()) {
      // If entities co-occur 3+ times, strengthen the relationship
      if (count >= 3) {
        const entity1 = allEntities.get(entity1Key);
        const entity2 = allEntities.get(entity2Key);
        
        if (entity1 && entity2 && entity1.type !== entity2.type) {
          // Check if we already have a triple for this pair
          const existingTriple = allTriples.find(
            (t) =>
              (t.subject.toLowerCase() === entity1Key && t.object.toLowerCase() === entity2Key) ||
              (t.subject.toLowerCase() === entity2Key && t.object.toLowerCase() === entity1Key)
          );

          if (existingTriple) {
            // Boost confidence based on co-occurrence count
            existingTriple.confidence = Math.min(0.9, existingTriple.confidence + (count * 0.05));
          } else {
            // Create a new strengthened association
            allTriples.push({
              subject: entity1.name,
              predicate: "associated_with",
              object: entity2.name,
              confidence: Math.min(0.8, 0.5 + (count * 0.05)),
            });
            stats.triplesAdded++;
          }
        }
      }
    }
  }

  // Batch-write all entities and triples from this file in one transaction
  if (!opts.dryRun && (allEntities.size > 0 || allTriples.length > 0)) {
    graph.batch(() => {
      // Write entities
      for (const entity of allEntities.values()) {
        graph.addEntity(entity.name, entity.type);
      }

      // Write triples
      for (const triple of allTriples) {
        graph.addTriple(triple.subject, triple.predicate, triple.object, {
          confidence: triple.confidence,
          source: `session:${filePath.split("/").slice(-1)[0]}`,
        });
      }

      // Write properties
      for (const prop of allProperties) {
        graph.addProperty(prop.entity, normalizePredicate(prop.key), prop.value, {
          source: `session:${filePath.split("/").slice(-1)[0]}`,
        });
      }
    });
  }

  return stats;
}

export async function ingestSessions(
  graph: GraphDB,
  baseDir: string = "/home/clawd/.openclaw/agents",
  opts: IngestOptions = {}
): Promise<IngestStats> {
  const stats: IngestStats = {
    filesProcessed: 0,
    entitiesAdded: 0,
    triplesAdded: 0,
    propertiesAdded: 0,
    factsProcessed: 0,
    sessionsProcessed: 0,
    messagesProcessed: 0,
    errors: [],
  };

  // Find all session files
  const sessionFiles = findSessionFiles(baseDir);

  if (opts.verbose) {
    console.log(`Found ${sessionFiles.length} session files to process`);
  }

  for (let i = 0; i < sessionFiles.length; i++) {
    const filePath = sessionFiles[i];
    try {
      if (i % 50 === 0 || opts.verbose) {
        console.log(`  [${i + 1}/${sessionFiles.length}] ${filePath.split("/").slice(-3).join("/")}`);
      }

      // Choose LLM or NLP processing
      const fileStats = opts.useLLM
        ? await processSessionFileWithLLM(graph, filePath, opts)
        : await processSessionFile(graph, filePath, opts);

      stats.sessionsProcessed++;
      stats.messagesProcessed += fileStats.messagesProcessed;
      stats.entitiesAdded += fileStats.entitiesAdded;
      stats.triplesAdded += fileStats.triplesAdded;
      stats.propertiesAdded += fileStats.propertiesAdded;
      stats.errors.push(...fileStats.errors);

      if (opts.verbose) {
        console.log(
          `    ✓ ${fileStats.messagesProcessed} messages, ${fileStats.entitiesAdded} entities, ${fileStats.triplesAdded} triples`
        );
      }
    } catch (err) {
      const error = `Error processing ${filePath}: ${err}`;
      stats.errors.push(error);
      console.error(`  ✗ ${filePath.split("/").slice(-3).join("/")}: ${err}`);
    }
  }

  return stats;
}

// Recursively find all .md files in a directory
function findMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];

  const results: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          results.push(...findMarkdownFiles(fullPath));
        } else if (stat.isFile() && entry.endsWith(".md")) {
          results.push(fullPath);
        }
      } catch {
        // Skip files/dirs we can't access
      }
    }
  } catch {
    // Skip directories we can't read
  }
  return results;
}

// Pattern matchers for structured markdown
interface StructuredData {
  entities: Array<{ name: string; type: string }>;
  triples: Array<{ subject: string; predicate: string; object: string }>;
  properties: Array<{ entity: string; key: string; value: string }>;
}

function parseStructuredMarkdown(content: string, filePath: string): StructuredData {
  const result: StructuredData = {
    entities: [],
    triples: [],
    properties: [],
  };

  const lines = content.split("\n");
  let currentEntity: string | null = null;
  let inFamilySection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Detect USER.md files and family sections
    if (filePath.endsWith("USER.md") || filePath.endsWith("user.md")) {
      // Family section header
      if (/^#{1,3}\s*(family|relatives|children)/i.test(line)) {
        inFamilySection = true;
        continue;
      }
      // End of section
      if (inFamilySection && /^#{1,3}\s/i.test(line)) {
        inFamilySection = false;
      }

      // Parse family member entries: "- **Name** (age) - phone - school"
      if (inFamilySection && (line.startsWith("-") || line.startsWith("*"))) {
        const nameMatch = line.match(/\*\*([^*]+)\*\*/);
        if (nameMatch) {
          const name = nameMatch[1].trim();
          result.entities.push({ name, type: "person" });

          // Extract age: (XX) or "age XX"
          const ageMatch = line.match(/\((\d+)\)|age[:\s]+(\d+)/i);
          if (ageMatch) {
            const age = ageMatch[1] || ageMatch[2];
            result.properties.push({ entity: name, key: "age", value: age });
          }

          // Extract phone: XXX-XXX-XXXX or (XXX) XXX-XXXX
          const phoneMatch = line.match(/(\d{3}[-.]?\d{3}[-.]?\d{4}|\(\d{3}\)\s?\d{3}[-.]?\d{4})/);
          if (phoneMatch) {
            result.properties.push({ entity: name, key: "phone", value: phoneMatch[1] });
          }

          // Extract school/college mentions - two patterns:
          // 1. Explicit: "school: Name" or "School: Name"
          // 2. Implicit: ends with institution name (contains "School", "College", "University", "High School", etc.)
          const explicitSchoolMatch = line.match(/(?:school|college|university)[:\s]+([^-,\n]+)/i);
          if (explicitSchoolMatch) {
            const school = explicitSchoolMatch[1].trim();
            result.triples.push({ subject: name, predicate: "studies_at", object: school });
            result.entities.push({ name: school, type: "organization" });
          } else {
            // Look for institution names at the end of the line
            const parts = line.split("-").map((p) => p.trim());
            for (const part of parts) {
              if (
                part.match(/\b(University|College|School|High|Middle|Elementary|Academy|Institute)\b/i) &&
                !part.match(/^\*\*/) && // Not the name itself
                !part.match(/^\d/) // Not a phone number
              ) {
                const school = part.trim();
                result.triples.push({ subject: name, predicate: "studies_at", object: school });
                result.entities.push({ name: school, type: "organization" });
                break;
              }
            }
          }
        }
      }
    }

    // Pattern: "Name: Value" or "**Name:** Value"
    const keyValueMatch = line.match(/^\*?\*?([A-Za-z][A-Za-z\s]+?):\*?\*?\s+(.+)$/);
    if (keyValueMatch) {
      const key = keyValueMatch[1].trim();
      const value = keyValueMatch[2].trim();

      // Common keys that indicate entity properties
      if (/^(name|person|user)$/i.test(key)) {
        currentEntity = value;
        result.entities.push({ name: value, type: "person" });
      } else if (currentEntity) {
        // Add as property to the current entity
        result.properties.push({ entity: currentEntity, key, value });
      }
    }

    // Bullet points with relationship patterns
    // "- lives in New York" or "* works at Google"
    const bulletMatch = line.match(/^[-*]\s+(.+?)\s+(lives in|works at|studies at|born in|from)\s+(.+?)$/i);
    if (bulletMatch) {
      const subject = bulletMatch[1].trim();
      const predicate = bulletMatch[2].toLowerCase().replace(/\s+/g, "_");
      const object = bulletMatch[3].trim();

      if (subject && object) {
        result.triples.push({ subject, predicate, object });
        result.entities.push({ name: subject, type: "person" });
        result.entities.push({ name: object, type: predicate.includes("lives") || predicate.includes("born") ? "place" : "organization" });
      }
    }

    // Alternative bullet format: "- Adam lives in Boston"
    const sentenceBulletMatch = line.match(/^[-*]\s+([A-Z][a-z]+)\s+(lives in|works at|studies at|born in|from)\s+(.+?)$/);
    if (sentenceBulletMatch) {
      const subject = sentenceBulletMatch[1].trim();
      const predicate = sentenceBulletMatch[2].toLowerCase().replace(/\s+/g, "_");
      const object = sentenceBulletMatch[3].trim();

      if (subject && object) {
        result.triples.push({ subject, predicate, object });
        result.entities.push({ name: subject, type: "person" });
        result.entities.push({ name: object, type: predicate.includes("lives") || predicate.includes("born") ? "place" : "organization" });
      }
    }
  }

  return result;
}

export function ingestMarkdown(
  graph: GraphDB,
  paths: string[],
  opts: IngestOptions = {}
): IngestStats {
  const stats: IngestStats = {
    filesProcessed: 0,
    entitiesAdded: 0,
    triplesAdded: 0,
    propertiesAdded: 0,
    factsProcessed: 0,
    sessionsProcessed: 0,
    messagesProcessed: 0,
    errors: [],
  };

  // Find all markdown files
  const mdFiles: string[] = [];
  for (const path of paths) {
    mdFiles.push(...findMarkdownFiles(path));
  }

  if (opts.verbose) {
    console.log(`Found ${mdFiles.length} markdown files to process`);
  }

  // Batch all markdown writes in a single transaction
  graph.batch(() => {
  for (let i = 0; i < mdFiles.length; i++) {
    const filePath = mdFiles[i];
    try {
      const content = readFileSync(filePath, "utf-8");
      stats.filesProcessed++;
      if (i % 20 === 0 || opts.verbose) {
        console.log(`  [${i + 1}/${mdFiles.length}] ${filePath.split("/").slice(-3).join("/")}`);
      }

      // Extract entities using the entity extraction library
      const entities = extractEntities(content, graph);
      for (const entity of entities) {
        if (!opts.dryRun) {
          graph.addEntity(entity.name, entity.type);
        }
        stats.entitiesAdded++;
      }

      // Parse structured markdown
      const structured = parseStructuredMarkdown(content, filePath);

      // Add structured entities
      for (const entity of structured.entities) {
        if (!opts.dryRun) {
          graph.addEntity(entity.name, entity.type);
        }
        stats.entitiesAdded++;
      }

      // Add triples
      for (const triple of structured.triples) {
        if (!opts.dryRun) {
          graph.addTriple(triple.subject, triple.predicate, triple.object, {
            confidence: 0.8,
            source: `markdown:${filePath}`,
          });
        }
        stats.triplesAdded++;
      }

      // Add properties
      for (const prop of structured.properties) {
        if (!opts.dryRun) {
          const predicate = normalizePredicate(prop.key);
          // Try to add as property if it's a simple value, otherwise as a triple
          if (prop.value.length < 100 && !prop.value.includes(" ")) {
            graph.addProperty(prop.entity, predicate, prop.value, {
              source: `markdown:${filePath}`,
            });
            stats.propertiesAdded++;
          } else {
            // Complex value might be an entity
            graph.addTriple(prop.entity, predicate, prop.value, {
              confidence: 0.7,
              source: `markdown:${filePath}`,
            });
            stats.triplesAdded++;
          }
        } else {
          stats.propertiesAdded++;
        }
      }

      if (opts.verbose) {
        console.log(`  ✓ ${filePath}`);
      }
    } catch (err) {
      const error = `Error processing ${filePath}: ${err}`;
      stats.errors.push(error);
      if (opts.verbose) {
        console.error(`  ✗ ${error}`);
      }
    }
  }
  }); // end batch

  return stats;
}

export function ingestFactmem(
  graph: GraphDB,
  factsDbPath: string,
  opts: IngestOptions = {}
): IngestStats {
  const stats: IngestStats = {
    filesProcessed: 0,
    entitiesAdded: 0,
    triplesAdded: 0,
    propertiesAdded: 0,
    factsProcessed: 0,
    sessionsProcessed: 0,
    messagesProcessed: 0,
    errors: [],
  };

  if (!existsSync(factsDbPath)) {
    stats.errors.push(`Facts database not found: ${factsDbPath}`);
    return stats;
  }

  try {
    const factsDb = new Database(factsDbPath, { readonly: true });

    // Query all facts
    const facts = factsDb
      .prepare("SELECT entity, key, value, decay_tier, source FROM facts WHERE expires_at IS NULL OR expires_at > datetime('now')")
      .all() as Array<{ entity: string; key: string; value: string; decay_tier: string; source: string }>;

    console.log(`  Found ${facts.length} facts to process`);

    graph.batch(() => {
    for (const fact of facts) {
      try {
        stats.factsProcessed++;

        // Add the entity
        if (!opts.dryRun) {
          // Try to infer entity type from context
          let entityType = "unknown";
          if (fact.key.match(/phone|email|age|birthday/i)) {
            entityType = "person";
          } else if (fact.key.match(/url|domain|server/i)) {
            entityType = "service";
          }
          graph.addEntity(fact.entity, entityType);
        }
        stats.entitiesAdded++;

        // Normalize the key to a predicate
        const predicate = normalizePredicate(fact.key);

        // Determine if value is an entity or a property
        const isEntity = fact.value.length > 3 && 
                        (fact.key.match(/school|work|company|location|city|spouse|parent|child|friend|manager/i) ||
                         fact.value.match(/^[A-Z][a-z]+(\s[A-Z][a-z]+)*$/)); // Capitalized names

        if (isEntity) {
          // Add as a triple
          if (!opts.dryRun) {
            // Infer object type
            let objectType = "unknown";
            if (fact.key.match(/school|university|college|company|work|employer/i)) {
              objectType = "organization";
            } else if (fact.key.match(/location|city|address/i)) {
              objectType = "place";
            } else if (fact.key.match(/spouse|parent|child|friend|sibling|manager/i)) {
              objectType = "person";
            }

            graph.addEntity(fact.value, objectType);
            graph.addTriple(fact.entity, predicate, fact.value, {
              confidence: fact.decay_tier === "permanent" ? 0.95 : fact.decay_tier === "stable" ? 0.85 : 0.7,
              source: `factmem:${fact.source}`,
            });
          }
          stats.triplesAdded++;
        } else {
          // Add as a property
          if (!opts.dryRun) {
            graph.addProperty(fact.entity, predicate, fact.value, {
              source: `factmem:${fact.source}`,
            });
          }
          stats.propertiesAdded++;
        }

        if (stats.factsProcessed % 200 === 0) {
          console.log(`  [${stats.factsProcessed}/${facts.length}] ${fact.entity}/${fact.key}`);
        }
      } catch (err) {
        const error = `Error processing fact for ${fact.entity}: ${err}`;
        stats.errors.push(error);
        if (opts.verbose) {
          console.error(`  ✗ ${error}`);
        }
      }
    }
    }); // end batch

    factsDb.close();
  } catch (err) {
    stats.errors.push(`Error opening facts database: ${err}`);
  }

  return stats;
}

export async function ingestAll(
  graph: GraphDB,
  sessionsDir: string,
  markdownPaths: string[],
  factsDbPath: string,
  opts: IngestOptions = {}
): Promise<IngestStats> {
  const combined: IngestStats = {
    filesProcessed: 0,
    entitiesAdded: 0,
    triplesAdded: 0,
    propertiesAdded: 0,
    factsProcessed: 0,
    sessionsProcessed: 0,
    messagesProcessed: 0,
    errors: [],
  };

  // Ingest sessions FIRST (highest priority)
  console.log("\n=== Ingesting Session Files ===");
  const sessionStats = await ingestSessions(graph, sessionsDir, opts);
  combined.sessionsProcessed += sessionStats.sessionsProcessed;
  combined.messagesProcessed += sessionStats.messagesProcessed;
  combined.entitiesAdded += sessionStats.entitiesAdded;
  combined.triplesAdded += sessionStats.triplesAdded;
  combined.propertiesAdded += sessionStats.propertiesAdded;
  combined.errors.push(...sessionStats.errors);
  console.log(`  Sessions done: ${sessionStats.sessionsProcessed} files, ${sessionStats.messagesProcessed} messages, ${sessionStats.entitiesAdded} entities, ${sessionStats.triplesAdded} triples`);

  // Ingest markdown
  console.log("\n=== Ingesting Markdown Files ===");
  const mdStats = ingestMarkdown(graph, markdownPaths, opts);
  combined.filesProcessed += mdStats.filesProcessed;
  combined.entitiesAdded += mdStats.entitiesAdded;
  combined.triplesAdded += mdStats.triplesAdded;
  combined.propertiesAdded += mdStats.propertiesAdded;
  combined.errors.push(...mdStats.errors);
  console.log(`  Markdown done: ${mdStats.filesProcessed} files, ${mdStats.entitiesAdded} entities, ${mdStats.triplesAdded} triples`);

  // Ingest factmem LAST
  console.log("\n=== Ingesting Factmem Database ===");
  const factStats = ingestFactmem(graph, factsDbPath, opts);
  combined.entitiesAdded += factStats.entitiesAdded;
  combined.triplesAdded += factStats.triplesAdded;
  combined.propertiesAdded += factStats.propertiesAdded;
  combined.factsProcessed += factStats.factsProcessed;
  combined.errors.push(...factStats.errors);

  return combined;
}

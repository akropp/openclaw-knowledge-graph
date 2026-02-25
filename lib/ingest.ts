import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { GraphDB } from "./graph-db.js";
import { extractEntities } from "./entity-extract.js";

export interface IngestStats {
  filesProcessed: number;
  entitiesAdded: number;
  triplesAdded: number;
  propertiesAdded: number;
  factsProcessed: number;
  errors: string[];
}

export interface IngestOptions {
  dryRun?: boolean;
  verbose?: boolean;
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

  for (const filePath of mdFiles) {
    try {
      const content = readFileSync(filePath, "utf-8");
      stats.filesProcessed++;

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

    if (opts.verbose) {
      console.log(`Found ${facts.length} facts to process`);
    }

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

        if (opts.verbose && stats.factsProcessed % 100 === 0) {
          console.log(`  Processed ${stats.factsProcessed} facts...`);
        }
      } catch (err) {
        const error = `Error processing fact for ${fact.entity}: ${err}`;
        stats.errors.push(error);
        if (opts.verbose) {
          console.error(`  ✗ ${error}`);
        }
      }
    }

    factsDb.close();
  } catch (err) {
    stats.errors.push(`Error opening facts database: ${err}`);
  }

  return stats;
}

export function ingestAll(
  graph: GraphDB,
  markdownPaths: string[],
  factsDbPath: string,
  opts: IngestOptions = {}
): IngestStats {
  const combined: IngestStats = {
    filesProcessed: 0,
    entitiesAdded: 0,
    triplesAdded: 0,
    propertiesAdded: 0,
    factsProcessed: 0,
    errors: [],
  };

  // Ingest markdown
  if (opts.verbose) {
    console.log("\n=== Ingesting Markdown Files ===");
  }
  const mdStats = ingestMarkdown(graph, markdownPaths, opts);
  combined.filesProcessed += mdStats.filesProcessed;
  combined.entitiesAdded += mdStats.entitiesAdded;
  combined.triplesAdded += mdStats.triplesAdded;
  combined.propertiesAdded += mdStats.propertiesAdded;
  combined.errors.push(...mdStats.errors);

  // Ingest factmem
  if (opts.verbose) {
    console.log("\n=== Ingesting Factmem Database ===");
  }
  const factStats = ingestFactmem(graph, factsDbPath, opts);
  combined.entitiesAdded += factStats.entitiesAdded;
  combined.triplesAdded += factStats.triplesAdded;
  combined.propertiesAdded += factStats.propertiesAdded;
  combined.factsProcessed += factStats.factsProcessed;
  combined.errors.push(...factStats.errors);

  return combined;
}

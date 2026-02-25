import nlp from "compromise";
import type { GraphDB } from "./graph-db.js";

export interface ExtractedEntity {
  name: string;
  type: string;
  confidence: number;
}

// Common words that should never be extracted as entities
const STOP_WORDS = new Set([
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "it", "they",
  "them", "this", "that", "these", "those", "is", "are", "was", "were", "be",
  "been", "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "shall", "can", "need", "must", "the",
  "a", "an", "and", "or", "but", "if", "then", "else", "when", "up", "down",
  "out", "in", "on", "off", "over", "under", "again", "further", "once",
  "here", "there", "where", "why", "how", "all", "each", "every", "both",
  "few", "more", "most", "other", "some", "such", "no", "not", "only", "own",
  "same", "so", "than", "too", "very", "just", "because", "as", "until",
  "while", "of", "at", "by", "for", "with", "about", "between", "through",
  "during", "before", "after", "above", "below", "to", "from", "into",
  "also", "still", "already", "yet", "now", "today", "tomorrow", "yesterday",
  "please", "thanks", "thank", "yes", "no", "ok", "okay", "sure", "right",
  "well", "good", "great", "nice", "fine", "hello", "hi", "hey",
  // Technical/agent terms that aren't real entities
  "assistant", "user", "system", "message", "session", "config", "error",
  "null", "undefined", "true", "false", "default", "function", "import",
  "export", "const", "let", "var", "return", "async", "await", "ctx",
  "api", "db", "graph", "data", "info", "log", "debug", "warn", "type",
]);

// Patterns for technical entities
const IP_PATTERN = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g;
const HOSTNAME_PATTERN =
  /\b([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:[a-z]{2,})(?:\.[a-z]{2,})?)\b/gi;
const SERVICE_PATTERN =
  /\b(nginx|redis|postgres(?:ql)?|mysql|mongodb|docker|kubernetes|k8s|kafka|rabbitmq|elasticsearch|grafana|prometheus|jenkins|terraform|ansible)\b/gi;

// UUID pattern
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// File extension pattern
const FILE_EXT_PATTERN = /\.(js|ts|py|md|json|jsonl|db|txt|yaml|yml|css|html|tsx|jsx)$/i;

function isStopWord(word: string): boolean {
  return STOP_WORDS.has(word.toLowerCase().trim());
}

/**
 * Preprocess text to remove markdown, code blocks, JSON, and technical artifacts
 * before feeding to NLP extraction
 */
export function preprocessText(text: string): string {
  let cleaned = text;

  // Strip markdown code blocks (``` ... ```)
  cleaned = cleaned.replace(/```[\s\S]*?```/g, " ");

  // Strip inline code (`something`)
  cleaned = cleaned.replace(/`[^`]+`/g, " ");

  // Strip markdown links [text](url) → keep text
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // Strip markdown bold/italic (**text**, *text*)
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, "$1");
  cleaned = cleaned.replace(/\*([^*]+)\*/g, "$1");

  // Strip HTML tags
  cleaned = cleaned.replace(/<[^>]+>/g, " ");

  // Strip URLs (http://, https://)
  cleaned = cleaned.replace(/https?:\/\/[^\s]+/gi, " ");

  // Strip JSON blocks { ... } (multi-line and single-line)
  cleaned = cleaned.replace(/\{[\s\S]*?\}/g, " ");

  // Strip lines that look like system metadata, timestamps, message headers
  const lines = cleaned.split("\n");
  const filteredLines = lines.filter((line) => {
    const trimmed = line.trim();
    // Skip lines starting with system markers
    if (/^\[(System|discord|telegram|2026-|202[0-9]-|Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.test(trimmed)) {
      return false;
    }
    // Skip lines that look like timestamps
    if (/^\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/.test(trimmed)) {
      return false;
    }
    // Skip lines that look like file paths
    if (/^\/[a-z0-9/_-]+\.(ts|js|py|md|json|jsonl|db)/i.test(trimmed)) {
      return false;
    }
    // Skip lines containing common file extensions in path-like context
    if (/\/[a-z0-9_-]+\.(ts|js|py|md|json|jsonl|db)/i.test(trimmed)) {
      return false;
    }
    return true;
  });

  cleaned = filteredLines.join("\n");

  // Normalize whitespace but preserve line boundaries
  // Replace multiple spaces on same line with single space
  cleaned = cleaned.replace(/[ \t]+/g, " ");
  // Replace multiple newlines with single newline
  cleaned = cleaned.replace(/\n\n+/g, "\n");
  // Trim
  cleaned = cleaned.trim();

  return cleaned;
}

/**
 * Post-filter to reject entities that look like code artifacts
 */
function isValidEntity(name: string, type?: string): boolean {
  const trimmed = name.trim();

  // Allow IPs and hostnames to bypass most checks
  if (type === "ip_address" || type === "hostname" || type === "service") {
    return true;
  }

  // Reject empty or too short
  if (trimmed.length < 2) return false;

  // Reject if longer than 50 characters
  if (trimmed.length > 50) return false;

  // Reject if contains backticks, curly braces, square brackets, parentheses, angle brackets, pipe
  if (/[`{}[\]()<>|]/.test(trimmed)) return false;

  // Reject if contains arrows (→ or ->) or other technical symbols
  if (/→|->|←|<-|=>|<=/.test(trimmed)) return false;

  // Reject if contains forward slash (file paths)
  if (/\//.test(trimmed)) return false;

  // Reject if contains = or : followed by more text (key-value pairs)
  if (/[:=].+/.test(trimmed)) return false;

  // Reject if contains semicolons or question marks ANYWHERE (not just at end)
  if (/[;?!]/.test(trimmed)) return false;

  // Reject if starts or ends with punctuation (including curly quotes and commas)
  if (/^[",.'!?;:"""''`]|[",.'!?;:"""''`,]$/.test(trimmed)) return false;

  // Reject if contains multiple consecutive punctuation marks
  if (/[.,:;!?]{2,}/.test(trimmed)) return false;

  // Reject if matches file extension pattern
  if (FILE_EXT_PATTERN.test(trimmed)) return false;

  // Reject if looks like a UUID
  if (UUID_PATTERN.test(trimmed)) return false;

  // Reject if contains only lowercase with dots (config keys like api.registerHook, graph.db)
  // BUT: allow it if it looks like a valid hostname (ends with common TLD)
  if (/^[a-z0-9.]+$/.test(trimmed) && trimmed.includes(".")) {
    // Check if it ends with a common TLD
    if (!/\.(com|org|net|edu|gov|io|co|uk|de|fr|ca|au|jp|cn|in|br|ru|us)$/i.test(trimmed)) {
      return false;
    }
  }

  // Reject if contains dots in a way that looks like code (method calls, config keys)
  // But allow hostnames like "example.com"
  if (/\.[a-z]+[A-Z]/.test(trimmed) || /[a-z]\.[a-z]/.test(trimmed) && !/\.(com|org|net|edu|gov|io|co)$/i.test(trimmed)) {
    // Check if it looks like a code pattern (camelCase after dot, or lowercase.lowercase not ending in TLD)
    const parts = trimmed.split(".");
    if (parts.length > 1) {
      const lastPart = parts[parts.length - 1];
      // If last part is not a common TLD and contains lowercase, probably code
      if (!/^(com|org|net|edu|gov|io|co|uk|de|fr|ca|au|jp|cn|in|br|ru)$/i.test(lastPart)) {
        if (parts.some((p) => /^[a-z]+$/.test(p))) {
          return false;
        }
      }
    }
  }

  // Reject technical terms with underscores
  if (/_/.test(trimmed) && /^[a-z_]+$/.test(trimmed)) return false;

  // Reject if it looks like a variable or constant (starts with lowercase or underscore)
  if (/^[a-z_$]/.test(trimmed) && trimmed.length < 15 && !/\s/.test(trimmed)) {
    // Single word starting with lowercase, likely a variable
    // Exception: common single-word names like "adam", but those should be capitalized by NLP
    return false;
  }

  // Reject common non-entity words that slip through NLP
  const nonEntityWords = new Set([
    "this way", "that way", "lesson", "worth building", "skip", "without",
    "building", "way", "code", "system", "agent", "task"
  ]);
  if (nonEntityWords.has(trimmed.toLowerCase())) return false;

  return true;
}

function cleanEntityName(name: string): string {
  let cleaned = name.trim();
  
  // Strip leading/trailing quotes (straight and curly)
  cleaned = cleaned.replace(/^["'"""''`]+|["'"""''`]+$/g, "");
  
  // Strip leading dashes, bullets, and list markers
  cleaned = cleaned.replace(/^[-•*]+\s*/, "");
  
  // Strip trailing commas, periods, semicolons, colons, dashes, question/exclamation marks
  cleaned = cleaned.replace(/[,.;:\-!?]+$/g, "");
  
  // Strip leading/trailing whitespace again after quote removal
  cleaned = cleaned.trim();
  
  // Remove possessive 's from end
  cleaned = cleaned.replace(/'s$/i, "");
  
  return cleaned;
}

function dedup(entities: ExtractedEntity[]): ExtractedEntity[] {
  const seen = new Map<string, ExtractedEntity>();

  for (const e of entities) {
    // Clean the entity name first
    const cleanedName = cleanEntityName(e.name);
    if (!cleanedName) continue;
    
    const key = cleanedName.toLowerCase().trim();
    if (key.length < 2) continue;
    if (isStopWord(key)) continue;
    if (!isValidEntity(cleanedName, e.type)) continue;

    const existing = seen.get(key);
    if (!existing || e.confidence > existing.confidence) {
      seen.set(key, { ...e, name: cleanedName });
    }
  }

  return [...seen.values()];
}

/**
 * Returns true if the string looks like a sentence/fragment rather than a proper entity name.
 * Uses NLP verb detection + structural heuristics. Used by consolidation to filter garbage entities.
 *
 * Deliberately permissive on gray-area cases ("same location as adam") — the LLM consolidation
 * pass handles those. This function only catches clear non-entities.
 */
export function isGarbageEntityName(s: string): boolean {
  if (!s || s.trim().length === 0) return true;

  // Phone numbers are valid entity values — exempt early
  if (/^\+?[\d\s\-().]{7,20}$/.test(s.trim())) return false;

  // ── Structural checks (fast, no NLP needed) ───────────────────────────
  // Markdown artifacts
  if (s.startsWith("**") || s.startsWith("- ") || s.startsWith("* ")) return true;
  // Code / special chars
  if (s.includes("`") || s.includes("→") || s.includes("\n")) return true;
  // Em-dash separators and comma lists (addresses, enumerations)
  if (s.includes(" — ") || s.includes(", ")) return true;
  // Concatenated items
  if (s.includes(" + ")) return true;
  // Sentence break: ". Capital"
  if (/\. [A-Z]/.test(s)) return true;
  // Date/time stamps
  if (/^\d{4}-\d{2}-\d{2}/.test(s) || /^\d{1,2}:\d{2}\s*(am|pm)/i.test(s)) return true;
  // Market/session IDs: long digit runs mixed with underscores/colons (not phone numbers)
  if (/\d{6,}/.test(s) && /[_:a-z]{3,}/.test(s)) return true;
  // Parenthetical with multiple words = description, not nickname
  // "(monty)" is fine, "(quant finance)" is not
  if (/\([^)]*\s[^)]+\)/.test(s)) return true;
  // Colon that isn't part of a URL or phone number
  if (s.includes(":") && !/^https?:\/\//.test(s) && !/^\+?[\d\s\-().:]+$/.test(s)) return true;

  // ── NLP checks ───────────────────────────────────────────────────────
  const doc = nlp(s);

  // Has a conjugated verb = sentence or sentence fragment
  // e.g. "what adam experiences", "delegation added to soul.md"
  if (doc.verbs().length > 0) return true;

  // Starts with question/relative word
  if (/^(what|where|when|who|how|which|whether)\s/i.test(s)) return true;

  return false;
}

export function extractEntities(
  text: string,
  graph?: GraphDB
): ExtractedEntity[] {
  const results: ExtractedEntity[] = [];

  // Extract technical patterns FIRST (from original text before preprocessing)
  // These patterns rely on specific characters that preprocessing might remove
  for (const match of text.matchAll(IP_PATTERN)) {
    results.push({ name: match[1], type: "ip_address", confidence: 0.9 });
  }

  for (const match of text.matchAll(HOSTNAME_PATTERN)) {
    const hostname = match[1];
    // Filter out file extensions AND hostnames with too many dots (code artifacts)
    const dotCount = (hostname.match(/\./g) || []).length;
    const parts = hostname.split(".");
    const tld = parts[parts.length - 1];
    
    // Reject if:
    // - Has file extension
    // - Has more than 3 dots
    // - TLD is not a common TLD (likely code like api.registerHook)
    // - TLD is camelCase (code pattern)
    // - Contains "db" as TLD (likely database file)
    const validTLDs = /^(com|org|net|edu|gov|io|co|uk|de|fr|ca|au|jp|cn|in|br|ru|us|dev|app|tech|cloud|ai)$/i;
    
    if (
      !hostname.match(/\.(js|ts|py|md|txt|json|yaml|yml|css|html|jsonl|db)$/i) &&
      dotCount <= 3 &&
      dotCount >= 1 && // Must have at least one dot
      validTLDs.test(tld) && // TLD must be valid
      !/[A-Z]/.test(tld) // TLD should not contain uppercase (camelCase)
    ) {
      results.push({ name: hostname, type: "hostname", confidence: 0.8 });
    }
  }

  for (const match of text.matchAll(SERVICE_PATTERN)) {
    results.push({ name: match[1].toLowerCase(), type: "service", confidence: 0.9 });
  }

  // NOW preprocess: Clean the text before NLP extraction
  const cleanedText = preprocessText(text);

  // NLP extraction via compromise (on cleaned text)
  const doc = nlp(cleanedText);

  // People
  for (const person of doc.people().out("array") as string[]) {
    if (!isStopWord(person) && isValidEntity(person)) {
      results.push({ name: person, type: "person", confidence: 0.8 });
    }
  }

  // Places
  for (const place of doc.places().out("array") as string[]) {
    if (!isStopWord(place) && isValidEntity(place)) {
      results.push({ name: place, type: "place", confidence: 0.7 });
    }
  }

  // Organizations
  for (const org of doc.organizations().out("array") as string[]) {
    if (!isStopWord(org) && isValidEntity(org)) {
      results.push({ name: org, type: "organization", confidence: 0.7 });
    }
  }

  // Cross-reference with existing graph entities
  if (graph) {
    try {
      const words = cleanedText.split(/\s+/).filter((w) => w.length >= 3 && !isStopWord(w) && isValidEntity(w));
      for (const word of words) {
        const found = graph.search(word);
        for (const entity of found) {
          // Boost confidence for known entities
          const existing = results.find(
            (r) => r.name.toLowerCase() === entity.name
          );
          if (existing) {
            existing.confidence = Math.min(1.0, existing.confidence + 0.2);
          } else if (isValidEntity(entity.display_name)) {
            results.push({
              name: entity.display_name,
              type: entity.entity_type,
              confidence: 0.85,
            });
          }
        }
      }
    } catch {
      // Graph search failure is non-fatal
    }
  }

  return dedup(results);
}

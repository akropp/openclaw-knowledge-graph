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
]);

// Patterns for technical entities
const IP_PATTERN = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g;
const HOSTNAME_PATTERN =
  /\b([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:[a-z]{2,})(?:\.[a-z]{2,})?)\b/gi;
const SERVICE_PATTERN =
  /\b(nginx|redis|postgres(?:ql)?|mysql|mongodb|docker|kubernetes|k8s|kafka|rabbitmq|elasticsearch|grafana|prometheus|jenkins|terraform|ansible)\b/gi;

function isStopWord(word: string): boolean {
  return STOP_WORDS.has(word.toLowerCase().trim());
}

function dedup(entities: ExtractedEntity[]): ExtractedEntity[] {
  const seen = new Map<string, ExtractedEntity>();

  for (const e of entities) {
    const key = e.name.toLowerCase().trim();
    if (key.length < 2) continue;
    if (isStopWord(key)) continue;

    const existing = seen.get(key);
    if (!existing || e.confidence > existing.confidence) {
      seen.set(key, { ...e, name: e.name.trim() });
    }
  }

  return [...seen.values()];
}

export function extractEntities(
  text: string,
  graph?: GraphDB
): ExtractedEntity[] {
  const results: ExtractedEntity[] = [];

  // NLP extraction via compromise
  const doc = nlp(text);

  // People
  for (const person of doc.people().out("array") as string[]) {
    if (!isStopWord(person)) {
      results.push({ name: person, type: "person", confidence: 0.8 });
    }
  }

  // Places
  for (const place of doc.places().out("array") as string[]) {
    if (!isStopWord(place)) {
      results.push({ name: place, type: "place", confidence: 0.7 });
    }
  }

  // Organizations
  for (const org of doc.organizations().out("array") as string[]) {
    if (!isStopWord(org)) {
      results.push({ name: org, type: "organization", confidence: 0.7 });
    }
  }

  // Technical patterns
  for (const match of text.matchAll(IP_PATTERN)) {
    results.push({ name: match[1], type: "ip_address", confidence: 0.9 });
  }

  for (const match of text.matchAll(HOSTNAME_PATTERN)) {
    const hostname = match[1];
    // Filter out common file extensions that look like hostnames
    if (!hostname.match(/\.(js|ts|py|md|txt|json|yaml|yml|css|html)$/i)) {
      results.push({ name: hostname, type: "hostname", confidence: 0.8 });
    }
  }

  for (const match of text.matchAll(SERVICE_PATTERN)) {
    results.push({ name: match[1].toLowerCase(), type: "service", confidence: 0.9 });
  }

  // Cross-reference with existing graph entities
  if (graph) {
    try {
      const words = text.split(/\s+/).filter((w) => w.length >= 3 && !isStopWord(w));
      for (const word of words) {
        const found = graph.search(word);
        for (const entity of found) {
          // Boost confidence for known entities
          const existing = results.find(
            (r) => r.name.toLowerCase() === entity.name
          );
          if (existing) {
            existing.confidence = Math.min(1.0, existing.confidence + 0.2);
          } else {
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

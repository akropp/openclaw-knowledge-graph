import { preprocessText } from "./entity-extract.js";

/** Parse LLM response content into triples */
function parseTriples(content: string): LLMTriple[] {
  const triples: LLMTriple[] = [];

  // Strategy 1: Find JSON objects with regex (handles multi-line)
  const jsonRegex = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
  const matches = content.match(jsonRegex) || [];

  for (const match of matches) {
    try {
      const triple = JSON.parse(match) as LLMTriple;
      if (triple.subject && triple.predicate && triple.object) {
        triples.push(triple);
      }
    } catch {
      // Not valid JSON, skip
    }
  }

  // Strategy 2: If regex found nothing, try parsing as JSON array
  if (triples.length === 0) {
    try {
      const arr = JSON.parse(content);
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (item.subject && item.predicate && item.object) {
            triples.push(item as LLMTriple);
          }
        }
      }
    } catch {
      // Not a JSON array either
    }
  }

  return triples;
}

export interface LLMTriple {
  subject: string;
  predicate: string;
  object: string;
  subject_type?: string;
  object_type?: string;
}

export interface LLMExtractOptions {
  ollamaUrl: string;
  model: string;
  apiKey?: string;
  verbose?: boolean;
  timeoutMs?: number;
}

const SYSTEM_PROMPT = `Extract knowledge triples from this conversation. Return ONLY valid JSON lines, one per triple:
{"subject":"Adam Kropp","predicate":"parent_of","object":"Emily Kropp","subject_type":"person","object_type":"person"}

DIRECTIONALITY IS CRITICAL. The subject is always the actor, owner, or "bigger" entity:
- parent_of: the PARENT is the subject → "Adam Kropp" parent_of "Emily Kropp" (NOT Emily parent_of Adam)
- works_at: the PERSON is the subject → "Adam" works_at "Company" (NOT Company works_at Adam)
- manages: the MANAGER is the subject → "Adam" manages "Gilfoyle" (NOT Gilfoyle manages Adam)
- lives_in: the PERSON is the subject → "Emily" lives_in "NYC"
- married_to: either direction is fine (symmetric)
- dating: either direction is fine (symmetric)

Canonical predicates (use ONLY these, pick ONE direction per relationship):
- People: parent_of, child_of, married_to, sibling_of, dating, has_phone, has_email, has_age, born_on
- Work: works_at, manages, member_of, collaborates_with
- Location: lives_in, located_in
- Education: studies_at, attends
- Tech: runs_on, hosted_on, uses, built_with

NEVER emit contradictory pairs. If Adam manages Gilfoyle, do NOT also emit Adam managed_by Gilfoyle.
Pick child_of OR parent_of for a given pair, not both. child_of means the CHILD is the subject.

Rules:
- Only extract factual relationships about real people, places, organizations, services
- AI agents (Clawd, Gilfoyle, Monty, Sterling) are software — Adam manages/uses them, not the reverse
- Ignore technical implementation details, code, configs, debugging
- Normalize names (full names when known)
- Skip vague or uncertain relationships
- Skip entities that are code, file paths, or technical artifacts
- Return one JSON object per line, no other text

ENTITY NAME RULES — entity names must be SHORT proper nouns (1-5 words max):
- ✓ "Adam Kropp", "Emily Kropp", "LIM College", "Boston University", "New York City"
- ✗ NEVER use full sentences as entity names
- ✗ NEVER use markdown bullets, code snippets, or descriptions as entity names
- ✗ NEVER use more than 5 words for subject or object
- If you can't express a relationship with short proper noun entities, SKIP IT`;

/**
 * Extract triples from text using Ollama LLM
 * @param text - Text to extract triples from
 * @param opts - LLM extraction options (ollamaUrl and model are required)
 */
export async function extractTriplesWithLLM(
  text: string,
  opts: LLMExtractOptions
): Promise<LLMTriple[]> {
  const { ollamaUrl, model } = opts;

  // Clean text before sending to LLM (remove code, markdown, technical artifacts)
  const cleanedText = preprocessText(text);
  
  if (!cleanedText || cleanedText.length < 10) {
    if (opts.verbose) {
      console.warn("  ⚠ Text too short after cleaning, skipping LLM extraction");
    }
    return [];
  }

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    
    // Add Authorization header if apiKey is provided
    if (opts.apiKey) {
      headers["Authorization"] = `Bearer ${opts.apiKey}`;
    }

    // Support both Ollama (http://host:port) and OpenAI-compatible APIs (http://host/v1)
    const endpoint = ollamaUrl.endsWith("/v1") || ollamaUrl.includes("/v1/")
      ? `${ollamaUrl.replace(/\/$/, "")}/chat/completions`
      : `${ollamaUrl}/v1/chat/completions`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: cleanedText },
        ],
        temperature: 0,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs || 300000), // 120s timeout (model loading + inference)
    });

    // Retry on 429 with exponential backoff
    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get("retry-after") || "0", 10);
      const waitMs = retryAfter ? retryAfter * 1000 : 5000;
      if (opts.verbose) {
        console.log(`  ⏳ Rate limited, waiting ${waitMs / 1000}s...`);
      }
      await new Promise((r) => setTimeout(r, waitMs));
      // Retry once
      const retry = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: cleanedText },
          ],
          temperature: 0,
        }),
        signal: AbortSignal.timeout(opts.timeoutMs || 300000),
      });
      if (!retry.ok) {
        throw new Error(`LLM API error after retry: ${retry.status} ${retry.statusText}`);
      }
      const retryData = (await retry.json()) as any;
      const retryContent = retryData.choices?.[0]?.message?.content;
      if (retryContent) {
        return parseTriples(retryContent);
      }
      return [];
    }

    if (!response.ok) {
      throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as any;
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      if (opts.verbose) {
        console.warn("  ⚠ LLM returned empty response");
      }
      return [];
    }

    return parseTriples(content);
  } catch (err: any) {
    if (opts.verbose) {
      console.warn(`  ⚠ LLM extraction failed: ${err.message}`);
    }
    return [];
  }
}

/**
 * Batch text into chunks of approximately maxChars, without splitting mid-message
 */
export function chunkMessages(
  messages: Array<{ role: string; text: string }>,
  maxChars: number = 16000
): string[] {
  const chunks: string[] = [];
  let currentChunk: string[] = [];
  let currentLength = 0;

  for (const msg of messages) {
    const msgText = `[${msg.role}]: ${msg.text}\n\n`;
    const msgLength = msgText.length;

    // If adding this message would exceed max, start new chunk
    if (currentLength + msgLength > maxChars && currentChunk.length > 0) {
      chunks.push(currentChunk.join(""));
      currentChunk = [];
      currentLength = 0;
    }

    currentChunk.push(msgText);
    currentLength += msgLength;
  }

  // Add final chunk
  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join(""));
  }

  return chunks;
}

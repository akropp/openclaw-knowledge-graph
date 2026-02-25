import { preprocessText } from "./entity-extract.js";

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
  verbose?: boolean;
}

const SYSTEM_PROMPT = `Extract knowledge triples from this conversation. Return ONLY valid JSON lines, one per triple:
{"subject":"Emily Kropp","predicate":"studies_at","object":"LIM College","subject_type":"person","object_type":"organization"}

Rules:
- Only extract factual relationships about real people, places, organizations, services
- Ignore technical implementation details, code, configs
- Normalize names (full names when possible)
- Use clear predicates: lives_in, works_at, studies_at, dating, married_to, parent_of, child_of, has_phone, has_email, born_on, has_age, member_of, located_in, runs_on, managed_by
- Skip vague or uncertain relationships
- Skip entities that are code, file paths, or technical artifacts
- Return one JSON object per line, no other text`;

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
    const response = await fetch(`${ollamaUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: cleanedText },
        ],
        temperature: 0,
      }),
      signal: AbortSignal.timeout(120000), // 120s timeout (model loading + inference)
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as any;
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      if (opts.verbose) {
        console.warn("  ⚠ LLM returned empty response");
      }
      return [];
    }

    // Parse JSONL response
    const triples: LLMTriple[] = [];
    const lines = content.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("{")) continue;

      try {
        const triple = JSON.parse(trimmed) as LLMTriple;
        
        // Validate triple has required fields
        if (triple.subject && triple.predicate && triple.object) {
          triples.push(triple);
        }
      } catch (err) {
        if (opts.verbose) {
          console.warn(`  ⚠ Failed to parse LLM output line: ${trimmed}`);
        }
      }
    }

    return triples;
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
  maxChars: number = 2000
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

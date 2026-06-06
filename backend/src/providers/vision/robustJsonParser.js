import { createThrownProviderError } from './providerErrors.js';

export function extractFirstJsonObject(text) {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaping = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === '\\') {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        return text.slice(start, i + 1);
      }
    }
  }

  return '';
}

export function parseJsonFromModelOutput(text) {
  if (!text || typeof text !== 'string') {
    throw createThrownProviderError('PARSE_ERROR', 'Model response is empty or not a string', {
      reason: 'EMPTY_RESPONSE'
    });
  }

  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    // Try more forgiving extraction strategies below.
  }

  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {
      // Continue to object extraction.
    }
  }

  const jsonCandidate = extractFirstJsonObject(trimmed);
  if (jsonCandidate) {
    try {
      return JSON.parse(jsonCandidate);
    } catch {
      // Fall through to structured error.
    }
  }

  throw createThrownProviderError('PARSE_ERROR', 'Failed to parse JSON from model response', {
    reason: 'INVALID_JSON',
    preview: trimmed.slice(0, 1000)
  });
}

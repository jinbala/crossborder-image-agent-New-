# AI Provider Integration Guide

This document describes how to add real AI providers after v0.3. Real AI must be added behind provider interfaces and should not modify business routes in `backend/src/routes/tasks.js`.

## Current Provider Structure

Provider interfaces live in `backend/src/providers`:

- `VisionProvider`
- `ImageProvider`
- `ReviewProvider`

Mock implementations live in `backend/src/providers/mock`.

Provider selection is centralized in `backend/src/providers/index.js` and `backend/src/providers/vision/index.js`.

Vision selection:

```env
AI_PROVIDER=mock
VISION_PROVIDER=mock
```

Supported `VISION_PROVIDER` values:

- `mock`
- `qwen`
- `openai`
- `gemini`

If `VISION_PROVIDER` is omitted, it follows `AI_PROVIDER`. If both are omitted, it defaults to `mock`.

## Normalized Provider Response

Every provider method returns:

```js
{
  provider: "mock",
  model: "mock-vision-v0.2",
  durationMs: 12,
  status: "success",
  error: null,
  data: {}
}
```

On failure:

```js
{
  provider,
  model,
  durationMs,
  status: "failed",
  error: {
    code: "MISSING_API_KEY",
    message: "Readable error message",
    details: {}
  },
  data: null
}
```

## VisionProvider

Method:

```js
recognize({ task, image })
```

Input:

- `task`: current task record
- `image`: uploaded source image record with file path, mime type, size, width, and height

Expected normalized `data`:

```js
{
  productInfoRaw: {
    productName,
    category,
    brand,
    model,
    colors,
    sizes,
    capacity,
    material,
    packageIncluded,
    sellingPoints,
    useScenarios,
    targetUsers,
    visibleSpecs
  },
  visibleText: [{ text, language, locationHint, confidence }],
  risks: [{ type, level, message, evidence }],
  confidence: {
    productName,
    category,
    brand,
    model,
    colors,
    sizes,
    capacity,
    material,
    packageIncluded,
    sellingPoints,
    visibleText
  },
  notes: []
}
```

Important rule: real vision output is raw recognition, not confirmed truth. Dimensions, capacity, certifications, material, and functions must remain editable and should not be treated as final until saved as `productInfoConfirmed`.

## Real Vision Providers

### Qwen / DashScope

```env
VISION_PROVIDER=qwen
QWEN_API_KEY=
QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
QWEN_MODEL=qwen-vl-max-latest
```

Qwen uses OpenAI-compatible chat completions with base64 data URL images.

### OpenAI

```env
VISION_PROVIDER=openai
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_VISION_MODEL=gpt-4.1-mini
```

OpenAI uses the Responses API with `input_text` and `input_image`.

### Gemini

```env
VISION_PROVIDER=gemini
GEMINI_API_KEY=
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta
GEMINI_VISION_MODEL=gemini-2.5-flash
```

Gemini uses REST `generateContent` with `inline_data`.

## Manual Validation Script

Use the v0.5 debug script for real provider validation:

```bash
cd backend
node scripts/testVisionRecognition.js test-assets/sample-product.jpg
```

The script reads `.env`, uses `VISION_PROVIDER`, does not write to the JSON database, does not advance task status, and prints normalized data plus `rawResponsePreview` capped at 1000 characters.

If an API key is missing or the provider fails, the script prints a structured error and does not fabricate a successful result.

## Vision JSON Parsing and Normalization

Vision providers must run raw model text through `robustJsonParser.js` and `normalizeVisionResult.js`.

Parser behavior:

- strict JSON first
- JSON markdown code block second
- first complete JSON object extraction third
- structured `PARSE_ERROR` on failure

Normalization behavior:

- fills missing fields with defaults
- clamps confidence values to `0..1`
- converts invalid arrays to empty arrays
- normalizes `visibleText` and `risks`
- drops unknown extra fields

If parsing or normalization fails, the route returns a provider error and does not update task data.

## ImageProvider

Method:

```js
generate({ task, plan, outputIndex })
```

Input:

- `task`: current task with confirmed product info and selected target
- `plan`: image plan with prompt, image type, targetId, and size
- `outputIndex`: export ordering index

Expected `data`:

```js
{
  id,
  planId,
  type,
  title,
  prompt,
  fileName,
  filePath,
  previewUrl,
  provider,
  model,
  status
}
```

Recommended real implementation strategy:

- Preserve product subject as much as possible.
- Generate or replace background separately when possible.
- Use programmatic layout for text-heavy feature, size, and package images.
- Do not let the model invent accessories, certifications, capacity, materials, or functions.

## ReviewProvider

Method:

```js
review({ task, image, plan, target })
```

Input:

- `task`: current task
- `image`: generated image record
- `plan`: source image plan when available
- `target`: selected platform rule target when available

Expected `data`:

```js
{
  id,
  imageId,
  fileName,
  type,
  status,
  riskLevel,
  issues,
  fixSuggestions,
  checks,
  provider,
  model,
  durationMs
}
```

Recommended review layers:

- OCR text extraction
- Chinese text detection
- watermark and price detection
- logo and certification risk checks
- platform-specific main image rules
- file format, dimensions, and color profile checks

## Standardization

Real AI responses should be normalized immediately inside provider implementations. Routes should never parse provider-specific raw payloads. Store raw provider output only in future debug logs or audit tables, not as the primary task schema.

## Error Handling

Provider errors should:

- return `status: "failed"`
- include a readable `error`
- avoid leaking API keys or provider secrets
- preserve `provider`, `model`, and `durationMs`
- let routes convert failure to a controlled HTTP error

## Timeout and Retry

Recommended defaults for real providers:

- vision/OCR timeout: 30 seconds
- image generation timeout: 90 to 180 seconds
- review timeout: 30 to 60 seconds
- retries: 1 or 2 for network and rate-limit errors only
- no retry for validation errors, unsupported file types, or policy errors

Future queue-based execution should move long image generation jobs out of direct HTTP request-response flow.

## Model Slots

Potential future provider implementations:

- Qwen-VL or similar vision model for recognition
- OCR service for visible text extraction
- Tongyi Wanxiang or similar image generation/editing service
- GPT Image or Image2-style image generation provider
- Dedicated visual compliance or logo detection service

## Integration Rule

Real AI should only add provider implementations and provider selection configuration. Business routes, task state machine, platform rules, prompt factory, and export logic should remain provider-agnostic.

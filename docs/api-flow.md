# API Flow

This document describes the current v0.3 API workflow and task state requirements.

## 1. Upload Product Image

- API: `/api/tasks/upload`
- Method: `POST`
- Request: multipart form-data with `image`
- Required status: none, creates a new task
- Success status: `uploaded`
- Common errors:
  - missing image
  - file too large
  - invalid image content

## 2. Product Recognition

- API: `/api/tasks/:id/recognize`
- Method: `POST`
- Required task status: `uploaded`
- Success status: `recognized`
- Output:
  - `productInfoRaw`
  - `visibleText`
  - `risks`
  - `confidence`
  - `recognitionMeta`
- Common errors:
  - `404` task not found
  - `409` wrong task status
  - `502` provider failure, such as `MISSING_API_KEY`, `HTTP_ERROR`, `PARSE_ERROR`, `NORMALIZE_ERROR`

When real recognition fails, the task remains in its previous status and existing `productInfoRaw` is not overwritten. Real recognition results are raw model output after normalization and still require user confirmation.

## 3. Product Information Confirmation

- API: `/api/tasks/:id/product`
- Method: `PATCH`
- Required task status: `recognized` or `confirmed`
- Request body:

```json
{
  "productInfo": {
    "sku": "SKU001",
    "name": "Product name",
    "category": "general"
  }
}
```

- Success status: `confirmed`
- Common errors:
  - missing product name
  - `409` recognition has not run yet

## 4. Select Platform Rules

- API: `/api/tasks/:id/platforms`
- Method: `POST`
- Required task status: `confirmed` or `rules_selected`
- Request body:

```json
{
  "platformId": "amazon",
  "site": "US",
  "language": "English",
  "category": "general"
}
```

- Success status: `rules_selected`
- Common errors:
  - unsupported platform
  - `409` product info has not been confirmed

Supporting API:

- API: `/api/tasks/platform-rules`
- Method: `GET`
- Purpose: returns platform list, image types, and full rule registry for frontend selection

## 5. Generate Image Plans

- API: `/api/tasks/:id/image-plans`
- Method: `POST`
- Required task status: `rules_selected` or `planned`
- Success status: `planned`
- Output:
  - five image plans
  - prompt per plan
  - `promptVersion`
  - target and size metadata
- Common errors:
  - missing confirmed product info
  - missing target/rules snapshot
  - `409` platform rules have not been selected

## 6. Mock Generate Images

- API: `/api/tasks/:id/generate`
- Method: `POST`
- Required task status: `planned` or `generated`
- Success status: `generated`
- Output:
  - generated image records
  - provider metadata
  - file paths and preview URLs
- Common errors:
  - missing image plans
  - provider failure
  - `409` image plans have not been generated

## 7. Compliance Review

- API: `/api/tasks/:id/review`
- Method: `POST`
- Required task status: `generated` or `reviewed`
- Success status: `reviewed`
- Output:
  - `reviewResults`
  - compatibility aggregate `review`
- Common errors:
  - missing generated images
  - provider failure
  - `409` images have not been generated

## 8. ZIP Export

- API: `/api/tasks/:id/export`
- Method: `GET`
- Required task status: `reviewed` or `exported`
- Success status: `exported`
- Output: ZIP file stream
- ZIP contents:
  - generated images
  - `metadata.json`
  - `prompts.json`
  - `review-report.json`
  - `manifest.json`
- Common errors:
  - missing generated images
  - `409` review has not been completed

## Status Error Pattern

Invalid step order returns HTTP `409`:

```json
{
  "error": "Image generation requires task status planned or generated, but current status is confirmed"
}
```

The frontend converts this into a friendlier message and disables invalid action buttons whenever possible.

## Manual Recognition Debug Flow

For v0.5 real provider validation, use:

```bash
cd backend
node scripts/testVisionRecognition.js test-assets/sample-product.jpg
```

This is not part of the task API flow. It does not write to `db.json`, does not create a task, and does not advance status. It is intended only for validating `VISION_PROVIDER=qwen`, `openai`, or `gemini` with local product images.

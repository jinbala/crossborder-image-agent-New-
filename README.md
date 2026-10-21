# Crossborder Image Agent

Crossborder Image Agent is a full-stack MVP for cross-border ecommerce product image production. It runs the workflow from product image upload to mock recognition, product confirmation, platform rule selection, prompt-backed image plans, mock image generation, compliance review, and ZIP export.

The current version is v3.1. Image recognition can run with mock, Qwen, OpenAI, or Gemini Vision providers. Image generation defaults to mock, with an optional OpenAI real background-generation path for safe `lifestyle_image` plans only. Review supports mock rules by default and optional real AI vision risk checks through `REVIEW_PROVIDER`.

## Tech Stack

- Frontend: React, Vite, Tailwind CSS, React Router
- Backend: Node.js, Express
- Uploads: Multer
- Image processing: sharp
- Export: archiver
- Temporary storage: local JSON file at `backend/data/db.json`
- Tests: node:test, supertest

## Current Features

- Single product workflow with up to 15 source images per product/SKU
- Mock product information recognition
- Editable product confirmation form
- Platform rule selection from backend rule registry
- Supported platform registry: Amazon, Temu, Noon, Rakuten, Ozon
- Prompt-backed image plans for eight image types: `main_image`, `feature_image`, `size_image`, `compatibility_image`, `package_image`, `lifestyle_image`, `detail_image`, and `variant_image`
- Mock local image generation with `sharp`
- Optional OpenAI real background generation for safe `lifestyle_image` plans
- Mock compliance review, plus optional AI vision review for risk detection
- ZIP export with images and structured reports
- Frontend task progress and status-aware buttons
- User settings center for local defaults, provider preferences, import scan preferences, queue defaults, safety flags, UI preferences, and cost estimates
- Clean-room operations workbench for spreadsheet/link image collection, resumable ZIP downloads, SKU-folder image packs, drag ordering, target-KB compression, perceptual deduplication, role overrides, naming placeholders, square-image generation, and optional Sharp/rembg/API batch matting
- Chrome/Edge Manifest V3 Temu deep-collection helper under `browser-extension/temu-deep-collector`; v0.4.0 extracts lazy/structured/variant images and can return authorized-session image bytes to localhost (requires the user's own logged-in browser session and live-site acceptance testing)
- RPA web/Windows-client architecture, feature inventory, completion status, acceptance gates, and roadmap: `docs/rpa-web-desktop-development-status.md`
- Web platform + Windows client product requirements, scope, acceptance criteria, current-stage mapping, and milestones: `docs/xingya-web-client-development-requirements.md`
- Windows desktop 0.23.0 localizes controlled export/preflight/payload/sandbox/safety report labels, scan feedback and queue hints without changing business content or downloaded JSON. It also fixes real-sample preview options and strict capability-flag display. Source-file preflight, per-target export isolation, immutable ZIP history and queue safety remain included, with extension 0.5.3. See [implementation progress](docs/implementation-progress.md), [0.23.0 verification](docs/verification-0.23.0.md), [language coverage](docs/i18n-progress.md) and [desktop guide](desktop/README.md). Full bilingual coverage, live-site, model-license, quality and deployment gates remain explicit; build and executable acceptance status are recorded separately.

Workbench pages after startup:

- Operations overview: http://localhost:5173/workbench
- Image collection: http://localhost:5173/workbench/collection
- SKU image packs: http://localhost:5173/workbench/sku-pack
- Detailed usage: `docs/user-manual.md`
- Clean-room boundaries: `docs/clean-room-workbench.md`

Upload limits:

- Up to 15 product images per task
- Each image must be 10MB or smaller
- Total upload size must be 100MB or smaller
- Supported formats: jpg, jpeg, png, webp

## Directory Structure

```text
crossborder-image-agent/
  backend/
    src/
      constants/
      providers/
      prompts/
      routes/
      rules/
      services/
      utils/
    data/db.json
    tests/
  frontend/
    src/
      components/
      pages/
      services/
      utils/
  docs/
  uploads/
  outputs/
```

## Local Setup

Install backend dependencies:

```bash
cd backend
npm.cmd install
```

Install frontend dependencies:

```bash
cd frontend
npm.cmd install
```

## Windows One-Click Start and Stop

First-time setup still requires installing dependencies:

```bash
cd backend && npm.cmd install
cd frontend && npm.cmd install
```

After dependencies are installed, use the Windows batch files in the project root:

- Start app: double-click `启动小程序.bat`
- Stop app: double-click `关闭小程序.bat`
- Check status: double-click `检查小程序状态.bat`

The start script opens separate windows:

- `CrossBorder Backend`
- `CrossBorder Frontend`

It then opens the frontend in your browser:

- Frontend: http://localhost:5173/
- Backend health check: http://localhost:4000/api/health

If startup fails, check:

- Node.js is installed and available in PATH.
- `npm.cmd install` has been run in both `backend` and `frontend`.
- Ports `4000` and `5173` are not already occupied.
- Local `.env` exists if you are using real providers, and it is configured correctly.

The stop script only targets processes listening on ports `5173` and `4000`. It does not delete `uploads`, `outputs`, `backend/data/db.json`, or test images.

## Start Backend

```bash
cd backend
npm.cmd run dev
```

Backend default URL:

```text
http://localhost:4000
```

Health check:

```text
GET http://localhost:4000/api/health
```

## Start Frontend

```bash
cd frontend
npm.cmd run dev
```

Frontend default URL:

```text
http://localhost:5173
```

The Vite dev server is configured for local development with `host: 127.0.0.1`.

## Test Commands

Backend:

```bash
cd backend
npm.cmd test
```

Frontend build:

```bash
cd frontend
npm.cmd run build
```

## Release Package

Create a clean delivery ZIP from a whitelist of source, lockfiles, tests, docs, scripts, and required static test assets:

```bash
node scripts/create-release-package.mjs
```

Validate a release ZIP before sending it:

```bash
node scripts/validate-release-package.mjs crossborder-image-agent-release-YYYYMMDDHHMMSS.zip
```

The validator fails if the ZIP contains runtime dependencies, real `.env` files, SQLite/WAL/SHM files, uploads, outputs, backups, logs, frontend `dist`, or other local runtime artifacts. `package-lock.json` and `.env.example` should remain in the release package.

## Task State Machine

Tasks move through the workflow in this order:

```text
uploaded -> recognized -> confirmed -> rules_selected -> planned -> generated -> reviewed -> exported
```

The backend checks each workflow API against the current task status. Invalid step skips return HTTP `409` with a clear status error. The frontend shows task progress and disables actions that are not valid for the current state.

## Task Data Structure

v0.3 task records keep MVP compatibility fields and add future-ready structure:

```js
{
  id,
  status,
  sourceImages: [],
  productInfoRaw: {},
  productInfoConfirmed: {},
  productInfo: {},
  visibleText: [],
  risks: [],
  confidence: {},
  targets: [{ id, platformId, site, language, category, rulesSnapshot }],
  imagePlans: [{ id, targetId, type, title, description, prompt, promptVersion, size, status }],
  generatedImages: [{ id, planId, filePath, previewUrl, provider, model, durationMs, status }],
  reviewResults: [{ id, imageId, status, riskLevel, issues, fixSuggestions, provider, model }],
  exports: []
}
```

## Platform Rules API

Frontend platform selection reads rules from:

```text
GET /api/tasks/platform-rules
```

The response includes:

- `platforms`: selectable platform metadata
- `imageTypes`: supported image type keys
- `rules`: complete rule registry

Each platform rule supports `platformId`, `site`, `language`, `category`, and image-type rules for the eight system image types: `main_image`, `feature_image`, `size_image`, `compatibility_image`, `package_image`, `lifestyle_image`, `detail_image`, and `variant_image`.

## Provider Interfaces

The backend has three provider interfaces:

- `VisionProvider.recognize`
- `ImageProvider.generate`
- `ReviewProvider.review`

Provider responses use a normalized shape:

```js
{
  provider,
  model,
  durationMs,
  status,
  error,
  data
}
```

## Environment Variables

Copy `.env.example` when you need local provider configuration. Do not commit real `.env` files or API keys.

```env
AI_PROVIDER=mock
VISION_PROVIDER=mock
IMAGE_PROVIDER=mock
BACKGROUND_PROVIDER=mock
VISION_TIMEOUT_MS=300000
VISION_MODEL=
VISION_RECOGNITION_MODE=balanced
VISION_BATCH_SIZE=4
VISION_RETRY_COUNT=1
VISION_FAST_TIMEOUT_MS=90000
VISION_IMAGE_MAX_WIDTH=1280
VISION_IMAGE_QUALITY=75
VISION_VISIBLE_TEXT_LIMIT_PER_IMAGE=10
VISION_VISIBLE_TEXT_TOTAL_LIMIT=80

QWEN_API_KEY=
QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
QWEN_MODEL=qwen-vl-max-latest

OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_VISION_MODEL=gpt-4.1-mini
OPENAI_IMAGE_MODEL=gpt-image-2
OPENAI_IMAGE_EDIT_ENABLED=false
OPENAI_IMAGE_EDIT_MODEL=gpt-image-2
IMAGE_TIMEOUT_MS=300000
IMAGE_RETRY_COUNT=1
IMAGE_OUTPUT_SIZE=1536x1536
IMAGE_EDIT_OUTPUT_SIZE=1536x1536
IMAGE_REFERENCE_MAX_WIDTH=1536
IMAGE_REFERENCE_QUALITY=90

GEMINI_API_KEY=
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta
GEMINI_VISION_MODEL=gemini-2.5-flash
```

Provider behavior:

- `VISION_PROVIDER=mock`: use local mock recognition.
- `VISION_PROVIDER=qwen`: use DashScope/Qwen OpenAI-compatible chat completions.
- `VISION_PROVIDER=openai`: use OpenAI Responses API.
- `VISION_PROVIDER=gemini`: use Gemini REST `generateContent`.
- `IMAGE_PROVIDER=mock`: use local mock image generation for every image type.
- `IMAGE_PROVIDER=real` with `BACKGROUND_PROVIDER=openai`: allow OpenAI background generation only for `lifestyle_image` plans whose `generationRequest` is safe and uses `background_replace`.

Real background generation settings:

- `OPENAI_IMAGE_MODEL=gpt-image-2`: default OpenAI image model for background generation.
- `IMAGE_OUTPUT_SIZE=1536x1536`: requested output size for OpenAI Images API.
- `IMAGE_TIMEOUT_MS=300000` and `IMAGE_RETRY_COUNT=1`: reserved image-generation runtime controls.

To test OpenAI background generation locally:

```env
IMAGE_PROVIDER=real
BACKGROUND_PROVIDER=openai
OPENAI_API_KEY=<your-local-api-key>
OPENAI_IMAGE_MODEL=gpt-image-2
IMAGE_OUTPUT_SIZE=1536x1536
```

Only `lifestyle_image` cards show `灏濊瘯鐪熷疄鑳屾櫙鐢熸垚` when `safeForRealGeneration=true`. Other image types continue to use mock generation. If OpenAI fails or the key is missing, the backend falls back to mock and records `fallbackToMock` and `realGenerationError`.

Real API final-acceptance small samples are intentionally narrower than the full image-plan system. The real-api acceptance endpoint currently allows only `main_image`, `feature_image`, and `detail_image` samples, with explicit confirmations for paid API usage and no platform upload. This is a controlled real-test sample limit; it does not mean the system only supports three image types. Platform rules and review reports are internal planning and risk-check helpers, not official marketplace approval and not a guarantee of platform acceptance.

Current real background generation is text-to-image, not image edit. `productReferenceUsed=false` means the OpenAI output does not strictly preserve the uploaded product subject; it only validates the real generation pipeline for lifestyle scenes. A ZIP can therefore contain a normal mixed image pack: mock preview images, real generated lifestyle images, and fallback mock images. Export metadata and manifest files mark every image with `isMockPreview`, `isRealGenerated`, `fallbackToMock`, `productReferenceUsed`, and `realBackgroundOnly`. Product-preserving image edit/background replacement is planned for a later stage.

To try product-preserving image edit for `lifestyle_image`, set `OPENAI_IMAGE_EDIT_ENABLED=true`. The backend picks one product reference image from the uploaded source images, preprocesses a temporary PNG input, calls OpenAI image edit, and records `editAttempted`, `editSucceeded`, `editFailed`, `fallbackMode`, `productReference`, and `referencePreprocess` in export metadata. If edit fails, the provider falls back to text-to-image first; if that also fails, the existing fallback mock path is used.

v2.3 adds a stricter ecommerce-safe route for `lifestyle_image`: `subject_composite`. The backend extracts the product subject from the selected reference image, asks OpenAI to generate a background-only scene, then composites the preserved subject onto that background with `sharp`. This is preferred over image edit because the product pixels come from the uploaded image instead of being redrawn by AI. The first extractor is a lightweight `sharp` alpha-mask approach for white or light backgrounds; export metadata records `subjectCompositeUsed`, `subjectExtractionMethod`, `subjectPreserved`, `productGeneratedByAI`, `compositeMetadata`, and `fallbackChain`.

v2.4 wraps subject extraction behind a Matting Provider interface. The default is `MATTING_PROVIDER=sharp`, which uses a local light-background alpha mask and works best with white or clean product photos. It now reports `mattingProvider`, `mattingMethod`, `backgroundType`, `edgeQuality`, `mattingConfidence`, and `mattingWarnings`. `MATTING_PROVIDER=external` is reserved for a future third-party matting API; without `MATTING_API_KEY` and `MATTING_BASE_URL` it returns a structured error and never pretends to succeed. For best subject composite results, upload at least one white-background or clean-background main image.

If `VISION_PROVIDER` is omitted, it follows `AI_PROVIDER`. If both are omitted, recognition defaults to mock.

Vision stability settings:

- `VISION_TIMEOUT_MS=300000`: allows longer real multi-image recognition requests.
- `VISION_RECOGNITION_MODE=balanced`: supports `fast`, `balanced`, and `full`.
- `VISION_BATCH_SIZE=4`: sends large SKU image sets to real providers in small batches.
- `VISION_RETRY_COUNT=1`: retries retryable network failures such as timeout, `ECONNRESET`, `429`, and `5xx`.
- `VISION_FAST_TIMEOUT_MS=90000`: keeps fast-mode hung requests from consuming the full 300 second default timeout.
- `VISION_IMAGE_MAX_WIDTH=1280` and `VISION_IMAGE_QUALITY=75`: create temporary compressed model-input images. Original uploaded files are not changed.
- `VISION_VISIBLE_TEXT_LIMIT_PER_IMAGE=10` and `VISION_VISIBLE_TEXT_TOTAL_LIMIT=80`: keep OCR output focused on useful product and compliance text.

Recognition modes:

- `fast`: max width 960, JPEG quality 70, up to 8 prioritized images, visible text limit 5 per image / 40 total, 90 second request timeout by default.
- `balanced`: max width 1280, JPEG quality 75, up to 12 prioritized images, visible text limit 10 per image / 80 total.
- `full`: max width 1600, JPEG quality 85, up to 15 images, visible text limit 15 per image / 120 total.

For batch tests, command-line mode overrides `.env`:

```bash
cd backend
node scripts/runVisionBatchTest.js --provider gemini --dir test-assets/sku001-hard-drive --mode fast
```

## Real Vision Provider Behavior

v1.0 introduced real product image recognition providers behind the `VisionProvider` interface. Later versions add limited real background generation and optional real review, both still guarded behind provider switches.

For real multi-image recognition, the backend now compresses temporary model-input images, splits large SKU image sets into small batches, retries retryable network failures, and can return `partialSuccess` when at least one batch succeeds. The original uploaded files remain unchanged.

Real recognition results are written only to `productInfoRaw`, `visibleText`, `risks`, and `confidence`. They are not final listing data until the user confirms them into `productInfoConfirmed`.

If a real provider is selected but its API key is missing, the `/recognize` API returns a clear `MISSING_API_KEY` error and does not advance task status or overwrite existing recognition data.

Do not change business routes for provider integration. Add or modify provider implementations under `backend/src/providers/vision`, keep the normalized response schema, and switch provider selection through environment configuration.

## Manual Confirmation Principles

AI recognition is not final product truth. Sellers should manually confirm product information before continuing.

- Capacity, certifications, warranty, material, compatibility, model, and brand must be checked carefully against the images.
- Fields without image evidence are not treated as reliable listing information.
- `fieldEvidence` records visible-text or visual evidence for each key field when available.
- `inferredCandidates` are only AI guesses or possible candidates. They are shown for reference and are not automatically copied into confirmed product information.
- `productInfoConfirmed` is the source used by later image plan, mock generation, review, and export steps.

## Manual Vision Recognition Debugging

v0.7 includes a manual debug script that does not write to `db.json` and does not advance task status. It supports single-image, multi-image, folder, recursive folder, and multi-provider comparison runs:

```bash
cd backend
node scripts/testVisionRecognition.js test-assets/sample-product.jpg
node scripts/testVisionRecognition.js --provider qwen --images test-assets/sku001/01-main.jpg test-assets/sku001/02-size.jpg
node scripts/testVisionRecognition.js --provider openai --dir test-assets/sku001
node scripts/testVisionRecognition.js --providers qwen,openai,gemini --dir test-assets/sku001
node scripts/testVisionRecognition.js --providers qwen,openai,gemini --dir test-assets --recursive
```

The script reads local `.env`, calls the selected provider(s), and prints provider, model, durationMs, status, structured error, normalized data summary, and `rawResponsePreview` capped at 1000 characters.

Limits match the upload flow: 1-15 images per SKU, 10MB per image, 100MB total per SKU, jpg/jpeg/png/webp only.

Detailed JSON results are saved under `backend/test-results/`. Result JSON files are ignored by `.gitignore` because they may contain private product metadata.

Batch test reports include image preprocessing status, batch size, retry count, per-provider batch success/failure, partial success status, and compressed input size totals. Use this to compare Gemini/Qwen/OpenAI stability before changing providers.

The script also updates:

```text
docs/vision-recognition-test-report.md
```

Place temporary real product images under `backend/test-assets/` or pass another local path. Do not commit private or large product images.

## Frontend Real Vision Manual Validation

1. Start backend and frontend.
2. Configure local `.env` with `VISION_PROVIDER=qwen`, `VISION_PROVIDER=openai`, or `VISION_PROVIDER=gemini`.
3. Open the app.
4. Upload 1-15 product images.
5. Click `涓婁紶骞惰瘑鍒叏閮ㄥ浘鐗嘸.
6. Open the product confirmation page.
7. Check provider, model, and duration.
8. Check product information fields.
9. Check `鍥剧墖鏂囧瓧璇嗗埆缁撴灉`.
10. Check `璇嗗埆椋庨櫓鎻愮ず`.
11. Manually correct product information.
12. Confirm product info and continue through the mock image-plan flow.

## Multi-Platform Image Packs

v3.4 supports choosing multiple marketplace targets in one task. On the platform rules page, select Amazon, Temu, Noon, Ozon, Rakuten, or use the quick selections such as `Amazon + Temu`, `Amazon + Noon`, and `鍏ㄩ儴骞冲彴`.

Each target stores its own `targetId`, platform, site, language, category, platform rule snapshot, and category rule snapshot. Image plans, generated images, review results, prompts, and exports keep `targetId` / `platformId` so results can be traced back to the correct marketplace rules.

The app still supports the old single-platform workflow. Older tasks without `targets` are treated as one default target.

Multi-platform export creates a unified ZIP with one folder per platform target:

```text
export/
  amazon-US-English/
    images/
    metadata.json
    prompts.json
    review-report.json
    manifest.json
  temu-US-English/
    images/
    metadata.json
    prompts.json
    review-report.json
    manifest.json
  master-metadata.json
```

The export page also supports downloading a single platform package. The app does not upload anything to marketplaces; sellers must manually review and upload images.

## User Settings Center

The Settings Center is available from the top navigation or `/settings`. It stores local operating preferences in `backend/data/db.json` under `userSettings`.

It can manage:

- Default workflow template and default platform targets.
- Preferred Vision/Image/Background/Review/Matting providers.
- Default recognition mode, generation mode, review mode, and batch queue concurrency.
- Import scan preferences such as root directory, enabled flag, depth, and max SKU count.
- Local cost estimates per provider call.
- Safety preferences such as requiring human confirmation, preventing automatic real generation, showing mock warnings, and showing cost warnings.
- UI preferences such as default batch view and whether advanced panels start collapsed.

Security rules:

- The Settings Center does not save API keys, tokens, passwords, or secrets.
- API keys still belong only in local `.env`.
- `/api/settings/effective` returns only key presence summaries, never real key values.
- Cost estimates are local references only and do not represent real provider bills.

Existing workflows read these defaults where appropriate: new batch imports can use the default template and targets, batch queues use the default concurrency when no concurrency is supplied, import scanning can use the preferred root directory, and analytics prefer Settings Center cost estimates before `.env` cost values.

## Project Snapshots and Backup Restore

The backup page is available at `/snapshots`. It creates local ZIP snapshots under `backups/` so you can recover from accidental deletion, a damaged `db.json`, or a bad local change.

Snapshots include:

- `backend/data/db.json`
- `uploads/`
- `outputs/`
- `docs/`
- `README.md`
- `.env.example`
- `snapshot-metadata.json`

Snapshots never include:

- `.env`
- API keys, tokens, or secrets
- `node_modules/`
- `.vision-tmp/`
- `backups/`
- `backend/test-results`

Restore behavior:

- Restore requires explicit confirmation in the UI or API.
- By default the app creates a pre-restore snapshot before overwriting data.
- `restoreDb` overwrites `backend/data/db.json`.
- `restoreUploads` and `restoreOutputs` replace the local upload and output folders.
- `restoreDocs` is off by default to avoid overwriting current documentation.
- `.env` is never restored or overwritten.

Do not upload `backups/` to GitHub or public tools. Backup ZIPs may contain real product images and generated operating data. If you need to share a clean project with ChatGPT/Codex, use a clean package rather than a backup snapshot.

## Batch SKU Tasks

v3.5 adds a local batch SKU framework for operations teams that need to process multiple products in one run. A batch task only orchestrates existing single-SKU tasks; each SKU still uses the normal upload, recognition, product confirmation, platform target, plan, generation, review, and export flow.

Recommended folder structure:

```text
batch-import/
  sku001-hard-drive/
    01-main.jpg
    02-size.jpg
    03-package.jpg
  sku002-hard-drive/
    01-main.jpg
    02-size.jpg
    03-package.jpg
```

Rules:

- Each child folder is treated as one SKU.
- Each SKU supports 1-15 jpg/jpeg/png/webp images.
- Each image must be 10MB or smaller.
- Each SKU folder must be 100MB or smaller in total.
- Empty folders are skipped with a warning.
- Unsupported files are skipped and recorded as warnings.

The batch page is available at `/batches`. Enter a local `folderPath`, choose default platform targets, then import. This is a local-development feature; do not point it at system-sensitive folders. A production deployment should replace this with browser uploads or a restricted import directory.

Batch actions are intentionally conservative:

- `鎵归噺璇嗗埆` runs the configured VisionProvider per SKU, but does not confirm product information.
- Sellers must open each SKU and confirm product information manually.
- `搴旂敤骞冲彴 targets` writes the selected multi-platform targets to confirmed SKUs.
- `鎵归噺鐢熸垚鏂规`, `鎵归噺鐢熸垚鍥剧墖`, and `鎵归噺瀹℃牳` skip SKUs whose status is not ready.
- A failed SKU does not stop the rest of the batch; the batch records per-SKU success, skipped, failed, and error details.

Batch queues:

- v3.6 adds a lightweight in-process queue for `recognize`, `plan`, `generate`, and `review`.
- Default concurrency is `2`; keep real AI recognition concurrency low to avoid timeout, rate-limit, or cost surprises.
- The queue writes status, lock info, per-SKU queue state, and execution logs to `db.json`.
- Queue controls support start, pause, resume, cancel, and retry failed jobs.
- Logs are capped to the most recent 500 entries to avoid unbounded JSON growth.
- This is not a production queue. A production deployment should move to SQLite/Postgres plus a real queue such as Redis-backed workers.

Queue environment variables:

```env
BATCH_DEFAULT_CONCURRENCY=2
BATCH_MAX_CONCURRENCY=4
BATCH_JOB_TIMEOUT_MS=600000
BATCH_LOCK_TTL_MS=900000
```

Safe import directory scanning:

- v3.7 adds an optional scanner for a configured local import root. It discovers SKU child folders and lets the user manually import selected `new` candidates into a batch task.
- Scanning never calls real AI, never generates images, never reviews, and never exports. It only creates a batch task after the user confirms import.
- The scanner only accepts paths under `IMPORT_ROOT_DIR`; do not point it at system folders, user home, drive roots, or other sensitive locations.
- Already imported folder paths are recorded in `db.json` as `importedFolders`, so the same folder is shown as `imported` instead of being imported again.

Recommended scan root structure:

```text
import-root/
  sku001-hard-drive/
    01-main.jpg
    02-size.jpg
  sku002-hard-drive/
    01-main.jpg
```

Scanner environment variables:

```env
IMPORT_ROOT_DIR=
IMPORT_SCAN_ENABLED=false
IMPORT_SCAN_MAX_DEPTH=2
IMPORT_SCAN_MAX_SKU=200
IMPORT_SCAN_ALLOWED_EXTENSIONS=jpg,jpeg,png,webp
```

Batch analytics and cost estimates:

- v3.8 adds a batch result dashboard for SKU success/failure, generated image sources, review risks, provider usage, duration, warnings, and estimated cost.
- Analytics can be recomputed from the current batch and its linked single-SKU tasks, so it does not depend only on runtime counters.
- Cost is a local estimate only. It is calculated as provider call count multiplied by user-configured per-call values and does not represent a real provider invoice.
- Use the dashboard to decide whether to retry failed SKUs, lower real-AI concurrency, switch providers, or manually inspect high-risk outputs.

Optional cost estimate variables:

```env
COST_VISION_GEMINI_PER_CALL=0
COST_VISION_OPENAI_PER_CALL=0
COST_VISION_QWEN_PER_CALL=0
COST_IMAGE_OPENAI_PER_CALL=0
COST_REVIEW_GEMINI_PER_CALL=0
COST_REVIEW_OPENAI_PER_CALL=0
COST_REVIEW_QWEN_PER_CALL=0
COST_MATTING_EXTERNAL_PER_CALL=0
```

Batch failure classification and retry:

- v3.9 classifies batch job failures into `timeout`, `provider`, `config`, `input`, `state`, `network`, `validation`, and `unknown`.
- Retryable failures include timeouts, temporary provider/network errors, rate limits, and parse errors. Missing API keys, quota/billing errors, invalid state, bad images, and safe-check failures require user action first.
- Automatic retry is disabled by default to avoid unexpected real AI cost. Enable it only when you understand the provider cost and rate-limit impact.
- Lower concurrency if the dashboard shows timeouts or provider rate limits.

```env
BATCH_AUTO_RETRY_ENABLED=false
BATCH_MAX_RETRY_PER_JOB=1
BATCH_RETRY_DELAY_MS=5000
BATCH_RETRY_BACKOFF=linear
BATCH_RETRYABLE_CODES=JOB_TIMEOUT,HTTP_ERROR,PARSE_ERROR,PROVIDER_RATE_LIMIT,ECONNRESET
```

Batch workflow templates:

- v4.0 adds workflow templates for common batch operating modes. Templates fill default platform targets, provider names, recognition mode, generation/review mode suggestions, queue concurrency, retry settings, and export preferences.
- Templates never store API keys and never start AI work automatically. Applying a template only updates batch configuration and saves a `workflowTemplateSnapshot`; the user still starts recognition, planning, generation, review, and export manually.
- Built-in templates:
  - `mock_preview_all_platforms`: mock-only preview for Amazon, Temu, and Noon.
  - `hard_drive_multi_platform_balanced`: electronics storage / hard-drive flow for Amazon, Temu, Noon, Ozon, and Rakuten with Gemini balanced recognition suggested.
  - `low_cost_batch`: mock/low-cost batch mode.
  - `real_lifestyle_test`: suggests OpenAI real lifestyle background configuration but does not auto-generate.
  - `real_review_check`: suggests real Gemini review checks.
- System templates cannot be deleted. Copy a system template to create an editable user template.
- If a template suggests Gemini/OpenAI/Qwen but the matching API key is missing, the batch page shows warnings such as `GEMINI_API_KEY` missing. The template still applies because keys belong in `.env`, not in templates.
- Scan import can apply a selected template while creating a batch. The imported batch remains in `imported` state and does not call AI until the user starts a queue action.

Batch operation guide:

- v4.1 adds a beginner-friendly batch operation guide at the top of BatchPage.
- Recommended flow: scan/import SKU folders, choose or apply a workflow template, run batch recognition, manually confirm each SKU, apply platform targets, generate image plans, generate image previews, review images, then export the batch ZIP.
- The guide calculates the current step from each SKU task status and shows blockers such as pending manual confirmation, retryable failures, missing template configuration, or user-action errors.
- The guide never calls real AI automatically, never skips `productInfoConfirmed`, and never uploads to any marketplace.
- Existing manual controls remain available under Advanced Operations, including queue execution, analytics, cost estimate, logs, retry filters, and direct batch action buttons.

SOP export:

- v4.2 adds Markdown SOP export.
- The general SOP explains the full app workflow, environment configuration, single-SKU flow, batch flow, template usage, queue/retry, review, export, cost estimates, and common errors.
- The batch SOP is generated from the current batch state. It includes the current guide step, blockers, SKU status list, pending confirmations, failed/retryable/user-action SKUs, platform targets, template snapshot, queue status, provider usage, estimated cost, review risk summary, and a next-action checklist.
- Download the general SOP from Dashboard or BatchPage. Download or preview the current batch SOP from BatchPage.
- SOP files are Markdown only in v4.2. They never include `.env` content or API keys.

System health check:

- v4.5 adds a system health / environment diagnostics center at `/health`.
- The health page checks backend environment summary, provider configuration, storage paths, `db.json`, snapshots, import scan configuration, batch queue locks, disk usage, and basic security reminders.
- API keys are never printed. The diagnostics only show boolean key status such as whether Gemini/OpenAI/Qwen credentials are configured.
- Use the HealthPage "Copy Diagnostic Report" button to copy a sanitized Markdown report for ChatGPT/Codex troubleshooting.
- Common fixes:
  - Provider missing key: configure the matching key in local `.env`, or switch the provider back to `mock`.
  - `db.json` invalid JSON: restore from a snapshot under `backups/`.
  - `uploads` / `outputs` not writable: check folder permissions or recreate the directories.
  - import root unsafe or missing: set `IMPORT_ROOT_DIR` to a dedicated SKU import folder, not a system or user root directory.
  - disk space low: clean old outputs, temporary files, or local backups.
  - expired batch queue lock: reopen the batch page and restart or cancel the queue.

SQLite storage preparation:

- v4.6 adds an optional SQLite storage layer while keeping JSON as the default. Existing users do not need to migrate immediately.
- Default configuration remains:

```env
STORAGE_DRIVER=json
```

- To prepare SQLite metadata storage, run:

```bash
cd backend
node scripts/migrateJsonToSqlite.js
node scripts/verifySqliteMigration.js
```

- Then enable SQLite by changing local `.env` and restarting the backend:

```env
STORAGE_DRIVER=sqlite
SQLITE_DB_PATH=backend/data/app.sqlite
SQLITE_AUTO_MIGRATE=false
SQLITE_BACKUP_JSON_BEFORE_MIGRATE=true
```

- `db.json` is not deleted. Uploaded source images and generated outputs are not moved; only metadata is migrated.
- SQLite files under `backend/data/*.sqlite` and `backend/data/*.sqlite-*` are ignored by Git and should not be committed.
- To return to JSON mode, set `STORAGE_DRIVER=json` and restart the backend.
- Creating a project snapshot before migration is recommended. Snapshots now record the active storage driver and include `app.sqlite` when it exists, but still never include `.env` or API keys.
- v4.7 upgrades SQLite to schema version 2 with structured index tables for batch SKU status, queue status, analytics summary, provider usage, and review risk. The complete task and batch objects still remain in `data_json`; these indexes are only query accelerators for Dashboard, Batch Analytics, and Health Check.
- If SQLite indexes are missing or stale, the app falls back to object scanning. Index damage does not mean task data is lost.
- To rebuild SQLite indexes manually, run:

```bash
cd backend
node scripts/rebuildSqliteIndexes.js --sqlite
```

- The migration script builds v2 indexes automatically, and the verification script checks schema version and index counts.
- v4.8 adds a controlled SQLite trial workflow. The app can check readiness, migrate, verify, rebuild indexes, and show trial status, but it still does not edit `.env` for you.
- Recommended SQLite trial process:
  1. Create a project snapshot from the backup page.
  2. Open Storage Management and run the preflight check.
  3. Run "Create snapshot and migrate to SQLite".
  4. Run SQLite verification.
  5. If verification passes, manually edit local `.env`:

```env
STORAGE_DRIVER=sqlite
SQLITE_DB_PATH=backend/data/app.sqlite
```

  6. Restart the backend.
  7. Open HealthPage and confirm SQLite/schema/index checks are healthy.
  8. Run a small batch first.
  9. If anything looks wrong, set `STORAGE_DRIVER=json` and restart the backend.

- JSON is never deleted during the trial. The page does not migrate uploads or outputs; it only migrates metadata.
- The StoragePage can run:
  - `GET /api/storage/status`
  - `POST /api/storage/preflight-sqlite`
  - `POST /api/storage/migrate-to-sqlite`
  - `POST /api/storage/verify-sqlite`
  - `POST /api/storage/rebuild-sqlite-indexes`
- SQLite trial status is stored in `userSettings.sqliteTrial`, including the last migration and verification reports.

SQLite small-batch trial acceptance:

After SQLite migration and verification pass, validate it with a small operational run before using it long term:

1. Create a project snapshot.
2. Open Storage Management and run the preflight check.
3. Run migration.
4. Run verification.
5. Rebuild SQLite indexes.
6. Manually edit local `.env`:

```env
STORAGE_DRIVER=sqlite
SQLITE_DB_PATH=backend/data/app.sqlite
```

7. Restart the backend.
8. Open HealthPage and confirm SQLite storage, schema, and index checks are healthy.
9. Run one single-SKU mock workflow.
10. Run one batch with 1-2 SKUs in mock mode.
11. Refresh Batch Analytics and confirm it loads normally.
12. Create another project snapshot while SQLite mode is active.
13. Export one ZIP package.
14. Run the SQLite trial checklist on StoragePage or from the backend:

```bash
cd backend
node scripts/runSqliteTrialCheck.js
```

If anything looks wrong, safely roll back by editing `.env` and restarting the backend:

```env
STORAGE_DRIVER=json
```

The trial checklist is advisory. It does not call real AI, does not modify `.env`, and does not delete `db.json`.

Batch export creates a ZIP like:

```text
sku001-hard-drive/
  amazon-US-English/
    images/
    metadata.json
    prompts.json
    review-report.json
    manifest.json
  temu-US-English/
    images/
    metadata.json
    prompts.json
    review-report.json
    manifest.json
sku002-hard-drive/
  amazon-US-English/
    ...
batch-master-metadata.json
```

## v5.0 鏁版嵁娓呯悊 / 涓存椂鏂囦欢绠＄悊

鏁版嵁娓呯悊椤甸潰浣嶄簬 `/cleanup`锛岀敤浜庢煡鐪嬫湰鍦拌繍琛屾枃浠跺崰鐢紝骞舵墜鍔ㄩ瑙堛€佺‘璁ゆ竻鐞嗘棫鐨勮繍琛屼骇鐗┿€傚畠鍙鐞嗘槑纭?allowlist 鍐呯殑杩愯鐩綍锛屼緥濡?`.vision-tmp`銆乣backend/test-results`銆佹棫 `outputs`銆佹棫瀵煎嚭 ZIP銆佹棫澶囦唤 ZIP銆佷复鏃舵姞鍥炬枃浠跺拰鏃?mock 鍥剧墖銆?
杩欎釜鍔熻兘涓嶄細娓呯悊 `.env`銆乣.env.*`銆丄PI Key銆乣backend/data/app.sqlite`銆乣backend/data/db.json`銆佹簮鐮佺洰褰曘€佹祴璇曟簮鐮併€乣docs`銆乣README.md`銆乣node_modules`銆乣package.json` 鎴?`package-lock.json`銆傚鍎?`uploads` 绗竴鐗堝彧鏍囪涓洪珮椋庨櫓锛岄粯璁や笉浼氬垹闄ゃ€?
蹇呴』鍏堥瑙堝啀娓呯悊锛屾槸涓轰簡璁╃敤鎴风湅鍒板皢瑕佸垹闄ょ殑鏂囦欢銆佸ぇ灏忋€佷慨鏀规椂闂淬€侀闄╃瓑绾у拰涓枃鍘熷洜銆俙POST /api/cleanup/preview` 鍙繑鍥炲€欓€夊垪琛紝涓嶅垹闄や换浣曟枃浠讹紱`POST /api/cleanup/run` 蹇呴』浼犲叆 `confirm=true`锛屽苟涓斿悗绔細閲嶆柊鎸夊悓涓€瑙勫垯鐢熸垚鍊欓€夊垪琛ㄥ悗鍐嶅垹闄わ紝涓嶇浉淇″墠绔紶鏉ョ殑鏂囦欢璺緞銆?
鎺ㄨ崘娓呯悊绛栫暐锛?
- `.vision-tmp`锛? 澶╁墠鍙竻鐞嗐€?- `backend/test-results`锛? 澶╁墠鍙竻鐞嗐€?- `outputs`锛?0 澶╁墠璋ㄦ厧娓呯悊銆?- 瀵煎嚭 ZIP锛?0 澶╁墠璋ㄦ厧娓呯悊銆?- `backups`锛?0 澶╁墠璋ㄦ厧娓呯悊锛屾竻鐞嗗墠纭宸叉湁鏇存柊蹇収銆?- `uploads`锛氶粯璁や笉寤鸿鑷姩娓呯悊銆?
娓呯悊鎺ュ彛锛?
```text
GET /api/cleanup/summary
POST /api/cleanup/preview
POST /api/cleanup/run
```

娓呯悊鍔熻兘娌℃湁瀹氭椂浠诲姟锛屼篃涓嶄細鑷姩鎵ц銆傛瘡娆″垹闄ら兘闇€瑕佹墜鍔ㄩ瑙堝拰浜屾纭銆?
## Audit Notes

Frontend `npm audit` currently reports 2 moderate issues from Vite and esbuild development tooling. The suggested automatic fix requires a Vite major upgrade. v0.3 does not run `npm audit fix --force`; the risk is limited to development server exposure, and the Vite server is configured for localhost.

Backend `npm audit` currently reports 0 vulnerabilities.

## Current Limits

- Real image generation is limited to OpenAI text-to-image background generation for safe `lifestyle_image` plans
- Mixed mock + real image packs are expected until product-preserving image edit is added
- Subject composite currently uses a simple light-background extraction method; difficult backgrounds may need a stronger matting provider later
- `MATTING_PROVIDER=external` is a placeholder for a future professional matting API and is not implemented yet
- v2.6 prepares a generic external matting HTTP provider. Configure it with `MATTING_PROVIDER=external`, `MATTING_API_KEY`, `MATTING_BASE_URL`, optional `MATTING_MODEL`, and keep `MATTING_FALLBACK_PROVIDER=sharp` so subject_composite can fall back to local sharp cutout if the external API fails.
- External matting accepts JSON `subjectPngBase64`, JSON `subjectPngUrl`, or direct `image/png` binary responses. Use `cd backend && node scripts/testMattingProviders.js --providers sharp,external --image test-assets/sku001/01-main.png` to compare cutout quality without running full image generation.
- v2.7 lets sellers choose the product reference image per `lifestyle_image` plan and preview the cutout before subject composite generation. A clean white or light-background full product image is usually the best reference; hand-held, shadow-heavy, or complex-background images may produce rough edges and should be previewed first.
- v2.8 adds editable `compositeSettings` for `lifestyle_image` subject composite output. Use presets such as desk center, bottom-center desk, right-side hero, or floating product, then fine-tune scale, placement, offsets, shadow, edge feather, and basic color match before regenerating the single image.
- If a subject composite result looks pasted onto the scene, first reduce/increase subject scale, move the product closer to the desk surface, enable soft contact shadow, and apply light edge feather. If edges still look rough, switch to a cleaner reference image or use a professional matting provider later.
- v2.9 renders text-heavy auxiliary images with programmatic text layout instead of asking AI to draw text. `feature_image`, `size_image`, `compatibility_image`, `package_image`, and `variant_image` use confirmed product fields and plan `textBlocks` to build stable `textElements`, `iconElements`, and `lineElements`. Chinese, prices, promotion copy, platform-sensitive claims, and unconfirmed high-risk specs are filtered before rendering.
- Programmatic text layout reduces misspellings, mojibake, invented specs, and marketplace compliance risk. Later work can add a visual canvas editor, but the current flow keeps text rendering deterministic and exportable through `textLayout` metadata.
- v3.0 adds a lightweight visual layout editor for programmatic text-layout images. Sellers can adjust text blocks, icons, and dimension/callout lines by changing position, size, visibility, alignment, and layer order, then save a `textLayoutOverride` for the current plan and regenerate only that image.
- The layout editor applies only to `feature_image`, `size_image`, `compatibility_image`, `package_image`, and `variant_image`. Main images and lifestyle images keep their existing flows. Edited text still passes marketplace text safety checks, so Chinese, prices, promotions, unconfirmed capacity, and unconfirmed certification/warranty copy are blocked before rendering.
- v3.1 adds ReviewProvider support. `REVIEW_PROVIDER=mock` remains the default; `REVIEW_PROVIDER=gemini`, `openai`, `qwen`, or `vision` can run AI vision review combined with rule-based checks. Real review is only an auxiliary risk check for Chinese text, prices, promotion, watermark, main-image violations, unconfirmed specs, generation-source risk, and text-layout issues. It is not official platform approval.
- To test the review provider manually, run `cd backend && node scripts/testReviewProvider.js --provider gemini --image test-assets/sample.jpg`. The script prints structured JSON and never writes to `db.json`.
- v3.2 expands the internal platform rule registry for Amazon, Temu, Noon, Ozon, and Rakuten. Main-image rules and auxiliary-image rules are evaluated separately, with stricter handling for text, non-white backgrounds, prices, promotions, watermarks, seller logos, unconfirmed certifications, warranty claims, and target-language requirements.
- Platform rules are internal helper rules for planning and risk review. They are not official marketplace policy, not guaranteed complete, and do not replace platform documentation or final human review. Category-specific rules can be added later without changing the ReviewProvider contract.
- v3.3 adds category rules on top of platform rules. Platform rules answer "what does this marketplace/image type allow"; category rules answer "what claims are risky for this product type." The first detailed category is `electronics_storage` for external hard drives, portable SSDs, and storage devices.
- For electronics/storage products, capacity, interface, speed, compatibility, package contents, certifications, warranty, waterproof/shockproof, and performance claims require visible evidence or explicit user confirmation before they should appear in image copy. These rules are auxiliary checks only and do not represent official platform approval.
- v3.4 adds multi-platform image pack generation. One confirmed product can generate separate plans, previews, reviews, and export folders for Amazon, Temu, Noon, Ozon, and Rakuten. Each platform uses its own platform and category rule snapshots, while single-platform tasks continue to work as before.
- v3.5 adds batch SKU tasks. Batch import creates normal single-SKU tasks from child folders and then provides batch recognition, target application, planning, generation, review, and export controls. Product confirmation is still manual per SKU.
- v3.6 adds a lightweight batch queue with SKU-level concurrency, DB-backed locks, pause/resume/cancel, retry failed jobs, queue statistics, and execution logs. It is intended for local batch processing, not production-grade distributed workers.
- v3.7 adds safe import directory scanning. It finds new/imported/invalid SKU folders under `IMPORT_ROOT_DIR` and imports selected new folders into a batch task without starting AI work automatically.
- v3.8 adds batch analytics and local cost estimates. The dashboard summarizes provider calls, image source mix, review risk, duration, warnings, and estimated costs for deciding retries or provider changes.
- v3.9 adds batch failure classification and controlled retry filters. Retryable errors can be retried automatically when enabled, while config/input/state errors surface clear user action suggestions.
- v2.5 adds product-preserve quality scoring for generated lifestyle images. `subject_composite` is best for clean white or light-background product references, `image_edit` is useful for complex references but may redraw details, and `text_to_image` does not guarantee product fidelity.
- For real marketplace work, prefer a white-background main product image, use `subject_composite`, then manually review product shape, color, texture, ports, logo, and edge quality before export.
- Local JSON storage is not production-grade for concurrent writes
- Single-product workflow only, with up to 15 source images for that product/SKU
- Compliance review is an auxiliary risk check. Mock review is for flow testing; real AI review can help find visual/text risks but does not replace human review or official platform decisions.
- Platform rule content is a starting registry, not a complete marketplace policy database

## Next Plan

The next recommended step is testing real product images with the configured vision provider and improving prompt/normalization accuracy before moving to real review.

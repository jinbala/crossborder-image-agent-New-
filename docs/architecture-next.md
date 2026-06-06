# Crossborder Image Agent v0.2 Architecture

## 1. Current MVP Architecture

The current MVP is a React + Vite + Tailwind frontend paired with a Node.js + Express backend. The backend stores task state in `backend/data/db.json`, writes uploaded files to `uploads`, writes generated files and exports to `outputs`, and uses mock services for product recognition, image generation, compliance review, and ZIP export.

The MVP workflow is task-centric:

1. Upload one product image.
2. Mock-recognize product information.
3. Confirm product fields.
4. Select marketplace platform and language.
5. Generate five image plans.
6. Mock-generate images with `sharp`.
7. Run compliance review.
8. Export a ZIP package.

This is a good process prototype, but the MVP data model is still too flat for multi-SKU, multi-platform, multi-language, and real AI provider integration.

## 2. v0.2 Architecture Goals

v0.2 keeps the MVP flow intact while strengthening the boundaries that will matter later:

- Centralize task status definitions and prevent workflow steps from being skipped.
- Split model-recognized product data from user-confirmed product data.
- Introduce target records for platform, site, language, category, and rule snapshots.
- Move marketplace rules into a structured registry.
- Add provider interfaces for vision, image generation, and review so real AI can be added without rewriting routes.
- Version prompts and keep generated prompts traceable.
- Export images plus structured metadata, prompts, review results, and manifest files.

## 3. Task State Machine

Allowed statuses:

- `uploaded`
- `recognized`
- `confirmed`
- `rules_selected`
- `planned`
- `generated`
- `reviewed`
- `exported`

Allowed transitions:

- `uploaded -> recognized`
- `recognized -> confirmed`
- `confirmed -> rules_selected`
- `rules_selected -> planned`
- `planned -> generated`
- `generated -> reviewed`
- `reviewed -> exported`

Workflow APIs must verify the current task status before mutating the task. Re-running some idempotent steps can be allowed only when it is safe and explicitly defined, such as regenerating image plans after `planned`.

## 4. New Task Data Structure

The v0.2 task schema is compatible with the MVP but introduces future-ready fields:

```js
{
  id,
  status,
  sourceImages: [],
  originalImage, // compatibility alias for the first source image
  productInfoRaw: {},
  productInfoConfirmed: {},
  productInfo, // compatibility alias for confirmed info, then raw info
  visibleText: [],
  risks: [],
  confidence: {},
  targets: [
    {
      id,
      platformId,
      site,
      language,
      category,
      rulesSnapshot
    }
  ],
  platform, // compatibility display name
  language, // compatibility field
  imagePlans: [
    {
      id,
      targetId,
      type,
      title,
      description,
      prompt,
      promptVersion,
      size,
      status
    }
  ],
  generatedImages: [
    {
      id,
      planId,
      filePath,
      previewUrl,
      url, // compatibility alias
      provider,
      model,
      durationMs,
      status
    }
  ],
  reviewResults: [
    {
      id,
      imageId,
      status,
      riskLevel,
      issues,
      fixSuggestions,
      provider,
      model,
      durationMs
    }
  ],
  review, // compatibility aggregate
  exports: [],
  exportFile // compatibility alias for the latest export
}
```

## 5. API Naming and Responsibilities

The current endpoints remain available for MVP compatibility. Their responsibilities are:

- `GET /api/tasks`: list tasks.
- `GET /api/tasks/:id`: get task detail.
- `POST /api/tasks/upload`: create task from upload.
- `POST /api/tasks/:id/recognize`: run product recognition.
- `PATCH /api/tasks/:id/product`: save confirmed product info.
- `POST /api/tasks/:id/platforms`: save target platform selection and rules snapshot.
- `POST /api/tasks/:id/image-plans`: generate prompt-backed image plans.
- `POST /api/tasks/:id/generate`: generate images from plans.
- `POST /api/tasks/:id/review`: review generated images.
- `GET /api/tasks/:id/export`: export package.
- `GET /api/tasks/platform-rules`: list marketplace rule registry for frontend selection.

Future API cleanup can add clearer resources such as `/api/platform-rules`, `/api/tasks/:id/targets`, and `/api/tasks/:id/plans` while keeping old endpoints as aliases during migration.

## 6. Provider Interface Design

Providers are selected with `AI_PROVIDER`, defaulting to `mock`.

Provider interfaces:

```js
VisionProvider.recognize({ task, image })
ImageProvider.generate({ task, plan, target, productInfo })
ReviewProvider.review({ task, image, plan, target })
```

Each provider response must include:

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

Routes should depend on provider interfaces, not on mock implementation files. A real AI provider can later implement the same methods and return the same normalized schema.

## 7. Platform Rule Registry Schema

Rules are keyed by platform, site, language, category, and image type:

```js
{
  platformId: "amazon",
  name: "Amazon",
  sites: ["US"],
  languages: ["English"],
  categories: ["general"],
  imageTypes: {
    main_image: {
      background,
      textAllowed,
      watermarkAllowed,
      logoAllowed,
      minSize,
      recommendedSize,
      productArea,
      fileFormats,
      bannedElements,
      languageRules,
      notes
    }
  }
}
```

The selected target stores a `rulesSnapshot` so generated plans remain traceable even if platform rules change later.

## 8. Prompt Template Design

`imagePromptFactory.js` is the single prompt entry point. Prompts include:

- `promptVersion`
- platform, site, language, category
- image type and image-specific rules
- user-confirmed product information
- package list and selling points
- hard prohibitions against inventing parameters, certifications, functions, capacity, or materials

Prompt templates should be deterministic and traceable. Later, language-specific templates can be added without changing route logic.

## 9. Export File Structure

ZIP packages include:

```text
Amazon_SKU001_01_main-image.jpg
Amazon_SKU001_02_feature-image.jpg
metadata.json
prompts.json
review-report.json
manifest.json
```

`metadata.json` records task, source image, target, generated image, and provider metadata. `prompts.json` records every image plan and prompt. `review-report.json` records review results and fix suggestions. `manifest.json` is the package index.

## 10. Real AI Integration Route

Recommended sequence:

1. Keep v0.2 mock providers as the contract test baseline.
2. Add a real vision provider that returns normalized `productInfoRaw`, `visibleText`, `risks`, and `confidence`.
3. Add OCR-backed review before full visual compliance review.
4. Add image generation provider with product-subject preservation strategy.
5. Add queueing and persistent database only after provider contracts stabilize.

No real AI API is required in v0.2.

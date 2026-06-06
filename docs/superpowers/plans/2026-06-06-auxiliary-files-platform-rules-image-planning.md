# Auxiliary Files, Platform Rules, and Image Planning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add non-video auxiliary product files to recognition, refine platform image rules, and expand image planning to 1 main image, 9 carousel images, and variant-derived SKU images.

**Architecture:** Work is split across three reviewable branches: `feature/product-recognition-v2`, `feature/platform-rules-v2`, and `feature/image-planning-v2`. Recognition stores auxiliary file metadata and extracted text on tasks; platform rules expose per-platform image requirements; image planning consumes confirmed product info, evidence, and platform snapshots without mutating recognition data.

**Tech Stack:** Node.js/Express backend, React/Vite frontend, built-in file scanning, `multer` uploads, Node test runner.

---

### Task 1: Product Recognition V2

**Files:**
- Create: `backend/src/services/auxiliaryFileService.js`
- Modify: `backend/src/services/batchTaskService.js`
- Modify: `backend/src/services/importScanService.js`
- Modify: `backend/src/providers/vision/visionPrompt.js`
- Modify: `frontend/src/pages/BatchPage.jsx`
- Modify: `frontend/src/pages/ProductInfoPage.jsx`
- Test: `backend/tests/auxiliaryFileService.test.js`
- Test: `backend/tests/importScanService.test.js`
- Test: `backend/tests/visionProvider.test.js`

- [ ] Add an auxiliary file classifier that accepts `txt`, `csv`, `html`, `htm`, `pdf`, `xls`, `xlsx`, `doc`, and `docx`, and rejects video extensions such as `mp4`, `mov`, `avi`, `mkv`, and `webm`.
- [ ] Add lightweight text extraction for text-like files; for binary formats without a parser, store metadata and a warning instead of blocking import.
- [ ] Raise the image import limit from 15 to 30 across scan, import, and recognition prompt context.
- [ ] Attach `auxiliaryFiles` and `auxiliaryText` to each task created by folder import and scan import.
- [ ] Add UI display for recognized auxiliary files and extraction warnings on product confirmation.
- [ ] Add tests proving video files are excluded, 30 images are allowed, 31 images are blocked, and auxiliary text appears in the recognition prompt.

### Task 2: Platform Rules V2

**Files:**
- Modify: `backend/src/rules/platformRules.js`
- Modify: `backend/src/services/complianceService.js`
- Modify: `frontend/src/utils/platformRulesDisplay.js`
- Test: `backend/tests/platformRuleUtils.test.js`
- Test: `frontend/tests/platformRulesDisplay.test.js`

- [ ] Split platform main-image rules by platform instead of using a single white-background rule.
- [ ] Preserve Amazon strict white-background, no-text main image behavior.
- [ ] Keep Temu product-first but allow clean neutral/light commercial main images when text remains safe and non-promotional.
- [ ] Keep Noon conservative, including preferred white/neutral backgrounds and no seller logo, price, promotion, or watermark.
- [ ] Surface rule summaries in the UI so generated prompts and audit labels use the selected platform, not stale Amazon labels.
- [ ] Add tests for Amazon, Temu, and Noon main image differences.

### Task 3: Image Planning V2

**Files:**
- Modify: `backend/src/prompts/imagePromptFactory.js`
- Modify: `backend/src/services/imagePlanService.js`
- Modify: `frontend/src/pages/ImagePlanPage.jsx`
- Test: `backend/tests/imagePlanService.test.js`
- Test: `frontend/tests/singleImageGeneration.test.js`

- [ ] Replace the fixed 8-plan set with 1 `main_image` plus 9 carousel plans.
- [ ] Generate SKU/variant image plans from confirmed colors, sizes, capacity, and model values.
- [ ] Add a variant explosion guard so large combinations require explicit confirmation before generation.
- [ ] Replan carousel themes by product category, with sofa/furniture themes such as room scene, dimensions, material, comfort, modular layout, color options, installation/package, lifestyle, and selling-point summary.
- [ ] Ensure prompts consume platform-specific rules and auxiliary evidence without copying source examples.
- [ ] Add tests proving sofa-like product info creates furniture-oriented carousel themes and variant counts are computed from confirmed fields.

### Task 4: Branch Delivery

**Files:**
- Git branches only.

- [ ] Commit and push `feature/product-recognition-v2`.
- [ ] Commit and push `feature/platform-rules-v2`.
- [ ] Commit and push `feature/image-planning-v2`.
- [ ] Leave `main` unchanged except for this plan unless the user approves merging.

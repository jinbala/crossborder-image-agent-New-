# Crossborder Image Agent MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable full-stack MVP for the cross-border ecommerce image workflow.

**Architecture:** React + Vite + Tailwind frontend calls a Node.js + Express backend. Backend stores task state in local JSON, generates mock recognition data, prompt-backed image plans, mock `sharp` images, compliance results, and a ZIP export.

**Tech Stack:** React, Vite, Tailwind CSS, Node.js, Express, Multer, Sharp, Archiver, node:test, Supertest.

---

### Task 1: Project Scaffolding

**Files:**
- Create: `backend/package.json`
- Create: `backend/src/app.js`
- Create: `backend/src/server.js`
- Create: `backend/data/db.json`
- Create: `frontend/package.json`
- Create: `frontend/index.html`
- Create: `frontend/vite.config.js`
- Create: `frontend/tailwind.config.js`
- Create: `frontend/postcss.config.js`

- [ ] Create the backend and frontend package manifests and base server/client entry points.
- [ ] Install dependencies with `npm.cmd install` in each package.

### Task 2: Backend Workflow API

**Files:**
- Create: `backend/tests/workflow.test.js`
- Create: `backend/src/routes/tasks.js`
- Create: `backend/src/services/db.js`
- Create: `backend/src/services/mockVisionService.js`
- Create: `backend/src/services/imagePlanService.js`
- Create: `backend/src/services/mockImageService.js`
- Create: `backend/src/services/complianceService.js`
- Create: `backend/src/services/exportService.js`
- Create: `backend/src/rules/platformRules.js`
- Create: `backend/src/prompts/imagePromptFactory.js`
- Create: `backend/src/utils/fileNaming.js`
- Create: `backend/src/utils/asyncHandler.js`

- [ ] Write a failing integration test that uploads a sample image and walks the complete workflow.
- [ ] Implement JSON persistence and all task routes.
- [ ] Implement mock recognition, platform rules, image plan prompts, mock image generation, compliance review, and ZIP export.
- [ ] Run `npm.cmd test` in `backend`.

### Task 3: Frontend Workflow

**Files:**
- Create: `frontend/src/main.jsx`
- Create: `frontend/src/App.jsx`
- Create: `frontend/src/index.css`
- Create: `frontend/src/services/api.js`
- Create: `frontend/src/components/Layout.jsx`
- Create: `frontend/src/components/StepNav.jsx`
- Create: `frontend/src/components/StatusBadge.jsx`
- Create: `frontend/src/components/Section.jsx`
- Create: `frontend/src/pages/Dashboard.jsx`
- Create: `frontend/src/pages/UploadPage.jsx`
- Create: `frontend/src/pages/ProductInfoPage.jsx`
- Create: `frontend/src/pages/PlatformRulesPage.jsx`
- Create: `frontend/src/pages/ImagePlanPage.jsx`
- Create: `frontend/src/pages/GeneratePage.jsx`
- Create: `frontend/src/pages/ReviewPage.jsx`
- Create: `frontend/src/pages/ExportPage.jsx`

- [ ] Build a compact operational UI for the eight requested pages.
- [ ] Wire every page to the backend API.
- [ ] Keep the workflow usable without real AI APIs.
- [ ] Run `npm.cmd run build` in `frontend`.

### Task 4: Verification and Run

**Files:**
- Modify as needed based on verification output.

- [ ] Run backend tests.
- [ ] Run frontend build.
- [ ] Start backend and frontend dev servers.
- [ ] Report local URLs and any limitations.

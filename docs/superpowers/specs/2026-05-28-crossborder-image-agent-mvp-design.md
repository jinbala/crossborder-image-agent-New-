# Crossborder Image Agent MVP Design

## Goal

Build a runnable MVP for a cross-border ecommerce product image generation workflow: upload one product image, mock product recognition, confirm product info, select Amazon/Temu/Noon, generate five English image plans, mock-generate images, run compliance review, and export a named image package.

## Architecture

The app is split into `frontend` and `backend`. The React frontend owns the workflow UI and calls the Express API. The backend owns file uploads, local JSON persistence, mock AI services, platform rules, prompt generation, image rendering with `sharp`, compliance review, and ZIP export.

## Data

Temporary persistence uses `backend/data/db.json`. A task stores upload metadata, recognized product fields, selected platform/language, five image plans, generated image records, compliance review results, and export metadata.

## Backend API

- `GET /api/tasks`: list dashboard tasks.
- `GET /api/tasks/:id`: fetch one task.
- `POST /api/tasks/upload`: upload one product image and create a task.
- `POST /api/tasks/:id/recognize`: fill mock product info.
- `PATCH /api/tasks/:id/product`: save user edits.
- `POST /api/tasks/:id/platforms`: save platform and language selection.
- `POST /api/tasks/:id/image-plans`: generate five prompt-backed image plans.
- `POST /api/tasks/:id/generate`: create mock images using `sharp`.
- `POST /api/tasks/:id/review`: run mock compliance checks.
- `GET /api/tasks/:id/export`: download ZIP package.

## Frontend Pages

The frontend contains the requested pages under `frontend/src/pages`: Dashboard, UploadPage, ProductInfoPage, PlatformRulesPage, ImagePlanPage, GeneratePage, ReviewPage, and ExportPage. Navigation follows the task ID through the workflow.

## MVP Constraints

Only a single uploaded product is supported per task. Supported platforms are Amazon, Temu, and Noon. English is the only active language. All AI-like behavior is mocked, but the file upload, persistence, image creation, review state, and export package are real.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rootDir = process.env.CROSSBORDER_DATA_ROOT
  ? path.resolve(process.env.CROSSBORDER_DATA_ROOT)
  : path.resolve(backendDir, '..');
const dataDir = path.join(rootDir, 'backend', 'data');
const dbPath = path.join(dataDir, 'db.json');
const uploadDir = path.join(rootDir, 'uploads');
const outputDir = path.join(rootDir, 'outputs');

export const paths = {
  rootDir,
  dataDir,
  dbPath,
  uploadDir,
  outputDir
};

export async function ensureBaseStoragePaths() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(uploadDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
}

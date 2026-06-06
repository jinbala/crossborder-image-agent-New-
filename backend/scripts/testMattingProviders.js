#!/usr/bin/env node
import '../src/config/env.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { extractSubjectWithFallback, getMattingProvider } from '../src/providers/matting/index.js';
import { paths } from '../src/services/db.js';

const scriptPath = fileURLToPath(import.meta.url);
const backendRoot = path.resolve(path.dirname(scriptPath), '..');
const projectRoot = path.resolve(backendRoot, '..');
const resultDir = path.join(backendRoot, 'test-results');
const mattingOutputDir = path.join(resultDir, 'matting');
const reportPath = path.join(projectRoot, 'docs', 'matting-provider-test-report.md');
const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function parseProviders(value) {
  return [...new Set(String(value || 'sharp').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

export function parseMattingArgs(argv = []) {
  const options = { providers: ['sharp'], image: null, dir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--provider') options.providers = parseProviders(argv[++index]);
    else if (arg === '--providers') options.providers = parseProviders(argv[++index]);
    else if (arg === '--image') options.image = argv[++index];
    else if (arg === '--dir') options.dir = argv[++index];
    else if (arg === '--help') options.help = true;
  }
  if (!options.help && !options.image && !options.dir) {
    throw new Error('--image or --dir is required');
  }
  return options;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/testMattingProviders.js --provider sharp --image test-assets/sku001/01-main.png',
    '  node scripts/testMattingProviders.js --providers sharp,external --image test-assets/sku001/01-main.png',
    '  node scripts/testMattingProviders.js --providers sharp,external --dir test-assets/sku001'
  ].join('\n');
}

async function collectImages(options) {
  if (options.image) return [path.resolve(backendRoot, options.image)];
  const absoluteDir = path.resolve(backendRoot, options.dir);
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(absoluteDir, entry.name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

async function copyOutput(result, provider, imagePath) {
  if (result.status !== 'success' || !result.output?.subjectPngPath) return result;
  await fs.mkdir(mattingOutputDir, { recursive: true });
  const stem = `${path.parse(imagePath).name}-${provider}-${Date.now()}`;
  const subjectTarget = path.join(mattingOutputDir, `${stem}.png`);
  await fs.copyFile(result.output.subjectPngPath, subjectTarget);
  let maskTarget = null;
  if (result.output.maskPath) {
    maskTarget = path.join(mattingOutputDir, `${stem}-mask.png`);
    await fs.copyFile(result.output.maskPath, maskTarget);
  }
  return {
    ...result,
    output: {
      ...result.output,
      subjectPngPath: path.relative(backendRoot, subjectTarget).replaceAll('\\', '/'),
      maskPath: maskTarget ? path.relative(backendRoot, maskTarget).replaceAll('\\', '/') : null
    }
  };
}

async function runProvider(providerName, imagePath) {
  const sourceImage = {
    id: path.parse(imagePath).name,
    imageIndex: 0,
    displayName: path.basename(imagePath),
    filePath: path.relative(paths.rootDir, imagePath).replaceAll('\\', '/'),
    role: 'main'
  };
  const task = { id: `matting-test-${Date.now()}` };
  const result = providerName === 'external'
    ? await extractSubjectWithFallback({ providerName, task, sourceImage, generationRequest: {} })
    : await getMattingProvider(providerName).extractSubject({ task, sourceImage, generationRequest: {} });
  return copyOutput(result, providerName, imagePath);
}

function summarize(results, providers) {
  return providers.map((provider) => {
    const items = results.flatMap((image) => image.providerResults).filter((item) => item.requestedProvider === provider);
    const success = items.filter((item) => item.status === 'success');
    return {
      provider,
      successCount: success.length,
      failedCount: items.length - success.length,
      averageDurationMs: success.length ? Math.round(success.reduce((sum, item) => sum + item.durationMs, 0) / success.length) : 0,
      averageConfidence: success.length ? Number((success.reduce((sum, item) => sum + (item.metadata?.confidence || 0), 0) / success.length).toFixed(2)) : 0,
      good: success.filter((item) => item.metadata?.edgeQuality === 'good').length,
      medium: success.filter((item) => item.metadata?.edgeQuality === 'medium').length,
      poor: success.filter((item) => item.metadata?.edgeQuality === 'poor').length
    };
  });
}

async function writeReport(run) {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  const lines = [
    '# Matting Provider Test Report',
    '',
    '## 测试概览',
    '',
    `- 测试时间：${run.createdAt}`,
    `- 测试图片数量：${run.totalImageCount}`,
    `- 测试 Provider：${run.providers.join(', ')}`,
    '',
    '## Provider 对比',
    '',
    '| Provider | 成功数 | 失败数 | 平均耗时 | 平均置信度 | good | medium | poor | 备注 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---|',
    ...run.summary.map((item) => `| ${item.provider} | ${item.successCount} | ${item.failedCount} | ${item.averageDurationMs}ms | ${item.averageConfidence} | ${item.good} | ${item.medium} | ${item.poor} | 需人工查看输出 PNG 边缘 |`),
    '',
    '## 图片结果',
    '',
    '| 图片 | Provider | 背景类型 | 边缘质量 | 置信度 | warnings | 输出文件 |',
    '|---|---|---|---|---:|---|---|',
    ...run.results.flatMap((image) => image.providerResults.map((item) => `| ${image.fileName} | ${item.provider} | ${item.metadata?.backgroundType || '-'} | ${item.metadata?.edgeQuality || '-'} | ${item.metadata?.confidence ?? 0} | ${(item.metadata?.warnings || []).join(', ') || '-'} | ${item.output?.subjectPngPath || '-'} |`)),
    '',
    '## 结论',
    '',
    '- 白底图推荐：sharp 可作为低成本默认方案，external 可用于精细边缘。',
    '- 复杂背景推荐：优先测试 external，sharp 仅作 fallback。',
    '- 手持图推荐：建议 external 或人工复核。',
    '- 是否建议启用 external：取决于真实样图对比结果，不建议在未验证前直接替换 sharp。'
  ];
  await fs.writeFile(reportPath, `${lines.join('\n')}\n`);
}

async function main() {
  try {
    const options = parseMattingArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    const images = await collectImages(options);
    if (!images.length) throw new Error('No supported images found');
    await fs.mkdir(resultDir, { recursive: true });
    const results = [];
    for (const imagePath of images) {
      const providerResults = [];
      for (const provider of options.providers) {
        const result = await runProvider(provider, imagePath).catch((error) => ({
          provider,
          status: 'failed',
          durationMs: 0,
          error: { code: error.code || 'MATTING_TEST_ERROR', message: error.message },
          output: null,
          metadata: { confidence: 0, edgeQuality: 'poor', backgroundType: 'unknown', warnings: ['script_error'] }
        }));
        providerResults.push({
          requestedProvider: provider,
          provider: result.provider,
          model: result.model,
          method: result.method,
          status: result.status,
          durationMs: result.durationMs,
          error: result.error,
          output: result.output,
          metadata: result.metadata
        });
        console.log(`${path.basename(imagePath)} / ${provider}: ${result.status} ${result.metadata?.edgeQuality || ''} ${result.output?.subjectPngPath || result.error?.code || ''}`);
      }
      const meta = await sharp(imagePath).metadata().catch(() => ({}));
      results.push({ fileName: path.basename(imagePath), filePath: imagePath, width: meta.width, height: meta.height, providerResults });
    }
    const run = {
      runId: `matting-test-${Date.now()}`,
      createdAt: new Date().toISOString(),
      providers: options.providers,
      totalImageCount: images.length,
      results,
      summary: summarize(results, options.providers)
    };
    const outputPath = path.join(resultDir, `${run.runId}.json`);
    await fs.writeFile(outputPath, JSON.stringify(run, null, 2));
    await writeReport(run);
    console.log(`Saved result JSON: ${path.relative(backendRoot, outputPath)}`);
    console.log(`Updated report: ${path.relative(backendRoot, reportPath)}`);
  } catch (error) {
    console.error(JSON.stringify({
      status: 'failed',
      error: { code: error.code || 'MATTING_TEST_ERROR', message: error.message }
    }, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main();
}

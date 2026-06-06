import fs from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { paths } from './dbPaths.js';

const DEFAULT_REPORT_DIR = path.join(paths.rootDir, 'backend', 'test-results', 'matting-reports');
const CHECK_FIELDS = [
  'edgeCleanliness',
  'interfaceIntegrity',
  'holeAndPortIntegrity',
  'texturePreserved',
  'productShapePreserved',
  'transparentBackground',
  'suitableForMainImage',
  'suitableForLifestyleComposite'
];

function sanitizeString(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/[A-Z]:\\[^"',\n\r\t]+/g, '[local-path-hidden]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[secret-hidden]')
    .replace(/backend[\\/]data[\\/]app\.sqlite/gi, '[sqlite-path-hidden]')
    .replace(/\.env(?:\.[A-Za-z0-9_-]+)?/g, '[env-hidden]')
    .replace(/node_modules[\\/][^"',\n\r\t]+/g, '[node-modules-hidden]');
}

function sanitizeValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/apiKey|api_key|secret|token|password|localPath|subjectPngPath|maskPath/i.test(key))
      .map(([key, item]) => [key, sanitizeValue(item)]));
  }
  return sanitizeString(value);
}

function safePath(value = '') {
  if (!value) return '';
  const normalized = sanitizeString(String(value).replaceAll('\\', '/'));
  const marker = '/backend/test-assets/';
  if (normalized.includes(marker)) return `backend/test-assets/${normalized.split(marker).pop()}`;
  if (normalized.startsWith('backend/test-assets/')) return normalized;
  if (normalized.startsWith('test-assets/')) return `backend/${normalized}`;
  if (normalized.startsWith('/outputs/')) return normalized;
  if (normalized.startsWith('outputs/')) return normalized;
  if (normalized.startsWith('[local-path-hidden]')) return '';
  return normalized.replace(/^\/+/, '');
}

function checklist() {
  return Object.fromEntries([
    ...CHECK_FIELDS.map((field) => [field, 'unchecked']),
    ['notes', '']
  ]);
}

function resultSummary(result = {}) {
  const qualityScore = result.qualityScore || {};
  const matted = result.mattedImage || result.previewImage || {};
  const previewFile = safePath(matted.previewUrl || '');
  return sanitizeValue({
    requestedProvider: result.requestedProvider || '',
    providerUsed: result.providerUsed || '',
    status: result.status || 'unknown',
    fallbackUsed: Boolean(result.fallbackUsed),
    fallbackReason: result.fallbackReason || '',
    outputType: result.outputType || '',
    durationMs: result.durationMs || 0,
    qualityScore,
    warnings: qualityScore.warnings || result.warnings || [],
    outputFile: safePath(matted.relativePath || previewFile),
    previewFile
  });
}

function recommendation({ image2Result, sharpResult }) {
  const image2Score = Number(image2Result?.qualityScore?.score || 0);
  const sharpScore = Number(sharpResult?.qualityScore?.score || 0);
  const image2OutputType = image2Result?.outputType || '';
  if (!image2Result || image2Result.status !== 'success' || image2Result.fallbackUsed) {
    return {
      recommendedProvider: 'sharp',
      recommendationReason: 'Image2 不可用、失败或发生 fallback，继续保持 sharp 默认。'
    };
  }
  if (image2OutputType === 'transparent' && image2Score > sharpScore + 10) {
    return {
      recommendedProvider: 'image2-experimental',
      recommendationReason: 'Image2 透明输出评分明显高于 sharp，但仍只建议保留为实验 provider。'
    };
  }
  if (image2OutputType === 'edited-background-removed' && image2Score >= 50) {
    return {
      recommendedProvider: 'keep-experimental',
      recommendationReason: 'Image2 为背景移除式编辑输出且评分中等，适合继续实验，不适合作为默认 provider。'
    };
  }
  if (image2OutputType !== 'transparent') {
    return {
      recommendedProvider: 'sharp',
      recommendationReason: 'Image2 输出不是标准透明背景，继续保持 sharp 默认。'
    };
  }
  return {
    recommendedProvider: 'sharp',
    recommendationReason: 'sharp 更稳定，默认建议继续使用 sharp。'
  };
}

export function buildMattingReport({
  summary = {},
  sample = {},
  reportId = `matting-report-image2-${Date.now()}-${nanoid(6)}`,
  generatedAt = new Date().toISOString()
} = {}) {
  const image2Result = summary.image2 || {};
  const sharpResult = summary.compare?.sharp || {};
  const rec = recommendation({ image2Result, sharpResult });
  const report = {
    meta: {
      reportId,
      generatedAt,
      providerUnderTest: 'image2',
      defaultProvider: 'sharp',
      testMode: 'single-image-smoke',
      inputImageName: sample.inputImageName || summary.image2?.originalImage?.displayName || '',
      inputImageSafePath: safePath(sample.inputImageSafePath || ''),
      imageSource: sample.imageSource || 'task-image',
      image2Available: Boolean(summary.image2Available),
      costNotice: summary.costNotice || ''
    },
    image2Result: resultSummary(image2Result),
    sharpResult: resultSummary(sharpResult),
    compareSummary: {
      image2Score: Number(image2Result?.qualityScore?.score || 0),
      sharpScore: Number(sharpResult?.qualityScore?.score || 0),
      image2Level: image2Result?.qualityScore?.level || '',
      sharpLevel: sharpResult?.qualityScore?.level || '',
      image2OutputType: image2Result?.outputType || '',
      sharpOutputType: sharpResult?.outputType || '',
      ...rec
    },
    manualChecklist: checklist(),
    conclusion: {
      keepSharpDefault: true,
      keepImage2Experimental: true,
      allowBatchImage2: false,
      allowFormalGenerationUse: false,
      nextSuggestedAction: '请人工打开 Image2 和 sharp 输出图，检查硬盘边缘、接口、孔位、纹理和主体轮廓。未完成人工验收前，不建议扩大 Image2 调用范围。'
    }
  };
  return sanitizeValue(report);
}

export async function writeMattingReport({ report, reportDir = DEFAULT_REPORT_DIR } = {}) {
  const safeReport = sanitizeValue(report || buildMattingReport());
  await fs.mkdir(reportDir, { recursive: true });
  const fileName = `${safeReport.meta?.reportId || `matting-report-image2-${Date.now()}`}.json`;
  const absolutePath = path.join(reportDir, fileName);
  await fs.writeFile(absolutePath, `${JSON.stringify(safeReport, null, 2)}\n`, 'utf8');
  return {
    absolutePath,
    relativePath: `backend/test-results/matting-reports/${fileName}`,
    report: safeReport
  };
}

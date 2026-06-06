import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildMattingReport,
  writeMattingReport
} from '../src/services/mattingReportService.js';

function result(provider, score, outputType = 'transparent', fallbackUsed = false) {
  return {
    status: 'success',
    requestedProvider: provider,
    providerUsed: provider,
    outputType,
    fallbackUsed,
    fallbackReason: fallbackUsed ? 'fallback to sharp' : '',
    durationMs: provider === 'image2' ? 61000 : 120,
    qualityScore: {
      score,
      level: score >= 80 ? 'good' : 'medium',
      warnings: provider === 'image2' ? ['edge check'] : []
    },
    warnings: provider === 'image2' ? ['edge check'] : [],
    mattedImage: {
      previewUrl: `/outputs/task/${provider}.png`,
      relativePath: `outputs/task/${provider}.png`,
      localPath: `D:\\secret\\${provider}.png`
    },
    apiKey: 'sk-secret'
  };
}

test('matting report includes required sections and keeps manual checklist unchecked', () => {
  const report = buildMattingReport({
    summary: {
      image2Available: true,
      costNotice: 'Image2 may cost API credits',
      image2: result('image2', 65, 'edited-background-removed'),
      compare: {
        sharp: result('sharp', 65, 'transparent'),
        image2: result('image2', 65, 'edited-background-removed')
      }
    },
    sample: {
      inputImageName: '主图.png',
      inputImageSafePath: 'backend/test-assets/sku001-hard-drive/主图.png',
      imageSource: 'test-assets'
    }
  });

  assert.equal(report.meta.providerUnderTest, 'image2');
  assert.equal(report.meta.defaultProvider, 'sharp');
  assert.equal(report.meta.testMode, 'single-image-smoke');
  assert.equal(report.image2Result.outputType, 'edited-background-removed');
  assert.equal(report.sharpResult.outputType, 'transparent');
  assert.equal(report.compareSummary.image2Score, 65);
  assert.equal(report.compareSummary.sharpScore, 65);
  assert.equal(report.compareSummary.recommendedProvider, 'keep-experimental');
  assert.equal(report.manualChecklist.edgeCleanliness, 'unchecked');
  assert.equal(report.manualChecklist.interfaceIntegrity, 'unchecked');
  assert.equal(report.conclusion.keepSharpDefault, true);
  assert.equal(report.conclusion.keepImage2Experimental, true);
  assert.equal(report.conclusion.allowBatchImage2, false);
  assert.equal(report.conclusion.allowFormalGenerationUse, false);
});

test('matting report sanitizes secrets absolute paths env content and sqlite paths', () => {
  const report = buildMattingReport({
    summary: {
      image2Available: true,
      costNotice: 'Image2 may cost API credits',
      image2: {
        ...result('image2', 82, 'transparent'),
        fallbackReason: 'failed near D:\\project\\.env with sk-secret and backend/data/app.sqlite'
      },
      compare: {
        sharp: result('sharp', 60, 'transparent'),
        image2: result('image2', 82, 'transparent')
      }
    },
    sample: {
      inputImageName: '主图.png',
      inputImageSafePath: 'D:\\project\\backend\\test-assets\\sku001-hard-drive\\主图.png',
      imageSource: 'test-assets'
    }
  });
  const text = JSON.stringify(report);

  assert.doesNotMatch(text, /sk-secret|D:\\project|C:\\|backend\/data\/app\.sqlite|\.env/);
  assert.match(text, /backend\/test-assets\/sku001-hard-drive\/主图\.png/);
  assert.equal(report.compareSummary.recommendedProvider, 'image2-experimental');
});

test('writeMattingReport writes JSON artifact under a caller provided runtime directory', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cia-matting-report-'));
  try {
    const result = await writeMattingReport({
      reportDir: dir,
      report: buildMattingReport({
        summary: {
          image2Available: false,
          costNotice: 'Image2 is not configured',
          image2: { status: 'unavailable', qualityScore: { score: 0, level: 'poor', warnings: [] } },
          compare: null
        },
        sample: {
          inputImageName: '',
          inputImageSafePath: '',
          imageSource: 'task-image'
        }
      })
    });
    const saved = JSON.parse(await readFile(result.absolutePath, 'utf8'));

    assert.match(result.relativePath, /^backend\/test-results\/matting-reports\/matting-report-image2-/);
    assert.equal(saved.meta.providerUnderTest, 'image2');
    assert.equal(saved.image2Result.status, 'unavailable');
    assert.equal(saved.manualChecklist.texturePreserved, 'unchecked');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

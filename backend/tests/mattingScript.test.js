import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMattingArgs } from '../scripts/testMattingProviders.js';
import {
  buildImage2SmokeSummary,
  image2SmokeConfigSummary,
  parseImage2SmokeArgs,
  runImage2MattingSmoke,
  sanitizeImage2SmokeReport
} from '../scripts/runImage2MattingSmokeTest.js';

test('testMattingProviders script validates missing image or directory path', () => {
  assert.throws(
    () => parseMattingArgs(['--provider', 'sharp']),
    /--image or --dir is required/
  );
});

test('testMattingProviders script parses provider and image arguments', () => {
  const args = parseMattingArgs(['--providers', 'sharp,external', '--image', 'test-assets/sku001/01-main.png']);

  assert.deepEqual(args.providers, ['sharp', 'external']);
  assert.equal(args.image, 'test-assets/sku001/01-main.png');
});

test('Image2 smoke script defaults to one explicit sample and compare mode', () => {
  const args = parseImage2SmokeArgs(['--task-id', 'task-1', '--image-id', 'image-1']);

  assert.equal(args.taskId, 'task-1');
  assert.equal(args.imageId, 'image-1');
  assert.equal(args.compare, true);
  assert.equal(args.limit, 1);
});

test('Image2 smoke script supports documented provider and input aliases', () => {
  const args = parseImage2SmokeArgs([
    '--provider=image2',
    '--input=backend/test-assets/sku001-hard-drive/主图.png',
    '--no-compare',
    '--write-report'
  ]);

  assert.equal(args.provider, 'image2');
  assert.equal(args.image, 'test-assets/sku001-hard-drive/主图.png');
  assert.equal(args.compare, false);
  assert.equal(args.writeReport, true);
  assert.equal(args.limit, 1);
});

test('Image2 smoke script accepts one allowlisted test asset image without database writes', async () => {
  let capturedInput = null;
  let capturedDeps = null;
  const report = await runImage2MattingSmoke({
    image: 'test-assets/sku001-hard-drive/主图.png',
    compare: false
  }, {
    getConfig: () => ({ image2Available: true }),
    runMatting: async (input, runDeps) => {
      capturedInput = input;
      capturedDeps = runDeps;
      return {
        requestedProvider: 'image2',
        providerUsed: 'image2',
        outputType: 'edited-background-removed',
        fallbackUsed: false,
        fallbackReason: '',
        qualityScore: { score: 70, warnings: [] }
      };
    }
  });

  const task = await capturedDeps.taskReader(capturedInput.taskId);
  assert.equal(capturedInput.provider, 'image2');
  assert.match(capturedInput.taskId, /^image2-smoke-/);
  assert.equal(task.sourceImages.length, 1);
  assert.match(task.sourceImages[0].filePath, /backend\/test-assets\/sku001-hard-drive\/主图\.png/);
  assert.equal(report.status, 'completed');
  assert.equal(report.costNotice.includes('API 成本'), true);
  assert.equal(report.limit, 1);
});

test('Image2 smoke compare mode calls Image2 only once and reuses that result', async () => {
  const providers = [];
  const report = await runImage2MattingSmoke({
    image: 'test-assets/sku001-hard-drive/主图.png',
    compare: true
  }, {
    getConfig: () => ({ image2Available: true }),
    runMatting: async (input) => {
      providers.push(input.provider);
      return {
        status: 'success',
        requestedProvider: input.provider,
        providerUsed: input.provider,
        outputType: input.provider === 'image2' ? 'edited-background-removed' : 'transparent',
        fallbackUsed: false,
        fallbackReason: '',
        qualityScore: { score: input.provider === 'image2' ? 72 : 68, warnings: [] }
      };
    },
    compareMatting: async () => {
      throw new Error('smoke script must not call compareMatting because it would call Image2 twice');
    }
  });

  assert.deepEqual(providers, ['image2', 'sharp']);
  assert.equal(report.compare.image2.providerUsed, 'image2');
  assert.equal(report.compare.sharp.providerUsed, 'sharp');
  assert.equal(report.compareSucceeded, true);
});

test('Image2 smoke write-report creates a sanitized report artifact', async () => {
  let writeInput = null;
  const report = await runImage2MattingSmoke({
    image: 'test-assets/sku001-hard-drive/主图.png',
    compare: true,
    writeReport: true
  }, {
    getConfig: () => ({ image2Available: true }),
    runMatting: async (input) => ({
      status: 'success',
      requestedProvider: input.provider,
      providerUsed: input.provider,
      outputType: input.provider === 'image2' ? 'edited-background-removed' : 'transparent',
      fallbackUsed: false,
      fallbackReason: '',
      qualityScore: { score: input.provider === 'image2' ? 65 : 65, level: 'medium', warnings: [] },
      mattedImage: {
        previewUrl: `/outputs/task/${input.provider}.png`,
        localPath: `D:\\secret\\${input.provider}.png`
      },
      apiKey: 'sk-secret'
    }),
    writeMattingReport: async (input) => {
      writeInput = input;
      return {
        relativePath: 'backend/test-results/matting-reports/matting-report-image2-test.json',
        report: input.report
      };
    }
  });
  const text = JSON.stringify({ report, writeInput });

  assert.equal(report.reportFile, 'backend/test-results/matting-reports/matting-report-image2-test.json');
  assert.equal(writeInput.report.meta.providerUnderTest, 'image2');
  assert.equal(writeInput.report.compareSummary.recommendedProvider, 'keep-experimental');
  assert.equal(writeInput.report.manualChecklist.edgeCleanliness, 'unchecked');
  assert.doesNotMatch(text, /sk-secret|D:\\secret|apiKey|localPath/);
});

test('Image2 smoke report keeps required run and compare fields while sanitizing secrets and local paths', () => {
  const report = buildImage2SmokeSummary({
    status: 'completed',
    image2Available: true,
    input: { taskId: 'task-1', imageId: 'image-1' },
    runResult: {
      requestedProvider: 'image2',
      providerUsed: 'image2',
      outputType: 'edited-background-removed',
      fallbackUsed: false,
      fallbackReason: '',
      qualityScore: { score: 78, level: 'medium', warnings: ['edge_check'] },
      mattedImage: {
        previewUrl: '/outputs/task-1/matting-test/result.png',
        localPath: 'D:\\secret\\result.png'
      },
      apiKey: 'sk-secret'
    },
    compareResult: {
      sharp: {
        status: 'success',
        providerUsed: 'sharp',
        outputType: 'transparent',
        qualityScore: { score: 82, warnings: [] }
      },
      image2: {
        status: 'success',
        providerUsed: 'image2',
        outputType: 'edited-background-removed',
        qualityScore: { score: 78, warnings: ['edge_check'] }
      }
    }
  });
  const text = JSON.stringify(report);

  assert.equal(report.status, 'completed');
  assert.equal(report.image2.requestedProvider, 'image2');
  assert.equal(report.image2.providerUsed, 'image2');
  assert.equal(report.image2.outputType, 'edited-background-removed');
  assert.equal(report.image2.fallbackUsed, false);
  assert.deepEqual(report.image2.warnings, ['edge_check']);
  assert.equal(report.compare.sharp.providerUsed, 'sharp');
  assert.equal(report.compare.image2.providerUsed, 'image2');
  assert.doesNotMatch(text, /sk-secret|D:\\secret|localPath|apiKey/);
});

test('Image2 smoke script marks unavailable config without calling real Image2', async () => {
  let runCalls = 0;
  const report = await runImage2MattingSmoke({
    taskId: 'task-1',
    imageId: 'image-1',
    compare: true
  }, {
    getConfig: () => ({ image2Available: false }),
    runMatting: async () => {
      runCalls += 1;
      return {
        requestedProvider: 'image2',
        providerUsed: 'sharp',
        outputType: 'transparent',
        fallbackUsed: true,
        fallbackReason: 'Image2 未配置，已 fallback 到 sharp 本地抠图。',
        qualityScore: { score: 70, warnings: [] }
      };
    },
    compareMatting: async () => ({
      sharp: { status: 'success', providerUsed: 'sharp', qualityScore: { score: 70, warnings: [] } },
      image2: { status: 'unavailable', message: 'Image2 未配置，当前仅可使用 sharp 本地抠图。' }
    })
  });

  assert.equal(runCalls, 0);
  assert.equal(report.status, 'skipped');
  assert.equal(report.image2Available, false);
  assert.equal(report.image2.status, 'unavailable');
  assert.match(report.reason, /Image2 未配置/);
  assert.deepEqual(report.requiredEnvNames, ['OPENAI_API_KEY']);
});

test('Image2 smoke config summary lists variable names without leaking values', () => {
  const summary = image2SmokeConfigSummary({
    OPENAI_API_KEY: 'sk-secret',
    OPENAI_IMAGE_EDIT_MODEL: 'gpt-image-2',
    OPENAI_BASE_URL: 'https://example.test/v1'
  });
  const text = JSON.stringify(summary);

  assert.equal(summary.image2Available, true);
  assert.deepEqual(summary.recognizedEnvNames, [
    'OPENAI_API_KEY',
    'OPENAI_IMAGE_EDIT_MODEL',
    'OPENAI_IMAGE_MODEL',
    'IMAGE_MODEL',
    'OPENAI_BASE_URL'
  ]);
  assert.equal(summary.availabilityRule, 'Boolean(OPENAI_API_KEY)');
  assert.doesNotMatch(text, /sk-secret|https:\/\/example\.test/);
});

test('Image2 smoke sanitizer removes provider secrets and filesystem paths recursively', () => {
  const report = sanitizeImage2SmokeReport({
    result: {
      message: 'failed near D:\\project\\secret.png with sk-secret-token',
      nested: {
        filePath: 'C:\\hidden\\input.png',
        previewUrl: '/outputs/task/matting.png',
        token: 'secret'
      }
    }
  });
  const text = JSON.stringify(report);

  assert.doesNotMatch(text, /sk-secret-token|C:\\hidden|D:\\project|filePath|token/);
  assert.match(text, /\/outputs\/task\/matting\.png/);
});

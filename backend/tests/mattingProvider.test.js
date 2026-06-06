import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { getMattingProvider } from '../src/providers/matting/index.js';
import { extractSubjectWithFallback } from '../src/providers/matting/index.js';
import { SharpMattingProvider } from '../src/providers/matting/sharpMattingProvider.js';
import { ExternalMattingProvider } from '../src/providers/matting/externalMattingProvider.js';
import { paths } from '../src/services/db.js';

const tempDir = path.join(os.tmpdir(), `crossborder-matting-provider-${process.pid}`);
let plainPath;
let complexPath;

function sourceImage(filePath, displayName = '01-main.png') {
  return {
    id: 'source-main',
    imageIndex: 0,
    displayName,
    filePath: path.relative(paths.rootDir, filePath).replaceAll('\\', '/'),
    previewUrl: '/uploads/01-main.png',
    role: 'main'
  };
}

before(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.mkdir(tempDir, { recursive: true });
  plainPath = path.join(tempDir, 'plain-product.png');
  complexPath = path.join(tempDir, 'complex-product.png');

  await sharp({
    create: { width: 600, height: 600, channels: 4, background: '#ffffff' }
  })
    .composite([
      {
        input: Buffer.from('<svg width="600" height="600" xmlns="http://www.w3.org/2000/svg"><rect x="190" y="160" width="220" height="280" rx="30" fill="#111827"/></svg>')
      }
    ])
    .png()
    .toFile(plainPath);

  await sharp({
    create: { width: 600, height: 600, channels: 4, background: '#7493aa' }
  })
    .composite([
      {
        input: Buffer.from('<svg width="600" height="600" xmlns="http://www.w3.org/2000/svg"><rect width="600" height="600" fill="#789"/><circle cx="120" cy="130" r="90" fill="#a66"/><circle cx="470" cy="430" r="120" fill="#6a8"/><rect x="190" y="160" width="220" height="280" rx="30" fill="#111827"/></svg>')
      }
    ])
    .png()
    .toFile(complexPath);
});

after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('sharpMattingProvider extracts subject with high confidence on plain light backgrounds', async () => {
  const provider = new SharpMattingProvider();
  const result = await provider.extractSubject({
    task: { id: 'matting-plain' },
    sourceImage: sourceImage(plainPath),
    generationRequest: {}
  });

  assert.equal(result.status, 'success');
  assert.equal(result.provider, 'sharp');
  assert.equal(result.method, 'sharp_light_background_alpha_mask');
  assert.ok(result.output.subjectPngPath);
  assert.equal(result.output.hasAlpha, true);
  assert.ok(result.metadata.confidence >= 0.6);
  assert.match(result.metadata.backgroundType, /plain|light/);
});

test('sharpMattingProvider warns on complex backgrounds', async () => {
  const provider = new SharpMattingProvider();
  const result = await provider.extractSubject({
    task: { id: 'matting-complex' },
    sourceImage: sourceImage(complexPath, 'desk-photo.png'),
    generationRequest: {}
  });

  assert.equal(result.status, 'success');
  assert.ok(result.metadata.warnings.includes('complex_background_detected'));
  assert.ok(result.metadata.warnings.includes('manual_review_recommended'));
  assert.equal(result.metadata.backgroundType, 'complex');
});

test('matting provider selector defaults to sharp and external reports missing config', async () => {
  assert.equal(getMattingProvider('sharp').provider, 'sharp');
  const external = new ExternalMattingProvider({ apiKey: '', baseURL: '' });
  const result = await external.extractSubject({
    task: { id: 'external-matting' },
    sourceImage: sourceImage(plainPath),
    generationRequest: {}
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'MISSING_MATTING_CONFIG');
});

test('external matting provider saves base64 subject and mask responses', async () => {
  const subject = await sharp({
    create: { width: 80, height: 60, channels: 4, background: '#00000000' }
  }).png().toBuffer();
  const mask = await sharp({
    create: { width: 80, height: 60, channels: 3, background: '#ffffff' }
  }).png().toBuffer();
  const provider = new ExternalMattingProvider({
    apiKey: 'test-key',
    baseURL: 'https://matting.example/api',
    fetchImpl: async () => new Response(JSON.stringify({
      subjectPngBase64: subject.toString('base64'),
      maskBase64: mask.toString('base64'),
      confidence: 0.88,
      edgeQuality: 'good',
      backgroundType: 'plain',
      warnings: []
    }), { headers: { 'content-type': 'application/json' } })
  });

  const result = await provider.extractSubject({
    task: { id: 'external-base64' },
    sourceImage: sourceImage(plainPath),
    generationRequest: {}
  });

  assert.equal(result.status, 'success');
  assert.equal(result.provider, 'external');
  assert.ok(result.output.subjectPngPath.endsWith('.png'));
  assert.ok(result.output.maskPath.endsWith('.png'));
  assert.equal(result.metadata.confidence, 0.88);
  assert.match(result.metadata.providerResponsePreview, /subjectPngBase64/);
});

test('external matting provider saves URL and binary png responses', async () => {
  const subject = await sharp({
    create: { width: 70, height: 70, channels: 4, background: '#00000000' }
  }).png().toBuffer();
  const urlProvider = new ExternalMattingProvider({
    apiKey: 'test-key',
    baseURL: 'https://matting.example/api',
    fetchImpl: async (url) => {
      if (String(url).includes('subject.png')) return new Response(subject, { headers: { 'content-type': 'image/png' } });
      return new Response(JSON.stringify({ subjectPngUrl: 'https://cdn.example/subject.png', confidence: 0.72 }));
    }
  });
  const binaryProvider = new ExternalMattingProvider({
    apiKey: 'test-key',
    baseURL: 'https://matting.example/api',
    fetchImpl: async () => new Response(subject, { headers: { 'content-type': 'image/png' } })
  });

  const urlResult = await urlProvider.extractSubject({ task: { id: 'external-url' }, sourceImage: sourceImage(plainPath), generationRequest: {} });
  const binaryResult = await binaryProvider.extractSubject({ task: { id: 'external-binary' }, sourceImage: sourceImage(plainPath), generationRequest: {} });

  assert.equal(urlResult.status, 'success');
  assert.equal(binaryResult.status, 'success');
  assert.equal(binaryResult.metadata.warnings[0], 'binary_response_no_mask');
});

test('external matting failure can fall back to sharp with metadata', async () => {
  const result = await extractSubjectWithFallback({
    providerName: 'external',
    task: { id: 'external-fallback' },
    sourceImage: sourceImage(plainPath),
    generationRequest: {},
    providerOptions: {
      external: {
        apiKey: 'test-key',
        baseURL: 'https://matting.example/api',
        fetchImpl: async () => new Response(JSON.stringify({ error: 'bad response' }), { status: 500 })
      }
    }
  });

  assert.equal(result.status, 'success');
  assert.equal(result.provider, 'sharp');
  assert.equal(result.metadata.mattingFallbackToSharp, true);
  assert.equal(result.metadata.externalMattingError.code, 'HTTP_ERROR');
});

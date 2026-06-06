import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { parseJsonFromModelOutput } from '../src/providers/vision/robustJsonParser.js';
import { normalizeVisionResult } from '../src/providers/vision/normalizeVisionResult.js';
import { buildVisionPrompt } from '../src/providers/vision/visionPrompt.js';
import { getVisionProvider } from '../src/providers/vision/index.js';
import { parseVisionDebugArgs, validateImageArgument } from '../scripts/testVisionRecognition.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

test('robust parser reads strict JSON', () => {
  const parsed = parseJsonFromModelOutput('{"productInfoRaw":{"productName":"Bottle"}}');
  assert.equal(parsed.productInfoRaw.productName, 'Bottle');
});

test('robust parser reads JSON code block', () => {
  const parsed = parseJsonFromModelOutput('```json\n{"visibleText":[]}\n```');
  assert.deepEqual(parsed.visibleText, []);
});

test('robust parser extracts first JSON object from surrounding text', () => {
  const parsed = parseJsonFromModelOutput('Here is the result: {"notes":["ok"]} Thank you.');
  assert.deepEqual(parsed.notes, ['ok']);
});

test('robust parser extracts first object when response contains multiple objects', () => {
  const parsed = parseJsonFromModelOutput('first {"notes":["one"]} second {"notes":["two"]}');
  assert.deepEqual(parsed.notes, ['one']);
});

test('robust parser handles realistic fenced output with explanatory lead-in', () => {
  const parsed = parseJsonFromModelOutput('Result below:\n```json\n{"productInfoRaw":{"productName":"Bottle"},"visibleText":[{"text":"24 OZ"}]}\n```');
  assert.equal(parsed.productInfoRaw.productName, 'Bottle');
  assert.equal(parsed.visibleText[0].text, '24 OZ');
});

test('robust parser throws structured error for invalid JSON', () => {
  assert.throws(
    () => parseJsonFromModelOutput('not json at all'),
    (error) => error.code === 'PARSE_ERROR' && error.details.reason === 'INVALID_JSON'
  );
});

test('normalize vision result fills defaults and clamps confidence', () => {
  const normalized = normalizeVisionResult({
    productInfoRaw: {
      productName: 'Travel Bottle',
      colors: 'blue'
    },
    visibleText: ['SALE', { text: '24 OZ', confidence: 1.5 }],
    risks: ['watermark'],
    confidence: {
      productName: 2,
      material: -1
    },
    extraField: 'ignored'
  });

  assert.equal(normalized.productInfoRaw.productName, 'Travel Bottle');
  assert.deepEqual(normalized.productInfoRaw.colors, []);
  assert.equal(normalized.productInfoRaw.material, null);
  assert.equal(normalized.visibleText[0].text, 'SALE');
  assert.equal(normalized.visibleText[1].confidence, 1);
  assert.equal(normalized.risks[0].type, 'watermark');
  assert.equal(normalized.confidence.productName, 1);
  assert.equal(normalized.confidence.material, 0);
  assert.equal(normalized.extraField, undefined);
});

test('normalize vision result handles realistic object arrays from model output', () => {
  const normalized = normalizeVisionResult({
    productInfoRaw: {
      productName: 'Kitchen Scale',
      visibleSpecs: [{ text: '5kg max' }, { value: 'USB-C charging' }],
      packageIncluded: [{ name: 'scale' }, { name: 'charging cable' }],
      sellingPoints: [{ text: 'High precision' }]
    },
    visibleText: [{ text: '高精度', language: 'Chinese', confidence: 0.82 }],
    risks: [{ type: 'chinese_text', level: 'medium', message: 'Chinese text detected', evidence: [{ text: '高精度' }] }],
    confidence: { productName: 0.91, visibleText: 0.82 }
  });

  assert.deepEqual(normalized.productInfoRaw.visibleSpecs, ['5kg max', 'USB-C charging']);
  assert.deepEqual(normalized.productInfoRaw.packageIncluded, ['scale', 'charging cable']);
  assert.deepEqual(normalized.productInfoRaw.sellingPoints, ['High precision']);
  assert.deepEqual(normalized.risks[0].evidence, ['高精度']);
});

test('normalize vision result preserves ecommerce electronics fields and image metadata', () => {
  const normalized = normalizeVisionResult({
    productInfoRaw: {
      productName: 'Portable SSD',
      category: 'External Hard Drive',
      interfaceType: 'USB 3.2 Type-C',
      compatibleDevices: ['Laptop', 'Desktop', 'Android phone'],
      dimensions: ['4.2 x 1.3 x 0.5 in'],
      certifications: ['CE'],
      warranty: '3 years',
      weight: '52g',
      visibleSpecs: ['1TB', 'USB-C']
    },
    visibleText: [{ imageIndex: 1, imageName: '尺寸图.png', text: 'USB 3.2', language: 'English', confidence: 0.9 }],
    fieldEvidence: {
      certifications: [{ source: 'visible_text', imageIndex: 2, imageName: 'cert.png', text: 'CE', value: 'CE', confidence: 0.8 }],
      warranty: [{ source: 'visible_text', imageIndex: 3, imageName: 'warranty.png', text: '3 years warranty', value: '3 years', confidence: 0.8 }]
    },
    risks: [{ type: 'certification_mark', level: 'medium', message: 'CE mark visible', imageIndex: 2, evidence: ['CE'] }],
    confidence: { productName: 0.9, visibleText: 0.9 },
    notes: Array.from({ length: 20 }, (_, index) => `note ${index}`)
  });

  assert.equal(normalized.productInfoRaw.interfaceType, 'USB 3.2 Type-C');
  assert.deepEqual(normalized.productInfoRaw.compatibleDevices, ['Laptop', 'Desktop', 'Android phone']);
  assert.deepEqual(normalized.productInfoRaw.dimensions, ['4.2 x 1.3 x 0.5 in']);
  assert.deepEqual(normalized.productInfoRaw.certifications, ['CE']);
  assert.equal(normalized.productInfoRaw.warranty, '3 years');
  assert.equal(normalized.productInfoRaw.weight, '52g');
  assert.equal(normalized.visibleText[0].imageIndex, 1);
  assert.equal(normalized.visibleText[0].imageName, '尺寸图.png');
  assert.equal(normalized.risks[0].imageIndex, 2);
  assert.equal(normalized.notes.length, 10);
});

test('normalize vision result preserves fieldEvidence and removes high-risk capacity without visible text evidence', () => {
  const normalized = normalizeVisionResult({
    productInfoRaw: {
      productName: 'Portable External Hard Drive',
      capacity: ['500GB', '1TB', '2TB'],
      interfaceType: 'Type-C',
      certifications: ['CE'],
      warranty: '3 years'
    },
    fieldEvidence: {
      interfaceType: [{ source: 'visible_text', imageIndex: 1, imageName: 'detail.png', text: 'Type-C Connection', value: 'Type-C', confidence: 0.92 }],
      capacity: [{ source: 'inferred', imageIndex: null, imageName: '', text: 'Common market capacity', value: '1TB', confidence: 0.3 }],
      certifications: [{ source: 'inferred', text: 'Common electronics mark', value: 'CE', confidence: 0.2 }]
    },
    visibleText: [{ imageIndex: 1, imageName: 'detail.png', text: 'Type-C Connection', confidence: 0.9 }],
    risks: [],
    confidence: { interfaceType: 0.9, capacity: 0.3 }
  });

  assert.deepEqual(normalized.productInfoRaw.capacity, []);
  assert.deepEqual(normalized.productInfoRaw.certifications, []);
  assert.equal(normalized.productInfoRaw.warranty, null);
  assert.equal(normalized.productInfoRaw.interfaceType, 'Type-C');
  assert.equal(normalized.fieldEvidence.interfaceType[0].source, 'visible_text');
  assert.equal(normalized.inferredCandidates.some((item) => item.field === 'capacity' && item.value === '500GB'), true);
  assert.equal(normalized.inferredCandidates.some((item) => item.field === 'certifications' && item.value === 'CE'), true);
  assert.match(normalized.notes.join(' '), /capacity.*requires visible text evidence/);
});

test('normalize vision result keeps capacity when visible text evidence supports it', () => {
  const normalized = normalizeVisionResult({
    productInfoRaw: {
      productName: 'Portable SSD',
      capacity: ['1TB']
    },
    fieldEvidence: {
      capacity: [{ source: 'visible_text', imageIndex: 0, imageName: 'main.png', text: '1TB Portable SSD', value: '1TB', confidence: 0.95 }]
    },
    visibleText: [{ imageIndex: 0, imageName: 'main.png', text: '1TB Portable SSD', confidence: 0.95 }],
    risks: [],
    confidence: { capacity: 0.95 }
  });

  assert.deepEqual(normalized.productInfoRaw.capacity, ['1TB']);
  assert.equal(normalized.inferredCandidates.length, 0);
});

test('normalize vision result demotes accent colors from confirmed product colors', () => {
  const normalized = normalizeVisionResult({
    productInfoRaw: {
      productName: 'Portable 4TB SSD',
      colors: ['Black', 'Orange', 'Orange/Red']
    },
    fieldEvidence: {
      colors: [
        { source: 'visual', imageIndex: 0, imageName: 'main.png', value: 'Black', reason: 'main product body color', confidence: 0.95 },
        { source: 'visual', imageIndex: 0, imageName: 'main.png', value: 'Orange', reason: 'accent ring around port and title text color', confidence: 0.8 },
        { source: 'visual', imageIndex: 1, imageName: 'spec.png', value: 'Orange/Red', reason: 'small trim accent, not full product variant', confidence: 0.7 }
      ]
    },
    visibleText: [
      { imageIndex: 0, imageName: 'main.png', text: 'PORTABLE 4TB SSD', confidence: 0.9 }
    ],
    risks: [],
    confidence: { colors: 0.8 }
  });

  assert.deepEqual(normalized.productInfoRaw.colors, ['Black']);
  assert.equal(normalized.inferredCandidates.some((item) => item.field === 'colors' && item.value === 'Orange'), true);
  assert.equal(normalized.inferredCandidates.some((item) => item.field === 'colors' && item.value === 'Orange/Red'), true);
  assert.match(normalized.notes.join(' '), /accent color/i);
});

test('vision prompt tells provider to separate product body colors from accents and text colors', () => {
  const prompt = buildVisionPrompt({
    task: {
      id: 'task-color',
      sourceImages: [{ displayName: 'main.png' }]
    },
    image: { displayName: 'main.png' }
  });

  assert.match(prompt, /product body colors/i);
  assert.match(prompt, /accent/i);
  assert.match(prompt, /Do not treat text color/i);
});

test('normalize vision result limits visibleText per image and records truncation note', () => {
  const previousPerImage = process.env.VISION_VISIBLE_TEXT_LIMIT_PER_IMAGE;
  const previousTotal = process.env.VISION_VISIBLE_TEXT_TOTAL_LIMIT;
  process.env.VISION_VISIBLE_TEXT_LIMIT_PER_IMAGE = '3';
  process.env.VISION_VISIBLE_TEXT_TOTAL_LIMIT = '80';

  const normalized = normalizeVisionResult({
    productInfoRaw: { productName: 'Portable SSD' },
    visibleText: Array.from({ length: 8 }, (_, index) => ({
      imageIndex: 0,
      imageName: '01-main.png',
      text: index === 6 ? '1TB USB-C compatible with PC and Mac' : `Decorative footer ${index}`,
      confidence: 0.6
    })),
    risks: [],
    confidence: {}
  });

  assert.equal(normalized.visibleText.length, 3);
  assert.equal(normalized.visibleText.some((item) => item.text.includes('1TB USB-C')), true);
  assert.match(normalized.notes.join(' '), /visibleText truncated: original 8, kept 3/);
  assert.equal(normalized.ocrSummary.visibleTextOriginalCount, 8);
  assert.equal(normalized.ocrSummary.visibleTextKeptCount, 3);
  assert.equal(normalized.ocrSummary.visibleTextTruncated, true);

  if (previousPerImage == null) delete process.env.VISION_VISIBLE_TEXT_LIMIT_PER_IMAGE;
  else process.env.VISION_VISIBLE_TEXT_LIMIT_PER_IMAGE = previousPerImage;
  if (previousTotal == null) delete process.env.VISION_VISIBLE_TEXT_TOTAL_LIMIT;
  else process.env.VISION_VISIBLE_TEXT_TOTAL_LIMIT = previousTotal;
});

test('normalize vision result limits visibleText total count after per-image filtering', () => {
  const previousPerImage = process.env.VISION_VISIBLE_TEXT_LIMIT_PER_IMAGE;
  const previousTotal = process.env.VISION_VISIBLE_TEXT_TOTAL_LIMIT;
  process.env.VISION_VISIBLE_TEXT_LIMIT_PER_IMAGE = '10';
  process.env.VISION_VISIBLE_TEXT_TOTAL_LIMIT = '5';

  const normalized = normalizeVisionResult({
    productInfoRaw: { productName: 'Portable SSD' },
    visibleText: Array.from({ length: 12 }, (_, index) => ({
      imageIndex: Math.floor(index / 4),
      text: index === 10 ? 'Package includes hard drive and USB cable' : `OCR text ${index}`,
      confidence: 0.5
    })),
    risks: [],
    confidence: {}
  });

  assert.equal(normalized.visibleText.length, 5);
  assert.equal(normalized.visibleText.some((item) => item.text.includes('Package includes')), true);
  assert.match(normalized.notes.join(' '), /visibleText truncated: original 12, kept 5/);

  if (previousPerImage == null) delete process.env.VISION_VISIBLE_TEXT_LIMIT_PER_IMAGE;
  else process.env.VISION_VISIBLE_TEXT_LIMIT_PER_IMAGE = previousPerImage;
  if (previousTotal == null) delete process.env.VISION_VISIBLE_TEXT_TOTAL_LIMIT;
  else process.env.VISION_VISIBLE_TEXT_TOTAL_LIMIT = previousTotal;
});

test('testVisionRecognition script validates missing image path', async () => {
  await assert.rejects(
    () => validateImageArgument(),
    (error) => error.code === 'MISSING_IMAGE_PATH'
  );
});

test('testVisionRecognition script validates missing image file', async () => {
  await assert.rejects(
    () => validateImageArgument('does-not-exist.jpg'),
    (error) => error.code === 'IMAGE_NOT_FOUND'
  );
});

test('testVisionRecognition script parses multi-provider directory arguments', () => {
  const options = parseVisionDebugArgs([
    '--providers', 'qwen,openai,gemini',
    '--dir', 'test-assets/sku001',
    '--recursive'
  ]);

  assert.deepEqual(options.providers, ['qwen', 'openai', 'gemini']);
  assert.equal(options.dir, 'test-assets/sku001');
  assert.equal(options.recursive, true);
  assert.deepEqual(options.images, []);
});

test('testVisionRecognition script parses explicit image arguments', () => {
  const options = parseVisionDebugArgs([
    '--provider', 'openai',
    '--images', 'main.jpg', 'size.jpg'
  ]);

  assert.deepEqual(options.providers, ['openai']);
  assert.deepEqual(options.images, ['main.jpg', 'size.jpg']);
  assert.equal(options.dir, null);
  assert.equal(options.recursive, false);
});

test('qwen provider reports missing api key without throwing', async () => {
  process.env.VISION_PROVIDER = 'qwen';
  delete process.env.QWEN_API_KEY;
  const provider = getVisionProvider();
  const result = await provider.recognize({ task: { id: 'task_missing_qwen' }, image: null });

  assert.equal(result.provider, 'qwen');
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'MISSING_API_KEY');
  assert.equal(result.data, null);
});

test('openai provider reports missing api key without throwing', async () => {
  process.env.VISION_PROVIDER = 'openai';
  delete process.env.OPENAI_API_KEY;
  const provider = getVisionProvider();
  const result = await provider.recognize({ task: { id: 'task_missing_openai' }, image: null });

  assert.equal(result.provider, 'openai');
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'MISSING_API_KEY');
  assert.equal(result.data, null);
});

test('gemini provider reports missing api key without throwing', async () => {
  process.env.VISION_PROVIDER = 'gemini';
  delete process.env.GEMINI_API_KEY;
  const provider = getVisionProvider();
  const result = await provider.recognize({ task: { id: 'task_missing_gemini' }, image: null });

  assert.equal(result.provider, 'gemini');
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'MISSING_API_KEY');
  assert.equal(result.data, null);
});

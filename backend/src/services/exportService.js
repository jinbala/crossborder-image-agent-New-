import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';
import { paths } from './db.js';
import { sanitizeFilePart } from '../utils/fileNaming.js';
import { buildGenerationQualitySummary } from './productPreserveQualityService.js';
import { normalizeTargets, targetSlug } from './targetService.js';

function imagePlanTrace(task) {
  return (task.imagePlans || []).map((plan) => ({
    planId: plan.id,
    type: plan.type,
    title: plan.title,
    promptVersion: plan.promptVersion,
    productInfoConfirmed: task.productInfoConfirmed || task.productInfo || {},
    fieldEvidenceSummary: plan.fieldEvidenceSummary || task.fieldEvidence || {},
    excludedInferredCandidates: plan.excludedUnconfirmedFields || [],
    riskWarnings: plan.riskWarnings || [],
    platformRulesSnapshot: plan.rulesSnapshot || task.targets?.find((target) => target.id === plan.targetId)?.rulesSnapshot || null,
    categoryRuleSnapshot: plan.categoryRuleSnapshot || null
  }));
}

function requestSummaryForPlan(task, plan) {
  const generated = (task.generatedImages || []).find((image) => image.planId === plan.id);
  return generated?.generationRequestSummary || generated?.generationRequest || null;
}

function platformRuleSnapshotFromImage(image = {}) {
  return image.platformRuleSnapshot ||
    image.generationRequestSummary?.platformRuleSnapshot ||
    image.generationRequest?.compliance?.platformRulesSnapshot ||
    null;
}

function platformRuleSnapshotsForTask(task, generatedImages = []) {
  const snapshots = [
    ...generatedImages.map(platformRuleSnapshotFromImage),
    ...(task.imagePlans || []).map((plan) => requestSummaryForPlan(task, plan)?.platformRuleSnapshot),
    ...(task.reviewResults || []).map((item) => item.platformRuleSnapshot || item.platformChecks?.platformRuleSnapshot)
  ].filter(Boolean);
  const byKey = new Map();
  for (const snapshot of snapshots) {
    const key = `${snapshot.platformId || snapshot.platformName || ''}:${snapshot.site || ''}:${snapshot.imageType || ''}:${snapshot.language || ''}`;
    byKey.set(key, snapshot);
  }
  return [...byKey.values()];
}

function categoryRuleSnapshotFromImage(image = {}) {
  return image.categoryRuleSnapshot ||
    image.generationRequestSummary?.categoryRuleSnapshot ||
    image.generationRequest?.categoryRuleSnapshot ||
    image.generationRequest?.compliance?.categoryRuleSnapshot ||
    null;
}

function categoryRuleSnapshotsForTask(task, generatedImages = []) {
  const snapshots = [
    ...generatedImages.map(categoryRuleSnapshotFromImage),
    ...(task.imagePlans || []).map((plan) => plan.categoryRuleSnapshot || requestSummaryForPlan(task, plan)?.categoryRuleSnapshot),
    ...(task.reviewResults || []).map((item) => item.categoryRuleSnapshot || item.platformChecks?.categoryRuleSnapshot || item.metadata?.categoryRuleSnapshot)
  ].filter(Boolean);
  const byKey = new Map();
  for (const snapshot of snapshots) {
    const key = `${snapshot.categoryId || ''}:${snapshot.imageType || ''}`;
    byKey.set(key, snapshot);
  }
  return [...byKey.values()];
}

function latestGeneratedImages(task) {
  const byPlan = new Map();
  for (const image of task.generatedImages || []) {
    const key = image.planId || image.id;
    const current = byPlan.get(key);
    if (!current || (image.version || 1) >= (current.version || 1)) {
      byPlan.set(key, image);
    }
  }
  return [...byPlan.values()];
}

function imagesForTarget(images = [], targetId) {
  return images.filter((image) => (image.targetId || image.generationRequestSummary?.targetId) === targetId);
}

function reviewResultsForTarget(reviewResults = [], targetId) {
  return reviewResults.filter((item) => item.targetId === targetId);
}

export function buildImageSourceSummary(images = []) {
  const providers = [...new Set(images.map((image) => image.provider).filter(Boolean))].sort();
  return {
    totalImages: images.length,
    mockPreviewCount: images.filter((image) => Boolean(image.isMockPreview || image.provider === 'mock') && !image.fallbackToMock).length,
    realGeneratedCount: images.filter((image) => Boolean(image.isRealGenerated)).length,
    fallbackMockCount: images.filter((image) => Boolean(image.fallbackToMock)).length,
    providers
  };
}

export function buildCompositeQualitySummary(images = []) {
  return images.reduce((summary, image) => {
    const level = image.compositeQuality?.level || image.preserveQuality?.compositeQuality?.level || 'unknown';
    if (level === 'good') summary.goodCount += 1;
    else if (level === 'medium') summary.mediumCount += 1;
    else if (level === 'poor') summary.poorCount += 1;
    else summary.unknownCount += 1;
    return summary;
  }, { goodCount: 0, mediumCount: 0, poorCount: 0, unknownCount: 0 });
}

export function buildReviewSummary(reviewResults = []) {
  return reviewResults.reduce((summary, item) => {
    summary.totalImages += 1;
    if (item.pass === true || item.status === 'passed') summary.passCount += 1;
    else summary.failCount += 1;
    if (item.riskLevel === 'high') summary.highRiskCount += 1;
    else if (item.riskLevel === 'medium') summary.mediumRiskCount += 1;
    else summary.lowRiskCount += 1;
    if (item.isRealReview) summary.realReviewCount += 1;
    else summary.mockReviewCount += 1;
    if (item.fallbackToMockReview) summary.fallbackReviewCount += 1;
    return summary;
  }, {
    totalImages: 0,
    passCount: 0,
    failCount: 0,
    highRiskCount: 0,
    mediumRiskCount: 0,
    lowRiskCount: 0,
    realReviewCount: 0,
    mockReviewCount: 0,
    fallbackReviewCount: 0
  });
}

function targetSummary(task, target, images) {
  const reviewResults = reviewResultsForTarget(task.reviewResults || [], target.id);
  return {
    targetId: target.id,
    platformId: target.platformId,
    platformName: target.platformName,
    site: target.site,
    language: target.language,
    categoryId: target.categoryId,
    totalImages: images.length,
    imageSourceSummary: buildImageSourceSummary(images),
    generationQualitySummary: buildGenerationQualitySummary(images),
    reviewSummary: buildReviewSummary(reviewResults),
    folder: targetSlug(target)
  };
}

function imageExportTrace(image = {}) {
  return {
    ...image,
    planId: image.planId,
    imageType: image.type || image.imageType,
    fileName: image.fileName,
    version: image.version || 1,
    provider: image.provider,
    model: image.model,
    mode: image.mode || 'mock',
    isMockPreview: Boolean(image.isMockPreview || image.provider === 'mock'),
    isRealGenerated: Boolean(image.isRealGenerated),
    fallbackToMock: Boolean(image.fallbackToMock),
    realGenerationError: image.realGenerationError || null,
    productReferenceUsed: Boolean(image.productReferenceUsed),
    productReferenceSelectedBy: image.productReferenceSelectedBy || null,
    productReferenceOverride: image.productReferenceOverride || null,
    realBackgroundOnly: Boolean(image.realBackgroundOnly),
    realGenerationMode: image.realGenerationMode || (image.isRealGenerated ? 'text_to_image' : 'mock'),
    subjectCompositeUsed: Boolean(image.subjectCompositeUsed),
    subjectExtractionMethod: image.subjectExtractionMethod || null,
    subjectSourceImageId: image.subjectSourceImageId || null,
    subjectSourceDisplayName: image.subjectSourceDisplayName || null,
    subjectPreserved: Boolean(image.subjectPreserved),
    backgroundGenerated: Boolean(image.backgroundGenerated),
    productGeneratedByAI: image.productGeneratedByAI ?? null,
    compositeMetadata: image.compositeMetadata || null,
    fallbackChain: image.fallbackChain || [],
    mattingProvider: image.mattingProvider || null,
    mattingModel: image.mattingModel || null,
    mattingMethod: image.mattingMethod || null,
    mattingConfidence: image.mattingConfidence ?? null,
    edgeQuality: image.edgeQuality || null,
    backgroundType: image.backgroundType || null,
    mattingWarnings: image.mattingWarnings || [],
    mattingFallbackToSharp: Boolean(image.mattingFallbackToSharp),
    externalMattingError: image.externalMattingError || null,
    subjectPngPath: image.subjectPngPath || null,
    maskPath: image.maskPath || null,
    mattingPreviewUsed: Boolean(image.mattingPreviewUsed),
    compositeSettings: image.compositeSettings || null,
    compositeQuality: image.compositeQuality || image.preserveQuality?.compositeQuality || null,
    compositeMode: image.compositeMode || null,
    subjectScale: image.subjectScale ?? null,
    subjectPlacement: image.subjectPlacement || null,
    shadowApplied: Boolean(image.shadowApplied),
    edgeFeatherApplied: Boolean(image.edgeFeatherApplied),
    colorMatchApplied: Boolean(image.colorMatchApplied),
    textLayout: image.textLayout || null,
    renderedBy: image.renderedBy || null,
    layoutSource: image.layoutSource || image.textLayout?.layoutSource || null,
    layoutEditedByUser: Boolean(image.layoutEditedByUser || image.textLayout?.layoutEditedByUser),
    layoutEditedAt: image.layoutEditedAt || image.textLayout?.layoutEditedAt || null,
    preserveQuality: image.preserveQuality || null,
    generationStrategy: image.generationStrategy || null,
    editAttempted: Boolean(image.editAttempted),
    editSucceeded: Boolean(image.editSucceeded),
    editFailed: Boolean(image.editFailed),
    fallbackMode: image.fallbackMode || null,
    productReference: image.productReference || null,
    referencePreprocess: image.referencePreprocess || null,
    generationRequestSummary: image.generationRequestSummary || image.generationRequest || null,
    platformRuleSnapshot: platformRuleSnapshotFromImage(image),
    categoryRuleSnapshot: categoryRuleSnapshotFromImage(image)
  };
}

export function buildExportMetadata(task) {
  const generatedImages = latestGeneratedImages(task);
  const targets = normalizeTargets(task.targets || [], { productInfo: task.productInfoConfirmed || task.productInfo || {}, fallbackTask: task });
  return {
      taskId: task.id,
      sku: task.productInfo?.sku,
      platform: task.platform,
      language: task.language,
      isMockPreview: generatedImages.some((image) => image.isMockPreview || image.provider === 'mock'),
      imageSourceSummary: buildImageSourceSummary(generatedImages),
      generationQualitySummary: buildGenerationQualitySummary(generatedImages),
      compositeQualitySummary: buildCompositeQualitySummary(generatedImages),
      reviewSummary: buildReviewSummary(task.reviewResults || []),
      platformRuleSnapshots: platformRuleSnapshotsForTask(task, generatedImages),
      categoryRuleSnapshots: categoryRuleSnapshotsForTask(task, generatedImages),
      sourceImages: task.sourceImages || [],
      targets: task.targets || [],
      platformSummaries: targets.map((target) => targetSummary(task, target, imagesForTarget(generatedImages, target.id))),
      productInfoConfirmed: task.productInfoConfirmed || task.productInfo || {},
      fieldEvidence: task.fieldEvidence || {},
      inferredCandidates: task.inferredCandidates || [],
      imagePlanTrace: imagePlanTrace(task),
      generatedImages: generatedImages.map(imageExportTrace),
      generationRequests: (task.imagePlans || [])
        .map((plan) => requestSummaryForPlan(task, plan))
        .filter(Boolean),
      exports: task.exports || []
    };
}

export function buildTargetExportMetadata(task, targetId) {
  const generatedImages = latestGeneratedImages(task);
  const targets = normalizeTargets(task.targets || [], { productInfo: task.productInfoConfirmed || task.productInfo || {}, fallbackTask: task });
  const target = targets.find((item) => item.id === targetId || item.targetId === targetId) || targets[0];
  const images = imagesForTarget(generatedImages, target.id);
  const reviewResults = reviewResultsForTarget(task.reviewResults || [], target.id);
  return {
    targetId: target.id,
    platformId: target.platformId,
    platformName: target.platformName,
    site: target.site,
    language: target.language,
    categoryId: target.categoryId,
    productInfoConfirmed: task.productInfoConfirmed || task.productInfo || {},
    imageSourceSummary: buildImageSourceSummary(images),
    generationQualitySummary: buildGenerationQualitySummary(images),
    compositeQualitySummary: buildCompositeQualitySummary(images),
    reviewSummary: buildReviewSummary(reviewResults),
    platformRuleSnapshot: target.platformRuleSnapshot || target.rulesSnapshot || null,
    categoryRuleSnapshot: target.categoryRuleSnapshot || images[0]?.generationRequestSummary?.categoryRuleSnapshot || null,
    images: images.map(imageExportTrace),
    reviewResults
  };
}

export function buildMasterMetadata(task) {
  const generatedImages = latestGeneratedImages(task);
  const targets = normalizeTargets(task.targets || [], { productInfo: task.productInfoConfirmed || task.productInfo || {}, fallbackTask: task });
  return {
    taskId: task.id,
    sku: task.productInfoConfirmed?.sku || task.productInfo?.sku || task.sku,
    productInfoConfirmed: task.productInfoConfirmed || task.productInfo || {},
    targets,
    platformSummaries: targets.map((target) => targetSummary(task, target, imagesForTarget(generatedImages, target.id))),
    totalImages: generatedImages.length,
    createdAt: new Date().toISOString()
  };
}

export function buildExportPrompts(task) {
  const generatedImages = latestGeneratedImages(task);
  return {
      promptVersion: task.imagePlans?.[0]?.promptVersion,
      isMockPreview: generatedImages.some((image) => image.isMockPreview || image.provider === 'mock'),
      imageSourceSummary: buildImageSourceSummary(generatedImages),
      generationQualitySummary: buildGenerationQualitySummary(generatedImages),
      compositeQualitySummary: buildCompositeQualitySummary(generatedImages),
      reviewSummary: buildReviewSummary(task.reviewResults || []),
      platformRuleSnapshots: platformRuleSnapshotsForTask(task, generatedImages),
      categoryRuleSnapshots: categoryRuleSnapshotsForTask(task, generatedImages),
      productInfoConfirmed: task.productInfoConfirmed || task.productInfo || {},
      fieldEvidence: task.fieldEvidence || {},
      excludedInferredCandidates: task.inferredCandidates || [],
      generatedImages: generatedImages.map(imageExportTrace),
      generationRequests: (task.imagePlans || [])
        .map((plan) => requestSummaryForPlan(task, plan))
        .filter(Boolean),
      imagePlans: (task.imagePlans || []).map((plan) => ({
        ...plan,
        productInfoConfirmed: task.productInfoConfirmed || task.productInfo || {},
        fieldEvidenceSummary: plan.fieldEvidenceSummary || task.fieldEvidence || {},
        excludedInferredCandidates: plan.excludedUnconfirmedFields || [],
        platformRulesSnapshot: plan.rulesSnapshot || task.targets?.find((target) => target.id === plan.targetId)?.rulesSnapshot || null,
        categoryRuleSnapshot: plan.categoryRuleSnapshot || null
      }))
    };
}

export async function createExportZip(task) {
  if (!task.generatedImages?.length) {
    const error = new Error('Generated images are required before export');
    error.statusCode = 400;
    throw error;
  }

  const exportDir = path.join(paths.outputDir, task.id);
  await fsp.mkdir(exportDir, { recursive: true });
  const zipName = `${sanitizeFilePart(task.platform)}_${sanitizeFilePart(task.productInfo?.sku || task.id)}_image-pack.zip`;
  const zipPath = path.join(exportDir, zipName);

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    const generatedImages = latestGeneratedImages(task);
    const targets = normalizeTargets(task.targets || [], { productInfo: task.productInfoConfirmed || task.productInfo || {}, fallbackTask: task });
    const targetFilter = task.exportTargetId || task.targetId;
    const exportTargets = targetFilter ? targets.filter((target) => target.id === targetFilter || target.targetId === targetFilter) : targets;
    if (targetFilter && exportTargets.length === 0) {
      throw new Error(`Export target not found: ${targetFilter}`);
    }
    const exportedGeneratedImages = targetFilter
      ? generatedImages.filter((image) => exportTargets.some((target) => image.targetId === target.id || image.targetId === target.targetId || image.platformId === target.platformId))
      : generatedImages;
    const exportedReviewResults = targetFilter
      ? exportTargets.flatMap((target) => reviewResultsForTarget(task.reviewResults || [], target.id))
      : (task.reviewResults || []);
    const exportedImageIds = new Set(exportedGeneratedImages.map((image) => image.id));
    const exportTask = targetFilter
      ? {
          ...task,
          targets: exportTargets,
          generatedImages: exportedGeneratedImages,
          reviewResults: exportedReviewResults,
          review: task.review
            ? {
                ...task.review,
                items: (task.review.items || []).filter((item) => exportedImageIds.has(item.imageId))
              }
            : task.review
        }
      : task;
    for (const target of exportTargets) {
      const folder = targetSlug(target);
      const targetImages = imagesForTarget(generatedImages, target.id);
      for (const image of targetImages) {
        archive.file(path.join(paths.rootDir, image.filePath), { name: `${folder}/images/${image.fileName}` });
      }
    }
    const metadata = buildExportMetadata(exportTask);
    const prompts = buildExportPrompts(exportTask);
    const reviewReport = {
      imageSourceSummary: buildImageSourceSummary(exportedGeneratedImages),
      generationQualitySummary: buildGenerationQualitySummary(exportedGeneratedImages),
      compositeQualitySummary: buildCompositeQualitySummary(exportedGeneratedImages),
      reviewSummary: buildReviewSummary(exportedReviewResults),
      platformRuleSnapshots: platformRuleSnapshotsForTask(exportTask, exportedGeneratedImages),
      categoryRuleSnapshots: categoryRuleSnapshotsForTask(exportTask, exportedGeneratedImages),
      generatedImages: exportedGeneratedImages.map(imageExportTrace),
      review: exportTask.review,
      reviewResults: exportedReviewResults
    };
    const manifest = {
      packageName: zipName,
      createdAt: new Date().toISOString(),
      imageSourceSummary: buildImageSourceSummary(exportedGeneratedImages),
      generationQualitySummary: buildGenerationQualitySummary(exportedGeneratedImages),
      compositeQualitySummary: buildCompositeQualitySummary(exportedGeneratedImages),
      reviewSummary: buildReviewSummary(exportedReviewResults),
      platformRuleSnapshots: platformRuleSnapshotsForTask(exportTask, exportedGeneratedImages),
      categoryRuleSnapshots: categoryRuleSnapshotsForTask(exportTask, exportedGeneratedImages),
      files: [
        ...exportedGeneratedImages.map((image) => ({
          type: 'image',
          imageId: image.id,
          planId: image.planId,
          imageType: image.type,
          version: image.version || 1,
          fileName: image.fileName,
          status: image.status,
          provider: image.provider,
          model: image.model,
          mode: image.mode || 'mock',
          isMockPreview: Boolean(image.isMockPreview),
          isRealGenerated: Boolean(image.isRealGenerated),
          fallbackToMock: Boolean(image.fallbackToMock),
          realGenerationError: image.realGenerationError || null,
          productReferenceUsed: Boolean(image.productReferenceUsed),
          productReferenceSelectedBy: image.productReferenceSelectedBy || null,
          productReferenceOverride: image.productReferenceOverride || null,
          realBackgroundOnly: Boolean(image.realBackgroundOnly),
          realGenerationMode: image.realGenerationMode || (image.isRealGenerated ? 'text_to_image' : 'mock'),
          subjectCompositeUsed: Boolean(image.subjectCompositeUsed),
          subjectExtractionMethod: image.subjectExtractionMethod || null,
          subjectSourceImageId: image.subjectSourceImageId || null,
          subjectSourceDisplayName: image.subjectSourceDisplayName || null,
          subjectPreserved: Boolean(image.subjectPreserved),
          backgroundGenerated: Boolean(image.backgroundGenerated),
          productGeneratedByAI: image.productGeneratedByAI ?? null,
          compositeMetadata: image.compositeMetadata || null,
          fallbackChain: image.fallbackChain || [],
          mattingProvider: image.mattingProvider || null,
          mattingModel: image.mattingModel || null,
          mattingMethod: image.mattingMethod || null,
          mattingConfidence: image.mattingConfidence ?? null,
          edgeQuality: image.edgeQuality || null,
          backgroundType: image.backgroundType || null,
          mattingWarnings: image.mattingWarnings || [],
          mattingFallbackToSharp: Boolean(image.mattingFallbackToSharp),
          externalMattingError: image.externalMattingError || null,
          subjectPngPath: image.subjectPngPath || null,
          maskPath: image.maskPath || null,
          mattingPreviewUsed: Boolean(image.mattingPreviewUsed),
          compositeSettings: image.compositeSettings || null,
          compositeQuality: image.compositeQuality || image.preserveQuality?.compositeQuality || null,
          compositeMode: image.compositeMode || null,
          subjectScale: image.subjectScale ?? null,
          subjectPlacement: image.subjectPlacement || null,
          shadowApplied: Boolean(image.shadowApplied),
          edgeFeatherApplied: Boolean(image.edgeFeatherApplied),
          colorMatchApplied: Boolean(image.colorMatchApplied),
          textLayout: image.textLayout || null,
          renderedBy: image.renderedBy || null,
          layoutSource: image.layoutSource || image.textLayout?.layoutSource || null,
          layoutEditedByUser: Boolean(image.layoutEditedByUser || image.textLayout?.layoutEditedByUser),
          layoutEditedAt: image.layoutEditedAt || image.textLayout?.layoutEditedAt || null,
          preserveQuality: image.preserveQuality || null,
          generationStrategy: image.generationStrategy || null,
          editAttempted: Boolean(image.editAttempted),
          editSucceeded: Boolean(image.editSucceeded),
          editFailed: Boolean(image.editFailed),
          fallbackMode: image.fallbackMode || null,
          productReference: image.productReference || null,
          referencePreprocess: image.referencePreprocess || null,
          generationRequestSummary: image.generationRequestSummary || image.generationRequest || null,
          platformRuleSnapshot: platformRuleSnapshotFromImage(image),
          categoryRuleSnapshot: categoryRuleSnapshotFromImage(image)
        })),
        { type: 'metadata', fileName: 'metadata.json' },
        { type: 'prompts', fileName: 'prompts.json' },
        { type: 'review', fileName: 'review-report.json' },
        { type: 'manifest', fileName: 'manifest.json' }
      ]
    };
    for (const target of exportTargets) {
      const folder = targetSlug(target);
      const targetMetadata = buildTargetExportMetadata(exportTask, target.id);
      archive.append(JSON.stringify(targetMetadata, null, 2), { name: `${folder}/metadata.json` });
      archive.append(JSON.stringify({ ...prompts, targetId: target.id, generatedImages: targetMetadata.images }, null, 2), { name: `${folder}/prompts.json` });
      archive.append(JSON.stringify({
        reviewSummary: targetMetadata.reviewSummary,
        generatedImages: targetMetadata.images,
        reviewResults: targetMetadata.reviewResults
      }, null, 2), { name: `${folder}/review-report.json` });
      archive.append(JSON.stringify({
        packageName: zipName,
        createdAt: new Date().toISOString(),
        targetId: target.id,
        files: targetMetadata.images.map((image) => ({ type: 'image', fileName: `images/${image.fileName}`, planId: image.planId, imageType: image.imageType, version: image.version }))
      }, null, 2), { name: `${folder}/manifest.json` });
    }
    archive.append(JSON.stringify(metadata, null, 2), { name: 'metadata.json' });
    archive.append(JSON.stringify(prompts, null, 2), { name: 'prompts.json' });
    archive.append(JSON.stringify(reviewReport, null, 2), { name: 'review-report.json' });
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
    archive.append(JSON.stringify(buildMasterMetadata(exportTask), null, 2), { name: 'master-metadata.json' });
    archive.finalize();
  });

  return {
    id: `${task.id}-export-${Date.now()}`,
    fileName: zipName,
    filePath: path.relative(paths.rootDir, zipPath).replaceAll('\\', '/'),
    createdAt: new Date().toISOString(),
    status: 'succeeded'
  };
}

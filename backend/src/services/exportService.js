import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';
import { randomUUID, createHash } from 'node:crypto';
import { paths } from './db.js';
import { sanitizeFilePart } from '../utils/fileNaming.js';
import { buildGenerationQualitySummary } from './productPreserveQualityService.js';
import { normalizeTargets } from './targetService.js';
import { readExportSource } from './exportPackageService.js';
import { exportTargetsForTask, imageBelongsToExportTarget, reviewBelongsToExportTarget, resolveExportImageTarget, singleTargetFolder, latestExportImages } from '../../../frontend/src/utils/exportTargets.js';

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
  return latestExportImages(task);
}

function imagesForTarget(images = [], targetId, task) {
  const target = exportTargetsForTask(task).find(target => target.id === targetId || target.targetId === targetId);
  return target ? images.filter(image => imageBelongsToExportTarget(task,image,target)) : [];
}

function reviewResultsForTarget(reviewResults = [], targetId, task) {
  const target = exportTargetsForTask(task).find(target => target.id === targetId || target.targetId === targetId);
  const imageIds=new Set(latestGeneratedImages(task).map(image=>image.id));
  return target ? reviewResults.filter(review => reviewBelongsToExportTarget(task,review,target)&&(!review.imageId||imageIds.has(review.imageId))) : [];
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
  const reviewResults = reviewResultsForTarget(task.reviewResults || [], target.id, task);
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
    folder: singleTargetFolder(target, exportTargetsForTask(task))
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
  const targets = normalizeTargets(exportTargetsForTask(task), { productInfo: task.productInfoConfirmed || task.productInfo || {}, fallbackTask: task });
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
      platformSummaries: targets.map((target) => targetSummary(task, target, imagesForTarget(generatedImages, target.id, task))),
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
  const targets = normalizeTargets(exportTargetsForTask(task), { productInfo: task.productInfoConfirmed || task.productInfo || {}, fallbackTask: task });
  const target = targets.find((item) => item.id === targetId || item.targetId === targetId);
  if (!target) throw Object.assign(new Error('Export target not found'), {statusCode:400});
  const images = imagesForTarget(generatedImages, target.id, task);
  const reviewResults = reviewResultsForTarget(task.reviewResults || [], target.id, task);
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
  const targets = normalizeTargets(exportTargetsForTask(task), { productInfo: task.productInfoConfirmed || task.productInfo || {}, fallbackTask: task });
  return {
    taskId: task.id,
    sku: task.productInfoConfirmed?.sku || task.productInfo?.sku || task.sku,
    productInfoConfirmed: task.productInfoConfirmed || task.productInfo || {},
    targets,
    platformSummaries: targets.map((target) => targetSummary(task, target, imagesForTarget(generatedImages, target.id, task))),
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
  const generatedImages = latestGeneratedImages(task);
  const targets = normalizeTargets(exportTargetsForTask(task), { productInfo: task.productInfoConfirmed || task.productInfo || {}, fallbackTask: task });
  const targetFilter = task.exportTargetId || task.targetId;
  const exportTargets = targetFilter ? targets.filter(target => target.id === targetFilter || target.targetId === targetFilter) : targets;
  if (!exportTargets.length) throw Object.assign(new Error('Export target not found'), {statusCode:400});
  if (!generatedImages.some(image => exportTargets.some(target => imageBelongsToExportTarget(task,image,target)))) throw Object.assign(new Error('Selected target has no successful assigned images'), {statusCode:400});
  const sources=new Map(),archivePaths=new Set();
  for(const target of exportTargets){
    for(const image of imagesForTarget(generatedImages,target.id,task)){
      const name=image.fileName;
      if(typeof name!=='string'||!name||name.length>200||/^\.+$/.test(name)||/[. ]$/.test(name)||/[\\/:*?"<>|\u0000-\u001f]/.test(name)||/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name))throw Object.assign(new Error('图片文件名不适用于 ZIP/Windows，请检查图片清单后重试。'),{statusCode:400});
      const key=`${singleTargetFolder(target,exportTargets)}/images/${name}`.toLowerCase();
      if(archivePaths.has(key))throw Object.assign(new Error('目标目录内存在同名图片，请检查图片清单或重新生成后重试。'),{statusCode:409});
      archivePaths.add(key);
      try{const {sourcePath,input,bytes}=await readExportSource(image.filePath);await input.stats();input.destroy();sources.set(image,{sourcePath,sourceSha256:createHash('sha256').update(bytes).digest('hex')});}
      catch(error){throw Object.assign(new Error(`源图校验失败（${error.exportImageCode||'IMAGE_DECODE_FAILED'}），请修复源图后重试。`),{statusCode:400});}
    }
  }

  const exportDir = path.join(paths.outputDir, task.id);
  await fsp.mkdir(exportDir, { recursive: true });
  const exportId = `${task.id}-export-${randomUUID()}`;
  const zipName = `${sanitizeFilePart(task.platform)}_${sanitizeFilePart(task.productInfo?.sku || task.id)}_${exportId.slice(-12)}_image-pack.zip`;
  const zipPath = path.join(exportDir, zipName);

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath, {flags:'wx'});
    const archive = archiver('zip', { zlib: { level: 9 } });
    let failed = false;
    const fail = error => { if(failed)return;failed=true;archive.abort();output.destroy();reject(error); };
    output.on('close', resolve);
    output.on('error', fail); archive.on('error', fail); archive.on('warning', fail);
    archive.pipe(output);
    const exportedGeneratedImages = generatedImages.filter(image => sources.has(image)).map(image=>({...image,sourceSha256:sources.get(image).sourceSha256}));
    const exportedImageIds = new Set(exportedGeneratedImages.map(image=>image.id));
    const candidateReviews = targetFilter
      ? exportTargets.flatMap(target => reviewResultsForTarget(task.reviewResults || [], target.id, task))
      : (task.reviewResults || []).filter(review => exportTargets.some(target => reviewBelongsToExportTarget(task,review,target)));
    const exportedReviewResults = candidateReviews.filter(review=>!review.imageId || exportedImageIds.has(review.imageId));
    const exportTask = {
          ...task,
          targets: exportTargets,
          imagePlans: (task.imagePlans || []).filter(plan=>exportTargets.some(target=>imageBelongsToExportTarget(task,{planId:plan.id,targetId:plan.targetId,platformId:plan.platformId},target))),
          generatedImages: exportedGeneratedImages,
          reviewResults: exportedReviewResults,
          review: task.review
            ? {
                ...task.review,
                items: (task.review.items || []).filter((item) => exportedImageIds.has(item.imageId))
              }
            : task.review
        };
    for (const target of exportTargets) {
      const folder = singleTargetFolder(target, exportTargets);
      const targetImages = imagesForTarget(generatedImages, target.id, task);
      for (const image of targetImages) {
        archive.file(sources.get(image).sourcePath, { name: `${folder}/images/${image.fileName}` });
      }
    }
    const metadata = buildExportMetadata(exportTask);
    metadata.excludedImages = generatedImages.filter(image => !exportedImageIds.has(image.id)).map(image => ({imageId:image.id,planId:image.planId,code:resolveExportImageTarget(task,image).code || 'IMAGE_TARGET_NOT_SELECTED'}));
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
      const folder = singleTargetFolder(target, exportTargets);
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
    archive.finalize().catch(fail);
  });

  const digest=createHash('sha256');let bytes=0;
  for await(const chunk of fs.createReadStream(zipPath)){digest.update(chunk);bytes+=chunk.length;}
  return {
    id: exportId,
    targetIds: exportTargets.map(target=>target.id),
    sha256: digest.digest('hex'), bytes,
    fileName: zipName,
    filePath: path.relative(paths.rootDir, zipPath).replaceAll('\\', '/'),
    createdAt: new Date().toISOString(),
    status: 'succeeded'
  };
}

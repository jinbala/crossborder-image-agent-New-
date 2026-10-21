// Shared, pure target identity rules. No locale, browser, filesystem or provider
// dependencies: backend exports and the preview UI must select the same images.
const array = value => Array.isArray(value) ? value : [];
const platform = value => String(value || 'amazon').toLowerCase();
const part = value => String(value || '').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 45) || 'unknown';
function shortHash(value) {
  let hash = 2166136261;
  const text = String(value);
  for (let index=0;index<text.length;index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}
export function exportTargetsForTask(task = {}) {
  const targets = array(task.targets);
  const inputs = targets.length ? targets : [{ platformId: task.platformId || task.platform, site: task.site, language: task.language }];
  return inputs.map((target, index) => {
    const platformId = platform(target.platformId || target.platform || task.platformId || task.platform);
    const id = String(target.id || target.targetId || `legacy-${platformId}-${index + 1}`);
    return { ...target, id, targetId: String(target.targetId || id), platformId,
      site: String(target.site || task.site || 'US'), language: String(target.language || task.language || 'English') };
  });
}
export function exportTargetsForPlatform(task, platformId) {
  const matches = exportTargetsForTask(task).filter(target => target.platformId === platform(platformId));
  return matches.length ? matches : [{ id: `missing-${platform(platformId)}`, targetId: `missing-${platform(platformId)}`,
    platformId: platform(platformId), site: 'US', language: 'English', placeholder: true }];
}
export function resolveExportImageTarget(task = {}, image = {}) {
  const targets = exportTargetsForTask(task), plan = array(task.imagePlans).find(plan => plan.id === image.planId) || {};
  const reference = image.targetId || image.generationRequestSummary?.targetId || image.generationRequest?.targetId || plan.targetId;
  const explicitPlatform = image.platformId || image.platform || plan.platformId || plan.platform;
  if (reference) {
    const matches = targets.filter(target => target.id === String(reference) || target.targetId === String(reference));
    if (matches.length !== 1) return { target: null, code: 'IMAGE_TARGET_UNKNOWN' };
    if (explicitPlatform && matches[0].platformId !== platform(explicitPlatform)) return { target: null, code: 'IMAGE_TARGET_CONFLICT' };
    return { target: matches[0], code: null };
  }
  const imagePlatform = platform(explicitPlatform || task.platformId || task.platform);
  let candidates = targets.filter(target => target.platformId === imagePlatform);
  const site = image.site || plan.site, language = image.language || plan.language;
  if (site) candidates = candidates.filter(target => target.site.toLowerCase() === String(site).toLowerCase());
  if (language) candidates = candidates.filter(target => target.language.toLowerCase() === String(language).toLowerCase());
  return candidates.length === 1 ? { target: candidates[0], code: null } : { target: null, code: candidates.length ? 'IMAGE_TARGET_AMBIGUOUS' : 'IMAGE_TARGET_UNKNOWN' };
}
export function imageBelongsToExportTarget(task, image, target) {
  const resolved = resolveExportImageTarget(task, image).target;
  return Boolean(resolved && !target.placeholder && resolved.id === target.id && resolved.platformId === target.platformId);
}
export function reviewBelongsToExportTarget(task, review, target) {
  const image = array(task.generatedImages).find(image => image.id === review.imageId);
  if (review.targetId) {
    if (!imageBelongsToExportTarget(task, review, target)) return false;
    return !image || imageBelongsToExportTarget(task,image,target);
  }
  return image ? imageBelongsToExportTarget(task, image, target) : Boolean(review.platformId && imageBelongsToExportTarget(task, review, target));
}
export function exportImageKey(taskId, targetId, imageType) { return JSON.stringify([String(taskId), String(targetId), String(imageType)]); }
export function structuredTargetFolder(target, siblings) {
  if (siblings.length <= 1) return '';
  return `${part(target.site)}-${part(target.language)}-target-${part(target.id)}-${shortHash(target.id)}`;
}
export function singleTargetFolder(target, siblings) {
  const slug = `${part(target.platformId)}-${part(target.site)}-${part(target.language)}`;
  const conflicts = siblings.filter(item => `${part(item.platformId)}-${part(item.site)}-${part(item.language)}`.toLowerCase() === slug.toLowerCase());
  return conflicts.length <= 1 ? slug : `${slug}-target-${part(target.id)}-${shortHash(target.id)}`;
}
export function exportImageType(image = {}) { return image.imageType || image.type || image.mockPreview?.type || image.mockPreview?.template?.templateType || ''; }
export function exportImageSourceType(image = {}) {
  if (!image || !Object.keys(image).length) return 'missing';
  if (image.fallbackToMock || ['fallbackMock', 'fallback_mock'].includes(image.sourceType)) return 'fallbackMock';
  if (image.isMockPreview || image.provider === 'mock' || image.mockPreview || ['mock', 'mockPreview'].includes(image.sourceType)) return 'mock';
  if (image.sourceType === 'realSample' || image.isRealSample === true) return 'realSample';
  if (image.isRealGenerated === true || image.realMode === true || image.provider === 'openai' || ['real', 'realGenerated'].includes(image.sourceType)) return 'real';
  return typeof image.sourceType === 'string' && image.sourceType ? image.sourceType : 'generated';
}
export function exportImageExclusion(image, { includeMockImages = true, includeRealSamples = false } = {}) {
  const sourceType = exportImageSourceType(image);
  if (!includeMockImages && ['mock', 'fallbackMock'].includes(sourceType)) return 'IMAGE_EXCLUDED_MOCK';
  if (!includeRealSamples && (sourceType === 'realSample' || image?.isRealSample === true || image?.sourceType === 'realSample')) return 'IMAGE_EXCLUDED_REAL_SAMPLE';
  return null;
}
export function latestImagesForExportTarget(task, target) {
  const images = new Map();
  for (const image of array(task.generatedImages)) {
    if (image.status && !['succeeded', 'success', 'completed'].includes(image.status)) continue;
    if (!imageBelongsToExportTarget(task, image, target)) continue;
    const key = exportImageType(image), previous = images.get(key);
    const version = Number(image.version) || 1, oldVersion = Number(previous?.version) || 1;
    if (!previous || version >= oldVersion) images.set(key, image);
  }
  return images;
}
export function latestExportImages(task = {}) {
  const images = new Map();
  array(task.generatedImages).forEach((image,index) => {
    if (image.status && !['succeeded','success','completed'].includes(image.status)) return;
    const target = resolveExportImageTarget(task,image).target;
    const key = JSON.stringify([target?.id || 'unassigned', image.planId || image.id || `${exportImageType(image)}:${image.filePath || image.fileName || index}`]);
    const current=images.get(key);
    if(!current || (Number(image.version)||1) >= (Number(current.version)||1))images.set(key,image);
  });
  return [...images.values()];
}

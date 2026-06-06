import { nanoid } from 'nanoid';
import { getPlatformRuleSnapshot, normalizePlatformId } from '../rules/platformRules.js';
import { categoryRuleSnapshotForImage, detectCategoryFromProductInfo } from '../rules/categoryRuleUtils.js';

function asArray(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

export function normalizeTargetInput(input = {}, { productInfo = {}, index = 0 } = {}) {
  const platformId = normalizePlatformId(input.platformId || input.platform || 'amazon');
  const categoryId = input.categoryId || input.category || detectCategoryFromProductInfo(productInfo);
  const rulesSnapshot = getPlatformRuleSnapshot({
    platformId,
    platform: input.platform,
    site: input.site,
    language: input.language || 'English',
    category: categoryId
  });
  const categoryRuleSnapshot = categoryRuleSnapshotForImage({
    categoryId,
    imageType: input.imageType,
    productInfoConfirmed: productInfo
  });
  return {
    id: input.id || input.targetId || `target-${rulesSnapshot.platformId}-${index + 1}-${nanoid(4)}`,
    targetId: input.targetId || input.id || undefined,
    platformId: rulesSnapshot.platformId,
    platformName: rulesSnapshot.platformName || rulesSnapshot.name,
    site: rulesSnapshot.site,
    language: rulesSnapshot.language,
    categoryId,
    category: categoryId,
    rulesSnapshot,
    platformRuleSnapshot: rulesSnapshot,
    categoryRuleSnapshot
  };
}

export function normalizeTargets(inputs = [], { productInfo = {}, fallbackTask = {} } = {}) {
  const rawTargets = asArray(inputs).length
    ? asArray(inputs)
    : [{
        id: fallbackTask.targets?.[0]?.id,
        platformId: fallbackTask.platformId || fallbackTask.platform || fallbackTask.targets?.[0]?.platformId || 'amazon',
        platform: fallbackTask.platform,
        site: fallbackTask.site,
        language: fallbackTask.language || 'English',
        categoryId: fallbackTask.categoryId,
        category: fallbackTask.category || productInfo.category
      }];
  return rawTargets.map((target, index) => {
    const normalized = normalizeTargetInput(target, { productInfo, index });
    return {
      ...normalized,
      targetId: normalized.targetId || normalized.id
    };
  });
}

export function targetForPlan(task = {}, plan = {}) {
  const productInfo = task.productInfoConfirmed || task.productInfo || {};
  const targets = normalizeTargets(task.targets || [], { productInfo, fallbackTask: task });
  return targets.find((target) => target.id === plan.targetId || target.targetId === plan.targetId) || targets[0];
}

export function targetSlug(target = {}) {
  return [
    target.platformId || 'marketplace',
    target.site || 'US',
    target.language || 'English'
  ].map((part) => String(part).replace(/[^A-Za-z0-9_-]+/g, '-')).join('-');
}


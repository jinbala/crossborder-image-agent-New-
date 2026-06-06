import { platformRuleRegistry, normalizePlatformId, RULE_VERSION } from './platformRules.js';

const secondaryFallback = 'feature_image';

function platformFor(platformId) {
  const normalized = normalizePlatformId(platformId || 'marketplace');
  return platformRuleRegistry[normalized] || platformRuleRegistry.marketplace;
}

export function normalizeImageType(imageType = secondaryFallback) {
  return imageType || secondaryFallback;
}

export function getPlatformRule({ platformId, site, imageType = secondaryFallback } = {}) {
  const platform = platformFor(platformId);
  const normalizedType = normalizeImageType(imageType);
  const rule = platform.imageTypes?.[normalizedType] || platform.imageTypes?.[secondaryFallback] || platformRuleRegistry.marketplace.imageTypes[secondaryFallback];
  return {
    platformId: platform.platformId,
    platformName: platform.platformName || platform.name,
    site: site || platform.sites?.[0],
    imageType: normalizedType,
    rule,
    platform,
    ruleVersion: platform.ruleVersion || RULE_VERSION
  };
}

export function getImageTypeRule({ platformId, imageType } = {}) {
  return getPlatformRule({ platformId, imageType }).rule;
}

export function getForbiddenElements({ platformId, imageType } = {}) {
  const { platform, rule } = getPlatformRule({ platformId, imageType });
  return [...new Set([...(platform.globalForbidden || []), ...(rule.forbiddenElements || rule.bannedElements || [])])];
}

export function getLanguageRule({ platformId, language } = {}) {
  const platform = platformFor(platformId);
  return {
    language: language || platform.defaultLanguage,
    ...(platform.languageRules || {})
  };
}

export function isTextAllowed({ platformId, imageType } = {}) {
  const rule = getImageTypeRule({ platformId, imageType });
  return Boolean(rule.text?.allowed ?? rule.textAllowed);
}

export function getRuleSeverity({ platformId, imageType, issueType } = {}) {
  const rule = getImageTypeRule({ platformId, imageType });
  return rule.severity?.[issueType] || rule.severity?.[String(issueType || '').replace(/_([a-z])/g, (_, char) => char.toUpperCase())] || 'medium';
}

export function platformRuleSnapshotForImage({ platformId, site, imageType, language } = {}) {
  const { platform, rule, ruleVersion, platformName } = getPlatformRule({ platformId, site, imageType });
  return {
    platformId: platform.platformId,
    platformName,
    site: site || platform.sites?.[0],
    imageType,
    language: language || platform.defaultLanguage,
    textAllowed: Boolean(rule.text?.allowed ?? rule.textAllowed),
    backgroundRule: rule.background || null,
    forbiddenElements: getForbiddenElements({ platformId, imageType }),
    severity: rule.severity || {},
    ruleVersion,
    notes: rule.notes || ''
  };
}

export function summarizePlatformRulesForPrompt({ platformId, imageType, language } = {}) {
  const snapshot = platformRuleSnapshotForImage({ platformId, imageType, language });
  return [
    `Platform: ${snapshot.platformName}`,
    `Image type: ${snapshot.imageType}`,
    `Target language: ${snapshot.language}`,
    `Text allowed: ${snapshot.textAllowed ? 'yes' : 'no'}`,
    `Background: ${snapshot.backgroundRule?.recommended || snapshot.backgroundRule || 'clean'}`,
    `Forbidden elements: ${snapshot.forbiddenElements.join(', ')}`,
    `Severity: ${Object.entries(snapshot.severity || {}).map(([key, value]) => `${key}=${value}`).join(', ')}`,
    `Rule version: ${snapshot.ruleVersion}`
  ].join('\n');
}

const FIELD_LABELS = {
  capacity: '容量',
  dimensions: '尺寸',
  interfaceType: '接口类型',
  certifications: '认证',
  warranty: '保修',
  material: '材质',
  model: '型号',
  brand: '品牌',
  packageIncluded: '包装清单',
  compatibleDevices: '兼容设备',
  speed: '速度',
  waterproof: '防水',
  shockproof: '防摔',
  medicalClaims: '医疗声明'
};

export function sanitizeRulesDisplay(value) {
  if (Array.isArray(value)) return value.map(sanitizeRulesDisplay);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeRulesDisplay(item)]));
  }
  if (typeof value !== 'string') return value;
  return value
    .replace(/\b[A-Z0-9_]*API[_-]?KEY\b\s*[:=]\s*[^\s"',，。；;]+/gi, '[已隐藏密钥]')
    .replace(/\b(?:sk|rk|ak)-[A-Za-z0-9_-]{6,}\b/g, '[已隐藏密钥]')
    .replace(/[A-Z]:\\[^\s"',，。；;]+/gi, '[已隐藏本地路径]')
    .replace(/\.env(?:\.[\w.-]+)?/gi, '[已隐藏环境文件]')
    .replace(/\b[\w.-]*\.sqlite\b/gi, '[已隐藏数据库文件]')
    .replace(/\bnode_modules\b/gi, '[已隐藏依赖目录]');
}

export function fieldDisplayName(field) {
  return FIELD_LABELS[field] || field;
}

export function ruleListText(items = []) {
  const safeItems = Array.isArray(items) ? items.filter(Boolean) : [];
  return safeItems.length ? safeItems.join('、') : '暂无';
}

export function platformRulesEmptyText() {
  return '暂无该平台或类目的规则配置，请检查平台和类目选择。';
}

function mainImageSummary(rules = {}) {
  const parts = [];
  if (rules.background === 'pure_white') parts.push('白底');
  else if (rules.background) parts.push(`背景：${rules.background}`);
  if (rules.textAllowed === false) parts.push('无文字');
  if (rules.iconsAllowed === false) parts.push('无 icon');
  if (rules.priceAllowed === false) parts.push('不允许价格');
  if (rules.promotionAllowed === false) parts.push('不允许促销');
  if (rules.productCentered) parts.push('产品居中');
  return parts.length ? parts.join('，') : '暂无主图规则摘要';
}

function secondaryImageSummary(rules = {}) {
  const parts = [];
  if (rules.textAllowed) parts.push('允许英文卖点');
  if (rules.chineseAllowed === false) parts.push('不允许中文');
  if (rules.priceAllowed === false) parts.push('不允许价格');
  if (rules.promotionAllowed === false) parts.push('不允许促销');
  if (rules.unconfirmedCertificationAllowed === false) parts.push('未确认认证不可写入文案');
  if (rules.unconfirmedWarrantyAllowed === false) parts.push('未确认保修不可写入文案');
  if (rules.unconfirmedCapacityAllowed === false) parts.push('未确认容量不可写入文案');
  if (rules.unconfirmedSpeedAllowed === false) parts.push('未确认速度不可写入文案');
  if (rules.absoluteClaimsAllowed === false) parts.push('不允许绝对化词');
  return parts.length ? parts.join('，') : '暂无辅图规则摘要';
}

export function buildRulesSummary(effectiveRules) {
  if (!effectiveRules) {
    return {
      emptyText: platformRulesEmptyText(),
      platformText: '',
      categoryText: '',
      mainImageText: '',
      secondaryImageText: '',
      highRiskFields: [],
      bannedWords: [],
      cautionWords: [],
      recommendations: []
    };
  }

  const safeRules = sanitizeRulesDisplay(effectiveRules);
  const highRiskFields = (safeRules.effectiveHighRiskFields || []).map((field) => `${fieldDisplayName(field)} ${field}`);

  return {
    emptyText: '',
    platformText: safeRules.platformName || safeRules.platformId || '未知平台',
    categoryText: safeRules.categoryName || safeRules.categoryId || '未知类目',
    mainImageText: mainImageSummary(safeRules.effectiveMainImageRules),
    secondaryImageText: secondaryImageSummary(safeRules.effectiveSecondaryImageRules),
    highRiskFields,
    bannedWords: safeRules.effectiveBannedWords || [],
    cautionWords: safeRules.effectiveCautionWords || [],
    recommendations: safeRules.recommendations || []
  };
}

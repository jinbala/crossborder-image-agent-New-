const riskOrder = { low: 1, medium: 2, high: 3 };

function normalizeRiskLevel(value, fallback = 'low') {
  const normalized = String(value || '').toLowerCase();
  return riskOrder[normalized] ? normalized : fallback;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === '') return [];
  return [value];
}

function normalizeIssue(issue, index) {
  if (typeof issue === 'string') {
    return {
      type: 'general',
      category: 'visual',
      level: 'medium',
      message: issue,
      evidence: [],
      imageArea: '',
    ruleId: '',
    platformId: '',
    imageType: '',
    categoryId: '',
    fixSuggestion: ''
    };
  }
  return {
    type: String(issue?.type || `issue_${index + 1}`),
    category: String(issue?.category || 'visual'),
    level: normalizeRiskLevel(issue?.level, 'medium'),
    message: String(issue?.message || issue?.type || 'Review issue'),
    evidence: asArray(issue?.evidence).map((item) => String(item)),
    imageArea: String(issue?.imageArea || ''),
    ruleId: String(issue?.ruleId || ''),
    platformId: String(issue?.platformId || ''),
    imageType: String(issue?.imageType || ''),
    categoryId: String(issue?.categoryId || ''),
    fixSuggestion: String(issue?.fixSuggestion || '')
  };
}

export function normalizeReviewResult(parsed = {}) {
  const issues = asArray(parsed.issues).map(normalizeIssue);
  const riskLevel = normalizeRiskLevel(parsed.riskLevel, issues.some((issue) => issue.level === 'high') ? 'high' : issues.length ? 'medium' : 'low');
  const pass = typeof parsed.pass === 'boolean' ? parsed.pass : issues.length === 0 && riskLevel === 'low';
  return {
    pass,
    status: pass ? 'passed' : 'failed',
    riskLevel,
    issues,
    fixSuggestions: asArray(parsed.fixSuggestions).map((item) => String(item)),
    platformChecks: {
      mainImageTextAllowed: parsed.platformChecks?.mainImageTextAllowed ?? null,
      backgroundValid: parsed.platformChecks?.backgroundValid ?? null,
      watermarkDetected: parsed.platformChecks?.watermarkDetected ?? null,
      ...(parsed.platformChecks || {})
    },
    visualChecks: {
      productVisible: parsed.visualChecks?.productVisible ?? null,
      productDistortedRisk: parsed.visualChecks?.productDistortedRisk || 'unknown',
      backgroundRisk: parsed.visualChecks?.backgroundRisk || 'unknown',
      ...(parsed.visualChecks || {})
    },
    textChecks: {
      hasChinese: Boolean(parsed.textChecks?.hasChinese),
      hasPrice: Boolean(parsed.textChecks?.hasPrice),
      hasPromotion: Boolean(parsed.textChecks?.hasPromotion),
      hasUnconfirmedSpecs: Boolean(parsed.textChecks?.hasUnconfirmedSpecs),
      ...(parsed.textChecks || {})
    },
    sourceChecks: {
      isMockPreview: Boolean(parsed.sourceChecks?.isMockPreview),
      isRealGenerated: Boolean(parsed.sourceChecks?.isRealGenerated),
      fallbackToMock: Boolean(parsed.sourceChecks?.fallbackToMock),
      ...(parsed.sourceChecks || {})
    },
    evidenceChecks: {
      unconfirmedCapacityUsed: Boolean(parsed.evidenceChecks?.unconfirmedCapacityUsed),
      unconfirmedCertificationUsed: Boolean(parsed.evidenceChecks?.unconfirmedCertificationUsed),
      ...(parsed.evidenceChecks || {})
    },
    notes: asArray(parsed.notes).map((item) => String(item)).slice(0, 12)
  };
}

export function maxRiskLevel(...levels) {
  return levels.map((item) => normalizeRiskLevel(item)).sort((a, b) => riskOrder[b] - riskOrder[a])[0] || 'low';
}

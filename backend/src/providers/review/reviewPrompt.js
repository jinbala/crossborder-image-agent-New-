import {
  getForbiddenElements,
  platformRuleSnapshotForImage,
  summarizePlatformRulesForPrompt
} from '../../rules/platformRuleUtils.js';
import {
  categoryRuleSnapshotForImage,
  summarizeCategoryRulesForPrompt
} from '../../rules/categoryRuleUtils.js';
import { runRuleBasedReviewChecks } from './ruleBasedReview.js';

export const REVIEW_PROMPT_VERSION = 'review-v3.1';

function resolvePlatformId({ task = {}, plan = {}, generationRequest = null } = {}) {
  return plan.platformId ||
    plan.platform ||
    task.targets?.[0]?.platformId ||
    task.platformId ||
    task.platform ||
    generationRequest?.platform;
}

export function buildReviewPrompt({ task = {}, image = {}, plan = {}, generationRequest = null } = {}) {
  const imageType = image.type || plan.type || generationRequest?.imageType;
  const platformId = resolvePlatformId({ task, plan, generationRequest });
  const language = plan.language || task.targets?.[0]?.language || task.language || generationRequest?.language || 'English';
  const platformRuleSnapshot = platformRuleSnapshotForImage({
    platformId,
    site: plan.site || task.targets?.[0]?.site || task.site || generationRequest?.site,
    imageType,
    language
  });
  const categoryRuleSnapshot = generationRequest?.categoryRuleSnapshot || generationRequest?.compliance?.categoryRuleSnapshot || categoryRuleSnapshotForImage({
    categoryId: task.categoryId || task.targets?.[0]?.categoryId || task.targets?.[0]?.category,
    imageType,
    productInfoConfirmed: task.productInfoConfirmed || task.productInfo || {}
  });
  const platformRuleSummary = summarizePlatformRulesForPrompt({ platformId, imageType, language });
  const categoryRuleSummary = summarizeCategoryRulesForPrompt({
    categoryId: categoryRuleSnapshot.categoryId,
    productInfoConfirmed: task.productInfoConfirmed || task.productInfo || {},
    imageType
  });
  const forbiddenElements = getForbiddenElements({ platformId, imageType });
  const preliminaryRuleReview = runRuleBasedReviewChecks({
    task,
    image,
    plan,
    generationRequest
  });
  const context = {
    imageType,
    platform: platformRuleSnapshot.platformName || plan.platform || task.platform,
    platformRuleSnapshot,
    platformRuleSummary,
    categoryRuleSnapshot,
    categoryRuleSummary,
    forbiddenElements,
    preliminaryRuleBasedIssues: (preliminaryRuleReview.issues || []).slice(0, 12),
    productInfoConfirmed: task.productInfoConfirmed || task.productInfo || {},
    fieldEvidence: task.fieldEvidence || {},
    inferredCandidates: task.inferredCandidates || [],
    generationRequestSummary: image.generationRequestSummary || plan.generationRequestSummary || generationRequest,
    imageSource: {
      isMockPreview: Boolean(image.isMockPreview),
      isRealGenerated: Boolean(image.isRealGenerated),
      fallbackToMock: Boolean(image.fallbackToMock),
      realGenerationMode: image.realGenerationMode,
      provider: image.provider,
      model: image.model
    },
    textLayout: image.textLayout || plan.textLayout || null,
    preserveQuality: image.preserveQuality || null
  };

  return `You are a professional cross-border ecommerce image compliance reviewer.

Review the provided generated product image and context. This is an auxiliary risk check only, not official Amazon, Temu, Noon, Rakuten, or Ozon approval.

Return strict JSON only. Do not use Markdown. Do not include explanations outside JSON.

Check:
1. visible Chinese text, price, discount, promotion, watermark, seller logo, fake certification, exaggerated claim, Best Seller or No.1 claims.
2. main image risks: visible text, non-white background for Amazon/Noon, scene background, promotional elements, non-product props.
3. product information risks: unconfirmed capacity, certification, warranty, waterproof rating, medical/health claims, or inferred candidate values.
4. source risks: mock preview, fallback mock, text-to-image product fidelity risk, image edit distortion risk, subject composite edge risk.
5. text layout risks: blocking issues, warnings, too much text, small text, overflow risk.

For electronics storage products, do not accept capacity, speed, waterproof, shockproof, warranty, certifications, or universal compatibility claims unless supported by visible evidence or confirmed product information. Report unsupported electronic product claims as category risks.

Platform rule summary:
${platformRuleSummary}

Category rule summary:
${categoryRuleSummary}

forbiddenElements:
${JSON.stringify(forbiddenElements)}

Preliminary rule-based issues:
${JSON.stringify(context.preliminaryRuleBasedIssues, null, 2)}

Required JSON schema:
{
  "pass": false,
  "riskLevel": "low | medium | high",
  "issues": [
    {
      "type": "",
      "level": "low | medium | high",
      "message": "",
      "evidence": [],
      "imageArea": ""
    }
  ],
  "fixSuggestions": [],
  "platformChecks": {
    "mainImageTextAllowed": true,
    "backgroundValid": true,
    "watermarkDetected": false
  },
  "visualChecks": {
    "productVisible": true,
    "productDistortedRisk": "low | medium | high | unknown",
    "backgroundRisk": "low | medium | high | unknown"
  },
  "textChecks": {
    "hasChinese": false,
    "hasPrice": false,
    "hasPromotion": false,
    "hasUnconfirmedSpecs": false
  },
  "sourceChecks": {
    "isMockPreview": false,
    "isRealGenerated": true,
    "fallbackToMock": false
  },
  "evidenceChecks": {
    "unconfirmedCapacityUsed": false,
    "unconfirmedCertificationUsed": false
  },
  "notes": []
}

Context JSON:
${JSON.stringify(context, null, 2)}`;
}

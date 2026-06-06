import { createImagePlans } from '../prompts/imagePromptFactory.js';
import { buildGenerationRequest, generationRequestSummary } from './generationRequestService.js';
import { buildTextLayout } from './textLayoutService.js';
import { normalizeTargets } from './targetService.js';

export function generateImagePlans(task) {
  const productInfo = task.productInfoConfirmed;
  if (!productInfo) {
    const error = new Error('Confirmed product info is required before generating image plans');
    error.statusCode = 400;
    throw error;
  }
  const targets = normalizeTargets(task.targets || [], { productInfo, fallbackTask: task });
  if (!targets.length || !targets[0]?.rulesSnapshot) {
    const error = new Error('Platform target and rules are required before generating image plans');
    error.statusCode = 400;
    throw error;
  }
  const plans = targets.flatMap((target) => createImagePlans({
    productInfo,
    target,
    task: { ...task, targets },
    fieldEvidence: task.fieldEvidence || {},
    inferredCandidates: task.inferredCandidates || []
  }));
  return plans.map((plan) => {
    const generationRequest = buildGenerationRequest({ task: { ...task, targets, productInfoConfirmed: productInfo }, plan });
    const textLayout = buildTextLayout({ task: { ...task, targets, productInfoConfirmed: productInfo }, plan, generationRequest });
    return {
      ...plan,
      generationRequestSummary: generationRequestSummary(generationRequest),
      platformRuleSnapshot: generationRequest.compliance?.platformRulesSnapshot || plan.platformRuleSnapshot || null,
      categoryRuleSnapshot: generationRequest.categoryRuleSnapshot || null,
      blockingIssues: textLayout?.blockingIssues || [],
      textLayout
    };
  });
}

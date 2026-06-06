import { asArray, safeSegment } from './exportManifestService.js';
import { buildUploadPayloadPreview, sanitizeUploadPayloadValue } from './uploadPayloadService.js';

function timestampSafe(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function simulatedStatusFor(payload = {}) {
  if (payload.status === 'blocked') return 'blocked';
  if (payload.status === 'warning') return 'accepted_with_warnings';
  return 'accepted';
}

function simulatedResultFor(payload = {}, generatedAt = new Date()) {
  const simulatedStatus = simulatedStatusFor(payload);
  return sanitizeUploadPayloadValue({
    platformId: payload.platformId,
    sku: payload.sku,
    simulatedStatus,
    sandboxRequestId: `sandbox-${safeSegment(payload.platformId, 'platform')}-${timestampSafe(generatedAt)}-${safeSegment(payload.sku, 'SKU')}`,
    uploaded: false,
    realNetworkCalled: false,
    externalApiCalled: false,
    blockingIssues: asArray(payload.blockingIssues),
    warnings: asArray(payload.warnings),
    nextSuggestedAction: simulatedStatus === 'blocked'
      ? 'Resolve blocking issues before another sandbox simulation.'
      : 'Review payload details manually before any future real integration.'
  });
}

function summarize(results = []) {
  return {
    totalPayloads: results.length,
    accepted: results.filter((item) => item.simulatedStatus === 'accepted').length,
    acceptedWithWarnings: results.filter((item) => item.simulatedStatus === 'accepted_with_warnings').length,
    blocked: results.filter((item) => item.simulatedStatus === 'blocked').length,
    uploaded: false,
    realNetworkCalled: false,
    externalApiCalled: false
  };
}

export async function simulateSandboxSubmit(batchId, options = {}) {
  if (options.confirmSandboxSubmit !== true) {
    const error = new Error('confirmSandboxSubmit=true is required to simulate sandbox submit');
    error.statusCode = 400;
    throw error;
  }
  const generatedAt = new Date();
  const preview = await buildUploadPayloadPreview(batchId, {
    ...options,
    confirmDryRun: true
  });
  const simulatedResults = asArray(preview.skuPayloads).map((payload) => simulatedResultFor(payload, generatedAt));
  const blockedResults = simulatedResults.filter((item) => item.simulatedStatus === 'blocked');

  return sanitizeUploadPayloadValue({
    meta: {
      reportId: `upload-sandbox-report-${batchId}-${timestampSafe(generatedAt)}`,
      batchId,
      packageId: options.packageId || '',
      generatedAt: generatedAt.toISOString(),
      mode: 'sandboxSubmitSimulation',
      targetPlatforms: preview.meta?.targetPlatforms || [],
      realUploadEnabled: false,
      realNetworkCalled: false,
      externalApiCalled: false,
      uploaded: false
    },
    summary: summarize(simulatedResults),
    simulatedResults,
    blockedResults,
    warnings: asArray(preview.warnings),
    recommendations: [
      'Sandbox simulation did not call any platform API.',
      'Use blockedResults and warnings to prepare a later real integration checklist.'
    ],
    realNetworkCalled: false,
    externalApiCalled: false,
    uploaded: false
  });
}

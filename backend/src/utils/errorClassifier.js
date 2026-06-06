function textOf(error) {
  if (!error) return '';
  return [
    error.code,
    error.errorCode,
    error.status,
    error.statusCode,
    error.message,
    error.technicalMessage,
    error.payload?.code,
    error.payload?.message,
    error.response?.status,
    error.response?.data?.error?.code,
    error.response?.data?.error?.message,
    error.response?.data?.message
  ].filter(Boolean).join(' ').toLowerCase();
}

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

function baseInfo(error, context = {}) {
  const code = normalizeCode(error?.code || error?.payload?.code || error?.errorCode || context.errorCode || 'UNKNOWN_ERROR');
  return {
    errorCategory: 'unknown',
    errorCode: code,
    retryable: false,
    requiresUserAction: false,
    userActionType: null,
    message: error?.payload?.message || error?.message || '未知错误',
    technicalMessage: error?.stack || error?.technicalMessage || error?.message || '',
    provider: context.provider || error?.provider || null,
    action: context.action || null,
    skuId: context.skuId || null,
    taskId: context.taskId || null,
    timestamp: new Date().toISOString()
  };
}

export function classifyError(error, context = {}) {
  const info = baseInfo(error, context);
  const text = textOf(error);
  const status = Number(error?.statusCode || error?.status || error?.response?.status || 0);

  if (info.errorCode === 'JOB_TIMEOUT' || /timeout|timed out|socket hang up|econnreset|etimedout/.test(text)) {
    return {
      ...info,
      errorCategory: 'timeout',
      errorCode: info.errorCode === 'UNKNOWN_ERROR' ? 'JOB_TIMEOUT' : info.errorCode,
      retryable: true,
      userActionType: null,
      message: info.message || '处理超时，可稍后重试。'
    };
  }

  if (status === 429 || /429|rate limit|too many requests/.test(text)) {
    return {
      ...info,
      errorCategory: 'provider',
      errorCode: 'PROVIDER_RATE_LIMIT',
      retryable: true,
      userActionType: 'change_provider',
      message: 'Provider rate limit，建议降低并发或稍后重试。'
    };
  }

  if (/insufficient_quota|quota exceeded|billing|payment required/.test(text)) {
    return {
      ...info,
      errorCategory: 'config',
      errorCode: 'PROVIDER_QUOTA_EXCEEDED',
      retryable: false,
      requiresUserAction: true,
      userActionType: 'change_provider',
      message: 'Provider quota 或账单不可用，请检查额度或更换 provider。'
    };
  }

  if (info.errorCode === 'MISSING_API_KEY' || /missing_api_key|api key|apikey|missing key/.test(text)) {
    return {
      ...info,
      errorCategory: 'config',
      errorCode: 'MISSING_API_KEY',
      retryable: false,
      requiresUserAction: true,
      userActionType: 'provide_key',
      message: '缺少 API Key，请检查 .env 配置。'
    };
  }

  if (info.errorCode === 'PARSE_ERROR' || /parse_error|invalid_json|failed to parse|invalid json/.test(text)) {
    return {
      ...info,
      errorCategory: 'provider',
      errorCode: info.errorCode === 'UNKNOWN_ERROR' ? 'PARSE_ERROR' : info.errorCode,
      retryable: true,
      userActionType: null,
      message: '模型返回格式异常，可重试一次。'
    };
  }

  if (info.errorCode === 'INVALID_STATE' || /invalid_state|requires task status|status is|状态/.test(text)) {
    return {
      ...info,
      errorCategory: 'state',
      errorCode: 'INVALID_STATE',
      retryable: false,
      requiresUserAction: true,
      userActionType: context.action === 'plan' || context.action === 'generate' ? 'review_rules' : 'confirm_product_info',
      message: '任务状态不符合当前操作，请先完成前置流程。'
    };
  }

  if (/image_too_large|unsupported_format|no_images|no valid images|too_many_images/.test(text)) {
    return {
      ...info,
      errorCategory: 'input',
      errorCode: /unsupported/.test(text) ? 'UNSUPPORTED_FORMAT' : /no_images|no valid/.test(text) ? 'NO_IMAGES' : 'IMAGE_TOO_LARGE',
      retryable: false,
      requiresUserAction: true,
      userActionType: 'fix_images',
      message: '图片输入不符合要求，请修复图片后再试。'
    };
  }

  if (info.errorCode === 'SAFE_CHECK_FAILED' || /safe_check_failed|blockingissues|blocking issues|safeforrealgeneration/.test(text)) {
    return {
      ...info,
      errorCategory: 'validation',
      errorCode: 'SAFE_CHECK_FAILED',
      retryable: false,
      requiresUserAction: true,
      userActionType: 'review_rules',
      message: '安全检查未通过，请检查规则、字段证据或图片方案。'
    };
  }

  if (status >= 500 || /http_error|5\d\d|provider error/.test(text)) {
    return {
      ...info,
      errorCategory: 'network',
      errorCode: info.errorCode === 'UNKNOWN_ERROR' ? 'HTTP_ERROR' : info.errorCode,
      retryable: true,
      userActionType: null,
      message: 'Provider 或网络临时错误，可稍后重试。'
    };
  }

  return info;
}

export function isRetryableError(errorInfo) {
  return Boolean(errorInfo?.retryable);
}

export function getUserActionSuggestion(errorInfo = {}) {
  const map = {
    provide_key: '请检查 .env 中的 API Key 配置。',
    confirm_product_info: '请先完成商品信息人工确认。',
    fix_images: '请更换、压缩或补充商品图片。',
    change_provider: '建议降低并发、稍后重试或更换 provider。',
    review_rules: '请检查平台规则、类目规则、字段证据或图片方案。',
    manual_check: '请人工检查该 SKU 的任务状态和错误信息。'
  };
  return map[errorInfo.userActionType] || (errorInfo.retryable ? '该错误可重试。' : '该错误不建议自动重试。');
}

import { computeBatchAnalytics } from './batchAnalyticsService.js';
import { getBatchGuideState, getNextPendingConfirmSku } from '../../../frontend/src/utils/batchWorkflowGuide.js';

const SOP_VERSION = 'v4.2';

function nowIso() {
  return new Date().toISOString();
}

function asList(items = []) {
  return items.filter(Boolean);
}

function providerUsageText(providers = {}) {
  return Object.entries(providers)
    .map(([provider, data]) => `${provider}: ${data.calls || 0}`)
    .join(', ') || '无记录';
}

function section(title, content, { checklist = [], warnings = [], tips = [] } = {}) {
  return { title, content, checklist, warnings, tips };
}

function formatTargets(targets = []) {
  if (!targets.length) return '暂无平台 targets。';
  return targets.map((target) => `- ${target.platformId || target.platformName || 'platform'} / ${target.site || 'US'} / ${target.language || 'English'} / ${target.categoryId || target.category || 'general'}`).join('\n');
}

function sanitizeMarkdown(markdown = '') {
  return String(markdown)
    .replace(/(API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*[^\s\n]+/gi, '$1=<redacted>')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-<redacted>');
}

export function generateGeneralSop() {
  return {
    sopVersion: SOP_VERSION,
    type: 'general',
    title: 'CrossBorder Image Agent 通用 SOP',
    generatedAt: nowIso(),
    sections: [
      section('项目用途', '用于跨境电商商品图片的识别、确认、方案生成、mock/真实场景图生成、规则审核和多平台导出。'),
      section('启动和关闭小程序', 'Windows 本地可双击启动脚本打开前后端服务，也可以分别在 backend/frontend 目录运行 npm 命令。'),
      section('.env 配置说明', 'Provider、模型、导入扫描目录、成本估算等均通过 .env 配置。SOP 不会导出 .env 或任何 API Key。'),
      section('单 SKU 流程', '上传 1-15 张商品图，识别商品信息，人工确认 productInfoConfirmed，选择平台，生成方案，生成图片，审核，导出。'),
      section('批量 SKU 流程', '按文件夹导入多个 SKU，每个 SKU 仍然是独立 task，批量任务只做编排、队列、统计和导出。'),
      section('扫描导入目录', '配置 IMPORT_ROOT_DIR 后，可扫描安全目录下的 SKU 子文件夹。扫描只发现和导入，不自动调用真实 AI。'),
      section('工作流模板使用', '模板用于填充默认平台、Provider、识别模式、并发、重试和导出策略。模板不保存 API Key，也不自动启动队列。'),
      section('批量识别', '使用 Vision Provider 识别每个 SKU。真实识别可能产生费用，建议先小批量验证。'),
      section('人工确认商品信息', 'AI 识别结果不是最终商品信息，必须由运营人工确认后写入 productInfoConfirmed。'),
      section('多平台 targets', '可为同一 SKU 设置 Amazon、Temu、Noon、Ozon、Rakuten 等多个平台目标，每个平台使用独立规则快照。'),
      section('生成图片方案', '系统根据 productInfoConfirmed、平台规则、类目规则和字段证据生成图片方案。'),
      section('图片生成方式说明', 'mock 用于流程预览；OpenAI real 当前主要用于 lifestyle_image；subject_composite 使用原商品主体 + AI 背景 + 程序合成；textLayout 用程序排版文字图。'),
      section('轻量画布编辑器使用', 'feature/size/compatibility/package/variant 图可用轻量排版编辑器调整文字、图标、线条位置和显隐。'),
      section('审核说明', 'mock review 用于流程测试；real review 是辅助风险检查；平台规则和类目规则不能替代官方最终审核。'),
      section('导出 ZIP 结构', '批量导出会按 SKU / 平台目录生成 images、metadata.json、prompts.json、review-report.json、manifest.json 和 batch-master-metadata.json。'),
      section('批量队列和失败重试', '队列支持并发、暂停、恢复、取消、失败分类和可控重试。默认不自动重试，避免真实 AI 成本失控。'),
      section('成本统计说明', '成本为本地估算，不代表真实账单。可通过 COST_* 环境变量配置每次调用的预估成本。'),
      section('常见错误处理', '缺 API Key：检查 .env；timeout/socket hang up：降低并发或重试；图片太大：压缩或减少图片；状态不匹配：按向导完成前置步骤；provider 限流：稍后重试或降低并发。'),
      section('安全提醒', '不要上传 .env，不要提交 API Key，真实 AI 会产生费用，导出结果仍需人工复核后再上传平台。'),
      section('推荐日常操作流程', '扫描导入 → 选择模板 → 批量识别 → 人工确认 → 应用平台 → 生成方案 → 生成图片 → 审核 → 导出。')
    ],
    batchContext: null
  };
}

export function generateBatchNextActionChecklist(batchTask = {}, guideState = getBatchGuideState(batchTask)) {
  const counts = guideState.counts || {};
  const checklist = [];
  const currentStep = guideState.currentStepId;
  if (currentStep === 'import') checklist.push('扫描导入目录或手动导入 SKU 文件夹');
  if (currentStep === 'template') checklist.push('选择并应用一个工作流模板');
  if (currentStep === 'recognize') checklist.push('启动批量识别队列');
  if (currentStep === 'confirm') checklist.push('打开下一个待确认 SKU');
  if (currentStep === 'targets') checklist.push('应用 Amazon / Temu / Noon 等平台 targets');
  if (currentStep === 'plan') checklist.push('启动生成图片方案队列');
  if (currentStep === 'generate') checklist.push('启动生成图片预览队列');
  if (currentStep === 'review') checklist.push('启动图片审核队列');
  if (currentStep === 'export') checklist.push('导出批量 ZIP 图片包');
  if (counts.retryable > 0) checklist.push(`重试 ${counts.retryable} 个可重试失败`);
  if (counts.requiresUserAction > 0) checklist.push(`人工处理 ${counts.requiresUserAction} 个需要用户操作的问题`);
  return checklist.map((item) => `[ ] ${item}`);
}

export function generateBatchSop(batchTask = {}) {
  const guideState = getBatchGuideState(batchTask);
  const analytics = batchTask.analytics || {};
  const pendingConfirm = (batchTask.skuTasks || []).filter((sku) => sku.taskId && (sku.status === 'recognized' || sku.currentStep === 'waiting_confirm'));
  const failed = (batchTask.skuTasks || []).filter((sku) => sku.status === 'failed' || sku.queueStatus === 'failed');
  const retryable = failed.filter((sku) => sku.retryable);
  const userAction = failed.filter((sku) => sku.requiresUserAction);
  const currentStep = guideState.steps.find((step) => step.id === guideState.currentStepId);
  const checklist = generateBatchNextActionChecklist(batchTask, guideState);
  return {
    sopVersion: SOP_VERSION,
    type: 'batch',
    title: `Batch SOP - ${batchTask.name || batchTask.id || 'Untitled Batch'}`,
    generatedAt: nowIso(),
    batchContext: {
      batchId: batchTask.id,
      batchName: batchTask.name,
      currentStep: guideState.currentStepId,
      currentStepTitle: currentStep?.title,
      skuSummary: batchTask.summary || analytics.sku || {},
      queueStatus: batchTask.queue || {},
      failureSummary: analytics.failureSummary || {},
      analyticsSummary: {
        estimatedCost: analytics.cost?.estimatedTotal || 0,
        currency: analytics.cost?.currency || 'USD',
        highRiskCount: analytics.review?.highRiskCount || 0,
        providerUsage: analytics.providers || {}
      }
    },
    sections: [
      section('Batch 基本信息', `Batch ID：${batchTask.id || '-'}\nBatch 名称：${batchTask.name || '-'}\n状态：${batchTask.status || '-'}\n当前推荐步骤：${currentStep?.title || guideState.currentStepId}`),
      section('当前阻塞原因', currentStep?.blockingReasons?.length ? currentStep.blockingReasons.join('\n') : '暂无阻塞原因。', { warnings: guideState.warnings.map((warning) => warning.message) }),
      section('SKU 状态列表', (batchTask.skuTasks || []).map((sku) => `- ${sku.skuId}: ${sku.status || '-'} / ${sku.currentStep || '-'}${sku.error ? ` / ${sku.error.code || ''} ${sku.error.message || ''}` : ''}`).join('\n') || '暂无 SKU。'),
      section('待确认 SKU 列表', pendingConfirm.map((sku) => `- ${sku.skuId} (${sku.taskId})`).join('\n') || '暂无待确认 SKU。'),
      section('失败 SKU 列表', failed.map((sku) => `- ${sku.skuId}: ${sku.lastErrorCode || sku.error?.code || 'UNKNOWN'} / ${sku.lastErrorCategory || 'unknown'} / ${sku.error?.message || ''}`).join('\n') || '暂无失败 SKU。'),
      section('可重试失败列表', retryable.map((sku) => `- ${sku.skuId}: ${sku.lastErrorCode || sku.error?.code || 'UNKNOWN'}`).join('\n') || '暂无可重试失败。'),
      section('需要人工处理列表', userAction.map((sku) => `- ${sku.skuId}: ${sku.lastUserActionType || 'manual_check'} / ${sku.lastErrorCode || sku.error?.code || 'UNKNOWN'}`).join('\n') || '暂无需要人工处理的问题。'),
      section('当前平台 targets', formatTargets(batchTask.defaultTargets || batchTask.workflowTemplateSnapshot?.defaultTargets || [])),
      section('当前工作流模板', batchTask.workflowTemplateSnapshot ? `${batchTask.workflowTemplateSnapshot.name} (${batchTask.workflowTemplateSnapshot.id})` : '未应用工作流模板。'),
      section('队列状态', `状态：${batchTask.queue?.status || 'idle'}\nAction：${batchTask.queue?.action || '-'}\n并发：${batchTask.queue?.concurrency || '-'}`),
      section('Provider 使用情况', `Vision：${providerUsageText(analytics.providers?.vision)}\nImage：${providerUsageText(analytics.providers?.image)}\nReview：${providerUsageText(analytics.providers?.review)}\nMatting：${providerUsageText(analytics.providers?.matting)}`),
      section('成本预估', `${analytics.cost?.currency || 'USD'} ${Number(analytics.cost?.estimatedTotal || 0).toFixed(4)}（本地估算，不代表真实账单）`),
      section('审核风险摘要', `High：${analytics.review?.highRiskCount || 0}\nMedium：${analytics.review?.mediumRiskCount || 0}\nLow：${analytics.review?.lowRiskCount || 0}`),
      section('下一步操作清单', '按下方 checklist 逐项处理。', { checklist })
    ]
  };
}

export async function generateBatchSopWithAnalytics(batchTask = {}) {
  const analytics = batchTask.analytics || await computeBatchAnalytics(batchTask);
  return generateBatchSop({ ...batchTask, analytics });
}

export function renderSopMarkdown(sopData = {}) {
  const lines = [
    `# ${sopData.title || 'SOP'}`,
    '',
    `- SOP 版本：${sopData.sopVersion || SOP_VERSION}`,
    `- 类型：${sopData.type || '-'}`,
    `- 生成时间：${sopData.generatedAt || nowIso()}`,
    ''
  ];
  if (sopData.batchContext) {
    lines.push('## Batch Context', '');
    lines.push(`- Batch ID：${sopData.batchContext.batchId || '-'}`);
    lines.push(`- 当前步骤：${sopData.batchContext.currentStepTitle || sopData.batchContext.currentStep || '-'}`);
    lines.push(`- 队列状态：${sopData.batchContext.queueStatus?.status || 'idle'}`);
    lines.push('');
  }
  for (const item of sopData.sections || []) {
    lines.push(`## ${item.title}`, '');
    if (item.content) lines.push(item.content, '');
    if (item.checklist?.length) {
      lines.push('### Checklist', '');
      lines.push(...item.checklist);
      lines.push('');
    }
    if (item.warnings?.length) {
      lines.push('### Warnings', '');
      lines.push(...item.warnings.map((warning) => `- ${warning}`));
      lines.push('');
    }
    if (item.tips?.length) {
      lines.push('### Tips', '');
      lines.push(...item.tips.map((tip) => `- ${tip}`));
      lines.push('');
    }
  }
  return sanitizeMarkdown(lines.join('\n'));
}

export function sopFileName(sopData = {}) {
  if (sopData.type === 'batch') return `Batch-SOP-${sopData.batchContext?.batchId || 'batch'}.md`;
  return 'CrossBorder-Image-Agent-SOP.md';
}

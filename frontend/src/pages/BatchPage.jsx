import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Download, FolderOpen, Play, RefreshCw, Search } from 'lucide-react';
import Section from '../components/Section.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import { api } from '../services/api.js';
import { ErrorMessage, PrimaryButton } from './pageUtils.jsx';
import { getBatchGuideState, getNextPendingConfirmSku } from '../utils/batchWorkflowGuide.js';
import { buildScanSummaryMessage, getScanCandidateDisplay, hasScanCandidates } from '../utils/importScan.js';
import { downloadBatchReviewReportJson, getBatchReviewReportDisplayModel } from '../utils/batchReviewReport.js';
import { downloadBatchStabilityReportJson, getBatchStabilityDisplayModel } from '../utils/batchStability.js';
import { downloadSkuRetryResultJson, getSkuRetryDisplayModel } from '../utils/skuRetry.js';
import { downloadBatchResumePlanJson, getBatchResumePlanDisplayModel } from '../utils/batchResumePlan.js';
import {
  batchControlStateTransition,
  buildBatchListRowsForBatchPage,
  buildSkuRowsForBatchPage,
  resetImportActionMode,
  shouldApplyBatchScopedResponse,
  shouldShowResetImportStatusAction
} from '../utils/batchControlState.js';
import { getSkuDisplayQueueHint, getSkuDisplayQueueStatus } from '../utils/batchStatusDisplay.js';
import {
  buildExportPackageDownloadUrl,
  exportPackageConfirmText,
  getExportPackageDisplayModel,
  normalizeExportPackageOptions
} from '../utils/exportPackage.js';
import {
  buildListingCsvDownloadUrl,
  getListingExportDisplayModel,
  listingExportConfirmText,
  listingExportNotice,
  normalizeListingExportOptions
} from '../utils/listingExport.js';
import {
  downloadUploadReadinessJson,
  getUploadReadinessDisplayModel,
  loadUploadSandboxConfig,
  normalizeUploadReadinessOptions,
  saveUploadSandboxConfig,
  uploadSandboxNotice,
  uploadReadinessNotice
} from '../utils/uploadReadiness.js';
import {
  downloadUploadPayloadJson,
  downloadUploadSandboxJson,
  getUploadPayloadDisplayModel,
  getUploadSandboxDisplayModel,
  uploadPayloadNotice
} from '../utils/uploadPayload.js';
import {
  downloadUploadSafetyJson,
  getUploadSafetyDisplayModel,
  uploadSafetyNotice
} from '../utils/uploadSafety.js';

const categoryOptions = [
  ['electronics_storage', '电子产品 / 存储设备'],
  ['general', '通用商品'],
  ['electronics_general', '电子产品'],
  ['beauty', '美妆个护'],
  ['apparel', '服饰'],
  ['home', '家居'],
  ['tools', '工具'],
  ['pet', '宠物'],
  ['medical_device', '医疗器械']
];

const statusLabels = {
  created: '已创建',
  imported: '已导入',
  recognizing: '识别中',
  waiting_confirm: '待确认',
  planning: '方案生成中',
  generating: '生成中',
  reviewing: '审核中',
  exporting: '导出中',
  completed: '已完成',
  partial_failed: '部分失败',
  failed: '失败',
  idle: '空闲',
  running: '运行中',
  paused: '已暂停',
  cancelled: '已取消',
  skipped: '已跳过',
  pending: '等待中',
  uploaded: '已导入',
  recognized: '待确认',
  confirmed: '已确认',
  rules_selected: '已应用平台',
  planned: '待生成图片',
  generated: '待审核',
  reviewed: '已审核',
  exported: '已导出',
  new: 'new'
};

const batchControlConfirmText = '此操作只会清理小程序内的批量任务记录或导入状态，不会删除本地图片文件夹。确认继续吗？';

function guideStepStatusLabel(status) {
  if (status === 'done') return '已完成';
  if (status === 'current') return '当前步骤';
  if (status === 'blocked') return '被阻塞';
  if (status === 'available') return '可执行';
  return '待开始';
}

function nextTaskRoute(sku) {
  if (!sku.taskId) return '/';
  if (sku.status === 'uploaded') return `/tasks/${sku.taskId}/product`;
  if (sku.status === 'recognized') return `/tasks/${sku.taskId}/product`;
  if (sku.status === 'confirmed') return `/tasks/${sku.taskId}/rules`;
  if (sku.status === 'rules_selected') return `/tasks/${sku.taskId}/plans`;
  if (sku.status === 'planned') return `/tasks/${sku.taskId}/generate`;
  if (sku.status === 'generated') return `/tasks/${sku.taskId}/review`;
  return `/tasks/${sku.taskId}/export`;
}

function normalizeTargets(selectedIds, rules, targetDrafts) {
  return selectedIds
    .map((platformId) => {
      const platform = rules?.platforms?.find((item) => item.platformId === platformId);
      if (!platform) return null;
      const draft = targetDrafts[platformId] || {};
      return {
        platformId,
        site: draft.site || platform.sites?.[0] || 'US',
        language: draft.language || platform.languages?.[0] || 'English',
        categoryId: draft.categoryId || 'electronics_storage'
      };
    })
    .filter(Boolean);
}

function ResultList({ results }) {
  if (!results?.length) return null;
  return (
    <div className="mt-4 rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
      <div className="mb-2 font-semibold text-slate-800">最近一次批量操作结果</div>
      <div className="space-y-1">
        {results.map((item, index) => (
          <div key={`${item.skuId}-${item.action}-${index}`} className="flex flex-wrap gap-2">
            <span className="font-medium">{item.skuId}</span>
            <span>{item.action}</span>
            <span className={item.success ? 'text-emerald-700' : item.skipped ? 'text-amber-700' : 'text-red-700'}>
              {item.success ? '成功' : item.skipped ? '跳过' : '失败'}
            </span>
            <span>{item.message || item.error?.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatBytes(bytes = 0) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function scanStatusClass(status) {
  if (status === 'new') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (status === 'imported') return 'bg-slate-100 text-slate-600 border-slate-200';
  if (status === 'empty') return 'bg-amber-50 text-amber-700 border-amber-200';
  return 'bg-red-50 text-red-700 border-red-200';
}

function formatDuration(ms = 0) {
  if (!ms) return '0s';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}

function formatMoney(value = 0, currency = 'USD') {
  return `${currency} ${Number(value || 0).toFixed(4)}`;
}

function providerSummary(stats = {}) {
  return Object.entries(stats)
    .map(([provider, data]) => `${provider}: ${data.calls || 0}`)
    .join(' / ') || '-';
}

export default function BatchPage() {
  const { batchId } = useParams();
  const navigate = useNavigate();
  const scanResultRef = useRef(null);
  const batchRequestGenerationRef = useRef(0);
  const batchInvalidatedRef = useRef(false);
  const activeBatchIdRef = useRef(batchId || '');
  const [rules, setRules] = useState(null);
  const [batches, setBatches] = useState([]);
  const [batchTask, setBatchTask] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [batchReviewReport, setBatchReviewReport] = useState(null);
  const [batchStabilityReport, setBatchStabilityReport] = useState(null);
  const [batchResumePlan, setBatchResumePlan] = useState(null);
  const [skuRetryPlans, setSkuRetryPlans] = useState({});
  const [skuRetrySteps, setSkuRetrySteps] = useState({});
  const [skuRetryResults, setSkuRetryResults] = useState({});
  const [exportPackageOptions, setExportPackageOptions] = useState({
    platforms: ['amazon', 'temu'],
    includeReports: true,
    includeMockImages: true,
    includeRealSamples: false
  });
  const [exportPackagePreview, setExportPackagePreview] = useState(null);
  const [exportPackageResult, setExportPackageResult] = useState(null);
  const [listingExportOptions, setListingExportOptions] = useState({
    platforms: ['amazon', 'temu'],
    includeMockImages: true
  });
  const [listingExportPreview, setListingExportPreview] = useState(null);
  const [listingExportResult, setListingExportResult] = useState(null);
  const [listingExportError, setListingExportError] = useState('');
  const [uploadReadinessOptions, setUploadReadinessOptions] = useState({
    platforms: ['temu', 'miaoshou']
  });
  const [uploadReadinessReport, setUploadReadinessReport] = useState(null);
  const [uploadSandboxConfig, setUploadSandboxConfig] = useState(() => loadUploadSandboxConfig());
  const [uploadPayloadPreview, setUploadPayloadPreview] = useState(null);
  const [uploadSandboxReport, setUploadSandboxReport] = useState(null);
  const [uploadSafetyReport, setUploadSafetyReport] = useState(null);
  const [scanStatus, setScanStatus] = useState(null);
  const [scanResult, setScanResult] = useState(null);
  const [scanFeedback, setScanFeedback] = useState('');
  const [selectedScanFolders, setSelectedScanFolders] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [effectiveSettings, setEffectiveSettings] = useState(null);
  const [providerStatus, setProviderStatus] = useState(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [templateWarnings, setTemplateWarnings] = useState([]);
  const [folderPath, setFolderPath] = useState('');
  const [name, setName] = useState('');
  const [selectedPlatforms, setSelectedPlatforms] = useState(['amazon', 'temu']);
  const [targetDrafts, setTargetDrafts] = useState({});
  const [results, setResults] = useState([]);
  const [logs, setLogs] = useState([]);
  const [sopMarkdown, setSopMarkdown] = useState('');
  const [queueAction, setQueueAction] = useState('recognize');
  const [queueMode, setQueueMode] = useState('mock');
  const [queueConcurrency, setQueueConcurrency] = useState(2);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [batchControlFeedback, setBatchControlFeedback] = useState('');
  const [batchControlError, setBatchControlError] = useState('');

  const defaultTargets = useMemo(
    () => normalizeTargets(selectedPlatforms, rules, targetDrafts),
    [selectedPlatforms, rules, targetDrafts]
  );

  useEffect(() => {
    activeBatchIdRef.current = batchTask?.id || batchId || '';
  }, [batchTask?.id, batchId]);

  function bumpBatchRequestGeneration({ invalidated = false } = {}) {
    batchRequestGenerationRef.current += 1;
    batchInvalidatedRef.current = invalidated;
    if (invalidated) activeBatchIdRef.current = '';
    return batchRequestGenerationRef.current;
  }

  function canApplyBatchResponse(requestBatchId, requestGeneration) {
    return shouldApplyBatchScopedResponse({
      requestBatchId,
      currentBatchId: activeBatchIdRef.current,
      requestGeneration,
      currentGeneration: batchRequestGenerationRef.current,
      batchInvalidated: batchInvalidatedRef.current
    });
  }

  async function load() {
    const requestBatchId = batchId || '';
    const requestGeneration = bumpBatchRequestGeneration({ invalidated: false });
    setLoading(true);
    setError('');
    try {
      const [rulesResult, batchList, scanStatusResult, templateResult, settingsResult, providerStatusResult] = await Promise.all([
        api.listPlatformRules(),
        api.listBatches(),
        api.getImportScanStatus(),
        api.listWorkflowTemplates(),
        api.getEffectiveSettings(),
        api.getProviderStatus()
      ]);
      setRules(rulesResult);
      setBatches(batchList.batchTasks || []);
      setScanStatus(scanStatusResult);
      setTemplates(templateResult.templates || []);
      setEffectiveSettings(settingsResult);
      setProviderStatus(providerStatusResult);
      const defaultTemplateId = settingsResult.userSettings?.defaults?.workflowTemplateId || templateResult.templates?.[0]?.id || '';
      if (!selectedTemplateId && defaultTemplateId) setSelectedTemplateId(defaultTemplateId);
      const settingsPlatforms = settingsResult.userSettings?.defaults?.platforms || [];
      if (settingsPlatforms.length && selectedPlatforms.length === 2 && selectedPlatforms.includes('amazon') && selectedPlatforms.includes('temu')) {
        setSelectedPlatforms(settingsPlatforms.map((item) => item.platformId));
        setTargetDrafts(Object.fromEntries(settingsPlatforms.map((item) => [item.platformId, {
          site: item.site,
          language: item.language,
          categoryId: item.categoryId
        }])));
      }
      if (settingsResult.userSettings?.defaults?.batchConcurrency) {
        setQueueConcurrency(settingsResult.userSettings.defaults.batchConcurrency);
      }
      if (settingsResult.userSettings?.defaults?.reviewMode) {
        setQueueMode(settingsResult.userSettings.defaults.reviewMode);
      }
      setShowAdvanced(!settingsResult.userSettings?.ui?.collapseAdvancedByDefault);
      if (batchId) {
        const [batchResult, analyticsResult, reviewReportResult, stabilityResult, resumePlanResult] = await Promise.all([
          api.getBatch(batchId),
          api.getBatchAnalytics(batchId),
          api.getBatchReviewReport(batchId),
          api.getBatchStability(batchId),
          api.getBatchResumePlan(batchId)
        ]);
        if (!canApplyBatchResponse(requestBatchId, requestGeneration)) return;
        setBatchTask(batchResult.batchTask);
        setAnalytics(analyticsResult.analytics);
        setBatchReviewReport(reviewReportResult.reviewReport);
        setBatchStabilityReport(stabilityResult.batchStabilityReport);
        setBatchResumePlan(resumePlanResult.batchResumePlan);
        const logResult = await api.getBatchLogs(batchId);
        if (!canApplyBatchResponse(requestBatchId, requestGeneration)) return;
        setLogs(logResult.logs || []);
      } else {
        setBatchTask(null);
        setAnalytics(null);
        setBatchReviewReport(null);
        setBatchStabilityReport(null);
        setBatchResumePlan(null);
        setLogs([]);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [batchId]);

  useEffect(() => {
    if (!batchTask || batchTask.queue?.status !== 'running') return undefined;
    const timer = setInterval(async () => {
      const requestBatchId = batchTask.id;
      const requestGeneration = batchRequestGenerationRef.current;
      try {
        const [batchResult, logResult] = await Promise.all([
          api.getBatch(requestBatchId),
          api.getBatchLogs(requestBatchId)
        ]);
        if (!canApplyBatchResponse(requestBatchId, requestGeneration)) return;
        setBatchTask(batchResult.batchTask);
        setLogs(logResult.logs || []);
      } catch {
        // keep the page calm; manual refresh will surface errors if needed
      }
    }, 4000);
    return () => clearInterval(timer);
  }, [batchTask?.id, batchTask?.queue?.status]);

  function togglePlatform(platformId) {
    setSelectedPlatforms((current) => (
      current.includes(platformId)
        ? current.filter((item) => item !== platformId)
        : [...current, platformId]
    ));
  }

  function updateTargetDraft(platformId, patch) {
    setTargetDrafts((current) => ({
      ...current,
      [platformId]: {
        ...(current[platformId] || {}),
        ...patch
      }
    }));
  }

  async function importFolder() {
    setBusy('import');
    setError('');
    try {
      const result = await api.importBatchFolder({ folderPath, name, defaultTargets, templateId: selectedTemplateId || undefined });
      setBatchTask(result.batchTask);
      setAnalytics(result.batchTask?.analytics || null);
      setTemplateWarnings(result.templateWarnings || []);
      setResults([]);
      navigate(`/batches/${result.batchTask.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function scanImportDirectory() {
    setBusy('scan');
    setError('');
    setScanFeedback('正在扫描导入目录...');
    try {
      const result = await api.scanImportRoot({});
      setScanResult(result);
      setSelectedScanFolders((result.candidates || [])
        .filter((candidate) => candidate.status === 'new')
        .map((candidate) => candidate.folderPath));
      setScanFeedback(buildScanSummaryMessage(result));
      if (typeof window !== 'undefined') {
        window.requestAnimationFrame(() => {
          scanResultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
    } catch (err) {
      setError(err.message);
      setScanFeedback(`扫描失败：${err.message}`);
    } finally {
      setBusy('');
    }
  }

  async function refreshBatchListFromServer(nextCurrentBatch = batchTask) {
    const list = await api.listBatches();
    setBatches(buildBatchListRowsForBatchPage({ batches: list.batchTasks || [], batchTask: nextCurrentBatch || null }));
    return list;
  }

  async function refreshScanCandidates() {
    const refreshed = await api.scanImportRoot({});
    setScanResult(refreshed);
    setSelectedScanFolders((current) => current.filter((folderPathValue) => (
      (refreshed.candidates || []).some((candidate) => candidate.folderPath === folderPathValue && candidate.status === 'new')
    )));
    return refreshed;
  }

  function toggleScanFolder(folderPathValue) {
    setSelectedScanFolders((current) => (
      current.includes(folderPathValue)
        ? current.filter((item) => item !== folderPathValue)
        : [...current, folderPathValue]
    ));
  }

  async function importSelectedScanFolders() {
    setBusy('scan-import');
    setError('');
    try {
      const result = await api.importScannedFolders({
        folderPaths: selectedScanFolders,
        batchName: name || '扫描导入批量任务',
        defaultTargets,
        templateId: selectedTemplateId || undefined
      });
      if (result.batchTask) {
        bumpBatchRequestGeneration({ invalidated: false });
        activeBatchIdRef.current = result.batchTask.id;
        setBatchTask(result.batchTask);
        setAnalytics(result.batchTask?.analytics || null);
        setTemplateWarnings(result.templateWarnings || []);
        setResults([]);
        setBatches((current) => buildBatchListRowsForBatchPage({ batches: current, batchTask: result.batchTask }));
        navigate(`/batches/${result.batchTask.id}`);
      }
      const refreshed = await api.scanImportRoot();
      setScanResult(refreshed);
      setSelectedScanFolders([]);
      const list = await api.listBatches();
      setBatches(buildBatchListRowsForBatchPage({ batches: list.batchTasks || [], batchTask: result.batchTask || null }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function runAction(action, runner) {
    if (!batchTask) return;
    const requestBatchId = batchTask.id;
    const requestGeneration = batchRequestGenerationRef.current;
    setBusy(action);
    setError('');
    try {
      const result = await runner(requestBatchId);
      if (!canApplyBatchResponse(requestBatchId, requestGeneration)) return;
      setBatchTask(result.batchTask);
      setAnalytics(result.batchTask?.analytics || null);
      setResults(result.results || []);
      const list = await api.listBatches();
      setBatches(list.batchTasks || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function queueRequest(label, runner) {
    if (!batchTask) return;
    const requestBatchId = batchTask.id;
    const requestGeneration = batchRequestGenerationRef.current;
    setBusy(label);
    setError('');
    try {
      const result = await runner(requestBatchId);
      if (!canApplyBatchResponse(requestBatchId, requestGeneration)) return;
      setBatchTask(result.batchTask);
      setAnalytics(result.batchTask?.analytics || null);
      const logResult = await api.getBatchLogs(requestBatchId);
      if (!canApplyBatchResponse(requestBatchId, requestGeneration)) return;
      setLogs(logResult.logs || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function applySelectedTemplate() {
    if (!batchTask || !selectedTemplateId) return;
    const requestBatchId = batchTask.id;
    const requestGeneration = batchRequestGenerationRef.current;
    setBusy('apply-template');
    setError('');
    try {
      const result = await api.applyBatchTemplate(requestBatchId, selectedTemplateId);
      if (!canApplyBatchResponse(requestBatchId, requestGeneration)) return;
      setBatchTask(result.batchTask);
      setTemplateWarnings(result.warnings || []);
      const analyticsResult = await api.getBatchAnalytics(requestBatchId);
      if (!canApplyBatchResponse(requestBatchId, requestGeneration)) return;
      setAnalytics(analyticsResult.analytics);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function refreshAnalytics() {
    if (!batchTask) return;
    const requestBatchId = batchTask.id;
    const requestGeneration = batchRequestGenerationRef.current;
    setBusy('analytics');
    setError('');
    try {
      const result = await api.refreshBatchAnalytics(requestBatchId);
      if (!canApplyBatchResponse(requestBatchId, requestGeneration)) return;
      setAnalytics(result.analytics);
      const batchResult = await api.getBatch(requestBatchId);
      if (!canApplyBatchResponse(requestBatchId, requestGeneration)) return;
      setBatchTask(batchResult.batchTask);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function loadBatchSop() {
    if (!batchTask) return;
    setBusy('sop');
    setError('');
    try {
      const result = await api.getBatchSop(batchTask.id);
      setSopMarkdown(result.markdown || '');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function runBatchControl(action, successMessage, runner) {
    if (!batchTask?.id) return;
    if (!window.confirm(batchControlConfirmText)) return;
    setBusy(action);
    setError('');
    setBatchControlError('');
    setBatchControlFeedback('');
    try {
      const result = await runner(batchTask.id);
      const transition = batchControlStateTransition(action, result, successMessage);
      if (transition.clearCurrentBatch) {
        bumpBatchRequestGeneration({ invalidated: true });
        setBatchTask(null);
        setAnalytics(null);
        setBatchReviewReport(null);
        setBatchStabilityReport(null);
        setBatchResumePlan(null);
        setLogs([]);
        setResults([]);
        setSkuRetryPlans({});
        setSkuRetrySteps({});
        setSkuRetryResults({});
      } else if (result.batchTask) {
        setBatchTask(result.batchTask);
      }
      if (transition.clearReports) {
        setExportPackagePreview(null);
        setExportPackageResult(null);
        setListingExportPreview(null);
        setListingExportResult(null);
        setListingExportError('');
        setUploadReadinessReport(null);
        setUploadPayloadPreview(null);
        setUploadSandboxReport(null);
        setUploadSafetyReport(null);
      }
      const list = await api.listBatches();
      setBatches(list.batchTasks || []);
      if (transition.navigateToBatchList) {
        navigate('/batches');
      }
      setBatchControlFeedback(transition.feedback || successMessage);
    } catch (err) {
      setError(err.message);
      setBatchControlError(`batch 操作失败，请查看错误信息后重试。${err.message ? ` ${err.message}` : ''}`);
    } finally {
      setBusy('');
    }
  }

  async function cancelCurrentBatch() {
    await runBatchControl('batch-cancel', '当前 batch 已取消', (id) => api.cancelBatch(id, { confirm: true }));
  }

  async function deleteCurrentBatch() {
    await runBatchControl('batch-delete', 'batch 记录已删除，本地图片未删除', (id) => api.deleteBatch(id, { confirm: true }));
  }

  async function resetCurrentBatchImportState() {
    const mode = resetImportActionMode({ batchTask, scanResult });
    if (mode === 'hidden') return;
    if (mode === 'reset-current-batch') {
      await runBatchControl('batch-reset-import', '导入状态已重置，可以重新扫描目录', (id) => api.resetBatchImportState(id, { confirm: true }));
      try {
        await refreshScanCandidates();
        await refreshBatchListFromServer(null);
      } catch {
        // Reset already completed; users can scan again manually if refresh fails.
      }
      return;
    }
    setBusy('batch-reset-import');
    setError('');
    setBatchControlError('');
    try {
      await refreshScanCandidates();
      await refreshBatchListFromServer(null);
      setBatchControlFeedback('已刷新导入状态和批量任务列表，可以重新选择 SKU 导入。');
    } catch (err) {
      setError(err.message);
      setBatchControlError(`刷新导入状态失败，请查看错误信息后重试。${err.message ? ` ${err.message}` : ''}`);
    } finally {
      setBusy('');
    }
  }

  async function runGuideAction(action) {
    if (action === 'scan_or_import') {
      if (scanStatus?.enabled && scanStatus?.validRoot) {
        await scanImportDirectory();
      }
      return;
    }
    if (!batchTask) return;
    if (action === 'apply_template') {
      await applySelectedTemplate();
      return;
    }
    if (action === 'start_recognize_queue') {
      await queueRequest('guide-recognize', (id) => api.startBatchQueue(id, { action: 'recognize', concurrency: Number(queueConcurrency), mode: 'mock' }));
      return;
    }
    if (action === 'open_pending_confirm_sku') {
      const sku = getNextPendingConfirmSku(batchTask);
      if (sku?.taskId) navigate(`/tasks/${sku.taskId}/product`);
      return;
    }
    if (action === 'apply_targets') {
      await runAction('apply-targets', (id) => api.batchApplyTargets(id, defaultTargets));
      return;
    }
    if (action === 'start_plan_queue') {
      await queueRequest('guide-plan', (id) => api.startBatchQueue(id, { action: 'plan', concurrency: Number(queueConcurrency), mode: 'mock' }));
      return;
    }
    if (action === 'start_generate_queue') {
      await queueRequest('guide-generate', (id) => api.startBatchQueue(id, { action: 'generate', concurrency: Number(queueConcurrency), mode: 'mock' }));
      return;
    }
    if (action === 'start_review_queue') {
      await queueRequest('guide-review', (id) => api.startBatchQueue(id, { action: 'review', concurrency: Number(queueConcurrency), mode: 'mock' }));
      return;
    }
    if (action === 'export_batch') {
      window.location.href = api.batchExportUrl(batchTask.id);
    }
  }

  async function runGuideSecondaryAction(action) {
    if (action === 'retry_failed' && batchTask) {
      await queueRequest('guide-retry', (id) => api.retryFailedBatchQueue(id, {
        action: queue.action || queueAction || 'recognize',
        concurrency: Number(queueConcurrency),
        mode: queueMode,
        filter: 'retryable'
      }));
    }
  }

  if (loading) return <div className="text-sm text-slate-500">正在加载批量任务...</div>;

  const summary = batchTask?.summary || {};
  const queue = batchTask?.queue || {};
  const progressTotal = queue.totalJobs || 0;
  const progressDone = (queue.completedJobs || 0) + (queue.failedJobs || 0) + (queue.skippedJobs || 0);
  const progressPercent = progressTotal ? Math.round((progressDone / progressTotal) * 100) : 0;
  const queueRunning = queue.status === 'running';
  const queuePaused = queue.status === 'paused';
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId);
  const modeSource = batchTask?.workflowTemplateSnapshot || selectedTemplate || {};
  const workflowModes = {
    recognition: modeSource.modes?.recognition || (modeSource.providers?.visionProvider && modeSource.providers.visionProvider !== 'mock' ? 'real' : 'mock'),
    imageGeneration: modeSource.modes?.imageGeneration || modeSource.generation?.defaultMode || 'mock',
    review: modeSource.modes?.review || modeSource.review?.defaultMode || 'mock',
    upload: 'dry-run'
  };
  const guideState = getBatchGuideState(batchTask || { skuTasks: [] });
  const currentGuideStep = guideState.steps.find((step) => step.id === guideState.currentStepId);
  const pendingConfirmSku = batchTask ? getNextPendingConfirmSku(batchTask) : null;
  const batchReviewDisplay = getBatchReviewReportDisplayModel(batchReviewReport);
  const batchStabilityDisplay = getBatchStabilityDisplayModel(batchStabilityReport);
  const batchResumePlanDisplay = getBatchResumePlanDisplayModel(batchResumePlan);
  const batchListRows = buildBatchListRowsForBatchPage({ batches, batchTask });
  const skuListRows = buildSkuRowsForBatchPage({ batchTask, scanResult });
  const showResetImportStatusAction = shouldShowResetImportStatusAction({ batchTask, scanResult });
  const exportPackageDisplay = getExportPackageDisplayModel({
    preview: exportPackagePreview,
    result: exportPackageResult
  });
  const listingExportDisplay = getListingExportDisplayModel({
    preview: listingExportPreview,
    result: listingExportResult
  });
  const uploadReadinessDisplay = getUploadReadinessDisplayModel(uploadReadinessReport);
  const uploadPayloadDisplay = getUploadPayloadDisplayModel(uploadPayloadPreview);
  const uploadSandboxDisplay = getUploadSandboxDisplayModel(uploadSandboxReport);
  const uploadSafetyDisplay = getUploadSafetyDisplayModel(uploadSafetyReport);

  async function exportBatchReviewReport() {
    let report = batchReviewReport;
    if (!report && batchTask?.id) {
      const requestBatchId = batchTask.id;
      const requestGeneration = batchRequestGenerationRef.current;
      const result = await api.getBatchReviewReport(requestBatchId);
      if (!canApplyBatchResponse(requestBatchId, requestGeneration)) return;
      report = result.reviewReport;
      setBatchReviewReport(report);
    }
    if (report) downloadBatchReviewReportJson({ report, batchId: batchTask.id });
  }

  async function exportBatchStabilityReport() {
    let report = batchStabilityReport;
    if (!report && batchTask?.id) {
      const requestBatchId = batchTask.id;
      const requestGeneration = batchRequestGenerationRef.current;
      const result = await api.getBatchStability(requestBatchId);
      if (!canApplyBatchResponse(requestBatchId, requestGeneration)) return;
      report = result.batchStabilityReport;
      setBatchStabilityReport(report);
    }
    if (report) downloadBatchStabilityReportJson({ report, batchId: batchTask.id });
  }

  async function refreshBatchResumePlan() {
    if (!batchTask?.id) return;
    const requestBatchId = batchTask.id;
    const requestGeneration = batchRequestGenerationRef.current;
    setBusy('batch-resume-plan');
    setError('');
    try {
      const result = await api.getBatchResumePlan(requestBatchId);
      if (!canApplyBatchResponse(requestBatchId, requestGeneration)) return;
      setBatchResumePlan(result.batchResumePlan);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function exportBatchResumePlan() {
    let plan = batchResumePlan;
    if (!plan && batchTask?.id) {
      const requestBatchId = batchTask.id;
      const requestGeneration = batchRequestGenerationRef.current;
      const result = await api.getBatchResumePlan(requestBatchId);
      if (!canApplyBatchResponse(requestBatchId, requestGeneration)) return;
      plan = result.batchResumePlan;
      setBatchResumePlan(plan);
    }
    if (plan) downloadBatchResumePlanJson({ plan, batchId: batchTask.id });
  }

  function updateExportPackageOption(key, value) {
    setExportPackageOptions((current) => normalizeExportPackageOptions({ ...current, [key]: value }));
  }

  function toggleExportPackagePlatform(platformId) {
    setExportPackageOptions((current) => {
      const nextPlatforms = current.platforms?.includes(platformId)
        ? current.platforms.filter((item) => item !== platformId)
        : [...(current.platforms || []), platformId];
      return normalizeExportPackageOptions({ ...current, platforms: nextPlatforms });
    });
  }

  async function previewExportPackage() {
    if (!batchTask?.id) return;
    const requestBatchId = batchTask.id;
    const requestGeneration = batchRequestGenerationRef.current;
    setBusy('export-package-preview');
    setError('');
    try {
      const result = await api.getExportPackagePreview(requestBatchId, exportPackageOptions);
      if (!canApplyBatchResponse(requestBatchId, requestGeneration)) return;
      setExportPackagePreview(result.preview);
      setExportPackageResult(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function createExportPackageZip() {
    if (!batchTask?.id) return;
    if (!window.confirm(exportPackageConfirmText)) return;
    const requestBatchId = batchTask.id;
    const requestGeneration = batchRequestGenerationRef.current;
    setBusy('export-package-create');
    setError('');
    try {
      const result = await api.createExportPackage(requestBatchId, {
        ...exportPackageOptions,
        confirmExport: true
      });
      if (!canApplyBatchResponse(requestBatchId, requestGeneration)) return;
      setExportPackageResult(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  function updateListingExportOption(key, value) {
    setListingExportOptions((current) => normalizeListingExportOptions({ ...current, [key]: value }));
  }

  function toggleListingExportPlatform(platformId) {
    setListingExportOptions((current) => {
      const nextPlatforms = current.platforms?.includes(platformId)
        ? current.platforms.filter((item) => item !== platformId)
        : [...(current.platforms || []), platformId];
      return normalizeListingExportOptions({ ...current, platforms: nextPlatforms });
    });
  }

  async function previewListingCsv() {
    if (!batchTask?.id) return;
    const requestBatchId = batchTask.id;
    const requestGeneration = batchRequestGenerationRef.current;
    setBusy('listing-csv-preview');
    setError('');
    setListingExportError('');
    try {
      const result = await api.getListingCsvPreview(requestBatchId, listingExportOptions);
      if (!canApplyBatchResponse(requestBatchId, requestGeneration)) return;
      setListingExportPreview(result.preview);
      setListingExportResult(null);
    } catch (err) {
      setError(err.message);
      setListingExportError(`CSV 预览失败，请查看错误信息后重试。${err.message ? ` ${err.message}` : ''}`);
    } finally {
      setBusy('');
    }
  }

  async function createListingCsv() {
    if (!batchTask?.id) return;
    if (!window.confirm(listingExportConfirmText)) return;
    const requestBatchId = batchTask.id;
    const requestGeneration = batchRequestGenerationRef.current;
    setBusy('listing-csv-create');
    setError('');
    setListingExportError('');
    try {
      const result = await api.createListingCsvExport(requestBatchId, {
        ...listingExportOptions,
        confirmExport: true
      });
      if (!canApplyBatchResponse(requestBatchId, requestGeneration)) return;
      setListingExportResult(result);
    } catch (err) {
      setError(err.message);
      setListingExportError(`CSV 生成失败，请查看错误信息后重试。${err.message ? ` ${err.message}` : ''}`);
    } finally {
      setBusy('');
    }
  }

  function toggleUploadReadinessPlatform(platformId) {
    setUploadReadinessOptions((current) => {
      const nextPlatforms = current.platforms?.includes(platformId)
        ? current.platforms.filter((item) => item !== platformId)
        : [...(current.platforms || []), platformId];
      return normalizeUploadReadinessOptions({ platforms: nextPlatforms });
    });
  }

  function updateUploadSandboxConfig(platformId, patch) {
    setUploadSandboxConfig((current) => ({
      ...current,
      [platformId]: {
        ...(current[platformId] || {}),
        enabled: true,
        ...patch
      }
    }));
  }

  function saveUploadSandboxConfigToLocal() {
    setUploadSandboxConfig((current) => saveUploadSandboxConfig(current));
  }

  async function refreshUploadSafetyReport() {
    setBusy('upload-safety-refresh');
    setError('');
    try {
      await api.getUploadCredentialStatus();
      const result = await api.getUploadSafetyReport();
      setUploadSafetyReport(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  function exportUploadSafetyReport() {
    if (!uploadSafetyReport) return;
    downloadUploadSafetyJson({ report: uploadSafetyReport });
  }

  async function previewUploadReadiness() {
    if (!batchTask?.id) return;
    const requestBatchId = batchTask.id;
    const requestGeneration = batchRequestGenerationRef.current;
    setBusy('upload-readiness-preview');
    setError('');
    try {
      const hasSandboxConfig = Object.values(uploadSandboxConfig || {}).some((item) => item?.configured || item?.accountName || item?.credential);
      const result = hasSandboxConfig
        ? await api.postUploadReadinessPreview(requestBatchId, {
          ...uploadReadinessOptions,
          packageId: exportPackageResult?.exportId || exportPackagePreview?.packageId || '',
          listingCsvId: listingExportResult?.exportId || '',
          sandboxConfig: uploadSandboxConfig,
          confirmDryRun: true
        })
        : await api.getUploadReadinessPreview(requestBatchId, uploadReadinessOptions);
      if (!canApplyBatchResponse(requestBatchId, requestGeneration)) return;
      setUploadReadinessReport(result.uploadReadinessReport);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  function exportUploadReadinessReport() {
    if (!uploadReadinessReport || !batchTask?.id) return;
    downloadUploadReadinessJson({ batchId: batchTask.id, report: uploadReadinessReport });
  }

  async function previewUploadPayload() {
    if (!batchTask?.id) return;
    const requestBatchId = batchTask.id;
    const requestGeneration = batchRequestGenerationRef.current;
    setBusy('upload-payload-preview');
    setError('');
    try {
      const result = await api.previewUploadPayload(requestBatchId, {
        ...uploadReadinessOptions,
        packageId: exportPackageResult?.exportId || exportPackagePreview?.packageId || '',
        confirmDryRun: true
      });
      if (!canApplyBatchResponse(requestBatchId, requestGeneration)) return;
      setUploadPayloadPreview(result.uploadPayloadPreview);
      setUploadSandboxReport(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function simulateUploadSandbox() {
    if (!batchTask?.id) return;
    const requestBatchId = batchTask.id;
    const requestGeneration = batchRequestGenerationRef.current;
    setBusy('upload-sandbox-simulate');
    setError('');
    try {
      const result = await api.simulateUploadSandbox(requestBatchId, {
        ...uploadReadinessOptions,
        packageId: exportPackageResult?.exportId || exportPackagePreview?.packageId || '',
        confirmSandboxSubmit: true
      });
      if (!canApplyBatchResponse(requestBatchId, requestGeneration)) return;
      setUploadSandboxReport(result.uploadSandboxReport);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  function exportUploadPayloadPreview() {
    if (!uploadPayloadPreview || !batchTask?.id) return;
    downloadUploadPayloadJson({ batchId: batchTask.id, preview: uploadPayloadPreview });
  }

  function exportUploadSandboxReport() {
    if (!uploadSandboxReport || !batchTask?.id) return;
    downloadUploadSandboxJson({ batchId: batchTask.id, report: uploadSandboxReport });
  }

  async function viewSkuRetryPlan(failure) {
    if (!batchTask?.id || !failure?.taskId) return;
    setBusy(`sku-retry-plan-${failure.taskId}`);
    setError('');
    try {
      const result = await api.getSkuRetryPlan(batchTask.id, failure.taskId);
      const retryPlan = result.retryPlan;
      setSkuRetryPlans((current) => ({ ...current, [failure.taskId]: retryPlan }));
      setSkuRetrySteps((current) => ({
        ...current,
        [failure.taskId]: retryPlan?.allowedRetrySteps?.[0] || current[failure.taskId] || ''
      }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function retrySingleSku(failure) {
    if (!batchTask?.id || !failure?.taskId) return;
    const retryPlan = skuRetryPlans[failure.taskId];
    const retryStep = skuRetrySteps[failure.taskId] || retryPlan?.allowedRetrySteps?.[0] || failure.failedStep;
    const confirmed = window.confirm('本次只会重试当前 SKU 的指定步骤，不会自动重试整个 batch，不会调用真实 Provider。确认继续吗？');
    if (!confirmed) return;
    setBusy(`sku-retry-run-${failure.taskId}`);
    setError('');
    try {
      const planResult = retryPlan ? { retryPlan } : await api.getSkuRetryPlan(batchTask.id, failure.taskId);
      if (!retryPlan) {
        setSkuRetryPlans((current) => ({ ...current, [failure.taskId]: planResult.retryPlan }));
      }
      const result = await api.executeSkuRetry(batchTask.id, failure.taskId, {
        retryStep,
        confirmRetry: true,
        mode: 'mockOnly',
        confirmPaidApi: false
      });
      setSkuRetryResults((current) => ({ ...current, [failure.taskId]: result.retryResult }));
      const stabilityResult = await api.getBatchStability(batchTask.id);
      setBatchStabilityReport(stabilityResult.batchStabilityReport);
      const resumePlanResult = await api.getBatchResumePlan(batchTask.id);
      setBatchResumePlan(resumePlanResult.batchResumePlan);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  function exportSkuRetryResult(taskId) {
    const retryResult = skuRetryResults[taskId];
    if (!retryResult) return;
    downloadSkuRetryResultJson({
      taskId,
      retryPlan: skuRetryPlans[taskId],
      retryResult
    });
  }

  return (
    <div className="space-y-5">
      <ErrorMessage error={error} />
      {(batchTask || showResetImportStatusAction) && (
        <Section title="安全操作">
          <div className="space-y-3">
            <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              这些操作只清理小程序内的 batch / task 记录或导入状态，不会删除本地图片文件夹。删除后如需重新导入，请重新扫描目录。
            </div>
            {batchControlFeedback && (
              <div className="rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
                {batchControlFeedback}
              </div>
            )}
            {batchControlError && (
              <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                {batchControlError}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {batchTask && (
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={cancelCurrentBatch}
                  className="rounded border border-amber-300 bg-white px-3 py-2 text-sm font-medium text-amber-800 disabled:opacity-60"
                >
                  {busy === 'batch-cancel' ? '正在取消...' : '取消当前 batch'}
                </button>
              )}
              {showResetImportStatusAction && (
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={resetCurrentBatchImportState}
                  className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60"
                >
                  {busy === 'batch-reset-import' ? '正在重置...' : '重置导入状态'}
                </button>
              )}
              {batchTask && (
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={deleteCurrentBatch}
                  className="rounded border border-red-300 bg-white px-3 py-2 text-sm font-medium text-red-700 disabled:opacity-60"
                >
                  {busy === 'batch-delete' ? '正在删除...' : '删除当前 batch 记录'}
                </button>
              )}
            </div>
          </div>
        </Section>
      )}
      <Section title="批量任务操作向导">
        <div className="rounded border border-mint bg-teal-50 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-teal-700">推荐下一步</div>
              <div className="mt-1 text-lg font-semibold text-ink">{currentGuideStep?.title || '导入 SKU'}</div>
              <div className="mt-1 text-sm text-slate-600">{currentGuideStep?.description}</div>
              <div className="mt-2 text-xs text-slate-500">{currentGuideStep?.progressText}</div>
            </div>
            <div className="flex flex-wrap gap-2">
              {currentGuideStep?.primaryAction && (
                <button
                  type="button"
                  disabled={Boolean(busy) || queueRunning || (currentGuideStep.primaryAction.action === 'apply_template' && !selectedTemplateId)}
                  onClick={() => runGuideAction(currentGuideStep.primaryAction.action)}
                  className="rounded bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
                >
                  {currentGuideStep.primaryAction.label}
                </button>
              )}
              {pendingConfirmSku && currentGuideStep?.id === 'confirm' && (
                <Link to={`/tasks/${pendingConfirmSku.taskId}/product`} className="rounded border border-teal-300 bg-white px-3 py-2 text-sm font-semibold text-teal-800">打开下一个待确认 SKU</Link>
              )}
              {currentGuideStep?.secondaryActions?.map((action) => (
                <button key={action.id} type="button" disabled={Boolean(busy) || queueRunning} onClick={() => runGuideSecondaryAction(action.action)} className="rounded border border-amber-300 bg-white px-3 py-2 text-sm font-medium text-amber-800 disabled:opacity-60">
                  {action.label}
                </button>
              ))}
            </div>
          </div>
          {currentGuideStep?.blockingReasons?.length > 0 && (
            <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
              {currentGuideStep.blockingReasons.map((reason) => <div key={reason}>{reason}</div>)}
            </div>
          )}
          {guideState.warnings.length > 0 && (
            <div className="mt-3 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
              {guideState.warnings.map((warning) => <div key={warning.code}>{warning.message}</div>)}
            </div>
          )}
        </div>
        <div className="mt-4 grid gap-2 md:grid-cols-9">
          {guideState.steps.map((step, index) => (
            <div key={step.id} className={[
              'rounded border p-2 text-xs',
              step.status === 'done' && 'border-emerald-200 bg-emerald-50 text-emerald-800',
              step.status === 'current' && 'border-teal-300 bg-white text-teal-900',
              step.status === 'blocked' && 'border-red-200 bg-red-50 text-red-700',
              step.status === 'available' && 'border-blue-200 bg-blue-50 text-blue-800',
              step.status === 'pending' && 'border-slate-200 bg-slate-50 text-slate-500'
            ].filter(Boolean).join(' ')}>
              <div className="font-semibold">{index + 1}. {step.title}</div>
              <div className="mt-1">{guideStepStatusLabel(step.status)}</div>
            </div>
          ))}
        </div>
        {batchTask?.workflowTemplateSnapshot && (
          <div className="mt-3 text-xs text-slate-500">当前模板：{batchTask.workflowTemplateSnapshot.name}。更换模板只影响后续默认配置，不会自动重写已确认商品信息。</div>
        )}
      </Section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">批量 SKU 任务</h1>
          <p className="mt-1 text-sm text-slate-500">按本地文件夹导入多个 SKU，每个 SKU 仍走独立单品任务和人工确认流程。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {batchTask && (
            <button
              type="button"
              disabled={Boolean(busy) || queueRunning}
              onClick={() => queueRequest('queue-prepare', (id) => api.startBatchQueue(id, { action: 'prepare', concurrency: Number(queueConcurrency) || 1, mode: 'mock' }))}
              className="focus-ring inline-flex items-center gap-2 rounded bg-teal-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              <Play size={16} />
              启动当前 batch
            </button>
          )}
        <button type="button" onClick={load} className="focus-ring inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700">
          <RefreshCw size={16} />
          刷新
        </button>
        </div>
      </div>

      <Section title="创建批量任务">
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          本地 folderPath 导入仅适合本地开发环境。不要输入系统敏感目录；生产环境应改成受限目录扫描或浏览器多文件上传。
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-[1.5fr_1fr]">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">本地批量文件夹路径</span>
            <input value={folderPath} onChange={(event) => setFolderPath(event.target.value)} placeholder="D:\\Code\\batch-import" className="focus-ring w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">批量任务名称</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="硬盘图片批量任务" className="focus-ring w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm" />
          </label>
        </div>
        <div className="mt-4 rounded border border-slate-200 bg-white p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="block min-w-[260px] flex-1">
              <span className="mb-1 block text-sm font-medium text-slate-700">工作流模板</span>
              <select value={selectedTemplateId} onChange={(event) => setSelectedTemplateId(event.target.value)} className="focus-ring w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm">
                <option value="">不使用模板</option>
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>{template.name}{template.isSystemTemplate ? '（系统）' : '（自定义）'}</option>
                ))}
              </select>
            </label>
            <Link to="/workflow-templates" className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700">管理模板</Link>
            {batchTask && (
              <button type="button" disabled={!selectedTemplateId || Boolean(busy)} onClick={applySelectedTemplate} className="rounded bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">应用到当前 batch</button>
            )}
          </div>
          {selectedTemplate && (
            <div className="mt-3 grid gap-2 text-xs text-slate-600 md:grid-cols-4">
              <div>平台：{selectedTemplate.defaultTargets?.map((item) => item.platformId).join(', ') || '-'}</div>
              <div>识别：{selectedTemplate.providers?.visionProvider || 'mock'} / {selectedTemplate.recognition?.mode || 'balanced'}</div>
              <div>生图：{selectedTemplate.providers?.imageProvider || 'mock'} / {selectedTemplate.providers?.backgroundProvider || 'mock'}</div>
              <div>审核：{selectedTemplate.providers?.reviewProvider || 'mock'} / 并发 {selectedTemplate.queue?.concurrency || 2}</div>
            </div>
          )}
          <div className="mt-2 text-xs text-amber-700">模板只填充平台、provider、并发、重试和导出策略，不保存 API Key，也不会自动调用 AI 或跳过人工确认。</div>
          {templateWarnings.length > 0 && (
            <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
              {templateWarnings.map((warning, index) => <div key={`${warning.code}-${index}`}>{warning.message}</div>)}
            </div>
          )}
          {batchTask?.workflowTemplateSnapshot && (
            <div className="mt-2 text-xs text-slate-500">当前 batch 模板：{batchTask.workflowTemplateSnapshot.name}</div>
          )}
        </div>
        <div className="mt-3 grid gap-2 rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700 md:grid-cols-4">
          <div><span className="font-semibold">recognition mode</span>: {workflowModes.recognition}</div>
          <div><span className="font-semibold">image generation mode</span>: {workflowModes.imageGeneration}</div>
          <div><span className="font-semibold">review mode</span>: {workflowModes.review}</div>
          <div><span className="font-semibold">upload mode</span>: {workflowModes.upload}</div>
        </div>
        {providerStatus && (
          <div className="mt-3 grid gap-2 rounded border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800 md:grid-cols-3">
            {['vision', 'image', 'review'].map((kind) => {
              const item = providerStatus[kind] || {};
              return (
                <div key={kind}>
                  <div className="font-semibold">{kind} Provider: {item.provider || 'mock'}</div>
                  <div>Model: {item.model || '-'}</div>
                  <div>configured: {String(item.configured === true)}</div>
                  <div>missing: {(item.missingVariables || []).join(', ') || '-'}</div>
                </div>
              );
            })}
            <div className="md:col-span-3">real-test: {String(providerStatus.modes?.realTestAvailable === true)} / upload mode: dry-run / realUploadEnabled=false / readyForRealUpload=false</div>
          </div>
        )}
        <div className="mt-4">
          <div className="mb-2 text-sm font-semibold text-ink">默认目标平台</div>
          <div className="grid gap-3 md:grid-cols-3">
            {(rules?.platforms || []).map((platform) => {
              const checked = selectedPlatforms.includes(platform.platformId);
              const draft = targetDrafts[platform.platformId] || {};
              return (
                <div key={platform.platformId} className={`rounded border p-3 ${checked ? 'border-mint bg-teal-50' : 'border-slate-200 bg-white'}`}>
                  <label className="flex items-center gap-2 font-semibold text-ink">
                    <input type="checkbox" checked={checked} onChange={() => togglePlatform(platform.platformId)} className="accent-teal-700" />
                    {platform.name}
                  </label>
                  {checked && (
                    <div className="mt-3 grid gap-2">
                      <select value={draft.site || platform.sites?.[0] || 'US'} onChange={(event) => updateTargetDraft(platform.platformId, { site: event.target.value })} className="rounded border border-slate-300 bg-white px-2 py-1 text-xs">
                        {(platform.sites || ['US']).map((site) => <option key={site}>{site}</option>)}
                      </select>
                      <select value={draft.language || platform.languages?.[0] || 'English'} onChange={(event) => updateTargetDraft(platform.platformId, { language: event.target.value })} className="rounded border border-slate-300 bg-white px-2 py-1 text-xs">
                        {(platform.languages || ['English']).map((language) => <option key={language}>{language}</option>)}
                      </select>
                      <select value={draft.categoryId || 'electronics_storage'} onChange={(event) => updateTargetDraft(platform.platformId, { categoryId: event.target.value })} className="rounded border border-slate-300 bg-white px-2 py-1 text-xs">
                        {categoryOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div className="mt-4">
          <PrimaryButton busy={busy === 'import'} disabled={!folderPath || defaultTargets.length === 0} onClick={importFolder}>
            <FolderOpen size={17} />
            导入 SKU 文件夹
          </PrimaryButton>
        </div>
      </Section>

      <Section title="扫描导入目录">
        <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
          <div className="grid gap-2 md:grid-cols-4">
            <div>
              <div className="text-xs text-slate-500">扫描状态</div>
              <div className="font-semibold text-ink">{scanStatus?.enabled ? '已开启' : '未开启'}</div>
            </div>
            <div className="md:col-span-2">
              <div className="text-xs text-slate-500">IMPORT_ROOT_DIR</div>
              <div className="break-all font-medium text-ink">{scanStatus?.rootDir || '未配置'}</div>
            </div>
            <div>
              <div className="text-xs text-slate-500">允许格式</div>
              <div className="font-medium text-ink">{(scanStatus?.allowedExtensions || []).join(', ') || '-'}</div>
            </div>
          </div>
          <div className="mt-2 text-xs text-slate-500">
            扫描只会发现 SKU 文件夹并创建待处理批量任务，不会自动识别、生成、审核或导出，避免真实 AI 成本失控。
          </div>
          {scanStatus?.message && <div className="mt-2 text-xs text-amber-700">{scanStatus.message}</div>}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!scanStatus?.enabled || !scanStatus?.validRoot || Boolean(busy)}
            onClick={() => scanImportDirectory()}
            className="inline-flex items-center gap-2 rounded bg-ink px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            <Search size={16} />
            扫描导入目录
          </button>
          <button
            type="button"
            disabled={!selectedScanFolders.length || Boolean(busy)}
            onClick={() => importSelectedScanFolders()}
            className="rounded border border-mint bg-white px-3 py-2 text-sm font-semibold text-teal-800 disabled:opacity-60"
          >
            导入选中 SKU 为批量任务
          </button>
          {selectedScanFolders.length > 0 && <span className="self-center text-xs text-slate-500">已选择 {selectedScanFolders.length} 个 new SKU</span>}
        </div>
        {scanFeedback && (
          <div className={[
            'mt-3 rounded border px-3 py-2 text-sm',
            scanFeedback.startsWith('扫描失败') ? 'border-red-200 bg-red-50 text-red-700' : 'border-teal-200 bg-teal-50 text-teal-800'
          ].join(' ')}>
            {scanFeedback}
          </div>
        )}
        {scanResult && (
          <div ref={scanResultRef} className="mt-4">
            <div className="mb-2 text-sm text-slate-600">
              扫描结果：共 {scanResult.summary?.totalFolders || 0} 个文件夹，new {scanResult.summary?.newCount || 0}，已导入 {scanResult.summary?.importedCount || 0}，无效 {scanResult.summary?.invalidCount || 0}，空文件夹 {scanResult.summary?.emptyCount || 0}
            </div>
            {!hasScanCandidates(scanResult) && (
              <div className="mb-3 rounded border border-slate-200 bg-slate-50 px-3 py-4 text-sm text-slate-600">
                未发现 SKU 文件夹，请确认 IMPORT_ROOT_DIR 下每个 SKU 是一个子文件夹。
              </div>
            )}
            <div className="overflow-x-auto rounded border border-slate-200">
              <table className="w-full min-w-[900px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
                    <th className="px-3 py-2 font-medium">选择</th>
                    <th className="px-3 py-2 font-medium">SKU 文件夹</th>
                    <th className="px-3 py-2 font-medium">图片</th>
                    <th className="px-3 py-2 font-medium">大小</th>
                    <th className="px-3 py-2 font-medium">状态</th>
                    <th className="px-3 py-2 font-medium">提示</th>
                  </tr>
                </thead>
                <tbody>
                  {(scanResult.candidates || []).map((candidate) => (
                    <tr key={candidate.folderPath} className="border-b border-slate-100">
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          disabled={!getScanCandidateDisplay(candidate, { currentBatchId: batchTask?.id }).selectable}
                          checked={selectedScanFolders.includes(candidate.folderPath)}
                          onChange={() => toggleScanFolder(candidate.folderPath)}
                          className="accent-teal-700"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium text-ink">{candidate.displayName || candidate.folderName}</div>
                        <div className="max-w-[360px] truncate text-xs text-slate-400">{candidate.folderPath}</div>
                      </td>
                      <td className="px-3 py-2 text-slate-700">{candidate.imageCount}</td>
                      <td className="px-3 py-2 text-slate-700">{formatBytes(candidate.totalSize)}</td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex rounded border px-2 py-1 text-xs font-medium ${scanStatusClass(candidate.status)}`}>{candidate.status} / {getScanCandidateDisplay(candidate, { currentBatchId: batchTask?.id }).label}</span>
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600">
                        {[...(candidate.errors || []), ...(candidate.warnings || [])].slice(0, 3).map((item) => item.message || item.code).join('；') || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Section>

      <Section title="批量任务列表">
        {batchListRows.length === 0 ? (
          <div className="text-sm text-slate-500">暂无批量任务。</div>
        ) : (
          <div className="space-y-2">
            {batchListRows.map((batch) => (
              <Link key={batch.id} to={`/batches/${batch.id}`} className={`block rounded border p-3 text-sm ${batchTask?.id === batch.id ? 'border-mint bg-teal-50' : 'border-slate-200 bg-white'}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-ink">{batch.isCurrentBatch ? '当前批量任务：' : ''}{batch.name}</span>
                  <span className="text-slate-500">{statusLabels[batch.status] || batch.status}</span>
                </div>
                <div className="mt-1 text-xs text-slate-500">SKU：{batch.summary?.totalSku || 0} / 待确认：{batch.summary?.waitingConfirmSku || 0} / 失败：{batch.summary?.failedSku || 0} / 已完成：{batch.summary?.completedSku || 0}</div>
                <div className="mt-1 text-xs text-slate-500">模板：{batch.templateName || '未应用模板'}</div>
              </Link>
            ))}
          </div>
        )}
      </Section>

      {batchTask && (
        <Section
          title="批量任务稳定性摘要"
          actions={(
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={exportBatchStabilityReport}
              className="inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60"
            >
              <Download size={16} />
              导出批量稳定性报告 JSON
            </button>
          )}
        >
          {batchStabilityDisplay.emptyText ? (
            <div className="rounded border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              {batchStabilityDisplay.emptyText}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                {batchStabilityDisplay.readOnlyNotice || '本阶段仅提供断点续跑分析，不会自动恢复或重试。请先处理需要人工确认的 SKU，再执行后续批量恢复。'}
              </div>
              <div className="grid gap-3 md:grid-cols-4 lg:grid-cols-8">
                {batchStabilityDisplay.summaryCards.map((card) => (
                  <div key={card.label} className="rounded border border-slate-200 bg-white p-3">
                    <div className="text-xs text-slate-500">{card.label}</div>
                    <div className="mt-1 text-lg font-semibold text-ink">{card.value}</div>
                  </div>
                ))}
              </div>
              <div className="overflow-x-auto rounded border border-slate-200">
                <table className="w-full min-w-[780px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
                      <th className="px-3 py-2 font-medium">步骤</th>
                      <th className="px-3 py-2 font-medium">总数</th>
                      <th className="px-3 py-2 font-medium">完成</th>
                      <th className="px-3 py-2 font-medium">运行中</th>
                      <th className="px-3 py-2 font-medium">失败</th>
                      <th className="px-3 py-2 font-medium">待处理</th>
                      <th className="px-3 py-2 font-medium">需人工复查</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batchStabilityDisplay.stepRows.map((row) => (
                      <tr key={row.step} className="border-b border-slate-100">
                        <td className="px-3 py-2 font-medium text-ink">{row.label}</td>
                        <td className="px-3 py-2">{row.total}</td>
                        <td className="px-3 py-2 text-emerald-700">{row.completed}</td>
                        <td className="px-3 py-2 text-blue-700">{row.running}</td>
                        <td className="px-3 py-2 text-red-700">{row.failed}</td>
                        <td className="px-3 py-2 text-slate-600">{row.pending}</td>
                        <td className="px-3 py-2 text-amber-700">{row.needsManualReview}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                  <div className="mb-2 font-semibold">失败 SKU 列表</div>
                  {batchStabilityDisplay.failureRows.length ? (
                    <div className="space-y-2">
                      {batchStabilityDisplay.failureRows.map((failure) => {
                        const retryPlan = skuRetryPlans[failure.taskId];
                        const retryResult = skuRetryResults[failure.taskId];
                        const retryDisplay = getSkuRetryDisplayModel({ retryPlan, retryResult });
                        return (
                          <div key={`${failure.taskId}-${failure.sku}`} className="rounded bg-white p-2">
                            <div className="flex flex-wrap justify-between gap-2">
                              <span className="font-semibold">{failure.sku}</span>
                              <span className="text-xs">{failure.failedStep} / {failure.severity}</span>
                            </div>
                            <div className="mt-1 text-xs">{failure.errorMessage || '暂无错误信息'}</div>
                            <div className="mt-1 text-xs">可重试：{failure.canRetry ? '是' : '否'} / 需人工处理：{failure.requiresManualAction ? '是' : '否'}</div>
                            <div className="mt-1 text-xs">{failure.suggestion}</div>
                            <div className="mt-2 flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={Boolean(busy) || !failure.taskId}
                                onClick={() => viewSkuRetryPlan(failure)}
                                className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 disabled:opacity-60"
                              >
                                查看重试计划
                              </button>
                              <button
                                type="button"
                                disabled={Boolean(busy) || !failure.taskId || (retryPlan && !retryPlan.allowedRetrySteps?.length)}
                                onClick={() => retrySingleSku(failure)}
                                className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 disabled:opacity-60"
                              >
                                重试该 SKU
                              </button>
                              {retryResult && (
                                <button
                                  type="button"
                                  disabled={Boolean(busy)}
                                  onClick={() => exportSkuRetryResult(failure.taskId)}
                                  className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 disabled:opacity-60"
                                >
                                  导出重试结果 JSON
                                </button>
                              )}
                            </div>
                            {retryPlan && (
                              <div className="mt-2 rounded border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700">
                                <div>允许步骤：{retryDisplay.allowedStepsText}</div>
                                <div className="mt-1">阻止步骤：{retryDisplay.blockedStepsText}</div>
                                <div className="mt-1">提示：{retryDisplay.warningsText}</div>
                                {retryPlan.allowedRetrySteps?.length > 0 && (
                                  <label className="mt-2 block">
                                    <span className="mb-1 block text-slate-500">选择重试步骤</span>
                                    <select
                                      value={skuRetrySteps[failure.taskId] || retryPlan.allowedRetrySteps[0] || ''}
                                      onChange={(event) => setSkuRetrySteps((current) => ({ ...current, [failure.taskId]: event.target.value }))}
                                      className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                                    >
                                      {retryPlan.allowedRetrySteps.map((step) => (
                                        <option key={step} value={step}>{step}</option>
                                      ))}
                                    </select>
                                  </label>
                                )}
                              </div>
                            )}
                            {retryResult && (
                              <div className="mt-2 rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-800">
                                <div>重试结果：{retryDisplay.resultStatusText} / {retryResult.retryStep} / {retryDisplay.durationText}</div>
                                <div className="mt-1">{retryDisplay.resultSummaryText}</div>
                                <div className="mt-1">前后快照：{retryDisplay.snapshotSummary || '暂无变化摘要'}</div>
                                {retryDisplay.nextSuggestedAction && <div className="mt-1">下一步：{retryDisplay.nextSuggestedAction}</div>}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-xs">暂无失败 SKU。</div>
                  )}
                </div>
                <div className="rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
                  <div className="mb-2 font-semibold">恢复建议</div>
                  <div className="text-xs">canResume：{batchStabilityDisplay.resumePlan.canResume ? '是' : '否'}</div>
                  <div className="mt-2 text-xs">安全建议步骤：{(batchStabilityDisplay.resumePlan.safeResumeSteps || []).join(' / ') || '暂无'}</div>
                  {(batchStabilityDisplay.resumePlan.blockedReasons || []).length > 0 && (
                    <div className="mt-2 rounded bg-white p-2 text-xs">
                      {(batchStabilityDisplay.resumePlan.blockedReasons || []).map((item, index) => <div key={index}>{item}</div>)}
                    </div>
                  )}
                  {(batchStabilityDisplay.resumePlan.recommendations || []).length > 0 && (
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
                      {batchStabilityDisplay.resumePlan.recommendations.map((item, index) => <li key={index}>{item}</li>)}
                    </ul>
                  )}
                </div>
              </div>
              {batchStabilityDisplay.recommendations.length > 0 && (
                <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                  {batchStabilityDisplay.recommendations.join(' / ')}
                </div>
              )}
            </div>
          )}
        </Section>
      )}

      {batchTask && (
        <Section
          title="批量恢复计划预览"
          actions={(
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={refreshBatchResumePlan}
                className="inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60"
              >
                <RefreshCw size={16} />
                刷新恢复计划
              </button>
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={exportBatchResumePlan}
                className="inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60"
              >
                <Download size={16} />
                导出恢复计划 JSON
              </button>
            </div>
          )}
        >
          {batchResumePlanDisplay.emptyText ? (
            <div className="rounded border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              {batchResumePlanDisplay.emptyText}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                {batchResumePlanDisplay.safetyNotice || '当前仅为批量恢复计划预览，不会自动恢复整批。请逐个 SKU 执行安全重试。'}
              </div>
              <div className="grid gap-3 md:grid-cols-4 lg:grid-cols-7">
                {batchResumePlanDisplay.summaryCards.map((card) => (
                  <div key={card.label} className="rounded border border-slate-200 bg-white p-3">
                    <div className="text-xs text-slate-500">{card.label}</div>
                    <div className="mt-1 text-lg font-semibold text-ink">{card.value}</div>
                  </div>
                ))}
              </div>
              <div className="grid gap-3 lg:grid-cols-5">
                {Object.values(batchResumePlanDisplay.groupSections).map((section) => (
                  <div key={section.key} className="rounded border border-slate-200 bg-white p-3">
                    <div className="mb-2 text-sm font-semibold text-ink">{section.title}</div>
                    {section.rows.length ? (
                      <div className="space-y-2 text-xs text-slate-600">
                        {section.rows.slice(0, 6).map((row) => (
                          <div key={`${section.key}-${row.taskId}-${row.sku}`} className="rounded bg-slate-50 p-2">
                            <div className="font-semibold text-slate-800">{row.sku || row.taskId}</div>
                            <div className="mt-1">{row.recommendedRetryStep || row.blockedReason || row.suggestion || '-'}</div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs text-slate-500">暂无 SKU。</div>
                    )}
                  </div>
                ))}
              </div>
              <div className="overflow-x-auto rounded border border-slate-200">
                <table className="w-full min-w-[820px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
                      <th className="px-3 py-2 font-medium">顺序</th>
                      <th className="px-3 py-2 font-medium">SKU</th>
                      <th className="px-3 py-2 font-medium">推荐步骤</th>
                      <th className="px-3 py-2 font-medium">模式</th>
                      <th className="px-3 py-2 font-medium">付费 API 风险</th>
                      <th className="px-3 py-2 font-medium">建议</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batchResumePlanDisplay.orderedRows.length ? batchResumePlanDisplay.orderedRows.map((row) => (
                      <tr key={`${row.order}-${row.taskId}-${row.sku}`} className="border-b border-slate-100">
                        <td className="px-3 py-2">{row.order}</td>
                        <td className="px-3 py-2 font-medium text-ink">{row.sku || row.taskId}</td>
                        <td className="px-3 py-2">{row.recommendedRetryStep || '-'}</td>
                        <td className="px-3 py-2">{row.mode || 'mockOnly'}</td>
                        <td className="px-3 py-2">{row.paidApiRisk ? '是' : '否'}</td>
                        <td className="px-3 py-2 text-xs text-slate-600">{row.suggestion || row.blockedReason || '-'}</td>
                      </tr>
                    )) : (
                      <tr>
                        <td colSpan={6} className="px-3 py-4 text-center text-sm text-slate-500">暂无恢复计划项。</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {(batchResumePlanDisplay.warnings.length > 0 || batchResumePlanDisplay.recommendations.length > 0) && (
                <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                  {[...batchResumePlanDisplay.warnings, ...batchResumePlanDisplay.recommendations].join(' / ')}
                </div>
              )}
            </div>
          )}
        </Section>
      )}

      {batchTask && (
        <Section
          title="批量审核摘要"
          actions={(
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={exportBatchReviewReport}
              className="inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60"
            >
              <Download size={16} />
              导出批量审核报告 JSON
            </button>
          )}
        >
          {batchReviewDisplay.emptyText ? (
            <div className="rounded border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              {batchReviewDisplay.emptyText}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-6">
                {batchReviewDisplay.overviewCards.map((card) => (
                  <div key={card.label} className="rounded border border-slate-200 bg-white p-3">
                    <div className="text-xs text-slate-500">{card.label}</div>
                    <div className="mt-1 text-xl font-semibold text-ink">{card.value}</div>
                  </div>
                ))}
              </div>
              <div className="grid gap-3 md:grid-cols-4">
                {batchReviewDisplay.riskCards.map((card) => (
                  <div key={card.label} className="rounded border border-slate-200 bg-white p-3">
                    <div className="text-xs text-slate-500">{card.label}</div>
                    <div className="mt-1 text-lg font-semibold text-ink">{card.value}</div>
                  </div>
                ))}
              </div>
              <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                {batchReviewDisplay.mockInfoNotice || 'mock 提示仅表示流程测试信息，不代表真实平台上传失败。'}
              </div>
              <div className="rounded border border-slate-200 bg-slate-50 p-3">
                <div className="mb-3 text-sm font-semibold text-ink">批量修正建议摘要</div>
                <div className="grid gap-3 md:grid-cols-4">
                  {batchReviewDisplay.fixSummaryCards.map((card) => (
                    <div key={card.label} className="rounded border border-slate-200 bg-white p-3">
                      <div className="text-xs text-slate-500">{card.label}</div>
                      <div className="mt-1 text-lg font-semibold text-ink">{card.value}</div>
                    </div>
                  ))}
                </div>
                {batchReviewDisplay.fixActionRows.length > 0 && (
                  <div className="mt-3 rounded border border-slate-200 bg-white p-3 text-xs text-slate-700">
                    <div className="mb-1 font-semibold text-ink">按 actionType 统计</div>
                    {batchReviewDisplay.fixActionRows.map((row) => <div key={row.label}>{row.label}: {row.value}</div>)}
                  </div>
                )}
                {batchReviewDisplay.topFixSuggestions.length > 0 && (
                  <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                    <div className="mb-2 font-semibold">高风险 SKU 的 topFixSuggestions</div>
                    {batchReviewDisplay.topFixSuggestions.slice(0, 6).map((suggestion) => (
                      <div key={`${suggestion.sku}-${suggestion.suggestionId}`} className="mb-2 rounded bg-white p-2">
                        <div className="font-semibold">{suggestion.sku} - {suggestion.title}</div>
                        <div className="mt-1 text-xs">{suggestion.actionType} / {suggestion.severity}</div>
                      </div>
                    ))}
                  </div>
                )}
                {batchReviewDisplay.fixRecommendations.length > 0 && (
                  <div className="mt-3 text-xs text-slate-600">
                    {batchReviewDisplay.fixRecommendations.join(' / ')}
                  </div>
                )}
              </div>
              {batchReviewDisplay.recommendations.length > 0 && (
                <div className="rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
                  <div className="font-semibold">中文处理建议</div>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {batchReviewDisplay.recommendations.map((item, index) => <li key={index}>{item}</li>)}
                  </ul>
                </div>
              )}
              {batchReviewDisplay.topRiskSku.length > 0 && (
                <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                  <div className="mb-2 font-semibold">高风险 SKU</div>
                  <div className="space-y-2">
                    {batchReviewDisplay.topRiskSku.slice(0, 6).map((sku) => (
                      <div key={sku.taskId || sku.sku} className="rounded bg-white p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="font-semibold">{sku.sku || sku.taskId}</div>
                          <div className="text-xs">fatal {sku.fatalCount || 0} / high {sku.highCount || 0}</div>
                        </div>
                        <div className="mt-1 text-xs text-red-700">{sku.productName || '-'}</div>
                        {sku.topIssues?.length > 0 && (
                          <div className="mt-2 text-xs">
                            {sku.topIssues.map((issue) => `${issue.severity}: ${issue.title}`).join(' / ')}
                          </div>
                        )}
                        <div className="mt-1 text-xs">{sku.nextSuggestedAction}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded border border-slate-200 bg-white p-3 text-xs text-slate-700">
                  <div className="mb-2 text-sm font-semibold text-ink">问题代码统计</div>
                  {batchReviewDisplay.issueRows.length ? batchReviewDisplay.issueRows.map((row) => <div key={row.label}>{row.label}: {row.value}</div>) : '-'}
                </div>
                <div className="rounded border border-slate-200 bg-white p-3 text-xs text-slate-700">
                  <div className="mb-2 text-sm font-semibold text-ink">图片类型统计</div>
                  {Object.entries(batchReviewDisplay.issuesByImageType || {}).map(([key, value]) => <div key={key}>{key}: {value}</div>)}
                </div>
                <div className="rounded border border-slate-200 bg-white p-3 text-xs text-slate-700">
                  <div className="mb-2 text-sm font-semibold text-ink">mock 提示统计</div>
                  {Object.entries(batchReviewDisplay.mockInfoSummary || {}).map(([key, value]) => <div key={key}>{key}: {value}</div>)}
                </div>
              </div>
            </div>
          )}
        </Section>
      )}

      {batchTask && (
        <Section title="上架前资料包导出">
          <div className="space-y-4">
            <div className="rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
              上架前资料包只生成本地 ZIP 文件，不会提交到任何平台，不会调用真实 Provider。预览不会写入文件，生成 ZIP 前需要二次确认。
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="rounded border border-slate-200 bg-white p-3">
                <div className="mb-2 text-sm font-semibold text-ink">平台选择</div>
                <div className="flex flex-wrap gap-2">
                  {[
                    ['amazon', 'Amazon'],
                    ['temu', 'Temu'],
                    ['noon', 'Noon'],
                    ['ozon', 'Ozon'],
                    ['rakuten', 'Rakuten']
                  ].map(([platformId, label]) => (
                    <label key={platformId} className="inline-flex items-center gap-2 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={exportPackageOptions.platforms.includes(platformId)}
                        onChange={() => toggleExportPackagePlatform(platformId)}
                        className="accent-teal-700"
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
              <div className="rounded border border-slate-200 bg-white p-3">
                <div className="mb-2 text-sm font-semibold text-ink">导出内容</div>
                <div className="flex flex-wrap gap-3 text-sm text-slate-700">
                  <label className="inline-flex items-center gap-2">
                    <input type="checkbox" checked={exportPackageOptions.includeReports} onChange={(event) => updateExportPackageOption('includeReports', event.target.checked)} className="accent-teal-700" />
                    包含审核和生成报告
                  </label>
                  <label className="inline-flex items-center gap-2">
                    <input type="checkbox" checked={exportPackageOptions.includeMockImages} onChange={(event) => updateExportPackageOption('includeMockImages', event.target.checked)} className="accent-teal-700" />
                    包含 mock 图片
                  </label>
                  <label className="inline-flex items-center gap-2">
                    <input type="checkbox" checked={exportPackageOptions.includeRealSamples} onChange={(event) => updateExportPackageOption('includeRealSamples', event.target.checked)} className="accent-teal-700" />
                    包含真实小样本
                  </label>
                </div>
                <div className="mt-2 text-xs text-slate-500">mock 图片会在 manifest 中标记 sourceType=mock；缺失图片会标记 missing，不会中断整包导出。</div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={previewExportPackage}
                className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60"
              >
                预览导出包
              </button>
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={createExportPackageZip}
                className="rounded bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                生成上架前资料包 ZIP
              </button>
            </div>
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
              {exportPackageDisplay.emptyText || exportPackageDisplay.previewNotice}
            </div>
            {!exportPackageDisplay.emptyText && (
              <div className="space-y-4">
                <div className="grid gap-3 md:grid-cols-7">
                  {exportPackageDisplay.summaryCards.map((card) => (
                    <div key={card.label} className="rounded border border-slate-200 bg-white p-3">
                      <div className="text-xs text-slate-500">{card.label}</div>
                      <div className="mt-1 text-lg font-semibold text-ink">{card.value}</div>
                    </div>
                  ))}
                </div>
                {exportPackageDisplay.warningText && (
                  <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{exportPackageDisplay.warningText}</div>
                )}
                {exportPackageDisplay.resultText && (
                  <div className="rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
                    <div>{exportPackageDisplay.resultText}</div>
                    {buildExportPackageDownloadUrl(exportPackageResult?.relativePath) && (
                      <a href={buildExportPackageDownloadUrl(exportPackageResult.relativePath)} className="mt-2 inline-flex items-center gap-2 rounded bg-emerald-700 px-3 py-2 text-sm font-semibold text-white">
                        <Download size={16} />
                        下载资料包 ZIP
                      </a>
                    )}
                  </div>
                )}
                <div className="rounded border border-slate-200 bg-white p-3">
                  <div className="mb-2 text-sm font-semibold text-ink">预览目录结构</div>
                  {exportPackageDisplay.treeRows.length ? (
                    <div className="max-h-72 overflow-auto text-xs text-slate-600">
                      {exportPackageDisplay.treeRows.map((row, index) => (
                        <div key={`${row.path}-${index}`} className="flex justify-between gap-3 border-b border-slate-100 py-1">
                          <span>{row.path}</span>
                          <span>{row.status} / {row.sourceTypeDisplay || row.sourceType}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-slate-500">暂无目录预览，请先点击“预览导出包”。</div>
                  )}
                </div>
                <div className="grid gap-3 lg:grid-cols-2">
                  <div className="rounded border border-slate-200 bg-white p-3 text-xs text-slate-700">
                    <div className="mb-2 text-sm font-semibold text-ink">报告文件</div>
                    {exportPackageDisplay.reportsText}
                  </div>
                  <div className="rounded border border-slate-200 bg-white p-3 text-xs text-slate-700">
                    <div className="mb-2 text-sm font-semibold text-ink">失败 SKU</div>
                    {exportPackageDisplay.failedSkuRows.length ? exportPackageDisplay.failedSkuRows.map((sku) => (
                      <div key={`${sku.taskId}-${sku.sku}`} className="mb-1">{sku.sku || sku.taskId}: {sku.failedStep} / {sku.nextSuggestedAction}</div>
                    )) : '暂无失败 SKU'}
                  </div>
                </div>
              </div>
            )}
          </div>
        </Section>
      )}

      {batchTask && (
        <Section title="平台凭据与上传安全检查">
          <div className="space-y-4">
            <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              {uploadSafetyNotice}
              <div className="mt-1 text-xs">
                localStorage 仅用于 dry-run UI 体验，当前系统不会把 localStorage 配置提交到真实平台，也不会写入数据库。
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={refreshUploadSafetyReport}
                className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60"
              >
                刷新凭据状态
              </button>
              <button
                type="button"
                disabled={!uploadSafetyReport || Boolean(busy)}
                onClick={exportUploadSafetyReport}
                className="rounded bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                导出上传安全检查报告 JSON
              </button>
            </div>
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
              {uploadSafetyDisplay.emptyText || uploadSafetyDisplay.notice}
            </div>
            {!uploadSafetyDisplay.emptyText && (
              <div className="space-y-4">
                <div className="grid gap-3 md:grid-cols-6">
                  {uploadSafetyDisplay.summaryCards.map((card) => (
                    <div key={card.label} className="rounded border border-slate-200 bg-white p-3">
                      <div className="text-xs text-slate-500">{card.label}</div>
                      <div className="mt-1 text-lg font-semibold text-ink">{card.value}</div>
                    </div>
                  ))}
                </div>
                <div className="rounded border border-slate-200 bg-white p-3">
                  <div className="mb-2 text-sm font-semibold text-ink">平台凭据状态</div>
                  {uploadSafetyDisplay.platformRows.length ? (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[980px] border-collapse text-xs">
                        <thead>
                          <tr className="border-b border-slate-200 text-left text-slate-500">
                            <th className="py-2 pr-3">平台</th>
                            <th className="py-2 pr-3">dry-run</th>
                            <th className="py-2 pr-3">真实上传</th>
                            <th className="py-2 pr-3">状态</th>
                            <th className="py-2 pr-3">必需变量名</th>
                            <th className="py-2 pr-3">已配置变量</th>
                            <th className="py-2 pr-3">缺失变量</th>
                            <th className="py-2 pr-3">风险提示</th>
                          </tr>
                        </thead>
                        <tbody>
                          {uploadSafetyDisplay.platformRows.map((row) => (
                            <tr key={row.platformId} className="border-b border-slate-100">
                              <td className="py-2 pr-3 font-medium text-ink">{row.platformName || row.platformId}</td>
                              <td className="py-2 pr-3 text-slate-700">{row.sandboxText}</td>
                              <td className="py-2 pr-3 text-slate-700">{row.realUploadText}</td>
                              <td className="py-2 pr-3 text-slate-700">{row.configuredText}</td>
                              <td className="py-2 pr-3 text-slate-600">{row.requiredVariablesText}</td>
                              <td className="py-2 pr-3 text-slate-600">{row.configuredVariablesText}</td>
                              <td className="py-2 pr-3 text-slate-600">{row.missingVariablesText}</td>
                              <td className="py-2 pr-3 text-slate-600">{row.warningText || '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="text-sm text-slate-500">暂无平台凭据状态。</div>
                  )}
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-800">
                    <div className="mb-1 font-semibold">安全发现</div>
                    {uploadSafetyDisplay.findingText || '暂无'}
                  </div>
                  <div className="rounded border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
                    <div className="mb-1 font-semibold">建议</div>
                    {uploadSafetyDisplay.recommendationText || '暂无'}
                  </div>
                  <div className="rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                    <div className="mb-1 font-semibold">下一步</div>
                    {uploadSafetyDisplay.nextSuggestedAction || '继续 dry-run。'}
                  </div>
                </div>
              </div>
            )}
          </div>
        </Section>
      )}

      {batchTask && (
        <Section title="平台上传前检查">
          <div className="space-y-4">
            <div className="rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
              {uploadReadinessNotice}
            </div>
            <div className="rounded border border-teal-200 bg-teal-50 p-3 text-sm text-teal-800">
              {uploadSandboxNotice}
            </div>
            <div className="rounded border border-slate-200 bg-white p-3">
              <div className="mb-2 text-sm font-semibold text-ink">平台选择</div>
              <div className="flex flex-wrap gap-2">
                {[
                  ['temu', 'Temu'],
                  ['miaoshou', '妙手'],
                  ['amazon', 'Amazon（预留）'],
                  ['noon', 'Noon（预留）'],
                  ['ozon', 'Ozon（预留）'],
                  ['rakuten', 'Rakuten（预留）']
                ].map(([platformId, label]) => (
                  <label key={platformId} className="inline-flex items-center gap-2 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={uploadReadinessOptions.platforms.includes(platformId)}
                      onChange={() => toggleUploadReadinessPlatform(platformId)}
                      className="accent-teal-700"
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
            <div className="rounded border border-slate-200 bg-white p-3">
              <div className="mb-2 text-sm font-semibold text-ink">沙盒账号配置（仅本机保存）</div>
              <div className="grid gap-3 md:grid-cols-2">
                {[
                  ['temu', 'Temu'],
                  ['miaoshou', '妙手']
                ].map(([platformId, label]) => (
                  <div key={platformId} className="rounded border border-slate-200 bg-slate-50 p-3">
                    <div className="mb-2 text-sm font-semibold text-ink">{label}</div>
                    <label className="mb-2 block text-xs text-slate-600">
                      账号备注
                      <input
                        value={uploadSandboxConfig[platformId]?.accountName || ''}
                        onChange={(event) => updateUploadSandboxConfig(platformId, { accountName: event.target.value })}
                        className="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"
                      />
                    </label>
                    <label className="block text-xs text-slate-600">
                      访问凭据（仅用于沙盒 dry-run 配置存在性检查）
                      <input
                        type="password"
                        value={uploadSandboxConfig[platformId]?.credential || ''}
                        onChange={(event) => updateUploadSandboxConfig(platformId, { credential: event.target.value })}
                        className="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"
                      />
                    </label>
                  </div>
                ))}
              </div>
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={saveUploadSandboxConfigToLocal}
                className="mt-3 rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60"
              >
                保存到本机浏览器
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={previewUploadReadiness}
                className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60"
              >
                执行上传前检查
              </button>
              <button
                type="button"
                disabled={!uploadReadinessReport || Boolean(busy)}
                onClick={exportUploadReadinessReport}
                className="inline-flex items-center gap-2 rounded bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                <Download size={16} />
                导出 JSON
              </button>
            </div>
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
              {uploadReadinessDisplay.emptyText || uploadReadinessDisplay.notice}
            </div>
            {!uploadReadinessDisplay.emptyText && (
              <div className="space-y-4">
                <div className="grid gap-3 md:grid-cols-5">
                  {uploadReadinessDisplay.summaryCards.map((card) => (
                    <div key={card.label} className="rounded border border-slate-200 bg-white p-3">
                      <div className="text-xs text-slate-500">{card.label}</div>
                      <div className="mt-1 text-lg font-semibold text-ink">{card.value}</div>
                    </div>
                  ))}
                </div>
                <div className="grid gap-3 lg:grid-cols-3">
                  <div className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-800">
                    <div className="mb-1 font-semibold">阻断问题</div>
                    {uploadReadinessDisplay.blockingText || '暂无'}
                  </div>
                  <div className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                    <div className="mb-1 font-semibold">提醒</div>
                    {uploadReadinessDisplay.warningText || '暂无'}
                  </div>
                  <div className="rounded border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
                    <div className="mb-1 font-semibold">建议</div>
                    {uploadReadinessDisplay.recommendationText || uploadReadinessDisplay.nextSuggestedAction || '暂无'}
                  </div>
                </div>
                <div className="rounded border border-slate-200 bg-white p-3">
                  <div className="mb-2 text-sm font-semibold text-ink">平台报告</div>
                  {uploadReadinessDisplay.platformRows.length ? (
                    <div className="grid gap-3 md:grid-cols-3">
                      {uploadReadinessDisplay.platformRows.map((row) => (
                        <div key={row.platformId} className="rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                          <div className="font-semibold text-ink">{row.platformName || row.platformId}</div>
                          <div className="mt-1">mode: {row.mode} / provider: {row.provider}</div>
                          <div className="mt-1">ready {row.readySku || 0} / blocked {row.blockedSku || 0} / warning {row.warningSku || 0}</div>
                          <div className="mt-1">realUploadEnabled: {String(row.realUploadEnabled === true)}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-slate-500">暂无平台报告。</div>
                  )}
                </div>
                <div className="rounded border border-slate-200 bg-white p-3">
                  <div className="mb-2 text-sm font-semibold text-ink">SKU 检查结果</div>
                  {uploadReadinessDisplay.skuRows.length ? (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[900px] border-collapse text-xs">
                        <thead>
                          <tr className="border-b border-slate-200 text-left text-slate-500">
                            <th className="py-2 pr-3 font-medium">SKU</th>
                            <th className="py-2 pr-3 font-medium">平台</th>
                            <th className="py-2 pr-3 font-medium">状态</th>
                            <th className="py-2 pr-3 font-medium">审核</th>
                            <th className="py-2 pr-3 font-medium">缺字段</th>
                            <th className="py-2 pr-3 font-medium">缺图片</th>
                            <th className="py-2 pr-3 font-medium">mock</th>
                            <th className="py-2 pr-3 font-medium">高风险</th>
                          </tr>
                        </thead>
                        <tbody>
                          {uploadReadinessDisplay.skuRows.map((row, index) => (
                            <tr key={`${row.sku}-${row.platformId}-${index}`} className="border-b border-slate-100">
                              <td className="py-2 pr-3 font-medium text-ink">{row.sku}</td>
                              <td className="py-2 pr-3 text-slate-700">{row.platformId}</td>
                              <td className="py-2 pr-3 text-slate-700">{row.status}</td>
                              <td className="py-2 pr-3 text-slate-700">{row.reviewStatus}</td>
                              <td className="py-2 pr-3 text-slate-600">{row.missingFieldsText}</td>
                              <td className="py-2 pr-3 text-slate-600">{row.missingImagesText}</td>
                              <td className="py-2 pr-3 text-slate-600">{String(row.usesMockImages === true)}</td>
                              <td className="py-2 pr-3 text-slate-600">{String(row.hasHighRiskIssues === true)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="text-sm text-slate-500">暂无 SKU 检查结果。</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </Section>
      )}

      {batchTask && (
        <Section title="上传 Payload 预览 / 沙盒模拟">
          <div className="space-y-4">
            <div className="rounded border border-teal-200 bg-teal-50 p-3 text-sm text-teal-800">
              {uploadPayloadNotice}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={previewUploadPayload}
                className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60"
              >
                生成 Payload 预览
              </button>
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={simulateUploadSandbox}
                className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60"
              >
                执行沙盒提交模拟
              </button>
              <button
                type="button"
                disabled={!uploadPayloadPreview || Boolean(busy)}
                onClick={exportUploadPayloadPreview}
                className="rounded bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                导出 Payload JSON
              </button>
              <button
                type="button"
                disabled={!uploadSandboxReport || Boolean(busy)}
                onClick={exportUploadSandboxReport}
                className="rounded bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                导出沙盒报告 JSON
              </button>
            </div>
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
              {uploadPayloadDisplay.emptyText || uploadPayloadDisplay.notice}
            </div>
            {!uploadPayloadDisplay.emptyText && (
              <div className="space-y-4">
                <div className="grid gap-3 md:grid-cols-6">
                  {uploadPayloadDisplay.summaryCards.map((card) => (
                    <div key={card.label} className="rounded border border-slate-200 bg-white p-3">
                      <div className="text-xs text-slate-500">{card.label}</div>
                      <div className="mt-1 text-lg font-semibold text-ink">{card.value}</div>
                    </div>
                  ))}
                </div>
                <div className="rounded border border-slate-200 bg-white p-3">
                  <div className="mb-2 text-sm font-semibold text-ink">Payload SKU 预览</div>
                  {uploadPayloadDisplay.skuRows.length ? (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[960px] border-collapse text-xs">
                        <thead>
                          <tr className="border-b border-slate-200 text-left text-slate-500">
                            <th className="py-2 pr-3 font-medium">platform</th>
                            <th className="py-2 pr-3 font-medium">SKU</th>
                            <th className="py-2 pr-3 font-medium">status</th>
                            <th className="py-2 pr-3 font-medium">将提交字段</th>
                            <th className="py-2 pr-3 font-medium">图片数</th>
                            <th className="py-2 pr-3 font-medium">missingFields</th>
                            <th className="py-2 pr-3 font-medium">blockedFields</th>
                            <th className="py-2 pr-3 font-medium">warnings</th>
                            <th className="py-2 pr-3 font-medium">riskNotes</th>
                          </tr>
                        </thead>
                        <tbody>
                          {uploadPayloadDisplay.skuRows.map((row, index) => (
                            <tr key={`${row.platformId}-${row.sku}-${index}`} className="border-b border-slate-100">
                              <td className="py-2 pr-3 text-slate-700">{row.platformId}</td>
                              <td className="py-2 pr-3 font-medium text-ink">{row.sku}</td>
                              <td className="py-2 pr-3 text-slate-700">{row.status}</td>
                              <td className="py-2 pr-3 text-slate-600">{row.fieldSummary || '-'}</td>
                              <td className="py-2 pr-3 text-slate-600">{row.imageCount}</td>
                              <td className="py-2 pr-3 text-slate-600">{row.missingFieldsText}</td>
                              <td className="py-2 pr-3 text-slate-600">{row.blockedFieldsText}</td>
                              <td className="py-2 pr-3 text-slate-600">{row.warningText || '-'}</td>
                              <td className="py-2 pr-3 text-slate-600">{row.riskNotesText}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="text-sm text-slate-500">暂无 Payload SKU 预览。</div>
                  )}
                </div>
              </div>
            )}
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
              {uploadSandboxDisplay.emptyText || uploadSandboxDisplay.notice}
            </div>
            {!uploadSandboxDisplay.emptyText && (
              <div className="space-y-4">
                <div className="grid gap-3 md:grid-cols-6">
                  {uploadSandboxDisplay.summaryCards.map((card) => (
                    <div key={card.label} className="rounded border border-slate-200 bg-white p-3">
                      <div className="text-xs text-slate-500">{card.label}</div>
                      <div className="mt-1 text-lg font-semibold text-ink">{card.value}</div>
                    </div>
                  ))}
                </div>
                <div className="rounded border border-slate-200 bg-white p-3">
                  <div className="mb-2 text-sm font-semibold text-ink">沙盒模拟结果</div>
                  {uploadSandboxDisplay.resultRows.length ? (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[920px] border-collapse text-xs">
                        <thead>
                          <tr className="border-b border-slate-200 text-left text-slate-500">
                            <th className="py-2 pr-3 font-medium">platform</th>
                            <th className="py-2 pr-3 font-medium">SKU</th>
                            <th className="py-2 pr-3 font-medium">simulatedStatus</th>
                            <th className="py-2 pr-3 font-medium">sandboxRequestId</th>
                            <th className="py-2 pr-3 font-medium">uploaded</th>
                            <th className="py-2 pr-3 font-medium">realNetworkCalled</th>
                            <th className="py-2 pr-3 font-medium">externalApiCalled</th>
                            <th className="py-2 pr-3 font-medium">warnings</th>
                          </tr>
                        </thead>
                        <tbody>
                          {uploadSandboxDisplay.resultRows.map((row, index) => (
                            <tr key={`${row.platformId}-${row.sku}-${index}`} className="border-b border-slate-100">
                              <td className="py-2 pr-3 text-slate-700">{row.platformId}</td>
                              <td className="py-2 pr-3 font-medium text-ink">{row.sku}</td>
                              <td className="py-2 pr-3 text-slate-700">{row.simulatedStatus}</td>
                              <td className="py-2 pr-3 text-slate-600">{row.sandboxRequestId}</td>
                              <td className="py-2 pr-3 text-slate-600">{row.uploadedText}</td>
                              <td className="py-2 pr-3 text-slate-600">{row.realNetworkCalledText}</td>
                              <td className="py-2 pr-3 text-slate-600">{row.externalApiCalledText}</td>
                              <td className="py-2 pr-3 text-slate-600">{row.warningText || '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="text-sm text-slate-500">暂无沙盒模拟结果。</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </Section>
      )}

      {batchTask && (
        <Section title="平台上架表格 / CSV 导出">
          <div className="space-y-4">
            <div className="rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
              {listingExportNotice}
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="rounded border border-slate-200 bg-white p-3">
                <div className="mb-2 text-sm font-semibold text-ink">平台选择</div>
                <div className="flex flex-wrap gap-2">
                  {[
                    ['amazon', 'Amazon'],
                    ['temu', 'Temu'],
                    ['noon', 'Noon（占位）'],
                    ['ozon', 'Ozon（占位）'],
                    ['rakuten', 'Rakuten（占位）']
                  ].map(([platformId, label]) => (
                    <label key={platformId} className="inline-flex items-center gap-2 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={listingExportOptions.platforms.includes(platformId)}
                        onChange={() => toggleListingExportPlatform(platformId)}
                        className="accent-teal-700"
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
              <div className="rounded border border-slate-200 bg-white p-3">
                <div className="mb-2 text-sm font-semibold text-ink">CSV 选项</div>
                <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={listingExportOptions.includeMockImages}
                    onChange={(event) => updateListingExportOption('includeMockImages', event.target.checked)}
                    className="accent-teal-700"
                  />
                  includeMockImages
                </label>
                <div className="mt-2 text-xs text-slate-500">图片路径使用资料包内相对路径；缺证据、冲突或 AI 推测字段会留空并进入 risk notes。</div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={previewListingCsv}
                className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60"
              >
                预览 CSV
              </button>
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={createListingCsv}
                className="rounded bg-ink px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                生成 CSV
              </button>
            </div>
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
              {listingExportDisplay.emptyText || listingExportDisplay.notice}
            </div>
            {listingExportError && (
              <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                {listingExportError}
              </div>
            )}
            {!listingExportDisplay.emptyText && (
              <div className="space-y-4">
                {listingExportDisplay.resultText && (
                  <div className="rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
                    CSV 已生成：{listingExportDisplay.resultText}
                  </div>
                )}
                <div className="grid gap-3 md:grid-cols-5">
                  {listingExportDisplay.platformRows.map((row) => (
                    <div key={row.platform} className="rounded border border-slate-200 bg-white p-3">
                      <div className="text-xs text-slate-500">{row.platform}</div>
                      <div className="mt-1 text-lg font-semibold text-ink">{row.rows}</div>
                    </div>
                  ))}
                </div>
                <div className="grid gap-3 lg:grid-cols-3">
                  <div className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                    <div className="mb-1 font-semibold">缺失字段</div>
                    {listingExportDisplay.missingText}
                  </div>
                  <div className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-800">
                    <div className="mb-1 font-semibold">blocked 字段</div>
                    {listingExportDisplay.blockedText}
                  </div>
                  <div className="rounded border border-slate-200 bg-white p-3 text-xs text-slate-700">
                    <div className="mb-1 font-semibold">noReview SKU</div>
                    {listingExportDisplay.noReviewText}
                  </div>
                </div>
                {listingExportDisplay.warningText && (
                  <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{listingExportDisplay.warningText}</div>
                )}
                {listingExportDisplay.recommendationText && (
                  <div className="rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">{listingExportDisplay.recommendationText}</div>
                )}
                <div className="rounded border border-slate-200 bg-white p-3">
                  <div className="mb-2 text-sm font-semibold text-ink">CSV 文件列表</div>
                  {listingExportDisplay.fileRows.length ? (
                    <div className="space-y-2 text-sm text-slate-700">
                      {listingExportDisplay.fileRows.map((file) => (
                        <div key={`${file.platform}-${file.fileName}`} className="flex flex-wrap items-center justify-between gap-2 rounded bg-slate-50 p-2">
                          <span>{file.fileName}</span>
                          {buildListingCsvDownloadUrl(file.relativePath) ? (
                            <a href={buildListingCsvDownloadUrl(file.relativePath)} download={file.fileName} className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700">下载</a>
                          ) : (
                            <span className="text-xs text-slate-400">预览</span>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-slate-500">暂无 CSV 文件，请先预览或生成。</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </Section>
      )}

      {batchTask && (
        <Section title="高级操作">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-slate-600">队列执行、结果看板、成本统计、执行日志和手动批量按钮仍然保留在高级模式中。</div>
            <button type="button" onClick={() => setShowAdvanced((value) => !value)} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700">
              {showAdvanced ? '收起高级操作' : '展开高级操作'}
            </button>
          </div>
        </Section>
      )}

      {batchTask && (
        <Section title="操作手册 / SOP">
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={Boolean(busy)} onClick={loadBatchSop} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60">查看当前 batch SOP</button>
            <a href={api.batchSopDownloadUrl(batchTask.id)} className="rounded bg-ink px-3 py-2 text-sm font-semibold text-white">下载当前 batch SOP</a>
            <a href={api.generalSopDownloadUrl()} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700">下载通用 SOP</a>
          </div>
          <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
            SOP 会根据当前向导步骤、失败分类、成本统计和审核风险生成下一步清单，不包含 .env 或任何 API Key。
          </div>
          {sopMarkdown && (
            <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded border border-slate-200 bg-white p-4 text-xs text-slate-700">
              {sopMarkdown}
            </pre>
          )}
        </Section>
      )}

      {batchTask && showAdvanced && (
        <Section title="结果看板与成本统计">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm text-slate-500">统计来自当前 batch 关联的单 SKU task。成本是本地预估，不代表真实账单。</div>
            <button type="button" disabled={Boolean(busy)} onClick={refreshAnalytics} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60">刷新统计</button>
          </div>
          {analytics ? (
            <div className="mt-4 space-y-4">
              <div className="grid gap-3 md:grid-cols-5">
                <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">总 SKU</div><div className="mt-1 font-semibold text-ink">{analytics.sku?.total || 0}</div></div>
                <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">已完成</div><div className="mt-1 font-semibold text-ink">{analytics.sku?.completed || 0}</div></div>
                <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">失败</div><div className="mt-1 font-semibold text-red-700">{analytics.sku?.failed || 0}</div></div>
                <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">待确认</div><div className="mt-1 font-semibold text-amber-700">{analytics.sku?.waitingConfirm || 0}</div></div>
                <div className="rounded border border-slate-200 p-3"><div className="text-xs text-slate-500">跳过</div><div className="mt-1 font-semibold text-slate-700">{analytics.sku?.skipped || 0}</div></div>
              </div>
              <div className="grid gap-3 md:grid-cols-4">
                <div className="rounded border border-slate-200 p-3">
                  <div className="text-xs text-slate-500">图片生成</div>
                  <div className="mt-1 text-sm text-slate-700">总数 {analytics.images?.totalGenerated || 0} / mock {analytics.images?.mockPreviewCount || 0} / real {analytics.images?.realGeneratedCount || 0} / fallback {analytics.images?.fallbackMockCount || 0}</div>
                  <div className="mt-2 text-xs text-slate-500">{Object.entries(analytics.images?.byImageType || {}).map(([type, count]) => `${type}: ${count}`).join(' / ') || '-'}</div>
                </div>
                <div className="rounded border border-slate-200 p-3">
                  <div className="text-xs text-slate-500">审核风险</div>
                  <div className="mt-1 text-sm text-slate-700">pass {analytics.review?.passCount || 0} / fail {analytics.review?.failCount || 0}</div>
                  <div className="mt-2 text-xs text-slate-500">high {analytics.review?.highRiskCount || 0} / medium {analytics.review?.mediumRiskCount || 0} / low {analytics.review?.lowRiskCount || 0}</div>
                </div>
                <div className="rounded border border-slate-200 p-3">
                  <div className="text-xs text-slate-500">耗时</div>
                  <div className="mt-1 text-sm text-slate-700">总计 {formatDuration(analytics.duration?.totalMs)} / 平均 {formatDuration(analytics.duration?.averagePerSkuMs)}</div>
                  <div className="mt-2 text-xs text-slate-500">最慢 {analytics.duration?.slowestSku?.skuId || '-'} / 最快 {analytics.duration?.fastestSku?.skuId || '-'}</div>
                </div>
                <div className="rounded border border-slate-200 p-3">
                  <div className="text-xs text-slate-500">预估成本</div>
                  <div className="mt-1 text-sm font-semibold text-ink">{formatMoney(analytics.cost?.estimatedTotal, analytics.cost?.currency)}</div>
                  <div className="mt-2 text-xs text-slate-500">vision {formatMoney(analytics.cost?.byAction?.vision, analytics.cost?.currency)} / image {formatMoney(analytics.cost?.byAction?.image, analytics.cost?.currency)} / review {formatMoney(analytics.cost?.byAction?.review, analytics.cost?.currency)}</div>
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-4">
                <div className="rounded border border-slate-200 p-3 text-xs"><div className="mb-1 font-semibold text-ink">Vision Provider</div>{providerSummary(analytics.providers?.vision)}</div>
                <div className="rounded border border-slate-200 p-3 text-xs"><div className="mb-1 font-semibold text-ink">Image Provider</div>{providerSummary(analytics.providers?.image)}</div>
                <div className="rounded border border-slate-200 p-3 text-xs"><div className="mb-1 font-semibold text-ink">Review Provider</div>{providerSummary(analytics.providers?.review)}</div>
                <div className="rounded border border-slate-200 p-3 text-xs"><div className="mb-1 font-semibold text-ink">Matting Provider</div>{providerSummary(analytics.providers?.matting)}</div>
              </div>
              <div className="rounded border border-slate-200 p-3 text-xs text-slate-700">
                <div className="mb-2 text-sm font-semibold text-ink">失败原因分析</div>
                <div>失败总数：{analytics.failureSummary?.totalFailed || 0} / 可重试：{analytics.failureSummary?.retryableCount || 0} / 需人工处理：{analytics.failureSummary?.requiresUserActionCount || 0}</div>
                <div className="mt-1">按分类：{Object.entries(analytics.failureSummary?.byCategory || {}).map(([key, value]) => `${key}: ${value}`).join(' / ') || '-'}</div>
                <div className="mt-1">按错误码：{Object.entries(analytics.failureSummary?.byCode || {}).map(([key, value]) => `${key}: ${value}`).join(' / ') || '-'}</div>
                <div className="mt-1">处理建议：{Object.entries(analytics.failureSummary?.userActionTypes || {}).map(([key, value]) => `${key}: ${value}`).join(' / ') || '-'}</div>
              </div>
              {analytics.warnings?.length > 0 && (
                <div className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                  {analytics.warnings.map((warning) => <div key={warning.code}>{warning.message}</div>)}
                </div>
              )}
            </div>
          ) : (
            <div className="mt-4 text-sm text-slate-500">暂无统计，点击“刷新统计”生成当前批量任务看板。</div>
          )}
        </Section>
      )}

      {batchTask && showAdvanced && (
        <Section title={`批量进度：${batchTask.name}`}>
          <div className="grid gap-3 md:grid-cols-5">
            <div className="rounded border border-slate-200 p-3">
              <div className="text-xs text-slate-500">状态</div>
              <div className="mt-1 font-semibold text-ink">{statusLabels[batchTask.status] || batchTask.status}</div>
            </div>
            <div className="rounded border border-slate-200 p-3">
              <div className="text-xs text-slate-500">总 SKU</div>
              <div className="mt-1 font-semibold text-ink">{summary.totalSku || 0}</div>
            </div>
            <div className="rounded border border-slate-200 p-3">
              <div className="text-xs text-slate-500">待确认</div>
              <div className="mt-1 font-semibold text-ink">{summary.waitingConfirmSku || 0}</div>
            </div>
            <div className="rounded border border-slate-200 p-3">
              <div className="text-xs text-slate-500">失败</div>
              <div className="mt-1 font-semibold text-ink">{summary.failedSku || 0}</div>
            </div>
            <div className="rounded border border-slate-200 p-3">
              <div className="text-xs text-slate-500">图片总数</div>
              <div className="mt-1 font-semibold text-ink">{summary.totalImages || 0}</div>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <PrimaryButton busy={busy === 'recognize'} onClick={() => runAction('recognize', api.batchRecognize)}><Play size={16} />批量识别</PrimaryButton>
            <button type="button" disabled={Boolean(busy)} onClick={() => runAction('apply-targets', (id) => api.batchApplyTargets(id, defaultTargets))} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60">应用平台 targets</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => runAction('plan', api.batchPlan)} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60">批量生成方案</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => runAction('generate', (id) => api.batchGenerate(id, { mode: 'mock' }))} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60">批量生成图片</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => runAction('review', (id) => api.batchReview(id, { mode: 'mock' }))} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60">批量审核</button>
            <a href={api.batchExportUrl(batchTask.id)} className="inline-flex items-center gap-2 rounded bg-coral px-3 py-2 text-sm font-semibold text-white">
              <Download size={16} />
              批量导出 ZIP
            </a>
          </div>
          <div className="mt-2 text-xs text-slate-500">批量操作会自动跳过状态不符合的 SKU；识别后仍需逐个打开商品确认页人工确认。</div>
          <ResultList results={results} />
        </Section>
      )}

      {batchTask && showAdvanced && (
        <Section title="队列执行面板">
          <div className="grid gap-3 md:grid-cols-6">
            <div className="rounded border border-slate-200 p-3">
              <div className="text-xs text-slate-500">队列状态</div>
              <div className="mt-1 font-semibold text-ink">{statusLabels[queue.status] || queue.status || 'idle'}</div>
            </div>
            <div className="rounded border border-slate-200 p-3">
              <div className="text-xs text-slate-500">当前 action</div>
              <div className="mt-1 font-semibold text-ink">{queue.action || '-'}</div>
            </div>
            <div className="rounded border border-slate-200 p-3">
              <div className="text-xs text-slate-500">并发数</div>
              <div className="mt-1 font-semibold text-ink">{queue.concurrency || queueConcurrency}</div>
            </div>
            <div className="rounded border border-slate-200 p-3">
              <div className="text-xs text-slate-500">pending / running</div>
              <div className="mt-1 font-semibold text-ink">{queue.pendingJobs || 0} / {queue.runningJobs || 0}</div>
            </div>
            <div className="rounded border border-slate-200 p-3">
              <div className="text-xs text-slate-500">completed / failed</div>
              <div className="mt-1 font-semibold text-ink">{queue.completedJobs || 0} / {queue.failedJobs || 0}</div>
            </div>
            <div className="rounded border border-slate-200 p-3">
              <div className="text-xs text-slate-500">skipped</div>
              <div className="mt-1 font-semibold text-ink">{queue.skippedJobs || 0}</div>
            </div>
          </div>

          <div className="mt-4 h-3 overflow-hidden rounded bg-slate-100">
            <div className="h-full bg-mint transition-all" style={{ width: `${progressPercent}%` }} />
          </div>
          <div className="mt-1 text-xs text-slate-500">进度：{progressDone} / {progressTotal}（{progressPercent}%）</div>

          <div className="mt-4 grid gap-3 md:grid-cols-4">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-600">队列 action</span>
              <select value={queueAction} onChange={(event) => setQueueAction(event.target.value)} disabled={queueRunning} className="w-full rounded border border-slate-300 bg-white px-2 py-2 text-sm">
                <option value="prepare">启动当前 batch（识别+确认+方案）</option>
                <option value="recognize">批量识别</option>
                <option value="plan">批量方案</option>
                <option value="generate">批量生成图片</option>
                <option value="review">批量审核</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-600">模式</span>
              <select value={queueMode} onChange={(event) => setQueueMode(event.target.value)} disabled={queueRunning} className="w-full rounded border border-slate-300 bg-white px-2 py-2 text-sm">
                <option value="mock">mock</option>
                <option value="real">real review / provider</option>
                <option value="real-test">real-test：真实识别 / 真实生图 / 真实审核，上传仍为 dry-run</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-600">并发数</span>
              <input type="number" min="1" max="4" value={queueConcurrency} onChange={(event) => setQueueConcurrency(event.target.value)} disabled={queueRunning} className="w-full rounded border border-slate-300 bg-white px-2 py-2 text-sm" />
            </label>
            <div className="flex items-end">
              <button
                type="button"
                disabled={Boolean(busy) || queueRunning}
                onClick={() => queueRequest('queue-start', (id) => api.startBatchQueue(id, { action: queueAction, concurrency: Number(queueConcurrency), mode: queueMode }))}
                className="w-full rounded bg-ink px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
              >
                开始队列
              </button>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" disabled={!queueRunning || Boolean(busy)} onClick={() => queueRequest('queue-pause', api.pauseBatchQueue)} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60">暂停</button>
            <button type="button" disabled={!queuePaused || Boolean(busy)} onClick={() => queueRequest('queue-resume', api.resumeBatchQueue)} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60">恢复</button>
            <button type="button" disabled={(!queueRunning && !queuePaused) || Boolean(busy)} onClick={() => queueRequest('queue-cancel', api.cancelBatchQueue)} className="rounded border border-red-300 bg-white px-3 py-2 text-sm font-medium text-red-700 disabled:opacity-60">取消</button>
            <button type="button" disabled={Boolean(busy) || queueRunning} onClick={() => queueRequest('queue-retry', (id) => api.retryFailedBatchQueue(id, { action: queueAction, concurrency: Number(queueConcurrency), mode: queueMode }))} className="rounded border border-amber-300 bg-white px-3 py-2 text-sm font-medium text-amber-700 disabled:opacity-60">重试失败</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => queueRequest('logs', async (id) => ({ batchTask, ...(await api.getBatchLogs(id)) }))} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60">刷新日志</button>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" disabled={Boolean(busy) || queueRunning} onClick={() => queueRequest('queue-retry-timeout', (id) => api.retryFailedBatchQueue(id, { action: queueAction, concurrency: Number(queueConcurrency), mode: queueMode, filter: 'timeout' }))} className="rounded border border-amber-300 bg-white px-3 py-2 text-sm font-medium text-amber-700 disabled:opacity-60">只重试 timeout</button>
            <button type="button" disabled={Boolean(busy) || queueRunning} onClick={() => queueRequest('queue-retry-parse', (id) => api.retryFailedBatchQueue(id, { action: queueAction, concurrency: Number(queueConcurrency), mode: queueMode, filter: 'parse_error' }))} className="rounded border border-amber-300 bg-white px-3 py-2 text-sm font-medium text-amber-700 disabled:opacity-60">只重试 parse error</button>
            <button type="button" disabled={Boolean(busy) || queueRunning} onClick={() => queueRequest('queue-retry-all', (id) => api.retryFailedBatchQueue(id, { action: queueAction, concurrency: Number(queueConcurrency), mode: queueMode, filter: 'all' }))} className="rounded border border-red-300 bg-white px-3 py-2 text-sm font-medium text-red-700 disabled:opacity-60">重试所有失败</button>
          </div>

          <div className="mt-4 rounded border border-slate-200 bg-slate-50 p-3">
            <div className="mb-2 text-sm font-semibold text-ink">执行日志</div>
            {logs.length === 0 ? (
              <div className="text-xs text-slate-500">暂无日志。</div>
            ) : (
              <div className="max-h-64 space-y-1 overflow-auto text-xs">
                {logs.slice().reverse().slice(0, 80).map((log) => (
                  <div key={log.id} className={[
                    'rounded bg-white px-2 py-1',
                    log.level === 'error' && 'text-red-700',
                    log.level === 'warn' && 'text-amber-700',
                    log.level === 'success' && 'text-emerald-700',
                    log.level === 'info' && 'text-slate-600'
                  ].filter(Boolean).join(' ')}>
                    [{new Date(log.timestamp).toLocaleTimeString()}] [{log.level}] {log.skuId ? `${log.skuId} - ` : ''}{log.message}
                    {log.durationMs != null ? ` (${log.durationMs}ms)` : ''}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Section>
      )}

      {skuListRows.length > 0 && (
        <Section title="SKU 列表">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500">
                  <th className="py-3 pr-4 font-medium">SKU</th>
                  <th className="py-3 pr-4 font-medium">图片数</th>
                  <th className="py-3 pr-4 font-medium">状态</th>
                  <th className="py-3 pr-4 font-medium">当前步骤</th>
                  <th className="py-3 pr-4 font-medium">生成进度</th>
                  <th className="py-3 pr-4 font-medium">队列</th>
                  <th className="py-3 pr-4 font-medium">错误 / 提示</th>
                  <th className="py-3 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {skuListRows.map((sku) => (
                  <tr key={`${sku.sourceType}-${sku.taskId || sku.folderPath || sku.skuId}`} className="border-b border-slate-100">
                    <td className="py-3 pr-4 font-medium text-ink">
                      <div>{sku.displayName || sku.skuId}</div>
                      {sku.sourceLabel && <div className="mt-1 text-xs font-normal text-slate-500">{sku.sourceLabel}</div>}
                    </td>
                    <td className="py-3 pr-4 text-slate-700">{sku.imageCount || 0}</td>
                    <td className="py-3 pr-4"><StatusBadge status={sku.status} /></td>
                    <td className="py-3 pr-4 text-slate-600">{statusLabels[sku.currentStep] || sku.currentStep}</td>
                    <td className="py-3 pr-4 text-xs text-slate-600">
                      {sku.generationProgress?.total ? (
                        <div>
                          <div>{sku.generationProgress.current || 0} / {sku.generationProgress.total}</div>
                          <div className={sku.generationProgress.failed ? 'text-red-700' : 'text-slate-400'}>
                            failed: {sku.generationProgress.failed || 0}
                          </div>
                        </div>
                      ) : '-'}
                    </td>
                    <td className="py-3 pr-4 text-xs text-slate-600">
                      <div>{getSkuDisplayQueueStatus(sku, batchStabilityReport, batchResumePlan).text}</div>
                      {sku.lastDurationMs != null && <div className="text-slate-400">{sku.lastDurationMs}ms</div>}
                    </td>
                    <td className="py-3 pr-4 text-xs text-slate-500">
                      {getSkuDisplayQueueHint(sku, batchStabilityReport, batchResumePlan) ? <div className="text-amber-700">{getSkuDisplayQueueHint(sku, batchStabilityReport, batchResumePlan)}</div> : null}
                      {sku.error ? <span className="text-red-700">{sku.error.code}: {sku.error.message}</span> : null}
                      {sku.lastQueueError ? <div className="text-red-700">{sku.lastQueueError.code}: {sku.lastQueueError.message}</div> : null}
                      {sku.warnings?.length > 0 && <div>{sku.warnings.slice(0, 2).map((warning) => warning.message || warning.code).join('；')}</div>}
                    </td>
                    <td className="py-3 text-right">
                      {sku.taskId ? (
                        <Link to={nextTaskRoute(sku)} className="font-semibold text-mint hover:text-teal-800">打开单 SKU 任务</Link>
                      ) : sku.rowSource === 'importedElsewhere' ? (
                        <span className="text-amber-700">已在其他 batch</span>
                      ) : sku.sourceType === 'scan' ? (
                        <span className="text-emerald-700">待导入</span>
                      ) : (
                        <span className="text-slate-400">无任务</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </div>
  );
}

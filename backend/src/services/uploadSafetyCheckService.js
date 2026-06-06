import { getUploadCredentialStatus } from './uploadCredentialService.js';

function nowIso() {
  return new Date().toISOString();
}

function finding(code, severity, message) {
  return { code, severity, message };
}

export function buildUploadSafetyReport({ env = process.env } = {}) {
  const credentialStatus = getUploadCredentialStatus({ env });
  const sandboxReadyPlatforms = credentialStatus.platforms
    .filter((platform) => platform.sandboxSupported && platform.configured);

  const securityFindings = [
    finding('REAL_UPLOAD_DISABLED', 'info', 'realUploadEnabled=false，本阶段不会真实上传平台。'),
    finding('REAL_PLATFORM_API_DISABLED', 'info', '本阶段不会调用 Temu、妙手或其他平台 API。'),
    finding('CREDENTIAL_VALUES_NOT_RETURNED', 'info', '接口只返回变量名和 configured 状态，不返回 token、key 或 secret 的真实值。'),
    finding('LOCAL_STORAGE_NOT_CREDENTIAL_STORE', 'critical', 'localStorage 仅用于 dry-run UI 体验，不适合保存真实平台凭据。'),
    finding('DATABASE_WRITE_DISABLED', 'info', '凭据状态与安全报告为只读检查，不写入数据库。')
  ];

  const missingCount = credentialStatus.platforms
    .reduce((sum, platform) => sum + (platform.missingVariables?.length || 0), 0);
  if (missingCount > 0) {
    securityFindings.push(finding('MISSING_CREDENTIAL_VARIABLES', 'warning', '部分平台缺少未来沙盒 API 接入所需变量名。'));
  }

  const warnings = securityFindings.filter((item) => item.severity === 'warning').length;
  const criticalIssues = securityFindings.filter((item) => item.severity === 'critical').length;

  return {
    meta: {
      generatedAt: nowIso(),
      mode: 'credential-safety-dry-run',
      realUploadEnabled: false
    },
    summary: {
      platformsChecked: credentialStatus.platforms.length,
      readyForSandboxApi: sandboxReadyPlatforms.length > 0,
      readyForRealUpload: false,
      criticalIssues,
      warnings
    },
    credentialStatus,
    securityFindings,
    recommendations: [
      '真实平台凭据不能保存在 localStorage，localStorage 仅用于 dry-run UI 体验。',
      '真实上传前请迁移到后端安全凭据管理方案，并完成沙盒 API 验证。',
      '继续保持 realUploadEnabled=false，直到人工确认凭据、审计、回滚和限流方案。'
    ],
    nextSuggestedAction: sandboxReadyPlatforms.length
      ? '继续使用 dry-run 和 sandbox 模拟；真实上传前先完成后端凭据安全方案。'
      : '先补齐未来沙盒 API 所需变量名，再进行只读安全复查；当前仍只允许 dry-run。'
  };
}

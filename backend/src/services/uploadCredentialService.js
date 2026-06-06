const PLATFORM_CREDENTIALS = [
  {
    platformId: 'temu',
    platformName: 'Temu',
    sandboxSupported: true,
    requiredVariables: [
      'TEMU_CLIENT_ID',
      'TEMU_CLIENT_SECRET',
      'TEMU_ACCESS_TOKEN',
      'TEMU_API_BASE_URL'
    ],
    optionalVariables: [
      'TEMU_SANDBOX_ENABLED',
      'TEMU_REFRESH_TOKEN'
    ]
  },
  {
    platformId: 'miaoshou',
    platformName: '妙手',
    sandboxSupported: true,
    requiredVariables: [
      'MIAOSHOU_APP_KEY',
      'MIAOSHOU_APP_SECRET',
      'MIAOSHOU_ACCESS_TOKEN',
      'MIAOSHOU_API_BASE_URL'
    ],
    optionalVariables: [
      'MIAOSHOU_SANDBOX_ENABLED'
    ]
  },
  {
    platformId: 'amazon',
    platformName: 'Amazon',
    sandboxSupported: false,
    requiredVariables: [
      'AMAZON_SELLER_ID',
      'AMAZON_REFRESH_TOKEN',
      'AMAZON_CLIENT_ID',
      'AMAZON_CLIENT_SECRET',
      'AMAZON_MARKETPLACE_ID'
    ],
    optionalVariables: [
      'AMAZON_SANDBOX_ENABLED'
    ]
  },
  {
    platformId: 'noon',
    platformName: 'Noon',
    sandboxSupported: false,
    requiredVariables: [],
    optionalVariables: []
  },
  {
    platformId: 'ozon',
    platformName: 'Ozon',
    sandboxSupported: false,
    requiredVariables: [],
    optionalVariables: []
  },
  {
    platformId: 'rakuten',
    platformName: 'Rakuten',
    sandboxSupported: false,
    requiredVariables: [],
    optionalVariables: []
  }
];

function hasEnvValue(env, variableName) {
  const value = env?.[variableName];
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function credentialRow(definition, env) {
  const requiredVariables = [...definition.requiredVariables];
  const optionalVariables = [...definition.optionalVariables];
  const configuredVariables = [...requiredVariables, ...optionalVariables]
    .filter((variableName) => hasEnvValue(env, variableName));
  const missingVariables = requiredVariables.filter((variableName) => !hasEnvValue(env, variableName));
  const maskedPreview = Object.fromEntries(
    configuredVariables.map((variableName) => [variableName, '****configured****'])
  );

  return {
    platformId: definition.platformId,
    platformName: definition.platformName,
    sandboxSupported: definition.sandboxSupported,
    realUploadSupported: false,
    configured: requiredVariables.length > 0 && missingVariables.length === 0,
    requiredVariables,
    optionalVariables,
    configuredVariables,
    missingVariables,
    maskedPreview,
    warnings: missingVariables.length
      ? [{
        code: 'MISSING_REQUIRED_VARIABLES',
        message: '缺少真实沙盒 API 接入前需要确认的变量；当前仍仅支持 dry-run。'
      }]
      : []
  };
}

export function getUploadCredentialStatus({ env = process.env } = {}) {
  const platforms = PLATFORM_CREDENTIALS.map((definition) => credentialRow(definition, env));
  const configuredSandboxPlatforms = platforms.filter((platform) => platform.sandboxSupported && platform.configured);

  return {
    realUploadEnabled: false,
    platforms,
    globalWarnings: [
      '当前仅检查变量是否存在，不读取、不返回、不保存真实凭据值。',
      '真实上传仍未启用；后续接入真实沙盒 API 前需要独立的后端凭据管理方案。'
    ],
    nextSuggestedAction: configuredSandboxPlatforms.length
      ? '已有平台变量名状态满足沙盒 API 前置检查，但当前仍只允许 dry-run，不会真实上传。'
      : '当前仅支持 dry-run。真实上传前需要完成平台凭据安全方案和沙盒验证。'
  };
}

export function listUploadCredentialDefinitions() {
  return PLATFORM_CREDENTIALS.map((definition) => ({
    ...definition,
    requiredVariables: [...definition.requiredVariables],
    optionalVariables: [...definition.optionalVariables]
  }));
}

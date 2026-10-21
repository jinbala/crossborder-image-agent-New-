param(
  [ValidateSet('u2net', 'u2netp', 'silueta', 'isnet-general-use', 'birefnet-general', 'birefnet-general-lite')]
  [string]$Model = 'u2net',
  [switch]$AcceptModelLicense,
  [switch]$DependenciesOnly
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$venvPath = Join-Path $projectRoot '.venv-rembg'
$rembgExe = Join-Path $venvPath 'Scripts\rembg.exe'
$modelDirectory = Join-Path $projectRoot 'models\rembg'

if (-not $DependenciesOnly -and -not $AcceptModelLicense) {
  throw 'rembg code is MIT licensed, but model weights have separate licenses. Review the selected model license, then rerun with -AcceptModelLicense.'
}

$pythonLauncher = $null
$installedRuntimes = (& py --list 2>&1 | Out-String)
foreach ($version in @('3.13', '3.12', '3.11')) {
  if ($installedRuntimes -notmatch [regex]::Escape($version)) { continue }
  & py "-$version" -c 'import sys; print(sys.executable)' *> $null
  if ($LASTEXITCODE -eq 0) {
    $pythonLauncher = $version
    break
  }
}
if (-not $pythonLauncher) {
  throw 'Python 3.11, 3.12, or 3.13 is required. The current rembg release does not support Python 3.14.'
}

if (-not (Test-Path -LiteralPath $venvPath)) {
  & py "-$pythonLauncher" -m venv $venvPath
  if ($LASTEXITCODE -ne 0) { throw 'Failed to create .venv-rembg.' }
}

$pythonExe = Join-Path $venvPath 'Scripts\python.exe'
& $pythonExe -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw 'Failed to upgrade pip.' }
& $pythonExe -m pip install 'rembg[cpu,cli]'
if ($LASTEXITCODE -ne 0) { throw 'Failed to install rembg.' }
if (-not $DependenciesOnly) {
  New-Item -ItemType Directory -Path $modelDirectory -Force | Out-Null
  $env:U2NET_HOME = $modelDirectory
  $env:REMBG_HOME = $modelDirectory
  & $rembgExe d $Model
  if ($LASTEXITCODE -ne 0) { throw "Failed to download model $Model." }
  $acceptancePath = Join-Path $modelDirectory 'license-acceptance.json'
  $modelConsents = @{}
  if (Test-Path -LiteralPath $acceptancePath) {
    $previous = Get-Content -LiteralPath $acceptancePath -Raw | ConvertFrom-Json
    foreach ($entry in $previous.models.PSObject.Properties) { $modelConsents[$entry.Name] = $entry.Value }
  }
  $modelConsents[$Model] = @{ accepted = $true; acceptedAt = (Get-Date).ToUniversalTime().ToString('o'); method = 'explicit-AcceptModelLicense-switch' }
  @{ models = $modelConsents } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $acceptancePath -Encoding UTF8
} else {
  Write-Host 'Dependencies installed only. No model weights were downloaded or licensed.'
}

Write-Host "rembg local environment is ready: $rembgExe"
Write-Host "Model: $Model. Set REMBG_MODEL=$Model before starting the backend; the default is u2net."

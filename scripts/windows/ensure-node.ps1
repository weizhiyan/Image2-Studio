param(
  [string]$TargetDir = (Join-Path $PSScriptRoot '..\..\.runtime\node')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Get-NodeArch {
  if ($env:PROCESSOR_ARCHITEW6432 -eq 'AMD64') { return 'x64' }
  if ($env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { return 'arm64' }
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { return 'arm64' }
  if ($env:PROCESSOR_ARCHITECTURE -eq 'x86') { return 'x86' }
  return 'x64'
}

try {
  if (Test-Path (Join-Path $TargetDir 'node.exe')) {
    Write-Host "Portable Node is already installed at $TargetDir"
    exit 0
  }

  $arch = Get-NodeArch
  $runtimeDir = Split-Path -Parent $TargetDir
  New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

  $bases = @(
    'https://nodejs.org/dist/latest-v22.x',
    'https://npmmirror.com/mirrors/node/latest-v22.x',
    'https://cdn.npmmirror.com/binaries/node/latest-v22.x'
  )

  $zipPath = Join-Path $runtimeDir 'node-download.zip'
  $tempDir = Join-Path $runtimeDir 'node-extract'
  if (Test-Path $tempDir) { Remove-Item -Recurse -Force $tempDir }
  New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

  $downloaded = $false
  $version = ''

  foreach ($base in $bases) {
    try {
      Write-Host "Checking Node mirror: $base"
      $shasums = Invoke-WebRequest -UseBasicParsing -Uri "$base/SHASUMS256.txt" -TimeoutSec 30
      $pattern = "node-v([0-9.]+)-win-$arch\.zip$"
      $entry = ($shasums.Content -split "`n") | Where-Object { $_ -match $pattern } | Select-Object -First 1
      if (-not $entry) {
        Write-Host "No Node 22 package for Windows $arch on this mirror."
        continue
      }

      $parts = $entry.Trim() -split '\s+'
      $expectedHash = $parts[0]
      $fileName = $parts[-1]
      $version = [regex]::Match($fileName, 'node-v([0-9.]+)-win').Groups[1].Value
      $url = "$base/$fileName"

      Write-Host "Downloading Node $version ($arch): $url"
      Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zipPath -TimeoutSec 300
      $actualHash = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actualHash -ne $expectedHash.ToLowerInvariant()) {
        throw 'SHA-256 checksum mismatch.'
      }
      $downloaded = $true
      break
    } catch {
      Write-Host "Download failed: $($_.Exception.Message)"
      if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
    }
  }

  if (-not $downloaded) {
    throw 'Could not download Node.js from any mirror.'
  }

  Expand-Archive -Path $zipPath -DestinationPath $tempDir -Force
  $inner = Get-ChildItem -Path $tempDir -Directory | Select-Object -First 1
  if (-not $inner) {
    throw 'The Node.js archive did not contain a folder.'
  }

  if (Test-Path $TargetDir) { Remove-Item -Recurse -Force $TargetDir }
  Move-Item -Path $inner.FullName -Destination $TargetDir
  Remove-Item -Recurse -Force $tempDir
  Remove-Item -Force $zipPath

  if (-not (Test-Path (Join-Path $TargetDir 'node.exe'))) {
    throw 'Node.js extraction failed.'
  }
  Write-Host "Node $version is ready at $TargetDir"
  exit 0
} catch {
  Write-Host ''
  Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'Install Node.js 22 LTS manually from https://nodejs.org/en/download'
  Write-Host 'Then run the launcher again.'
  exit 1
}

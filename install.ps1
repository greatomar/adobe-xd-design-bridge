#Requires -Version 5.1
<#
.SYNOPSIS
  Installs the OpenCode Adobe XD Design Bridge on this machine.

.DESCRIPTION
  1. Checks Windows, Node.js >= 22.6, Adobe XD and the UXP Developer Tool.
  2. Installs the single runtime dependency (ws) in bridge\.
  3. Creates bridge\.bridge-token when missing.
  4. Merges the adobe-xd MCP server into ~\.config\opencode\opencode.json
     (backs up the previous file first).
  5. Copies agents\design.md and skills\ into ~\.config\opencode\.
  6. Prints the remaining manual steps (UXP load, token, smoke test).

.PARAMETER SkipOpenCodeConfig
  Do not modify opencode.json. The block to add is printed instead.

.PARAMETER SkipSkills
  Install the design agent but not the bundled skills.

.PARAMETER Force
  Overwrite existing agent/skill files and the existing MCP entry.

.EXAMPLE
  pwsh -File .\install.ps1
.EXAMPLE
  pwsh -File .\install.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [switch]$SkipOpenCodeConfig,
  [switch]$SkipSkills,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$RepoRoot = $PSScriptRoot
$BridgeDir = Join-Path $RepoRoot 'bridge'
$PluginManifest = Join-Path $RepoRoot 'xd-plugin\manifest.json'
$OpenCodeRoot = Join-Path $env:USERPROFILE '.config\opencode'
$ConfigPath = Join-Path $OpenCodeRoot 'opencode.json'

function Write-Step([string]$Text) { Write-Host "`n== $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "   OK   $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "   WARN $Text" -ForegroundColor Yellow }
function Write-Info([string]$Text) { Write-Host "        $Text" -ForegroundColor Gray }

function Find-Node {
  $candidates = @()
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $candidates += $cmd.Source }
  $candidates += @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'mise\installs\node')
  )
  foreach ($c in $candidates) {
    if (-not $c) { continue }
    if (Test-Path $c -PathType Container) {
      $exe = Get-ChildItem $c -Recurse -Filter node.exe -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
      if ($exe) { return $exe.FullName }
    } elseif (Test-Path $c) { return (Resolve-Path $c).Path }
  }
  return $null
}

Write-Host 'OpenCode - Adobe XD Design Bridge installer' -ForegroundColor White
Write-Info "repository: $RepoRoot"

# ---------------------------------------------------------------- 1. checks
Write-Step '1/6 Checking prerequisites'

if ($PSVersionTable.PSVersion.Major -lt 5) { throw 'PowerShell 5.1 or newer is required.' }
if (-not $IsWindows -and $PSVersionTable.PSVersion.Major -ge 6) { throw 'Windows is required (Windows UI Automation).' }
if ($env:OS -ne 'Windows_NT' -and $PSVersionTable.PSVersion.Major -lt 6) { throw 'Windows is required.' }

$nodeExe = Find-Node
if (-not $nodeExe) {
  throw 'Node.js was not found. Install Node.js 22.6+ (https://nodejs.org) or make sure "node" is on PATH, then rerun.'
}
$nodeVersion = (& $nodeExe -p "process.versions.node").Trim()
$nodeOk = $false
try { $nodeOk = ([version]$nodeVersion -ge [version]'22.6.0') } catch { $nodeOk = $false }
if (-not $nodeOk) { throw "Node.js $nodeVersion found at $nodeExe, but 22.6+ is required (native TypeScript)." }
Write-Ok "Node.js $nodeVersion -> $nodeExe"

if (-not (Test-Path (Join-Path $BridgeDir 'bin\bridge.ts'))) { throw "bridge\bin\bridge.ts not found under $RepoRoot." }
if (-not (Test-Path $PluginManifest)) { throw "xd-plugin\manifest.json not found under $RepoRoot." }

$xd = $null
try {
  $prevWhatIf = $WhatIfPreference
  $WhatIfPreference = $false   # Get-AppxPackage imports aliases that echo under -WhatIf
  try { $xd = Get-AppxPackage -Name 'Adobe.XD' -ErrorAction SilentlyContinue | Select-Object -First 1 }
  finally { $WhatIfPreference = $prevWhatIf }
} catch { }
if ($xd) {
  Write-Ok "Adobe XD $($xd.Version) (MSIX)"
} elseif (Test-Path 'C:\Program Files\Adobe\Adobe XD\XD.exe') {
  Write-Ok 'Adobe XD found in Program Files'
} else {
  Write-Warn 'Adobe XD was not detected. The bridge installs fine, but the plugin needs XD 61.x.'
}

$udt = @(
  (Join-Path $env:ProgramFiles 'Adobe\Adobe UXP Developer Tools\Adobe UXP Developer Tools.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Adobe UXP Developer Tools\Adobe UXP Developer Tools.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($udt) { Write-Ok "UXP Developer Tool -> $udt" }
else { Write-Warn 'UXP Developer Tool was not detected; you need it once to load the panel.' }

# ------------------------------------------------------------ 2. dependency
Write-Step '2/6 Installing bridge dependencies (ws)'
$npmCmd = Join-Path (Split-Path $nodeExe) 'npm.cmd'
if (-not (Test-Path $npmCmd)) { $npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source }
if (-not $npmCmd) { throw 'npm was not found next to Node.js. Reinstall Node.js with npm included.' }
if ($PSCmdlet.ShouldProcess($BridgeDir, 'npm install')) {
  Push-Location $BridgeDir
  try {
    & $npmCmd install --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
  } finally { Pop-Location }
  Write-Ok 'dependencies installed'
}

# ---------------------------------------------------------------- 3. token
Write-Step '3/6 Bridge token'
$tokenFile = Join-Path $BridgeDir '.bridge-token'
if ($PSCmdlet.ShouldProcess($tokenFile, 'create or read bridge token')) {
  $token = (& $nodeExe (Join-Path $BridgeDir 'bin\bridge.ts') --show-token).Trim()
  if (-not $token) { throw 'The bridge did not return a token.' }
  Write-Ok "token ready (stored in bridge\.bridge-token)"
  Write-Info $token
}

# ------------------------------------------------------- 4. MCP registration
Write-Step '4/6 Registering the MCP server with OpenCode'
$bridgeEntry = Join-Path $BridgeDir 'bin\bridge.ts'
if ($SkipOpenCodeConfig) {
  Write-Warn 'skipped (-SkipOpenCodeConfig). Add this to ' + $ConfigPath + ' :'
  Write-Host @"
{
  "mcp": {
    "servers": {
      "adobe-xd": {
        "type": "local",
        "command": ["$($nodeExe.Replace('\','\\'))",
                    "$($bridgeEntry.Replace('\','\\'))"],
        "cwd": "$($BridgeDir.Replace('\','\\'))",
        "environment": { "XD_BRIDGE_VERBOSE": "0" },
        "timeout": { "startup": 30000, "catalog": 30000, "execution": 600000 }
      }
    }
  }
}
"@ -ForegroundColor DarkGray
} else {
  if ($PSCmdlet.ShouldProcess($ConfigPath, 'merge adobe-xd MCP server')) {
    if (Test-Path $ConfigPath) {
      $backup = "$ConfigPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
      Copy-Item $ConfigPath $backup -Force
      Write-Ok "backup -> $backup"
    }
    $mergeArgs = @(
      (Join-Path $RepoRoot 'scripts\merge-mcp.mjs'),
      '--config', $ConfigPath,
      '--node', $nodeExe,
      '--bridge', $bridgeEntry,
      '--cwd', $BridgeDir
    )
    & $nodeExe @mergeArgs
    if ($LASTEXITCODE -ne 0) {
      throw "Config merge failed (exit $LASTEXITCODE). Add the entry manually (see INSTALLATION.md)."
    }
    Write-Ok "MCP server 'adobe-xd' registered"
  }
}

# --------------------------------------------------------- 5. agent, skills
Write-Step '5/6 Installing the design agent and skills'
$agentSrc = Join-Path $RepoRoot 'agents\design.md'
$skillsSrc = Join-Path $RepoRoot 'skills'
if ($PSCmdlet.ShouldProcess($OpenCodeRoot, 'copy agent and skills')) {
  $agentDir = Join-Path $OpenCodeRoot 'agents'
  New-Item -ItemType Directory -Force -Path $agentDir | Out-Null
  $agentDst = Join-Path $agentDir 'design.md'
  if ((Test-Path $agentDst) -and -not $Force) {
    Write-Warn "agent exists, kept as-is (use -Force to replace): $agentDst"
  } else {
    Copy-Item $agentSrc $agentDst -Force
    Write-Ok "agent -> $agentDst"
  }

  if ($SkipSkills) {
    Write-Warn 'skills skipped (-SkipSkills)'
  } elseif (Test-Path $skillsSrc) {
    $skillsDir = Join-Path $OpenCodeRoot 'skills'
    New-Item -ItemType Directory -Force -Path $skillsDir | Out-Null
    foreach ($skill in Get-ChildItem $skillsSrc -Directory) {
      $dest = Join-Path $skillsDir $skill.Name
      if ((Test-Path $dest) -and -not $Force) {
        Write-Warn "skill exists, kept as-is: $($skill.Name)"
      } else {
        Copy-Item $skill.FullName $dest -Recurse -Force
        Write-Ok "skill -> $($skill.Name)"
      }
    }
  } else {
    Write-Warn 'skills\ folder not found in this checkout'
  }
}

# ----------------------------------------------------------------- 6. next
Write-Step '6/6 Remaining manual steps'
Write-Host @"

  1. Open Adobe UXP Developer Tool.
  2. Add Plugin -> select:
     $PluginManifest
  3. Click Load. In XD open Plugins > Panels > OpenCode Design Bridge.
  4. Paste the token printed above and press Connect.
  5. Restart OpenCode, pick the 'design' agent, then ask:
        Run xd_health, then xd_get_capabilities.

  Optional smoke test:
        Create an artboard 'BridgeTest' 390x844, add a rectangle
        and a text label, then export it.

  Uninstall: remove the 'adobe-xd' entry from $ConfigPath,
  then delete $OpenCodeRoot\agents\design.md and the bundled skills.

"@ -ForegroundColor White

Write-Host 'Installation finished.' -ForegroundColor Green
Write-Info 'Full guide: INSTALLATION.md   Arabic: README.ar.md'

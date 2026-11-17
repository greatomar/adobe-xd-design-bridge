<#
  Live acceptance driver - ONE Adobe XD prototype interaction, no connector drag.

  This script is the automation half of the acceptance test. It runs the same
  worker commands, in the same order, with the same arguments that
  bridge/src/automation/adapter.ts uses (focus_xd → ensure_mode → select_node →
  add_interaction → set_field(destination) → set_field(trigger) →
  set_field(action) → set_field(transition) → set_duration).

  It is deliberately NOT the verification half. Automation reporting "ok" is not
  evidence that Adobe XD contains a wire. Verification is a separate UXP
  read-back (xd_get_prototype_state / xd_validate_prototype) executed by
  DesignBridge after this script ends. The script therefore prints
  verified:false and status:"AUTOMATION_ONLY" on success.

  Evidence for every step is written to
  automation/PrototypeAutomation/evidence/live-<timestamp>.json
#>
[CmdletBinding()]
param(
    [string]$Source = "PrototypeTest/Source",
    [string]$Target = "PrototypeTest/Target",
    [string]$Trigger = "Tap",
    [string]$Action = "Transition",
    [string]$Transition = "Dissolve",
    [string]$DurationText = "0.3 s",
    [double]$DurationSeconds = 0.3,
    [ValidateSet("prototype", "design")][string]$Mode = "prototype",
    [string]$WorkerPath = ""
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $WorkerPath) { $WorkerPath = Join-Path $here "uia-worker.ps1" }
$evidenceDir = Join-Path $here "evidence"
if (-not (Test-Path $evidenceDir)) { New-Item -ItemType Directory -Path $evidenceDir | Out-Null }
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$evidenceFile = Join-Path $evidenceDir ("live-" + $stamp + ".json")

function Invoke-Worker {
    param([string]$Cmd, [hashtable]$WorkerArgs = @{})
    $payload = @{ cmd = $Cmd; args = $WorkerArgs } | ConvertTo-Json -Depth 8 -Compress
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
    $raw = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $WorkerPath -Base64 $b64 2>&1 | Out-String
    $line = ($raw -split "`r?`n" | Where-Object { $_.Trim().StartsWith("{") } | Select-Object -Last 1)
    if (-not $line) {
        return @{ ok = $false; cmd = $Cmd; error = @{ code = "WORKER_UNAVAILABLE"; message = "no JSON from worker: $raw"; stage = $Cmd } }
    }
    try { return ($line | ConvertFrom-Json) } catch { return @{ ok = $false; cmd = $Cmd; error = @{ code = "WORKER_UNAVAILABLE"; message = "unparseable: $line"; stage = $Cmd } } }
}

$steps = New-Object System.Collections.ArrayList
$script:failed = $null

function Step {
    param([string]$Name, [string]$Cmd, [hashtable]$StepArgs = @{}, [scriptblock]$Check)
    $t0 = Get-Date
    $res = Invoke-Worker -Cmd $Cmd -WorkerArgs $StepArgs
    $ok = $false
    if ($res.ok -eq $true) {
        if ($Check) { try { $ok = [bool](& $Check $res.result) } catch { $ok = $false } } else { $ok = $true }
    }
    $entry = @{
        stage = $Name; cmd = $Cmd; args = $StepArgs; ok = $ok
        workerOk = [bool]$res.ok
        result = $res.result
        error = $res.error
        ms = [int]((Get-Date) - $t0).TotalMilliseconds
    }
    [void]$steps.Add($entry)
    if (-not $ok -and -not $script:failed) {
        $script:failed = @{
            stage = $Name
            code = if ($res.error -and $res.error.code) { $res.error.code } else { if ($res.ok) { "EXPECTED_STATE_NOT_OBSERVED" } else { "AUTOMATION_ERROR" } }
            message = if ($res.error -and $res.error.message) { $res.error.message } else { "worker returned ok but the expected state was not observed" }
        }
    }
    return $entry
}

# 1. probe (diagnostic; also fails fast when XD is not running)
$probe = Step -Name "probe" -Cmd "probe" -Check { param($r) [bool]$r.xd.running }

if (-not $script:failed) {
    # 2. focus
    Step -Name "focus_xd" -Cmd "focus_xd" -Check { param($r) [bool]$r.focused } | Out-Null
}
if (-not $script:failed) {
    # 3. workspace
    Step -Name "ensure_mode" -Cmd "ensure_mode" -StepArgs @{ mode = $Mode } -Check { param($r) [bool]$r.verified } | Out-Null
}
if (-not $script:failed) {
    # 4. select the source artboard through the Layers list
    Step -Name "select_source" -Cmd "select_node" -StepArgs @{ name = $Source; scope = "artboard" } -Check { param($r) [bool]$r.uiaSelected } | Out-Null
}
if (-not $script:failed) {
    # 5. open the interaction editor for the selection
    Step -Name "create_connector" -Cmd "add_interaction" -Check { param($r) [bool]$r.editorVisible } | Out-Null
}
if (-not $script:failed) {
    Step -Name "connect_to_target" -Cmd "set_field" -StepArgs @{ field = "destination"; value = $Target } -Check { param($r) [string]$r.after -eq $Target } | Out-Null
}
if (-not $script:failed) {
    Step -Name "configure_trigger" -Cmd "set_field" -StepArgs @{ field = "trigger"; value = $Trigger } -Check { param($r) [string]$r.after -eq $Trigger } | Out-Null
}
if (-not $script:failed) {
    Step -Name "configure_action" -Cmd "set_field" -StepArgs @{ field = "action"; value = $Action } -Check { param($r) [string]$r.after -eq $Action } | Out-Null
}
if (-not $script:failed) {
    Step -Name "configure_transition" -Cmd "set_field" -StepArgs @{ field = "transition"; value = $Transition } -Check { param($r) [string]$r.after -eq $Transition } | Out-Null
}
if (-not $script:failed) {
    Step -Name "configure_duration" -Cmd "set_duration" -StepArgs @{ seconds = $DurationSeconds; text = $DurationText } -Check {
        param($r)
        $null -ne $r.seconds -and [Math]::Abs([double]$r.seconds - $DurationSeconds) -lt 0.0005
    } | Out-Null
}

$observed = $null
if (-not $script:failed) {
    $last = Invoke-Worker -Cmd "read_interaction"
    $observed = if ($last.ok) { $last.result } else { $null }
    [void]$steps.Add(@{ stage = "read_interaction"; cmd = "read_interaction"; ok = [bool]$last.ok; result = $last.result; error = $last.error; ms = 0 })
}

$report = @{
    kind = "live-automation-run"
    timestamp = (Get-Date).ToString("o")
    documentInvariant = "Automation output is NOT verification. DesignBridge must read the interaction back through UXP."
    request = @{
        source = $Source; target = $Target; trigger = $Trigger; action = $Action
        transition = $Transition; duration = $DurationSeconds; durationText = $DurationText; mode = $Mode
    }
    probe = $null
    steps = $steps
    observedInteraction = $observed
    automationOk = [bool](-not $script:failed)
    created = $null
    verified = $false
    status = if ($script:failed) { "POC_BLOCKED" } else { "AUTOMATION_ONLY" }
    failure = $script:failed
    nextStep = if ($script:failed) {
        "Read the failing stage above; the document may or may not have been modified - verify with xd_get_prototype_state before retrying."
    } else {
        "Run xd_validate_prototype (requiredConnections: source->target, trigger tap, action goToArtboard) through DesignBridge for the authoritative verdict."
    }
}

# Keep the evidence file useful but small: the full control inventory is
# diagnostic noise once a run passes, so it is stored as a compact summary.
if ($probe -and $probe.result) {
    $report.probe = [ordered]@{
        xd          = $probe.result.xd
        diagnostics = $probe.result.diagnostics
        modes       = $probe.result.modes
        interaction = $probe.result.interaction
        exposed     = $probe.result.exposed
        capabilities = $probe.result.capabilities
    }
}
foreach ($s in $steps) {
    if ($s.result -and $s.result.PSObject.Properties['controls']) {
        $s.result.PSObject.Properties.Remove('controls')
    }
}

$report | ConvertTo-Json -Depth 12 | Set-Content -Path $evidenceFile -Encoding UTF8
if ($script:failed) { exit 2 }
exit 0



<#
  Prototype Automation worker - Adobe XD UI Automation probe/actuator (POC).

  Invoked by DesignBridge (bridge/src/automation/worker.ts) with ONE base64 JSON
  request and answers with ONE JSON object on stdout:

    { "ok": true,  "cmd": "...", "result": {...} }
    { "ok": false, "cmd": "...", "error": { "code": "...", "message": "...", "stage": "..." } }

  Rules this file obeys:
    * No mouse coordinates and no synthetic clicks. Every action goes through a
      documented UI Automation pattern (Invoke / SelectionItem / Toggle /
      ExpandCollapse / Value). If a control cannot be driven that way the worker
      reports an unsupported_control error instead of guessing a screen position.
    * Every action is followed by a state read-back with a bounded wait, never a
      fixed sleep as the primary synchronisation.
    * Nothing here decides whether a wire exists. Adobe XD is the only source of
      truth, and DesignBridge reads it back through the UXP plugin.
#>
[CmdletBinding()]
param(
    [string]$Base64,
    [switch]$Serve
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]

# ---------------------------------------------------------------------------
# errors
# ---------------------------------------------------------------------------
function Throw-Coded {
    param([string]$Code, [string]$Message, [string]$Stage = "worker")
    $ex = New-Object System.Exception $Message
    $ex.Data['code'] = $Code
    $ex.Data['stage'] = $Stage
    throw $ex
}

# ---------------------------------------------------------------------------
# element helpers
# ---------------------------------------------------------------------------
function Get-XdProcess {
    $p = Get-Process -Name XD -ErrorAction SilentlyContinue | Select-Object -First 1
    return $p
}

function Get-XdWindow {
    $p = Get-XdProcess
    if (-not $p) { Throw-Coded "XD_NOT_FOUND" "Adobe XD (XD.exe) is not running" "focus_xd" }
    $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $p.Id)
    $win = $AE::RootElement.FindFirst($TS::Descendants, $cond)
    if (-not $win) { Throw-Coded "XD_WINDOW_NOT_FOUND" "XD.exe is running but exposes no window to UI Automation" "focus_xd" }
    return @{ element = $win; processId = $p.Id; processName = $p.ProcessName }
}

function Find-ById {
    param($Root, [string]$Id)
    $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $Id)
    return $Root.FindFirst($TS::Descendants, $c)
}

function Find-ByName {
    param($Root, [string]$Name)
    $c = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $Name)
    return $Root.FindFirst($TS::Descendants, $c)
}

function Get-PatternNames {
    param($Element)
    $names = @()
    if (-not $Element) { return $names }
    try {
        foreach ($p in $Element.GetSupportedPatterns()) {
            $names += $p.ProgrammaticName.Replace("PatternIdentifiers.Pattern", "")
        }
    } catch { }
    return $names
}

function Clean-Text {
    param($Value)
    if ($null -eq $Value) { return $Value }
    if ($Value -isnot [string]) { return $Value }
    # UIA names (e.g. a plugin log panel) can contain raw control characters,
    # which are illegal inside a JSON string. Fold them to spaces at the source.
    return ($Value -replace '[\u0000-\u001F]', " ")
}

function Get-ElementInfo {
    param($Element)
    if (-not $Element) { return $null }
    $c = $Element.Current
    $rect = $null
    try {
        $r = $c.BoundingRectangle
        if ($r.Width -gt 0 -or $r.Height -gt 0) {
            $rect = @{ x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height }
        }
    } catch { }
    return @{
        name        = (Clean-Text $c.Name)
        automationId = $c.AutomationId
        controlType = $c.ControlType.ProgrammaticName.Replace("ControlType.", "")
        className   = $c.ClassName
        offscreen   = $c.IsOffscreen
        enabled     = $c.IsEnabled
        rect        = $rect
        patterns    = (Get-PatternNames $Element)
    }
}

function Get-Value {
    param($Element)
    if (-not $Element) { return $null }
    try {
        $vp = $Element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        if ($vp) { return (Clean-Text $vp.Current.Value) }
    } catch { }
    return $null
}

function Get-ToggleStateName {
    param($Element)
    if (-not $Element) { return "not-found" }
    try {
        $tp = $Element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
        if ($tp) { return [string]$tp.Current.ToggleState }
    } catch { }
    return "unsupported"
}

function Wait-Until {
    param([scriptblock]$Condition, [int]$TimeoutMs = 4000, [int]$PollMs = 100)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    # NOTE: the local result must not be named $value: PowerShell variables are
    # case-insensitive, so a caller's $Value (the expected UI value) would be
    # shadowed by this function and every comparison would run against $null.
    while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
        $conditionResult = $null
        try { $conditionResult = & $Condition } catch { $conditionResult = $null }
        if ($conditionResult) { return $conditionResult }
        Start-Sleep -Milliseconds $PollMs
    }
    return $null
}

function Invoke-Element {
    param($Element, [string]$Stage)
    if (-not $Element) { Throw-Coded "element_not_found" "target element is missing" $Stage }
    try {
        $ip = $Element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        if (-not $ip) { Throw-Coded "unsupported_control" ("element has no Invoke pattern: " + $Element.Current.AutomationId) $Stage }
        $ip.Invoke()
        return $true
    } catch {
        if ($_.Exception.Data['code']) { throw }
        Throw-Coded "invoke_failed" ("Invoke failed: " + $_.Exception.Message) $Stage
    }
}

# ---------------------------------------------------------------------------
# window / mode
# ---------------------------------------------------------------------------
Add-Type -Namespace XdBridge -Name NativeFocus -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
'@ -ErrorAction SilentlyContinue

function Set-XdForeground {
    param([IntPtr]$Hwnd)
    if ($Hwnd -eq [IntPtr]::Zero) { return $false }
    try { if ([XdBridge.NativeFocus]::GetForegroundWindow() -eq $Hwnd) { return $true } } catch { }

    $fg = [IntPtr]::Zero
    try { $fg = [XdBridge.NativeFocus]::GetForegroundWindow() } catch { }
    $fgPid = [uint32]0
    $fgThread = [uint32]0
    if ($fg -ne [IntPtr]::Zero) {
        try { $fgThread = [XdBridge.NativeFocus]::GetWindowThreadProcessId($fg, [ref]$fgPid) } catch { }
    }
    $ourThread = [uint32]0
    try { $ourThread = [XdBridge.NativeFocus]::GetCurrentThreadId() } catch { }

    $attached = $false
    if ($fgThread -ne 0 -and $ourThread -ne 0 -and $fgThread -ne $ourThread) {
        try { $attached = [XdBridge.NativeFocus]::AttachThreadInput($ourThread, $fgThread, $true) } catch { }
    }
    try {
        if ([XdBridge.NativeFocus]::IsIconic($Hwnd)) { [void][XdBridge.NativeFocus]::ShowWindow($Hwnd, 9) }
        [void][XdBridge.NativeFocus]::BringWindowToTop($Hwnd)
        [void][XdBridge.NativeFocus]::SetForegroundWindow($Hwnd)
        [void][XdBridge.NativeFocus]::SetFocus($Hwnd)
    } catch { } finally {
        if ($attached) { try { [void][XdBridge.NativeFocus]::AttachThreadInput($ourThread, $fgThread, $false) } catch { } }
    }
    try { return ([XdBridge.NativeFocus]::GetForegroundWindow() -eq $Hwnd) } catch { return $false }
}

function Get-FrameWindowElement {
    param($Element)
    # The UIA tree for an MSIX app is ApplicationFrameWindow → CoreWindow. The
    # foreground API needs the top-level frame, not the CoreWindow.
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $current = $Element
    for ($i = 0; $i -lt 8; $i++) {
        try { $parent = $walker.GetParent($current) } catch { break }
        if (-not $parent) { break }
        try { if ($parent -eq $AE::RootElement) { break } } catch { }
        $current = $parent
    }
    return $current
}

function Ensure-Foreground {
    $xd = Get-XdWindow
    $win = $xd.element
    $frame = Get-FrameWindowElement $win
    $hwnd = [IntPtr]::Zero
    try { $hwnd = [IntPtr]$frame.Current.NativeWindowHandle } catch { }
    if ($hwnd -eq [IntPtr]::Zero) {
        try { $hwnd = [IntPtr]$win.Current.NativeWindowHandle } catch { }
    }

    $activationError = $null
    if ($hwnd -ne [IntPtr]::Zero) {
        try {
            [void](Set-XdForeground -Hwnd $hwnd)
        } catch { $activationError = $_.Exception.Message }
    } else {
        $activationError = "no native window handle exposed for the XD window"
    }

    $foregroundOk = Wait-Until -TimeoutMs 3000 -PollMs 100 -Condition {
        if ($hwnd -eq [IntPtr]::Zero) { return $null }
        try { if ([XdBridge.NativeFocus]::GetForegroundWindow() -eq $hwnd) { $true } else { $null } } catch { $null }
    }

    try { $win.SetFocus() } catch { }

    $keyboardFocus = Wait-Until -TimeoutMs 2000 -PollMs 100 -Condition {
        try { if ($win.Current.HasKeyboardFocus) { $true } else { $null } } catch { $null }
    }

    $focused = [bool]($foregroundOk -or $keyboardFocus)
    $hwndValue = 0
    if ($hwnd -ne [IntPtr]::Zero) { $hwndValue = $hwnd.ToInt64() }
    $fgValue = 0
    try { $fgValue = [XdBridge.NativeFocus]::GetForegroundWindow().ToInt64() } catch { }
    return @{
        processId          = $xd.processId
        windowName         = $win.Current.Name
        windowHandle       = $hwndValue
        foregroundWindow   = $fgValue
        foregroundVerified = [bool]$foregroundOk
        keyboardFocus      = [bool]$keyboardFocus
        focused            = $focused
        activationError    = $activationError
    }
}

function Set-Workspace {
    param([ValidateSet("design", "prototype")][string]$Mode)
    $xd = Get-XdWindow
    $win = $xd.element
    $id = if ($Mode -eq "prototype") { "titlebarPrototypeButton" } else { "titlebarDesignButton" }
    $btn = Find-ById $win $id
    if (-not $btn) { Throw-Coded "UNSUPPORTED_XD_UI" ("workspace toggle is not exposed: " + $id) "PROTOTYPE_MODE_FAILED" }
    $before = Get-ToggleStateName $btn
    if ($before -ne "On") {
        try {
            $tp = $btn.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
            if (-not $tp) { Throw-Coded "UNSUPPORTED_XD_UI" "workspace toggle has no Toggle pattern" "PROTOTYPE_MODE_FAILED" }
            $tp.Toggle()
        } catch {
            if ($_.Exception.Data['code']) { throw }
            Throw-Coded "PROTOTYPE_MODE_FAILED" ("toggle failed: " + $_.Exception.Message) "PROTOTYPE_MODE_FAILED"
        }
    }
    $after = Wait-Until -TimeoutMs 5000 -Condition {
        $state = Get-ToggleStateName $btn
        if ($state -eq "On") { $state } else { $null }
    }
    if (-not $after) {
        Throw-Coded "PROTOTYPE_MODE_FAILED" ("workspace '" + $Mode + "' did not engage (toggle state " + (Get-ToggleStateName $btn) + ")") "PROTOTYPE_MODE_FAILED"
    }
    $otherId = "titlebarDesignButton"
    if ($Mode -eq "prototype") { $otherId = "titlebarDesignButton" } else { $otherId = "titlebarPrototypeButton" }
    $other = Find-ById $win $otherId
    return @{
        mode          = $Mode
        toggleBefore  = $before
        toggleAfter   = $after
        otherToggle   = (Get-ToggleStateName $other)
        verified      = $true
    }
}

# ---------------------------------------------------------------------------
# layers pane: semantic node selection without coordinates
# ---------------------------------------------------------------------------
function Open-LayersPane {
    param($Win)
    $nav = Find-ById $Win "toolbarNavigationPaneButton"
    if (-not $nav) { Throw-Coded "UNSUPPORTED_XD_UI" "navigation (layers) pane toggle is not exposed" "select_source" }
    $state = Get-ToggleStateName $nav
    if ($state -ne "On") {
        try {
            $tp = $nav.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
            if (-not $tp) { Throw-Coded "UNSUPPORTED_XD_UI" "navigation pane toggle has no Toggle pattern" "select_source" }
            $tp.Toggle()
        } catch {
            if ($_.Exception.Data['code']) { throw }
            Throw-Coded "SOURCE_SELECTION_FAILED" ("could not open the layers pane: " + $_.Exception.Message) "select_source"
        }
    }
    $list = Wait-Until -TimeoutMs 4000 -Condition { Find-ById $Win "layersPaneOutlineView" }
    if (-not $list) { Throw-Coded "UNSUPPORTED_XD_UI" "layers pane opened but its outline view is not exposed" "select_source" }
    return $list
}

function Get-LayerRows {
    param($List)
    $rows = @()
    try { $rows = $List.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition) } catch { return @() }
    return $rows
}

function Get-RowText {
    param($Row)
    try {
        $t = $Row.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, "displayText")))
        if ($t) { return (Clean-Text $t.Current.Name) }
    } catch { }
    return $null
}

function Find-LayerRows {
    param($List, [string]$Name)
    $matches = @()
    foreach ($r in (Get-LayerRows $List)) {
        $t = Get-RowText $r
        if ($t -eq $Name) { $matches += $r; continue }
        if ($t -and ($t.Trim() -ieq $Name.Trim())) { $matches += $r }
    }
    return $matches
}

function Find-LayerRow {
    param($List, [string]$Name)
    # @() is required: a single match unrolls to a scalar, and StrictMode makes
    # .Count fail on scalars.
    $hits = @(Find-LayerRows $List $Name)
    if ($hits.Count -eq 0) { return $null }
    return $hits[0]
}

function Get-PaneHeader {
    param($Win)
    $h = Find-ById $Win "layersPaneHeader"
    if ($h) { return (Clean-Text $h.Current.Name) }
    return $null
}

function Select-Node {
    param([string]$Name, [string]$Scope = "artboard")
    $xd = Get-XdWindow
    $win = $xd.element
    $list = Open-LayersPane $win
    $header = Get-PaneHeader $win

    $row = Find-LayerRow $list $Name
    $navigation = @()
    if (-not $row -and $Scope -eq "artboard") {
        # Drill up to the artboard list: the layers pane shows one artboard's
        # children until the back button is used.
        $back = Find-ById $win "layersHeaderBackButton"
        if ($back) {
            Invoke-Element $back "SOURCE_SELECTION_FAILED" | Out-Null
            $navigation += "invoked layersHeaderBackButton"
            $list = Wait-Until -TimeoutMs 4000 -Condition { Find-ById $win "layersPaneOutlineView" }
            if (-not $list) { Throw-Coded "UNSUPPORTED_XD_UI" "layers pane lost its outline view after navigating back" "select_source" }
            $header = Get-PaneHeader $win
            $row = Find-LayerRow $list $Name
        }
    }
    if (-not $row) {
        $names = @()
        foreach ($r in (Get-LayerRows $list)) { $n = Get-RowText $r; if ($n) { $names += $n } }
        Throw-Coded "SOURCE_NOT_FOUND" ("no layer row named '" + $Name + "' (pane header: " + $header + "; rows: " + $names.Count + ")") "select_source"
    }
    $hits = @(Find-LayerRows $list $Name)
    if ($hits.Count -gt 1) {
        Throw-Coded "ambiguous" ("'" + $Name + "' matches " + $hits.Count + " Layers rows; refusing to guess. Pass a name that resolves to one row (DesignBridge reports candidates).") "select_source"
    }

    $rowInfo = Get-ElementInfo (Get-RowTextElement $row)
    try { $sip = $row.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern) } catch { $sip = $null }
    if (-not $sip) { Throw-Coded "UNSUPPORTED_XD_UI" "layer row has no SelectionItem pattern" "SOURCE_SELECTION_FAILED" }

    $wasSelected = $false
    try { $wasSelected = $sip.Current.IsSelected } catch { }
    if (-not $wasSelected) {
        try {
            try { $si = $row.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern); if ($si) { $si.ScrollIntoView() } } catch { }
            $sip.Select()
        } catch {
            Throw-Coded "SOURCE_SELECTION_FAILED" ("SelectionItem.Select failed: " + $_.Exception.Message) "SOURCE_SELECTION_FAILED"
        }
    }
    $selected = Wait-Until -TimeoutMs 4000 -Condition {
        try { if ($sip.Current.IsSelected) { $true } else { $null } } catch { $null }
    }
    if (-not $selected) {
        Throw-Coded "SOURCE_SELECTION_FAILED" ("row '" + $Name + "' did not report a selected state after SelectionItem.Select") "SOURCE_SELECTION_FAILED"
    }
    return @{
        requested      = $Name
        scope          = $Scope
        paneHeader     = (Get-PaneHeader $win)
        rowText        = (Get-RowText $row)
        wasSelected    = $wasSelected
        uiaSelected    = $true
        navigation     = $navigation
        note           = "UIA reports the row selected; DesignBridge confirms the document selection through UXP."
    }
}

function Get-RowTextElement {
    param($Row)
    try {
        return $Row.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, "displayText")))
    } catch { return $Row }
}

# ---------------------------------------------------------------------------
# interaction pane
# ---------------------------------------------------------------------------
function Get-FieldControlId {
    param([string]$Field)
    switch ($Field) {
        "trigger"     { return "interactionPopoverTriggerEventPopup" }
        "action"      { return "interactionPopoverActionPopup" }
        "destination" { return "interactionPopoverTargetPopup" }
        "transition"  { return "interactionPopoverTransitionPopup" }
        default       { Throw-Coded "invalid_field" ("unknown interaction field: " + $Field) "configure_interaction" }
    }
}

function Read-InteractionState {
    param($Win)
    $state = @{
        panePresent   = $false
        editorOpen    = $false
        editorVisible = $false
        addButton     = $false
        trigger       = $null
        action        = $null
        destination   = $null
        transition    = $null
        easing        = $null
        duration      = $null
        enabled       = @{}
        labels        = @{}
    }
    $pane = Find-ById $Win "kInteractionPaneContainerId"
    $state.panePresent = [bool]$pane
    $add = Find-ById $Win "kInteractionPaneAddButtonId"
    if ($add) { $state.addButton = [bool]$add.Current.IsEnabled } else { $state.addButton = $false }
    $body = Find-ById $Win "kInteractionPrimaryActionContainerId"
    $state.editorVisible = [bool]$body

    foreach ($field in @("trigger", "action", "destination", "transition")) {
        $el = Find-ById $Win (Get-FieldControlId $field)
        if ($el) {
            $state[$field] = Get-Value $el
            $state.labels[$field] = $el.Current.AutomationId
            $state.enabled[$field] = $el.Current.IsEnabled
        }
    }
    $easing = Find-ById $Win "interactionPopoverEasingCombo"
    if ($easing) { $state.easing = Get-Value $easing }
    $duration = Find-ById $Win "interactionPopoverDurationCombo"
    if ($duration) { $state.duration = Get-Value $duration; $state.enabled["duration"] = $duration.Current.IsEnabled }

    # An interaction editor that is actually usable: the destination combo is
    # present AND enabled. XD keeps a detached, disabled copy of the controls in
    # the visual tree when no interaction is being edited, so presence alone is
    # not evidence (verified live on 61.0.12.1).
    $state.editorOpen = ($state.enabled["destination"] -eq $true) -and ($state.addButton -or $state.editorVisible)
    return $state
}

function Add-Interaction {
    param([bool]$Force = $false)
    $xd = Get-XdWindow
    $win = $xd.element

    # Always start a NEW interaction. Idempotency is decided by the caller from
    # the UXP read-back (an existing wire never reaches this point), and XD shows
    # one editor at a time: reusing an open editor would retarget the previous
    # interaction instead of adding another one (verified live).
    $state = Read-InteractionState $win

    $add = Find-ById $win "kInteractionPaneAddButtonId"
    if (-not $add) {
        Throw-Coded "UNSUPPORTED_XD_UI" "the Interaction pane has no 'Add Interaction' button for the current selection" "CONNECTOR_CREATION_FAILED"
    }
    Invoke-Element $add "CONNECTOR_CREATION_FAILED" | Out-Null
    $editor = Wait-Until -TimeoutMs 6000 -Condition {
        $s = Read-InteractionState $win
        if ($s.editorOpen) { $s } else { $null }
    }
    if (-not $editor) {
        Throw-Coded "CONNECTOR_CREATION_FAILED" "no usable interaction editor appeared after 'Add Interaction'" "CONNECTOR_CREATION_FAILED"
    }
    return @{
        added         = $true
        alreadyOpen   = $false
        editorVisible = $true
        state         = $editor
    }
}

function Get-ComboItems {
    param($Combo)
    $names = @()
    if (-not $Combo) { return $names }
    $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::ListItem)
    try {
        $items = $Combo.FindAll($TS::Descendants, $cond)
        foreach ($i in $items) { $n = $i.Current.Name; if ($n) { $names += $n } }
    } catch { }
    return $names
}

function Expand-Combo {
    param($Combo)
    try {
        $ecp = $Combo.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
        if ($ecp -and $ecp.Current.ExpandCollapseState -ne [System.Windows.Automation.ExpandCollapseState]::Expanded) {
            $ecp.Expand()
            Wait-Until -TimeoutMs 2500 -PollMs 80 -Condition {
                try { if ($ecp.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Expanded) { $true } else { $null } } catch { $null }
            } | Out-Null
        }
    } catch { }
}

function Collapse-Combo {
    param($Combo)
    try {
        $ecp = $Combo.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
        if ($ecp -and $ecp.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Expanded) { $ecp.Collapse() }
    } catch { }
}

function Set-ComboField {
    param([string]$Field, [string]$Value, [string]$Row = "")
    $xd = Get-XdWindow
    $win = $xd.element
    $id = Get-FieldControlId $Field
    $rowSel = Resolve-Row $win $Row
    $combo = $null
    if ($rowSel) {
        switch ($Field) {
            "trigger"     { $combo = $rowSel.trigger }
            "action"      { $combo = $rowSel.action }
            "destination" { $combo = $rowSel.target }
            "transition"  { $combo = $rowSel.transition }
        }
    }
    if (-not $combo) { $combo = Find-ById $win $id }
    if (-not $combo -or -not $combo.Current.IsEnabled) {
        # Recovery: XD can collapse the editor between edges. Add-Interaction is
        # idempotent, so reopen it once instead of failing the edge.
        Add-Interaction | Out-Null
        Start-Sleep -Milliseconds 500
        $combo = Find-ById $win $id
    }
    if (-not $combo) {
        Throw-Coded "INTERACTION_CONFIGURATION_FAILED" ("interaction control not found: " + $id) "INTERACTION_CONFIGURATION_FAILED"
    }
    if (-not $combo.Current.IsEnabled) {
        Throw-Coded "INTERACTION_CONFIGURATION_FAILED" ("interaction control is disabled (no active interaction editor): " + $id) "INTERACTION_CONFIGURATION_FAILED"
    }
    $before = Get-Value $combo
    if ($before -and ($before.Trim() -ieq $Value.Trim())) {
        return @{ field = $Field; control = $id; before = $before; after = $before; changed = $false; alreadySet = $true }
    }
    Expand-Combo $combo

    $nameCond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $Value)
    $typeCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::ListItem)
    $both = New-Object System.Windows.Automation.AndCondition($nameCond, $typeCond)
    $item = $combo.FindFirst($TS::Descendants, $both)

    if (-not $item) {
        # The destination list is a virtualized ComboBox popup: only the rows
        # currently in view exist as ListItems and no Scroll pattern is exposed.
        # Page through the popup with END (documented keyboard navigation) until
        # the row is realised. Bounded, then reported - never a blind click.
        try { $combo.SetFocus() } catch { }
        $previousCount = -1
        for ($i = 0; $i -lt 10 -and -not $item; $i++) {
            try {
                Add-Type -AssemblyName System.Windows.Forms
                [System.Windows.Forms.SendKeys]::SendWait("{END}")
            } catch { break }
            Start-Sleep -Milliseconds 350
            $item = $combo.FindFirst($TS::Descendants, $both)
            $realized = @(Get-ComboItems $combo)
            if (-not $item -and $realized.Count -eq $previousCount) { break }
            $previousCount = $realized.Count
        }
    }

    if (-not $item) {
        $available = @(Get-ComboItems $combo)
        Collapse-Combo $combo
        Throw-Coded "option_not_found" ("'" + $Value + "' is not an option of " + $Field + ". Realised options: " + (($available | Select-Object -First 40) -join " | ")) "INTERACTION_CONFIGURATION_FAILED"
    }
    try {
        try { $si = $item.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern); if ($si) { $si.ScrollIntoView() } } catch { }
        $sip = $item.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
        if (-not $sip) { Throw-Coded "UNSUPPORTED_XD_UI" ("option '" + $Value + "' has no SelectionItem pattern") "INTERACTION_CONFIGURATION_FAILED" }
        $sip.Select()
    } catch {
        if ($_.Exception.Data['code']) { throw }
        Throw-Coded "INTERACTION_CONFIGURATION_FAILED" ("selecting '" + $Value + "' failed: " + $_.Exception.Message) "INTERACTION_CONFIGURATION_FAILED"
    }
    $after = Wait-Until -TimeoutMs 5000 -PollMs 100 -Condition {
        # XD re-renders the ComboBox when the popup closes, which can invalidate
        # the element we selected from. Re-resolve by AutomationId each poll.
        $fresh = Find-ById $win $id
        if (-not $fresh) { return $null }
        $v = Get-Value $fresh
        if ($v -and ((($v -replace '\s+', ' ').Trim()) -ieq (($Value -replace '\s+', ' ').Trim()))) { $v } else { $null }
    }
    Collapse-Combo $combo
    if (-not $after) {
        $freshNow = Find-ById $win $id
        Throw-Coded "INTERACTION_CONFIGURATION_FAILED" ("control " + $id + " still reads '" + (Get-Value $freshNow) + "' after selecting '" + $Value + "'") "INTERACTION_CONFIGURATION_FAILED"
    }
    return @{ field = $Field; control = $id; before = $before; after = $after; changed = $true; alreadySet = $false }
}

# ---------------------------------------------------------------------------
# duration (editable combo): ValuePattern.SetValue + Enter to commit
# ---------------------------------------------------------------------------
function ConvertTo-Seconds {
    param([string]$Text)
    if (-not $Text) { return $null }
    $t = $Text.Trim().ToLowerInvariant().Replace("s", "").Replace(",", ".").Trim()
    $d = 0.0
    if ([double]::TryParse($t, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$d)) { return $d }
    return $null
}

function Set-DurationField {
    param([double]$Seconds, [string]$Text, [string]$Row = "")
    $xd = Get-XdWindow
    $win = $xd.element
    $rowSel = Resolve-Row $win $Row
    $edit = $null
    if ($rowSel) { $edit = $rowSel.duration }
    if (-not $edit) { $edit = Find-ById $win "interactionPopoverDurationCombo" }
    if (-not $edit -or -not $edit.Current.IsEnabled) {
        Add-Interaction | Out-Null
        Start-Sleep -Milliseconds 500
        $edit = Find-ById $win "interactionPopoverDurationCombo"
    }
    if (-not $edit) {
        Throw-Coded "INTERACTION_CONFIGURATION_FAILED" "the duration field is not exposed" "INTERACTION_CONFIGURATION_FAILED"
    }
    $before = Get-Value $edit
    $beforeSeconds = ConvertTo-Seconds $before
    if ($null -ne $beforeSeconds -and [Math]::Abs($beforeSeconds - $Seconds) -lt 0.0005 -and $Text) {
        return @{ before = $before; after = $before; seconds = $beforeSeconds; changed = $false; alreadySet = $true }
    }
    try {
        $vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        if (-not $vp) { Throw-Coded "UNSUPPORTED_XD_UI" "duration field has no Value pattern" "INTERACTION_CONFIGURATION_FAILED" }
        $vp.SetValue($Text)
        # Commit: XD's duration combo commits on Enter; focus is required first.
        try {
            $edit.SetFocus()
            Add-Type -AssemblyName System.Windows.Forms
            [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
        } catch { }
    } catch {
        if ($_.Exception.Data['code']) { throw }
        Throw-Coded "INTERACTION_CONFIGURATION_FAILED" ("setting the duration failed: " + $_.Exception.Message) "INTERACTION_CONFIGURATION_FAILED"
    }
    $after = Wait-Until -TimeoutMs 4000 -PollMs 100 -Condition {
        $v = Get-Value $edit
        $secs = ConvertTo-Seconds $v
        if ($null -ne $secs -and [Math]::Abs($secs - $Seconds) -lt 0.0005) { $v } else { $null }
    }
    if (-not $after) {
        Throw-Coded "INTERACTION_CONFIGURATION_FAILED" ("duration still reads '" + (Get-Value $edit) + "' after setting '" + $Text + "'") "INTERACTION_CONFIGURATION_FAILED"
    }
    return @{ before = $before; after = $after; seconds = (ConvertTo-Seconds $after); requestedSeconds = $Seconds; changed = $true; alreadySet = $false }
}

# ---------------------------------------------------------------------------
# diagnostics
# ---------------------------------------------------------------------------
function Get-ChildCount {
    param($Element)
    if (-not $Element) { return -1 }
    $n = 0
    try {
        $w = [System.Windows.Automation.TreeWalker]::ControlViewWalker
        $c = $w.GetFirstChild($Element)
        while ($c -ne $null -and $n -lt 500) { $n++; $c = $w.GetNextSibling($c) }
    } catch { }
    return $n
}

function Get-Diagnostics {
    param($Win, [string]$SourceName = "")
    $diag = [ordered]@{
        xdWindowFound            = [bool]$Win
        prototypeModeControlFound = [bool](Find-ById $Win "titlebarPrototypeButton")
        designModeControlFound   = [bool](Find-ById $Win "titlebarDesignButton")
        layersPanelToggleFound   = [bool](Find-ById $Win "toolbarNavigationPaneButton")
        layersPanelFound         = [bool](Find-ById $Win "layersPaneOutlineView")
        interactionPaneFound     = [bool](Find-ById $Win "kInteractionPaneContainerId")
        addInteractionFound      = [bool](Find-ById $Win "kInteractionPaneAddButtonId")
        triggerControlFound      = [bool](Find-ById $Win "interactionPopoverTriggerEventPopup")
        actionControlFound       = [bool](Find-ById $Win "interactionPopoverActionPopup")
        targetControlFound       = [bool](Find-ById $Win "interactionPopoverTargetPopup")
        transitionControlFound   = [bool](Find-ById $Win "interactionPopoverTransitionPopup")
        durationControlFound     = [bool](Find-ById $Win "interactionPopoverDurationCombo")
        sourceLayerFound         = $null
    }
    if ($SourceName) {
        $list = Find-ById $Win "layersPaneOutlineView"
        if ($list) {
            $rows = @(Find-LayerRows $list $SourceName)
            $diag.sourceLayerFound = ($rows.Count -eq 1)
            $diag.sourceLayerMatches = $rows.Count
        } else {
            $diag.sourceLayerFound = $false
            $diag.sourceLayerMatches = 0
        }
    }
    return $diag
}

function Invoke-Probe {
    $xd = Get-XdWindow
    $win = $xd.element
    $w = $win.Current

    $canvas = Find-ById $win "canvasView"
    $interactionPane = Find-ById $win "kInteractionPaneContainerId"
    $layers = Find-ById $win "layersPaneOutlineView"

    # Control inventory: AutomationId + type + patterns only. Element names are
    # deliberately excluded - XD plugin log panels expose names containing raw
    # control characters, and names add nothing to a transport diagnostic.
    $controls = @()
    $all = $win.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($e in $all) {
        $c = $e.Current
        if (-not $c.AutomationId) { continue }
        if ($c.ControlType.ProgrammaticName -in @("ControlType.Image", "ControlType.Text")) { continue }
        $controls += [ordered]@{ automationId = $c.AutomationId; controlType = $c.ControlType.ProgrammaticName.Replace("ControlType.", ""); enabled = $c.IsEnabled; patterns = (Get-PatternNames $e) }
    }

    $interaction = Read-InteractionState $win

    return @{
        xd = @{
            running    = $true
            processId  = $xd.processId
            windowName = $w.Name
            className  = $w.ClassName
            rect       = @{ x = [int]$w.BoundingRectangle.X; y = [int]$w.BoundingRectangle.Y; width = [int]$w.BoundingRectangle.Width; height = [int]$w.BoundingRectangle.Height }
            elementCount = $all.Count
        }
        diagnostics = (Get-Diagnostics $win "")
        exposed = @{
            canvas              = [bool]$canvas
            canvasChildCount    = (Get-ChildCount $canvas)
            canvasObjects       = ((Get-ChildCount $canvas) -gt 0)
            interactionPane     = [bool]$interactionPane
            interactionControls = [bool](Find-ById $win "interactionPopoverTargetPopup")
            interactionEditorOpen = $interaction.editorOpen
            layersPane          = [bool]$layers
            layerRowCount       = (Get-ChildCount $layers)
            prototypeModeToggle = [bool](Find-ById $win "titlebarPrototypeButton")
            designModeToggle    = [bool](Find-ById $win "titlebarDesignButton")
        }
        modes = @{
            design    = (Get-ToggleStateName (Find-ById $win "titlebarDesignButton"))
            prototype = (Get-ToggleStateName (Find-ById $win "titlebarPrototypeButton"))
        }
        interaction = $interaction
        controls = $controls
        probeMarker = "MARK-7"
        capabilities = @{
            uiaTree            = $true
            canvasObjects      = ((Get-ChildCount $canvas) -gt 0)
            semanticLayerSelection = [bool](Find-ById $win "layersPaneOutlineView")
            interactionPaneDriven = [bool]$interactionPane
            mouseInputUsed     = $false
        }
    }
}

# ---------------------------------------------------------------------------
# dispatch
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# multi-interaction sources: index-paired rows, discovery, deletion
#
# XD 61 renders interactions as FLAT repeated controls in the Interaction pane:
# the i-th enabled interactionPopoverTargetPopup belongs to the i-th interaction,
# together with the i-th trigger/action/transition/duration control. There is no
# per-row container element, so rows are paired by index (verified live).
# ---------------------------------------------------------------------------
function Get-EnabledElementsById {
    param($Win, [string]$Id)
    $cond = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $Id)
    $out = @()
    try { foreach ($e in $Win.FindAll($TS::Descendants, $cond)) { if ($e.Current.IsEnabled) { $out += $e } } } catch { }
    return $out
}

function Get-At {
    param($List, [int]$Index)
    if ($null -eq $List) { return $null }
    $arr = @($List)
    if ($Index -ge 0 -and $Index -lt $arr.Count) { return $arr[$Index] }
    return $null
}

function Get-RowControls {
    param($Win)
    $targets = @(Get-EnabledElementsById $Win "interactionPopoverTargetPopup")
    if ($targets.Count -eq 0) { return @() }
    $triggers = @(Get-EnabledElementsById $Win "interactionPopoverTriggerEventPopup")
    $actions = @(Get-EnabledElementsById $Win "interactionPopoverActionPopup")
    $transitions = @(Get-EnabledElementsById $Win "interactionPopoverTransitionPopup")
    $durations = @(Get-EnabledElementsById $Win "interactionPopoverDurationCombo")
    $rows = @()
    for ($i = 0; $i -lt $targets.Count; $i++) {
        $rows += [ordered]@{
            index       = $i
            target      = $targets[$i]
            targetValue = (Get-Value $targets[$i])
            trigger     = (Get-At $triggers $i)
            action      = (Get-At $actions $i)
            transition  = (Get-At $transitions $i)
            duration    = (Get-At $durations $i)
        }
    }
    return $rows
}

function Resolve-Row {
    param($Win, $RowSpec)
    $rows = @(Get-RowControls $Win)
    if ($rows.Count -eq 0) { return $null }
    $spec = ""
    if ($RowSpec) { $spec = [string]$RowSpec }
    if (-not $spec -or $spec -eq "first") { return $rows[0] }
    if ($spec -eq "last") { return $rows[-1] }
    if ($spec -match "^\d+$") {
        $idx = [int]$spec
        if ($idx -lt 0 -or $idx -ge $rows.Count) {
            Throw-Coded "row_not_found" ("row index " + $idx + " out of range (" + $rows.Count + " interaction rows)") "INTERACTION_CONFIGURATION_FAILED"
        }
        return $rows[$idx]
    }
    foreach ($r in $rows) {
        $d = [string]$r.targetValue
        if ($d -eq $spec) { return $r }
        if ($d -and $d.Trim() -ieq $spec.Trim()) { return $r }
    }
    Throw-Coded "row_not_found" ("no interaction row points to '" + $spec + "' (rows: " + ((@($rows | ForEach-Object { [string]$_.targetValue })) -join " | ") + ")") "INTERACTION_CONFIGURATION_FAILED"
}

function Get-InteractionRows {
    param($Win)
    $out = @()
    foreach ($r in @(Get-RowControls $Win)) {
        $out += [ordered]@{
            index      = $r.index
            destination = [string]$r.targetValue
            trigger    = (Get-Value $r.trigger)
            action     = (Get-Value $r.action)
            transition = (Get-Value $r.transition)
            duration   = (Get-Value $r.duration)
        }
    }
    return $out
}

function Add-AnotherInteraction {
    $xd = Get-XdWindow
    $win = $xd.element
    $add = Find-ById $win "kInteractionPaneAddButtonId"
    if (-not $add) {
        Throw-Coded "UNSUPPORTED_XD_UI" "the Interaction pane has no 'Add Interaction' button" "CONNECTOR_CREATION_FAILED"
    }
    $beforeRows = @(Get-InteractionRows $win)
    Invoke-Element $add "CONNECTOR_CREATION_FAILED" | Out-Null

    # A new interaction always starts with no destination. The pane shows ONE
    # editor at a time (never a growing list), so "did it add?" is detected from
    # the fresh placeholder, not from a row count.
    $fresh = Wait-Until -TimeoutMs 5000 -PollMs 120 -Condition {
        $rows = @(Get-InteractionRows $win)
        if ($rows.Count -eq 0) { return $null }
        $last = $rows[-1]
        $d = [string]$last.destination
        if (-not $d -or $d -eq "(Choose an artboard)") { $last } else { $null }
    }
    if (-not $fresh) {
        $triggerHint = ""
        try {
            $combo = (Resolve-Row $win "last").trigger
            Expand-Combo $combo
            $opts = @(Get-ComboItems $combo)
            Collapse-Combo $combo
            $triggerHint = ($opts -join " | ")
        } catch { }
        Throw-Coded "no_free_trigger" ("no new interaction editor appeared. XD allows one interaction per trigger, so a source only accepts triggers it does not already use. Free triggers now: " + $triggerHint) "CONNECTOR_CREATION_FAILED"
    }
    return @{ added = $true; rowsBefore = $beforeRows.Count; row = $fresh; note = "one editor per pane; the new interaction is the current one" }
}

function Find-RowByDestination {
    param($Win, [string]$TargetName)
    $matches = @()
    foreach ($r in @(Get-RowControls $Win)) {
        $d = [string]$r.targetValue
        if ($d -eq $TargetName) { $matches += $r }
        elseif ($d -and $d.Trim() -ieq $TargetName.Trim()) { $matches += $r }
    }
    return $matches
}

<#
  Deletion strategy (probed live):
   1. XD exposes no per-row delete control while an interaction is being edited
      (the pane's only buttons are "Add Interaction" / "Add Action").
   2. Therefore the supported way to remove a wire through the same UI is to
      clear the interaction's destination, which removes it from the prototype
      graph. The adapter ALWAYS verifies the result through UXP read-back; a row
      that still produces a wire is reported as a failed deletion.
#>
function Remove-InteractionRow {
    param([string]$TargetName)
    $xd = Get-XdWindow
    $win = $xd.element
    $matches = @(Find-RowByDestination $win $TargetName)
    if ($matches.Count -eq 0) {
        $rows = @(Get-InteractionRows $win)
        Throw-Coded "row_not_found" ("no interaction row points to '" + $TargetName + "' (rows: " + ((@($rows | ForEach-Object { [string]$_.destination })) -join " | ") + ")") "INTERACTION_DELETION_FAILED"
    }
    if ($matches.Count -gt 1) {
        Throw-Coded "ambiguous_row" ("'" + $TargetName + "' matches " + $matches.Count + " interaction rows") "INTERACTION_DELETION_FAILED"
    }
    $row = $matches[0]
    $before = @(Get-InteractionRows $win)

    # 1. a real delete control, if this XD build exposes one
    $deleteInvoked = $false
    $usedControl = $null
    $btnCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Button)
    try {
        foreach ($b in $win.FindAll($TS::Descendants, $btnCond)) {
            $n = ([string]$b.Current.Name).ToLowerInvariant()
            $id = ([string]$b.Current.AutomationId).ToLowerInvariant()
            if ($n -match "^(delete|remove)" -or $id -match "delete|remove") {
                Invoke-Element $b "INTERACTION_DELETION_FAILED" | Out-Null
                $deleteInvoked = $true
                $usedControl = @{ name = $b.Current.Name; automationId = $b.Current.AutomationId }
                break
            }
        }
    } catch { }

    if (-not $deleteInvoked) {
        Throw-Coded "UNSUPPORTED_XD_UI" "XD 61 exposes no way to remove an existing interaction: a selection that already has wires shows only 'Add Interaction' in the Interaction pane (the existing interactions are never listed), there is no delete/remove control in the pane or in the Object/Edit menus, and a committed interaction's destination cannot be reset to the empty option. Deletion is therefore not reachable through UI Automation." "INTERACTION_DELETION_FAILED"
    }

    $cleared = Wait-Until -TimeoutMs 6000 -PollMs 150 -Condition {
        $same = @(Find-RowByDestination $win $TargetName)
        if ($same.Count -eq 0) { $true } else { $null }
    }
    if (-not $cleared) {
        Throw-Coded "INTERACTION_DELETION_FAILED" ("the interaction row for '" + $TargetName + "' still points at it after the delete action") "INTERACTION_DELETION_FAILED"
    }
    return @{
        status      = "deleted"
        target      = $TargetName
        mechanism   = if ($deleteInvoked) { "delete_control" } else { "clear_destination" }
        usedControl = $usedControl
        rowsBefore  = @($before).Count
        rowsAfter   = @(Get-InteractionRows $win).Count
        note        = "UI reports the row cleared; DesignBridge must confirm through UXP that no wire remains."
    }
}
# ---------------------------------------------------------------------------
# DesignBridge panel: pending state + Apply Pending (UIA)
#
# The panel is a UXP webview inside the right sidebar. Its DOM is exposed to UIA
# once the Plugins pane is the active tab, with these stable AutomationIds:
#   execBtn    Button  - "Apply" | "Apply N change(s)" | "Applying." ; disabled
#                        when the queue is empty or a batch is executing
#   queueInfo  Custom  - "Idle - nothing queued" | "N change(s) waiting" |
#                        "N change(s) ready - click anywhere in this panel to apply" |
#                        "Applying."
#   autoChk    CheckBox- "Apply automatically"
# The panel host element itself reports IsOffscreen=true with an empty rect even
# when realized, so realisation is detected by the presence of execBtn.
# ---------------------------------------------------------------------------
function Ensure-Panel {
    $xd = Get-XdWindow
    $win = $xd.element
    $btn = Find-ById $win "execBtn"
    if (-not $btn) {
        $plugins = Find-ById $win "toolbarPluginsPaneButton"
        if ($plugins) {
            try {
                $tp = $plugins.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
                if ($tp.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::On) { $tp.Toggle() }
            } catch { }
        }
        $btn = Wait-Until -TimeoutMs 3000 -PollMs 150 -Condition { Find-ById $win "execBtn" }
        if ($btn) { $win = (Get-XdWindow).element }
    }
    return @{ window = $win; button = $btn }
}

function Get-PanelStateInternal {
    $ctx = Ensure-Panel
    $win = $ctx.window
    $btn = $ctx.button
    $state = [ordered]@{
        panelFound = [bool]$btn
        applyButton = $null
        queueInfo = $null
        autoApply = $null
        windowName = $null
    }
    try { $state.windowName = (Clean-Text $win.Current.Name) } catch { }
    if (-not $btn) { return $state }
    $state.applyButton = [ordered]@{
        found = $true
        automationId = "execBtn"
        enabled = $btn.Current.IsEnabled
        name = (Clean-Text $btn.Current.Name)
        offscreen = $btn.Current.IsOffscreen
        patterns = (Get-PatternNames $btn)
    }
    $info = Find-ById $win "queueInfo"
    if ($info) { $state.queueInfo = (Clean-Text $info.Current.Name) }
    $auto = Find-ById $win "autoChk"
    if ($auto) {
        try { $state.autoApply = [string]$auto.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState } catch { $state.autoApply = "unknown" }
    }
    return $state
}

<#
  Set the panel's "Apply automatically" checkbox through its real UIA control.
  Never trusts the click: the toggle state is re-read and compared, and the
  caller is told both the value found and the value achieved so it can restore
  the original setting in a cleanup path.
#>
function Set-AutoApply {
    param([string]$Enabled)
    $target = [string]$Enabled
    if ($target -ne "On" -and $target -ne "Off") {
        Throw-Coded "invalid_params" ("enabled must be On or Off, got '" + $target + "'") "PANEL_STATE_FAILED"
    }
    $ctx = Ensure-Panel
    $win = $ctx.window
    $chk = Find-ById $win "autoChk"
    if (-not $chk) {
        Throw-Coded "UNSUPPORTED_XD_UI" "autoChk is not exposed; the DesignBridge panel is not realised" "PANEL_STATE_FAILED"
    }
    $tp = $null
    try { $tp = $chk.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern) } catch { }
    if (-not $tp) {
        Throw-Coded "UNSUPPORTED_XD_UI" "autoChk has no Toggle pattern" "PANEL_STATE_FAILED"
    }
    $before = [string]$tp.Current.ToggleState
    $toggled = $false
    if ($before -ne $target) {
        $tp.Toggle()
        $toggled = $true
        $reached = Wait-Until -TimeoutMs 4000 -PollMs 100 -Condition {
            try { if ([string]$tp.Current.ToggleState -eq $target) { $true } else { $null } } catch { $null }
        }
        if (-not $reached) {
            $now = "unknown"
            try { $now = [string]$tp.Current.ToggleState } catch { }
            Throw-Coded "PANEL_STATE_FAILED" ("autoChk did not reach '" + $target + "' (reads '" + $now + "')") "PANEL_STATE_FAILED"
        }
    }
    $after = [string]$tp.Current.ToggleState
    if ($after -ne $target) {
        Throw-Coded "PANEL_STATE_FAILED" ("autoChk verification failed: wanted " + $target + ", reads " + $after) "PANEL_STATE_FAILED"
    }
    return @{
        before = $before
        requested = $target
        after = $after
        toggled = $toggled
        verified = $true
        control = @{ automationId = "autoChk"; patterns = (Get-PatternNames $chk) }
    }
}
function Invoke-ApplyButton {
    param([string]$ExpectedBatchHint = "")
    $ctx = Ensure-Panel
    $win = $ctx.window
    $btn = $ctx.button
    if (-not $btn) {
        return @{ clicked = $false; reason = "panel-not-available"; detail = "execBtn is not exposed to UI Automation" }
    }
    $state = Get-PanelStateInternal
    if (-not $btn.Current.IsEnabled) {
        return @{ clicked = $false; reason = "button-disabled"; queueInfo = $state.queueInfo; name = $state.applyButton.name }
    }
    $nameBefore = $state.applyButton.name
    $queueBefore = $state.queueInfo
    try { Invoke-Element $btn "APPLY_FAILED" | Out-Null } catch {
        return @{ clicked = $false; reason = "invoke-failed"; detail = $_.Exception.Message }
    }

    # Observe an execution state change: "Applying." text, a disabled button, or
    # the queue text leaving its previous value. "Applying." can be too fast to
    # catch, so completion is correlated by the bridge through batchExecuted.
    $started = Wait-Until -TimeoutMs 4000 -PollMs 100 -Condition {
        $s = Get-PanelStateInternal
        $q = [string]$s.queueInfo
        $n = [string]$s.applyButton.name
        if ($q -match "Applying" -or $n -match "Applying") { return "applying" }
        if ($q -and $q -ne $queueBefore) { return "queue-changed" }
        if ($null -ne $s.applyButton.enabled -and -not $s.applyButton.enabled -and $queueBefore -ne "Idle - nothing queued") { return "disabled" }
        return $null
    }
    $after = Get-PanelStateInternal
    return @{
        clicked = $true
        nameBefore = $nameBefore
        queueInfoBefore = $queueBefore
        observedStateChange = $started
        executionStartedObserved = [bool]$started
        nameAfter = $after.applyButton.name
        queueInfoAfter = $after.queueInfo
    }
}
function Invoke-WorkerRequest {
    param($Request)
    $cmd = [string]$Request.cmd
    $a = @{}
    if ($Request.PSObject.Properties['args'] -and $Request.args) {
        foreach ($p in $Request.args.PSObject.Properties) { $a[$p.Name] = $p.Value }
    }
    $result = $null
    try {
    switch ($cmd) {
        "ping"        { $result = @{ alive = $true; powershell = $PSVersionTable.PSVersion.ToString() } }
        "probe"       { $result = Invoke-Probe }
        "inventory"   { $result = Invoke-Probe }
        "get_state"   {
            $xd = Get-XdWindow
            $win = $xd.element
            $result = @{
                diagnostics = (Get-Diagnostics $win ([string]$a['name']))
                modes = @{
                    design    = (Get-ToggleStateName (Find-ById $win "titlebarDesignButton"))
                    prototype = (Get-ToggleStateName (Find-ById $win "titlebarPrototypeButton"))
                }
                interaction = (Read-InteractionState $win)
                window = @{ name = $win.Current.Name; processId = $xd.processId }
            }
        }
        "focus_xd"    { $result = Ensure-Foreground }
        "ensure_mode" { $result = Set-Workspace -Mode ([string]$a.mode) }
        "select_node" { $result = Select-Node -Name ([string]$a['name']) -Scope $(if ($a['scope']) { [string]$a['scope'] } else { "artboard" }) }
        "read_interaction" { $xd = Get-XdWindow; $result = Read-InteractionState $xd.element }
        "add_interaction"  { $result = Add-Interaction -Force ([bool]$a['force']) }
        "list_options" {
            $xd = Get-XdWindow
            $combo = Find-ById $xd.element (Get-FieldControlId ([string]$a.field))
            if (-not $combo) { Throw-Coded "element_not_found" "field control not found" "configure_interaction" }
            Expand-Combo $combo
            $items = Get-ComboItems $combo
            Collapse-Combo $combo
            $result = @{ field = [string]$a.field; current = (Get-Value $combo); options = $items }
        }
        "set_field"   { $result = Set-ComboField -Field ([string]$a.field) -Value ([string]$a.value) -Row ([string]$a['row']) }
        "list_rows"   { $xd = Get-XdWindow; $result = @{ rows = @(Get-InteractionRows $xd.element) } }
        "add_another" { $result = Add-AnotherInteraction }
        "delete_row"  { $result = Remove-InteractionRow -TargetName ([string]$a.target) }
        "panel_state" { $result = Get-PanelStateInternal }
        "click_apply" { $result = Invoke-ApplyButton -ExpectedBatchHint ([string]$a['hint']) }
        "set_auto_apply" { $result = Set-AutoApply -Enabled ([string]$a['enabled']) }
        "set_duration" {
            $seconds = [double]$a.seconds
            $text = [string]$a.text
            $result = Set-DurationField -Seconds $seconds -Text $text -Row ([string]$a['row'])
        }
        default { Throw-Coded "unknown_command" ("unknown worker command: " + $cmd) "worker" }
    }
        $jsonOut = @{ ok = $true; cmd = $cmd; result = $result } | ConvertTo-Json -Depth 12 -Compress
        # XD element names can carry raw control characters; -Compress emits no
        # structural newlines, so folding them to spaces keeps the payload valid.
        $jsonOut = $jsonOut -replace '[\u0000-\u001F]', " "
        return $jsonOut
    }
    catch {
        $code = if ($_.Exception.Data['code']) { [string]$_.Exception.Data['code'] } else { "AUTOMATION_ERROR" }
        $stage = if ($_.Exception.Data['stage']) { [string]$_.Exception.Data['stage'] } else { $cmd }
        $errOut = @{ ok = $false; cmd = $cmd; error = @{ code = $code; message = $_.Exception.Message; stage = $stage } } | ConvertTo-Json -Depth 8 -Compress
        $errOut = $errOut -replace '[\u0000-\u001F]', " "
        return $errOut
    }
}

if ($Serve) {
    # Persistent mode: one JSON request per line, one JSON response per line.
    # Strictly serial - the dispatcher answers one command at a time.
    while ($true) {
        $line = [Console]::In.ReadLine()
        if ($null -eq $line) { break }
        $line = $line.Trim()
        if (-not $line) { continue }
        $req = $null
        try { $req = $line | ConvertFrom-Json } catch {
            [Console]::Out.WriteLine('{"ok":false,"cmd":"parse","error":{"code":"bad_request","message":"invalid JSON line","stage":"worker"}}')
            [Console]::Out.Flush()
            continue
        }
        $out = Invoke-WorkerRequest $req
        [Console]::Out.WriteLine($out)
        [Console]::Out.Flush()
    }
    exit 0
}

$request = $null
try {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Base64))
    $request = $json | ConvertFrom-Json
} catch {
    @{ ok = $false; cmd = "parse"; error = @{ code = "bad_request"; message = "request was not valid base64 JSON"; stage = "worker" } } | ConvertTo-Json -Depth 8 -Compress
    exit 1
}
[Console]::Out.WriteLine((Invoke-WorkerRequest $request))






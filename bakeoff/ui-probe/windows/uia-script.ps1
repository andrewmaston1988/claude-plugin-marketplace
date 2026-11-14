# Per-call UIA adapter: one process per command, JSON in on argv, JSON out on stdout.
# Windows PowerShell 5.1 (STA by default since v3), no install required.
#
#   powershell.exe -File uia-script.ps1 -CommandJson '{"op":"find","title":"..."}'
#
# ops: find | tree | get | click | set | list
# Every reply: { ok, op, ms, ... } and on failure { ok:false, error, ms }.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$CommandJson
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Web.Extensions
$sw = [System.Diagnostics.Stopwatch]::StartNew()

function Reply([hashtable]$payload) {
    $payload['ms'] = [int]$sw.ElapsedMilliseconds
    [Console]::Out.WriteLine(($payload | ConvertTo-Json -Depth 10 -Compress))
    [Console]::Out.Flush()
}

function Get-ControlType([System.Windows.Automation.AutomationElement]$el) {
    return $el.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
}

function Find-Window([hashtable]$cmd) {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    if ($cmd.ContainsKey('pid') -and $cmd['pid']) {
        $cond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$cmd['pid'])
        $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
        if ($null -eq $el) {
            # A packaged app (Notepad) has no top-level child owned by the launched PID.
            $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
        }
        return $el
    }
    $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, [string]$cmd['title'])
    return $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
}

function Find-Element([hashtable]$cmd) {
    $window = Find-Window $cmd
    if ($null -eq $window) { throw 'window not found' }
    # Match Name or AutomationId: WinForms/WPF ListBoxes expose an empty Name and only an id.
    $nameCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, [string]$cmd['name'])
    $idCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::AutomationIdProperty, [string]$cmd['name'])
    $conds = New-Object System.Collections.Generic.List[System.Windows.Automation.Condition]
    $conds.Add((New-Object System.Windows.Automation.OrCondition($nameCond, $idCond)))
    if ($cmd.ContainsKey('controlType') -and $cmd['controlType']) {
        $ct = [System.Windows.Automation.ControlType]::GetControlTypeFromProgrammaticName('ControlType.' + $cmd['controlType'])
        $conds.Add((New-Object System.Windows.Automation.PropertyCondition(
                    [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ct)))
    }
    if ($conds.Count -eq 1) { $cond = $conds[0] } else {
        $cond = New-Object System.Windows.Automation.AndCondition($conds.ToArray())
    }
    return $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
}

function Get-Tree([hashtable]$cmd) {
    if ($cmd.ContainsKey('maxDepth') -and $cmd['maxDepth']) { $maxDepth = [int]$cmd['maxDepth'] } else { $maxDepth = 40 }
    $useCache = [bool]$cmd['cache']
    $script:treeTiming = @{ find_ms = 0; walk_ms = 0 }

    $props = @(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
        [System.Windows.Automation.AutomationElement]::BoundingRectangleProperty,
        [System.Windows.Automation.AutomationElement]::IsOffscreenProperty
    )

    $swFind = [System.Diagnostics.Stopwatch]::StartNew()
    $window = Find-Window $cmd
    if ($null -eq $window) { throw 'window not found' }
    $script:treeTiming.find_ms = [int]$swFind.ElapsedMilliseconds

    if ($useCache) {
        # The canonical cached fetch: push a subtree CacheRequest, then one FindAll.
        # (A cache request only fills elements fetched while it is active.)
        $swWalk = [System.Diagnostics.Stopwatch]::StartNew()
        $cache = New-Object System.Windows.Automation.CacheRequest
        foreach ($p in $props) { [void]$cache.Add($p) }
        $cache.TreeScope = [System.Windows.Automation.TreeScope]::Subtree
        $cache.Push()
        try {
            $window = Find-Window $cmd
            if ($null -eq $window) { throw 'window not found under cache request' }
            $all = $window.FindAll([System.Windows.Automation.TreeScope]::Subtree,
                [System.Windows.Automation.Condition]::TrueCondition)
        }
        finally { $cache.Pop() }
        $script:treeTiming.walk_ms = [int]$swWalk.ElapsedMilliseconds
        $nodes = New-Object System.Collections.Generic.List[object]
        foreach ($el in $all) {
            $info = $el.Cached
            $rect = $info.BoundingRectangle
            $ct = $info.ControlType
            if ($null -eq $ct) { $ctype = '' } else { $ctype = $ct.ProgrammaticName -replace '^ControlType\.', '' }
            $x = -1; $y = -1; $w = -1; $h = -1
            if ($null -ne $rect) {
                if (-not ([double]::IsInfinity($rect.X) -or [double]::IsNaN($rect.X))) { $x = [int]$rect.X }
                if (-not ([double]::IsInfinity($rect.Y) -or [double]::IsNaN($rect.Y))) { $y = [int]$rect.Y }
                if (-not ([double]::IsInfinity($rect.Width) -or [double]::IsNaN($rect.Width))) { $w = [int]$rect.Width }
                if (-not ([double]::IsInfinity($rect.Height) -or [double]::IsNaN($rect.Height))) { $h = [int]$rect.Height }
            }
            $nodes.Add([ordered]@{
                    depth = -1
                    type  = $ctype
                    name  = [string]$info.Name
                    id    = [string]$info.AutomationId
                    x     = $x; y = $y; w = $w; h = $h
                    off   = [bool]$info.IsOffscreen
                })
        }
        return $nodes
    }

    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $script:walkNodes = New-Object System.Collections.Generic.List[object]
    $script:uiaWalker = $walker
    function Walk-Tree([System.Windows.Automation.AutomationElement]$el, [int]$depth, [int]$depthLimit) {
        $info = $el.Current
        # Collapsed WPF elements report an infinite rect; keep the node, mark the box unknown.
        $rect = $info.BoundingRectangle
        $x = -1; $y = -1; $w = -1; $h = -1
        if (-not ([double]::IsInfinity($rect.X) -or [double]::IsNaN($rect.X))) { $x = [int]$rect.X }
        if (-not ([double]::IsInfinity($rect.Y) -or [double]::IsNaN($rect.Y))) { $y = [int]$rect.Y }
        if (-not ([double]::IsInfinity($rect.Width) -or [double]::IsNaN($rect.Width))) { $w = [int]$rect.Width }
        if (-not ([double]::IsInfinity($rect.Height) -or [double]::IsNaN($rect.Height))) { $h = [int]$rect.Height }
        $ct = $info.ControlType
        if ($null -eq $ct) { $ctype = '' } else { $ctype = $ct.ProgrammaticName -replace '^ControlType\.', '' }
        $script:walkNodes.Add([ordered]@{
                depth = $depth
                type  = $ctype
                name  = [string]$info.Name
                id    = [string]$info.AutomationId
                x     = $x; y = $y; w = $w; h = $h
                off   = [bool]$info.IsOffscreen
            })
        if ($depth -ge $depthLimit) { return }
        $child = $script:uiaWalker.GetFirstChild($el)
        while ($null -ne $child) {
            Walk-Tree $child ($depth + 1) $depthLimit
            $child = $script:uiaWalker.GetNextSibling($child)
        }
    }
    $swWalk = [System.Diagnostics.Stopwatch]::StartNew()
    Walk-Tree $window 0 $maxDepth
    $script:treeTiming.walk_ms = [int]$swWalk.ElapsedMilliseconds
    return $script:walkNodes
}

try {
    # ConvertFrom-Json -AsHashtable is PS6+; JavaScriptSerializer gives a dictionary on 5.1.
    $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $cmd = $serializer.DeserializeObject($CommandJson)
    switch ($cmd['op']) {
        'find' {
            $el = Find-Window $cmd
            if ($null -eq $el) {
                Reply @{ ok = $false; op = 'find'; error = 'window not found' }
                exit 1
            }
            $rect = $el.Current.BoundingRectangle
            Reply @{
                ok = $true; op = 'find'; hwnd = $el.Current.NativeWindowHandle
                pid = $el.Current.ProcessId; name = $el.Current.Name
                cls = $el.Current.ClassName
                x = [int]$rect.X; y = [int]$rect.Y; w = [int]$rect.Width; h = [int]$rect.Height
            }
        }
        'tree' {
            $nodes = Get-Tree $cmd
            Reply @{ ok = $true; op = 'tree'; count = $nodes.Count; find_ms = $script:treeTiming.find_ms; walk_ms = $script:treeTiming.walk_ms; nodes = $nodes }
        }
        'tree_uncached' {
            $cmd['cache'] = $false
            $nodes = Get-Tree $cmd
            Reply @{ ok = $true; op = 'tree_uncached'; count = $nodes.Count; find_ms = $script:treeTiming.find_ms; walk_ms = $script:treeTiming.walk_ms; nodes = $nodes }
        }
        'tree_cached' {
            $cmd['cache'] = $true
            $nodes = Get-Tree $cmd
            Reply @{ ok = $true; op = 'tree_cached'; count = $nodes.Count; find_ms = $script:treeTiming.find_ms; walk_ms = $script:treeTiming.walk_ms; nodes = $nodes }
        }
        'get' {
            $el = Find-Element $cmd
            if ($null -eq $el) { throw 'element not found' }
            $value = $null
            $pattern = $null
            try {
                $pattern = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                $value = $pattern.Current.Value
            } catch {
                try {
                    $pattern = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
                    $value = $pattern.Current.ToggleState.ToString()
                } catch {
                    $value = $el.Current.Name
                }
            }
            Reply @{ ok = $true; op = 'get'; value = [string]$value; type = (Get-ControlType $el) }
        }
        'click' {
            $el = Find-Element $cmd
            if ($null -eq $el) { throw 'element not found' }
            $used = 'invoke'
            try {
                $p = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
                $p.Invoke()
            } catch {
                try {
                    $used = 'toggle'
                    $p = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
                    $p.Toggle()
                } catch {
                    $used = 'selectionitem'
                    $p = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
                    $p.Select()
                }
            }
            Reply @{ ok = $true; op = 'click'; used = $used; type = (Get-ControlType $el) }
        }
        'set' {
            $el = Find-Element $cmd
            if ($null -eq $el) { throw 'element not found' }
            $p = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            $p.SetValue([string]$cmd['value'])
            Reply @{ ok = $true; op = 'set'; value = [string]$cmd['value'] }
        }
        'list' {
            $el = Find-Element $cmd
            if ($null -eq $el) { throw 'element not found' }
            $cond = New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                [System.Windows.Automation.ControlType]::ListItem)
            $items = $el.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
            $names = @()
            foreach ($i in $items) { $names += $i.Current.Name }
            Reply @{ ok = $true; op = 'list'; count = $names.Count; items = $names }
        }
        default { throw "unknown op: $($cmd['op'])" }
    }
} catch {
    Reply @{ ok = $false; op = 'error'; error = $_.Exception.Message }
    exit 1
}

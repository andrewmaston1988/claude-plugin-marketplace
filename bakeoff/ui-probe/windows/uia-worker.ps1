# Kept-warm UIA worker: JSON command per line on stdin, one JSON reply per line on stdout.
# Windows PowerShell 5.1. Same ops as uia-script.ps1, but window elements and the UIA
# client stay loaded between commands (no process/Add-Type cost per call), and UIA events
# can be subscribed to.
#
#   powershell.exe -File uia-worker.ps1
#
# Protocol: write {"op":"..."} lines; read {"ok":...,"ms":...} lines. {"op":"quit"} exits.
[CmdletBinding()]
param()

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Web.Extensions

# Events arrive on UIA's callback threads; collect them in .NET so the command loop can
# drain them without touching PowerShell runspaces from another thread.
$sinkSource = @'
using System;
using System.Collections.Concurrent;
using System.Windows.Automation;

public static class UiaEventSink
{
    public static readonly ConcurrentQueue<string> Events = new ConcurrentQueue<string>();
    private static AutomationElement _target;

    private static void OnStructure(object sender, StructureChangedEventArgs e)
    {
        Events.Enqueue("{\"kind\":\"structure\",\"change\":\"" + e.StructureChangeType +
                       "\",\"t\":" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + "}");
    }

    private static void OnProperty(object sender, AutomationPropertyChangedEventArgs e)
    {
        Events.Enqueue("{\"kind\":\"property\",\"prop\":\"" + e.Property.ProgrammaticName +
                       "\",\"t\":" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + "}");
    }

    public static int Subscribe(int hwnd)
    {
        Unsubscribe();
        _target = AutomationElement.FromHandle(new IntPtr(hwnd));
        Automation.AddStructureChangedEventHandler(_target, TreeScope.Subtree, OnStructure);
        Automation.AddAutomationPropertyChangedEventHandler(
            _target, TreeScope.Subtree, OnProperty,
            AutomationElement.NameProperty,
            ValuePattern.ValueProperty,
            TogglePattern.ToggleStateProperty,
            AutomationElement.BoundingRectangleProperty);
        return 0;
    }

    public static int Unsubscribe()
    {
        if (_target != null)
        {
            Automation.RemoveStructureChangedEventHandler(_target, OnStructure);
            Automation.RemoveAutomationPropertyChangedEventHandler(_target, OnProperty);
            _target = null;
        }
        return 0;
    }
}
'@
if (-not ('UiaEventSink' -as [type])) {
    Add-Type -TypeDefinition $sinkSource -ReferencedAssemblies 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase'
}

$serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$windowCache = @{}

function Write-Reply([hashtable]$payload) {
    [Console]::Out.WriteLine(($payload | ConvertTo-Json -Depth 12 -Compress))
    [Console]::Out.Flush()
}

function Get-CacheKey([object]$cmd) {
    if ($cmd.ContainsKey('pid') -and $cmd['pid']) { return "pid:$($cmd['pid'])" }
    return "title:$($cmd['title'])"
}

function Get-Window([object]$cmd, [bool]$forceFresh) {
    $key = Get-CacheKey $cmd
    if (-not $forceFresh -and $windowCache.ContainsKey($key)) {
        $cached = $windowCache[$key]
        try {
            # Touching Current proves the cached element is still connected to a live window.
            $null = $cached.Current.Name
            return $cached
        } catch {
            $windowCache.Remove($key)
        }
    }
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    if ($cmd.ContainsKey('pid') -and $cmd['pid']) {
        $cond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$cmd['pid'])
        $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
        if ($null -eq $el) {
            $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
        }
    } else {
        $cond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::NameProperty, [string]$cmd['title'])
        $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
    }
    if ($null -ne $el) { $windowCache[$key] = $el }
    return $el
}

function Find-Element([object]$cmd) {
    $window = Get-Window $cmd $false
    if ($null -eq $window) { throw 'window not found' }
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

function Get-TreeNodes([object]$cmd, [bool]$useCache) {
    $window = Get-Window $cmd $useCache
    if ($null -eq $window) { throw 'window not found' }
    if ($cmd.ContainsKey('maxDepth') -and $cmd['maxDepth']) { $maxDepth = [int]$cmd['maxDepth'] } else { $maxDepth = 40 }
    $props = @(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
        [System.Windows.Automation.AutomationElement]::BoundingRectangleProperty,
        [System.Windows.Automation.AutomationElement]::IsOffscreenProperty
    )
    $script:treeTiming = @{ find_ms = 0; walk_ms = 0 }
    if ($useCache) {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $cache = New-Object System.Windows.Automation.CacheRequest
        foreach ($p in $props) { [void]$cache.Add($p) }
        $cache.TreeScope = [System.Windows.Automation.TreeScope]::Subtree
        $cache.Push()
        try {
            $window = Get-Window $cmd $true
            if ($null -eq $window) { throw 'window not found' }
            $all = $window.FindAll([System.Windows.Automation.TreeScope]::Subtree,
                [System.Windows.Automation.Condition]::TrueCondition)
        }
        finally { $cache.Pop() }
        $script:treeTiming.walk_ms = [int]$sw.ElapsedMilliseconds
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
                    depth = -1; type = $ctype; name = [string]$info.Name
                    id = [string]$info.AutomationId
                    x = $x; y = $y; w = $w; h = $h; off = [bool]$info.IsOffscreen
                })
        }
        return $nodes
    }
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $script:walkNodes = New-Object System.Collections.Generic.List[object]
    $script:workerWalker = $walker
    function Walk-Tree([System.Windows.Automation.AutomationElement]$el, [int]$depth, [int]$depthLimit) {
        $info = $el.Current
        $rect = $info.BoundingRectangle
        $x = -1; $y = -1; $w = -1; $h = -1
        # A window that closed mid-walk yields a null rect; keep the node rather than
        # dying on a PowerShell property error the caller cannot interpret.
        if ($null -ne $rect) {
            if (-not ([double]::IsInfinity($rect.X) -or [double]::IsNaN($rect.X))) { $x = [int]$rect.X }
            if (-not ([double]::IsInfinity($rect.Y) -or [double]::IsNaN($rect.Y))) { $y = [int]$rect.Y }
            if (-not ([double]::IsInfinity($rect.Width) -or [double]::IsNaN($rect.Width))) { $w = [int]$rect.Width }
            if (-not ([double]::IsInfinity($rect.Height) -or [double]::IsNaN($rect.Height))) { $h = [int]$rect.Height }
        }
        $ct = $info.ControlType
        if ($null -eq $ct) { $ctype = '' } else { $ctype = $ct.ProgrammaticName -replace '^ControlType\.', '' }
        $script:walkNodes.Add([ordered]@{
                depth = $depth; type = $ctype; name = [string]$info.Name
                id = [string]$info.AutomationId
                x = $x; y = $y; w = $w; h = $h; off = [bool]$info.IsOffscreen
            })
        if ($depth -ge $depthLimit) { return }
        $child = $script:workerWalker.GetFirstChild($el)
        while ($null -ne $child) {
            Walk-Tree $child ($depth + 1) $depthLimit
            $child = $script:workerWalker.GetNextSibling($child)
        }
    }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    Walk-Tree $window 0 $maxDepth
    $script:treeTiming.walk_ms = [int]$sw.ElapsedMilliseconds
    return $script:walkNodes
}

[Console]::Out.WriteLine('{"ok":true,"op":"hello","ps":"5.1"}')
[Console]::Out.Flush()

$running = $true
while ($running) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $cmd = $serializer.DeserializeObject($line)
        switch ($cmd['op']) {
            'quit' { Write-Reply @{ ok = $true; op = 'quit'; ms = 0 }; $running = $false; break }
            'find' {
                $el = Get-Window $cmd $false
                if ($null -eq $el) { throw 'window not found' }
                $rect = $el.Current.BoundingRectangle
                Write-Reply @{
                    ok = $true; op = 'find'; hwnd = $el.Current.NativeWindowHandle
                    pid = $el.Current.ProcessId; name = $el.Current.Name
                    cls = $el.Current.ClassName
                    x = [int]$rect.X; y = [int]$rect.Y; w = [int]$rect.Width; h = [int]$rect.Height
                    ms = [int]$sw.ElapsedMilliseconds
                }
            }
            'tree' { $n = Get-TreeNodes $cmd $false; Write-Reply @{ ok = $true; op = 'tree'; count = $n.Count; find_ms = $script:treeTiming.find_ms; walk_ms = $script:treeTiming.walk_ms; nodes = $n; ms = [int]$sw.ElapsedMilliseconds } }
            'tree_uncached' { $n = Get-TreeNodes $cmd $false; Write-Reply @{ ok = $true; op = 'tree_uncached'; count = $n.Count; find_ms = $script:treeTiming.find_ms; walk_ms = $script:treeTiming.walk_ms; nodes = $n; ms = [int]$sw.ElapsedMilliseconds } }
            'tree_cached' { $n = Get-TreeNodes $cmd $true; Write-Reply @{ ok = $true; op = 'tree_cached'; count = $n.Count; find_ms = $script:treeTiming.find_ms; walk_ms = $script:treeTiming.walk_ms; nodes = $n; ms = [int]$sw.ElapsedMilliseconds } }
            'get' {
                $el = Find-Element $cmd
                if ($null -eq $el) { throw 'element not found' }
                try {
                    $value = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
                } catch {
                    try { $value = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState.ToString() }
                    catch { $value = $el.Current.Name }
                }
                Write-Reply @{ ok = $true; op = 'get'; value = [string]$value; ms = [int]$sw.ElapsedMilliseconds }
            }
            'click' {
                $el = Find-Element $cmd
                if ($null -eq $el) { throw 'element not found' }
                $used = 'invoke'
                try { $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
                catch {
                    try { $used = 'toggle'; $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle() }
                    catch { $used = 'selectionitem'; $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select() }
                }
                Write-Reply @{ ok = $true; op = 'click'; used = $used; ms = [int]$sw.ElapsedMilliseconds }
            }
            'set' {
                $el = Find-Element $cmd
                if ($null -eq $el) { throw 'element not found' }
                $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue([string]$cmd['value'])
                Write-Reply @{ ok = $true; op = 'set'; value = [string]$cmd['value']; ms = [int]$sw.ElapsedMilliseconds }
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
                Write-Reply @{ ok = $true; op = 'list'; count = $names.Count; items = $names; ms = [int]$sw.ElapsedMilliseconds }
            }
            'subscribe' {
                $el = Get-Window $cmd $false
                if ($null -eq $el) { throw 'window not found' }
                [void][UiaEventSink]::Subscribe([int]$el.Current.NativeWindowHandle)
                Write-Reply @{ ok = $true; op = 'subscribe'; hwnd = $el.Current.NativeWindowHandle; ms = [int]$sw.ElapsedMilliseconds }
            }
            'unsubscribe' {
                [void][UiaEventSink]::Unsubscribe()
                Write-Reply @{ ok = $true; op = 'unsubscribe'; ms = [int]$sw.ElapsedMilliseconds }
            }
            'events' {
                $events = @()
                $item = $null
                while ([UiaEventSink]::Events.TryDequeue([ref]$item)) { $events += $item }
                Write-Reply @{ ok = $true; op = 'events'; count = $events.Count; events = $events; ms = [int]$sw.ElapsedMilliseconds }
            }
            'ping' { Write-Reply @{ ok = $true; op = 'ping'; ms = [int]$sw.ElapsedMilliseconds } }
            default { throw "unknown op: $($cmd['op'])" }
        }
    } catch {
        Write-Reply @{ ok = $false; op = 'error'; error = $_.Exception.Message; ms = [int]$sw.ElapsedMilliseconds }
    }
}

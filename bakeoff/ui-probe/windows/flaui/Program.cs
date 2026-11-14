// FlaUI UIA3 helper for the ui-probe bake-off (RQ4 contender e).
// Long-running worker: one JSON command per stdin line, one JSON reply per stdout line.
//
//   flaui.exe            serve mode
//   flaui.exe '<json>'   one command (cold, includes process start)
//
// Ops mirror uia-worker.ps1: find | tree | tree_cached | get | click | set | list |
// subscribe | unsubscribe | events | ping | quit.
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Conditions;
using FlaUI.Core.Definitions;
using FlaUI.Core.Identifiers;
using FlaUI.UIA3;

namespace FlaUiHelper;

internal static class Program
{
    private static readonly Stopwatch Clock = Stopwatch.StartNew();

    // FlaUI 4.0 keeps AutomationProperty<T>.PropertyId internal; the public accessor for a
    // CacheRequest/event argument is PropertyId.Find(<UIA property id>).
    private static readonly PropertyId PName = PropertyId.Find(AutomationType.UIA3, 30005);
    private static readonly PropertyId PControlType = PropertyId.Find(AutomationType.UIA3, 30003);
    private static readonly PropertyId PAutomationId = PropertyId.Find(AutomationType.UIA3, 30011);
    private static readonly PropertyId PBoundingRectangle = PropertyId.Find(AutomationType.UIA3, 30001);
    private static readonly PropertyId PIsOffscreen = PropertyId.Find(AutomationType.UIA3, 30022);
    // Subscribed property set is identical to uia-worker.ps1's, so the event rows compare
    // like with like.
    private static readonly PropertyId PValue = PropertyId.Find(AutomationType.UIA3, 30045);
    private static readonly PropertyId PToggleState = PropertyId.Find(AutomationType.UIA3, 30086);
    private static readonly Dictionary<string, AutomationElement> WindowCache = new();
    private static readonly ConcurrentQueue<string> Events = new();
    private static IDisposable? _structureHandler;
    private static IDisposable? _propertyHandler;
    private static UIA3Automation? _automation;

    private static long NowMs() => Clock.ElapsedMilliseconds;

    private static void Write(Dictionary<string, object?> payload)
    {
        payload["ms"] = NowMs();
        Console.WriteLine(JsonSerializer.Serialize(payload));
        Console.Out.Flush();
    }

    private static AutomationElement FindWindow(JsonElement cmd, bool fresh = false)
    {
        var automation = _automation ??= new UIA3Automation();
        var desktop = automation.GetDesktop();
        var key = cmd.TryGetProperty("pid", out var pidProp) && pidProp.GetInt32() != 0
            ? "pid:" + pidProp.GetInt32()
            : "title:" + (cmd.TryGetProperty("title", out var t) ? t.GetString() : "");
        if (!fresh && WindowCache.TryGetValue(key, out var cached))
        {
            try
            {
                var _ = cached.Properties.Name.Value;
                return cached;
            }
            catch
            {
                WindowCache.Remove(key);
            }
        }

        AutomationElement? window;
        if (cmd.TryGetProperty("pid", out var pid) && pid.GetInt32() != 0)
        {
            window = desktop.FindFirstChild(cf => cf.ByProcessId(pid.GetInt32()))
                     ?? desktop.FindFirstDescendant(cf => cf.ByProcessId(pid.GetInt32()));
        }
        else
        {
            var title = cmd.GetProperty("title").GetString() ?? "";
            window = desktop.FindFirstChild(cf => cf.ByName(title));
        }
        if (window is null) throw new InvalidOperationException("window not found");
        WindowCache[key] = window;
        return window;
    }

    private static Dictionary<string, object?> Node(AutomationElement el, int depth)
    {
        // MSAA-proxied WinForms children can reject individual properties; a tree dump
        // must record the node with blanks rather than abort.
        string type = "", name = "", id = "";
        int x = -1, y = -1, w = -1, h = -1;
        bool off = false;
        try { type = el.ControlType.ToString(); } catch { }
        try { name = el.Name ?? ""; } catch { }
        try { id = el.AutomationId ?? ""; } catch { }
        try
        {
            var r = el.BoundingRectangle;
            x = r.X; y = r.Y; w = r.Width; h = r.Height;
        }
        catch { }
        try { off = el.IsOffscreen; } catch { }
        return new Dictionary<string, object?>
        {
            ["depth"] = depth,
            ["type"] = type,
            ["name"] = name,
            ["id"] = id,
            ["x"] = x, ["y"] = y, ["w"] = w, ["h"] = h,
            ["off"] = off,
        };
    }

    private static List<Dictionary<string, object?>> Walk(AutomationElement root)
    {
        var nodes = new List<Dictionary<string, object?>>();
        var stack = new Stack<(AutomationElement el, int depth)>();
        stack.Push((root, 0));
        while (stack.Count > 0)
        {
            var (el, depth) = stack.Pop();
            nodes.Add(Node(el, depth));
            if (depth >= 40) continue;
            AutomationElement[] children;
            try { children = el.FindAllChildren(); }
            catch { continue; }
            for (var i = children.Length - 1; i >= 0; i--) stack.Push((children[i], depth + 1));
        }
        return nodes;
    }

    private static List<Dictionary<string, object?>> WalkCached(AutomationElement root)
    {
        var request = new CacheRequest { TreeScope = TreeScope.Subtree };
        request.Add(PName);
        request.Add(PControlType);
        request.Add(PAutomationId);
        request.Add(PBoundingRectangle);
        request.Add(PIsOffscreen);
        using (request.Activate())
        {
            var all = root.FindAllDescendants();
            var nodes = new List<Dictionary<string, object?>>();
            foreach (var el in all) nodes.Add(Node(el, -1));
            return nodes;
        }
    }

    private static AutomationElement FindElement(AutomationElement window, JsonElement cmd)
    {
        var name = cmd.GetProperty("name").GetString() ?? "";
        var el = window.FindFirstDescendant(cf => cf.ByName(name)) ??
                 window.FindFirstDescendant(cf => cf.ByAutomationId(name));
        if (el is null) throw new InvalidOperationException("element not found");
        return el;
    }

    private static Dictionary<string, object?> Handle(JsonElement cmd)
    {
        var op = cmd.GetProperty("op").GetString() ?? "";
        switch (op)
        {
            case "ping":
                return new() { ["ok"] = true, ["op"] = "ping" };
            case "find":
            {
                var w = FindWindow(cmd);
                var r = w.BoundingRectangle;
                return new()
                {
                    ["ok"] = true, ["op"] = "find", ["name"] = w.Name,
                    ["pid"] = w.Properties.ProcessId.Value, ["cls"] = w.ClassName,
                    ["x"] = r.X, ["y"] = r.Y, ["w"] = r.Width, ["h"] = r.Height,
                };
            }
            case "tree":
            case "tree_uncached":
            {
                var w = FindWindow(cmd);
                var nodes = Walk(w);
                return new() { ["ok"] = true, ["op"] = op, ["count"] = nodes.Count, ["nodes"] = nodes };
            }
            case "tree_cached":
            {
                var w = FindWindow(cmd, fresh: true);
                var nodes = WalkCached(w);
                return new() { ["ok"] = true, ["op"] = op, ["count"] = nodes.Count, ["nodes"] = nodes };
            }
            case "get":
            {
                var el = FindElement(FindWindow(cmd), cmd);
                string value;
                var vp = el.Patterns.Value.PatternOrDefault;
                if (vp is not null && !string.IsNullOrEmpty(vp.Value)) value = vp.Value;
                else
                {
                    var tp = el.Patterns.Toggle.PatternOrDefault;
                    value = tp is not null ? tp.ToggleState.ToString() : (el.Name ?? "");
                }
                return new() { ["ok"] = true, ["op"] = "get", ["value"] = value };
            }
            case "click":
            {
                var el = FindElement(FindWindow(cmd), cmd);
                var used = "invoke";
                if (el.Patterns.Invoke.PatternOrDefault is { } invoke) invoke.Invoke();
                else if (el.Patterns.Toggle.PatternOrDefault is { } toggle) { used = "toggle"; toggle.Toggle(); }
                else if (el.Patterns.SelectionItem.PatternOrDefault is { } sel) { used = "selectionitem"; sel.Select(); }
                else throw new InvalidOperationException("no invoke/toggle/select pattern");
                return new() { ["ok"] = true, ["op"] = "click", ["used"] = used };
            }
            case "set":
            {
                var el = FindElement(FindWindow(cmd), cmd);
                var vp = el.Patterns.Value.PatternOrDefault
                         ?? throw new InvalidOperationException("no value pattern");
                vp.SetValue(cmd.GetProperty("value").GetString() ?? "");
                return new() { ["ok"] = true, ["op"] = "set" };
            }
            case "list":
            {
                var el = FindElement(FindWindow(cmd), cmd);
                var items = el.FindAllChildren()
                    .Where(c => c.ControlType == ControlType.ListItem)
                    .Select(c => c.Name)
                    .ToArray();
                return new() { ["ok"] = true, ["op"] = "list", ["count"] = items.Length, ["items"] = items };
            }
            case "subscribe":
            {
                var w = FindWindow(cmd);
                _structureHandler = w.RegisterStructureChangedEvent(TreeScope.Subtree,
                    (_, type, _) => Events.Enqueue("{\"kind\":\"structure\",\"change\":\"" + type + "\",\"t\":" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + "}"));
                _propertyHandler = w.RegisterPropertyChangedEvent(TreeScope.Subtree,
                    (_, id, _) => Events.Enqueue("{\"kind\":\"property\",\"prop\":\"" + id + "\",\"t\":" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + "}"),
                    new[] { PName, PBoundingRectangle, PValue, PToggleState });
                return new() { ["ok"] = true, ["op"] = "subscribe" };
            }
            case "unsubscribe":
                _structureHandler?.Dispose();
                _propertyHandler?.Dispose();
                _structureHandler = null;
                _propertyHandler = null;
                return new() { ["ok"] = true, ["op"] = "unsubscribe" };
            case "events":
            {
                var drained = new List<string>();
                while (Events.TryDequeue(out var e)) drained.Add(e);
                return new() { ["ok"] = true, ["op"] = "events", ["count"] = drained.Count, ["events"] = drained };
            }
            case "quit":
                return new() { ["ok"] = true, ["op"] = "quit" };
            default:
                throw new InvalidOperationException("unknown op: " + op);
        }
    }

    private static int Main(string[] args)
    {
        if (args.Length > 0)
        {
            try
            {
                using var doc = JsonDocument.Parse(args[0]);
                Write(Handle(doc.RootElement));
                return 0;
            }
            catch (Exception ex)
            {
                Write(new() { ["ok"] = false, ["op"] = "error", ["error"] = ex.Message });
                return 1;
            }
        }

        Write(new() { ["ok"] = true, ["op"] = "hello" });
        string? line;
        while ((line = Console.ReadLine()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            try
            {
                using var doc = JsonDocument.Parse(line);
                var result = Handle(doc.RootElement);
                Write(result);
                if ((string?)result["op"] == "quit") break;
            }
            catch (Exception ex)
            {
                Write(new() { ["ok"] = false, ["op"] = "error", ["error"] = ex.Message });
            }
        }
        _automation?.Dispose();
        return 0;
    }
}

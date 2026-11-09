using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Forms;

// User-run Windows companion. Validation and self-test modes never access UI.
class Request
{
    public string Thread, Role, ShortText;
    public int Position;
    public string[] Anchors, Context, Excluded;

    public static Request Parse(string text)
    {
        if (text.Length > 8192) throw new ArgumentException();
        var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(text);
        Guid id;
        string thread = (string)data["thread_id"];
        string role = (string)data["role"];
        int position = Convert.ToInt32(data["user_position"]);
        int count = Convert.ToInt32(data["captured_user_count"]);
        if (Convert.ToInt32(data["version"]) != 1 || !Guid.TryParse(thread, out id)
            || (role != "user" && role != "assistant") || position < 1 || position > count || count > 100000
            || (string)data["scope"] != "current_window") throw new ArgumentException();
        var request = new Request { Thread = thread, Role = role, Position = position,
            Anchors = Strings(data, "anchors"), Context = Strings(data, "context_anchors"),
            Excluded = Strings(data, "excluded_origins"),
            ShortText = data.ContainsKey("short_text") ? (string)data["short_text"] : null };
        if (request.Anchors.Length > 4 || request.Context.Length > 4
            || request.Anchors.Any(s => s.Length < 1 || s.Length > 64)
            || request.Context.Any(s => s.Length < 8 || s.Length > 64)
            || (request.Context.Length > 0 && request.ShortText == null)
            || request.Excluded.Length > 3
            || request.Excluded.Any(s => !Regex.IsMatch(s, @"^http://(127\.0\.0\.1|localhost)(:\d+)?/?$", RegexOptions.IgnoreCase))
            || (request.ShortText != null && (role != "user" || request.Anchors.Length != 0
                || request.ShortText.Length < 1 || request.ShortText.Length >= 8))) throw new ArgumentException();
        return request;
    }

    static string[] Strings(Dictionary<string, object> data, string key)
    {
        if (!data.ContainsKey(key) || data[key] == null) return new string[0];
        var values = data[key] as System.Collections.IEnumerable;
        if (values == null || data[key] is string) throw new ArgumentException();
        return values.Cast<object>().Select(value => (string)value).ToArray();
    }
}

class Rules
{
    public static string Normal(string text) { return Regex.Replace(text ?? "", @"\s+", " ").Trim().ToLowerInvariant(); }
    public static bool Named(string value, params string[] labels) { return labels.Any(s => Normal(s) == Normal(value)); }
    public static int RailPosition(string label)
    {
        string text = Normal(label);
        if (!text.Contains("user message") && !(text.Contains("用户") && text.Contains("消息"))
            && !(text.Contains("使用者") && text.Contains("訊息"))) return 0;
        var numbers = Regex.Matches(text, @"\d+");
        int position;
        return numbers.Count == 1 && int.TryParse(numbers[0].Value, out position) ? position : 0;
    }
    public static bool UniqueCount(string value)
    {
        return Regex.IsMatch(Normal(value), @"^(1\s*/\s*1\s+results?|1\s*个结果[，,]\s*共\s*1\s*个结果|1\s*/\s*1\s*個結果)$");
    }
}

class Program
{
    public static void Reply(string status, bool verified = false, Dictionary<string, object> diagnostics = null)
    {
        var value = new Dictionary<string, object> { {"status", status}, {"verified", verified}, {"method", "native_accessibility_find"} };
        if (diagnostics != null) value["diagnostics"] = diagnostics;
        Console.WriteLine(new JavaScriptSerializer().Serialize(value));
        Environment.Exit(new[] { "located", "turn_revealed", "search_requested", "context_revealed", "valid_request", "self_test_passed" }.Contains(status) ? 0 : 1);
    }

    [STAThread]
    static void Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length == 1 && args[0] == "--self-test")
        {
            if (Rules.RailPosition("跳转到用户消息 12") != 12 || Rules.RailPosition("user message 1 of 3") != 0
                || !Rules.UniqueCount("1 个结果，共 1 个结果") || Rules.UniqueCount("1 / 2 results")) Reply("invalid_request");
            Reply("self_test_passed");
        }
        if (args.Length != 1 || (args[0] != "--navigate" && args[0] != "--validate-request")) Reply("invalid_request");
        Request request;
        try { request = Request.Parse(Console.In.ReadToEnd()); }
        catch { Reply("invalid_request"); return; }
        if (args.Length == 1 && args[0] == "--validate-request") Reply("valid_request");
        if (args.Length != 1 || args[0] != "--navigate") Reply("invalid_request");
        // Load the Windows UI types only for actual user-triggered navigation.
        try { typeof(Program).Assembly.GetType("Navigator").GetMethod("Execute").Invoke(null, new object[] { request }); }
        catch { Reply("navigation_failed"); }
    }
}

class Scan
{
    public List<AutomationElement> Matches = new List<AutomationElement>();
    public bool Complete;
}

class Navigator
{
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    readonly Request request;
    readonly DateTime deadline = DateTime.UtcNow.AddSeconds(14);
    readonly TreeWalker walker = TreeWalker.ControlViewWalker;
    IntPtr handle;
    AutomationElement window;
    Dictionary<string, object> diagnostic = new Dictionary<string, object> {
        {"find_triggered", false}, {"chat_scope_found", false}, {"find_input_found", false}, {"query_written", false} };

    public Navigator(Request value) { request = value; }
    public static void Execute(Request request) { new Navigator(request).Run(); }
    void Focus()
    {
        if (GetForegroundWindow() != handle) Program.Reply("focus_changed");
        if (DateTime.UtcNow >= deadline) Program.Reply((bool)diagnostic["query_written"] ? "search_requested" : "find_unavailable", false, diagnostic);
    }
    bool Button(AutomationElement e) { return e.Current.ControlType == ControlType.Button || e.Current.ControlType == ControlType.CheckBox; }
    bool Scope(AutomationElement e) { return Button(e) && Rules.Named(e.Current.Name, "Search chat", "搜索聊天", "搜尋對話"); }
    bool Field(AutomationElement e)
    {
        return e.Current.ControlType == ControlType.Edit && e.Current.IsEnabled && !e.Current.IsOffscreen
            && (Rules.Named(e.Current.Name, "Find in chat", "在聊天中查找", "在對話中尋找")
                || Rules.Named(e.Current.HelpText, "Search chat…", "搜索聊天…", "搜尋對話…"));
    }
    string Address(AutomationElement e)
    {
        object pattern;
        if (!e.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) return "";
        string value = ((ValuePattern)pattern).Current.Value;
        return Regex.IsMatch(value ?? "", @"^(app|https?)://", RegexOptions.IgnoreCase) ? value : "";
    }
    bool AllowedDocument(AutomationElement e)
    {
        string address = Address(e);
        if (address == "") return true;
        if (request.Excluded.Any(s => address.StartsWith(s.TrimEnd('/') + "/", StringComparison.OrdinalIgnoreCase))) return false;
        var route = Regex.Match(address, @"/local/([0-9a-fA-F-]{36})(?:[/?#]|$)");
        if (route.Success && !string.Equals(route.Groups[1].Value, request.Thread, StringComparison.OrdinalIgnoreCase)) return false;
        Uri uri;
        return address.StartsWith("app://-/", StringComparison.OrdinalIgnoreCase)
            || (Uri.TryCreate(address, UriKind.Absolute, out uri) && new[] {"chatgpt.com", "chatgpt-staging.com"}.Contains(uri.Host));
    }
    Scan Walk(AutomationElement root, Func<AutomationElement, bool> match, double seconds, bool documentsOnly = false)
    {
        var result = new Scan();
        var queue = new Queue<AutomationElement>(); queue.Enqueue(root);
        DateTime stop = DateTime.UtcNow.AddSeconds(seconds); if (stop > deadline) stop = deadline;
        int visited = 0; bool failed = false;
        while (queue.Count > 0 && visited++ < 12000 && DateTime.UtcNow < stop)
        {
            var e = queue.Dequeue();
            try
            {
                bool document = e.Current.ControlType == ControlType.Document;
                if (document && !AllowedDocument(e)) continue;
                if (document && !Automation.Compare(e, root) && !documentsOnly) continue;
                if (match(e)) result.Matches.Add(e);
                if (document && documentsOnly) continue;
                for (var child = walker.GetFirstChild(e); child != null; child = walker.GetNextSibling(child)) queue.Enqueue(child);
            }
            catch (ElementNotAvailableException) { failed = true; }
        }
        result.Complete = queue.Count == 0 && !failed;
        return result;
    }
    bool Press(AutomationElement e)
    {
        Focus(); object pattern;
        if (e.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) { ((InvokePattern)pattern).Invoke(); return true; }
        return Activate(e);
    }
    bool Activate(AutomationElement e)
    {
        Focus(); if (!Scope(e) || !e.Current.IsKeyboardFocusable) return false;
        e.SetFocus();
        if (!Automation.Compare(AutomationElement.FocusedElement, e)) return false;
        Focus(); SendKeys.SendWait(" "); return true;
    }
    bool Visible(AutomationElement e)
    {
        Rect bounds = window.Current.BoundingRectangle, target = e.Current.BoundingRectangle;
        bounds.Inflate(0, -60);
        return !e.Current.IsOffscreen && target.Width > 0 && target.Height > 0
            && bounds.Contains(new Point(target.X + target.Width / 2, target.Y + target.Height / 2));
    }
    bool Reveal(AutomationElement e)
    {
        Focus(); if (Visible(e)) return true;
        object pattern;
        if (e.TryGetCurrentPattern(ScrollItemPattern.Pattern, out pattern))
        { ((ScrollItemPattern)pattern).ScrollIntoView(); Thread.Sleep(100); }
        Focus(); return Visible(e);
    }
    bool UniqueResult(AutomationElement input)
    {
        var group = input;
        for (int i = 0; i < 5; i++)
        {
            group = walker.GetParent(group);
            if (group == null || group.Current.ControlType == ControlType.Document) return false;
            var scan = Walk(group, e => (Button(e) && Rules.Named(e.Current.Name, "Next result", "Previous result", "下一个结果", "上一个结果", "下一個結果", "上一個結果"))
                || (e.Current.ControlType == ControlType.Text && Rules.UniqueCount(e.Current.Name)), .25);
            if (scan.Complete
                && scan.Matches.Count(e => Button(e) && Rules.Named(e.Current.Name, "Next result", "下一个结果", "下一個結果")) == 1
                && scan.Matches.Count(e => Button(e) && Rules.Named(e.Current.Name, "Previous result", "上一个结果", "上一個結果")) == 1)
                return scan.Matches.Count(e => e.Current.ControlType == ControlType.Text) == 1;
        }
        return false;
    }
    bool OriginalVisible(AutomationElement root, string query)
    {
        var scan = Walk(root, e => e.Current.ControlType == ControlType.Text
            && Rules.Normal(e.Current.Name).Contains(Rules.Normal(query)), .7);
        if (!scan.Complete || scan.Matches.Count != 1) return false;
        var context = scan.Matches[0];
        if (request.ShortText == null) return Reveal(context);
        var group = context;
        for (int i = 0; i < 8; i++)
        {
            group = walker.GetParent(group);
            if (group == null || group.Current.ControlType == ControlType.Document) return false;
            var shortScan = Walk(group, e => e.Current.ControlType == ControlType.Text && Rules.Normal(e.Current.Name) == Rules.Normal(request.ShortText), .25);
            if (!shortScan.Complete) continue;
            if (shortScan.Matches.Count > 1) return false;
            if (shortScan.Matches.Count == 1 && shortScan.Matches[0].Current.BoundingRectangle.Y < context.Current.BoundingRectangle.Y)
                return Reveal(shortScan.Matches[0]);
        }
        return false;
    }
    public void Run()
    {
        handle = GetForegroundWindow(); uint pid; GetWindowThreadProcessId(handle, out pid);
        var process = Process.GetProcessById((int)pid);
        if (!new[] {"codex", "chatgpt"}.Contains(process.ProcessName.ToLowerInvariant())) Program.Reply("focus_changed");
        window = AutomationElement.FromHandle(handle);
        var documents = Walk(window, e => e.Current.ControlType == ControlType.Document, 1, true);
        if (!documents.Complete || documents.Matches.Count == 0) Program.Reply("chat_unverified");
        var native = new List<AutomationElement>();
        var railTargets = new List<AutomationElement>();
        foreach (var doc in documents.Matches)
        {
            var rail = Walk(doc, e => Button(e) && Rules.RailPosition(e.Current.Name) != 0, 1);
            if (!rail.Complete) Program.Reply("chat_unverified");
            var target = rail.Matches.Where(e => Rules.RailPosition(e.Current.Name) == request.Position).ToList();
            if (rail.Matches.Count >= 4) railTargets.AddRange(target);
            native.Add(doc);
        }
        if (railTargets.Count > 1) Program.Reply("ambiguous_target");
        if (railTargets.Count == 1)
        { if (Press(railTargets[0])) Program.Reply("turn_revealed"); Program.Reply("navigation_failed"); }
        if (native.Count != 1) Program.Reply("chat_unverified");
        var root = native[0];
        string query = request.Anchors.FirstOrDefault() ?? request.Context.FirstOrDefault();
        if (query == null || query.Length < 8) Program.Reply("source_unsearchable");
        var scopes = Walk(root, Scope, .8);
        if (!scopes.Complete) Program.Reply("find_unavailable", false, diagnostic);
        if (scopes.Matches.Count == 0)
        { Focus(); SendKeys.SendWait("^f"); diagnostic["find_triggered"] = true; Thread.Sleep(200); scopes = Walk(root, Scope, 1); }
        if (!scopes.Complete || scopes.Matches.Count != 1) Program.Reply("find_unavailable", false, diagnostic);
        diagnostic["chat_scope_found"] = true;
        if (!Press(scopes.Matches[0])) Program.Reply("find_unavailable", false, diagnostic);
        AutomationElement input = null; bool rescued = false;
        DateTime fieldDeadline = DateTime.UtcNow.AddSeconds(3);
        while (DateTime.UtcNow < fieldDeadline && input == null)
        {
            Focus(); Thread.Sleep(100); var fields = Walk(root, Field, .6);
            if (fields.Complete && fields.Matches.Count == 1) input = fields.Matches[0];
            else if (!rescued && fields.Complete) { Activate(scopes.Matches[0]); rescued = true; }
        }
        if (input == null) Program.Reply("find_unavailable", false, diagnostic);
        diagnostic["find_input_found"] = true;
        object raw;
        if (!input.TryGetCurrentPattern(ValuePattern.Pattern, out raw)) Program.Reply("find_unavailable", false, diagnostic);
        var value = (ValuePattern)raw;
        if (value.Current.IsReadOnly) Program.Reply("find_unavailable", false, diagnostic);
        Focus(); value.SetValue(""); Thread.Sleep(200); Focus();
        if (!Field(input)) Program.Reply("find_unavailable", false, diagnostic);
        value.SetValue(query);
        if (value.Current.Value != query) Program.Reply("find_unavailable", false, diagnostic);
        diagnostic["query_written"] = true; diagnostic["contextual_search"] = request.ShortText != null;
        int unique = 0; DateTime revealDeadline = DateTime.UtcNow.AddSeconds(3);
        while (DateTime.UtcNow < revealDeadline)
        {
            Focus(); Thread.Sleep(200);
            unique = UniqueResult(input) ? unique + 1 : 0;
            if (unique >= 2 && OriginalVisible(root, query)) Program.Reply("located", true);
        }
        Program.Reply(request.ShortText != null && unique >= 2 ? "context_revealed" : "search_requested", false, diagnostic);
    }
}

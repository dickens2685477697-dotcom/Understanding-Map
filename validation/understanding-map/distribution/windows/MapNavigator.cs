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
    public static bool ChatFindLabel(string value)
    {
        string label = Regex.Replace(Normal(value), @"(?:\.{3}|…)\s*$", "").Trim();
        return Regex.IsMatch(label, @"^(?:find in chat|search chat|在聊天中查找|搜索聊天|在對話中尋找|搜尋對話)(?:\s*[,，:：]\s*.+)?$");
    }
    public static bool ChatComposerLabel(string value)
    {
        return Named(value, "Ask Codex", "Message Codex", "Work with Codex", "和 Codex 一起工作", "与 Codex 一起工作",
            "與 Codex 一起工作", "向 Codex 发送消息", "向 Codex 傳送訊息");
    }
    // 0 is an unreadable address, 1 is a native address, -1 is excluded, -2 is a different chat.
    public static int DocumentAddressKind(string address, string title, string thread, string[] excluded)
    {
        if (string.IsNullOrWhiteSpace(address))
            return Named(title, "Understanding Map", "理解地图", "理解地圖", "New tab", "新标签页", "新標籤頁") ? -1 : 0;
        Uri uri;
        if (!Uri.TryCreate(address, UriKind.Absolute, out uri)) return -1;
        if (excluded.Any(s => address.Equals(s.TrimEnd('/'), StringComparison.OrdinalIgnoreCase)
            || address.StartsWith(s.TrimEnd('/') + "/", StringComparison.OrdinalIgnoreCase))) return -1;
        bool native = (uri.Scheme == "app" && uri.Host == "-")
            || ((uri.Scheme == "http" || uri.Scheme == "https")
                && new[] {"chatgpt.com", "chatgpt-staging.com"}.Contains(uri.Host.ToLowerInvariant()));
        if (!native) return -1;
        string path = Uri.UnescapeDataString(uri.AbsolutePath);
        if (Regex.IsMatch(path, @"/(?:browser|in-app-browser|mcp(?:-apps?)?|webview|tools)(?:/|$)", RegexOptions.IgnoreCase)) return -1;
        var route = Regex.Match(path, @"/local/([0-9a-fA-F-]{36})(?:/|$)");
        if (route.Success && !string.Equals(route.Groups[1].Value, thread, StringComparison.OrdinalIgnoreCase)) return -2;
        return 1;
    }
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
            const string thread = "11111111-1111-1111-1111-111111111111";
            string[] excluded = {"http://127.0.0.1:18766"};
            if (Rules.RailPosition("跳转到用户消息 12") != 12 || Rules.RailPosition("user message 1 of 3") != 0
                || !Rules.UniqueCount("1 个结果，共 1 个结果") || Rules.UniqueCount("1 / 2 results")
                || !Rules.ChatFindLabel("Search chat...") || !Rules.ChatFindLabel("搜索聊天…")
                || !Rules.ChatFindLabel("Find in chat") || !Rules.ChatFindLabel("在聊天中查找...")
                || !Rules.ChatFindLabel("Find in chat, Search chat...") || Rules.ChatFindLabel("Ask Codex to find in chat")
                || Rules.ChatFindLabel("Search tabs...") || Rules.ChatComposerLabel("Search chat")
                || !Rules.ChatComposerLabel("和 Codex 一起工作")
                || Rules.DocumentAddressKind("app://-/local/" + thread, "Codex", thread, excluded) != 1
                || Rules.DocumentAddressKind("app://-/local/22222222-2222-2222-2222-222222222222", "Codex", thread, excluded) != -2
                || Rules.DocumentAddressKind("app://-/browser/new", "Codex", thread, excluded) != -1
                || Rules.DocumentAddressKind("app://-/mcp-app/resource", "Codex", thread, excluded) != -1
                || Rules.DocumentAddressKind("http://127.0.0.1:18766/map", "", thread, excluded) != -1
                || Rules.DocumentAddressKind("about:blank", "", thread, excluded) != -1
                || Rules.DocumentAddressKind("https://web-sandbox.oaiusercontent.com/map", "", thread, excluded) != -1
                || Rules.DocumentAddressKind("", "理解地图", thread, excluded) != -1
                || Rules.DocumentAddressKind("", "Codex", thread, excluded) != 0) Reply("invalid_request");
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
        catch { Reply("navigation_failed", false, new Dictionary<string, object> { {"diagnostic_version", 3}, {"navigation_error_code", 7}, {"find_stage", 0} }); }
    }
}

class Scan
{
    public List<AutomationElement> Matches = new List<AutomationElement>();
    public bool Complete;
    public int Visited, ReadErrors;
}

class Navigator
{
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, Input[] inputs, int size);
    [StructLayout(LayoutKind.Sequential)]
    struct KeyboardInput { public ushort VirtualKey, ScanCode; public uint Flags, Time; public UIntPtr ExtraInfo; }
    // The mouse member supplies INPUT's correct union size on both 32-bit and 64-bit Windows.
    [StructLayout(LayoutKind.Sequential)]
    struct MouseInput { public int X, Y; public uint Data, Flags, Time; public UIntPtr ExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    struct InputData
    {
        [FieldOffset(0)] public KeyboardInput Keyboard;
        [FieldOffset(0)] public MouseInput Mouse;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Input { public uint Type; public InputData Data; }
    readonly Request request;
    readonly DateTime deadline = DateTime.UtcNow.AddSeconds(14);
    readonly TreeWalker walker = TreeWalker.ControlViewWalker;
    readonly List<AutomationElement> verifiedDocuments = new List<AutomationElement>();
    IntPtr handle;
    AutomationElement window;
    Dictionary<string, object> diagnostic = new Dictionary<string, object> {
        {"diagnostic_version", 3}, {"find_stage", 0}, {"navigation_error_code", 0},
        {"native_pages", 0}, {"document_scan_complete", false}, {"ax_read_errors", 0},
        {"find_triggered", false}, {"chat_scope_found", false}, {"find_input_found", false}, {"query_written", false} };

    public Navigator(Request value) { request = value; }
    public static void Execute(Request request)
    {
        var navigator = new Navigator(request);
        try { navigator.Run(); }
        catch (Exception error)
        {
            int code = error is ElementNotAvailableException ? 1 : error is ElementNotEnabledException ? 2
                : error is COMException ? 3 : error is UnauthorizedAccessException ? 4 : error is InvalidOperationException ? 5 : 6;
            navigator.diagnostic["navigation_error_code"] = code;
            Program.Reply("navigation_failed", false, navigator.diagnostic);
        }
    }
    void Focus()
    {
        if (GetForegroundWindow() != handle) Program.Reply("focus_changed", false, diagnostic);
        if (DateTime.UtcNow >= deadline) Program.Reply((bool)diagnostic["query_written"] ? "search_requested" : "find_unavailable", false, diagnostic);
    }
    bool Button(AutomationElement e) { return e.Current.ControlType == ControlType.Button || e.Current.ControlType == ControlType.CheckBox; }
    bool Scope(AutomationElement e) { return Button(e) && Rules.Named(e.Current.Name, "Search chat", "搜索聊天", "搜尋對話"); }
    bool Field(AutomationElement e)
    {
        return e.Current.ControlType == ControlType.Edit && e.Current.IsEnabled && !e.Current.IsOffscreen
            && (Rules.ChatFindLabel(e.Current.Name) || Rules.ChatFindLabel(e.Current.HelpText));
    }
    bool Composer(AutomationElement e)
    {
        return e.Current.ControlType == ControlType.Edit && e.Current.IsEnabled && !e.Current.IsOffscreen
            && (Rules.ChatComposerLabel(e.Current.Name) || Rules.ChatComposerLabel(e.Current.HelpText)
                || Rules.Named(e.Current.AutomationId, "prompt-textarea", "composer-input", "chat-input"));
    }
    string Address(AutomationElement e)
    {
        object pattern;
        string value = e.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) ? ((ValuePattern)pattern).Current.Value : "";
        const string address = @"^(?:[a-z][a-z0-9+.-]*://|about:|blob:|data:|file:)";
        if (Regex.IsMatch(value ?? "", address, RegexOptions.IgnoreCase)) return value;
        value = e.Current.Name;
        return Regex.IsMatch(value ?? "", address, RegexOptions.IgnoreCase) ? value : "";
    }
    int DocumentKind(AutomationElement e)
    {
        int kind = Rules.DocumentAddressKind(Address(e), e.Current.Name, request.Thread, request.Excluded);
        return kind == 0 && verifiedDocuments.Any(doc => Automation.Compare(doc, e)) ? 1 : kind;
    }
    Scan Walk(AutomationElement root, Func<AutomationElement, bool> match, double seconds, bool documentsOnly = false)
    {
        var result = new Scan();
        var queue = new Queue<AutomationElement>(); queue.Enqueue(root);
        DateTime stop = DateTime.UtcNow.AddSeconds(seconds); if (stop > deadline) stop = deadline;
        while (queue.Count > 0 && result.Visited < 12000 && DateTime.UtcNow < stop)
        {
            var e = queue.Dequeue();
            result.Visited++;
            try
            {
                bool document = e.Current.ControlType == ControlType.Document;
                int kind = document ? DocumentKind(e) : 0;
                if (document && kind < 0)
                {
                    if (kind == -2 && !e.Current.IsOffscreen) Program.Reply("chat_mismatch", false, diagnostic);
                    continue;
                }
                if (document && !Automation.Compare(e, root) && !documentsOnly && kind != 1) continue;
                if (match(e)) result.Matches.Add(e);
                // Only known native documents may expose nested document trees.
                if (document && documentsOnly && kind != 1) continue;
                for (var child = walker.GetFirstChild(e); child != null; child = walker.GetNextSibling(child)) queue.Enqueue(child);
            }
            catch (ElementNotAvailableException) { result.ReadErrors++; }
            catch (InvalidOperationException) { result.ReadErrors++; }
            catch (COMException) { result.ReadErrors++; }
        }
        result.Complete = queue.Count == 0 && result.ReadErrors == 0;
        diagnostic["ax_read_errors"] = Math.Min(12000, (int)diagnostic["ax_read_errors"] + result.ReadErrors);
        return result;
    }
    bool WithinDocument(AutomationElement element, AutomationElement root)
    {
        // Raw parents retain embedded-document boundaries omitted by the control view.
        for (int i = 0; element != null && i < 80; i++)
        {
            if (Automation.Compare(element, root)) return true;
            if (element.Current.ControlType == ControlType.Document && DocumentKind(element) != 1) return false;
            element = TreeWalker.RawViewWalker.GetParent(element);
        }
        return false;
    }
    AutomationElement ChatRoot()
    {
        Focus();
        verifiedDocuments.Clear();
        var documents = Walk(window, e => e.Current.ControlType == ControlType.Document && !e.Current.IsOffscreen, 1.2, true);
        diagnostic["document_scan_complete"] = documents.Complete;
        if (!documents.Complete) Program.Reply("chat_unverified", false, diagnostic);
        var native = new List<AutomationElement>();
        foreach (var doc in documents.Matches)
        {
            if (DocumentKind(doc) == 1) { native.Add(doc); continue; }
            // A missing URL needs an explicit native-chat control inside this document.
            var markers = Walk(doc, e => Composer(e) || Field(e) || (Button(e) && Rules.RailPosition(e.Current.Name) != 0), .8);
            if (!markers.Complete) Program.Reply("chat_unverified", false, diagnostic);
            if (markers.Matches.Any(e => Composer(e) || Field(e))
                || markers.Matches.Count(e => Button(e) && Rules.RailPosition(e.Current.Name) != 0) >= 4)
            {
                verifiedDocuments.Add(doc);
                native.Add(doc);
            }
        }
        // A native nested document belongs to its already-verified outer chat.
        var roots = native.Where(doc => !native.Any(parent => !Automation.Compare(parent, doc) && WithinDocument(doc, parent))).ToList();
        diagnostic["native_pages"] = roots.Count;
        if (roots.Count > 1) Program.Reply("ambiguous_target", false, diagnostic);
        if (roots.Count == 0) Program.Reply("chat_unverified", false, diagnostic);
        return roots[0];
    }
    bool TryFocus(AutomationElement element, AutomationElement root)
    {
        Focus();
        if (!element.Current.IsEnabled || !element.Current.IsKeyboardFocusable || !WithinDocument(element, root)) return false;
        try { element.SetFocus(); }
        catch (InvalidOperationException) { return false; }
        catch (COMException) { return false; }
        Focus();
        var focused = AutomationElement.FocusedElement;
        return focused != null && WithinDocument(focused, root)
            && (Automation.Compare(element, root) || WithinDocument(focused, element));
    }
    bool FocusChat(AutomationElement root)
    {
        if (TryFocus(root, root)) return true;
        var targets = Walk(root, e => e.Current.IsEnabled && e.Current.IsKeyboardFocusable && !e.Current.IsOffscreen
            && (Composer(e) || (Button(e) && Rules.RailPosition(e.Current.Name) != 0)), .8);
        if (!targets.Complete) return false;
        var composers = targets.Matches.Where(Composer).ToList();
        if (composers.Count > 1) Program.Reply("ambiguous_target", false, diagnostic);
        var target = composers.Count == 1 ? composers[0] : targets.Matches.FirstOrDefault();
        return target != null && TryFocus(target, root);
    }
    AutomationElement FindInput(AutomationElement root)
    {
        var fields = Walk(root, e => e.Current.ControlType == ControlType.Edit && e.Current.IsEnabled && !e.Current.IsOffscreen, .8);
        diagnostic["find_fields"] = fields.Matches.Count;
        diagnostic["field_nodes"] = fields.Visited;
        diagnostic["field_scan_complete"] = fields.Complete;
        if (!fields.Complete) Program.Reply("find_unavailable", false, diagnostic);
        var chatFields = fields.Matches.Where(Field).ToList();
        diagnostic["chat_named_fields"] = chatFields.Count;
        if (chatFields.Count > 1) Program.Reply("ambiguous_target", false, diagnostic);
        diagnostic["find_input_found"] = chatFields.Count == 1;
        return chatFields.FirstOrDefault();
    }
    bool ReadField(AutomationElement input, out string text)
    {
        text = null;
        object pattern;
        if (input.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
        {
            text = ((ValuePattern)pattern).Current.Value;
            return true;
        }
        if (!input.TryGetCurrentPattern(TextPattern.Pattern, out pattern)) return false;
        text = ((TextPattern)pattern).DocumentRange.GetText(256).TrimEnd('\r', '\n');
        return true;
    }
    bool WriteQuery(ref AutomationElement root, ref AutomationElement input, string query)
    {
        diagnostic["find_stage"] = 7;
        if (!TryFocus(input, root)) { diagnostic["navigation_error_code"] = 8; return false; }
        object pattern;
        bool written = false;
        if (input.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
        {
            var value = (ValuePattern)pattern;
            if (value.Current.IsReadOnly) { diagnostic["navigation_error_code"] = 10; return false; }
            try
            {
                Focus(); value.SetValue(""); Thread.Sleep(100); Focus();
                value.SetValue(query);
                string text;
                written = ReadField(input, out text) && text == query;
            }
            catch (ElementNotAvailableException) { }
            catch (InvalidOperationException) { }
            catch (COMException) { }
        }
        if (!written)
        {
            // React may replace the edit, and some Windows edits expose only TextPattern.
            root = ChatRoot(); input = FindInput(root);
            string before;
            if (input == null || !ReadField(input, out before)) { diagnostic["navigation_error_code"] = 9; return false; }
            if (!TryFocus(input, root)) { diagnostic["navigation_error_code"] = 8; return false; }
            if (input.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) && ((ValuePattern)pattern).Current.IsReadOnly)
            { diagnostic["navigation_error_code"] = 10; return false; }
            Focus(); SendKeys.SendWait("^a{BACKSPACE}");
            if (!TryFocus(input, root)) { diagnostic["navigation_error_code"] = 8; return false; }
            var keys = new List<Input>();
            foreach (char character in query)
            {
                var key = new Input { Type = 1, Data = new InputData { Keyboard = new KeyboardInput { ScanCode = character, Flags = 4 } } };
                keys.Add(key);
                key.Data.Keyboard.Flags = 6;
                keys.Add(key);
            }
            Focus();
            if (SendInput((uint)keys.Count, keys.ToArray(), Marshal.SizeOf(typeof(Input))) != keys.Count)
            { diagnostic["navigation_error_code"] = 12; return false; }
            Thread.Sleep(150);
            root = ChatRoot(); input = FindInput(root);
        }
        diagnostic["find_stage"] = 8;
        string actual;
        if (input == null || !ReadField(input, out actual) || actual != query)
        { diagnostic["navigation_error_code"] = 11; return false; }
        diagnostic["navigation_error_code"] = 0;
        return true;
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
        if (!new[] {"codex", "chatgpt"}.Contains(process.ProcessName.ToLowerInvariant())) Program.Reply("focus_changed", false, diagnostic);
        window = AutomationElement.FromHandle(handle);
        diagnostic["find_stage"] = 1;
        var root = ChatRoot();
        var rail = Walk(root, e => Button(e) && Rules.RailPosition(e.Current.Name) != 0, 1);
        diagnostic["rail_buttons"] = rail.Matches.Count;
        diagnostic["rail_scan_complete"] = rail.Complete;
        if (!rail.Complete) Program.Reply("chat_unverified", false, diagnostic);
        var railTargets = rail.Matches.Where(e => Rules.RailPosition(e.Current.Name) == request.Position).ToList();
        diagnostic["target_buttons"] = railTargets.Count;
        if (railTargets.Count > 1) Program.Reply("ambiguous_target", false, diagnostic);
        if (rail.Matches.Count >= 4 && railTargets.Count == 1)
        {
            if (Press(railTargets[0])) Program.Reply("turn_revealed", false, diagnostic);
            Program.Reply("navigation_failed", false, diagnostic);
        }
        string query = request.Anchors.FirstOrDefault() ?? request.Context.FirstOrDefault();
        if (query == null || query.Length < 8) Program.Reply("source_unsearchable", false, diagnostic);
        diagnostic["find_stage"] = 2;
        var input = FindInput(root);
        if (input == null)
        {
            diagnostic["find_stage"] = 3;
            if (!FocusChat(root))
            {
                diagnostic["navigation_error_code"] = 8;
                Program.Reply("find_unavailable", false, diagnostic);
            }
            diagnostic["find_stage"] = 4;
            Focus(); SendKeys.SendWait("^f"); diagnostic["find_triggered"] = true;
        }
        bool scopePressed = false;
        DateTime fieldDeadline = DateTime.UtcNow.AddSeconds(4);
        while (DateTime.UtcNow < fieldDeadline && input == null)
        {
            Focus(); Thread.Sleep(100);
            root = ChatRoot();
            diagnostic["find_stage"] = 6;
            input = FindInput(root);
            if (input != null) break;
            var scopes = Walk(root, Scope, .6);
            if (!scopes.Complete) Program.Reply("find_unavailable", false, diagnostic);
            if (scopes.Matches.Count > 1) Program.Reply("ambiguous_target", false, diagnostic);
            diagnostic["chat_scope_found"] = scopes.Matches.Count == 1;
            if (scopes.Matches.Count == 1 && !scopePressed)
            {
                diagnostic["find_stage"] = 5;
                if (!Press(scopes.Matches[0])) Program.Reply("find_unavailable", false, diagnostic);
                diagnostic["chat_scope_pressed"] = true;
                scopePressed = true;
                // The next iteration reacquires both the document and its fields.
            }
        }
        if (input == null) Program.Reply("find_unavailable", false, diagnostic);
        if (!WriteQuery(ref root, ref input, query)) Program.Reply("navigation_failed", false, diagnostic);
        diagnostic["query_written"] = true; diagnostic["contextual_search"] = request.ShortText != null;
        diagnostic["find_stage"] = 9;
        int unique = 0; DateTime revealDeadline = DateTime.UtcNow.AddSeconds(3);
        while (DateTime.UtcNow < revealDeadline)
        {
            Focus(); Thread.Sleep(200);
            unique = UniqueResult(input) ? unique + 1 : 0;
            if (unique >= 2 && OriginalVisible(root, query)) Program.Reply("located", true, diagnostic);
        }
        Program.Reply(request.ShortText != null && unique >= 2 ? "context_revealed" : "search_requested", false, diagnostic);
    }
}

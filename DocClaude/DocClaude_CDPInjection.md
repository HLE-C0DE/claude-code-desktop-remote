# CDP Command Injection System - Comprehensive Documentation

## Table of Contents
1. [Part 1: Verbose Explanation of Functionality](#part-1-verbose-explanation-of-functionality)
   - [Chrome DevTools Protocol (CDP) Architecture](#chrome-devtools-protocol-cdp-architecture)
   - [Connection to Port 9222](#connection-to-port-9222)
   - [Multiple Injection Strategies](#multiple-injection-strategies)
   - [Process Detection Mechanisms](#process-detection-mechanisms)
   - [LevelDB Session Extraction](#leveldb-session-extraction)
   - [Command Execution Flow](#command-execution-flow)
   - [Retry and Error Handling](#retry-and-error-handling)
   - [PowerShell Script Utilities](#powershell-script-utilities)
2. [Part 2: Important Variables/Inputs/Outputs](#part-2-important-variablesinputsoutputs)

---

# PART 1: VERBOSE EXPLANATION OF FUNCTIONALITY

## Chrome DevTools Protocol (CDP) Architecture

### What is CDP?

The Chrome DevTools Protocol (CDP) is a remote debugging protocol that allows external applications to inspect, debug, and control Chromium-based applications. In this system, Claude Desktop (which is built on Electron, a Chromium-based framework) exposes a CDP debugging interface on port 9222.

### How CDP Works in This System

The CDP Controller (`cdp-controller.js`) acts as a bridge between the web UI/backend and Claude Desktop. It uses the CDP to:

1. **Execute JavaScript in Claude Desktop's context** - The controller can run arbitrary JavaScript code inside the Claude Desktop application's window, giving it access to Claude's internal APIs.

2. **Access Session Management APIs** - Claude Desktop exposes a global object `window['claude.web'].LocalSessions` that provides methods for:
   - Getting all sessions (`getAllSessions()`)
   - Switching between sessions (`switchSession()`)
   - Sending messages (`sendMessage()`)
   - Starting new sessions (`start()`)
   - Managing tool permissions and questions
   - Archiving sessions

3. **Maintain Persistent Connections** - The controller establishes a WebSocket connection to Claude Desktop's debugging interface and maintains it across multiple operations, avoiding the overhead of reconnecting for each request.

### CDP Connection Lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│  Step 1: HTTP Request to http://localhost:9222/json        │
│  Returns: Array of debug targets (pages/windows)           │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 2: Find target with URL containing 'claude.ai'       │
│  Extract: webSocketDebuggerUrl                             │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 3: Establish WebSocket connection                    │
│  Connection URL: ws://localhost:9222/devtools/page/...     │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 4: Send CDP commands as JSON messages                │
│  Format: { id, method, params }                            │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 5: Receive responses with matching id                │
│  Parse: result.result.value (for Runtime.evaluate)         │
└─────────────────────────────────────────────────────────────┘
```

## Connection to Port 9222

### Why Port 9222?

Port 9222 is the standard debugging port for Chromium-based applications. Claude Desktop must be launched with the `--remote-debugging-port=9222` flag to expose the CDP interface.

### Connection Process

1. **HTTP Discovery Request**
   ```javascript
   http.get('http://localhost:9222/json', (res) => {
     // Returns JSON array of debug targets
   })
   ```

   **Response Example:**
   ```json
   [
     {
       "id": "abc123",
       "title": "Claude Desktop",
       "type": "page",
       "url": "https://claude.ai/claude-code-desktop/local_c6db556b",
       "webSocketDebuggerUrl": "ws://localhost:9222/devtools/page/abc123"
     }
   ]
   ```

2. **Target Selection**
   - The system filters targets to find the one with URL containing `claude.ai`
   - This ensures we connect to the main Claude application page, not auxiliary windows

3. **WebSocket Connection**
   ```javascript
   const ws = new WebSocket(mainPage.webSocketDebuggerUrl);
   ```

4. **Persistent Connection Management**
   - Connection is cached in `this.wsConnection`
   - `ensureConnection()` method checks if connection is still open before reusing
   - Avoids reconnection overhead (10-30s reduction in operation time)
   - Handles connection failures with automatic cleanup

### Connection States

The CDP controller tracks connection state through several flags:

- `wsConnection`: The active WebSocket instance (null if disconnected)
- `isConnecting`: Boolean flag preventing multiple simultaneous connection attempts
- `reconnectAttempts`: Counter for retry logic
- `pendingRequests`: Map of in-flight requests awaiting responses

## Multiple Injection Strategies

The system supports **8 different injection strategies** to accommodate various environments and use cases. The strategies are chosen based on platform detection and availability.

### Strategy 1: Remote CDP (Primary Method)

**When Used:** Always in remote mode (this system's default)

**How It Works:**
- Connects to Claude Desktop via CDP on port 9222
- Executes JavaScript to call `LocalSessions.sendMessage()`
- No local process detection needed
- Completely remote-controlled

**Advantages:**
- Works across network boundaries
- No need for window focus or activation
- Most reliable and consistent
- Direct API access

**Code Path:**
```javascript
// In cdp-controller.js
async sendMessage(sessionId, message, attachments = []) {
    sessionId = this.validateSessionId(sessionId);

    await this.executeJS(`
        (async () => {
            await window['claude.web'].LocalSessions.sendMessage(
                ${JSON.stringify(sessionId)},
                ${JSON.stringify(message)},
                ${JSON.stringify(attachments)}
            );
        })()
    `);
}
```

### Strategy 2: Electron UI Automation (Windows)

**When Used:** When Claude Desktop App is detected on Windows

**How It Works:**
1. Finds Claude Desktop process (ProcessName = "Claude")
2. Activates the window using `AppActivate(pid)`
3. Uses Windows UI Automation API to find and focus input field
4. Copies message to clipboard
5. Simulates Ctrl+V and Enter

**Technical Details:**
- Uses PowerShell with `System.Windows.Automation` assembly
- Searches for ControlType = Edit or Document
- Sets focus using `SetFocus()` method
- Falls back to clipboard method if UI element not found

**Advantages:**
- Targets the correct input field reliably
- Works even with complex UI hierarchies
- Platform-native approach

**Limitations:**
- Windows-only
- Requires Claude Desktop to be running
- Slower than CDP method

### Strategy 3: Electron Clipboard (Windows)

**When Used:** Fallback for Electron UI Automation on Windows

**How It Works:**
1. Finds and activates Claude Desktop window
2. Copies message to clipboard using `Set-Clipboard`
3. Waits 300ms for window activation
4. Sends Ctrl+V keystroke
5. Waits 200ms then sends Enter

**Code Example:**
```powershell
$wshell = New-Object -ComObject wscript.shell;
Set-Clipboard -Value "message text";
$wshell.AppActivate(12345);  # PID
Start-Sleep -Milliseconds 300;
$wshell.SendKeys('^v');
Start-Sleep -Milliseconds 200;
$wshell.SendKeys('{ENTER}')
```

**Timing Considerations:**
- 300ms wait ensures window is fully activated
- 200ms wait allows clipboard paste to complete
- These delays are critical for reliability

### Strategy 4: Windows SendKeys (Terminal)

**When Used:** For Claude Code running in Windows Terminal, PowerShell, or cmd

**How It Works:**
1. Searches for window with "claude" in title
2. Falls back to Windows Terminal, PowerShell, or cmd
3. Activates the window
4. Escapes special characters for SendKeys
5. Sends keystrokes directly to active window

**Special Character Escaping:**
```javascript
const specialChars = {
    '+': '{+}',  // Shift modifier
    '^': '{^}',  // Ctrl modifier
    '%': '{%}',  // Alt modifier
    '~': '{~}',  // Enter key
    '(': '{(}',  // Parentheses
    ')': '{)}',
    '{': '{{}',  // Braces themselves
    '}': '{}}',
    '[': '{[}',  // Brackets
    ']': '{]}'
};
```

**Window Activation Priority:**
1. Window with "claude" in title (case-insensitive)
2. Windows Terminal (ProcessName = "WindowsTerminal")
3. PowerShell (ProcessName matches "powershell" or "pwsh")
4. cmd (ProcessName = "cmd")

### Strategy 5: tmux (Linux/Mac)

**When Used:** When Claude Code runs inside a tmux session

**How It Works:**
```bash
tmux send-keys -t session_name 'command text' Enter
```

**Security Considerations:**
- Uses `spawn()` with array arguments (not shell strings)
- Prevents shell injection attacks
- No shell interpretation of command text

**Process:**
1. Detect tmux sessions: `tmux list-sessions`
2. Parse session names from output
3. Send keys using spawn with explicit arguments
4. Timeout after 10 seconds

### Strategy 6: WSL tmux (Windows with WSL)

**When Used:** On Windows when WSL is available with tmux

**How It Works:**
```bash
wsl tmux send-keys -t "session_name" 'command' Enter
```

**Character Escaping:**
- Single quotes in command are escaped as `'\''`
- This prevents breaking out of the quoted string

### Strategy 7: screen (Linux/Mac)

**When Used:** When Claude Code runs inside a GNU screen session

**How It Works:**
```bash
screen -S "session_name" -X stuff 'command\n'
```

**Note:** The `stuff` command sends raw text including the newline character.

### Strategy 8: macOS AppleScript

**When Used:** On macOS for Terminal or iTerm

**How It Works:**
```applescript
tell application "Terminal"
    activate
    delay 0.2
    tell application "System Events"
        keystroke "command text"
        delay 0.1
        keystroke return
    end tell
end tell
```

**Timing:**
- 200ms delay after activation
- 100ms delay before Enter
- Ensures window is ready to receive input

### Strategy 9: Generic Clipboard (Cross-platform Fallback)

**When Used:** When all other methods fail

**How It Works:**
- **Windows:** `Set-Clipboard -Value 'text'` then Ctrl+V
- **macOS:** `echo "text" | pbcopy` then Cmd+V
- **Linux:** `echo "text" | xclip -selection clipboard` then Ctrl+V

**Limitations:**
- Requires active window to be the target
- No way to verify correct window is focused
- User must manually ensure correct window is active

## Process Detection Mechanisms

### Remote Mode vs Local Mode

**Current Configuration:** The system is configured for **remote mode only**.

In `process-detector.js`, the `findClaudeProcess()` method always returns:
```javascript
{
    pid: null,
    method: 'remote-cdp',
    terminal: { type: 'none', sessions: [] },
    windowTitle: null,
    processes: []
}
```

This indicates that all injection is performed remotely via CDP, with no local process detection.

### Windows Process Detection (When Enabled)

**Method 1: PowerShell Get-Process with WMI**

```powershell
Get-Process -Name node -ErrorAction SilentlyContinue |
ForEach-Object {
    $proc = $_
    $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.Id)").CommandLine
    if ($cmdLine -match 'claude') {
        [PSCustomObject]@{
            PID = $proc.Id
            Name = $proc.ProcessName
            CommandLine = $cmdLine
            WindowTitle = $proc.MainWindowTitle
        }
    }
} | ConvertTo-Json
```

**What This Does:**
1. Gets all Node.js processes
2. For each process, queries WMI for full command line
3. Filters for processes with "claude" in command line
4. Extracts PID, process name, command line, and window title
5. Returns as JSON

**Method 2: Claude Desktop App Detection**

Uses external script `find-claude-desktop.ps1`:
```powershell
$claudeProcs = Get-Process | Where-Object {
    $_.ProcessName -eq 'Claude' -or
    $_.ProcessName -eq 'claude' -or
    ($_.MainWindowTitle -match 'Claude' -and
     $_.MainWindowTitle -notmatch 'Visual Studio|Code|Terminal')
}
```

**Filtering Logic:**
- ProcessName exactly "Claude" (Electron app)
- OR ProcessName "claude" (lowercase variant)
- OR MainWindowTitle contains "Claude" but NOT "Visual Studio", "Code", or "Terminal"
- Must have a non-empty MainWindowTitle (visible window)

**Output Format:** `PID|ProcessName|WindowTitle`

Example: `12345|Claude|Claude Desktop`

### Unix/Linux Process Detection (When Enabled)

```bash
ps aux | grep -i "claude\|anthropic" | grep -v grep
```

**Parsing:**
- Splits output by whitespace
- Extracts user (field 0), PID (field 1), command line (fields 10+)
- Returns array of process objects

### Terminal Session Detection

**tmux Detection:**
```bash
tmux list-sessions 2>/dev/null
```

**Output Format:**
```
session-name: 1 windows (created Mon Jan 12 10:30:00 2026) (attached)
```

**Parsing Logic:**
- Extracts session name before the first colon
- Checks for "(attached)" to determine active sessions
- Stores raw line for debugging

**screen Detection:**
```bash
screen -ls 2>/dev/null
```

**Output Format:**
```
12345.session-name (Attached)
12345.session-name (Detached)
```

**Parsing Logic:**
- Extracts PID and session name: `\d+\.([^\s]+)`
- Checks for "(Attached)" status
- Returns PID, name, active status, and raw line

### Windows Terminal Detection

Uses PowerShell to enumerate all processes with visible windows:

```powershell
Get-Process | Where-Object { $_.MainWindowTitle -ne '' } |
Select-Object Id, ProcessName, MainWindowTitle
```

**Priority Order:**
1. **Claude Desktop App** - ProcessName = "Claude"
2. **Terminal with "claude" in title** - MainWindowTitle matches "claude" or "anthropic"
3. **Generic Terminal** - ProcessName in ["WindowsTerminal", "powershell", "pwsh", "cmd", "ConEmuC64", "ConEmuC"]

**Return Object:**
```javascript
{
    pid: 12345,
    title: "Windows PowerShell",
    processName: "powershell",
    type: "terminal-generic"
}
```

**Type Values:**
- `desktop-app`: Claude Desktop Electron application
- `terminal-claude`: Terminal window with Claude in title
- `terminal-generic`: Generic terminal emulator

## LevelDB Session Extraction

Claude Desktop stores session data in a LevelDB database located at:
```
%APPDATA%\Claude\Local Storage\leveldb
```

### LevelDB File Structure

**File Types:**
- `*.ldb` - Compacted data files (sorted string tables)
- `*.log` - Write-ahead log for uncommitted data
- `CURRENT` - Points to current MANIFEST file
- `MANIFEST-*` - Database metadata and file inventory

### Extraction Script: `extract-leveldb-data.ps1`

**Purpose:** Read LevelDB files to extract session information without locking issues.

**Technique:**
```powershell
$stream = [System.IO.File]::Open(
    $file.FullName,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::ReadWrite  # Critical: allows reading while Claude has file open
)
$reader = New-Object System.IO.BinaryReader($stream)
$bytes = $reader.ReadBytes([int]$stream.Length)
```

**Key Point:** `[System.IO.FileShare]::ReadWrite` allows reading the file even while Claude Desktop has it open for writing.

### Data Patterns Extracted

**1. LSS-cc Entries (Local Session State)**
```regex
LSS-cc-local_[a-f0-9-]+
```

Example: `LSS-cc-local_c6db556b-80f7-4cf9-a5e1-65ce516fd3d9`

These keys store the state of each local session.

**2. Router State with Paths**
```regex
"path":"(/[^"]*)"
```

Example: `"path":"/claude-code-desktop/local_c6db556b"`

Indicates which session was last active based on URL path.

**3. Local Session IDs**
```regex
local_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}
```

Full UUID format session identifiers.

**4. Short Session IDs**
```regex
local_[a-f0-9]{6,}
```

Abbreviated session IDs used in URLs.

### Session Storage Reading

**Script:** `read-session-storage.ps1`

**Location:** `%APPDATA%\Claude\Session Storage`

**What It Looks For:**

1. **session-pending-messages** - Messages awaiting user approval
2. **sessionId patterns** - Any JSON containing sessionId fields
3. **pending keywords** - Any reference to pending operations

**Extraction Technique:**
```powershell
$content = [System.Text.Encoding]::UTF8.GetString($bytes)
$matches = [regex]::Matches($content, '\{[^}]*sessionId[^}]*\}')
```

### Full Session Storage Script

**Script:** `read-full-session-storage.ps1`

**Advanced Technique:** Converts binary to ASCII-only, replacing non-printable bytes with spaces.

```powershell
$chars = @()
foreach ($b in $bytes) {
    if ($b -ge 32 -and $b -le 126) {
        $chars += [char]$b
    } else {
        $chars += ' '
    }
}
$content = -join $chars
```

**Why This Works:**
- LevelDB embeds binary data (length prefixes, checksums)
- JSON strings are UTF-8 and readable
- Converting non-printable bytes to spaces preserves JSON structure
- Regex can then extract JSON objects

**Pattern Matching:**
```regex
\{[^{}]*pendingMessages[^{}]*(?:\{[^{}]*\}[^{}]*)*\}
```

This finds JSON objects containing "pendingMessages" with nested objects.

### Session List Script

**Script:** `list-sessions.ps1`

**Location:** `%APPDATA%\Claude\claude-code-sessions`

**File Format:** Each session is a separate `.json` file.

**Structure:**
```json
{
    "sessionId": "local_c6db556b-80f7-4cf9-a5e1-65ce516fd3d9",
    "cliSessionId": "session_abc123",
    "title": "My Project",
    "cwd": "C:\\Users\\user\\Projects\\MyProject",
    "createdAt": "2026-01-15T10:30:00Z",
    "lastMessageAt": "2026-01-18T14:22:00Z"
}
```

**What The Script Does:**
- Recursively scans for `*.json` files
- Parses each JSON file
- Extracts sessionId, cliSessionId, title, cwd
- Sorts by LastWriteTime (most recent first)

## Command Execution Flow

### Full Request Path: Web UI → Backend → CDP → Claude Desktop

```
┌─────────────────────────────────────────────────────────────────┐
│  1. User clicks "Send" in Web UI (public/app.js)              │
│     - Calls: sendMessage(sessionId, message)                   │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. Web UI sends POST /api/sessions/:sessionId/messages        │
│     Body: { message: "user message text" }                     │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. Backend (server.js) receives request                       │
│     - Extracts sessionId and message from request              │
│     - Calls: cdpController.sendMessage(sessionId, message)     │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  4. CDP Controller (cdp-controller.js)                         │
│     - Validates sessionId format                               │
│     - Ensures WebSocket connection exists                      │
│     - Calls: executeJS() with LocalSessions.sendMessage()      │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  5. WebSocket sends CDP command                                │
│     Method: Runtime.evaluate                                   │
│     Expression: window['claude.web'].LocalSessions.sendMessage │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  6. Claude Desktop executes JavaScript                         │
│     - Validates session exists                                 │
│     - Appends message to session transcript                    │
│     - Sends to Claude API                                      │
│     - Returns Promise<void>                                    │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  7. CDP Controller receives response                           │
│     - Checks response.error                                    │
│     - Extracts result.result.value                             │
│     - Invalidates sessions cache                               │
│     - Returns { success: true, sessionId, message }            │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  8. Backend sends HTTP response                                │
│     Status: 200 OK                                             │
│     Body: { success: true, sessionId, message }                │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  9. Web UI receives response                                   │
│     - Clears input field                                       │
│     - Shows success notification                               │
│     - Polls for updated transcript                             │
└─────────────────────────────────────────────────────────────────┘
```

### Detailed Step-by-Step Execution

#### Step 1: Command Injection Request

**Entry Point:** `CommandInjector.injectCommand(sessionId, command)`

**Process:**
1. Emits `injection-started` event with timestamp
2. Calls `ProcessDetector.findClaudeProcess(sessionId)`
3. In remote mode, this returns `{ method: 'remote-cdp' }`
4. Determines injection method (always 'remote-cdp' in current config)
5. Calls `executeInjection(method, command, processInfo)`

#### Step 2: Execute Injection

**Method Selection Logic:**
```javascript
switch (method) {
    case 'tmux':
        return await this.strategies.injectViaTmux(session, command);
    case 'windows-sendkeys':
        return await this.strategies.injectViaWindowsSendKeys(command, title);
    case 'electron-uiautomation':
        return await this.strategies.injectViaElectronUIAutomation(command, info);
    case 'electron-clipboard':
        return await this.strategies.injectViaElectronClipboard(command, info);
    // ... more cases
    default:
        return await this.autoFallback(command, processInfo);
}
```

**In Remote Mode:** The method will be handled by the backend's CDP controller, not the injection strategies.

#### Step 3: CDP Message Construction

**JavaScript Code Generated:**
```javascript
(async () => {
    await window['claude.web'].LocalSessions.sendMessage(
        "local_c6db556b-80f7-4cf9-a5e1-65ce516fd3d9",
        "Please analyze this code",
        []  // attachments
    );
})()
```

**CDP Command:**
```json
{
    "id": 123,
    "method": "Runtime.evaluate",
    "params": {
        "expression": "(async () => { ... })())",
        "returnByValue": true,
        "awaitPromise": true
    }
}
```

**Key Parameters:**
- `returnByValue: true` - Return actual value, not object reference
- `awaitPromise: true` - Wait for async function to complete

#### Step 4: WebSocket Transmission

**Message Flow:**
```javascript
const message = { id, method, params };
ws.send(JSON.stringify(message));

// Response handling
ws.on('message', (data) => {
    const response = JSON.parse(data);
    if (response.id === id) {
        if (response.error) {
            reject(new Error(response.error.message));
        } else {
            resolve(response.result?.result?.value);
        }
    }
});
```

#### Step 5: Response Processing

**Success Response:**
```json
{
    "id": 123,
    "result": {
        "result": {
            "type": "undefined",
            "value": undefined
        }
    }
}
```

**sendMessage() returns void, so value is undefined.**

**Error Response:**
```json
{
    "id": 123,
    "error": {
        "code": -32000,
        "message": "Session not found"
    }
}
```

**Exception Response:**
```json
{
    "id": 123,
    "result": {
        "exceptionDetails": {
            "text": "TypeError: Cannot read property 'sendMessage' of undefined"
        }
    }
}
```

#### Step 6: Cache Invalidation

After successful message send:
```javascript
this.invalidateSessionsCache();
```

**Why:** The session's message count and lastMessageAt have changed, so cached session data is now stale.

**Cache Management:**
```javascript
this.cache = {
    sessions: null,
    sessionsTimestamp: 0,
    sessionsCacheDuration: 2000  // 2 seconds
};
```

**Cache Check:**
```javascript
if (!forceRefresh &&
    this.cache.sessions &&
    (now - this.cache.sessionsTimestamp) < this.cache.sessionsCacheDuration) {
    return this.cache.sessions;
}
```

## Retry and Error Handling

### Retry Mechanism

**Configuration:**
```javascript
this.config = {
    retryAttempts: 2,
    retryDelay: 1000,  // milliseconds
    // ...
};
```

**Retry Trigger:**
```javascript
if (!result.success && this.config.retryAttempts > 0) {
    result = await this.retryInjection(command, processInfo, method);
}
```

### Fallback Chain (Windows)

**Priority Order:**
1. `electron-uiautomation` - UI Automation API
2. `electron-clipboard` - Clipboard + paste
3. `windows-sendkeys` - SendKeys to terminal
4. `clipboard` - Generic clipboard paste

**Retry Logic:**
```javascript
const fallbackMethods = ['electron-uiautomation', 'electron-clipboard',
                         'windows-sendkeys', 'clipboard'];
const methodsToTry = fallbackMethods.filter(m => m !== failedMethod);

for (let attempt = 0; attempt < Math.min(retryAttempts, methodsToTry.length); attempt++) {
    const method = methodsToTry[attempt];
    await this.delay(this.config.retryDelay);

    const result = await this.executeInjection(method, command, processInfo);
    if (result.success) {
        return result;
    }
}
```

**Key Point:** Each retry attempts a different method, not the same method repeatedly.

### Error Types and Handling

**1. Connection Errors**
```javascript
// HTTP request to /json endpoint fails
reject(new Error('Cannot connect to Claude Desktop debug port: ' + e.message));

// Timeout
setTimeout(() => {
    req.destroy();
    reject(new Error('Connection timeout - is Claude Desktop running in debug mode?'));
}, 5000);
```

**2. WebSocket Errors**
```javascript
ws.on('error', (err) => {
    console.error('[CDP] WebSocket error:', err.message);
    this.isConnecting = false;
    reject(err);
});

ws.on('close', () => {
    console.log('[CDP] WebSocket connection closed');
    this.wsConnection = null;

    // Reject all pending requests
    for (const [id, { reject }] of this.pendingRequests) {
        reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();
});
```

**3. Execution Errors**
```javascript
if (response.error) {
    reject(new Error(response.error.message));
} else if (response.result && response.result.exceptionDetails) {
    reject(new Error(response.result.exceptionDetails.text || 'Execution error'));
}
```

**4. Timeout Handling**
```javascript
const timeout = setTimeout(() => {
    this.pendingRequests.delete(id);
    reject(new Error('Execution timeout'));
}, 30000);  // 30 second timeout

this.pendingRequests.set(id, {
    resolve: (value) => {
        clearTimeout(timeout);
        resolve(value);
    },
    reject: (err) => {
        clearTimeout(timeout);
        reject(err);
    }
});
```

### Statistics Tracking

**Stats Object:**
```javascript
this.stats = {
    totalInjections: 0,
    successfulInjections: 0,
    failedInjections: 0,
    methodStats: {
        'electron-uiautomation': { total: 5, success: 4, failed: 1 },
        'clipboard': { total: 2, success: 2, failed: 0 }
    }
};
```

**Update Logic:**
```javascript
updateStats(method, success) {
    this.stats.totalInjections++;

    if (success) {
        this.stats.successfulInjections++;
    } else {
        this.stats.failedInjections++;
    }

    if (!this.stats.methodStats[method]) {
        this.stats.methodStats[method] = { total: 0, success: 0, failed: 0 };
    }

    this.stats.methodStats[method].total++;
    if (success) {
        this.stats.methodStats[method].success++;
    } else {
        this.stats.methodStats[method].failed++;
    }
}
```

**Last Injection Tracking:**
```javascript
this.lastInjection = {
    sessionId: "local_c6db556b",
    command: "Please analyze...",
    result: { success: true, method: 'electron-clipboard' },
    timestamp: "2026-01-18T14:30:00Z",
    duration: 1250  // milliseconds
};
```

### Event Emission

**Events:**
- `injection-started` - When injection begins
- `injection-success` - When injection succeeds
- `injection-failed` - When injection fails
- `injection-error` - When an exception occurs
- `command-queued` - When command is added to queue
- `queue-cleared` - When queue is cleared

**Usage:**
```javascript
this.emit('injection-success', {
    sessionId,
    command,
    result,
    duration: Date.now() - startTime
});
```

**Listening:**
```javascript
injector.on('injection-success', (data) => {
    console.log(`Success: ${data.result.method} in ${data.duration}ms`);
});
```

## PowerShell Script Utilities

### Window Management Scripts

#### `activate-window.ps1`
**Purpose:** Activate a window by its process ID

**Input:**
- `-PID` (mandatory): Process ID of target window

**How It Works:**
```powershell
$wshell = New-Object -ComObject wscript.shell
$wshell.AppActivate($PID) | Out-Null
Start-Sleep -Milliseconds 100
$wshell.AppActivate($PID) | Out-Null  # Call twice for reliability
```

**Why Call AppActivate Twice:**
- Windows can be slow to respond to activation
- First call initiates activation
- Second call ensures window is brought to foreground

**Return:** Outputs "OK" on success

#### `find-claude-desktop.ps1`
**Purpose:** Locate the Claude Desktop application process

**Output Format:** `PID|ProcessName|WindowTitle`

**Example:** `12345|Claude|Claude Desktop`

**Filter Logic:**
```powershell
$claudeProcs = Get-Process | Where-Object {
    $_.ProcessName -eq 'Claude' -or
    $_.ProcessName -eq 'claude' -or
    ($_.MainWindowTitle -match 'Claude' -and
     $_.MainWindowTitle -notmatch 'Visual Studio|Code|Terminal')
}
```

**Exclusions:** Filters out Visual Studio Code, VS Code, and terminal windows that happen to have "Claude" in the title.

#### `find-claude-windows.ps1`
**Purpose:** Find ALL windows related to Claude (Desktop and Terminal)

**Output:** Multiple lines of `PID|ProcessName|WindowTitle`

**Example:**
```
12345|Claude|Claude Desktop
67890|powershell|PowerShell - claude-code
```

**Use Case:** Allows user to choose which Claude instance to target.

#### `inject-clipboard.ps1`
**Purpose:** Complete injection workflow using clipboard method

**Inputs:**
- `-PID` (mandatory): Target process ID
- `-Text` (mandatory): Message to inject

**Workflow:**
1. Copy text to clipboard: `Set-Clipboard -Value $Text`
2. Activate window: `$wshell.AppActivate($PID)`
3. Wait 300ms for activation
4. Paste: `$wshell.SendKeys('^v')`
5. Wait 200ms for paste
6. Send: `$wshell.SendKeys('{ENTER}')`

**Timing Rationale:**
- 300ms ensures window receives focus
- 200ms allows paste operation to complete before Enter
- These values are based on empirical testing

### Data Exploration Scripts

#### `find-claude-data.ps1`
**Purpose:** Discover all Claude data directories

**Searches:**
1. `%APPDATA%` (Roaming) - Cloud-synced data
2. `%LOCALAPPDATA%` (Local) - Machine-specific data
3. `%ProgramData%` - Shared data
4. `~\.claude` - User home directory
5. JSON files in Claude directories

**Output Example:**
```
=== Recherche dans AppData\Roaming ===
C:\Users\user\AppData\Roaming\Claude

=== Contenu de ~/.claude ===
C:\Users\user\.claude\config.json
C:\Users\user\.claude\sessions\local_c6db556b.json
```

#### `get-claude-protocol.ps1`
**Purpose:** Inspect Windows registry for `claude://` URL protocol handler

**Registry Keys Checked:**
- `HKCU:\Software\Classes\claude` - Protocol definition
- `HKCU:\Software\Classes\claude\shell\open\command` - Launch command
- `HKCU:\Software\Classes\claude\DefaultIcon` - Icon path

**Output Example:**
```
=== Claude URL Protocol ===
(default)    : URL:Claude Protocol
URL Protocol :

=== Shell Command ===
(default) : "C:\Users\user\AppData\Local\Programs\Claude\Claude.exe" "%1"
```

**Use Case:** Verify Claude Desktop is registered as URL protocol handler.

#### `find-pipes.ps1`
**Purpose:** Search for Named Pipes related to Claude or MCP

**Named Pipe Path:** `\\.\pipe\`

**Methods:**
1. .NET Directory API: `[System.IO.Directory]::GetFiles("\\.\pipe\")`
2. PowerShell Get-ChildItem: `Get-ChildItem "\\.\pipe\"`
3. Specific pipe test: `claude-mcp-browser-bridge-$username`

**Connection Test:**
```powershell
$pipe = New-Object System.IO.Pipes.NamedPipeClientStream(
    ".",
    "claude-mcp-browser-bridge-$username",
    [System.IO.Pipes.PipeDirection]::InOut
)
$pipe.Connect(1000)  # 1 second timeout
```

**Why Named Pipes:**
- MCP (Model Context Protocol) may use named pipes for IPC
- Browser extensions communicate with Claude Desktop via pipes
- Discovering pipes helps understand communication channels

#### `test-mcp-pipe.ps1`
**Purpose:** Send MCP commands to Claude Desktop via named pipe

**Inputs:**
- `-Tool` (default: "read_page"): MCP tool name
- `-ArgsJson` (default: "{}"): Tool arguments as JSON string

**Protocol:**
1. Connect to `claude-mcp-browser-bridge-$username` pipe
2. Construct MCP message:
   ```json
   {
       "method": "execute_tool",
       "params": {
           "client_id": "desktop",
           "tool": "read_page",
           "args": {}
       }
   }
   ```
3. Send length prefix (4 bytes, uint32) + message
4. Read response: length prefix + JSON response

**Wire Format:**
```
[4 bytes: message length (little-endian uint32)]
[N bytes: JSON message]
```

**Example Usage:**
```powershell
.\test-mcp-pipe.ps1 -Tool "read_page" -ArgsJson '{"url": "example.com"}'
```

### LevelDB Exploration Scripts

#### `extract-leveldb-data.ps1`
**Purpose:** Extract session data from LevelDB files

**Target Directory:** `%APPDATA%\Claude\Local Storage\leveldb`

**Process:**
1. Find all `*.ldb` files (compacted tables)
2. Sort by LastWriteTime (most recent first)
3. Open with read-only + share-read-write mode
4. Read entire file as binary
5. Convert to UTF-8 string
6. Extract patterns using regex

**Patterns Extracted:**
- `LSS-cc-local_[a-f0-9-]+` - Session state keys
- `"path":"(/[^"]*)"` - Router paths (current session)
- `local_[uuid]` - Full session IDs
- `local_[hex]` - Short session IDs

**File Sharing Mode:**
```powershell
$stream = [System.IO.File]::Open(
    $file.FullName,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::ReadWrite  # Allows reading while Claude has file open
)
```

**Critical:** Without `ReadWrite` sharing, the script would fail with "File is in use" error when Claude Desktop is running.

#### `read-session-storage.ps1`
**Purpose:** Read Session Storage for pending messages

**Target:** `%APPDATA%\Claude\Session Storage\*.ldb` and `*.log`

**What It Searches For:**
1. `session-pending-messages` - Draft messages
2. `\{[^}]*sessionId[^}]*\}` - JSON with sessionId
3. `pending` keyword context

**Example Output:**
```
=== Looking for session-pending-messages ===
Found session-pending-messages!
session-pending-messages{"local_c6db556b":{"text":"Hello"}}

=== Looking for sessionId patterns ===
{"sessionId":"local_c6db556b","status":"active"}
```

#### `read-full-session-storage.ps1`
**Purpose:** Deep extraction from Session Storage log files

**Technique:** ASCII-only conversion
```powershell
foreach ($b in $bytes) {
    if ($b -ge 32 -and $b -le 126) {
        $chars += [char]$b
    } else {
        $chars += ' '  # Replace non-printable with space
    }
}
```

**Why This Works:**
- LevelDB contains binary metadata (varint lengths, checksums, etc.)
- JSON text is always ASCII/UTF-8 printable
- Replacing binary with spaces preserves JSON structure
- Regex can extract `{...}` patterns from the cleaned text

**Advanced Pattern:**
```regex
\{[^{}]*pendingMessages[^{}]*(?:\{[^{}]*\}[^{}]*)*\}
```

This matches nested JSON objects containing "pendingMessages".

#### `list-sessions.ps1`
**Purpose:** List all saved session files

**Target:** `%APPDATA%\Claude\claude-code-sessions\**\*.json`

**Output:**
```
File: C:\...\local_c6db556b-80f7-4cf9-a5e1-65ce516fd3d9.json
Modified: 2026-01-18 14:30:00
SessionId: local_c6db556b-80f7-4cf9-a5e1-65ce516fd3d9
CliSessionId: session_abc123
Title: My Project
CWD: C:\Users\user\Projects\MyProject
```

**Sorting:** By `LastWriteTime` descending (most recent first)

### UI Automation Scripts

#### `explore-claude-ui.ps1`
**Purpose:** Explore Claude Desktop's UI element tree using Windows UI Automation

**Requirements:**
```powershell
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
```

**Process:**
1. Find Claude Desktop process
2. Get window handle: `$hwnd = $process.MainWindowHandle`
3. Create automation root: `AutomationElement::FromHandle($hwnd)`
4. Recursively explore UI tree

**Recursive Exploration:**
```powershell
function Explore-Element {
    param ($element, $depth = 0, $maxDepth = 4)

    $name = $element.Current.Name
    $controlType = $element.Current.ControlType.ProgrammaticName
    $automationId = $element.Current.AutomationId
    $className = $element.Current.ClassName

    # Display interesting elements
    if ($controlType -match 'Tab|Button|List|Tree|Menu|Custom' -or
        $name -match 'session|chat|conversation' -or
        $automationId -ne '') {
        Write-Output "[$controlType] Name='$name' AutomationId='$automationId'"
    }

    # Explore children
    $children = $element.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition
    )
    foreach ($child in $children) {
        Explore-Element -element $child -depth ($depth + 1)
    }
}
```

**Element Types Searched:**
- `TabItem` - Tab controls for session switching
- `ListItem` - Session list items
- `Button` - Action buttons (New Session, Send, etc.)
- `Custom` - Custom Electron/React components
- `Edit` or `Document` - Input fields

**Use Case:** Understanding UI structure to programmatically interact with Claude Desktop.

### CDP Helper Scripts

#### `cdp-execute.js`
**Purpose:** Standalone CDP JavaScript executor

**Usage:**
```bash
node cdp-execute.js "window.location.href"
node cdp-execute.js "Object.keys(window).filter(k => k.includes('claude'))"
```

**Process:**
1. HTTP GET to `http://localhost:9222/json`
2. Find target with `claude.ai` in URL
3. Connect WebSocket to `webSocketDebuggerUrl`
4. Send `Runtime.evaluate` command
5. Wait for response (timeout: 10 seconds)
6. Output result as JSON

**Example Output:**
```json
=== Result ===
{
  "type": "string",
  "value": "https://claude.ai/claude-code-desktop/local_c6db556b"
}
```

**Use Case:**
- Quick testing of CDP commands
- Exploring Claude Desktop's JavaScript API
- Debugging session state

---

# PART 2: IMPORTANT VARIABLES/INPUTS/OUTPUTS

## Core Classes and Functions

### CDPController Class

**Location:** `backend/command-injector/cdp-controller.js`

**Constructor:**
```javascript
constructor(port = 9222)
```

**Inputs:**
- `port` (number, default: 9222): CDP debugging port

**Instance Variables:**
- `this.port` (number): Debugging port
- `this.wsConnection` (WebSocket | null): Active WebSocket connection
- `this.messageId` (number): Auto-incrementing message ID counter
- `this.pendingRequests` (Map<number, {resolve, reject}>): In-flight requests
- `this.isConnecting` (boolean): Connection in progress flag
- `this.reconnectAttempts` (number): Reconnection attempt counter
- `this.maxReconnectAttempts` (number, default: 5): Max reconnection tries
- `this.reconnectDelay` (number, default: 1000): Delay between reconnections (ms)
- `this.lastTargetUrl` (string | null): Last WebSocket debugger URL
- `this.cache` (object): Sessions cache with timestamp

**Cache Structure:**
```javascript
{
    sessions: Array<Session> | null,
    sessionsTimestamp: number,  // Date.now()
    sessionsCacheDuration: 2000  // milliseconds
}
```

---

### Key CDP Methods

#### `getDebugTargets()`
**Purpose:** Get list of debug targets from CDP

**Inputs:** None

**Outputs:**
```javascript
Promise<Array<{
    id: string,
    title: string,
    type: string,
    url: string,
    webSocketDebuggerUrl: string
}>>
```

**Example:**
```javascript
[
  {
    "id": "9E9F5B2A-8C5D-4F3E-B2A1-6D5E4F3C2B1A",
    "title": "Claude Desktop",
    "type": "page",
    "url": "https://claude.ai/claude-code-desktop/local_c6db556b",
    "webSocketDebuggerUrl": "ws://localhost:9222/devtools/page/9E9F5B2A..."
  }
]
```

**Error Handling:**
- Throws: `"Cannot connect to Claude Desktop debug port: [error]"`
- Throws: `"Connection timeout - is Claude Desktop running in debug mode?"`

---

#### `isDebugModeAvailable()`
**Purpose:** Check if Claude Desktop is running with debug mode enabled

**Inputs:** None

**Outputs:** `Promise<boolean>`

**Logic:**
```javascript
try {
    const targets = await this.getDebugTargets();
    return targets.some(t => t.url.includes('claude.ai'));
} catch {
    return false;
}
```

---

#### `ensureConnection()`
**Purpose:** Establish or reuse persistent WebSocket connection

**Inputs:** None

**Outputs:** `Promise<WebSocket>`

**Connection States:**
1. **Already Connected:** Returns existing `this.wsConnection`
2. **Connecting:** Waits for in-progress connection (max 10s timeout)
3. **New Connection:** Creates new WebSocket connection

**Flow:**
```javascript
if (this.wsConnection && this.wsConnection.readyState === WebSocket.OPEN) {
    return this.wsConnection;  // Reuse existing
}

if (this.isConnecting) {
    // Wait for in-progress connection
    return new Promise((resolve, reject) => {
        const checkInterval = setInterval(() => {
            if (!this.isConnecting) {
                clearInterval(checkInterval);
                if (this.wsConnection?.readyState === WebSocket.OPEN) {
                    resolve(this.wsConnection);
                } else {
                    reject(new Error('Connection failed'));
                }
            }
        }, 100);
        setTimeout(() => {
            clearInterval(checkInterval);
            reject(new Error('Connection timeout'));
        }, 10000);
    });
}

// Create new connection
this.isConnecting = true;
const mainPage = await this.getMainPageTarget();
const ws = new WebSocket(mainPage.webSocketDebuggerUrl);
// ... setup event handlers
```

**Event Handlers:**
- `open`: Sets `this.wsConnection`, resets `this.isConnecting` and `this.reconnectAttempts`
- `message`: Parses response, resolves/rejects pending requests
- `close`: Clears `this.wsConnection`, rejects all pending requests
- `error`: Logs error, rejects connection promise

---

#### `executeJS(code, awaitPromise = true)`
**Purpose:** Execute JavaScript in Claude Desktop context

**Inputs:**
- `code` (string): JavaScript code to execute
- `awaitPromise` (boolean, default: true): Wait for async code

**Outputs:** `Promise<any>` - Value returned by the JavaScript code

**CDP Command:**
```javascript
{
    id: 123,
    method: 'Runtime.evaluate',
    params: {
        expression: code,
        returnByValue: true,
        awaitPromise: awaitPromise
    }
}
```

**Response Parsing:**
```javascript
if (response.error) {
    reject(new Error(response.error.message));
} else if (response.result?.exceptionDetails) {
    reject(new Error(response.result.exceptionDetails.text || 'Execution error'));
} else {
    resolve(response.result?.result?.value);
}
```

**Timeout:** 30 seconds

---

#### `getAllSessions(forceRefresh = false, includeHidden = false)`
**Purpose:** Get all Claude Code sessions

**Inputs:**
- `forceRefresh` (boolean, default: false): Bypass cache
- `includeHidden` (boolean, default: false): Include orchestrator worker sessions

**Outputs:**
```javascript
Promise<Array<{
    sessionId: string,
    title: string,
    cwd: string,
    createdAt: string,
    lastMessageAt: string,
    messageCount: number,
    pendingQuestions: Array,
    pendingToolPermissions: Array
}>>
```

**Cache Logic:**
```javascript
const now = Date.now();
if (!forceRefresh &&
    this.cache.sessions &&
    (now - this.cache.sessionsTimestamp) < this.cache.sessionsCacheDuration) {
    let sessions = this.cache.sessions;
    if (!includeHidden) {
        sessions = sessions.filter(s => !s.sessionId?.includes('__orch_'));
    }
    return sessions;
}
```

**JavaScript Executed:**
```javascript
(async () => {
    const sessions = await window['claude.web'].LocalSessions.getAll();
    const enrichedSessions = sessions.map(session => {
        return {
            ...session,
            messageCount: 0,  // Optimization: don't load transcript
            pendingQuestions: []
        };
    });
    return enrichedSessions;
})()
```

**Filtering:**
- Hidden sessions: `sessionId.includes('__orch_')` are filtered unless `includeHidden=true`
- These are internal orchestrator worker sessions

---

#### `validateSessionId(sessionId)`
**Purpose:** Ensure sessionId has correct format

**Inputs:**
- `sessionId` (string): Session ID to validate

**Outputs:** `string` - Validated and normalized session ID

**Logic:**
```javascript
if (!sessionId.startsWith('local_')) {
    sessionId = 'local_' + sessionId;
}

// Validation regex: local_ followed by UUID or short hex (6+ chars)
if (!/^local_[a-f0-9]{6,}(-[a-f0-9]{4,})*$/.test(sessionId)) {
    throw new Error(`Invalid session ID format: ${sessionId}`);
}

return sessionId;
```

**Valid Formats:**
- `local_c6db556b` (short hex)
- `local_c6db556b-80f7-4cf9-a5e1-65ce516fd3d9` (full UUID)

**Invalid Formats:**
- `c6db55` (too short)
- `local_xyz` (non-hex characters)
- `LOCAL_c6db556b` (wrong case for prefix)

---

#### `sendMessage(sessionId, message, attachments = [])`
**Purpose:** Send message to a specific session

**Inputs:**
- `sessionId` (string): Target session ID
- `message` (string): Message text
- `attachments` (Array, default: []): File attachments

**Outputs:**
```javascript
Promise<{
    success: boolean,
    sessionId: string,
    message: string
}>
```

**JavaScript Executed:**
```javascript
(async () => {
    await window['claude.web'].LocalSessions.sendMessage(
        "local_c6db556b-80f7-4cf9-a5e1-65ce516fd3d9",
        "Please analyze this code",
        []
    );
})()
```

**Side Effects:**
- Invalidates sessions cache
- Appends message to session transcript
- Triggers Claude API request

---

#### `startNewSessionWithMessage(cwd, message, options = {})`
**Purpose:** Create new session with initial message

**Inputs:**
- `cwd` (string): Working directory path
- `message` (string): Initial message
- `options` (object): Additional options

**Options Structure:**
```javascript
{
    title?: string,  // Custom title (otherwise auto-generated)
    useWorktree?: boolean,  // Use git worktree (default: false)
    // ... other options
}
```

**Outputs:**
```javascript
Promise<{
    sessionId: string,
    title: string,
    cwd: string,
    createdAt: string,
    // ... session properties
}>
```

**JavaScript Executed:**
```javascript
(async () => {
    return await window['claude.web'].LocalSessions.start({
        cwd: "C:\\Users\\user\\Projects\\MyProject",
        message: "Analyze this project",
        useWorktree: false,
        title: "My Custom Title"
    });
})()
```

**Behavior:**
- If `options.title` provided: Uses custom title immediately
- Otherwise: Claude generates title from first message (takes 2-5 seconds)
- `useWorktree: false`: Works directly in specified directory (no git worktree created)

---

#### `getPendingPermissions()`
**Purpose:** Get all pending tool permission requests

**Inputs:** None

**Outputs:**
```javascript
Promise<Array<{
    sessionId: string,
    requestId: string,
    toolName: string,
    input: object,
    suggestions: Array
}>>
```

**Filtering:**
- **Excludes:** `AskUserQuestion` (handled separately by `getPendingQuestions()`)
- Only returns actual tool permissions (Bash, Read, Write, etc.)

**Example:**
```javascript
[
  {
    "sessionId": "local_c6db556b",
    "requestId": "req_abc123",
    "toolName": "Bash",
    "input": {
      "command": "rm -rf /",
      "description": "Delete all files"
    },
    "suggestions": ["Deny", "Allow Once", "Allow Always"]
  }
]
```

---

#### `getPendingQuestions()`
**Purpose:** Get all pending AskUserQuestion requests

**Inputs:** None

**Outputs:**
```javascript
Promise<Array<{
    sessionId: string,
    questionId: string,
    questions: Array<{
        text: string,
        options: Array<string>
    }>,
    metadata: object
}>>
```

**Dual Detection:**
1. **Primary:** Checks `session.pendingQuestions` array
2. **Fallback:** Looks for `AskUserQuestion` in `session.pendingToolPermissions`

**Why Fallback?**
Claude Desktop sometimes represents questions as tool permissions internally.

**Example:**
```javascript
[
  {
    "sessionId": "local_c6db556b",
    "questionId": "q_abc123",
    "questions": [
      {
        "text": "Which approach do you prefer?",
        "options": ["Option A", "Option B", "Option C"]
      }
    ],
    "metadata": {}
  }
]
```

---

#### `respondToQuestion(questionId, answers)`
**Purpose:** Answer a pending question

**Inputs:**
- `questionId` (string): Question ID
- `answers` (object): Answer selections

**Answers Format:**
```javascript
{
    "0": 1,  // Question 0, selected option 1
    "1": 0   // Question 1, selected option 0
}
```

**Outputs:**
```javascript
Promise<{
    success: boolean,
    questionId: string,
    method: string  // 'respondToQuestion' or 'respondToPermission'
}>
```

**Dual Method Approach:**
1. **Try:** `LocalSessions.respondToQuestion(questionId, answers)`
2. **Fallback:** `LocalSessions.respondToPermission(questionId, 'once', answers)`

**Why Dual?**
Claude Desktop's internal representation of questions varies. Some are native questions, others are permissions.

---

#### `respondToPermission(requestId, decision, updatedInput = null)`
**Purpose:** Respond to tool permission request

**Inputs:**
- `requestId` (string): Permission request ID
- `decision` (string): `'once'`, `'always'`, or `'deny'`
- `updatedInput` (object | null): Modified tool input

**Outputs:**
```javascript
Promise<{
    success: boolean,
    requestId: string,
    decision: string
}>
```

**JavaScript Executed:**
```javascript
(async () => {
    await window['claude.web'].LocalSessions.respondToToolPermission(
        "req_abc123",
        "once",
        { command: "ls -la" }  // updated input
    );
})()
```

**Decision Values:**
- `'once'`: Allow this one time
- `'always'`: Remember and auto-allow in future
- `'deny'`: Reject this request

---

### CommandInjector Class

**Location:** `backend/command-injector/index.js`

**Constructor:**
```javascript
constructor(options = {})
```

**Options:**
```javascript
{
    preferredMethod?: string,     // 'auto', 'tmux', 'windows-sendkeys', etc.
    tmuxSession?: string,          // Specific tmux session name
    windowTitle?: string,          // Specific window title
    retryAttempts?: number,        // Default: 2
    retryDelay?: number,           // Default: 1000 (ms)
}
```

**Instance Variables:**
- `this.detector` (ProcessDetector): Process detection instance
- `this.strategies` (InjectionStrategies): Injection methods
- `this.config` (object): Configuration from options
- `this.commandQueue` (Map<string, Array>): Queued commands per session
- `this.lastInjection` (object | null): Last injection details
- `this.stats` (object): Injection statistics

---

#### `injectCommand(sessionId, command)`
**Purpose:** Main injection entry point

**Inputs:**
- `sessionId` (string): Target session ID
- `command` (string): Command/message text

**Outputs:**
```javascript
Promise<{
    success: boolean,
    method: string,
    error?: string,
    windowTitle?: string,
    pid?: number
}>
```

**Flow:**
1. Emit `injection-started` event
2. Detect process: `await this.detector.findClaudeProcess(sessionId)`
3. Determine method (in remote mode: always 'remote-cdp')
4. Execute injection: `await this.executeInjection(method, command, processInfo)`
5. Retry if failed and `retryAttempts > 0`
6. Update stats
7. Emit success/failure event
8. Return result

**Timing:**
```javascript
const startTime = Date.now();
// ... injection logic
this.lastInjection = {
    sessionId, command, result,
    timestamp: new Date().toISOString(),
    duration: Date.now() - startTime
};
```

---

#### `executeInjection(method, command, processInfo)`
**Purpose:** Execute specific injection method

**Inputs:**
- `method` (string): Injection method name
- `command` (string): Command text
- `processInfo` (object): Process detection results

**Method Routing:**
```javascript
switch (method) {
    case 'tmux':
        return await this.strategies.injectViaTmux(session, command);

    case 'wsl-tmux':
        return await this.strategies.injectViaWSLTmux(session, command);

    case 'screen':
        return await this.strategies.injectViaScreen(session, command);

    case 'windows-sendkeys':
        return await this.strategies.injectViaWindowsSendKeys(command, windowTitle);

    case 'electron-uiautomation':
        return await this.strategies.injectViaElectronUIAutomation(command, processInfo);

    case 'electron-clipboard':
        return await this.strategies.injectViaElectronClipboard(command, processInfo);

    case 'macos-applescript':
        return await this.strategies.injectViaMacOSAppleScript(command, appName);

    case 'clipboard':
        return await this.strategies.injectViaClipboard(command);

    default:
        return await this.autoFallback(command, processInfo);
}
```

---

#### `autoFallback(command, processInfo)`
**Purpose:** Automatic platform-specific fallback chain

**Windows Priority:**
1. Claude Desktop (Electron) via UI Automation
2. If UI Automation fails: Electron Clipboard
3. If no Claude Desktop: Terminal SendKeys
4. If SendKeys fails: Generic Clipboard

**macOS Priority:**
1. AppleScript
2. Clipboard

**Linux Priority:**
1. tmux (if session detected)
2. screen (if session detected)
3. Clipboard

**Code:**
```javascript
async autoFallback(command, processInfo) {
    const platform = process.platform;

    if (platform === 'win32') {
        const claudeDesktop = await this.strategies.findClaudeDesktopWindow();

        if (claudeDesktop) {
            let result = await this.strategies.injectViaElectronUIAutomation(command);
            if (result.success) return result;

            result = await this.strategies.injectViaElectronClipboard(command, claudeDesktop);
            if (result.success) return result;
        }

        let result = await this.strategies.injectViaWindowsSendKeys(command, processInfo?.windowTitle);
        if (!result.success) {
            result = await this.strategies.injectViaClipboard(command);
        }
        return result;
    }

    // ... similar for darwin and linux
}
```

---

#### `retryInjection(command, processInfo, failedMethod)`
**Purpose:** Retry with different methods

**Inputs:**
- `command` (string): Command to inject
- `processInfo` (object): Process info
- `failedMethod` (string): Method that just failed

**Fallback Order:**
- **Windows:** `['electron-uiautomation', 'electron-clipboard', 'windows-sendkeys', 'clipboard']`
- **macOS:** `['macos-applescript', 'tmux', 'clipboard']`
- **Linux:** `['tmux', 'screen', 'clipboard']`

**Logic:**
```javascript
const methodsToTry = fallbackMethods.filter(m => m !== failedMethod);

for (let attempt = 0; attempt < Math.min(this.config.retryAttempts, methodsToTry.length); attempt++) {
    const method = methodsToTry[attempt];
    console.log(`[CommandInjector] Retry ${attempt + 1}/${this.config.retryAttempts} avec ${method}`);

    await this.delay(this.config.retryDelay);

    const result = await this.executeInjection(method, command, processInfo);
    if (result.success) {
        return result;
    }
}

return { success: false, method: 'retry-exhausted', error: 'All methods failed' };
```

---

#### `getStatus(sessionId = null)`
**Purpose:** Get comprehensive injection system status

**Inputs:**
- `sessionId` (string | null): Optional session to check

**Outputs:**
```javascript
Promise<{
    available: boolean,
    detectedMethod: string,
    processInfo: object,
    systemInfo: object,
    methodsStatus: object,
    config: object,
    stats: object,
    lastInjection: object,
    recommendation: string
}>
```

**Example:**
```javascript
{
    "available": true,
    "detectedMethod": "remote-cdp",
    "processInfo": { method: 'remote-cdp', pid: null },
    "systemInfo": {
        "platform": "win32",
        "claudeDir": "C:\\Users\\user\\.claude",
        "supportedMethods": ["remote-cdp"]
    },
    "methodsStatus": {
        "remote-cdp": { available: true }
    },
    "config": {
        "preferredMethod": "auto",
        "retryAttempts": 2
    },
    "stats": {
        "totalInjections": 15,
        "successfulInjections": 14,
        "failedInjections": 1
    },
    "lastInjection": { /* ... */ },
    "recommendation": "Mode distant uniquement - Connexion CDP port 9222"
}
```

---

### InjectionStrategies Class

**Location:** `backend/command-injector/injection-strategies.js`

**Instance Variables:**
- `this.platform` (string): `process.platform` ('win32', 'darwin', 'linux')
- `this.lastTargetedWindow` (object | null): Last targeted window info
- `this.claudeDesktopInfo` (object | null): Cached Claude Desktop info
- `this.scriptsDir` (string): Path to PowerShell scripts directory

---

#### `injectViaTmux(sessionName, command)`
**Purpose:** Inject command via tmux

**Inputs:**
- `sessionName` (string): tmux session name
- `command` (string): Command text

**Outputs:**
```javascript
Promise<{
    success: boolean,
    method: 'tmux',
    session?: string,
    error?: string
}>
```

**Implementation:**
```javascript
await new Promise((resolve, reject) => {
    const proc = spawn('tmux', ['send-keys', '-t', sessionName, command, 'Enter'], {
        timeout: 10000,
        shell: false  // Critical: prevents shell injection
    });

    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data; });
    proc.on('error', reject);
    proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr || `tmux exited with code ${code}`));
    });
});
```

**Security Note:** Using `spawn()` with array arguments prevents shell injection attacks.

---

#### `injectViaWindowsSendKeys(command, windowTitle = null)`
**Purpose:** Inject via Windows SendKeys API

**Inputs:**
- `command` (string): Command text
- `windowTitle` (string | null): Target window title

**Outputs:**
```javascript
Promise<{
    success: boolean,
    method: 'windows-sendkeys',
    windowTitle?: string,
    error?: string
}>
```

**Process:**
1. Escape special characters: `escapeForSendKeys(command)`
2. Find and activate window: `findAndActivateClaudeWindow(windowTitle)`
3. Wait 300ms for window activation
4. Send keys using PowerShell

**PowerShell Command:**
```powershell
$wshell = New-Object -ComObject wscript.shell;
$wshell.SendKeys('escaped command');
Start-Sleep -Milliseconds 100;
$wshell.SendKeys('{ENTER}')
```

**Character Escaping:**
```javascript
escapeForSendKeys(text) {
    const specialChars = {
        '+': '{+}', '^': '{^}', '%': '{%}', '~': '{~}',
        '(': '{(}', ')': '{)}', '{': '{{}', '}': '{}}',
        '[': '{[}', ']': '{]}'
    };

    let escaped = '';
    for (const char of text) {
        escaped += specialChars[char] || char;
    }

    // Escape apostrophes for PowerShell
    return escaped.replace(/'/g, "''");
}
```

---

#### `injectViaElectronUIAutomation(command, windowInfo = null)`
**Purpose:** Inject using Windows UI Automation API for Electron

**Inputs:**
- `command` (string): Message text
- `windowInfo` (object | null): Window info (optional)

**Outputs:**
```javascript
Promise<{
    success: boolean,
    method: 'electron-uiautomation',
    windowTitle?: string,
    pid?: number,
    error?: string
}>
```

**Process:**
1. Find Claude Desktop: `findClaudeDesktopWindow()`
2. Activate window: `activateWindowByPid(pid)`
3. Wait 400ms for activation
4. Focus input field: `focusElectronInputField(pid)`
5. Copy to clipboard: `copyToClipboard(command)`
6. Paste: SendKeys `'^v'`
7. Send: SendKeys `'{ENTER}'`

**Fallback:** If UI Automation fails, falls back to `injectViaElectronClipboard()`

---

#### `focusElectronInputField(pid)`
**Purpose:** Focus input field using UI Automation

**Inputs:**
- `pid` (number): Process ID

**Outputs:**
```javascript
Promise<{
    success: boolean,
    result: string  // 'FOCUSED_EDIT', 'FOCUSED_DOCUMENT', 'NO_INPUT_FOUND'
}>
```

**PowerShell Logic:**
```powershell
Add-Type -AssemblyName UIAutomationClient;
Add-Type -AssemblyName UIAutomationTypes;

$process = Get-Process -Id $pid;
$hwnd = $process.MainWindowHandle;
$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd);

# Search for Edit control
$editCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Edit
);

$editElement = $root.FindFirst(
    [System.Windows.Automation.TreeScope]::Descendants,
    $editCondition
);

if ($editElement) {
    $editElement.SetFocus();
    Write-Output 'FOCUSED_EDIT';
} else {
    # Try Document control
    # ...
}
```

**Control Types Searched:**
1. `Edit` - Standard edit box
2. `Document` - Rich text editor (often used by Electron)

---

#### `injectViaElectronClipboard(command, windowInfo = null)`
**Purpose:** Inject via clipboard for Electron apps

**Inputs:**
- `command` (string): Message text
- `windowInfo` (object | null): Window info

**Outputs:**
```javascript
Promise<{
    success: boolean,
    method: 'electron-clipboard',
    windowTitle?: string,
    pid?: number,
    error?: string
}>
```

**Combined PowerShell Script:**
```powershell
$wshell = New-Object -ComObject wscript.shell;
Set-Clipboard -Value "message text";
Start-Sleep -Milliseconds 100;
$wshell.AppActivate(12345);  # PID
Start-Sleep -Milliseconds 300;
$wshell.SendKeys('^v');
Start-Sleep -Milliseconds 200;
$wshell.SendKeys('{ENTER}')
```

**Base64 Encoding:**
The script is Base64-encoded (UTF-16LE) and passed via `-EncodedCommand` to prevent PowerShell injection.

---

#### `findClaudeDesktopWindow()`
**Purpose:** Locate Claude Desktop application window

**Inputs:** None

**Outputs:**
```javascript
Promise<{
    pid: number,
    processName: string,
    title: string
} | null>
```

**Uses External Script:** `find-claude-desktop.ps1`

**Output Format:** `PID|ProcessName|WindowTitle`

**Parsing:**
```javascript
const parts = stdout.trim().split('|');
if (parts.length >= 3) {
    return {
        pid: parseInt(parts[0]),
        processName: parts[1],
        title: parts[2]
    };
}
```

---

#### `testMethod(method)`
**Purpose:** Test if an injection method is available

**Inputs:**
- `method` (string): Method name

**Outputs:**
```javascript
Promise<{
    available: boolean,
    version?: string,
    claudeDesktopFound?: boolean,
    windowInfo?: object
}>
```

**Tests:**
- `'tmux'`: Runs `tmux -V`, extracts version
- `'screen'`: Runs `screen -v`
- `'windows-sendkeys'`: Checks `platform === 'win32'`
- `'electron-uiautomation'`: Checks platform + finds Claude Desktop
- `'electron-clipboard'`: Checks platform + finds Claude Desktop
- `'macos-applescript'`: Checks `platform === 'darwin'`
- `'clipboard'`: Always available

---

### ProcessDetector Class

**Location:** `backend/command-injector/process-detector.js`

**Instance Variables:**
- `this.platform` (string): Current platform
- `this.claudeDir` (string): Claude config directory

**Configuration:**
```javascript
this.claudeDir = process.env.CLAUDE_DIR ||
                 path.join(process.env.USERPROFILE || process.env.HOME, '.claude');
```

---

#### `findClaudeProcess(sessionId = null)`
**Purpose:** Find Claude Code process (remote mode only)

**Inputs:**
- `sessionId` (string | null): Session ID (unused in remote mode)

**Outputs:**
```javascript
Promise<{
    pid: null,
    method: 'remote-cdp',
    terminal: { type: 'none', sessions: [] },
    windowTitle: null,
    processes: []
}>
```

**Note:** In remote mode, this always returns the same structure indicating remote CDP is the only method.

---

#### `getSupportedMethods()`
**Purpose:** Get list of supported injection methods

**Inputs:** None

**Outputs:** `Array<string>`

**Remote Mode:** `['remote-cdp']`

**Local Mode (if enabled):**
- Windows: `['electron-uiautomation', 'electron-clipboard', 'windows-sendkeys', 'clipboard']`
- macOS: `['macos-applescript', 'tmux', 'clipboard']`
- Linux: `['tmux', 'screen', 'clipboard', 'fifo']`

---

## CDP Protocol Commands Used

### Runtime.evaluate

**Purpose:** Execute JavaScript in page context

**Request:**
```json
{
    "id": 1,
    "method": "Runtime.evaluate",
    "params": {
        "expression": "window.location.href",
        "returnByValue": true,
        "awaitPromise": false
    }
}
```

**Response:**
```json
{
    "id": 1,
    "result": {
        "result": {
            "type": "string",
            "value": "https://claude.ai/claude-code-desktop/local_c6db556b"
        }
    }
}
```

**Parameters:**
- `expression` (string): JavaScript code
- `returnByValue` (boolean): Return value directly (not object reference)
- `awaitPromise` (boolean): Wait for Promise resolution

---

### HTTP Endpoint: /json

**Purpose:** List debug targets

**Request:**
```http
GET http://localhost:9222/json HTTP/1.1
```

**Response:**
```json
[
    {
        "description": "",
        "devtoolsFrontendUrl": "/devtools/inspector.html?ws=localhost:9222/devtools/page/ABC123",
        "id": "ABC123",
        "title": "Claude Desktop",
        "type": "page",
        "url": "https://claude.ai/claude-code-desktop/local_c6db556b",
        "webSocketDebuggerUrl": "ws://localhost:9222/devtools/page/ABC123",
        "faviconUrl": "https://claude.ai/favicon.ico"
    }
]
```

---

## Configuration Options

### CDPController Options

**Port:**
- Default: `9222`
- Environment variable: `CDP_PORT` (not implemented, but could be)
- Usage: `new CDPController(9222)`

**Timeouts:**
- Connection timeout: `10000ms` (10 seconds)
- Execution timeout: `30000ms` (30 seconds)
- HTTP request timeout: `5000ms` (5 seconds)

**Cache:**
- Sessions cache duration: `2000ms` (2 seconds)
- Invalidated on: session switch, message send, archive

---

### CommandInjector Options

**Configuration Object:**
```javascript
{
    preferredMethod: 'auto',      // or specific method name
    tmuxSession: null,             // or 'session-name'
    windowTitle: null,             // or 'Window Title'
    retryAttempts: 2,              // number of retries
    retryDelay: 1000,              // milliseconds between retries
    screenSession: null,           // GNU screen session name
    terminalApp: 'Terminal'        // macOS terminal app name
}
```

**Method Names:**
- `'auto'`: Automatic platform detection
- `'tmux'`: tmux terminal multiplexer
- `'wsl-tmux'`: tmux via WSL
- `'screen'`: GNU screen
- `'windows-sendkeys'`: Windows SendKeys API
- `'electron-uiautomation'`: Windows UI Automation
- `'electron-clipboard'`: Clipboard + paste (Electron)
- `'macos-applescript'`: AppleScript automation
- `'clipboard'`: Generic clipboard
- `'remote-cdp'`: Remote CDP (current default)

---

## Error Codes and Return Codes

### CDP Errors

**Connection Errors:**
- `"Cannot connect to Claude Desktop debug port: [error]"` - Port 9222 not accessible
- `"Connection timeout - is Claude Desktop running in debug mode?"` - No response from port 9222
- `"Failed to parse debug targets"` - Invalid JSON from `/json` endpoint

**Target Errors:**
- `"Claude main page not found"` - No target with `claude.ai` URL
- `"Connection failed"` - WebSocket connection attempt failed
- `"Connection timeout"` - WebSocket took >10s to connect

**Execution Errors:**
- `"Execution timeout"` - JavaScript didn't complete in 30s
- `"Execution error"` - JavaScript threw exception
- CDP error message from `response.error.message`
- Exception text from `response.result.exceptionDetails.text`

**Session Errors:**
- `"Invalid session ID format: [sessionId]"` - sessionId validation failed
- `"Session not found"` - Session doesn't exist in Claude Desktop

---

### Injection Errors

**Method-Specific Errors:**
- `"Cette méthode est uniquement disponible sur Windows"` - Method not available on platform
- `"Claude Desktop App non trouvée"` - Electron app not running
- `"Aucune session Claude détectée"` - No Claude process found
- `"FIFO non supporté sur Windows"` - FIFO pipes not on Windows
- `"Toutes les méthodes d'injection ont échoué"` - All retry attempts failed

**tmux Errors:**
- `"tmux exited with code [N]"` - tmux command failed
- stderr output from tmux

**PowerShell Errors:**
- `"PowerShell exited with code [N]"` - Script failed
- stderr from PowerShell process

---

## Platform-Specific Code Paths

### Windows (win32)

**Preferred Methods:**
1. Electron UI Automation (if Claude Desktop detected)
2. Electron Clipboard (if Claude Desktop detected)
3. Windows SendKeys (for terminal)
4. Generic Clipboard

**Process Detection:**
- PowerShell `Get-Process` + WMI for command line
- `find-claude-desktop.ps1` for Electron app
- Window enumeration for title matching

**Window Activation:**
- COM object: `wscript.shell`
- Method: `AppActivate(pid)`

**Keystroke Simulation:**
- SendKeys API via PowerShell
- Special character escaping required

---

### macOS (darwin)

**Preferred Methods:**
1. AppleScript automation
2. tmux (if available)
3. Generic Clipboard

**Process Detection:**
- `ps aux | grep claude`

**Window Activation:**
- AppleScript: `tell application "Terminal" to activate`

**Keystroke Simulation:**
- AppleScript: `tell application "System Events" to keystroke`

---

### Linux

**Preferred Methods:**
1. tmux (if session detected)
2. screen (if session detected)
3. Generic Clipboard (requires xclip)

**Process Detection:**
- `ps aux | grep claude`
- `tmux list-sessions`
- `screen -ls`

**Terminal Detection:**
- Check for tmux sessions
- Check for screen sessions
- No window activation (terminal-only)

---

## Important Notes and TODOs

### TODO Comments Found

**In cdp-controller.js:**
- None found

**In injection-strategies.js:**
- None found

**In process-detector.js:**
- None found

**In index.js:**
- None found

### Performance Optimizations

**1. Persistent WebSocket Connection**
- Avoids reconnecting for each operation
- Reduces latency from ~10-30s to <100ms
- Connection reused across multiple API calls

**2. Session Cache**
- 2-second cache for `getAllSessions()`
- Reduces `getAll()` call frequency (expensive operation)
- Invalidated on state changes (send message, archive, etc.)

**3. Lazy Transcript Loading**
- `getAllSessions()` no longer loads full transcripts
- Sets `messageCount: 0` as placeholder
- Transcript loaded only when session is opened
- Reduces initial load time from 10-30s to 1-2s

**4. Base64-Encoded PowerShell**
- Uses `-EncodedCommand` for script execution
- Prevents complex escaping issues
- More secure (no shell interpretation)

---

### Security Considerations

**1. Shell Injection Prevention**
- tmux: Uses `spawn()` with array arguments (no shell)
- CDP: Uses `JSON.stringify()` for parameter escaping
- PowerShell: Uses Base64 encoding for complex scripts

**2. File Sharing Mode**
- LevelDB reading: `[System.IO.FileShare]::ReadWrite`
- Allows reading while Claude has file open
- Read-only access prevents corruption

**3. Input Validation**
- Session ID validation regex
- Prevents injection via malformed session IDs

**4. Timeout Protection**
- All async operations have timeouts
- Prevents hanging on failed operations
- Cleans up resources on timeout

---

### Key Performance Metrics

**Connection Times:**
- Initial CDP connection: ~1-2 seconds
- Reusing connection: <100ms
- HTTP /json request: ~100-500ms

**Injection Times:**
- CDP method: ~200-500ms
- Electron UI Automation: ~1-2 seconds
- Electron Clipboard: ~800ms-1.5s
- Windows SendKeys: ~500ms-1s
- tmux: <100ms

**Cache Benefits:**
- Uncached `getAllSessions()`: 1-2s (optimized, was 10-30s)
- Cached `getAllSessions()`: <50ms
- Cache invalidation overhead: <10ms

---

## Summary

This CDP Command Injection System provides a robust, multi-strategy approach to remotely controlling Claude Desktop via the Chrome DevTools Protocol. The system:

1. **Connects to Claude Desktop** via WebSocket on port 9222
2. **Executes JavaScript** in Claude's context to access internal APIs
3. **Manages sessions** (create, switch, send messages, get status)
4. **Handles permissions and questions** via polling and response mechanisms
5. **Provides fallback strategies** for various platforms and scenarios
6. **Implements caching and optimization** for performance
7. **Includes extensive PowerShell utilities** for Windows automation

The architecture is designed for reliability with retry logic, timeout protection, and graceful degradation across multiple injection methods.

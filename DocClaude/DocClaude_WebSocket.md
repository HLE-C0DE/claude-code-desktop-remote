# WebSocket Communication System Documentation

## Table of Contents
1. [Part 1: Verbose Explanation of Functionality](#part-1-verbose-explanation-of-functionality)
   - [WebSocket Server Architecture](#websocket-server-architecture)
   - [Connection Lifecycle](#connection-lifecycle)
   - [Heartbeat/Ping-Pong Mechanism](#heartbeatping-pong-mechanism)
   - [Event-Driven Architecture](#event-driven-architecture)
   - [Broadcasting to Multiple Clients](#broadcasting-to-multiple-clients)
   - [Client Reconnection Logic with Exponential Backoff](#client-reconnection-logic-with-exponential-backoff)
   - [Message Queuing During Disconnection](#message-queuing-during-disconnection)
   - [State Synchronization Across Multiple Clients](#state-synchronization-across-multiple-clients)
   - [Error Handling and Connection Cleanup](#error-handling-and-connection-cleanup)
   - [Integration with Authentication System](#integration-with-authentication-system)
   - [How WebSocket Complements Polling](#how-websocket-complements-polling)
2. [Part 2: Important Variables/Inputs/Outputs](#part-2-important-variablesinputsoutputs)
   - [Complete Event Catalog](#complete-event-catalog)
   - [Event Payload Structures](#event-payload-structures)
   - [WebSocket Server Configuration](#websocket-server-configuration)
   - [Client Connection State Management](#client-connection-state-management)
   - [Broadcasting Functions and Logic](#broadcasting-functions-and-logic)
   - [Heartbeat Timeout Values](#heartbeat-timeout-values)
   - [Reconnection Backoff Algorithm](#reconnection-backoff-algorithm)
   - [Error Types and Handling](#error-types-and-handling)

---

# PART 1: VERBOSE EXPLANATION OF FUNCTIONALITY

## WebSocket Server Architecture

### Overview
The WebSocket server is built using the `ws` library (WebSocket implementation for Node.js) and is tightly integrated with the Express HTTP server. The architecture follows a **single WebSocket server instance serving multiple concurrent client connections**, with each connection authenticated individually when PIN authentication is enabled.

### Server Initialization
The WebSocket server is created in `backend/server.js` at line 3956:

```javascript
const wss = new WebSocket.Server({ server });
```

This creates a WebSocket server that **piggybacks on the existing HTTP server** (the `server` variable), allowing both HTTP REST API requests and WebSocket connections to coexist on the same port. This design eliminates the need for separate ports and simplifies client connection logic.

**Key architectural decisions:**
1. **Shared Server Instance**: The WebSocket server shares the same HTTP/HTTPS server instance, meaning clients connect to the same port (default: 3000) for both REST API calls and WebSocket connections.
2. **Stateless Design**: Each WebSocket connection is independent and does not share state with other connections except through the broadcasting mechanism.
3. **Event-Driven Integration**: The WebSocket server acts as a **real-time event broadcaster** for backend modules (sessionManager, usageTracker, pinManager, commandInjector, cdpMonitor, orchestratorModule) that emit events when state changes occur.

### Connection Management
The server maintains all active connections in `wss.clients`, which is a **Set** of WebSocket client objects. Each client object has custom properties attached:
- `ws.isAlive`: Boolean flag indicating if the connection is responsive (used by heartbeat)
- No explicit session mapping: Client identification relies on IP address extraction and token validation

### Server Responsibilities
The WebSocket server has three primary responsibilities:

1. **Connection Acceptance and Authentication**: Validate incoming connections against session tokens when PIN is enabled
2. **Event Broadcasting**: Forward backend events to all connected clients in real-time
3. **Connection Health Monitoring**: Detect and terminate dead connections using heartbeat mechanism

---

## Connection Lifecycle

The WebSocket connection lifecycle involves several distinct phases: **handshake → authentication → initialization → active communication → heartbeat monitoring → disconnection/cleanup**.

### Phase 1: Handshake and Initial Connection

When a client initiates a WebSocket connection (frontend `connectWebSocket()` at line 135 in `public/app.js`), the following sequence occurs:

```
CLIENT                          SERVER
  |                               |
  |------ HTTP Upgrade Req ------>|  (ws://host?token=xxx)
  |                               |
  |                         [Validate Token]
  |                               |
  |<----- 101 Switching Protocols-|  (Success)
  |          OR                   |
  |<----- 4001 Unauthorized ------|  (Failure - invalid token)
  |                               |
```

**Server-side handshake (lines 4350-4366 in server.js):**

```javascript
wss.on('connection', (ws, req) => {
  // Extract token from query parameters
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  const ip = pinManager.getClientIP(req);

  // Verify session token if PIN is enabled
  if (pinManager.isPinEnabled()) {
    if (!token || !pinManager.isSessionValid(token, ip)) {
      console.log(`[WebSocket] Rejected connection from ${ip} - invalid or missing token`);
      ws.close(4001, 'Unauthorized - Invalid or missing session token');
      return;  // CRITICAL: Connection terminated immediately
    }
    console.log(`[WebSocket] Authenticated connection from ${ip}`);
  } else {
    console.log(`[WebSocket] Connection from ${ip} (no auth required)`);
  }

  // Mark connection as alive
  ws.isAlive = true;

  // Continue with event handlers...
});
```

**Key points:**
- Token is passed via URL query parameter (`?token=xxx`) to avoid HTTP header issues during WebSocket upgrade
- If authentication fails, the connection is **immediately closed with code 4001** (custom code for unauthorized)
- The client receives the close event and will **not** attempt reconnection until reauthentication occurs

**Client-side connection initiation (lines 135-221 in app.js):**

```javascript
function connectWebSocket() {
  // SECURITY: Block WebSocket connection if PIN required but not authenticated
  if (pinRequired && !isAuthenticated) {
    console.log('[WebSocket] Connexion bloquée - authentification PIN requise');
    return;  // CRITICAL: Prevent connection without auth
  }

  // Clean up old connection properly
  if (ws) {
    ws.onclose = null;  // Remove handlers to prevent callbacks
    ws.onerror = null;
    ws.onmessage = null;
    ws.onopen = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }

  // Clean up old heartbeat
  if (wsHeartbeatInterval) {
    clearInterval(wsHeartbeatInterval);
    wsHeartbeatInterval = null;
  }

  // Build URL with session token
  const wsUrlWithAuth = sessionToken
    ? `${WS_URL}?token=${encodeURIComponent(sessionToken)}`
    : WS_URL;

  ws = new WebSocket(wsUrlWithAuth);

  // Attach event handlers (onopen, onmessage, onerror, onclose)
  // ...
}
```

**Critical security measure:** The client enforces a **pre-connection authentication check** (`pinRequired && !isAuthenticated`) to prevent WebSocket connection attempts before the user has successfully authenticated via PIN. This is a **defense-in-depth** approach - even if the client bypasses this check, the server will reject unauthenticated connections.

### Phase 2: Connection Established (onopen Event)

**Client-side (lines 165-175 in app.js):**

```javascript
ws.onopen = () => {
  console.log('WebSocket connecté');
  updateStatus(true);  // Update UI to show "Connected"
  wsReconnectAttempts = 0;  // Reset reconnection counter

  // Start heartbeat
  startHeartbeat();

  // Reload all data after reconnection
  reloadAllData();
};
```

When the connection opens successfully:
1. **UI is updated** to reflect connected state (green indicator)
2. **Reconnection counter is reset** to 0 (for exponential backoff)
3. **Heartbeat is started** (client sends ping every 30 seconds)
4. **Data is reloaded** from the server (sessions, permissions, etc.) to ensure client state is fresh

**Server-side (lines 4402-4416 in server.js):**

The server immediately sends two initialization messages to the newly connected client:

```javascript
// Send welcome message
ws.send(JSON.stringify({
  type: 'connected',
  message: 'Connecte au serveur ClaudeCode_Remote',
  pinEnabled: pinManager.isPinEnabled(),
  timestamp: new Date().toISOString()
}));

// Send current usage data
ws.send(JSON.stringify({
  type: 'usage-updated',
  usage: usageTracker.getCurrentUsage(),
  timestamp: new Date().toISOString()
}));
```

**Why send these messages immediately?**
- `connected`: Confirms to the client that the connection is fully established and provides server configuration (PIN enabled/disabled)
- `usage-updated`: Provides initial state for the usage widget without requiring an additional REST API call

### Phase 3: Active Communication

Once the connection is established, bidirectional communication occurs:

**Client → Server:**
- `ping`: Heartbeat ping from client
- `pong`: Response to server's ping

**Server → Client:**
- `ping`: Heartbeat ping from server
- `pong`: Response to client's ping
- **40+ event types** (see Event Catalog section) broadcasted from backend modules

The connection remains in this active phase until either:
1. The client explicitly closes the connection (page unload, logout)
2. The server shuts down
3. Network failure occurs
4. Heartbeat timeout is detected

### Phase 4: Disconnection and Cleanup

**Graceful Client-Initiated Closure:**

When the user logs out or closes the browser, the client calls:

```javascript
ws.close();
```

This triggers the server's `ws.on('close')` handler (line 4393):

```javascript
ws.on('close', () => {
  console.log('Client WebSocket déconnecté');
});
```

**Graceful Server-Initiated Closure (Shutdown):**

When the server shuts down (lines 4455-4463):

```javascript
wss.clients.forEach((ws) => {
  try {
    ws.send(JSON.stringify({ type: 'shutdown', message: 'Le serveur s\'arrête' }));
    ws.close();
  } catch (e) {
    // Ignore errors
  }
});
```

The server:
1. Sends a `shutdown` message to all clients
2. Closes each connection gracefully
3. Allows clients to detect the shutdown and display appropriate UI

**Network Failure or Heartbeat Timeout:**

If the heartbeat mechanism detects a dead connection (no pong received within 30 seconds), the server terminates the connection:

```javascript
if (ws.isAlive === false) {
  console.log('Terminaison connexion WebSocket inactive');
  return ws.terminate();  // Forceful termination
}
```

**Client-side reconnection (lines 203-220 in app.js):**

```javascript
ws.onclose = () => {
  console.log('WebSocket déconnecté');
  updateStatus(false);  // Update UI to "Disconnected"

  // Stop heartbeat
  if (wsHeartbeatInterval) {
    clearInterval(wsHeartbeatInterval);
    wsHeartbeatInterval = null;
  }

  // Reconnection with exponential backoff
  wsReconnectAttempts++;
  const delay = Math.min(WS_RECONNECT_DELAY_BASE * Math.pow(1.5, wsReconnectAttempts), 30000);
  console.log(`Reconnexion dans ${delay}ms (tentative ${wsReconnectAttempts})`);

  showReconnectingStatus();
  setTimeout(connectWebSocket, delay);
};
```

---

## Heartbeat/Ping-Pong Mechanism

The heartbeat mechanism is critical for **detecting dead connections** (e.g., client lost network, browser crashed, mobile device went to sleep). WebSocket connections can appear "open" even when the underlying TCP connection is broken due to network issues.

### Server-Side Heartbeat (lines 4419-4435 in server.js)

The server implements an **active heartbeat checker** that runs every 30 seconds:

```javascript
const WS_HEARTBEAT_INTERVAL = 30000; // 30 seconds

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('Terminaison connexion WebSocket inactive');
      return ws.terminate();  // Forcefully close dead connection
    }

    ws.isAlive = false;  // Mark as "potentially dead" until pong received

    // Send ping to client
    try {
      ws.send(JSON.stringify({ type: 'ping', timestamp: new Date().toISOString() }));
    } catch (e) {
      // Ignore send errors (connection already dead)
    }
  });
}, WS_HEARTBEAT_INTERVAL);
```

**Algorithm:**
1. Every 30 seconds, iterate through all connected clients
2. For each client:
   - If `ws.isAlive === false` (no pong received since last ping), **terminate the connection**
   - Set `ws.isAlive = false` (assume dead until proven alive)
   - Send a `ping` message with current timestamp
3. The client must respond with `pong` to set `ws.isAlive = true`

**Why this works:**
- If a client is responsive, it will receive the ping and respond with pong within milliseconds
- If a client has a broken connection, the ping will never be received, and `isAlive` will remain false
- On the next heartbeat cycle (30 seconds later), the connection is terminated

**Cleanup on server shutdown (lines 4438-4440):**

```javascript
wss.on('close', () => {
  clearInterval(heartbeatInterval);  // Stop heartbeat when server closes
});
```

### Client-Side Heartbeat (lines 223-229 in app.js)

The client also sends its own periodic pings every 30 seconds:

```javascript
const WS_HEARTBEAT_MS = 30000; // 30 seconds

function startHeartbeat() {
  wsHeartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, WS_HEARTBEAT_MS);
}
```

**Why both client and server send pings?**
- **Redundancy**: If either side detects a problem, it can take action
- **Bidirectional health check**: Ensures both send and receive paths are working
- **Client-side detection**: The client can detect server unresponsiveness and trigger reconnection

### Ping-Pong Message Handling

**Server receives ping from client (lines 4376-4379):**

```javascript
if (data.type === 'ping') {
  ws.isAlive = true;  // Mark connection as alive
  ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
  return;
}
```

**Server receives pong from client (lines 4382-4385):**

```javascript
if (data.type === 'pong') {
  ws.isAlive = true;  // Mark connection as alive
  return;
}
```

**Client receives ping from server (lines 182-185 in app.js):**

```javascript
if (data.type === 'ping') {
  ws.send(JSON.stringify({ type: 'pong' }));
  return;
}
```

**Client receives pong from server (lines 188-190):**

```javascript
if (data.type === 'pong') {
  return;  // Just acknowledge, no action needed
}
```

### Heartbeat Lifecycle Diagram

```
Time: 0s
Server: ws.isAlive = true (connection established)

Time: 30s
Server: ws.isAlive = false (assume dead)
Server → Client: { type: 'ping', timestamp: '2024-01-18T10:00:00Z' }

Time: 30.05s
Client receives ping
Client → Server: { type: 'pong' }

Time: 30.1s
Server receives pong
Server: ws.isAlive = true (confirmed alive)

Time: 60s
Server: ws.isAlive = false (assume dead)
Server → Client: { type: 'ping', timestamp: '2024-01-18T10:00:30Z' }

[No response from client - network failure]

Time: 90s
Server: ws.isAlive === false (still no pong)
Server: ws.terminate() → Connection closed
```

**Timeout Calculation:**
- Maximum time to detect a dead connection: **60 seconds** (2 heartbeat intervals)
  - 0s: Connection breaks
  - 30s: First ping sent, no response
  - 60s: Second heartbeat cycle detects isAlive=false, terminates connection

---

## Event-Driven Architecture

The WebSocket system implements a **publisher-subscriber pattern** where backend modules emit events, and the WebSocket server broadcasts these events to all connected clients.

### Architecture Overview

```
Backend Modules          WebSocket Server          Connected Clients
─────────────────        ────────────────          ─────────────────

usageTracker  ────────┐
                      │
pinManager    ────────┤
                      │
commandInjector ──────┤──→  EventEmitter  ──→  broadcastToClients()  ──→  Client 1
                      │         ↓                                          Client 2
cdpMonitor    ────────┤    .on('event')                                    Client 3
                      │         ↓                                          ...
orchestratorModule ───┤    Extract data
                      │         ↓
sessionManager ───────┘    Format payload
                               ↓
                          ws.send(JSON)
```

### Event Registration Pattern

Backend modules use Node.js EventEmitter to emit events. The WebSocket server registers listeners for these events:

**Example: Usage tracking events (lines 3970-3976 in server.js):**

```javascript
usageTracker.on('usage-updated', (usage) => {
  broadcastToClients({
    type: 'usage-updated',
    usage: usage,
    timestamp: new Date().toISOString()
  });
});
```

**Example: Security events (lines 3981-4004 in server.js):**

```javascript
pinManager.on('ip-blocked', (data) => {
  console.log(`[SECURITE] IP bloquee: ${data.ip} apres ${data.attempts} tentatives`);
  broadcastToClients({
    type: 'security-ip-blocked',
    ip: data.ip,
    attempts: data.attempts,
    timestamp: new Date().toISOString()
  });
});

pinManager.on('security-alert', (data) => {
  console.log(`[SECURITE ALERTE] ${data.distinctIPs} IPs differentes ont echoue...`);
  broadcastToClients({
    type: 'security-alert',
    alertType: data.type,
    distinctIPs: data.distinctIPs,
    totalAttempts: data.totalAttempts,
    lockdownActivated: data.lockdownActivated || false,
    timestamp: new Date().toISOString()
  });
});

pinManager.on('global-lockdown', (data) => {
  console.log(`[SECURITE] VERROUILLAGE GLOBAL: ${data.reason}`);
  broadcastToClients({
    type: 'global-lockdown',
    reason: data.reason,
    message: 'Le serveur est en mode verrouillage...',
    timestamp: new Date().toISOString()
  });
});
```

**Example: Command injection events (lines 4026-4079 in server.js):**

```javascript
commandInjector.on('injection-started', (data) => {
  console.log(`[CommandInjector] Injection demarree: ${data.command.substring(0, 30)}...`);
  broadcastToClients({
    type: 'injection-started',
    sessionId: data.sessionId,
    command: data.command,
    timestamp: data.timestamp
  });
});

commandInjector.on('injection-success', (data) => {
  console.log(`[CommandInjector] Injection reussie via ${data.result.method}`);
  broadcastToClients({
    type: 'injection-success',
    sessionId: data.sessionId,
    command: data.command,
    method: data.result.method,
    duration: data.duration,
    timestamp: new Date().toISOString()
  });
});

commandInjector.on('injection-failed', (data) => {
  console.log(`[CommandInjector] Injection echouee: ${data.result.error}`);
  broadcastToClients({
    type: 'injection-failed',
    sessionId: data.sessionId,
    command: data.command,
    method: data.result.method,
    error: data.result.error,
    duration: data.duration,
    timestamp: new Date().toISOString()
  });
});

commandInjector.on('injection-error', (data) => {
  console.error(`[CommandInjector] Erreur d'injection: ${data.error}`);
  broadcastToClients({
    type: 'injection-error',
    sessionId: data.sessionId,
    command: data.command,
    error: data.error,
    timestamp: new Date().toISOString()
  });
});
```

**Example: Orchestrator events (lines 4113-4262 in server.js):**

The orchestrator module emits over 20 different event types for task orchestration, worker management, and subsession tracking. Each event is converted to a WebSocket message and broadcast to all clients.

### Client-Side Event Handling

The client receives all broadcast events and routes them to appropriate handlers:

**Main message router (lines 418-548 in app.js):**

```javascript
function handleWebSocketMessage(data) {
  console.log('Message WebSocket:', data);

  // Security: Only allow security events if not authenticated
  const securityEvents = ['security-ip-blocked', 'security-alert', 'security-login-failed', 'connected'];
  if (!isAuthenticated && !securityEvents.includes(data.type)) {
    return;  // CRITICAL: Block non-security events before authentication
  }

  switch (data.type) {
    case 'connected':
      console.log('Connecté au serveur');
      break;

    case 'usage-updated':
      currentUsage = data.usage;
      if (getCurrentRoute() === 'home') {
        renderUsageWidget();  // Update UI
      }
      break;

    case 'security-ip-blocked':
    case 'security-alert':
    case 'security-login-failed':
      handleSecurityWebSocketEvents(data);
      break;

    case 'injection-started':
      handleInjectionStarted(data);
      break;

    case 'injection-success':
      handleInjectionSuccess(data);
      break;

    case 'cdp-connections-detected':
    case 'cdp-connection-count-changed':
      handleCDPConnectionUpdate(data);
      break;

    case 'orchestrator:created':
      handleOrchestratorCreated(data);
      break;

    case 'orchestrator:started':
    case 'orchestrator:phaseChanged':
    case 'orchestrator:progress':
      handleOrchestratorUpdate(data);
      break;

    // ... 40+ event types total
  }
}
```

**Security filtering:** Before authentication, the client **only processes security-related events** (ip-blocked, security-alert, login-failed, connected). All other events are silently dropped. This prevents information leakage to unauthenticated clients.

### Event Flow Diagram

```
EXAMPLE: User sends message to Claude

1. Frontend calls POST /api/sessions/:id/inject
   ↓
2. Backend commandInjector.inject() starts
   ↓
3. commandInjector emits 'injection-started'
   ↓
4. WebSocket server hears event via .on('injection-started')
   ↓
5. broadcastToClients() called with { type: 'injection-started', ... }
   ↓
6. wss.clients.forEach() → ws.send(JSON.stringify(data))
   ↓
7. All connected clients receive WebSocket message
   ↓
8. Client app.js: ws.onmessage → handleWebSocketMessage()
   ↓
9. Client routes to handleInjectionStarted(data)
   ↓
10. UI updated: "Envoi en cours..." notification shown
    ↓
11. Injection completes → 'injection-success' event
    ↓
12. Repeat steps 4-10 with success notification
```

---

## Broadcasting to Multiple Clients

The broadcasting mechanism allows the server to **push updates to all connected clients simultaneously**, ensuring that multiple users viewing the same dashboard see real-time updates.

### Core Broadcasting Function (lines 3959-3965 in server.js)

```javascript
function broadcastToClients(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}
```

**Simple but effective:**
1. Iterate through all connected WebSocket clients (`wss.clients` is a Set)
2. Check if each client's connection is in OPEN state (not CONNECTING, CLOSING, or CLOSED)
3. Serialize the data object to JSON
4. Send to the client via `client.send()`

**Why check `readyState === WebSocket.OPEN`?**
- Prevents errors when trying to send to clients that are mid-handshake (CONNECTING)
- Prevents errors when trying to send to clients that are closing (CLOSING/CLOSED)
- The `send()` method will throw an error if called on a non-OPEN socket

### Broadcasting Use Cases

**Use Case 1: System-Wide Notifications**

When the server detects a security event (e.g., IP blocked), all connected administrators should be notified immediately:

```javascript
pinManager.on('ip-blocked', (data) => {
  broadcastToClients({
    type: 'security-ip-blocked',
    ip: data.ip,
    attempts: data.attempts,
    timestamp: new Date().toISOString()
  });
});
```

All clients receive the notification and can display a security alert.

**Use Case 2: Real-Time Session Updates**

When a command injection succeeds, all clients viewing the session list should see the updated status:

```javascript
commandInjector.on('injection-success', (data) => {
  broadcastToClients({
    type: 'injection-success',
    sessionId: data.sessionId,
    command: data.command,
    method: data.result.method,
    duration: data.duration,
    timestamp: new Date().toISOString()
  });
});
```

Clients viewing that specific session can reload the session detail to show the newly injected message.

**Use Case 3: Usage Tracking**

When token usage is updated (e.g., Claude responds to a message), all clients should see the updated usage stats:

```javascript
usageTracker.on('usage-updated', (usage) => {
  broadcastToClients({
    type: 'usage-updated',
    usage: usage,
    timestamp: new Date().toISOString()
  });
});
```

The usage widget on all connected clients is automatically updated.

### Selective Broadcasting (Not Implemented, But Pattern Available)

While the current implementation broadcasts to **all** clients, the pattern can be extended for selective broadcasting:

```javascript
function broadcastToAuthenticatedClients(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.isAuthenticated) {
      client.send(JSON.stringify(data));
    }
  });
}
```

This would allow sending sensitive data only to authenticated clients, but currently the frontend handles filtering by checking `isAuthenticated` before processing events.

### Broadcasting Performance Considerations

**Scalability:**
- Broadcasting to N clients requires N `send()` calls
- Each `send()` serializes the JSON (O(N) operation if done inside forEach)
- **Optimization opportunity**: Serialize JSON once, reuse for all clients:

```javascript
function broadcastToClients(data) {
  const message = JSON.stringify(data);  // Serialize once
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);  // Reuse serialized message
    }
  });
}
```

**Current implementation** serializes inside forEach (line 3962), which is acceptable for small client counts (<100) but could be optimized for larger deployments.

---

## Client Reconnection Logic with Exponential Backoff

When a WebSocket connection is lost (network failure, server restart, etc.), the client automatically attempts to reconnect with **exponential backoff** to avoid overwhelming the server with connection attempts.

### Reconnection Algorithm (lines 203-220 in app.js)

```javascript
ws.onclose = () => {
  console.log('WebSocket déconnecté');
  updateStatus(false);  // Show "Disconnected" in UI

  // Stop heartbeat
  if (wsHeartbeatInterval) {
    clearInterval(wsHeartbeatInterval);
    wsHeartbeatInterval = null;
  }

  // Reconnection with exponential backoff
  wsReconnectAttempts++;
  const delay = Math.min(WS_RECONNECT_DELAY_BASE * Math.pow(1.5, wsReconnectAttempts), 30000);
  console.log(`Reconnexion dans ${delay}ms (tentative ${wsReconnectAttempts})`);

  showReconnectingStatus();
  setTimeout(connectWebSocket, delay);
};
```

### Backoff Formula

```
delay = min(BASE * 1.5^attempts, MAX)
```

Where:
- `BASE = 2000ms` (2 seconds)
- `MAX = 30000ms` (30 seconds)
- `attempts` increments on each failed connection

**Delay progression:**

| Attempt | Formula | Calculated Delay | Actual Delay (capped at 30s) |
|---------|---------|------------------|------------------------------|
| 1 | 2000 * 1.5^1 | 3000ms | 3s |
| 2 | 2000 * 1.5^2 | 4500ms | 4.5s |
| 3 | 2000 * 1.5^3 | 6750ms | 6.75s |
| 4 | 2000 * 1.5^4 | 10125ms | 10.125s |
| 5 | 2000 * 1.5^5 | 15187ms | 15.2s |
| 6 | 2000 * 1.5^6 | 22780ms | 22.8s |
| 7 | 2000 * 1.5^7 | 34171ms | **30s** (capped) |
| 8+ | 2000 * 1.5^n | >30000ms | **30s** (capped) |

**Why exponential backoff?**
1. **Avoids server overload**: If the server is down/restarting, constant rapid reconnection attempts would waste resources
2. **Network-friendly**: Temporary network issues often resolve themselves; exponential backoff gives time for recovery
3. **User experience**: Shows the client is still trying but not spamming
4. **Prevents thundering herd**: If server restarts, all clients won't reconnect simultaneously (they'll be at different backoff stages)

### Backoff Reset (line 168 in app.js)

When connection succeeds, the counter is reset:

```javascript
ws.onopen = () => {
  console.log('WebSocket connecté');
  updateStatus(true);
  wsReconnectAttempts = 0;  // RESET backoff counter

  startHeartbeat();
  reloadAllData();
};
```

This ensures that if the connection is stable, any future disconnection will start from the minimum delay again.

### Reconnection Flow Diagram

```
Time: 0s
Connection lost → onclose triggered

Time: 0s
wsReconnectAttempts = 1
delay = 2000 * 1.5^1 = 3000ms
setTimeout(connectWebSocket, 3000)
UI: "Reconnecting..."

Time: 3s
connectWebSocket() called
WebSocket connection attempt
→ Server is down → Connection fails → onclose triggered again

Time: 3s
wsReconnectAttempts = 2
delay = 2000 * 1.5^2 = 4500ms
setTimeout(connectWebSocket, 4500)

Time: 7.5s
connectWebSocket() called
WebSocket connection attempt
→ Server is up → Connection succeeds → onopen triggered

Time: 7.5s
wsReconnectAttempts = 0 (reset)
UI: "Connected"
```

### Blocking Reconnection During Unauthenticated State

**Critical security feature (lines 137-140 in app.js):**

```javascript
function connectWebSocket() {
  // SECURITY: Block WebSocket connection if PIN required but not authenticated
  if (pinRequired && !isAuthenticated) {
    console.log('[WebSocket] Connexion bloquée - authentification PIN requise');
    return;  // Exit without scheduling reconnection
  }
  // ...
}
```

If the user is logged out or session expires, the reconnection loop **terminates** instead of continuously attempting to reconnect. This prevents:
1. Wasted bandwidth on connections that will be rejected
2. Potential server load from failed authentication attempts
3. Confusion in logs (repeated "Unauthorized" messages)

The WebSocket will only reconnect after the user successfully reauthenticates via PIN.

---

## Message Queuing During Disconnection

**Important Note:** The current implementation **does not have explicit client-side message queuing**. This section describes the implicit behavior and potential enhancement opportunities.

### Current Behavior

When the WebSocket is disconnected, the client:
1. Shows "Disconnected" status in UI
2. Attempts reconnection with exponential backoff
3. **Does NOT queue outbound messages** (client only sends ping/pong, not user messages)

**Why no queuing?**
- The client primarily **receives** events from the server via WebSocket
- User actions (sending messages, managing sessions) use **REST API calls** (fetch), not WebSocket messages
- WebSocket is **one-directional** for data (server → client), bidirectional only for ping/pong

### Inbound Event Handling During Disconnection

When disconnected, the client:
1. **Cannot receive events** (WebSocket is closed)
2. **Polls for critical data** when reconnection succeeds (via `reloadAllData()`)

**reloadAllData() function (lines 231-247 in app.js):**

```javascript
async function reloadAllData() {
  // Don't reload if not authenticated
  if (!isAuthenticated) {
    console.log('Rechargement ignore - non authentifie');
    return;
  }

  console.log('Rechargement des données après reconnexion...');
  try {
    // Reload sessions
    await loadSessions();

    // Reload current session if viewing one
    const currentSessionId = getCurrentSessionId();
    if (currentSessionId) {
      await loadSessionDetail(currentSessionId);
    }

    // Reload pending permissions
    await loadPendingPermissions();
  } catch (e) {
    console.error('Erreur lors du rechargement:', e);
  }
}
```

**Synchronization on reconnection:**
1. When WebSocket reconnects, `ws.onopen` triggers `reloadAllData()`
2. Client fetches fresh data from REST API endpoints
3. UI is updated to reflect current server state
4. **Missed events during disconnection are "replayed"** implicitly via REST API data

**Example scenario:**
1. Client disconnects at 10:00:00
2. User sends a message via another client at 10:00:30 → `injection-success` event broadcast (this client misses it)
3. Client reconnects at 10:01:00 → `reloadAllData()` called
4. `loadSessions()` fetches latest session data from `/api/sessions` → new message is visible
5. UI is updated with the new message (indistinguishable from real-time event)

### Theoretical Message Queuing (Not Implemented)

If the client needed to send messages via WebSocket (currently not the case), a queue could be implemented:

```javascript
// THEORETICAL CODE (not in actual implementation)
let messageQueue = [];

function sendWebSocketMessage(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  } else {
    // Queue message for later
    messageQueue.push(data);
    console.log('Message queued (WebSocket disconnected)');
  }
}

ws.onopen = () => {
  // Flush queue on reconnection
  while (messageQueue.length > 0) {
    const msg = messageQueue.shift();
    ws.send(JSON.stringify(msg));
  }
};
```

**Why this isn't necessary in current implementation:**
- User actions use REST API (stateless, idempotent)
- REST API calls automatically retry on network failure (browser fetch behavior)
- WebSocket is only for **receiving** server events, not sending user commands

---

## State Synchronization Across Multiple Clients

The WebSocket broadcasting mechanism ensures that **all connected clients see a consistent view of server state** by pushing updates in real-time.

### Synchronization Mechanisms

**1. Broadcast Events (Real-Time Push)**

When server state changes, all clients are immediately notified:

```javascript
// Server: Usage updated
usageTracker.on('usage-updated', (usage) => {
  broadcastToClients({
    type: 'usage-updated',
    usage: usage,
    timestamp: new Date().toISOString()
  });
});

// Client 1, 2, 3, ... all receive and update UI
case 'usage-updated':
  currentUsage = data.usage;
  if (getCurrentRoute() === 'home') {
    renderUsageWidget();
  }
  break;
```

**Result:** All clients' usage widgets update simultaneously.

**2. Session Switching Synchronization**

When a user switches to a different Claude session via one client, all other clients are notified:

```javascript
// Server: Session switched
broadcastToClients({
  type: 'cdp-session-switched',
  sessionId: data.sessionId,
  previousSessionId: data.previousSessionId,
  timestamp: new Date().toISOString()
});

// All clients handle the event
function handleCDPSessionSwitched(data) {
  console.log('[CDP] Session changee vers', data.sessionId);
  // Reload session list to update isCurrent flags
  loadSessions();
  // If viewing session page, redirect to new active session
  if (getCurrentRoute() === 'session') {
    goToSession(data.sessionId);
  }
}
```

**Result:** If User A switches to Session X, all other users see Session X as the active session.

**3. Command Injection Synchronization**

When a message is injected into Claude via one client, all clients monitoring that session are updated:

```javascript
// Server: Message injected
broadcastToClients({
  type: 'message-injected',
  sessionId: data.sessionId,
  messageId: data.messageId,
  timestamp: new Date().toISOString()
});

// All clients reload the session if they're viewing it
function handleMessageInjected(data) {
  console.log('[Injection] Message injecte dans session', data.sessionId);
  if (getCurrentRoute() === 'session' && getCurrentSessionId() === data.sessionId) {
    loadSessionDetail(data.sessionId);  // Refresh session detail
  }
}
```

**Result:** User A sends a message to Claude via Client 1 → User B viewing the same session on Client 2 sees the message appear in real-time.

**4. Orchestrator Task Synchronization**

The orchestrator module emits dozens of events for task progress, worker status, and subsession management:

```javascript
// Server: Orchestrator progress
orchestratorModule.on('orchestrator:progress', (data) => {
  broadcastToClients({
    type: 'orchestrator:progress',
    data: data,
    timestamp: new Date().toISOString()
  });
});

// All clients update orchestrator dashboard
function handleOrchestratorUpdate(wsMessage) {
  const data = wsMessage.data || wsMessage;
  if (currentOrchestrator && currentOrchestrator.id === data.id) {
    refreshOrchestratorDashboard();  // Real-time progress update
  }
}
```

**Result:** User A starts a big task → User B watching the orchestrator dashboard sees real-time progress updates.

### Race Conditions and Eventual Consistency

**Potential race condition:** WebSocket events vs. REST API responses

**Scenario:**
1. Client calls POST `/api/sessions/:id/inject`
2. Server processes injection, emits `injection-success` event
3. WebSocket broadcast is sent **before** HTTP response returns

**Timeline:**
```
T+0ms:   Client → POST /api/sessions/123/inject
T+50ms:  Server starts processing
T+100ms: Injection succeeds, emit 'injection-success'
T+105ms: WebSocket broadcast sent to all clients
T+110ms: Client receives WebSocket event → triggers reload
T+150ms: HTTP response returns to client
```

**Client receives the WebSocket event before the HTTP response completes!**

**Mitigation in app.js (lines 432-444):**

```javascript
case 'sessions-list':
  // Ignore sessions-list if we already have CDP data
  // (avoid race condition where WebSocket sends file-based data
  // while API has already loaded CDP sessions)
  if (Object.keys(sessions).length === 0) {
    data.sessions.forEach(session => {
      sessions[session.id] = session;
    });
    if (getCurrentRoute() === 'home') {
      renderHomePage();
    }
  }
  break;
```

The client **ignores WebSocket session updates if it already has fresher data from REST API**. This prevents older file-based session data from overwriting newer CDP-based session data.

**General pattern for eventual consistency:**
1. WebSocket events are treated as **hints to refresh**
2. Client reloads data from REST API (source of truth)
3. UI updates based on REST API response, not WebSocket payload

This ensures that even if WebSocket events arrive out of order or contain stale data, the client will eventually converge to correct state.

---

## Error Handling and Connection Cleanup

### Server-Side Error Handling

**Client error handler (lines 4397-4399 in server.js):**

```javascript
ws.on('error', (error) => {
  console.error('Erreur WebSocket client:', error.message);
});
```

**Purpose:** Log WebSocket errors (e.g., ECONNRESET, EPIPE) without crashing the server.

**Common errors:**
- `ECONNRESET`: Client closed connection abruptly (browser crash, network failure)
- `EPIPE`: Tried to write to closed socket
- `ETIMEDOUT`: Connection timeout

These errors are **non-fatal** and handled gracefully by the ws library. The error handler just logs for debugging.

**Broadcast send error handling (lines 4429-4433):**

```javascript
try {
  ws.send(JSON.stringify({ type: 'ping', timestamp: new Date().toISOString() }));
} catch (e) {
  // Ignore errors (connection already dead)
}
```

When sending heartbeat pings, errors are caught and ignored because:
1. If `send()` fails, the connection is already broken
2. The heartbeat mechanism will detect the dead connection on next cycle
3. No need to log error (spammy, not actionable)

**Shutdown cleanup (lines 4455-4489):**

```javascript
// Close all WebSocket connections
wss.clients.forEach((ws) => {
  try {
    ws.send(JSON.stringify({ type: 'shutdown', message: 'Le serveur s\'arrête' }));
    ws.close();
  } catch (e) {
    // Ignore errors
  }
});

// Close WebSocket server
wss.close(() => {
  console.log('✓ WebSocket fermé');
});

// Close HTTP server
server.close(() => {
  console.log('✓ Serveur HTTP fermé');
  process.exit(0);
});

// Force exit after 5 seconds if graceful shutdown fails
setTimeout(() => {
  console.log('⚠ Forçage de l\'arrêt...');
  process.exit(0);
}, 5000);
```

**Shutdown sequence:**
1. Send `shutdown` message to all clients (gives them time to display notification)
2. Close all individual client connections
3. Close WebSocket server (stops accepting new connections)
4. Close HTTP server
5. Force exit after 5 seconds if graceful shutdown hangs

**Why force exit after 5s?**
- Prevents server from hanging if a connection refuses to close
- Ensures server restarts complete in reasonable time

### Client-Side Error Handling

**WebSocket error handler (lines 198-201 in app.js):**

```javascript
ws.onerror = (error) => {
  console.error('Erreur WebSocket:', error);
  updateStatus(false);
};
```

**Purpose:** Log errors and update UI to show disconnected state.

**Note:** The `onerror` event doesn't provide detailed error information in browsers (security restriction). The actual error is usually just `Event` object with minimal info.

**Close handler (lines 203-220):**

```javascript
ws.onclose = () => {
  console.log('WebSocket déconnecté');
  updateStatus(false);

  // Stop heartbeat
  if (wsHeartbeatInterval) {
    clearInterval(wsHeartbeatInterval);
    wsHeartbeatInterval = null;
  }

  // Reconnection with exponential backoff
  wsReconnectAttempts++;
  const delay = Math.min(WS_RECONNECT_DELAY_BASE * Math.pow(1.5, wsReconnectAttempts), 30000);
  console.log(`Reconnexion dans ${delay}ms (tentative ${wsReconnectAttempts})`);

  showReconnectingStatus();
  setTimeout(connectWebSocket, delay);
};
```

**Cleanup performed:**
1. Update UI to "Disconnected"
2. Stop heartbeat interval (prevents heartbeat from trying to send on closed socket)
3. Schedule reconnection

**Message parsing error handling (lines 193-195 in app.js):**

```javascript
ws.onmessage = (event) => {
  try {
    const data = JSON.parse(event.data);
    // ... handle message
  } catch (e) {
    console.error('Erreur de parsing WebSocket:', e);
  }
};
```

If the server sends invalid JSON (shouldn't happen, but defensive), the error is logged and the message is skipped.

**API error handling with authentication failure (lines 842-851 in app.js):**

```javascript
if (response.status === 401 && pinRequired) {
  console.warn('[API] 401 Unauthorized - session invalide ou expiree');
  isAuthenticated = false;
  ws?.close();  // Close WebSocket
  sessionToken = '';
  localStorage.removeItem('sessionToken');
  showPINModal();  // Force re-authentication
  throw new Error('Session expired. Please login again.');
}
```

When a REST API call returns 401 (session expired), the client:
1. Marks as unauthenticated
2. **Closes the WebSocket** (prevents reconnection loop)
3. Clears session token
4. Shows PIN modal for re-authentication

This ensures that if the session expires, the WebSocket doesn't continuously try to reconnect with an invalid token.

### Connection Cleanup on Navigation

**Page unload (lines 1670-1672 in app.js):**

```javascript
window.addEventListener('beforeunload', () => {
  // Close WebSocket
  if (ws) {
    ws.close();
  }
});
```

When the user closes the browser tab or navigates away, the WebSocket is gracefully closed to avoid leaving orphaned connections on the server.

---

## Integration with Authentication System

The WebSocket system is tightly integrated with the **PIN-based authentication system**. When PIN is enabled, all WebSocket connections must be authenticated with a valid session token.

### Authentication Flow

```
USER                    CLIENT                  SERVER
 |                        |                        |
 |--[Enter PIN]---------->|                        |
 |                        |---POST /api/auth/----->|
 |                        |    login               |
 |                        |                   [Validate PIN]
 |                        |                   [Create session]
 |                        |<---{token: "abc"}------|
 |                        |                        |
 |                   [Store token]                 |
 |                   [Set isAuthenticated=true]    |
 |                        |                        |
 |                        |---WebSocket---------->|
 |                        |   ?token=abc           |
 |                        |                   [Validate token]
 |                        |<---101 Switching-------|
 |                        |    Protocols           |
 |                        |                        |
 |                   [Connected]                   |
```

### Server-Side Authentication (lines 4350-4366)

```javascript
wss.on('connection', (ws, req) => {
  // Authentication check for WebSocket
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  const ip = pinManager.getClientIP(req);

  // Verify session token if PIN is enabled
  if (pinManager.isPinEnabled()) {
    if (!token || !pinManager.isSessionValid(token, ip)) {
      console.log(`[WebSocket] Rejected connection from ${ip} - invalid or missing token`);
      ws.close(4001, 'Unauthorized - Invalid or missing session token');
      return;  // Connection terminated
    }
    console.log(`[WebSocket] Authenticated connection from ${ip}`);
  } else {
    console.log(`[WebSocket] Connection from ${ip} (no auth required)`);
  }

  // Connection accepted, proceed with setup
  ws.isAlive = true;
  // ...
});
```

**Authentication checks:**
1. Extract token from URL query parameter: `?token=abc123`
2. Extract client IP from request headers (X-Forwarded-For or socket.remoteAddress)
3. If PIN is enabled:
   - Verify token exists
   - Call `pinManager.isSessionValid(token, ip)` to validate:
     - Token exists in session store
     - Token has not expired
     - IP matches the IP that created the session (prevents token theft)
4. If authentication fails, close connection with code 4001 and reason "Unauthorized"
5. If authentication succeeds or PIN is disabled, accept connection

### Client-Side Token Handling (lines 137-162 in app.js)

```javascript
function connectWebSocket() {
  // SECURITY: Block WebSocket connection if PIN required but not authenticated
  if (pinRequired && !isAuthenticated) {
    console.log('[WebSocket] Connexion bloquée - authentification PIN requise');
    return;
  }

  // ... cleanup old connection

  // SECURITY: Use global sessionToken, NOT localStorage
  // localStorage has been cleared on page load to force re-authentication
  const wsUrlWithAuth = sessionToken
    ? `${WS_URL}?token=${encodeURIComponent(sessionToken)}`
    : WS_URL;

  ws = new WebSocket(wsUrlWithAuth);
  // ...
}
```

**Client-side security measures:**
1. **Pre-connection check**: Don't even attempt connection if PIN is required but not authenticated
2. **Token from memory**: Use `sessionToken` variable (in-memory), **NOT** localStorage
3. **URL encoding**: Encode token to handle special characters safely

**Why not use localStorage?**

Lines 16-22 in app.js:
```javascript
// SECURITY: Force clearing tokens on page load to force re-authentication
if (localStorage.getItem('authToken') || localStorage.getItem('sessionToken')) {
  console.log('[Security] Effacement tokens au chargement pour ré-authentification');
  localStorage.removeItem('authToken');
  localStorage.removeItem('sessionToken');
}

let sessionToken = '';  // Plus de lecture depuis localStorage
```

**Security rationale:**
- localStorage persists across browser sessions → risk of stale tokens
- Forcing re-authentication on page load ensures fresh, valid tokens
- Prevents bypass attacks where attacker injects old token into localStorage

**Token is stored in-memory only**, populated after successful PIN login:

```javascript
// After successful login (line 5496)
sessionToken = data.token;
isAuthenticated = true;
```

### Session Expiration Handling

**Server-side:** Sessions expire after inactivity (configurable in PINManager)

**Client-side detection (lines 842-851 in app.js):**

When any REST API call returns 401:
```javascript
if (response.status === 401 && pinRequired) {
  console.warn('[API] 401 Unauthorized - session invalide ou expiree');
  isAuthenticated = false;
  ws?.close();  // CRITICAL: Close WebSocket
  sessionToken = '';
  localStorage.removeItem('sessionToken');
  showPINModal();
  throw new Error('Session expired. Please login again.');
}
```

**Session expiration flow:**
```
1. User authenticated, WebSocket connected
2. Session expires on server (timeout)
3. Client makes REST API call → 401 response
4. Client detects 401:
   - Sets isAuthenticated = false
   - Closes WebSocket
   - Clears sessionToken
   - Shows PIN modal
5. WebSocket onclose triggered
6. Reconnection is blocked (pinRequired && !isAuthenticated)
7. User must re-enter PIN
8. After successful login, WebSocket reconnects with new token
```

### Event Filtering by Authentication Status

**Critical security feature (lines 421-425 in app.js):**

```javascript
function handleWebSocketMessage(data) {
  console.log('Message WebSocket:', data);

  // Only allow security events if not authenticated
  const securityEvents = ['security-ip-blocked', 'security-alert', 'security-login-failed', 'connected'];
  if (!isAuthenticated && !securityEvents.includes(data.type)) {
    return;  // Block all non-security events
  }

  switch (data.type) {
    // ... event handlers
  }
}
```

**Before authentication**, the client only processes:
- `connected`: WebSocket connection confirmation
- `security-ip-blocked`: Alert that an IP was blocked
- `security-alert`: General security alerts
- `security-login-failed`: Failed login attempts

**All other events are silently dropped**, preventing information leakage to unauthenticated clients.

**After authentication**, all events are processed normally.

---

## How WebSocket Complements Polling

The system uses a **hybrid approach** combining WebSocket push events with REST API polling for different data sources.

### Architecture Rationale

**WebSocket strengths:**
- Real-time push notifications
- Low latency (<50ms for server events)
- Efficient for frequent updates (no HTTP overhead)

**WebSocket weaknesses:**
- Stateful connection (doesn't survive server restart)
- Not suitable for request-response patterns
- Missed events during disconnection

**REST API polling strengths:**
- Stateless (always gets latest data)
- Reliable (HTTP retry mechanisms)
- Can fetch historical data (not just latest event)

**REST API polling weaknesses:**
- Higher latency (polling interval)
- More server load (repeated requests)
- Wasted bandwidth (polling when nothing changed)

### Division of Responsibilities

**WebSocket handles:**
1. **Usage updates** (`usage-updated`)
2. **Security events** (`security-ip-blocked`, `security-alert`, `global-lockdown`)
3. **Command injection events** (`injection-started`, `injection-success`, `injection-failed`)
4. **CDP monitoring events** (`cdp-connections-detected`, `cdp-connection-count-changed`)
5. **Orchestrator events** (40+ event types for task orchestration)
6. **Session switching** (`cdp-session-switched`)

**REST API polling handles:**
1. **Sessions** (polled every 3s when Claude is thinking, 60s when idle)
2. **Session messages** (polled when viewing session detail)
3. **Permissions** (polled every 3-8s depending on activity)
4. **Authentication status** (checked on every API call via 401 detection)

### Why Not Use WebSocket for Everything?

**Sessions and messages are NOT sent via WebSocket because:**

1. **Large payload size**: Session data can be megabytes (full conversation history, tool uses, artifacts) → WebSocket not optimal for bulk data transfer
2. **CDP integration**: Sessions are stored in Chrome DevTools Protocol database, accessed via file reads → easier to poll on-demand than stream all changes
3. **Partial updates complexity**: Broadcasting full session data on every message would be wasteful; broadcasting only deltas would require complex merge logic on client
4. **Missed events problem**: If a client disconnects during a long Claude response (10+ messages), it would miss dozens of events → easier to just fetch latest state on reconnection

**Permissions are polled because:**

1. **CDP-specific data**: Permissions come from Chrome DevTools Protocol, not from backend EventEmitters
2. **Timeout management**: Permissions have countdown timers → client needs fresh data to calculate remaining time accurately
3. **Polling optimization**: The client already implements smart backoff (8s max interval when no changes), making polling efficient

### Example: Command Injection Flow (WebSocket + REST)

**Scenario: User sends message to Claude**

1. User clicks "Send" → POST `/api/sessions/:id/inject`
2. **REST API** processes injection, returns success
3. Backend emits `injection-started` event
4. **WebSocket** broadcasts `injection-started` to all clients
5. All clients show "Sending..." notification
6. Injection completes → backend emits `injection-success`
7. **WebSocket** broadcasts `injection-success` to all clients
8. All clients show "Message sent" notification
9. Client **polls** `/api/sessions/:id` to get updated session with new message
10. UI updates with full message content

**Why this hybrid approach?**
- WebSocket provides instant feedback ("Sending...", "Sent")
- REST API provides full data (actual message content, Claude's response)
- Best of both worlds: low latency + data completeness

### Example: Session Monitoring (Polling Only)

**Scenario: User viewing Claude session detail**

1. User navigates to session detail page
2. Client fetches initial session data via **REST API** (`/api/sessions/:id`)
3. Client starts **polling loop** (every 3 seconds if Claude is thinking)
4. Each poll fetches updated session data
5. If new messages detected, UI updates incrementally
6. If session becomes idle, polling slows to 60 seconds

**Why no WebSocket?**
- Session data is too large to broadcast on every change
- Polling allows client to fetch only when user is actively viewing
- Client can implement smart caching (only update if hash changed)

### Polling Optimization with WebSocket Hints

**Future enhancement opportunity (not implemented):**

WebSocket events could be used as **hints to poll immediately**, eliminating polling latency:

```javascript
// THEORETICAL CODE
case 'session-updated':
  // WebSocket hint: session data changed
  if (getCurrentRoute() === 'session' && getCurrentSessionId() === data.sessionId) {
    // Poll immediately instead of waiting for next interval
    loadSessionDetail(data.sessionId);
  }
  break;
```

This would combine the efficiency of WebSocket (instant notification) with the reliability of REST API (always get latest data).

### Sequence Diagram: Hybrid WebSocket + Polling

```
USER                  CLIENT                    WEBSOCKET               REST API
 |                      |                          |                      |
 |--[Send message]----->|                          |                      |
 |                      |-------POST /inject------------------------------>|
 |                      |                          |                 [Process]
 |                      |                          |                 [Emit event]
 |                      |                          |<---[injection-started]|
 |                      |<---[WS: injection-start]-|                      |
 |                 [Show "Sending..."]             |                      |
 |                      |                          |                      |
 |                      |<---HTTP 200 OK-------------------------------------|
 |                      |                          |<---[injection-success]|
 |                      |<---[WS: injection-success]|                     |
 |                 [Show "Sent!"]                  |                      |
 |                      |                          |                      |
 |                      |-------GET /sessions/:id------------------------>|
 |                      |<---[Session data with new message]--------------|
 |                 [Update UI with message]        |                      |
 |                      |                          |                      |
 |                [Start polling]                  |                      |
 |                      |-------GET /sessions/:id (poll 1)--------------->|
 |                      |<---[Session data]-------------------------------|
 |                      |                          |                      |
 |                      |-------GET /sessions/:id (poll 2)--------------->|
 |                      |<---[Session data with Claude response]---------|
 |                 [Update UI with response]       |                      |
```

---

# PART 2: IMPORTANT VARIABLES/INPUTS/OUTPUTS

## Complete Event Catalog

### Event Types: Server → Client

The server broadcasts the following events to connected clients via WebSocket:

#### Connection Events
| Event Type | Source | Frequency | Description |
|------------|--------|-----------|-------------|
| `connected` | WebSocket server | Once per connection | Sent immediately after WebSocket connection is established |
| `shutdown` | WebSocket server | Once during shutdown | Notifies clients that server is shutting down |
| `ping` | WebSocket heartbeat | Every 30s | Server-initiated heartbeat ping |
| `pong` | WebSocket heartbeat | On client ping | Response to client's ping |

#### Usage Tracking Events
| Event Type | Source | Frequency | Description |
|------------|--------|-----------|-------------|
| `usage-updated` | usageTracker | On token usage change | Token usage statistics updated (input/output/cache/total) |

#### Security Events
| Event Type | Source | Frequency | Description |
|------------|--------|-----------|-------------|
| `security-ip-blocked` | pinManager | On IP block | An IP address has been blocked after failed login attempts |
| `security-alert` | pinManager | On threshold breach | Security alert when multiple IPs fail authentication |
| `global-lockdown` | pinManager | On lockdown activation | Server enters lockdown mode (new connections blocked) |
| `security-login-failed` | pinManager | On failed login | Login attempt failed (includes attempts remaining) |

#### Command Injection Events
| Event Type | Source | Frequency | Description |
|------------|--------|-----------|-------------|
| `injection-started` | commandInjector | On injection start | Command injection to Claude has started |
| `injection-success` | commandInjector | On injection success | Command successfully injected via CDP |
| `injection-failed` | commandInjector | On injection failure | Command injection failed (method and error provided) |
| `injection-error` | commandInjector | On injection error | Critical error during injection process |
| `command-queued` | commandInjector | On queue addition | Command added to injection queue |
| `message-injected` | commandInjector | On message injection | Message successfully injected into session |

#### CDP Monitoring Events
| Event Type | Source | Frequency | Description |
|------------|--------|-----------|-------------|
| `cdp-connections-detected` | cdpMonitor | On initial detection | CDP connections detected on startup |
| `cdp-connection-count-changed` | cdpMonitor | On count change | Number of CDP connections changed |
| `cdp-new-connection` | cdpMonitor | On new connection | New CDP connection detected |
| `cdp-session-switched` | cdpController | On session switch | Active Claude session switched to different session |
| `cdp-permission-responded` | cdpController | On permission response | Permission request answered (once/always/never) |
| `cdp-question-answered` | cdpController | On question response | AskUserQuestion answered |

#### Orchestrator Events (Task Management)
| Event Type | Source | Frequency | Description |
|------------|--------|-----------|-------------|
| `orchestrator:created` | orchestratorModule | On orchestrator creation | New orchestrator instance created for big task |
| `orchestrator:started` | orchestratorModule | On orchestrator start | Orchestrator started executing |
| `orchestrator:phaseChanged` | orchestratorModule | On phase transition | Orchestrator moved to new phase (planning/execution/review) |
| `orchestrator:analysisComplete` | orchestratorModule | After analysis | Task analysis completed |
| `orchestrator:tasksReady` | orchestratorModule | After task breakdown | Tasks broken down and ready for execution |
| `orchestrator:progress` | orchestratorModule | On progress update | Overall orchestrator progress updated |
| `orchestrator:completed` | orchestratorModule | On completion | Orchestrator finished all tasks successfully |
| `orchestrator:error` | orchestratorModule | On error | Orchestrator encountered critical error |
| `orchestrator:cancelled` | orchestratorModule | On cancellation | Orchestrator cancelled by user |
| `orchestrator:paused` | orchestratorModule | On pause | Orchestrator paused by user |
| `orchestrator:resumed` | orchestratorModule | On resume | Orchestrator resumed after pause |

#### Worker Events (Individual Task Execution)
| Event Type | Source | Frequency | Description |
|------------|--------|-----------|-------------|
| `worker:spawned` | orchestratorModule | On worker creation | Worker session spawned for task |
| `worker:started` | orchestratorModule | On worker start | Worker started executing task (obsolete event) |
| `worker:progress` | orchestratorModule | On worker progress | Worker reported progress on task |
| `worker:completed` | orchestratorModule | On worker completion | Worker completed task successfully |
| `worker:failed` | orchestratorModule | On worker failure | Worker failed to complete task |
| `worker:timeout` | orchestratorModule | On worker timeout | Worker exceeded timeout limit |
| `worker:cancelled` | orchestratorModule | On worker cancellation | Worker cancelled by orchestrator |

#### SubSession Events (Session Hierarchy)
| Event Type | Source | Frequency | Description |
|------------|--------|-----------|-------------|
| `subsession:registered` | orchestratorModule | On subsession registration | Child session registered to parent |
| `subsession:statusChanged` | orchestratorModule | On status change | Subsession status changed (thinking/idle/etc) |
| `subsession:activity` | orchestratorModule | On activity | Subsession activity detected (frequent) |
| `subsession:resultReturned` | orchestratorModule | On result return | Subsession returned result to parent |
| `subsession:orphaned` | orchestratorModule | On orphan detection | Subsession orphaned (parent closed) |
| `subsession:error` | orchestratorModule | On subsession error | Subsession encountered error |
| `subsession:archived` | orchestratorModule | On archival | Subsession archived after completion |
| `subsession:monitoring:started` | orchestratorModule | On monitor start | Subsession monitoring started |
| `subsession:monitoring:stopped` | orchestratorModule | On monitor stop | Subsession monitoring stopped |

### Event Types: Client → Server

The client sends only heartbeat messages to the server:

| Event Type | Frequency | Description |
|------------|-----------|-------------|
| `ping` | Every 30s | Client-initiated heartbeat ping |
| `pong` | On server ping | Response to server's ping |

**Note:** User actions (sending messages, managing sessions) are sent via REST API, not WebSocket.

---

## Event Payload Structures

### Connection Events

**`connected`**
```json
{
  "type": "connected",
  "message": "Connecte au serveur ClaudeCode_Remote",
  "pinEnabled": true,
  "timestamp": "2024-01-18T10:00:00.000Z"
}
```

**`shutdown`**
```json
{
  "type": "shutdown",
  "message": "Le serveur s'arrête",
  "timestamp": "2024-01-18T10:00:00.000Z"
}
```

**`ping`**
```json
{
  "type": "ping",
  "timestamp": "2024-01-18T10:00:00.000Z"
}
```

**`pong`**
```json
{
  "type": "pong",
  "timestamp": "2024-01-18T10:00:00.000Z"
}
```

### Usage Tracking Events

**`usage-updated`**
```json
{
  "type": "usage-updated",
  "usage": {
    "input_tokens": 15234,
    "output_tokens": 8721,
    "cache_creation_input_tokens": 2000,
    "cache_read_input_tokens": 50000,
    "cost_usd": 0.25
  },
  "timestamp": "2024-01-18T10:00:00.000Z"
}
```

### Security Events

**`security-ip-blocked`**
```json
{
  "type": "security-ip-blocked",
  "ip": "192.168.1.100",
  "attempts": 5,
  "timestamp": "2024-01-18T10:00:00.000Z"
}
```

**`security-alert`**
```json
{
  "type": "security-alert",
  "alertType": "multiple_failed_attempts",
  "distinctIPs": 3,
  "totalAttempts": 12,
  "lockdownActivated": false,
  "timestamp": "2024-01-18T10:00:00.000Z"
}
```

**`global-lockdown`**
```json
{
  "type": "global-lockdown",
  "reason": "Too many failed authentication attempts from multiple IPs",
  "message": "Le serveur est en mode verrouillage. Seules les sessions deja authentifiees restent actives.",
  "timestamp": "2024-01-18T10:00:00.000Z"
}
```

**`security-login-failed`**
```json
{
  "type": "security-login-failed",
  "ip": "192.168.1.100",
  "attemptsRemaining": 3,
  "timestamp": "2024-01-18T10:00:00.000Z"
}
```

### Command Injection Events

**`injection-started`**
```json
{
  "type": "injection-started",
  "sessionId": "1737025200000-abc123",
  "command": "What is the capital of France?",
  "timestamp": "2024-01-18T10:00:00.000Z"
}
```

**`injection-success`**
```json
{
  "type": "injection-success",
  "sessionId": "1737025200000-abc123",
  "command": "What is the capital of France?",
  "method": "CDP.Input.insertText",
  "duration": 245,
  "timestamp": "2024-01-18T10:00:00.500Z"
}
```

**`injection-failed`**
```json
{
  "type": "injection-failed",
  "sessionId": "1737025200000-abc123",
  "command": "What is the capital of France?",
  "method": "CDP.Input.insertText",
  "error": "Timeout waiting for response",
  "duration": 5000,
  "timestamp": "2024-01-18T10:00:05.000Z"
}
```

**`injection-error`**
```json
{
  "type": "injection-error",
  "sessionId": "1737025200000-abc123",
  "command": "What is the capital of France?",
  "error": "CDP connection lost",
  "timestamp": "2024-01-18T10:00:00.100Z"
}
```

**`command-queued`**
```json
{
  "type": "command-queued",
  "sessionId": "1737025200000-abc123",
  "item": {
    "command": "What is the capital of France?",
    "priority": "normal",
    "timestamp": "2024-01-18T10:00:00.000Z"
  },
  "timestamp": "2024-01-18T10:00:00.000Z"
}
```

**`message-injected`**
```json
{
  "type": "message-injected",
  "sessionId": "1737025200000-abc123",
  "messageId": "msg_abc123",
  "timestamp": "2024-01-18T10:00:00.500Z"
}
```

### CDP Monitoring Events

**`cdp-connections-detected`**
```json
{
  "type": "cdp-connections-detected",
  "count": 2,
  "connections": [
    {
      "pid": 12345,
      "port": 9222,
      "url": "http://localhost:9222/json"
    },
    {
      "pid": 12346,
      "port": 9223,
      "url": "http://localhost:9223/json"
    }
  ],
  "timestamp": "2024-01-18T10:00:00.000Z"
}
```

**`cdp-connection-count-changed`**
```json
{
  "type": "cdp-connection-count-changed",
  "previous": 1,
  "current": 2,
  "connections": [
    {
      "pid": 12345,
      "port": 9222,
      "url": "http://localhost:9222/json"
    },
    {
      "pid": 12346,
      "port": 9223,
      "url": "http://localhost:9223/json"
    }
  ],
  "timestamp": "2024-01-18T10:00:00.000Z"
}
```

**`cdp-new-connection`**
```json
{
  "type": "cdp-new-connection",
  "count": 2,
  "connections": [
    {
      "pid": 12346,
      "port": 9223,
      "url": "http://localhost:9223/json"
    }
  ],
  "timestamp": "2024-01-18T10:00:00.000Z"
}
```

**`cdp-session-switched`**
```json
{
  "type": "cdp-session-switched",
  "sessionId": "1737025200000-new",
  "previousSessionId": "1737025200000-old",
  "timestamp": "2024-01-18T10:00:00.000Z"
}
```

**`cdp-permission-responded`**
```json
{
  "type": "cdp-permission-responded",
  "requestId": "perm_abc123",
  "decision": "once",
  "timestamp": "2024-01-18T10:00:00.000Z"
}
```

**`cdp-question-answered`**
```json
{
  "type": "cdp-question-answered",
  "questionId": "question_abc123",
  "answer": "User's response to the question",
  "timestamp": "2024-01-18T10:00:00.000Z"
}
```

### Orchestrator Events

**`orchestrator:created`**
```json
{
  "type": "orchestrator:created",
  "data": {
    "id": "orch_abc123",
    "templateId": "code-review",
    "status": "created",
    "createdAt": "2024-01-18T10:00:00.000Z"
  },
  "timestamp": "2024-01-18T10:00:00.000Z"
}
```

**`orchestrator:started`**
```json
{
  "type": "orchestrator:started",
  "data": {
    "id": "orch_abc123",
    "status": "running",
    "currentPhase": "analysis"
  },
  "timestamp": "2024-01-18T10:00:01.000Z"
}
```

**`orchestrator:phaseChanged`**
```json
{
  "type": "orchestrator:phaseChanged",
  "data": {
    "id": "orch_abc123",
    "currentPhase": "execution",
    "previousPhase": "analysis"
  },
  "timestamp": "2024-01-18T10:00:30.000Z"
}
```

**`orchestrator:analysisComplete`**
```json
{
  "type": "orchestrator:analysisComplete",
  "data": {
    "id": "orch_abc123",
    "analysis": {
      "summary": "Code review analysis complete",
      "findings": 5
    }
  },
  "timestamp": "2024-01-18T10:00:30.000Z"
}
```

**`orchestrator:tasksReady`**
```json
{
  "type": "orchestrator:tasksReady",
  "data": {
    "id": "orch_abc123",
    "taskCount": 5,
    "tasks": [
      {
        "id": "task_1",
        "description": "Review authentication logic",
        "priority": "high"
      }
    ]
  },
  "timestamp": "2024-01-18T10:00:35.000Z"
}
```

**`orchestrator:progress`**
```json
{
  "type": "orchestrator:progress",
  "data": {
    "id": "orch_abc123",
    "progress": 0.4,
    "completedTasks": 2,
    "totalTasks": 5,
    "currentTask": "Review database queries"
  },
  "timestamp": "2024-01-18T10:02:00.000Z"
}
```

**`orchestrator:completed`**
```json
{
  "type": "orchestrator:completed",
  "data": {
    "id": "orch_abc123",
    "status": "completed",
    "results": {
      "summary": "Code review complete",
      "issuesFound": 3,
      "improvements": 2
    },
    "duration": 300000
  },
  "timestamp": "2024-01-18T10:05:00.000Z"
}
```

**`orchestrator:error`**
```json
{
  "type": "orchestrator:error",
  "data": {
    "id": "orch_abc123",
    "error": "Worker timeout on task_3",
    "status": "error"
  },
  "timestamp": "2024-01-18T10:03:00.000Z"
}
```

**`orchestrator:cancelled`**
```json
{
  "type": "orchestrator:cancelled",
  "data": {
    "id": "orch_abc123",
    "status": "cancelled",
    "reason": "User requested cancellation"
  },
  "timestamp": "2024-01-18T10:02:30.000Z"
}
```

### Worker Events

**`worker:spawned`**
```json
{
  "type": "worker:spawned",
  "data": {
    "taskId": "task_1",
    "sessionId": "1737025200000-worker1",
    "orchestratorId": "orch_abc123"
  },
  "timestamp": "2024-01-18T10:01:00.000Z"
}
```

**`worker:progress`**
```json
{
  "type": "worker:progress",
  "data": {
    "taskId": "task_1",
    "sessionId": "1737025200000-worker1",
    "progress": 0.5,
    "status": "Processing authentication module"
  },
  "timestamp": "2024-01-18T10:01:30.000Z"
}
```

**`worker:completed`**
```json
{
  "type": "worker:completed",
  "data": {
    "taskId": "task_1",
    "sessionId": "1737025200000-worker1",
    "result": {
      "summary": "Authentication review complete",
      "findings": ["Use bcrypt instead of md5", "Add rate limiting"]
    },
    "duration": 60000
  },
  "timestamp": "2024-01-18T10:02:00.000Z"
}
```

**`worker:failed`**
```json
{
  "type": "worker:failed",
  "data": {
    "taskId": "task_1",
    "sessionId": "1737025200000-worker1",
    "error": "Failed to parse code file",
    "duration": 30000
  },
  "timestamp": "2024-01-18T10:01:30.000Z"
}
```

**`worker:timeout`**
```json
{
  "type": "worker:timeout",
  "data": {
    "taskId": "task_1",
    "sessionId": "1737025200000-worker1",
    "timeoutMs": 300000
  },
  "timestamp": "2024-01-18T10:06:00.000Z"
}
```

**`worker:cancelled`**
```json
{
  "type": "worker:cancelled",
  "data": {
    "taskId": "task_1",
    "sessionId": "1737025200000-worker1",
    "reason": "Orchestrator cancelled"
  },
  "timestamp": "2024-01-18T10:02:00.000Z"
}
```

### SubSession Events

**`subsession:registered`**
```json
{
  "type": "subsession:registered",
  "data": {
    "childSessionId": "1737025200000-child",
    "parentSessionId": "1737025200000-parent",
    "purpose": "Analyze database schema"
  },
  "timestamp": "2024-01-18T10:00:00.000Z"
}
```

**`subsession:statusChanged`**
```json
{
  "type": "subsession:statusChanged",
  "data": {
    "childSessionId": "1737025200000-child",
    "parentSessionId": "1737025200000-parent",
    "previousStatus": "idle",
    "newStatus": "thinking"
  },
  "timestamp": "2024-01-18T10:00:05.000Z"
}
```

**`subsession:activity`**
```json
{
  "type": "subsession:activity",
  "data": {
    "childSessionId": "1737025200000-child",
    "parentSessionId": "1737025200000-parent",
    "activityType": "tool_use",
    "details": "Reading file schema.sql"
  },
  "timestamp": "2024-01-18T10:00:10.000Z"
}
```

**`subsession:resultReturned`**
```json
{
  "type": "subsession:resultReturned",
  "data": {
    "childSessionId": "1737025200000-child",
    "parentSessionId": "1737025200000-parent",
    "result": {
      "summary": "Schema analysis complete",
      "tables": 12,
      "relationships": 8
    }
  },
  "timestamp": "2024-01-18T10:01:00.000Z"
}
```

**`subsession:orphaned`**
```json
{
  "type": "subsession:orphaned",
  "data": {
    "childSessionId": "1737025200000-child",
    "parentSessionId": "1737025200000-parent",
    "reason": "Parent session closed"
  },
  "timestamp": "2024-01-18T10:01:30.000Z"
}
```

**`subsession:error`**
```json
{
  "type": "subsession:error",
  "data": {
    "childSessionId": "1737025200000-child",
    "parentSessionId": "1737025200000-parent",
    "error": "Failed to load schema file"
  },
  "timestamp": "2024-01-18T10:00:30.000Z"
}
```

**`subsession:archived`**
```json
{
  "type": "subsession:archived",
  "data": {
    "childSessionId": "1737025200000-child",
    "parentSessionId": "1737025200000-parent",
    "archivedAt": "2024-01-18T10:02:00.000Z"
  },
  "timestamp": "2024-01-18T10:02:00.000Z"
}
```

---

## WebSocket Server Configuration

### Server Setup Variables

| Variable | Value | Location | Description |
|----------|-------|----------|-------------|
| `WebSocket` | `require('ws')` | Line 6 (server.js) | WebSocket library import |
| `wss` | `new WebSocket.Server({ server })` | Line 3956 (server.js) | WebSocket server instance |
| `server` | HTTP/HTTPS server | Created earlier in server.js | HTTP server that WebSocket piggybacks on |
| `WS_HEARTBEAT_INTERVAL` | `30000` (30 seconds) | Line 4348 (server.js) | Interval for heartbeat checks |

### Server Creation

```javascript
// Line 3956 in backend/server.js
const wss = new WebSocket.Server({ server });
```

**Configuration options:**
- `server`: Attach to existing HTTP server (allows sharing port)
- No explicit `port` option (uses HTTP server's port)
- No `path` option (accepts connections on any path)
- No `verifyClient` option (manual authentication in connection handler)

### Heartbeat Configuration

```javascript
// Line 4348 in backend/server.js
const WS_HEARTBEAT_INTERVAL = 30000; // 30 seconds

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('Terminaison connexion WebSocket inactive');
      return ws.terminate();
    }

    ws.isAlive = false;
    try {
      ws.send(JSON.stringify({ type: 'ping', timestamp: new Date().toISOString() }));
    } catch (e) {
      // Ignore send errors
    }
  });
}, WS_HEARTBEAT_INTERVAL);
```

**Heartbeat parameters:**
- **Interval**: 30 seconds (30000ms)
- **Timeout detection**: 60 seconds (2 missed heartbeats)
- **Termination method**: `ws.terminate()` (forceful close)

---

## Client Connection State Management

### Client State Variables

| Variable | Type | Location | Description |
|----------|------|----------|-------------|
| `ws` | `WebSocket | null` | Line 14 (app.js) | WebSocket connection instance |
| `wsHeartbeatInterval` | `number | null` | Line 85 (app.js) | Heartbeat interval ID |
| `wsReconnectAttempts` | `number` | Line 86 (app.js) | Reconnection attempt counter |
| `sessionToken` | `string` | Line 25 (app.js) | Session authentication token |
| `isAuthenticated` | `boolean` | Line 35 (app.js) | Authentication status flag |
| `pinRequired` | `boolean` | Line 34 (app.js) | PIN authentication required flag |

### Client Configuration Constants

| Constant | Value | Location | Description |
|----------|-------|----------|-------------|
| `WS_PROTOCOL` | `'ws:' | 'wss:'` | Line 12 (app.js) | Protocol based on HTTPS detection |
| `WS_URL` | `` `${WS_PROTOCOL}//${window.location.host}` `` | Line 13 (app.js) | WebSocket server URL |
| `WS_HEARTBEAT_MS` | `30000` | Line 87 (app.js) | Client heartbeat interval (30s) |
| `WS_RECONNECT_DELAY_BASE` | `2000` | Line 88 (app.js) | Base delay for exponential backoff (2s) |

### WebSocket Ready States

The `ws.readyState` property has four possible values:

| State | Value | Description |
|-------|-------|-------------|
| `WebSocket.CONNECTING` | 0 | Connection is being established |
| `WebSocket.OPEN` | 1 | Connection is open and ready to communicate |
| `WebSocket.CLOSING` | 2 | Connection is in the process of closing |
| `WebSocket.CLOSED` | 3 | Connection is closed or couldn't be opened |

**Usage in code:**

```javascript
// Check if connection is open before sending
if (ws && ws.readyState === WebSocket.OPEN) {
  ws.send(JSON.stringify({ type: 'ping' }));
}

// Close connection if open or connecting
if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
  ws.close();
}
```

### Connection State Transitions

```
INITIAL STATE: ws = null
       ↓
[User logs in with PIN]
       ↓
connectWebSocket() called
       ↓
ws = new WebSocket(url)
ws.readyState = CONNECTING (0)
       ↓
[Handshake succeeds]
       ↓
ws.onopen triggered
ws.readyState = OPEN (1)
isAuthenticated = true
wsReconnectAttempts = 0
Start heartbeat
       ↓
[Network failure]
       ↓
ws.onclose triggered
ws.readyState = CLOSED (3)
Stop heartbeat
wsReconnectAttempts++
       ↓
[Wait backoff delay]
       ↓
connectWebSocket() called
       ↓
[Cycle repeats]
```

---

## Broadcasting Functions and Logic

### Primary Broadcasting Function

**Function:** `broadcastToClients(data)`
**Location:** Lines 3959-3965 (server.js)

```javascript
function broadcastToClients(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}
```

**Parameters:**
- `data` (Object): Event data to broadcast (will be JSON-serialized)

**Behavior:**
1. Iterates through all connected clients (`wss.clients` is a Set)
2. Checks if each client's connection is in OPEN state
3. Serializes data to JSON string
4. Sends to client via `client.send()`

**Return value:** None (void)

### Broadcasting Invocation Pattern

All event listeners follow the same pattern:

```javascript
eventEmitter.on('event-name', (eventData) => {
  console.log('[Module] Event occurred:', eventData);
  broadcastToClients({
    type: 'event-type',
    ...eventData,  // Spread event data
    timestamp: new Date().toISOString()  // Add timestamp
  });
});
```

**Example: Usage tracking**

```javascript
// Line 3970 (server.js)
usageTracker.on('usage-updated', (usage) => {
  broadcastToClients({
    type: 'usage-updated',
    usage: usage,
    timestamp: new Date().toISOString()
  });
});
```

**Example: Security event**

```javascript
// Line 3981 (server.js)
pinManager.on('ip-blocked', (data) => {
  console.log(`[SECURITE] IP bloquee: ${data.ip} apres ${data.attempts} tentatives`);
  broadcastToClients({
    type: 'security-ip-blocked',
    ip: data.ip,
    attempts: data.attempts,
    timestamp: new Date().toISOString()
  });
});
```

### Broadcasting Call Counts

The `broadcastToClients()` function is called from **50+ different event listeners** throughout server.js:

- 1x usage tracking
- 4x security events
- 5x command injection events
- 3x CDP monitoring events
- 11x orchestrator events
- 6x worker events
- 8x subsession events
- Plus others

**Performance note:** Each broadcast call iterates through all connected clients. With 100 clients and 50 events/second, that's 5000 send operations/second. Current implementation is acceptable for small deployments (<100 clients) but would need optimization (connection pooling, message batching) for larger scale.

---

## Heartbeat Timeout Values

### Server-Side Heartbeat

| Parameter | Value | Location | Description |
|-----------|-------|----------|-------------|
| `WS_HEARTBEAT_INTERVAL` | 30000ms (30s) | Line 4348 (server.js) | Interval between heartbeat checks |
| Ping interval | Every 30s | Line 4420 (server.js) | How often server sends ping |
| Timeout detection | 60s (2 intervals) | Calculated | Time to detect dead connection |
| Termination method | `ws.terminate()` | Line 4424 (server.js) | Forceful close (no handshake) |

**Timeout calculation:**

```
T+0s:    ws.isAlive = true (connection established)
T+30s:   Heartbeat check
         ws.isAlive = false (assume dead)
         Send ping
T+30.1s: Client receives ping, sends pong
         ws.isAlive = true (confirmed alive)

--- FAILURE SCENARIO ---
T+0s:    ws.isAlive = true
T+30s:   Heartbeat check
         ws.isAlive = false
         Send ping (no response - network failure)
T+60s:   Heartbeat check
         ws.isAlive === false (still no response)
         ws.terminate() → Connection closed
```

**Maximum detection time:** 60 seconds (2 full heartbeat intervals)

### Client-Side Heartbeat

| Parameter | Value | Location | Description |
|-----------|-------|----------|-------------|
| `WS_HEARTBEAT_MS` | 30000ms (30s) | Line 87 (app.js) | Interval between client pings |
| Ping interval | Every 30s | Line 224 (app.js) | How often client sends ping |
| No explicit timeout | N/A | N/A | Client relies on `onclose` event |

**Client heartbeat logic:**

```javascript
// Line 223 (app.js)
function startHeartbeat() {
  wsHeartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, WS_HEARTBEAT_MS);
}
```

**Client doesn't implement timeout detection** - it just sends pings. If the server doesn't respond, the browser's WebSocket implementation will eventually trigger `onclose` event (browser-dependent timeout, usually 60-120 seconds).

### Heartbeat Synchronization

Both client and server send pings every 30 seconds, but they're **not synchronized** (they start at different times):

```
Server heartbeat: T+0, T+30, T+60, T+90...
Client heartbeat: T+5, T+35, T+65, T+95... (example)
```

This is **intentional** - it provides redundancy. If one side's ping mechanism fails, the other side will still detect the failure.

---

## Reconnection Backoff Algorithm

### Exponential Backoff Formula

```
delay = min(BASE * MULTIPLIER^attempts, MAX)
```

**Parameters:**
- `BASE = 2000ms` (WS_RECONNECT_DELAY_BASE)
- `MULTIPLIER = 1.5`
- `MAX = 30000ms` (30 seconds)
- `attempts` starts at 1 and increments on each failed connection

**Implementation (line 215 in app.js):**

```javascript
const delay = Math.min(WS_RECONNECT_DELAY_BASE * Math.pow(1.5, wsReconnectAttempts), 30000);
```

### Delay Progression Table

| Attempt | Calculation | Computed Delay | Actual Delay | Notes |
|---------|-------------|----------------|--------------|-------|
| 1 | 2000 * 1.5¹ | 3000ms | 3s | First reconnection attempt |
| 2 | 2000 * 1.5² | 4500ms | 4.5s | |
| 3 | 2000 * 1.5³ | 6750ms | 6.75s | |
| 4 | 2000 * 1.5⁴ | 10125ms | 10.125s | |
| 5 | 2000 * 1.5⁵ | 15187.5ms | 15.2s | |
| 6 | 2000 * 1.5⁶ | 22781.25ms | 22.8s | |
| 7 | 2000 * 1.5⁷ | 34171.875ms | **30s** | Capped at max |
| 8 | 2000 * 1.5⁸ | 51257.8ms | **30s** | Capped at max |
| 9+ | 2000 * 1.5ⁿ | >30000ms | **30s** | All subsequent attempts |

### Backoff Reset Conditions

The reconnection counter is reset to 0 when:

1. **Connection succeeds** (line 168 in app.js)
   ```javascript
   ws.onopen = () => {
     wsReconnectAttempts = 0;  // Reset on successful connection
     // ...
   };
   ```

2. **User logs out** (counter implicitly reset when session is cleared)

3. **User manually refreshes page** (all state is reset)

**Not reset on:**
- Server-initiated `shutdown` event (client will reconnect with backoff)
- Authentication failure (connection closes, backoff continues)
- Network errors (backoff continues)

### Backoff Termination Conditions

Reconnection attempts will **stop** (not just pause) when:

1. **PIN required but not authenticated** (line 137 in app.js)
   ```javascript
   if (pinRequired && !isAuthenticated) {
     console.log('[WebSocket] Connexion bloquée - authentification PIN requise');
     return;  // Exit without scheduling reconnection
   }
   ```

2. **Page is unloaded** (beforeunload event closes connection, no reconnection scheduled)

**Reconnection will resume** after user re-authenticates via PIN.

### Example Reconnection Timeline

**Scenario: Server restarts, client reconnects**

```
T+0s:     Server goes down
          ws.onclose triggered
          wsReconnectAttempts = 1
          delay = 3000ms
          setTimeout(connectWebSocket, 3000)

T+3s:     connectWebSocket() called
          new WebSocket(...) → Connection fails (server still down)
          ws.onclose triggered
          wsReconnectAttempts = 2
          delay = 4500ms
          setTimeout(connectWebSocket, 4500)

T+7.5s:   connectWebSocket() called
          new WebSocket(...) → Connection fails
          wsReconnectAttempts = 3
          delay = 6750ms
          setTimeout(connectWebSocket, 6750)

T+14.25s: connectWebSocket() called
          new WebSocket(...) → Connection succeeds (server is back)
          ws.onopen triggered
          wsReconnectAttempts = 0 (reset)
          Heartbeat started
          Data reloaded

Total downtime experienced by user: ~14 seconds
```

---

## Error Types and Handling

### Server-Side Error Types

#### WebSocket Client Errors

**Error handler:** `ws.on('error', ...)` (line 4397 in server.js)

**Common error codes:**

| Error Code | Description | Cause | Handling |
|------------|-------------|-------|----------|
| `ECONNRESET` | Connection reset by peer | Client crashed, network failure | Logged, connection auto-closed |
| `EPIPE` | Broken pipe | Tried to write to closed socket | Logged, ignored (connection dead) |
| `ETIMEDOUT` | Connection timeout | Network slowness, client unresponsive | Logged, connection terminated |
| `EHOSTUNREACH` | Host unreachable | Client network down | Logged, connection terminated |

**Handler implementation:**

```javascript
ws.on('error', (error) => {
  console.error('Erreur WebSocket client:', error.message);
  // No action needed - ws library handles cleanup
});
```

**Error propagation:** Errors are logged but do NOT crash the server. The ws library handles cleanup automatically.

#### Authentication Errors

**Error type:** Unauthorized connection attempt

**Handler:** Connection handshake (line 4358 in server.js)

```javascript
if (pinManager.isPinEnabled()) {
  if (!token || !pinManager.isSessionValid(token, ip)) {
    console.log(`[WebSocket] Rejected connection from ${ip} - invalid or missing token`);
    ws.close(4001, 'Unauthorized - Invalid or missing session token');
    return;
  }
}
```

**Close codes:**
- `4001`: Custom close code for unauthorized connection
- Message: "Unauthorized - Invalid or missing session token"

**Client handling:** Client receives close event with code 4001, does not attempt immediate reconnection if PIN is required but not authenticated.

#### Heartbeat Send Errors

**Error handler:** try-catch in heartbeat loop (line 4429 in server.js)

```javascript
try {
  ws.send(JSON.stringify({ type: 'ping', timestamp: new Date().toISOString() }));
} catch (e) {
  // Ignore send errors (connection already dead)
}
```

**Reason for ignoring:** If `send()` throws an error, the connection is already broken. The next heartbeat cycle will detect `isAlive === false` and terminate the connection.

### Client-Side Error Types

#### WebSocket Connection Errors

**Error handler:** `ws.onerror` (line 198 in app.js)

```javascript
ws.onerror = (error) => {
  console.error('Erreur WebSocket:', error);
  updateStatus(false);
};
```

**Browser limitation:** The browser's WebSocket API doesn't provide detailed error information in the `onerror` event for security reasons. The error is typically just an `Event` object with minimal details.

**Common causes:**
- Network failure (no internet connection)
- Server unreachable (server down, firewall blocking)
- DNS resolution failure
- SSL/TLS errors (for wss://)

**Handling:** Update UI to show "Disconnected", wait for `onclose` event to trigger reconnection.

#### Close Events

**Handler:** `ws.onclose` (line 203 in app.js)

**WebSocket close codes:**

| Code | Name | Description | Client Action |
|------|------|-------------|---------------|
| 1000 | Normal Closure | Graceful close | Attempt reconnection (could be server restart) |
| 1001 | Going Away | Server shutting down or client navigating away | Attempt reconnection with backoff |
| 1006 | Abnormal Closure | Connection lost without close frame | Attempt reconnection (network failure) |
| 4001 | Unauthorized (custom) | Authentication failed | Do not reconnect until re-authenticated |

**Handler implementation:**

```javascript
ws.onclose = () => {
  console.log('WebSocket déconnecté');
  updateStatus(false);

  // Stop heartbeat
  if (wsHeartbeatInterval) {
    clearInterval(wsHeartbeatInterval);
    wsHeartbeatInterval = null;
  }

  // Reconnection with exponential backoff
  wsReconnectAttempts++;
  const delay = Math.min(WS_RECONNECT_DELAY_BASE * Math.pow(1.5, wsReconnectAttempts), 30000);
  console.log(`Reconnexion dans ${delay}ms (tentative ${wsReconnectAttempts})`);

  showReconnectingStatus();
  setTimeout(connectWebSocket, delay);
};
```

**Note:** The handler doesn't check close code to determine if reconnection should occur. Instead, the `connectWebSocket()` function checks authentication status and blocks reconnection if not authenticated.

#### Message Parsing Errors

**Error handler:** try-catch in `ws.onmessage` (line 193 in app.js)

```javascript
ws.onmessage = (event) => {
  try {
    const data = JSON.parse(event.data);
    // ... handle message
  } catch (e) {
    console.error('Erreur de parsing WebSocket:', e);
  }
};
```

**Cause:** Server sends invalid JSON (should never happen in production)

**Handling:** Log error and skip the message. Connection remains open.

#### API Authentication Errors

**Error handler:** API response 401 detection (line 842 in app.js)

```javascript
if (response.status === 401 && pinRequired) {
  console.warn('[API] 401 Unauthorized - session invalide ou expiree');
  isAuthenticated = false;
  ws?.close();  // Close WebSocket to prevent reconnection loop
  sessionToken = '';
  localStorage.removeItem('sessionToken');
  showPINModal();
  throw new Error('Session expired. Please login again.');
}
```

**Trigger:** Any REST API call returns 401 (session expired)

**Handling:**
1. Mark as unauthenticated
2. **Close WebSocket** (prevents reconnection with invalid token)
3. Clear session token
4. Show PIN modal for re-authentication

### Error Recovery Strategies

| Error Type | Recovery Strategy | Automatic? |
|------------|-------------------|------------|
| Network failure | Exponential backoff reconnection | Yes |
| Server shutdown | Reconnection after backoff | Yes |
| Authentication failure | Block reconnection until re-auth | Requires user action |
| Session expiration | Show PIN modal, wait for re-login | Requires user action |
| Message parsing error | Skip message, continue | Yes |
| Heartbeat timeout | Terminate connection, trigger reconnection | Yes |

---

## TODO Comments

**Found TODO comment in app.js:**

```javascript
// Line 4335 (app.js)
// TODO: Open template manager modal
```

**Context:** This TODO is in a button click handler for managing orchestrator templates. The template manager modal is not yet implemented.

**No TODO comments found in WebSocket-related code** (backend/server.js WebSocket sections or app.js WebSocket functions).

---

## Summary Statistics

### Event Count
- **Total server→client events:** 44 distinct event types
- **Total client→server events:** 2 event types (ping, pong)
- **Obsolete events:** 7 (commented out in client code)

### Code Locations

**Server-side (backend/server.js):**
- WebSocket server creation: Line 3956
- Broadcasting function: Lines 3959-3965
- Event listeners: Lines 3970-4345 (375 lines)
- Connection handler: Lines 4350-4417 (67 lines)
- Heartbeat loop: Lines 4419-4435 (16 lines)
- Shutdown handler: Lines 4438-4489 (51 lines)

**Client-side (public/app.js):**
- WebSocket configuration: Lines 12-13
- State variables: Lines 14, 25, 34-35, 85-88
- Connection function: Lines 135-221 (86 lines)
- Heartbeat function: Lines 223-229 (6 lines)
- Message handler: Lines 418-548 (130 lines)
- Event-specific handlers: Scattered throughout 5600+ line file

### Performance Characteristics

**Server:**
- Heartbeat overhead: ~100 clients × 1 ping/30s = ~3 pings/second
- Broadcasting overhead: O(N) where N = number of clients
- Memory per connection: ~1KB (ws object + isAlive flag)

**Client:**
- Heartbeat overhead: 1 ping/30s = 0.033 pings/second
- Message processing: Single-threaded, ~1ms per message
- Reconnection backoff: Max 30s delay, prevents network spam

---

## Integration Points

### Backend Modules Integrated with WebSocket

1. **usageTracker**: Token usage updates
2. **pinManager**: Security events (IP blocks, alerts, lockdown)
3. **commandInjector**: Command injection lifecycle events
4. **cdpMonitor**: CDP connection monitoring
5. **cdpController**: Session switching, permission responses
6. **orchestratorModule**: Task orchestration events (40+ event types)

### Frontend Integration Points

1. **Authentication system**: PIN login, session management
2. **Session monitoring**: Real-time session updates
3. **Permission handling**: Permission request notifications
4. **Orchestrator dashboard**: Task progress visualization
5. **Usage widget**: Token usage display
6. **Security alerts**: Real-time security notifications

---

## Security Considerations

### Authentication Security
- Session tokens passed via URL query parameter (visible in logs)
- IP address binding prevents token theft
- Token validation on every connection attempt
- Forced token clearing on page load (prevents stale tokens)

### Information Disclosure Protection
- Unauthenticated clients only receive security events
- All other events blocked until authentication
- No sensitive data in event payloads without authentication check

### Denial of Service Protection
- Exponential backoff prevents reconnection spam
- Heartbeat mechanism detects and terminates dead connections
- Maximum reconnection delay caps resource usage

### Future Security Enhancements
1. Rate limiting on WebSocket connections per IP
2. Token rotation (refresh tokens)
3. Event filtering based on user permissions (not just authenticated/unauthenticated)
4. Message signing/verification to prevent event spoofing

---

**END OF DOCUMENTATION**

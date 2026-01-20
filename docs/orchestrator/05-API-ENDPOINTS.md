# API Endpoints Specification

## Base URL

All orchestrator endpoints are prefixed with `/api/orchestrator`.

## Authentication

All endpoints require authentication via `authMiddleware` (same as existing endpoints).

---

## Template Endpoints

### GET /api/orchestrator/templates

List all available templates.

**Response:**
```json
{
  "success": true,
  "templates": [
    {
      "id": "documentation",
      "name": "Documentation Generator",
      "description": "Generate structured documentation for a project",
      "icon": "book",
      "author": "system",
      "isSystem": true,
      "tags": ["documentation", "analysis"]
    },
    {
      "id": "my-custom-template",
      "name": "My Custom Workflow",
      "description": "Custom workflow for...",
      "icon": "cog",
      "author": "user",
      "isSystem": false,
      "tags": []
    }
  ],
  "timestamp": "2025-01-18T..."
}
```

---

### GET /api/orchestrator/templates/:id

Get full template details.

**Parameters:**
- `id` (path): Template ID

**Query:**
- `resolved` (boolean, default: true): Include resolved inheritance

**Response:**
```json
{
  "success": true,
  "template": {
    "id": "documentation",
    "name": "Documentation Generator",
    "extends": "_default",
    "config": { ... },
    "phases": { ... },
    "prompts": { ... },
    "variables": { ... },
    "ui": { ... }
  },
  "timestamp": "2025-01-18T..."
}
```

**Errors:**
- `404`: Template not found

---

### POST /api/orchestrator/templates

Create new custom template.

**Request Body:**
```json
{
  "name": "My New Template",
  "description": "What this template does",
  "extends": "_default",
  "icon": "star",
  "config": { ... },
  "phases": { ... },
  "prompts": { ... },
  "variables": { ... }
}
```

**Response:**
```json
{
  "success": true,
  "template": {
    "id": "my-new-template",
    ...
  },
  "timestamp": "2025-01-18T..."
}
```

**Errors:**
- `400`: Validation error (invalid schema)
- `409`: Template ID already exists

---

### PUT /api/orchestrator/templates/:id

Update custom template.

**Parameters:**
- `id` (path): Template ID

**Request Body:**
```json
{
  "name": "Updated Name",
  "config": { ... },
  ...
}
```

**Response:**
```json
{
  "success": true,
  "template": { ... },
  "timestamp": "2025-01-18T..."
}
```

**Errors:**
- `400`: Validation error
- `403`: Cannot modify system template
- `404`: Template not found

---

### DELETE /api/orchestrator/templates/:id

Delete custom template.

**Parameters:**
- `id` (path): Template ID

**Response:**
```json
{
  "success": true,
  "message": "Template deleted",
  "timestamp": "2025-01-18T..."
}
```

**Errors:**
- `403`: Cannot delete system template
- `404`: Template not found

---

### POST /api/orchestrator/templates/:id/duplicate

Duplicate template to custom folder.

**Parameters:**
- `id` (path): Source template ID

**Request Body:**
```json
{
  "name": "Copy of Documentation"
}
```

**Response:**
```json
{
  "success": true,
  "template": {
    "id": "copy-of-documentation",
    "name": "Copy of Documentation",
    ...
  },
  "timestamp": "2025-01-18T..."
}
```

---

### POST /api/orchestrator/templates/import

Import template from JSON.

**Request Body:**
```json
{
  "template": { ... }
}
```

**Response:**
```json
{
  "success": true,
  "template": { ... },
  "timestamp": "2025-01-18T..."
}
```

---

### GET /api/orchestrator/templates/export

Export all custom templates as JSON.

**Response:**
```json
{
  "success": true,
  "templates": [ ... ],
  "exportedAt": "2025-01-18T..."
}
```

---

## Orchestrator Endpoints

### POST /api/orchestrator/create

Create new orchestrator session.

**Request Body:**
```json
{
  "templateId": "documentation",
  "cwd": "/path/to/project",
  "message": "Create documentation for this project",
  "customVariables": {
    "OUTPUT_FORMAT": "markdown",
    "LANGUAGE": "french"
  },
  "options": {
    "autoSpawn": false,
    "maxWorkers": 5
  }
}
```

**Response:**
```json
{
  "success": true,
  "orchestrator": {
    "id": "orch_abc123",
    "templateId": "documentation",
    "mainSessionId": "local_xyz789",
    "status": "created",
    "currentPhase": null,
    "createdAt": "2025-01-18T..."
  },
  "timestamp": "2025-01-18T..."
}
```

**Errors:**
- `400`: Missing required fields
- `404`: Template not found

---

### GET /api/orchestrator/:id

Get orchestrator details.

**Parameters:**
- `id` (path): Orchestrator ID

**Response:**
```json
{
  "success": true,
  "orchestrator": {
    "id": "orch_abc123",
    "templateId": "documentation",
    "mainSessionId": "local_xyz789",
    "status": "running",
    "currentPhase": "workerExecution",

    "analysis": {
      "summary": "Found 5 modules to document",
      "recommended_splits": 5
    },

    "tasks": [
      { "id": "task_001", "title": "API Docs", ... },
      { "id": "task_002", "title": "WebSocket Docs", ... }
    ],

    "workers": {
      "task_001": { "sessionId": "local___orch_...", "status": "completed", "progress": 100 },
      "task_002": { "sessionId": "local___orch_...", "status": "running", "progress": 45 }
    },

    "stats": {
      "totalTools": 156,
      "reads": 89,
      "edits": 34,
      "writes": 12
    },

    "createdAt": "2025-01-18T...",
    "startedAt": "2025-01-18T...",
    "completedAt": null
  },
  "timestamp": "2025-01-18T..."
}
```

**Errors:**
- `404`: Orchestrator not found

---

### GET /api/orchestrator/:id/status

Get orchestrator status summary (lightweight).

**Parameters:**
- `id` (path): Orchestrator ID

**Response:**
```json
{
  "success": true,
  "status": {
    "id": "orch_abc123",
    "status": "running",
    "phase": "workerExecution",
    "progress": {
      "total": 5,
      "completed": 2,
      "running": 2,
      "pending": 1,
      "percent": 40
    },
    "stats": {
      "totalTools": 156
    }
  },
  "timestamp": "2025-01-18T..."
}
```

---

### POST /api/orchestrator/:id/start

Start orchestration (begin analysis phase).

**Parameters:**
- `id` (path): Orchestrator ID

**Response:**
```json
{
  "success": true,
  "message": "Orchestration started",
  "status": "analyzing",
  "timestamp": "2025-01-18T..."
}
```

**Errors:**
- `400`: Already started
- `404`: Orchestrator not found

---

### POST /api/orchestrator/:id/confirm-tasks

Confirm task list and spawn workers.

**Parameters:**
- `id` (path): Orchestrator ID

**Request Body (optional):**
```json
{
  "modifications": {
    "task_001": { "skip": true },
    "task_002": { "priority": 1 }
  }
}
```

**Response:**
```json
{
  "success": true,
  "message": "Workers spawned",
  "workersCreated": 5,
  "timestamp": "2025-01-18T..."
}
```

---

### POST /api/orchestrator/:id/pause

Pause orchestrator.

**Parameters:**
- `id` (path): Orchestrator ID

**Response:**
```json
{
  "success": true,
  "message": "Orchestrator paused",
  "pausedWorkers": 3,
  "timestamp": "2025-01-18T..."
}
```

---

### POST /api/orchestrator/:id/resume

Resume paused orchestrator.

**Parameters:**
- `id` (path): Orchestrator ID

**Response:**
```json
{
  "success": true,
  "message": "Orchestrator resumed",
  "timestamp": "2025-01-18T..."
}
```

---

### POST /api/orchestrator/:id/cancel

Cancel orchestrator and cleanup.

**Parameters:**
- `id` (path): Orchestrator ID

**Request Body (optional):**
```json
{
  "archiveWorkers": true,
  "deleteWorkers": false
}
```

**Response:**
```json
{
  "success": true,
  "message": "Orchestrator cancelled",
  "cleanedUp": {
    "workers": 5,
    "archived": true
  },
  "timestamp": "2025-01-18T..."
}
```

---

## Worker Endpoints

### GET /api/orchestrator/:id/workers

List all workers for orchestrator.

**Parameters:**
- `id` (path): Orchestrator ID

**Query:**
- `status` (string): Filter by status

**Response:**
```json
{
  "success": true,
  "workers": [
    {
      "taskId": "task_001",
      "sessionId": "local___orch_abc123_worker_task_001",
      "status": "completed",
      "progress": 100,
      "toolStats": { "reads": 15, "edits": 3 },
      "startedAt": "2025-01-18T...",
      "completedAt": "2025-01-18T..."
    },
    {
      "taskId": "task_002",
      "sessionId": "local___orch_abc123_worker_task_002",
      "status": "running",
      "progress": 67,
      "currentAction": "Documenting endpoints...",
      "toolStats": { "reads": 8, "edits": 1 }
    }
  ],
  "timestamp": "2025-01-18T..."
}
```

---

### GET /api/orchestrator/:id/workers/:taskId

Get specific worker details.

**Parameters:**
- `id` (path): Orchestrator ID
- `taskId` (path): Task ID

**Response:**
```json
{
  "success": true,
  "worker": {
    "taskId": "task_001",
    "sessionId": "local___orch_abc123_worker_task_001",
    "task": {
      "title": "API Documentation",
      "description": "Document REST endpoints",
      "scope": ["backend/server.js:2400-2520"]
    },
    "status": "completed",
    "progress": 100,
    "output": "Generated API documentation...",
    "outputFiles": ["docs/api.md"],
    "toolStats": { ... },
    "startedAt": "2025-01-18T...",
    "completedAt": "2025-01-18T..."
  },
  "timestamp": "2025-01-18T..."
}
```

---

### POST /api/orchestrator/:id/workers/:taskId/retry

Retry failed worker.

**Parameters:**
- `id` (path): Orchestrator ID
- `taskId` (path): Task ID

**Response:**
```json
{
  "success": true,
  "message": "Worker retry started",
  "newSessionId": "local___orch_abc123_worker_task_001_r1",
  "timestamp": "2025-01-18T..."
}
```

---

### POST /api/orchestrator/:id/workers/:taskId/cancel

Cancel specific worker.

**Parameters:**
- `id` (path): Orchestrator ID
- `taskId` (path): Task ID

**Response:**
```json
{
  "success": true,
  "message": "Worker cancelled",
  "timestamp": "2025-01-18T..."
}
```

---

## WebSocket Events

In addition to REST endpoints, real-time updates are sent via WebSocket.

### Event Types

```javascript
// Orchestrator events
{
  type: 'orchestrator:created',
  data: { orchestratorId, templateId, mainSessionId }
}

{
  type: 'orchestrator:phaseChanged',
  data: { orchestratorId, previousPhase, currentPhase }
}

{
  type: 'orchestrator:analysisComplete',
  data: { orchestratorId, analysis }
}

{
  type: 'orchestrator:tasksReady',
  data: { orchestratorId, tasks, parallelGroups }
}

{
  type: 'orchestrator:progress',
  data: { orchestratorId, status, progress, stats }
}

{
  type: 'orchestrator:completed',
  data: { orchestratorId, summary, outputFiles }
}

{
  type: 'orchestrator:error',
  data: { orchestratorId, error, phase }
}

// Worker events
{
  type: 'worker:spawned',
  data: { orchestratorId, taskId, sessionId }
}

{
  type: 'worker:progress',
  data: { orchestratorId, taskId, progress, currentAction }
}

{
  type: 'worker:completed',
  data: { orchestratorId, taskId, status, summary }
}

{
  type: 'worker:failed',
  data: { orchestratorId, taskId, error }
}
```

### Subscribing to Updates

```javascript
// Client-side
ws.send(JSON.stringify({
  type: 'subscribe',
  channel: 'orchestrator',
  orchestratorId: 'orch_abc123'
}));

// Unsubscribe
ws.send(JSON.stringify({
  type: 'unsubscribe',
  channel: 'orchestrator',
  orchestratorId: 'orch_abc123'
}));
```

---

## Error Response Format

All error responses follow this format:

```json
{
  "success": false,
  "error": "Error type",
  "message": "Human-readable error message",
  "details": { ... },
  "timestamp": "2025-01-18T..."
}
```

### Common Error Codes

| HTTP Code | Error | Description |
|-----------|-------|-------------|
| 400 | ValidationError | Invalid request data |
| 403 | ForbiddenError | Action not allowed |
| 404 | NotFoundError | Resource not found |
| 409 | ConflictError | Resource already exists |
| 500 | InternalError | Server error |

---

## Rate Limiting

Orchestrator endpoints have specific rate limits:

| Endpoint | Limit |
|----------|-------|
| POST /create | 10/minute |
| GET /status | 60/minute |
| POST /confirm-tasks | 10/minute |
| Other endpoints | 30/minute |

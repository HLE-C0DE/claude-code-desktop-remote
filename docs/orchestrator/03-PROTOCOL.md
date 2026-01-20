# Communication Protocol Specification

## Overview

The orchestrator system uses a structured JSON protocol for communication between our server and Claude. This protocol allows us to:
- Detect when Claude has completed a phase
- Parse structured data from responses
- Track worker progress
- Handle errors gracefully

## Response Format

All orchestrator-related responses from Claude must use this format:

```
<<<ORCHESTRATOR_RESPONSE>>>
{
  "phase": "<phase_name>",
  "data": { ... }
}
<<<END_ORCHESTRATOR_RESPONSE>>>
```

### Delimiters

| Delimiter | Purpose |
|-----------|---------|
| `<<<ORCHESTRATOR_RESPONSE>>>` | Start of structured response |
| `<<<END_ORCHESTRATOR_RESPONSE>>>` | End of structured response |

These delimiters are:
- Unlikely to appear naturally in conversation
- Easy to detect with regex
- Allow Claude to add context before/after the structured part

### Example Valid Response

```
I've analyzed the codebase and found several components to document.

<<<ORCHESTRATOR_RESPONSE>>>
{
  "phase": "analysis",
  "data": {
    "summary": "Found 5 main modules",
    "recommended_splits": 5
  }
}
<<<END_ORCHESTRATOR_RESPONSE>>>

Let me know if you'd like me to proceed with the task breakdown.
```

## Phase Types

### 1. Analysis Phase

**Phase name:** `analysis`

**Purpose:** Initial codebase exploration and planning

**Required fields:**
- `summary` (string): Brief description of findings
- `recommended_splits` (number): Suggested number of parallel tasks

**Optional fields:**
- `key_files` (string[]): Important files identified
- `estimated_complexity` (string): "low" | "medium" | "high"
- `notes` (string): Additional observations
- `warnings` (string[]): Potential issues identified
- `components` (object[]): Structured component breakdown

**Example:**
```json
{
  "phase": "analysis",
  "data": {
    "summary": "The project is a Node.js backend with Express API and WebSocket support",
    "key_files": [
      "backend/server.js",
      "backend/cdp-controller.js",
      "public/app.js"
    ],
    "estimated_complexity": "high",
    "recommended_splits": 6,
    "components": [
      {"name": "REST API", "files": ["server.js:2400-2520"], "complexity": "medium"},
      {"name": "WebSocket", "files": ["server.js:2522-2600"], "complexity": "low"},
      {"name": "CDP Controller", "files": ["cdp-controller.js"], "complexity": "high"}
    ],
    "notes": "Heavy use of async/await, consider documenting error handling patterns"
  }
}
```

### 2. Task List Phase

**Phase name:** `task_list`

**Purpose:** Define parallel tasks for workers

**Required fields:**
- `tasks` (object[]): Array of task definitions

**Optional fields:**
- `total_tasks` (number): Task count
- `parallelizable_groups` (string[][]): Groups that can run in parallel
- `execution_order` (string[]): Suggested execution order

**Task object schema:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | string | Yes | Unique task identifier (e.g., "task_001") |
| title | string | Yes | Short task title |
| description | string | Yes | What the task should accomplish |
| scope | string[] | No | Files/paths this task should focus on |
| priority | number | No | 1-10, higher = more important |
| dependencies | string[] | No | Task IDs that must complete first |
| estimated_tokens | number | No | Estimated token usage |

**Example:**
```json
{
  "phase": "task_list",
  "data": {
    "total_tasks": 4,
    "tasks": [
      {
        "id": "task_001",
        "title": "REST API Documentation",
        "description": "Document all REST endpoints in server.js including request/response formats",
        "scope": ["backend/server.js:2400-2520"],
        "priority": 1,
        "dependencies": []
      },
      {
        "id": "task_002",
        "title": "WebSocket Documentation",
        "description": "Document WebSocket events and message formats",
        "scope": ["backend/server.js:2522-2600", "public/app.js:websocket"],
        "priority": 2,
        "dependencies": []
      },
      {
        "id": "task_003",
        "title": "CDP Integration Documentation",
        "description": "Document Chrome DevTools Protocol integration",
        "scope": ["backend/cdp-controller.js"],
        "priority": 1,
        "dependencies": []
      },
      {
        "id": "task_004",
        "title": "Integration Guide",
        "description": "Write guide showing how components work together",
        "scope": [],
        "priority": 3,
        "dependencies": ["task_001", "task_002", "task_003"]
      }
    ],
    "parallelizable_groups": [
      ["task_001", "task_002", "task_003"],
      ["task_004"]
    ]
  }
}
```

### 3. Progress Phase

**Phase name:** `progress`

**Purpose:** Report worker progress during execution

**Required fields:**
- `task_id` (string): ID of the task being executed
- `status` (string): Current status

**Optional fields:**
- `progress_percent` (number): 0-100 completion percentage
- `current_action` (string): What the worker is currently doing
- `files_processed` (number): Files completed
- `files_total` (number): Total files to process
- `output_preview` (string): Preview of generated content

**Status values:**
- `in_progress`: Task is being executed
- `blocked`: Task is waiting on something
- `retrying`: Retrying after an error

**Example:**
```json
{
  "phase": "progress",
  "data": {
    "task_id": "task_001",
    "status": "in_progress",
    "progress_percent": 60,
    "current_action": "Documenting /api/session endpoints",
    "files_processed": 3,
    "files_total": 5
  }
}
```

### 4. Completion Phase

**Phase name:** `completion`

**Purpose:** Report task completion (success or failure)

**Required fields:**
- `task_id` (string): ID of the completed task
- `status` (string): Final status

**Optional fields:**
- `summary` (string): What was accomplished
- `output_files` (string[]): Files created/modified
- `output` (string): Actual output content
- `error` (string): Error message if failed
- `warnings` (string[]): Non-fatal issues encountered
- `metrics` (object): Execution metrics

**Status values:**
- `success`: Task completed successfully
- `partial`: Task partially completed
- `failed`: Task failed
- `timeout`: Task timed out

**Example (success):**
```json
{
  "phase": "completion",
  "data": {
    "task_id": "task_001",
    "status": "success",
    "summary": "Documented 15 REST endpoints with request/response examples",
    "output_files": ["docs/api-rest.md"],
    "metrics": {
      "endpoints_documented": 15,
      "examples_created": 8
    }
  }
}
```

**Example (failure):**
```json
{
  "phase": "completion",
  "data": {
    "task_id": "task_002",
    "status": "failed",
    "error": "Could not find WebSocket implementation in specified files",
    "warnings": ["File server.js:2522-2600 does not contain WebSocket code"]
  }
}
```

### 5. Aggregation Phase

**Phase name:** `aggregation`

**Purpose:** Report merged results from all workers

**Required fields:**
- `status` (string): Aggregation status

**Optional fields:**
- `summary` (string): Summary of merged content
- `conflicts` (object[]): Detected conflicts
- `merged_output` (string): Final merged content
- `output_files` (string[]): Final output files

**Example:**
```json
{
  "phase": "aggregation",
  "data": {
    "status": "success",
    "summary": "Merged 4 documentation sections into unified docs",
    "conflicts": [
      {
        "type": "duplicate",
        "description": "Both task_001 and task_003 documented the /api/status endpoint",
        "resolution": "Kept version from task_001 as more complete"
      }
    ],
    "output_files": ["docs/README.md", "docs/api.md", "docs/architecture.md"]
  }
}
```

## Parsing Algorithm

```javascript
function parseOrchestratorResponse(text) {
  const START_DELIMITER = '<<<ORCHESTRATOR_RESPONSE>>>';
  const END_DELIMITER = '<<<END_ORCHESTRATOR_RESPONSE>>>';

  const startIndex = text.indexOf(START_DELIMITER);
  if (startIndex === -1) {
    return { found: false, raw: text };
  }

  const endIndex = text.indexOf(END_DELIMITER, startIndex);
  if (endIndex === -1) {
    return { found: false, error: 'Missing end delimiter', raw: text };
  }

  const jsonStart = startIndex + START_DELIMITER.length;
  const jsonContent = text.substring(jsonStart, endIndex).trim();

  try {
    const parsed = JSON.parse(jsonContent);

    // Validate required fields
    if (!parsed.phase) {
      return { found: true, error: 'Missing phase field', raw: jsonContent };
    }
    if (!parsed.data) {
      return { found: true, error: 'Missing data field', raw: jsonContent };
    }

    return {
      found: true,
      phase: parsed.phase,
      data: parsed.data,
      beforeText: text.substring(0, startIndex).trim(),
      afterText: text.substring(endIndex + END_DELIMITER.length).trim()
    };
  } catch (e) {
    return { found: true, error: `JSON parse error: ${e.message}`, raw: jsonContent };
  }
}
```

## Error Handling

### Missing Delimiters

If Claude doesn't follow the format:
1. Log the raw response
2. Attempt keyword detection fallback
3. If critical phase, retry with stricter prompt
4. After max retries, mark as error and notify user

### Invalid JSON

If JSON is malformed:
1. Attempt to fix common issues (trailing commas, unquoted keys)
2. If unfixable, retry request
3. Log for debugging

### Missing Required Fields

If required fields are missing:
1. Check if data is usable with available fields
2. If not, request clarification from Claude
3. Allow user to manually provide missing data

## Fallback Detection

When structured response isn't found, attempt keyword detection:

```javascript
const FALLBACK_PATTERNS = {
  analysis_complete: /(?:analysis|exploration)\s+(?:complete|done|finished)/i,
  tasks_ready: /(?:task\s+list|breakdown)\s+(?:ready|complete|created)/i,
  worker_done: /(?:task|work)\s+(?:complete|done|finished)/i,
  worker_error: /(?:error|failed|could\s+not)/i
};
```

## Rate Limiting Considerations

- Don't request progress updates too frequently (min 10s between requests)
- Batch multiple status checks when possible
- Cache responses for at least polling interval duration

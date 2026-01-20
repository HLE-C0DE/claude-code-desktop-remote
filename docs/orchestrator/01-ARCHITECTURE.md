# Architecture Overview

## System Flow

```
User Request
     │
     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           WEB INTERFACE                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  New Session Modal                                                   │    │
│  │  - Type: [Classic / Orchestrator]                                    │    │
│  │  - Template: [Documentation / Exploration / Custom...]               │    │
│  │  - Message: "Create documentation for this project..."              │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
     │
     │ POST /api/orchestrator/create
     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           BACKEND SERVER                                     │
│                                                                              │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐         │
│  │ TemplateManager │───▶│ OrchestratorMgr │───▶│  WorkerManager  │         │
│  │                 │    │                 │    │                 │         │
│  │ - Load template │    │ - Create orch   │    │ - Spawn workers │         │
│  │ - Validate      │    │ - Track state   │    │ - Monitor       │         │
│  │ - Merge configs │    │ - Phase control │    │ - Aggregate     │         │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘         │
│           │                      │                      │                   │
│           └──────────────────────┼──────────────────────┘                   │
│                                  │                                          │
│                                  ▼                                          │
│                        ┌─────────────────┐                                  │
│                        │ ResponseParser  │                                  │
│                        │                 │                                  │
│                        │ - Detect format │                                  │
│                        │ - Parse JSON    │                                  │
│                        │ - Validate      │                                  │
│                        └─────────────────┘                                  │
└─────────────────────────────────────────────────────────────────────────────┘
     │
     │ CDP Protocol (via cdp-controller.js)
     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CLAUDE DESKTOP                                       │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Main Session (Orchestrator)                                         │    │
│  │  - Receives injected orchestrator prompt                             │    │
│  │  - Analyzes with Task(Explore) tool                                  │    │
│  │  - Returns structured JSON responses                                 │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │  Worker 1   │  │  Worker 2   │  │  Worker 3   │  │  Worker N   │        │
│  │  (hidden)   │  │  (hidden)   │  │  (hidden)   │  │  (hidden)   │        │
│  │  Task: API  │  │  Task: WS   │  │  Task: UI   │  │  Task: ...  │        │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘        │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Orchestration Phases

### Phase 1: Analysis
```
User creates orchestrator session
         │
         ▼
Backend injects ANALYSIS prompt from template
         │
         ▼
Claude uses Task(Explore) to analyze codebase
         │
         ▼
Claude responds with <<<ORCHESTRATOR_RESPONSE>>>
{
  "phase": "analysis",
  "data": { summary, key_files, recommended_splits, ... }
}
<<<END_ORCHESTRATOR_RESPONSE>>>
         │
         ▼
ResponseParser detects and parses response
         │
         ▼
OrchestratorManager stores analysis, moves to Phase 2
```

### Phase 2: Task Planning
```
Backend sends TASK_PLANNING prompt
         │
         ▼
Claude creates task breakdown
         │
         ▼
Claude responds with task_list format
         │
         ▼
Backend validates tasks (min/max, dependencies)
         │
         ▼
OrchestratorManager stores tasks, moves to Phase 3
```

### Phase 3: Worker Execution
```
WorkerManager calculates parallelizable groups
         │
         ▼
For each group (respecting maxWorkers):
  ├─▶ Create hidden session with prefix "__orch_{id}_worker_{taskId}"
  ├─▶ Inject WORKER prompt with task details
  └─▶ Add to monitoring queue
         │
         ▼
Monitoring loop (every 2s):
  ├─▶ Poll transcript for each active worker
  ├─▶ Detect <<<ORCHESTRATOR_RESPONSE>>> progress/completion
  ├─▶ Update OrchestratorManager state
  ├─▶ Broadcast via WebSocket to UI
  └─▶ If worker complete → spawn next from queue
         │
         ▼
All workers complete → Phase 4
```

### Phase 4: Aggregation
```
WorkerManager collects all worker outputs
         │
         ▼
Backend sends AGGREGATION prompt to main session
         │
         ▼
Claude merges/reviews outputs
         │
         ▼
(Optional) Phase 5: Verification
         │
         ▼
Mark orchestrator as complete
Archive worker sessions
```

## State Management

### OrchestratorState
```javascript
{
  id: "orch_abc123",
  templateId: "documentation",
  mainSessionId: "local_xxx",
  status: "analyzing" | "planning" | "spawning" | "running" | "aggregating" | "verifying" | "completed" | "error",
  currentPhase: "analysis" | "taskPlanning" | "workerExecution" | "aggregation" | "verification",

  userRequest: "Original user message...",
  cwd: "/path/to/project",

  analysis: { /* parsed analysis data */ },
  tasks: [ /* parsed task list */ ],

  workers: Map<taskId, WorkerState>,

  stats: {
    totalTools: 0,
    reads: 0,
    writes: 0,
    edits: 0,
    // ... per tool type
  },

  createdAt: Date,
  updatedAt: Date,
  completedAt: Date | null,

  errors: []
}
```

### WorkerState
```javascript
{
  taskId: "task_001",
  sessionId: "local___orch_abc123_worker_task_001",

  status: "pending" | "running" | "completed" | "error" | "timeout",
  progress: 0-100,

  task: { /* task definition from planning */ },

  toolStats: { reads: 5, edits: 2, ... },

  output: { /* final output if completed */ },
  error: { /* error details if failed */ },

  startedAt: Date | null,
  completedAt: Date | null
}
```

## Integration Points

### Existing Code to Modify

| File | Modification |
|------|--------------|
| `backend/server.js` | Add orchestrator API routes |
| `backend/command-injector/cdp-controller.js` | Filter hidden sessions from getAllSessions |
| `public/app.js` | Add orchestrator session type handling |
| `public/index.html` | Add template selector in new session modal |

### New Files to Create

| File | Purpose |
|------|---------|
| `backend/orchestrator/index.js` | Module exports |
| `backend/orchestrator/TemplateManager.js` | Template CRUD and validation |
| `backend/orchestrator/OrchestratorManager.js` | Orchestrator lifecycle |
| `backend/orchestrator/WorkerManager.js` | Worker spawning/monitoring |
| `backend/orchestrator/ResponseParser.js` | Parse structured responses |
| `backend/orchestrator/templates/*.json` | Template files |
| `public/orchestrator/*.js` | Frontend components |

## Error Handling Strategy

| Error Type | Handling |
|------------|----------|
| Claude doesn't follow format | Retry with stricter prompt, fallback to keyword detection |
| Worker timeout | Mark as error, optionally retry based on template config |
| Worker error | Log, mark task as failed, continue with other tasks |
| Too many tokens | Warn user, suggest splitting further |
| Rate limit | Queue with delays, exponential backoff |
| CDP connection lost | Attempt reconnect, pause orchestrator |

## Persistence

Orchestrator state is automatically persisted to disk to survive server restarts.

**Storage Location:**
```
backend/orchestrator/data/orchestrators.json
```

**Auto-save Triggers:**
- Orchestrator created
- State updated (phase change, status change, etc.)
- Orchestrator deleted

**Configuration Options (in OrchestratorManager):**
- `persistenceEnabled` - Enable/disable persistence (default: `true`)
- `persistencePath` - Custom file path (default: `data/orchestrators.json`)
- `saveDebounceMs` - Debounce interval for saves (default: `1000ms`)

**Data Format:**
```json
[
  {
    "id": "orch_xxxx",
    "templateId": "documentation",
    "mainSessionId": "local_xxxx",
    "status": "running",
    "currentPhase": "workerExecution",
    "tasks": [...],
    "workers": {...},
    "createdAt": "2024-01-18T...",
    "updatedAt": "2024-01-18T..."
  }
]
```

## Security Considerations

- Worker sessions are prefixed with `__orch_` to identify them
- Workers inherit same permissions as main session
- No cross-session data access (each worker isolated)
- User templates stored separately, validated against schema
- PIN authentication required for all orchestrator API endpoints
- Session tokens validated via `authMiddleware`

## Alternative: SubSession System

The SubSession system provides a **simpler, more natural approach** to multi-agent workflows. Instead of requiring Claude to follow a strict structured response protocol, it:

1. Lets Claude naturally use the Task tool to spawn agents
2. Automatically detects when spawned sessions become inactive (60+ seconds)
3. Returns the last assistant message back to the parent session

### When to Use SubSessions vs Structured Mode

| Use Case | Recommended Mode |
|----------|------------------|
| Dynamic, exploratory tasks | **SubSession Mode** |
| Documentation generation | **SubSession Mode** |
| Complex feature implementation | **SubSession Mode** |
| Predictable, repeatable workflows | Structured Mode |
| Tasks requiring strict output format | Structured Mode |

### SubSession Components

| File | Purpose |
|------|---------|
| `backend/orchestrator/SubSessionManager.js` | Manages parent-child relationships |
| `templates/subsession-doc.json` | Documentation template (SubSession mode) |
| `templates/subsession-task.json` | Generic task template (SubSession mode) |

See [05-SUBSESSION-SYSTEM.md](./05-SUBSESSION-SYSTEM.md) for detailed documentation.

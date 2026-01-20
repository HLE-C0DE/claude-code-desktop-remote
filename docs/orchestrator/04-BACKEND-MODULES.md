# Backend Modules Specification

## Module Overview

```
backend/orchestrator/
├── index.js                 # Main exports
├── TemplateManager.js       # Template CRUD & validation
├── ResponseParser.js        # Parse Claude responses
├── OrchestratorManager.js   # Orchestrator lifecycle
├── WorkerManager.js         # Worker spawning & monitoring
└── templates/
    ├── schema.json          # JSON Schema
    ├── _default.json        # Base template
    ├── documentation.json   # System template
    └── custom/              # User templates
```

---

## 1. TemplateManager.js

### Purpose
Load, validate, merge, and manage orchestrator templates.

### Dependencies
```javascript
const fs = require('fs').promises;
const path = require('path');
const Ajv = require('ajv');  // JSON Schema validator
```

### Class Structure

```javascript
class TemplateManager {
  constructor(templatesDir) {
    this.templatesDir = templatesDir;
    this.customDir = path.join(templatesDir, 'custom');
    this.schema = null;
    this.templates = new Map();  // id -> template
    this.ajv = new Ajv({ allErrors: true });
  }

  // === Initialization ===

  async initialize()
  // Load schema and all templates at startup
  // Returns: void
  // Throws: Error if schema invalid or required templates missing

  async loadSchema()
  // Load and compile JSON schema
  // Returns: compiled schema validator

  async loadAllTemplates()
  // Load system + custom templates
  // Returns: Map<id, template>

  // === Template CRUD ===

  async getTemplate(id)
  // Get template by ID (with inheritance resolved)
  // Returns: merged template object
  // Throws: Error if not found

  async getAllTemplates()
  // Get all available templates (metadata only)
  // Returns: Array<{id, name, description, icon, author, isSystem}>

  async createTemplate(templateData)
  // Create new custom template
  // Returns: created template with generated ID
  // Throws: ValidationError if invalid

  async updateTemplate(id, templateData)
  // Update existing custom template
  // Returns: updated template
  // Throws: Error if system template or not found

  async deleteTemplate(id)
  // Delete custom template
  // Returns: void
  // Throws: Error if system template or not found

  async duplicateTemplate(id, newName)
  // Duplicate template to custom folder
  // Returns: new template with new ID

  // === Template Processing ===

  resolveInheritance(template)
  // Resolve 'extends' chain and merge
  // Returns: fully merged template

  validateTemplate(template)
  // Validate against JSON schema
  // Returns: { valid: boolean, errors: array }

  substituteVariables(promptText, variables)
  // Replace {VAR} placeholders with values
  // Returns: string with substitutions

  // === Helpers ===

  isSystemTemplate(id)
  // Check if template is system (read-only)
  // Returns: boolean

  generateTemplateId(name)
  // Generate URL-safe ID from name
  // Returns: string
}
```

### Key Methods Implementation Notes

#### resolveInheritance
```javascript
resolveInheritance(template) {
  if (!template.extends) {
    return template;
  }

  const parentId = template.extends;
  const parent = this.templates.get(parentId);
  if (!parent) {
    throw new Error(`Parent template '${parentId}' not found`);
  }

  // Recursively resolve parent
  const resolvedParent = this.resolveInheritance(parent);

  // Deep merge: parent + child (child wins)
  return this.deepMerge(resolvedParent, template);
}
```

#### substituteVariables
```javascript
substituteVariables(text, variables) {
  return text.replace(/\{([A-Z_]+)\}/g, (match, varName) => {
    if (variables.hasOwnProperty(varName)) {
      const value = variables[varName];
      // Handle different types
      if (typeof value === 'boolean') return value ? 'yes' : 'no';
      if (Array.isArray(value)) return value.join(', ');
      return String(value);
    }
    return match; // Keep original if not found
  });
}
```

### Events Emitted
- `template:loaded` - Template loaded successfully
- `template:created` - Custom template created
- `template:updated` - Template updated
- `template:deleted` - Template deleted
- `template:error` - Validation or load error

---

## 2. ResponseParser.js

### Purpose
Parse and validate orchestrator responses from Claude.

### Class Structure

```javascript
class ResponseParser {
  constructor(options = {}) {
    this.delimiterStart = options.delimiterStart || '<<<ORCHESTRATOR_RESPONSE>>>';
    this.delimiterEnd = options.delimiterEnd || '<<<END_ORCHESTRATOR_RESPONSE>>>';
  }

  // === Main Parsing ===

  parse(text)
  // Parse orchestrator response from text
  // Returns: ParseResult object

  parseMultiple(text)
  // Parse all orchestrator responses in text (for progress updates)
  // Returns: Array<ParseResult>

  // === Validation ===

  validatePhase(phase, data, schema)
  // Validate response data against phase schema
  // Returns: { valid: boolean, errors: array, warnings: array }

  // === Fallback Detection ===

  detectFallback(text)
  // Attempt to detect phase from keywords when format not followed
  // Returns: { detected: boolean, probablePhase: string, confidence: number }

  // === Helpers ===

  extractJSON(text)
  // Extract and parse JSON from delimited text
  // Returns: object or null

  fixCommonJSONErrors(jsonString)
  // Attempt to fix trailing commas, etc.
  // Returns: fixed string
}

// Result Types
interface ParseResult {
  found: boolean;
  phase?: string;           // 'analysis', 'task_list', 'progress', 'completion', 'aggregation'
  data?: object;            // Parsed data
  beforeText?: string;      // Text before delimiters
  afterText?: string;       // Text after delimiters
  error?: string;           // Error message if parsing failed
  raw?: string;             // Raw content for debugging
}
```

### Phase Schemas (for validation)

```javascript
const PHASE_SCHEMAS = {
  analysis: {
    required: ['summary', 'recommended_splits'],
    optional: ['key_files', 'estimated_complexity', 'notes', 'warnings', 'components']
  },

  task_list: {
    required: ['tasks'],
    optional: ['total_tasks', 'parallelizable_groups', 'execution_order'],
    taskSchema: {
      required: ['id', 'title', 'description'],
      optional: ['scope', 'priority', 'dependencies', 'estimated_tokens']
    }
  },

  progress: {
    required: ['task_id', 'status'],
    optional: ['progress_percent', 'current_action', 'files_processed', 'files_total', 'output_preview']
  },

  completion: {
    required: ['task_id', 'status'],
    optional: ['summary', 'output_files', 'output', 'error', 'warnings', 'metrics']
  },

  aggregation: {
    required: ['status'],
    optional: ['summary', 'conflicts', 'merged_output', 'output_files']
  }
};
```

### Fallback Patterns

```javascript
const FALLBACK_PATTERNS = {
  analysis: [
    /analysis\s+(?:is\s+)?(?:complete|done|finished)/i,
    /(?:found|identified)\s+\d+\s+(?:components?|modules?|files?)/i,
    /recommend(?:ing|s?)\s+\d+\s+(?:tasks?|splits?)/i
  ],
  task_list: [
    /(?:task|breakdown)\s+list\s+(?:is\s+)?(?:ready|complete|created)/i,
    /created?\s+\d+\s+tasks?/i,
    /here\s+(?:are|is)\s+the\s+task/i
  ],
  progress: [
    /working\s+on/i,
    /currently\s+(?:processing|documenting|analyzing)/i,
    /progress:\s*\d+%/i
  ],
  completion: [
    /task\s+(?:is\s+)?(?:complete|done|finished)/i,
    /successfully\s+(?:completed|created|documented)/i
  ],
  error: [
    /(?:error|failed|could\s*n[o']t)/i,
    /unable\s+to/i
  ]
};
```

---

## 3. OrchestratorManager.js

### Purpose
Manage orchestrator lifecycle, state, and phase transitions.

### Dependencies
```javascript
const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');
```

### Class Structure

```javascript
class OrchestratorManager extends EventEmitter {
  constructor(templateManager, responseParser, cdpController) {
    super();
    this.templateManager = templateManager;
    this.responseParser = responseParser;
    this.cdpController = cdpController;
    this.orchestrators = new Map();  // id -> OrchestratorState
  }

  // === Lifecycle ===

  async create(options)
  // Create new orchestrator
  // options: { templateId, cwd, message, customVariables }
  // Returns: OrchestratorState
  // Side effects: Creates main session, injects analysis prompt

  async start(orchestratorId)
  // Start orchestration (after user confirmation if needed)
  // Returns: void

  async pause(orchestratorId)
  // Pause orchestrator (pause all workers)
  // Returns: void

  async resume(orchestratorId)
  // Resume paused orchestrator
  // Returns: void

  async cancel(orchestratorId)
  // Cancel orchestrator and cleanup workers
  // Returns: void

  // === Phase Management ===

  async processPhase(orchestratorId, transcript)
  // Process current phase based on transcript
  // Returns: { phaseComplete: boolean, nextPhase: string }

  async advanceToPhase(orchestratorId, phase)
  // Advance to next phase
  // Returns: void

  async handleAnalysisResponse(orchestratorId, data)
  // Process analysis phase response
  // Returns: void

  async handleTaskListResponse(orchestratorId, data)
  // Process task list response, validate tasks
  // Returns: void

  async handleAggregationResponse(orchestratorId, data)
  // Process aggregation response
  // Returns: void

  // === State Management ===

  get(orchestratorId)
  // Get orchestrator state
  // Returns: OrchestratorState or null

  getAll()
  // Get all active orchestrators
  // Returns: Array<OrchestratorState>

  getStatus(orchestratorId)
  // Get orchestrator status summary
  // Returns: StatusSummary

  updateStats(orchestratorId, toolStats)
  // Update aggregated tool statistics
  // Returns: void

  // === Helpers ===

  generatePrompt(template, phase, variables)
  // Generate prompt for phase with variable substitution
  // Returns: string

  buildWorkerTasks(orchestratorId)
  // Build worker task queue from task list
  // Returns: Array<WorkerTask>

  // === Cleanup ===

  async cleanup(orchestratorId, options)
  // Cleanup orchestrator (archive workers, etc.)
  // options: { archiveWorkers: true, deleteWorkers: false }
  // Returns: void
}
```

### State Types

```javascript
interface OrchestratorState {
  id: string;                    // "orch_abc123"
  templateId: string;            // "documentation"
  template: object;              // Resolved template

  mainSessionId: string;         // "local_xxx"
  cwd: string;                   // Working directory
  userRequest: string;           // Original user message

  status: OrchestratorStatus;
  currentPhase: Phase;

  analysis: AnalysisData | null;
  tasks: TaskDefinition[];
  parallelGroups: string[][];

  workers: Map<string, string>;  // taskId -> sessionId
  workerManager: WorkerManager;  // Reference

  stats: AggregatedStats;

  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;

  errors: ErrorEntry[];
}

type OrchestratorStatus =
  | 'created'       // Just created, waiting to start
  | 'analyzing'     // Analysis phase in progress
  | 'planning'      // Task planning phase
  | 'confirming'    // Waiting for user confirmation
  | 'spawning'      // Spawning workers
  | 'running'       // Workers executing
  | 'aggregating'   // Aggregating results
  | 'verifying'     // Verification phase
  | 'completed'     // Successfully completed
  | 'error'         // Failed with error
  | 'cancelled'     // Cancelled by user
  | 'paused';       // Paused

type Phase =
  | 'analysis'
  | 'taskPlanning'
  | 'workerExecution'
  | 'aggregation'
  | 'verification';
```

### Events Emitted
- `orchestrator:created` - New orchestrator created
- `orchestrator:started` - Orchestration started
- `orchestrator:phaseChanged` - Phase transition
- `orchestrator:analysisComplete` - Analysis phase done
- `orchestrator:tasksReady` - Task list ready
- `orchestrator:workersSpawned` - Workers created
- `orchestrator:progress` - Progress update
- `orchestrator:completed` - Successfully completed
- `orchestrator:error` - Error occurred
- `orchestrator:cancelled` - Cancelled by user

---

## 4. WorkerManager.js

### Purpose
Spawn, monitor, and manage worker sessions.

### Class Structure

```javascript
class WorkerManager extends EventEmitter {
  constructor(cdpController, responseParser, config) {
    super();
    this.cdpController = cdpController;
    this.responseParser = responseParser;
    this.config = config;  // maxWorkers, pollInterval, etc.

    this.workers = new Map();       // sessionId -> WorkerState
    this.taskQueue = [];            // Pending tasks
    this.activeCount = 0;
    this.monitoringInterval = null;
  }

  // === Worker Lifecycle ===

  async spawnWorker(orchestratorId, task, template, variables)
  // Create worker session for task
  // Returns: WorkerState

  async spawnBatch(orchestratorId, tasks, template, variables)
  // Spawn multiple workers respecting maxWorkers
  // Returns: Array<WorkerState>

  // === Monitoring ===

  startMonitoring()
  // Start polling workers for updates
  // Returns: void

  stopMonitoring()
  // Stop monitoring loop
  // Returns: void

  async pollWorker(sessionId)
  // Check single worker for updates
  // Returns: { hasUpdate: boolean, state: WorkerState }

  async pollAllWorkers()
  // Poll all active workers
  // Returns: Array<WorkerUpdate>

  // === State Management ===

  getWorker(sessionId)
  // Get worker state
  // Returns: WorkerState

  getWorkerByTaskId(taskId)
  // Get worker by task ID
  // Returns: WorkerState

  getAllWorkers(orchestratorId)
  // Get all workers for orchestrator
  // Returns: Array<WorkerState>

  getActiveWorkers(orchestratorId)
  // Get running workers
  // Returns: Array<WorkerState>

  // === Task Queue ===

  queueTasks(tasks)
  // Add tasks to queue
  // Returns: void

  async processQueue(orchestratorId, template, variables)
  // Process queued tasks (spawn if slots available)
  // Returns: number (tasks spawned)

  // === Worker Control ===

  async pauseWorker(sessionId)
  // Pause worker (stop polling)
  // Returns: void

  async resumeWorker(sessionId)
  // Resume paused worker
  // Returns: void

  async cancelWorker(sessionId)
  // Cancel and cleanup worker
  // Returns: void

  async retryWorker(sessionId)
  // Retry failed worker
  // Returns: WorkerState

  // === Results ===

  collectOutputs(orchestratorId)
  // Collect all worker outputs
  // Returns: Array<{ taskId, output }>

  getAggregatedStats(orchestratorId)
  // Get combined stats from all workers
  // Returns: AggregatedStats

  // === Cleanup ===

  async archiveWorkers(orchestratorId)
  // Archive all worker sessions
  // Returns: void

  async deleteWorkers(orchestratorId)
  // Permanently delete worker sessions
  // Returns: void
}
```

### Worker State

```javascript
interface WorkerState {
  sessionId: string;           // "local___orch_abc_worker_task_001"
  orchestratorId: string;      // Parent orchestrator
  taskId: string;              // "task_001"
  task: TaskDefinition;        // Full task definition

  status: WorkerStatus;
  progress: number;            // 0-100
  currentAction: string;       // What worker is doing

  toolStats: {
    total: number;
    reads: number;
    writes: number;
    edits: number;
    bash: number;
    // ... per tool type
  };

  output: string | null;       // Final output
  outputFiles: string[];       // Created files
  error: string | null;        // Error if failed

  retryCount: number;
  lastPollAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

type WorkerStatus =
  | 'pending'     // In queue, not started
  | 'spawning'    // Session being created
  | 'running'     // Actively executing
  | 'paused'      // Paused
  | 'completed'   // Successfully done
  | 'failed'      // Failed with error
  | 'timeout'     // Timed out
  | 'cancelled';  // Cancelled
```

### Session Naming Convention

Worker sessions use this naming format:
```
local___orch_{orchestratorId}_worker_{taskId}
```

Examples:
- `local___orch_abc123_worker_task_001`
- `local___orch_abc123_worker_task_002`

The double underscore `__` prefix makes them easy to filter from the session list.

### Events Emitted
- `worker:spawned` - Worker created
- `worker:started` - Worker began executing
- `worker:progress` - Progress update
- `worker:completed` - Worker finished successfully
- `worker:failed` - Worker failed
- `worker:timeout` - Worker timed out
- `worker:retrying` - Worker retrying after error

---

## 5. index.js (Main Export)

```javascript
const TemplateManager = require('./TemplateManager');
const ResponseParser = require('./ResponseParser');
const OrchestratorManager = require('./OrchestratorManager');
const WorkerManager = require('./WorkerManager');

class OrchestratorModule {
  constructor(cdpController, options = {}) {
    const templatesDir = options.templatesDir ||
      path.join(__dirname, 'templates');

    this.templateManager = new TemplateManager(templatesDir);
    this.responseParser = new ResponseParser(options.parser);
    this.orchestratorManager = new OrchestratorManager(
      this.templateManager,
      this.responseParser,
      cdpController
    );
    this.workerManager = new WorkerManager(
      cdpController,
      this.responseParser,
      options.worker
    );

    // Wire up events
    this._setupEventForwarding();
  }

  async initialize() {
    await this.templateManager.initialize();
  }

  _setupEventForwarding() {
    // Forward events from sub-managers
    // Allows single event listener on module
  }

  // Expose managers
  get templates() { return this.templateManager; }
  get orchestrators() { return this.orchestratorManager; }
  get workers() { return this.workerManager; }
}

module.exports = OrchestratorModule;
module.exports.TemplateManager = TemplateManager;
module.exports.ResponseParser = ResponseParser;
module.exports.OrchestratorManager = OrchestratorManager;
module.exports.WorkerManager = WorkerManager;
```

---

## Integration with Existing Code

### server.js Modifications

```javascript
// Add to imports
const OrchestratorModule = require('./orchestrator');

// Initialize after cdpController
const orchestrator = new OrchestratorModule(cdpController, {
  templatesDir: path.join(__dirname, 'orchestrator/templates'),
  worker: {
    maxWorkers: 5,
    pollInterval: 2000,
    workerTimeout: 300000
  }
});

// Initialize on startup
await orchestrator.initialize();

// Add routes (see 05-API-ENDPOINTS.md)
```

### cdp-controller.js Modifications

```javascript
// In getAllSessions, filter hidden orchestrator workers
async getAllSessions(forceRefresh = false, includeHidden = false) {
  // ... existing code ...

  if (!includeHidden) {
    sessions = sessions.filter(s => !s.sessionId.includes('__orch_'));
  }

  return sessions;
}
```

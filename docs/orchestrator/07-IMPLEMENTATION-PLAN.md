# Implementation Plan

## Overview

This document provides a step-by-step implementation plan with context prompts for starting fresh Claude sessions for each task.

## Task Dependency Graph

```
Task 1: TemplateManager ──┐
                          │
Task 2: ResponseParser ───┼──► Task 4: OrchestratorManager ──┐
                          │                                   │
Task 3: Schema + Templates┘                                   ├──► Task 7: Integration
                                                              │
Task 5: WorkerManager ────────────────────────────────────────┤
                                                              │
Task 6: API Endpoints ────────────────────────────────────────┘

Task 8: UI - New Session Modal (can start after Task 6)
Task 9: UI - Orchestrator Dashboard (can start after Task 6)
Task 10: Testing & Polish
```

## Recommended Order

1. **Task 1** - TemplateManager (foundation)
2. **Task 2** - ResponseParser (foundation)
3. **Task 3** - Schema + Default Templates
4. **Task 4** - OrchestratorManager (requires 1, 2, 3)
5. **Task 5** - WorkerManager (can parallel with 4)
6. **Task 6** - API Endpoints (requires 4, 5)
7. **Task 7** - Integration (requires 6)
8. **Task 8** - UI New Session Modal (requires 7)
9. **Task 9** - UI Orchestrator Dashboard (requires 7)
10. **Task 10** - Testing & Polish

---

## Task 1: TemplateManager

### Files to Create
- `backend/orchestrator/TemplateManager.js`

### Dependencies
- `ajv` (npm package for JSON Schema validation)

### Context Prompt

```
# Context: Big Tasks / Orchestrator System

You are implementing the TemplateManager module for a "Big Tasks" orchestration system in a Claude Desktop control interface.

## Project Location
C:\Users\lescu\Desktop\Projects\ClaudeCode_Remote

## Documentation to Read First
Read these files for full context:
- docs/orchestrator/00-README.md (overview)
- docs/orchestrator/02-TEMPLATES.md (full template specification)
- docs/orchestrator/04-BACKEND-MODULES.md (TemplateManager section)

## Your Task
Create `backend/orchestrator/TemplateManager.js` with:

1. Template loading from filesystem (JSON files)
2. JSON Schema validation using ajv
3. Template inheritance resolution (extends field)
4. Deep merge for template overrides
5. Variable substitution in prompts ({VAR_NAME} syntax)
6. CRUD operations for custom templates
7. Caching for loaded templates

## Key Requirements
- System templates are read-only (in templates/ folder)
- Custom templates go in templates/custom/ folder
- All templates must validate against schema.json
- The _default.json template is the base for inheritance
- Use EventEmitter for template:loaded, template:created, etc.

## Expected Interface
```javascript
class TemplateManager {
  constructor(templatesDir)
  async initialize()
  async loadSchema()
  async loadAllTemplates()
  async getTemplate(id) // Returns resolved template
  async getAllTemplates() // Returns metadata array
  async createTemplate(data)
  async updateTemplate(id, data)
  async deleteTemplate(id)
  async duplicateTemplate(id, newName)
  resolveInheritance(template)
  validateTemplate(template)
  substituteVariables(text, variables)
  isSystemTemplate(id)
}
```

## Constraints
- Use fs.promises for file operations
- Handle missing files gracefully
- Validate inheritance chains (no cycles)
- Cache templates in memory after load

DO NOT create the schema.json or template JSON files - that's Task 3.
Just create the TemplateManager.js module.
```

---

## Task 2: ResponseParser

### Files to Create
- `backend/orchestrator/ResponseParser.js`

### Dependencies
- None (pure JavaScript)

### Context Prompt

```
# Context: Big Tasks / Orchestrator System

You are implementing the ResponseParser module for parsing structured responses from Claude.

## Project Location
C:\Users\lescu\Desktop\Projects\ClaudeCode_Remote

## Documentation to Read First
- docs/orchestrator/00-README.md (overview)
- docs/orchestrator/03-PROTOCOL.md (full protocol specification)
- docs/orchestrator/04-BACKEND-MODULES.md (ResponseParser section)

## Your Task
Create `backend/orchestrator/ResponseParser.js` with:

1. Detection and extraction of orchestrator responses from text
2. JSON parsing with error recovery
3. Phase-specific validation
4. Fallback keyword detection when format not followed
5. Support for multiple responses in one text (progress updates)

## Response Format to Parse
```
<<<ORCHESTRATOR_RESPONSE>>>
{
  "phase": "analysis|task_list|progress|completion|aggregation",
  "data": { ... }
}
<<<END_ORCHESTRATOR_RESPONSE>>>
```

## Expected Interface
```javascript
class ResponseParser {
  constructor(options = {})
  parse(text) // Returns ParseResult
  parseMultiple(text) // Returns Array<ParseResult>
  validatePhase(phase, data) // Validates data against phase schema
  detectFallback(text) // Keyword-based detection
  extractJSON(text)
  fixCommonJSONErrors(jsonString)
}

// ParseResult shape:
{
  found: boolean,
  phase?: string,
  data?: object,
  beforeText?: string,
  afterText?: string,
  error?: string,
  raw?: string
}
```

## Phase Validation Schemas
- analysis: requires summary, recommended_splits
- task_list: requires tasks array
- progress: requires task_id, status
- completion: requires task_id, status
- aggregation: requires status

## Constraints
- Don't throw on invalid JSON, return error in result
- Attempt to fix common JSON issues (trailing commas)
- Include the raw extracted text in result for debugging
- Delimiters are configurable via constructor
```

---

## Task 3: Schema + Default Templates

### Files to Create
- `backend/orchestrator/templates/schema.json`
- `backend/orchestrator/templates/_default.json`
- `backend/orchestrator/templates/documentation.json`

### Dependencies
- None

### Context Prompt

```
# Context: Big Tasks / Orchestrator System

You are creating the JSON Schema and initial templates for the orchestration system.

## Project Location
C:\Users\lescu\Desktop\Projects\ClaudeCode_Remote

## Documentation to Read First
- docs/orchestrator/02-TEMPLATES.md (full template specification)
- docs/orchestrator/03-PROTOCOL.md (response formats for prompts)

## Your Task
Create these files:

### 1. backend/orchestrator/templates/schema.json
A JSON Schema that validates orchestrator templates. Must validate:
- Required fields: id, name, prompts
- Optional fields: description, icon, version, author, tags, extends, config, phases, variables, hooks, ui
- Nested structures for config, phases, prompts
- Prompt format requirements (must include response delimiters)

### 2. backend/orchestrator/templates/_default.json
The base template that all others inherit from. Include:
- Default config values (maxWorkers: 5, etc.)
- All phase definitions with reasonable defaults
- Complete prompt templates for: analysis, taskPlanning, worker, aggregation
- Prompts MUST instruct Claude to use <<<ORCHESTRATOR_RESPONSE>>> format

### 3. backend/orchestrator/templates/documentation.json
A documentation-focused template that extends _default. Include:
- extends: "_default"
- Custom config for documentation (more workers, auto-spawn)
- Modified prompts focused on documentation generation
- Custom variables: OUTPUT_FORMAT, LANGUAGE, VERBOSITY, INCLUDE_EXAMPLES

## Prompt Writing Guidelines
- Be VERY explicit about response format
- Include examples in the prompt if needed
- Remind Claude it MUST use the delimiters
- For workers, include progress and completion format instructions
- Use {VARIABLE_NAME} syntax for substitution points

## Also create the folder structure
backend/orchestrator/templates/custom/ (empty folder for user templates)
```

---

## Task 4: OrchestratorManager

### Files to Create
- `backend/orchestrator/OrchestratorManager.js`

### Dependencies
- TemplateManager (Task 1)
- ResponseParser (Task 2)
- uuid (npm package)

### Context Prompt

```
# Context: Big Tasks / Orchestrator System

You are implementing the OrchestratorManager module for managing orchestrator lifecycle and state.

## Project Location
C:\Users\lescu\Desktop\Projects\ClaudeCode_Remote

## Documentation to Read First
- docs/orchestrator/01-ARCHITECTURE.md (flow and state)
- docs/orchestrator/04-BACKEND-MODULES.md (OrchestratorManager section)

## Existing Code to Reference
- backend/command-injector/cdp-controller.js (for CDP API usage)

## Your Task
Create `backend/orchestrator/OrchestratorManager.js` with:

1. Orchestrator lifecycle management (create, start, pause, resume, cancel)
2. State management with OrchestratorState objects
3. Phase transitions (analysis → taskPlanning → workerExecution → aggregation)
4. Prompt generation with variable substitution
5. Response handling and phase advancement
6. Event emission for UI updates

## Expected Interface
```javascript
class OrchestratorManager extends EventEmitter {
  constructor(templateManager, responseParser, cdpController)

  // Lifecycle
  async create(options) // { templateId, cwd, message, customVariables }
  async start(orchestratorId)
  async pause(orchestratorId)
  async resume(orchestratorId)
  async cancel(orchestratorId)

  // Phase management
  async processPhase(orchestratorId, transcript)
  async advanceToPhase(orchestratorId, phase)
  async handleAnalysisResponse(orchestratorId, data)
  async handleTaskListResponse(orchestratorId, data)

  // State
  get(orchestratorId)
  getAll()
  getStatus(orchestratorId)
  updateStats(orchestratorId, toolStats)

  // Helpers
  generatePrompt(template, phase, variables)
  buildWorkerTasks(orchestratorId)
  async cleanup(orchestratorId, options)
}
```

## State Shape (OrchestratorState)
See 04-BACKEND-MODULES.md for full shape.

## Key Events to Emit
- orchestrator:created
- orchestrator:started
- orchestrator:phaseChanged
- orchestrator:analysisComplete
- orchestrator:tasksReady
- orchestrator:completed
- orchestrator:error

## Constraints
- Use uuid for orchestrator IDs (format: orch_xxx)
- Store orchestrators in a Map (in-memory for now)
- Validate tasks have required fields before spawning
- Handle errors gracefully, update state to 'error'
```

---

## Task 5: WorkerManager

### Files to Create
- `backend/orchestrator/WorkerManager.js`

### Dependencies
- ResponseParser (Task 2)

### Context Prompt

```
# Context: Big Tasks / Orchestrator System

You are implementing the WorkerManager module for spawning and monitoring worker sessions.

## Project Location
C:\Users\lescu\Desktop\Projects\ClaudeCode_Remote

## Documentation to Read First
- docs/orchestrator/01-ARCHITECTURE.md (worker flow)
- docs/orchestrator/04-BACKEND-MODULES.md (WorkerManager section)

## Existing Code to Reference
- backend/command-injector/cdp-controller.js (especially startNewSessionWithMessage, getTranscript)

## Your Task
Create `backend/orchestrator/WorkerManager.js` with:

1. Worker spawning via CDP (creates hidden sessions)
2. Task queue management (respect maxWorkers)
3. Polling loop for transcript updates
4. Progress and completion detection
5. Tool statistics aggregation
6. Worker control (pause, cancel, retry)
7. Cleanup (archive/delete workers)

## Worker Session Naming
Sessions MUST be named: `local___orch_{orchestratorId}_worker_{taskId}`
The `__` prefix makes them filterable from main session list.

## Expected Interface
```javascript
class WorkerManager extends EventEmitter {
  constructor(cdpController, responseParser, config)

  // Lifecycle
  async spawnWorker(orchestratorId, task, template, variables)
  async spawnBatch(orchestratorId, tasks, template, variables)

  // Monitoring
  startMonitoring()
  stopMonitoring()
  async pollWorker(sessionId)
  async pollAllWorkers()

  // State
  getWorker(sessionId)
  getWorkerByTaskId(taskId)
  getAllWorkers(orchestratorId)
  getActiveWorkers(orchestratorId)

  // Queue
  queueTasks(tasks)
  async processQueue(orchestratorId, template, variables)

  // Control
  async pauseWorker(sessionId)
  async resumeWorker(sessionId)
  async cancelWorker(sessionId)
  async retryWorker(sessionId)

  // Results
  collectOutputs(orchestratorId)
  getAggregatedStats(orchestratorId)

  // Cleanup
  async archiveWorkers(orchestratorId)
}
```

## Config Shape
```javascript
{
  maxWorkers: 5,
  pollInterval: 2000,
  workerTimeout: 300000
}
```

## Key Events to Emit
- worker:spawned
- worker:started
- worker:progress
- worker:completed
- worker:failed
- worker:timeout

## Constraints
- Respect maxWorkers limit
- Track tool usage by parsing transcripts
- Handle CDP errors gracefully
- Implement timeout handling
```

---

## Task 6: API Endpoints

### Files to Modify
- `backend/server.js`

### Files to Create
- `backend/orchestrator/index.js` (main export)

### Dependencies
- All previous tasks

### Context Prompt

```
# Context: Big Tasks / Orchestrator System

You are implementing the API endpoints for the orchestration system.

## Project Location
C:\Users\lescu\Desktop\Projects\ClaudeCode_Remote

## Documentation to Read First
- docs/orchestrator/05-API-ENDPOINTS.md (full API specification)
- docs/orchestrator/04-BACKEND-MODULES.md (index.js section)

## Existing Code to Reference
- backend/server.js (for existing API patterns, middleware, WebSocket)

## Your Task

### 1. Create backend/orchestrator/index.js
Main export that initializes all modules:
```javascript
const OrchestratorModule = require('./index');
const orchestrator = new OrchestratorModule(cdpController, options);
await orchestrator.initialize();
```

### 2. Add routes to backend/server.js
Add all endpoints from 05-API-ENDPOINTS.md:

Template endpoints:
- GET /api/orchestrator/templates
- GET /api/orchestrator/templates/:id
- POST /api/orchestrator/templates
- PUT /api/orchestrator/templates/:id
- DELETE /api/orchestrator/templates/:id
- POST /api/orchestrator/templates/:id/duplicate

Orchestrator endpoints:
- POST /api/orchestrator/create
- GET /api/orchestrator/:id
- GET /api/orchestrator/:id/status
- POST /api/orchestrator/:id/start
- POST /api/orchestrator/:id/confirm-tasks
- POST /api/orchestrator/:id/pause
- POST /api/orchestrator/:id/resume
- POST /api/orchestrator/:id/cancel

Worker endpoints:
- GET /api/orchestrator/:id/workers
- GET /api/orchestrator/:id/workers/:taskId
- POST /api/orchestrator/:id/workers/:taskId/retry
- POST /api/orchestrator/:id/workers/:taskId/cancel

### 3. Add WebSocket events
Forward orchestrator and worker events to connected clients.

## Constraints
- Use existing authMiddleware
- Follow existing error handling patterns
- Use existing response format ({ success, data, timestamp })
- Add rate limiting for create endpoint
```

---

## Task 7: Integration

### Files to Modify
- `backend/server.js`
- `backend/command-injector/cdp-controller.js`

### Context Prompt

```
# Context: Big Tasks / Orchestrator System

You are integrating the orchestration system with the existing codebase.

## Project Location
C:\Users\lescu\Desktop\Projects\ClaudeCode_Remote

## Documentation to Read First
- docs/orchestrator/01-ARCHITECTURE.md (integration points)

## Your Task

### 1. Initialize Orchestrator Module in server.js
```javascript
const OrchestratorModule = require('./orchestrator');
const orchestrator = new OrchestratorModule(cdpController, {
  templatesDir: path.join(__dirname, 'orchestrator/templates'),
  worker: { maxWorkers: 5, pollInterval: 2000 }
});
await orchestrator.initialize();
```

### 2. Modify cdp-controller.js - Filter hidden sessions
In getAllSessions(), add option to filter orchestrator workers:
```javascript
async getAllSessions(forceRefresh = false, includeHidden = false) {
  // ... existing code ...
  if (!includeHidden) {
    sessions = sessions.filter(s => !s.sessionId.includes('__orch_'));
  }
  return sessions;
}
```

### 3. Forward WebSocket events
In server.js, wire up orchestrator events to WebSocket broadcast:
```javascript
orchestrator.orchestrators.on('orchestrator:progress', (data) => {
  broadcastToClients({ type: 'orchestrator:progress', data });
});
// ... other events
```

### 4. Update existing session endpoints
Ensure /api/sessions doesn't return hidden orchestrator workers.

### 5. Test basic flow
- Create orchestrator
- Verify main session created
- Verify analysis prompt injected
- Verify hidden sessions are filtered

## Constraints
- Don't break existing functionality
- Graceful fallback if orchestrator module fails to load
- Log orchestrator initialization status
```

---

## Task 8: UI - New Session Modal

### Files to Modify
- `public/index.html`
- `public/app.js`
- `public/style.css` (or relevant CSS file)

### Context Prompt

```
# Context: Big Tasks / Orchestrator System

You are implementing the UI modifications for creating orchestrator sessions.

## Project Location
C:\Users\lescu\Desktop\Projects\ClaudeCode_Remote

## Documentation to Read First
- docs/orchestrator/06-UI-SPECS.md (UI specifications, especially section 1)

## Existing Code to Reference
- public/index.html (existing new session modal)
- public/app.js (existing session creation logic)

## Your Task

### 1. Modify New Session Modal (index.html)
Add:
- Session type radio buttons (Classic / Orchestrator)
- Template dropdown (visible only when Orchestrator selected)
- Advanced options section (maxWorkers, autoSpawn, custom variables)

### 2. Add JavaScript (app.js)
- toggleOrchestratorOptions() - Show/hide orchestrator options
- loadTemplates() - Fetch templates for dropdown
- createOrchestratorSession() - Call POST /api/orchestrator/create
- Variable editor modal (simple key-value editor)

### 3. Add CSS
- .session-type-selector styles
- .template-selector styles
- .orchestrator-options styles

## Constraints
- Maintain existing modal layout/styling
- Progressive disclosure (show orchestrator options only when selected)
- Load templates on modal open, cache them
- Validate form before submit
- Show template description when selected
```

---

## Task 9: UI - Orchestrator Dashboard

### Files to Modify
- `public/app.js`
- `public/style.css`

### Context Prompt

```
# Context: Big Tasks / Orchestrator System

You are implementing the orchestrator dashboard view.

## Project Location
C:\Users\lescu\Desktop\Projects\ClaudeCode_Remote

## Documentation to Read First
- docs/orchestrator/06-UI-SPECS.md (sections 2, 3, 4)

## Existing Code to Reference
- public/app.js (existing session view)

## Your Task

### 1. Detect Orchestrator Sessions
When opening a session, check if it's an orchestrator (check orchestrator status endpoint or session metadata).

### 2. Render Orchestrator Header
- Show template name, status, phase
- Progress bar with percentage
- Task count (completed/total)

### 3. Render Worker List
- Tab-based view: [Messages] [Workers] [Stats]
- Worker cards with status, progress, tool stats
- Expandable detail panel
- Action buttons (pause, retry, cancel)

### 4. Real-time Updates
- Subscribe to orchestrator WebSocket events
- Update worker cards on progress/completion
- Show toast notifications

### 5. Add CSS
- Worker card styles (.worker-card, .completed, .running, etc.)
- Progress bar styles
- Tab navigation styles

## Constraints
- Reuse existing message display for main session
- Workers tab should be default when orchestrator running
- Handle long-running orchestrators (don't block UI)
- Show loading states appropriately
```

---

## Task 10: Testing & Polish

### Context Prompt

```
# Context: Big Tasks / Orchestrator System

You are testing and polishing the orchestration system.

## Project Location
C:\Users\lescu\Desktop\Projects\ClaudeCode_Remote

## Your Task

### 1. Test Template System
- Load default templates
- Create custom template
- Validate inheritance works
- Test variable substitution

### 2. Test Orchestrator Flow
- Create orchestrator with documentation template
- Verify analysis phase works
- Verify task list parsing
- Verify workers spawn correctly
- Test pause/resume
- Test cancel and cleanup

### 3. Test Edge Cases
- Invalid template
- Claude doesn't follow format (test fallback)
- Worker timeout
- Worker error and retry
- Cancel during execution

### 4. Polish
- Error messages are clear
- Loading states are shown
- UI updates smoothly
- No console errors

### 5. Documentation
- Update README if needed
- Add inline comments to complex code
- Document any deviations from spec

## Test Scenarios

Scenario 1: Happy Path
1. Create orchestrator (documentation template)
2. Wait for analysis
3. Confirm tasks
4. Wait for all workers
5. Verify aggregation

Scenario 2: Error Recovery
1. Create orchestrator
2. Force a worker to fail (bad scope)
3. Retry worker
4. Verify completion

Scenario 3: Cancel
1. Create orchestrator
2. Start workers
3. Cancel mid-execution
4. Verify cleanup (workers archived)
```

---

## Quick Reference: File Locations

```
backend/
├── orchestrator/
│   ├── index.js                 # Task 6
│   ├── TemplateManager.js       # Task 1
│   ├── ResponseParser.js        # Task 2
│   ├── OrchestratorManager.js   # Task 4
│   ├── WorkerManager.js         # Task 5
│   └── templates/
│       ├── schema.json          # Task 3
│       ├── _default.json        # Task 3
│       ├── documentation.json   # Task 3
│       └── custom/              # Task 3
├── server.js                    # Task 6, 7
└── command-injector/
    └── cdp-controller.js        # Task 7

public/
├── index.html                   # Task 8
├── app.js                       # Task 8, 9
└── style.css                    # Task 8, 9
```

---

## NPM Dependencies to Add

```bash
npm install ajv uuid
```

- `ajv` - JSON Schema validation (for TemplateManager)
- `uuid` - UUID generation (for OrchestratorManager)

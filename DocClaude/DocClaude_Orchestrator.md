# Orchestrator System - Comprehensive Documentation

**Version**: 1.0.0
**Last Updated**: 2026-01-18
**Location**: `C:\Users\lescu\Desktop\Projects\ClaudeCode_Remote\backend\orchestrator\`

---

# PART 1: VERBOSE EXPLANATION OF FUNCTIONALITY

## Table of Contents

1. [System Overview](#system-overview)
2. [5-Phase Orchestrator Lifecycle](#5-phase-orchestrator-lifecycle)
3. [Parallel Worker Management](#parallel-worker-management)
4. [Template System with Inheritance](#template-system-with-inheritance)
5. [Response Parsing System](#response-parsing-system)
6. [Sub-Session Management](#sub-session-management)
7. [JSON Schema Validation](#json-schema-validation)
8. [Worker Timeout and Retry Mechanisms](#worker-timeout-and-retry-mechanisms)
9. [Progress Tracking and State Management](#progress-tracking-and-state-management)
10. [Result Aggregation System](#result-aggregation-system)

---

## System Overview

The Orchestrator System is a sophisticated multi-agent coordination framework that enables Claude to break down complex tasks into parallelizable subtasks, spawn worker sessions to execute them, and aggregate results. The system operates through a structured 5-phase lifecycle managed by several coordinated managers.

### Architecture Components

The orchestrator consists of **five primary managers**:

1. **OrchestratorManager**: Controls the lifecycle, state transitions, and phase progression
2. **WorkerManager**: Spawns, monitors, and manages parallel worker sessions
3. **TemplateManager**: Handles template loading, validation, and inheritance resolution
4. **ResponseParser**: Extracts and validates structured JSON responses from Claude
5. **SubSessionManager**: Manages natural parent-child session relationships for Task tool usage

### Design Philosophy

The system supports **two operational modes**:

1. **Structured Orchestration Mode**: Uses the 5-phase lifecycle with explicit task planning and worker spawning
2. **Natural SubSession Mode**: Allows Claude to spawn Task agents naturally, with automatic result propagation

---

## 5-Phase Orchestrator Lifecycle

The orchestrator follows a **deterministic state machine** with five distinct phases. Each phase has specific responsibilities and transitions to the next phase based on parsed responses from Claude.

### Phase 1: Analysis Phase

**Status**: `ORCHESTRATOR_STATUS.ANALYZING`
**Phase**: `ORCHESTRATOR_PHASE.ANALYSIS`

#### Purpose
The analysis phase is where Claude explores the codebase to understand structure, identify key files, and determine how to break down the user's request into parallelizable tasks.

#### Flow
1. **Orchestrator Creation**: User creates an orchestrator with a template ID and user request
2. **Prompt Generation**: System builds system + user prompts from template with variable substitution
3. **Session Spawning**: Main session is created via CDP with special title prefix `[Orchestrator]`
4. **Message Injection**: System sends the analysis prompt to Claude (with orchestrator badge)
5. **Monitoring Start**: Polling begins to detect Claude's response
6. **Response Detection**: System monitors transcript for `<<<ORCHESTRATOR_RESPONSE>>>` delimiters
7. **Parsing**: ResponseParser extracts the JSON structure with phase: "analysis"
8. **Validation**: Validates required fields: `summary`, `recommended_splits`
9. **State Update**: Stores analysis data in orchestrator state
10. **Phase Transition**: Auto-advances to Task Planning phase

#### Expected Response Format
```json
{
  "phase": "analysis",
  "data": {
    "summary": "1-3 sentence overview of findings",
    "recommended_splits": 3,
    "key_files": ["file1.js", "file2.js"],
    "estimated_complexity": "low|medium|high",
    "components": ["component descriptions"],
    "notes": "Important observations",
    "warnings": ["potential issues"]
  }
}
```

#### Important Implementation Details

- **System Prompt Hiding**: The system prompt is sent first, then a 1.5s delay occurs before sending the user prompt with the orchestrator badge
- **Orchestrator Badge**: User messages get prefixed with `🎭 **ORCHESTRATOR MODE** - {template_name}`
- **Task Tool Detection**: The system warns if Claude spawns a Task() agent instead of returning structured responses, as this bypasses orchestration
- **Transcript Caching**: Monitors `lastTranscriptLength` to avoid re-processing old messages

### Phase 2: Task Planning Phase

**Status**: `ORCHESTRATOR_STATUS.PLANNING` → `ORCHESTRATOR_STATUS.CONFIRMING`
**Phase**: `ORCHESTRATOR_PHASE.TASK_PLANNING`

#### Purpose
Claude creates a detailed task breakdown with dependencies, priorities, and scope definitions. Each task represents an independent unit of work that can be executed by a worker session.

#### Flow
1. **Prompt Injection**: System sends task planning prompt with analysis summary variables
2. **Response Waiting**: Monitors for `<<<ORCHESTRATOR_RESPONSE>>>` with phase: "task_list"
3. **Task Validation**: Validates each task has required fields (id, title, description)
4. **Dependency Analysis**: Computes parallel groups based on task dependencies
5. **Status Change**: Transitions to `CONFIRMING` status (waits for user approval)
6. **Event Emission**: Fires `orchestrator:tasksReady` event

#### Task Structure Requirements
Each task must include:
- `id`: Unique identifier (e.g., "task_001")
- `title`: Short descriptive title
- `description`: Clear explanation of task objectives
- `scope`: Array of file paths the task will work on
- `priority`: Number 1-10 (1 = highest)
- `dependencies`: Array of task IDs that must complete first

#### Parallel Group Computation
The system analyzes task dependencies to create execution groups:

```javascript
// Example: Tasks 1,2,3 have no dependencies → Group 1 (parallel)
// Task 4 depends on [1,2] → Group 2
// Task 5 depends on [4] → Group 3
parallelGroups: [
  ["task_001", "task_002", "task_003"],
  ["task_004"],
  ["task_005"]
]
```

**Algorithm**: Uses a greedy approach to find tasks whose dependencies are all satisfied, groups them together, marks as completed, and repeats until all tasks are grouped.

#### Manual Confirmation
Unlike other phases, this phase **does NOT auto-advance**. The user must explicitly confirm tasks via:
```javascript
orchestratorModule.confirmTasksAndSpawn(orchestratorId, modifications)
```

This allows users to:
- Review the task breakdown
- Skip specific tasks
- Adjust priorities
- Modify task definitions

### Phase 3: Worker Execution Phase

**Status**: `ORCHESTRATOR_STATUS.SPAWNING` → `ORCHESTRATOR_STATUS.RUNNING`
**Phase**: `ORCHESTRATOR_PHASE.WORKER_EXECUTION`

#### Purpose
Spawn worker sessions for each task and monitor their progress. Workers execute in parallel according to dependency constraints.

#### Flow
1. **Worker Spawning**: WorkerManager creates sessions for first parallel group
2. **Prompt Building**: Each worker gets a customized prompt with task details
3. **Session Creation**: Workers are created via CDP with naming convention
4. **Rate Limiting**: Configurable `spawnDelay` (default 500ms) between spawns
5. **Queue Management**: Remaining tasks wait in queue until workers complete
6. **Progress Monitoring**: WorkerManager polls each worker transcript
7. **Status Tracking**: Workers report progress via structured responses
8. **Timeout Detection**: Workers are marked as timed out if inactive too long
9. **Completion Detection**: Workers transition to `completed` when they report success
10. **Queue Processing**: As workers complete, queued tasks spawn into freed slots

#### Worker Session Naming Convention
```
local___orch_{orchestratorId}_worker_{taskId}
```
Example: `local___orch_abc123_worker_task_001`

The double underscore (`___`) makes orchestrator sessions filterable.

#### Worker Lifecycle States
- `pending`: Task queued but not yet spawned
- `spawning`: Session being created
- `running`: Actively executing
- `paused`: Manually paused by user
- `completed`: Successfully finished
- `failed`: Encountered an error
- `timeout`: Exceeded workerTimeout duration
- `cancelled`: Manually cancelled

#### Parallel Execution Control
The `maxWorkers` config limits concurrent workers:
- Default: 5 workers
- When a worker completes, the next queued task spawns
- Ensures resource constraints are respected

#### Progress Reporting
Workers can optionally report progress via:
```json
{
  "phase": "progress",
  "data": {
    "task_id": "task_001",
    "status": "in_progress",
    "progress_percent": 50,
    "current_action": "Currently working on X",
    "files_processed": 3,
    "files_total": 10
  }
}
```

This is **optional** - workers can complete without progress reports.

### Phase 4: Aggregation Phase

**Status**: `ORCHESTRATOR_STATUS.AGGREGATING`
**Phase**: `ORCHESTRATOR_PHASE.AGGREGATION`

#### Purpose
Review all worker outputs, detect conflicts, merge results into a coherent final output.

#### Flow
1. **Trigger**: When all workers complete AND aggregation is enabled in template
2. **Output Collection**: WorkerManager collects all worker outputs
3. **Prompt Injection**: Sends aggregation prompt with all worker results
4. **Claude Review**: Claude analyzes outputs for conflicts/inconsistencies
5. **Conflict Detection**: Identifies duplicate work, file collisions, etc.
6. **Response Parsing**: Extracts aggregation response with status and conflicts
7. **Status Resolution**: Determines if additional user input is needed
8. **Phase Transition**: Advances to verification (if enabled) or completion

#### Expected Response Format
```json
{
  "phase": "aggregation",
  "data": {
    "status": "success|needs_input|failed",
    "summary": "Overview of merged result",
    "conflicts": [
      {
        "type": "file_conflict",
        "description": "Worker 1 and 3 both modified config.js",
        "resolution": "Used Worker 1 version",
        "options": ["Use Worker 1", "Use Worker 3", "Merge manually"]
      }
    ],
    "merged_output": "Description of final result",
    "output_files": ["list/of/modified/files.js"]
  }
}
```

#### Conflict Types
- **File Conflicts**: Multiple workers modified the same file
- **Naming Inconsistencies**: Different conventions across workers
- **Duplicate Work**: Overlapping functionality
- **Missing Integration**: Components not properly connected

#### Skip Conditions
Aggregation phase can be skipped if:
- `template.phases.aggregation.enabled = false`
- Only one worker was spawned
- Workers produced independent outputs with no overlap

### Phase 5: Verification Phase

**Status**: `ORCHESTRATOR_STATUS.VERIFYING` → `ORCHESTRATOR_STATUS.COMPLETED`
**Phase**: `ORCHESTRATOR_PHASE.VERIFICATION`

#### Purpose
Final quality check to ensure output satisfies original request, check for syntax errors, validate completeness.

#### Flow
1. **Trigger**: After aggregation completes (if verification enabled)
2. **Prompt Injection**: Sends verification prompt with merged output
3. **Claude Validation**: Checks syntax, style, completeness
4. **Issue Detection**: Identifies errors, warnings, and suggestions
5. **Auto-Fix Attempt**: Optionally fixes simple issues
6. **Response Parsing**: Extracts verification results
7. **Completion**: Marks orchestrator as completed

#### Expected Response Format
```json
{
  "phase": "verification",
  "data": {
    "status": "passed|failed|passed_with_warnings",
    "summary": "Verification result summary",
    "issues": [
      {
        "severity": "error|warning|info",
        "description": "What the issue is",
        "location": "file.js:line 42",
        "suggested_fix": "How to fix it"
      }
    ],
    "auto_fixed": ["List of automatically fixed issues"]
  }
}
```

#### Verification is Optional
Most templates disable verification (`enabled: false`) because:
- Adds complexity and time
- Claude already validates during implementation
- Can be done manually by user review

---

## Parallel Worker Management

The WorkerManager is responsible for spawning, monitoring, and managing the lifecycle of worker sessions that execute individual tasks.

### Worker Spawning Process

#### 1. Session ID Generation
```javascript
_generateSessionId(orchestratorId, taskId) {
  return `local___orch_${orchestratorId}_worker_${taskId}`;
}
```
The naming convention makes workers:
- Filterable (by `___` prefix)
- Traceable to parent orchestrator
- Linkable to specific tasks

#### 2. Prompt Construction
Workers receive a customized prompt with:
- Task details (ID, title, description, scope)
- Original user request for context
- Worker-specific instructions
- Progress reporting format
- Completion reporting format

Variables substituted:
- `{TASK_ID}`, `{TASK_TITLE}`, `{TASK_DESCRIPTION}`, `{TASK_SCOPE}`
- `{ORIGINAL_REQUEST}`, `{USER_REQUEST}`
- `{CWD}`, `{TEMPLATE_NAME}`

#### 3. CDP Session Creation
```javascript
const session = await cdpController.startNewSessionWithMessage(
  cwd,
  workerPrompt,
  { title: `[Worker] ${task.title}` }
);
```

Creates a new Claude session with the worker prompt as the first message.

#### 4. State Tracking
WorkerManager maintains three maps:
- `workers`: sessionId → WorkerState
- `taskToSession`: taskId → sessionId (reverse lookup)
- `orchestratorWorkers`: orchestratorId → Set<sessionId> (grouping)

### Worker Monitoring

#### Polling Mechanism
Default interval: **2000ms** (2 seconds)

For each active worker:
1. Fetch transcript from CDP
2. Extract new messages since last poll
3. Parse for orchestrator responses
4. Update worker state (progress, status, tool stats)
5. Detect timeout conditions
6. Emit progress events

#### Tool Statistics Extraction
WorkerManager tracks tool usage via pattern matching:
```javascript
TOOL_PATTERNS = {
  read: /(?:Read|Reading|read_file|ReadFile|Glob|glob)/gi,
  write: /(?:Write|Writing|write_file|WriteFile)/gi,
  edit: /(?:Edit|Editing|edit_file|EditFile)/gi,
  bash: /(?:Bash|bash|execute|shell|terminal)/gi,
  search: /(?:Grep|grep|search|ripgrep|rg)/gi,
  web: /(?:WebFetch|WebSearch|web_fetch|web_search)/gi,
  task: /(?:Task\s*\(|subagent|TodoWrite)/gi
}
```

This provides visibility into worker activity without requiring explicit reporting.

### Worker Queue Management

When `maxWorkers` limit is reached, additional tasks are queued.

#### Queue Data Structure
```javascript
taskQueue = [
  {
    orchestratorId: "orch_abc123",
    task: { id: "task_004", title: "...", ... },
    template: { ... },
    variables: { ... }
  },
  ...
]
```

#### Queue Processing
After each worker completion or cancellation:
1. Check available slots: `maxWorkers - activeCount`
2. Filter queue for applicable tasks (by orchestratorId if specified)
3. Spawn workers for up to available slots
4. Apply spawn delay between each spawn
5. Update queue with remaining tasks

### Worker Retry Logic

#### Retry Conditions
Workers can be retried if:
- Status is `failed`, `timeout`, or `cancelled`
- `retryCount < maxRetries` (default: 2)
- Not explicitly disabled via config

#### Retry Process
```javascript
async retryWorker(sessionId) {
  // 1. Validate retry eligibility
  // 2. Increment retryCount
  // 3. Reset worker state
  // 4. Emit retry event
  // Note: Caller must re-spawn the worker
}
```

The retry mechanism **resets the state** but doesn't automatically re-spawn. The caller must handle spawning a new session.

### Worker Cleanup

#### Archive Workers
Moves sessions to archived state (preserves history):
```javascript
await workerManager.archiveWorkers(orchestratorId);
```

#### Delete Workers
Removes workers from internal state (doesn't archive):
```javascript
await workerManager.deleteWorkers(orchestratorId);
```

#### Automatic Cleanup
- Decrements `activeCount` when workers complete/fail
- Removes from internal maps
- Optionally archives sessions

---

## Template System with Inheritance

The template system provides a powerful way to define orchestrator behavior through JSON configuration files with support for inheritance, variable substitution, and validation.

### Template Structure

Templates are JSON files located in:
- **System templates**: `backend/orchestrator/templates/*.json`
- **Custom templates**: `backend/orchestrator/templates/custom/*.json`

### Core Template Fields

```json
{
  "id": "unique-template-id",
  "name": "Human Readable Name",
  "description": "What this template does",
  "icon": "emoji-or-icon-class",
  "version": "1.0.0",
  "author": "system|username",
  "tags": ["category", "tags"],
  "extends": "parent-template-id",
  "config": { ... },
  "phases": { ... },
  "prompts": { ... },
  "variables": { ... },
  "hooks": { ... },
  "ui": { ... }
}
```

### Template Inheritance

#### Inheritance Chain Resolution
Templates can extend other templates using the `extends` field:

```
_default (base)
  ↓
subsession-doc (extends _default)
  ↓
my-custom-doc (extends subsession-doc)
```

**Resolution Process**:
1. Start with child template
2. Recursively load parent templates
3. Deep merge: parent values + child overrides
4. Child values always win in conflicts
5. Arrays are replaced entirely (not merged)
6. Cache resolved result

#### Example: Inheritance Override
```json
// _default.json
{
  "config": {
    "maxWorkers": 5,
    "workerTimeout": 300000
  }
}

// my-template.json
{
  "extends": "_default",
  "config": {
    "maxWorkers": 10  // Overrides parent
    // workerTimeout: 300000 (inherited from parent)
  }
}
```

#### Circular Inheritance Detection
The system prevents circular references:
```javascript
resolveInheritance(template, visited = new Set()) {
  if (visited.has(template.id)) {
    throw new Error(`Circular inheritance detected: ${Array.from(visited).join(' -> ')}`);
  }
  visited.add(template.id);
  // ... resolve parent
}
```

### Variable Substitution

Templates support variable placeholders in prompts using `{VARIABLE_NAME}` syntax.

#### Built-in Variables
- `{USER_REQUEST}`: The original user request
- `{CWD}`: Current working directory
- `{TEMPLATE_NAME}`: Name of the template being used
- `{ORCHESTRATOR_ID}`: ID of the orchestrator instance
- `{ANALYSIS_SUMMARY}`: Summary from analysis phase
- `{RECOMMENDED_SPLITS}`: Number of recommended task splits
- `{KEY_FILES}`: List of key files identified
- `{TASK_COUNT}`: Number of tasks created
- `{TASKS_JSON}`: Full JSON of task list
- `{WORKER_OUTPUTS}`: Collected worker outputs (aggregation phase)
- `{MERGED_OUTPUT}`: Merged output from aggregation

#### Custom Variables
Templates can define custom variables:
```json
{
  "variables": {
    "OUTPUT_FORMAT": "markdown",
    "LANGUAGE": "english",
    "VERBOSITY": "detailed",
    "INCLUDE_EXAMPLES": true
  }
}
```

#### Substitution Process
```javascript
substituteVariables(text, variables) {
  return text.replace(/\{([A-Z_][A-Z0-9_]*)\}/g, (match, varName) => {
    const value = variables[varName];
    if (value === null || value === undefined) return '';
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    if (Array.isArray(value)) return value.join(', ');
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });
}
```

### Template CRUD Operations

#### Create Template
```javascript
await templateManager.createTemplate({
  id: "my-template",
  name: "My Template",
  extends: "_default",
  config: { ... },
  prompts: { ... }
});
```

Validations:
- Cannot overwrite system templates
- ID must be unique
- Must pass schema validation
- Inheritance chain must be valid

#### Update Template
```javascript
await templateManager.updateTemplate("my-template", {
  config: { maxWorkers: 8 }
});
```

Restrictions:
- Cannot update system templates
- ID cannot be changed
- Must maintain valid schema
- Dependent cache is invalidated

#### Delete Template
```javascript
await templateManager.deleteTemplate("my-template");
```

Safety checks:
- Cannot delete system templates
- Cannot delete if other templates extend it
- Removes from filesystem
- Clears resolved cache

#### Duplicate Template
```javascript
await templateManager.duplicateTemplate("system-template", "My Copy");
```

Creates a custom template that extends the original.

### Template Validation

#### Schema-Based Validation
Uses Ajv (Another JSON Validator) with the schema defined in `templates/schema.json`.

#### Validation Process
```javascript
validateTemplate(template) {
  const errors = [];
  const warnings = [];

  // 1. Check required fields: id, name
  // 2. Run Ajv schema validation
  // 3. Check extends reference exists
  // 4. Validate prompts have required fields
  // 5. Check for circular inheritance

  return { valid: errors.length === 0, errors, warnings };
}
```

#### Relaxed Requirements for Inheritance
Templates with `extends` don't need to define all fields:
- Can omit `prompts` (inherited from parent)
- Can omit `config` sections (inherited from parent)
- Only need to override what changes

---

## Response Parsing System

The ResponseParser extracts structured JSON data from Claude's responses using delimiter-based extraction.

### Delimiter Format

**Default Delimiters**:
- Start: `<<<ORCHESTRATOR_RESPONSE>>>`
- End: `<<<END_ORCHESTRATOR_RESPONSE>>>`

Claude wraps JSON responses like this:
```
Here's my analysis of the codebase...

<<<ORCHESTRATOR_RESPONSE>>>
{
  "phase": "analysis",
  "data": {
    "summary": "The project has 3 main components...",
    "recommended_splits": 3
  }
}
<<<END_ORCHESTRATOR_RESPONSE>>>

I recommend breaking this into 3 parallel tasks.
```

### Parsing Process

#### Single Response Parsing
```javascript
parse(text) {
  // 1. Find start delimiter
  const startIndex = text.indexOf(this.delimiterStart);
  if (startIndex === -1) return { found: false };

  // 2. Find end delimiter
  const endIndex = text.indexOf(this.delimiterEnd, startIndex);
  if (endIndex === -1) return { found: false, error: 'Missing end delimiter' };

  // 3. Extract JSON content
  const jsonContent = text.substring(startIndex + delimiterStart.length, endIndex).trim();

  // 4. Parse JSON (with error recovery)
  const extracted = this.extractJSON(jsonContent);

  // 5. Validate structure
  if (!extracted.phase) return { found: true, error: 'Missing required field: phase' };
  if (!extracted.data) return { found: true, error: 'Missing required field: data' };

  // 6. Return parsed result
  return { found: true, phase: extracted.phase, data: extracted.data };
}
```

#### Multiple Response Parsing
Some transcripts may contain multiple responses:
```javascript
parseMultiple(text) {
  const results = [];
  let searchStart = 0;

  while (true) {
    const startIndex = text.indexOf(delimiterStart, searchStart);
    if (startIndex === -1) break;

    const endIndex = text.indexOf(delimiterEnd, startIndex);
    if (endIndex === -1) {
      results.push({ found: false, error: 'Missing end delimiter' });
      break;
    }

    // Extract and parse this block
    const block = extractBlock(startIndex, endIndex);
    results.push(parse(block));

    searchStart = endIndex + delimiterEnd.length;
  }

  return results;
}
```

### JSON Error Recovery

The parser includes aggressive error recovery to handle malformed JSON:

#### Common JSON Errors Fixed
1. **Trailing commas**: `[1, 2, 3,]` → `[1, 2, 3]`
2. **Unquoted keys**: `{key: "value"}` → `{"key": "value"}`
3. **Single quotes**: `{'key': 'value'}` → `{"key": "value"}`
4. **Unquoted string values**: `{key: value}` → `{key: "value"}`
5. **JavaScript comments**: `// comment` and `/* comment */` removed
6. **BOM character**: Removed if present
7. **Escaped newlines**: `\\\n` → `\\n`

#### Error Recovery Process
```javascript
extractJSON(text) {
  // 1. Try parsing as-is
  try { return JSON.parse(text); } catch {}

  // 2. Try fixing common errors
  const fixed = fixCommonJSONErrors(text);
  try { return JSON.parse(fixed); } catch {}

  // 3. Try extracting JSON object from surrounding text
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]); } catch {}

    // Try fixing the extracted JSON
    const fixedExtracted = fixCommonJSONErrors(jsonMatch[0]);
    try { return JSON.parse(fixedExtracted); } catch {}
  }

  // 4. Give up
  return null;
}
```

### Phase Validation

After parsing, the ResponseParser validates the data structure against phase schemas.

#### Phase Schema Structure
```javascript
PHASE_SCHEMAS = {
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
  // ... other phases
}
```

#### Validation Process
```javascript
validatePhase(phase, data) {
  const result = { valid: true, errors: [], warnings: [] };
  const schema = PHASE_SCHEMAS[phase];

  // 1. Check required fields
  for (const field of schema.required) {
    if (data[field] === undefined || data[field] === null) {
      result.valid = false;
      result.errors.push(`Missing required field: ${field}`);
    }
  }

  // 2. Check for unexpected fields
  const allKnownFields = [...schema.required, ...schema.optional];
  for (const field of Object.keys(data)) {
    if (!allKnownFields.includes(field)) {
      result.warnings.push(`Unexpected field: ${field}`);
    }
  }

  // 3. Special validation (e.g., task_list validates each task)
  // 4. Type validation (e.g., progress_percent must be 0-100)

  return result;
}
```

### Fallback Detection

When structured responses aren't found, the parser can attempt keyword-based phase detection.

#### Fallback Patterns
```javascript
FALLBACK_PATTERNS = {
  analysis: [
    /analysis\s+(?:is\s+)?(?:complete|done|finished)/i,
    /(?:found|identified)\s+\d+\s+(?:components?|modules?|files?)/i,
    /recommend(?:ing|s?)\s+\d+\s+(?:tasks?|splits?)/i
  ],
  task_list: [
    /(?:task|breakdown)\s+list\s+(?:is\s+)?(?:ready|complete|created)/i,
    /created?\s+\d+\s+tasks?/i
  ],
  // ... other patterns
}
```

#### Confidence Calculation
```javascript
detectFallback(text) {
  let bestPhase = null;
  let bestCount = 0;

  for (const [phase, patterns] of Object.entries(FALLBACK_PATTERNS)) {
    let matches = 0;
    for (const pattern of patterns) {
      if (pattern.test(text)) matches++;
    }
    if (matches > bestCount) {
      bestCount = matches;
      bestPhase = phase;
    }
  }

  if (bestCount === 0) return { detected: false };

  // Confidence: (matches / total_patterns) * 0.9 + 0.1
  // Max 0.9 since this is heuristic
  const maxPatterns = FALLBACK_PATTERNS[bestPhase].length;
  const confidence = Math.min(0.9, (bestCount / maxPatterns) * 0.9 + 0.1);

  return { detected: true, probablePhase: bestPhase, confidence };
}
```

This provides a fallback mechanism when Claude doesn't use the exact delimiter format.

---

## Sub-Session Management

SubSessionManager provides an alternative to structured orchestration by managing natural parent-child session relationships. This allows Claude to spawn Task agents normally and have results automatically propagated back.

### Operational Model

#### Traditional Orchestration vs SubSession Mode

**Traditional Orchestration**:
- Claude returns structured JSON task lists
- System spawns workers based on task list
- Workers report progress via structured responses
- System aggregates results

**SubSession Mode**:
- Claude spawns Task agents naturally
- System detects Task spawns and links sessions
- Monitors subsession for completion (via inactivity)
- Automatically sends last message back to parent
- No structured responses required

### SubSession Lifecycle

#### 1. Registration
```javascript
registerSubSession(childSessionId, parentSessionId, { taskToolId })
```

Creates a parent-child relationship:
```javascript
{
  childSessionId: "session_xyz",
  parentSessionId: "session_abc",
  taskToolId: "task_001",  // Optional
  createdAt: new Date(),
  lastActivityAt: new Date(),
  status: "active",
  lastAssistantMessage: null,
  messageCount: 0,
  error: null
}
```

Stored in multiple maps:
- `relations`: childSessionId → SubSessionRelation
- `parentToChildren`: parentSessionId → Set<childSessionId>

#### 2. Activity Monitoring

**Polling Interval**: 5000ms (5 seconds)

For each active subsession:
1. Fetch transcript from CDP
2. Compare message count to last poll
3. If new activity: update `lastActivityAt`, reset status to `active`
4. If no activity: check inactivity threshold

#### 3. Inactivity Detection

**Inactivity Threshold**: 60000ms (60 seconds)

When a subsession has been inactive for 60+ seconds:
- Status changes to `completing`
- Enters confirmation period

**Confirmation Delay**: 30000ms (30 seconds)

After an additional 30 seconds of inactivity:
- Status changes to `completed`
- Automatic result extraction begins

Total time from last activity to extraction: **90 seconds**

#### 4. Result Extraction

```javascript
async extractAndReturnResult(childSessionId) {
  // 1. Get transcript
  const transcript = await cdpController.getTranscript(childSessionId);

  // 2. Extract last assistant message
  const lastMessage = findLastAssistantMessage(transcript);

  // 3. Check if parent still exists
  const parentExists = await checkSessionExists(parentSessionId);
  if (!parentExists) {
    updateStatus(childSessionId, 'orphaned');
    return { orphaned: true };
  }

  // 4. Format result with prefix
  const formatted = `**[Resultat de sous-tache]**\n\n${lastMessage}`;

  // 5. Send to parent session
  await cdpController.sendMessage(parentSessionId, formatted);

  // 6. Update status to 'returned'
  updateStatus(childSessionId, 'returned', { returnedAt: new Date() });

  // 7. Optionally archive subsession
  if (config.autoArchiveOnReturn) {
    await cdpController.archiveSession(childSessionId);
  }

  return { success: true, message: lastMessage };
}
```

### Task Spawn Detection

The system can automatically detect when Claude spawns Task agents.

#### Detection Methods

**1. Explicit Registration**
```javascript
subSessionManager.registerTaskSpawn(parentSessionId, taskToolId);
```
Called when system detects Task tool invocation.

**2. Pattern Matching**
```javascript
_extractTaskToolInvocations(content) {
  // Pattern 1: XML-like tool blocks
  const taskToolPattern = /<invoke name="Task"[^>]*>[\s\S]*?<\/antml:invoke>/gi;
  const matches = content.match(taskToolPattern);

  // Pattern 2: Keyword mentions
  if (content.includes('subagent_type') || content.includes('Task tool')) {
    // Task tool was used
  }

  return invocations;
}
```

**3. Time-Window Linking**
```javascript
tryLinkToTaskSpawn(newSessionId) {
  const now = Date.now();

  for (const [parentId, spawn] of pendingTaskSpawns) {
    // Check if within 10-second window
    if (now - spawn.timestamp <= 10000) {
      registerSubSession(newSessionId, parentId, { taskToolId: spawn.taskId });
      pendingTaskSpawns.delete(parentId);
      return true;
    }
  }

  return false;
}
```

When a new session is created within 10 seconds of a Task spawn, they're automatically linked.

### SubSession Status Flow

```
ACTIVE → (60s inactivity) → COMPLETING → (30s more) → COMPLETED → (auto-extract) → RETURNED
  ↓                                                                                      ↓
(parent deleted) → ORPHANED                                                    (optional) ARCHIVED
  ↓
(error during extract) → ERROR
```

### Advantages of SubSession Mode

1. **Natural Workflow**: Claude works normally without learning special formats
2. **Automatic Propagation**: Results return to parent without explicit commands
3. **Flexible Coordination**: Parent decides how to use results
4. **No Protocol Overhead**: No JSON schemas or delimiters required
5. **Graceful Handling**: Orphaned sessions are detected and cleaned up

### Configuration Options

```javascript
{
  pollInterval: 5000,              // How often to check subsessions
  inactivityThreshold: 60000,      // 60s → mark as completing
  confirmationDelay: 30000,        // 30s more → extract result
  resultPrefix: '**[Resultat de sous-tache]**\n\n',
  resultSuffix: '',
  maxMessageLength: 50000,         // Truncate long messages
  autoArchiveOnReturn: false,      // Archive after sending result
  detectTaskSpawn: true,           // Enable auto-detection
  taskSpawnWindow: 10000           // 10s link window
}
```

---

## JSON Schema Validation

The orchestrator uses JSON Schema (draft-07) to validate template structure and ensure correctness.

### Schema Location
`backend/orchestrator/templates/schema.json`

### Validation Library
**Ajv** (Another JSON Validator) - fast JSON schema validator

### Schema Structure

#### Top-Level Requirements
```json
{
  "required": ["id", "name", "prompts"],
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^[a-z0-9_-]+$"
    },
    "name": {
      "type": "string",
      "minLength": 1
    },
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+$"
    }
  }
}
```

### Configuration Schema

```json
{
  "config": {
    "maxWorkers": {
      "type": "integer",
      "minimum": 1,
      "maximum": 20,
      "default": 5
    },
    "workerTimeout": {
      "type": "integer",
      "minimum": 10000,
      "maximum": 3600000,
      "default": 300000
    },
    "parallelExecution": {
      "type": "boolean",
      "default": true
    }
  }
}
```

### Phase Schema Definitions

Each phase has a schema:
```json
{
  "analysisPhase": {
    "enabled": { "type": "boolean", "default": true },
    "timeout": { "type": "integer", "minimum": 10000 },
    "tools": {
      "required": { "type": "array", "items": { "type": "string" } },
      "subagentType": { "enum": ["Explore", "Code", "Edit"] }
    }
  }
}
```

### Prompt Schema

```json
{
  "prompts": {
    "required": ["analysis", "taskPlanning", "worker", "aggregation"],
    "properties": {
      "analysis": {
        "required": ["system"],
        "properties": {
          "system": { "type": "string", "minLength": 1 },
          "user": { "type": "string" }
        }
      }
    }
  }
}
```

### Validation in Practice

#### Template Loading
```javascript
async _loadTemplatesFromDir(dir, isSystem) {
  for (const entry of entries) {
    const template = JSON.parse(content);

    // Validate against schema (non-blocking)
    const validation = this.validateTemplate(template);
    if (!validation.valid) {
      console.warn(`Template ${template.id} has validation errors:`, validation.errors);
      // Still load template, but log warnings
    }

    templates.set(template.id, template);
  }
}
```

#### Template Creation
```javascript
async createTemplate(templateData) {
  // Strict validation before creation
  const validation = this.validateTemplate(templateData);
  if (!validation.valid) {
    throw new Error(`Invalid template: ${validation.errors.join(', ')}`);
  }

  // Proceed with creation
}
```

### Inheritance-Aware Validation

Templates with `extends` have **relaxed validation**:
```javascript
validateTemplate(template) {
  const usesInheritance = !!template.extends;

  if (schemaValidator.errors) {
    for (const err of schemaValidator.errors) {
      // Skip prompts requirement for inherited templates
      if (usesInheritance && err.keyword === 'required' &&
          err.params?.missingProperty === 'prompts') {
        continue;  // They'll inherit prompts from parent
      }
      errors.push(err.message);
    }
  }
}
```

This allows child templates to be minimal, only defining overrides.

---

## Worker Timeout and Retry Mechanisms

The system includes robust timeout detection and retry capabilities to handle worker failures gracefully.

### Timeout Detection

#### Timeout Threshold
**Default**: 300000ms (5 minutes)

Configurable via:
- Template: `config.workerTimeout`
- WorkerManager options: `workerTimeout`

#### Detection Process
```javascript
_isWorkerTimedOut(worker) {
  if (!worker.startedAt || worker.status !== 'running') {
    return false;
  }

  const elapsed = Date.now() - worker.startedAt.getTime();
  return elapsed > this.config.workerTimeout;
}
```

Called during every poll cycle (every 2 seconds).

#### Timeout Handling
```javascript
if (this._isWorkerTimedOut(worker)) {
  worker.status = 'timeout';
  worker.error = `Worker timed out after ${workerTimeout}ms`;
  worker.completedAt = new Date();
  this.activeCount = Math.max(0, this.activeCount - 1);

  this.emit('worker:timeout', {
    sessionId: worker.sessionId,
    orchestratorId: worker.orchestratorId,
    taskId: worker.taskId
  });
}
```

#### Timeout Extension on Activity
If a worker reports progress, the timeout is **NOT** reset. The timeout is based on `startedAt`, not `lastActivityAt`.

This is intentional - workers should complete within the timeout window regardless of progress updates.

### Retry Mechanism

#### Retry Eligibility
Workers can be retried if:
1. Status is `failed`, `timeout`, or `cancelled`
2. `retryCount < maxRetries` (default: 2)
3. `config.retryOnError = true` (default: true)

#### Retry Limits
**Default Maximum**: 2 retries per worker

Configurable via:
- Template: `config.maxRetries`
- WorkerManager options: `retryLimit`

#### Retry Process
```javascript
async retryWorker(sessionId) {
  const worker = this.workers.get(sessionId);

  // 1. Validate eligibility
  if (!['failed', 'timeout', 'cancelled'].includes(worker.status)) {
    throw new Error(`Cannot retry worker in status: ${worker.status}`);
  }

  if (worker.retryCount >= this.config.retryLimit) {
    throw new Error(`Worker exceeded retry limit (${this.config.retryLimit})`);
  }

  // 2. Increment retry count
  worker.retryCount++;

  // 3. Emit retry event
  this.emit('worker:retrying', {
    sessionId,
    orchestratorId: worker.orchestratorId,
    taskId: worker.taskId,
    retryCount: worker.retryCount
  });

  // 4. Reset worker state
  worker.status = 'pending';
  worker.progress = 0;
  worker.currentAction = 'Retrying...';
  worker.error = null;
  worker.output = null;
  worker.outputFiles = [];
  worker.completedAt = null;
  worker.startedAt = null;

  return worker;
}
```

**Note**: The retry mechanism only resets state. The **caller** must re-spawn the worker session.

#### Automatic vs Manual Retry
The current implementation requires **manual retry triggering**:
```javascript
const worker = await workerManager.retryWorker(sessionId);
await workerManager.spawnWorker(orchestratorId, worker.task, template, variables);
```

There is no automatic retry loop. This gives the orchestrator control over retry decisions.

### Worker Cancellation

Workers can be cancelled at any time:
```javascript
async cancelWorker(sessionId) {
  const worker = this.workers.get(sessionId);

  const wasActive = ['running', 'spawning', 'paused'].includes(worker.status);

  worker.status = 'cancelled';
  worker.completedAt = new Date();

  if (wasActive) {
    this.activeCount = Math.max(0, this.activeCount - 1);
  }

  this.emit('worker:cancelled', { sessionId, orchestratorId, taskId });

  // Try to process queue after cancellation
  await this._processQueueIfNeeded();
}
```

Cancellation **frees up a worker slot**, allowing queued tasks to spawn.

### Progress Detection Interval

While not a timeout, the system can detect lack of progress:

**Default**: 30000ms (30 seconds)

If a worker hasn't reported progress in 30 seconds, it might be:
- Stuck in a long operation (acceptable)
- Deadlocked (requires investigation)
- Not following progress reporting guidelines

This is **not enforced** as a hard timeout, but can be monitored via worker statistics.

---

## Progress Tracking and State Management

The orchestrator maintains detailed state for orchestrators, workers, and subsessions with comprehensive progress tracking.

### Orchestrator State Structure

```javascript
{
  // Identity
  id: "orch_abc123def456",
  templateId: "subsession-doc",
  template: { ... },  // Full resolved template
  mainSessionId: "session_xyz",
  cwd: "/path/to/project",
  userRequest: "Original user message",

  // Status and Phase
  status: "analyzing|planning|confirming|spawning|running|aggregating|verifying|completed|error|cancelled|paused",
  currentPhase: "analysis|taskPlanning|workerExecution|aggregation|verification",

  // Phase Results
  analysis: {
    summary: "Analysis summary",
    recommendedSplits: 3,
    keyFiles: ["file1.js", "file2.js"],
    estimatedComplexity: "medium",
    components: [...],
    notes: "...",
    warnings: [...]
  },

  tasks: [
    {
      id: "task_001",
      title: "Task title",
      description: "What to do",
      scope: ["file.js"],
      priority: 1,
      dependencies: []
    },
    ...
  ],

  parallelGroups: [
    ["task_001", "task_002"],
    ["task_003"]
  ],

  // Worker Tracking
  workers: Map<taskId, sessionId>,

  // Statistics
  stats: {
    totalTools: 42,
    reads: 15,
    writes: 8,
    edits: 12,
    bash: 3,
    glob: 2,
    grep: 1,
    task: 0,
    other: 1
  },

  // Custom Variables
  customVariables: { OUTPUT_FORMAT: "markdown" },

  // Timestamps
  createdAt: Date,
  updatedAt: Date,
  startedAt: Date,
  completedAt: Date,

  // Errors
  errors: [
    {
      phase: "analysis",
      error: "Error message",
      timestamp: Date
    }
  ],

  // Pause/Resume
  _previousStatus: "running",
  _previousPhase: "workerExecution"
}
```

### Worker State Structure

```javascript
{
  // Identity
  sessionId: "local___orch_abc123_worker_task_001",
  orchestratorId: "orch_abc123",
  taskId: "task_001",
  task: { ... },  // Full task definition

  // Status
  status: "pending|spawning|running|paused|completed|failed|timeout|cancelled",

  // Progress
  progress: 75,  // 0-100
  currentAction: "Writing documentation for API module",

  // Tool Usage Statistics
  toolStats: {
    total: 23,
    reads: 8,
    writes: 4,
    edits: 7,
    bash: 2,
    search: 1,
    web: 0,
    task: 1
  },

  // Outputs
  output: "Final output text or summary",
  outputFiles: ["docs/api.md", "docs/models.md"],
  outputPreview: "Preview of current output...",
  error: null,  // Error message if failed

  // Retry Tracking
  retryCount: 0,

  // Timestamps
  lastPollAt: Date,
  startedAt: Date,
  completedAt: Date,
  pausedAt: Date  // If paused
}
```

### SubSession State Structure

```javascript
{
  // Relationship
  childSessionId: "session_xyz",
  parentSessionId: "session_abc",
  taskToolId: "task_explore_001",  // Optional

  // Status
  status: "active|completing|completed|returned|orphaned|error",

  // Activity
  lastActivityAt: Date,
  messageCount: 15,

  // Result
  lastAssistantMessage: "Final message from subsession",

  // Error
  error: null,

  // Timestamps
  createdAt: Date,
  returnedAt: Date  // When result was sent to parent
}
```

### State Persistence

#### Orchestrator Persistence
OrchestratorManager persists state to disk:

**Location**: `backend/orchestrator/data/orchestrators.json`

**Serialization**:
```javascript
_serializeState(state) {
  // Convert Map to object
  const workers = {};
  for (const [key, value] of state.workers) {
    workers[key] = value;
  }

  return {
    id: state.id,
    templateId: state.templateId,
    template: state.template,  // Full template for restoration
    mainSessionId: state.mainSessionId,
    cwd: state.cwd,
    userRequest: state.userRequest,
    status: state.status,
    currentPhase: state.currentPhase,
    analysis: state.analysis,
    tasks: state.tasks,
    parallelGroups: state.parallelGroups,
    workers,
    stats: state.stats,
    customVariables: state.customVariables,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    errors: state.errors
  };
}
```

**Auto-Save**: Debounced save triggered on state changes (1 second debounce)

**Restoration**: On initialization, orchestrators are loaded from disk:
```javascript
async loadFromDisk() {
  const data = await fs.readFile(persistencePath, 'utf8');
  const orchestratorData = JSON.parse(data);

  for (const orchData of orchestratorData) {
    const state = this._deserializeState(orchData);
    this.orchestrators.set(state.id, state);
  }
}
```

This allows orchestrators to **survive server restarts**.

### Progress Events

The system emits granular events for state changes:

#### Orchestrator Events
- `orchestrator:created`
- `orchestrator:started`
- `orchestrator:phaseChanged`
- `orchestrator:analysisComplete`
- `orchestrator:tasksReady`
- `orchestrator:progress`
- `orchestrator:completed`
- `orchestrator:error`
- `orchestrator:cancelled`
- `orchestrator:paused`
- `orchestrator:resumed`
- `orchestrator:cleanup`

#### Worker Events
- `worker:spawning`
- `worker:spawned`
- `worker:started`
- `worker:progress`
- `worker:completed`
- `worker:failed`
- `worker:timeout`
- `worker:cancelled`
- `worker:paused`
- `worker:resumed`
- `worker:retrying`
- `workers:archived`

#### SubSession Events
- `subsession:registered`
- `subsession:statusChanged`
- `subsession:activity`
- `subsession:resultReturned`
- `subsession:orphaned`
- `subsession:error`
- `subsession:archived`
- `subsession:unregistered`
- `subsession:monitoring:started`
- `subsession:monitoring:stopped`

#### Event Forwarding
The main OrchestratorModule forwards all sub-manager events:
```javascript
_setupEventForwarding() {
  this.orchestratorManager.on('orchestrator:created', (data) => {
    this.emit('orchestrator:created', data);
  });
  // ... forwards all events
}
```

This allows a single event listener on OrchestratorModule to capture all events.

### State Queries

#### Get Orchestrator Status
```javascript
getStatus(orchestratorId) {
  const state = this.orchestrators.get(orchestratorId);

  return {
    id: state.id,
    status: state.status,
    currentPhase: state.currentPhase,
    taskCount: state.tasks.length,
    completedTasks: countCompletedTasks(state),
    stats: { ...state.stats },
    errors: state.errors.length,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    startedAt: state.startedAt,
    completedAt: state.completedAt
  };
}
```

#### Get Worker by Task
```javascript
getWorkerByTaskId(taskId) {
  const sessionId = this.taskToSession.get(taskId);
  return this.workers.get(sessionId);
}
```

#### Get Active Workers
```javascript
getActiveWorkers(orchestratorId) {
  return this.getAllWorkers(orchestratorId)
    .filter(w => ['running', 'spawning'].includes(w.status));
}
```

#### Get Aggregated Statistics
```javascript
getAggregatedStats(orchestratorId) {
  const workers = this.getAllWorkers(orchestratorId);

  const stats = {
    totalWorkers: workers.length,
    completed: 0,
    failed: 0,
    running: 0,
    averageProgress: 0,
    toolStats: { total: 0, reads: 0, writes: 0, ... }
  };

  for (const worker of workers) {
    // Aggregate by status
    if (worker.status === 'completed') stats.completed++;
    if (worker.status === 'failed') stats.failed++;
    // ...

    // Aggregate tool stats
    for (const [key, value] of Object.entries(worker.toolStats)) {
      stats.toolStats[key] += value;
    }
  }

  stats.averageProgress = Math.round(totalProgress / workers.length);

  return stats;
}
```

---

## Result Aggregation System

The aggregation phase collects outputs from all workers and combines them into a coherent final result.

### Aggregation Trigger

Aggregation begins when:
1. All workers have completed (or failed/timed out)
2. `template.phases.aggregation.enabled = true`
3. Orchestrator is in `workerExecution` phase

```javascript
_updateOrchestratorOnWorkerComplete(data) {
  const allWorkers = this.workerManager.getAllWorkers(orchestratorId);
  const activeWorkers = this.workerManager.getActiveWorkers(orchestratorId);

  if (allWorkers.length > 0 && activeWorkers.length === 0) {
    const hasAggregation = orch.template?.phases?.aggregation?.enabled;
    if (hasAggregation && orch.currentPhase === 'workerExecution') {
      this.orchestratorManager.advanceToPhase(orch.id, 'aggregation');
    }
  }
}
```

### Output Collection

```javascript
collectOutputs(orchestratorId) {
  const workers = this.getAllWorkers(orchestratorId);
  const outputs = [];

  for (const worker of workers) {
    outputs.push({
      taskId: worker.taskId,
      taskTitle: worker.task?.title || worker.taskId,
      status: worker.status,
      output: worker.output,
      outputFiles: worker.outputFiles,
      error: worker.error,
      toolStats: worker.toolStats,
      completedAt: worker.completedAt
    });
  }

  return outputs;
}
```

This creates a structured array of all worker results.

### Aggregation Prompt

The aggregation prompt receives:
- `{WORKER_OUTPUTS}`: JSON array of all worker outputs
- `{ORIGINAL_REQUEST}`: The original user request for context
- `{TASK_COUNT}`: Number of tasks that were executed

Claude receives this information and is instructed to:
1. Review each worker's output
2. Check for conflicts (file collisions, inconsistencies)
3. Detect duplicate work
4. Merge outputs coherently
5. Resolve conflicts or flag for user input

### Aggregation Response

Claude returns a structured response:
```json
{
  "phase": "aggregation",
  "data": {
    "status": "success",
    "summary": "Successfully merged all documentation files into comprehensive docs",
    "conflicts": [
      {
        "type": "naming_convention",
        "description": "Worker 1 used camelCase, Worker 2 used snake_case",
        "resolution": "Normalized to camelCase throughout"
      }
    ],
    "merged_output": "Created 5 documentation files covering all API endpoints",
    "output_files": [
      "docs/api-auth.md",
      "docs/api-users.md",
      "docs/api-posts.md",
      "docs/models.md",
      "docs/utilities.md"
    ]
  }
}
```

### Conflict Types

#### File Conflicts
Multiple workers modified the same file:
```json
{
  "type": "file_conflict",
  "description": "Workers 1 and 3 both modified config.js",
  "files": ["config.js"],
  "workers": ["task_001", "task_003"],
  "resolution": "Used Worker 1's version as it was more comprehensive"
}
```

#### Naming Inconsistencies
Different conventions across workers:
```json
{
  "type": "naming_inconsistency",
  "description": "Inconsistent function naming across modules",
  "resolution": "Standardized to camelCase"
}
```

#### Duplicate Work
Overlapping functionality:
```json
{
  "type": "duplicate_work",
  "description": "Both Workers 2 and 4 created similar helper functions",
  "resolution": "Kept Worker 2's implementation, removed Worker 4's duplicate"
}
```

#### Missing Integration
Components not connected:
```json
{
  "type": "missing_integration",
  "description": "API routes created but not registered in main app",
  "resolution": "Added route registration in app.js"
}
```

### Merge Strategies

Templates can specify merge strategy:

```json
{
  "phases": {
    "aggregation": {
      "mergeStrategy": "concatenate|smart-merge|manual",
      "conflictResolution": "ask|first-wins|last-wins|smart"
    }
  }
}
```

**Concatenate**: Simply combine all outputs in order
**Smart-Merge**: Claude attempts intelligent merging
**Manual**: Flag all conflicts for user resolution

**Conflict Resolution**:
- `ask`: Stop and ask user to resolve
- `first-wins`: First worker's output wins
- `last-wins`: Last worker's output wins
- `smart`: Claude decides based on context

### Status Determination

Aggregation can result in multiple statuses:

**Success**: All outputs merged cleanly
```json
{ "status": "success" }
```

**Needs Input**: Conflicts require user decision
```json
{ "status": "needs_input" }
```

**Failed**: Outputs cannot be reconciled
```json
{ "status": "failed", "error": "Irreconcilable conflicts in core logic" }
```

### Post-Aggregation Flow

After aggregation:
1. If status is `success` and verification disabled → Mark orchestrator `completed`
2. If status is `success` and verification enabled → Advance to `verification` phase
3. If status is `needs_input` → Pause and wait for user decisions
4. If status is `failed` → Mark orchestrator as `error`

### Skipping Aggregation

Aggregation is skipped when:
- `template.phases.aggregation.enabled = false`
- Only one worker was spawned (nothing to merge)
- Workers produced independent outputs with no overlap

In these cases, orchestrator proceeds directly to completion.

---

# PART 2: IMPORTANT VARIABLES/INPUTS/OUTPUTS

## Class Structures and Methods

### OrchestratorManager Class

**File**: `backend/orchestrator/OrchestratorManager.js`

#### Constructor
```javascript
constructor(templateManager, responseParser, cdpController, options = {})
```

**Parameters**:
- `templateManager`: TemplateManager instance
- `responseParser`: ResponseParser instance
- `cdpController`: CDPController instance for session management
- `options.persistenceEnabled`: Boolean (default: true)
- `options.persistencePath`: String (default: `./data/orchestrators.json`)
- `options.saveDebounceMs`: Number (default: 1000)

#### Lifecycle Methods

**create(options)**
```javascript
async create({
  templateId: string,      // Required: Template to use
  cwd: string,            // Required: Working directory
  message: string,        // Required: User request
  customVariables: object // Optional: Variable overrides
}) → Promise<OrchestratorState>
```

**start(orchestratorId)**
```javascript
async start(orchestratorId: string) → Promise<OrchestratorState>
```
Begins analysis phase, creates main session, starts monitoring.

**pause(orchestratorId)**
```javascript
async pause(orchestratorId: string) → Promise<OrchestratorState>
```
Pauses orchestrator, stores previous status for resume.

**resume(orchestratorId)**
```javascript
async resume(orchestratorId: string) → Promise<OrchestratorState>
```
Restores previous status and continues.

**cancel(orchestratorId)**
```javascript
async cancel(orchestratorId: string) → Promise<OrchestratorState>
```
Cancels orchestrator permanently.

#### Monitoring Methods

**startMonitoring()**
```javascript
startMonitoring() → void
```
Starts polling loop (interval: 3000ms).

**stopMonitoring()**
```javascript
stopMonitoring() → void
```
Stops polling loop.

**pollOrchestrator(orchestratorId)**
```javascript
async pollOrchestrator(orchestratorId: string) → Promise<void>
```
Polls a specific orchestrator for new transcript messages.

#### Phase Management

**processPhase(orchestratorId, transcript)**
```javascript
async processPhase(
  orchestratorId: string,
  transcript: object
) → Promise<{
  phaseComplete: boolean,
  nextPhase: string|null,
  error?: string
}>
```

**advanceToPhase(orchestratorId, phase)**
```javascript
async advanceToPhase(
  orchestratorId: string,
  phase: ORCHESTRATOR_PHASE
) → Promise<OrchestratorState>
```

**handleAnalysisResponse(orchestratorId, data)**
```javascript
async handleAnalysisResponse(
  orchestratorId: string,
  data: {
    summary: string,
    recommended_splits: number,
    key_files?: string[],
    estimated_complexity?: string,
    components?: any[],
    notes?: string,
    warnings?: string[]
  }
) → Promise<void>
```

**handleTaskListResponse(orchestratorId, data)**
```javascript
async handleTaskListResponse(
  orchestratorId: string,
  data: {
    tasks: Task[],
    total_tasks?: number,
    parallelizable_groups?: string[][],
    execution_order?: string[]
  }
) → Promise<void>
```

**handleAggregationResponse(orchestratorId, data)**
```javascript
async handleAggregationResponse(
  orchestratorId: string,
  data: {
    status: 'success'|'needs_input'|'failed',
    summary?: string,
    conflicts?: Conflict[],
    merged_output?: string,
    output_files?: string[]
  }
) → Promise<void>
```

#### State Management

**get(orchestratorId)**
```javascript
get(orchestratorId: string) → OrchestratorState | null
```

**getAll()**
```javascript
getAll() → OrchestratorState[]
```

**getStatus(orchestratorId)**
```javascript
getStatus(orchestratorId: string) → {
  id: string,
  status: string,
  currentPhase: string,
  taskCount: number,
  completedTasks: number,
  stats: object,
  errors: number,
  createdAt: Date,
  updatedAt: Date,
  startedAt: Date,
  completedAt: Date
} | null
```

**updateStats(orchestratorId, toolStats)**
```javascript
updateStats(
  orchestratorId: string,
  toolStats: {
    reads?: number,
    writes?: number,
    edits?: number,
    bash?: number,
    // ...
  }
) → void
```

#### Persistence Methods

**loadFromDisk()**
```javascript
async loadFromDisk() → Promise<number>  // Returns count loaded
```

**saveToDisk()**
```javascript
async saveToDisk() → Promise<void>
```

#### Helper Methods

**generatePrompt(template, phase, variables)**
```javascript
generatePrompt(
  template: Template,
  phase: ORCHESTRATOR_PHASE,
  variables: object
) → string
```

**buildWorkerTasks(orchestratorId)**
```javascript
buildWorkerTasks(orchestratorId: string) → {
  orchestratorId: string,
  taskId: string,
  task: Task,
  dependencies: string[],
  priority: number
}[]
```

**cleanup(orchestratorId, options)**
```javascript
async cleanup(
  orchestratorId: string,
  options: {
    archiveWorkers?: boolean,
    deleteWorkers?: boolean,
    removeState?: boolean
  }
) → Promise<void>
```

#### Constants

**ORCHESTRATOR_STATUS**
```javascript
{
  CREATED: 'created',
  ANALYZING: 'analyzing',
  PLANNING: 'planning',
  CONFIRMING: 'confirming',
  SPAWNING: 'spawning',
  RUNNING: 'running',
  AGGREGATING: 'aggregating',
  VERIFYING: 'verifying',
  COMPLETED: 'completed',
  ERROR: 'error',
  CANCELLED: 'cancelled',
  PAUSED: 'paused'
}
```

**ORCHESTRATOR_PHASE**
```javascript
{
  ANALYSIS: 'analysis',
  TASK_PLANNING: 'taskPlanning',
  WORKER_EXECUTION: 'workerExecution',
  AGGREGATION: 'aggregation',
  VERIFICATION: 'verification'
}
```

---

### WorkerManager Class

**File**: `backend/orchestrator/WorkerManager.js`

#### Constructor
```javascript
constructor(cdpController, responseParser, config = {})
```

**Config Options**:
- `maxWorkers`: Number (default: 5)
- `pollInterval`: Number (default: 2000)
- `workerTimeout`: Number (default: 300000)
- `retryLimit`: Number (default: 2)
- `spawnDelay`: Number (default: 500)
- `progressDetectionInterval`: Number (default: 30000)

#### Worker Lifecycle

**spawnWorker(orchestratorId, task, template, variables)**
```javascript
async spawnWorker(
  orchestratorId: string,
  task: Task,
  template: Template,
  variables: object
) → Promise<WorkerState>
```

**spawnBatch(orchestratorId, tasks, template, variables)**
```javascript
async spawnBatch(
  orchestratorId: string,
  tasks: Task[],
  template: Template,
  variables: object
) → Promise<WorkerState[]>
```

**cancelWorker(sessionId)**
```javascript
async cancelWorker(sessionId: string) → Promise<void>
```

**pauseWorker(sessionId)**
```javascript
async pauseWorker(sessionId: string) → Promise<void>
```

**resumeWorker(sessionId)**
```javascript
async resumeWorker(sessionId: string) → Promise<void>
```

**retryWorker(sessionId)**
```javascript
async retryWorker(sessionId: string) → Promise<WorkerState>
```

#### Monitoring

**startMonitoring()**
```javascript
startMonitoring() → void
```

**stopMonitoring()**
```javascript
stopMonitoring() → void
```

**pollWorker(sessionId)**
```javascript
async pollWorker(sessionId: string) → Promise<{
  hasUpdate: boolean,
  state?: WorkerState,
  error?: string
}>
```

**pollAllWorkers()**
```javascript
async pollAllWorkers() → Promise<Array<UpdateResult>>
```

#### State Queries

**getWorker(sessionId)**
```javascript
getWorker(sessionId: string) → WorkerState | null
```

**getWorkerByTaskId(taskId)**
```javascript
getWorkerByTaskId(taskId: string) → WorkerState | null
```

**getAllWorkers(orchestratorId)**
```javascript
getAllWorkers(orchestratorId: string) → WorkerState[]
```

**getActiveWorkers(orchestratorId)**
```javascript
getActiveWorkers(orchestratorId: string) → WorkerState[]
```

**getCompletedWorkers(orchestratorId)**
```javascript
getCompletedWorkers(orchestratorId: string) → WorkerState[]
```

**getFailedWorkers(orchestratorId)**
```javascript
getFailedWorkers(orchestratorId: string) → WorkerState[]
```

#### Task Queue

**queueTasks(tasks)**
```javascript
queueTasks(tasks: Array<{
  orchestratorId: string,
  task: Task,
  template: Template,
  variables: object
}>) → void
```

**processQueue(orchestratorId, template, variables)**
```javascript
async processQueue(
  orchestratorId: string,
  template: Template,
  variables: object
) → Promise<number>  // Returns number of workers spawned
```

#### Results

**collectOutputs(orchestratorId)**
```javascript
collectOutputs(orchestratorId: string) → Array<{
  taskId: string,
  taskTitle: string,
  status: string,
  output: any,
  outputFiles: string[],
  error: string|null,
  toolStats: object,
  completedAt: Date
}>
```

**getAggregatedStats(orchestratorId)**
```javascript
getAggregatedStats(orchestratorId: string) → {
  totalWorkers: number,
  completed: number,
  failed: number,
  running: number,
  pending: number,
  paused: number,
  cancelled: number,
  timeout: number,
  totalProgress: number,
  toolStats: {
    total: number,
    reads: number,
    writes: number,
    edits: number,
    bash: number,
    search: number,
    web: number,
    task: number
  },
  averageProgress: number,
  totalRetries: number
}
```

#### Cleanup

**archiveWorkers(orchestratorId)**
```javascript
async archiveWorkers(orchestratorId: string) → Promise<{
  archived: number,
  errors: Array<{sessionId: string, error: string}>
}>
```

**deleteWorkers(orchestratorId)**
```javascript
async deleteWorkers(orchestratorId: string) → Promise<void>
```

#### WorkerState Type
```typescript
{
  sessionId: string,
  orchestratorId: string,
  taskId: string,
  task: Task,
  status: 'pending'|'spawning'|'running'|'paused'|'completed'|'failed'|'timeout'|'cancelled',
  progress: number,  // 0-100
  currentAction: string,
  toolStats: {
    total: number,
    reads: number,
    writes: number,
    edits: number,
    bash: number,
    search: number,
    web: number,
    task: number
  },
  output: any,
  outputFiles: string[],
  error: string|null,
  retryCount: number,
  lastPollAt: Date|null,
  startedAt: Date|null,
  completedAt: Date|null
}
```

---

### TemplateManager Class

**File**: `backend/orchestrator/TemplateManager.js`

#### Constructor
```javascript
constructor(templatesDir: string)
```

**Properties**:
- `templatesDir`: Root templates directory
- `customDir`: Custom templates subdirectory
- `templates`: Map<id, template> (raw, unresolved)
- `resolvedCache`: Map<id, template> (resolved with inheritance)

#### Initialization

**initialize()**
```javascript
async initialize() → Promise<void>
```
Loads schema and all templates.

**loadSchema()**
```javascript
async loadSchema() → Promise<Function>  // Returns validator function
```

**loadAllTemplates()**
```javascript
async loadAllTemplates() → Promise<Map<id, template>>
```

#### Template CRUD

**getTemplate(id)**
```javascript
async getTemplate(id: string) → Promise<Template>
```
Returns fully resolved template with inheritance.

**getAllTemplates()**
```javascript
async getAllTemplates() → Promise<Array<{
  id: string,
  name: string,
  description: string,
  icon: string|null,
  author: string,
  version: string,
  tags: string[],
  isSystem: boolean,
  isInternal: boolean,
  extends: string|null
}>>
```

**createTemplate(templateData)**
```javascript
async createTemplate(templateData: Partial<Template>) → Promise<Template>
```

Validations:
- Cannot overwrite system templates
- ID must be unique
- Must pass schema validation

**updateTemplate(id, templateData)**
```javascript
async updateTemplate(
  id: string,
  templateData: Partial<Template>
) → Promise<Template>
```

Restrictions:
- Cannot update system templates
- ID cannot be changed

**deleteTemplate(id)**
```javascript
async deleteTemplate(id: string) → Promise<void>
```

Safety:
- Cannot delete system templates
- Cannot delete if other templates extend it

**duplicateTemplate(id, newName)**
```javascript
async duplicateTemplate(
  id: string,
  newName: string
) → Promise<Template>
```

#### Processing

**resolveInheritance(template, visited)**
```javascript
resolveInheritance(
  template: Template,
  visited: Set<string> = new Set()
) → Template
```

**validateTemplate(template)**
```javascript
validateTemplate(template: Template) → {
  valid: boolean,
  errors: string[],
  warnings: string[]
}
```

**substituteVariables(text, variables)**
```javascript
substituteVariables(
  text: string,
  variables: object
) → string
```

#### Helpers

**isSystemTemplate(id)**
```javascript
isSystemTemplate(id: string) → boolean
```

**generateTemplateId(name)**
```javascript
generateTemplateId(name: string) → string
```
Generates URL-safe ID from name, ensures uniqueness.

#### Template Type
```typescript
{
  id: string,
  name: string,
  description?: string,
  icon?: string,
  version?: string,
  author?: string,
  tags?: string[],
  extends?: string,
  config?: {
    maxWorkers?: number,
    workerTimeout?: number,
    autoSpawn?: boolean,
    parallelExecution?: boolean,
    retryOnError?: boolean,
    maxRetries?: number,
    sessionPrefix?: string,
    pollInterval?: number,
    hideWorkersFromList?: boolean
  },
  phases?: {
    analysis?: PhaseConfig,
    taskPlanning?: PhaseConfig,
    workerExecution?: PhaseConfig,
    aggregation?: PhaseConfig,
    verification?: PhaseConfig
  },
  prompts?: {
    responseFormat?: {
      delimiterStart?: string,
      delimiterEnd?: string,
      type?: 'json'|'yaml'|'text'
    },
    analysis?: PromptDefinition,
    taskPlanning?: PromptDefinition,
    worker?: PromptDefinition,
    aggregation?: PromptDefinition,
    verification?: PromptDefinition
  },
  variables?: Record<string, string|number|boolean>,
  hooks?: {
    onAnalysisComplete?: string|null,
    onTasksGenerated?: string|null,
    onWorkerStart?: string|null,
    onWorkerComplete?: string|null,
    onAllWorkersComplete?: string|null,
    onError?: string|null
  },
  ui?: {
    color?: string,
    icon?: string,
    showWorkerDetails?: boolean,
    showTokenEstimate?: boolean,
    showProgressBar?: boolean,
    progressStyle?: 'minimal'|'detailed'|'compact',
    workerColumns?: string[]
  }
}
```

#### PromptDefinition Type
```typescript
{
  system: string,      // Required
  user?: string,
  format?: {
    phase?: string,
    requiredFields?: string[],
    optionalFields?: string[],
    taskSchema?: {
      required?: string[],
      optional?: string[]
    },
    progressPhase?: string,
    completionPhase?: string
  }
}
```

---

### ResponseParser Class

**File**: `backend/orchestrator/ResponseParser.js`

#### Constructor
```javascript
constructor(options = {})
```

**Options**:
- `delimiterStart`: String (default: `<<<ORCHESTRATOR_RESPONSE>>>`)
- `delimiterEnd`: String (default: `<<<END_ORCHESTRATOR_RESPONSE>>>`)

#### Parsing Methods

**parse(text)**
```javascript
parse(text: string) → {
  found: boolean,
  phase?: string,
  data?: object,
  beforeText?: string,
  afterText?: string,
  error?: string,
  raw?: string
}
```

**parseMultiple(text)**
```javascript
parseMultiple(text: string) → Array<ParseResult>
```

#### Validation

**validatePhase(phase, data)**
```javascript
validatePhase(
  phase: string,
  data: object
) → {
  valid: boolean,
  errors: string[],
  warnings: string[]
}
```

#### Fallback Detection

**detectFallback(text)**
```javascript
detectFallback(text: string) → {
  detected: boolean,
  probablePhase: string|null,
  confidence: number  // 0-1
}
```

#### JSON Utilities

**extractJSON(text)**
```javascript
extractJSON(text: string) → object | null
```

**fixCommonJSONErrors(jsonString)**
```javascript
fixCommonJSONErrors(jsonString: string) → string
```

#### Constants

**PHASE_SCHEMAS**
```javascript
{
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
}
```

**FALLBACK_PATTERNS**
```javascript
{
  analysis: [RegExp, ...],
  task_list: [RegExp, ...],
  progress: [RegExp, ...],
  completion: [RegExp, ...],
  error: [RegExp, ...]
}
```

---

### SubSessionManager Class

**File**: `backend/orchestrator/SubSessionManager.js`

#### Constructor
```javascript
constructor(cdpController, config = {})
```

**Config Options**:
- `pollInterval`: Number (default: 5000)
- `inactivityThreshold`: Number (default: 60000)
- `confirmationDelay`: Number (default: 30000)
- `resultPrefix`: String (default: `**[Resultat de sous-tache]**\n\n`)
- `resultSuffix`: String (default: ``)
- `maxMessageLength`: Number (default: 50000)
- `autoArchiveOnReturn`: Boolean (default: false)
- `detectTaskSpawn`: Boolean (default: true)
- `taskSpawnWindow`: Number (default: 10000)

#### Lifecycle

**startMonitoring()**
```javascript
startMonitoring() → void
```

**stopMonitoring()**
```javascript
stopMonitoring() → void
```

#### Registration

**registerSubSession(childSessionId, parentSessionId, options)**
```javascript
registerSubSession(
  childSessionId: string,
  parentSessionId: string,
  options: {
    taskToolId?: string
  }
) → SubSessionRelation
```

**registerTaskSpawn(parentSessionId, taskToolId)**
```javascript
registerTaskSpawn(
  parentSessionId: string,
  taskToolId?: string
) → void
```

**tryLinkToTaskSpawn(newSessionId)**
```javascript
tryLinkToTaskSpawn(newSessionId: string) → boolean
```

#### Queries

**getRelation(childSessionId)**
```javascript
getRelation(childSessionId: string) → SubSessionRelation | null
```

**getChildren(parentSessionId)**
```javascript
getChildren(parentSessionId: string) → SubSessionRelation[]
```

**getActiveChildren(parentSessionId)**
```javascript
getActiveChildren(parentSessionId: string) → SubSessionRelation[]
```

**getByStatus(status)**
```javascript
getByStatus(status: SUBSESSION_STATUS) → SubSessionRelation[]
```

**isSubSession(sessionId)**
```javascript
isSubSession(sessionId: string) → boolean
```

**hasActiveSubSessions(sessionId)**
```javascript
hasActiveSubSessions(sessionId: string) → boolean
```

#### Status Management

**updateStatus(childSessionId, newStatus, updates)**
```javascript
updateStatus(
  childSessionId: string,
  newStatus: SUBSESSION_STATUS,
  updates: object
) → void
```

**recordActivity(childSessionId, messageCount)**
```javascript
recordActivity(
  childSessionId: string,
  messageCount: number
) → void
```

#### Result Handling

**extractAndReturnResult(childSessionId)**
```javascript
async extractAndReturnResult(childSessionId: string) → Promise<{
  success?: boolean,
  alreadyReturned?: boolean,
  orphaned?: boolean,
  message: string,
  formatted?: string
}>
```

**forceReturn(childSessionId)**
```javascript
async forceReturn(childSessionId: string) → Promise<ResultObject>
```

#### Cleanup

**unregister(childSessionId, options)**
```javascript
async unregister(
  childSessionId: string,
  options: {
    archiveSession?: boolean
  }
) → Promise<void>
```

**unregisterAllChildren(parentSessionId, options)**
```javascript
async unregisterAllChildren(
  parentSessionId: string,
  options: object
) → Promise<void>
```

**cleanup(options)**
```javascript
async cleanup(options: {
  maxAge?: number  // Default: 3600000 (1 hour)
}) → Promise<{
  removed: number
}>
```

#### Statistics

**getStats()**
```javascript
getStats() → {
  total: number,
  byStatus: {
    active: number,
    completing: number,
    completed: number,
    returned: number,
    orphaned: number,
    error: number
  },
  parents: number,
  pendingTaskSpawns: number,
  isMonitoring: boolean
}
```

#### Auto-Detection

**scanForTaskSpawns(parentSessionId)**
```javascript
async scanForTaskSpawns(parentSessionId: string) → Promise<Array<TaskInvocation>>
```

**autoDetectNewSessions()**
```javascript
async autoDetectNewSessions() → Promise<number>  // Returns number linked
```

**watchParentSession(parentSessionId)**
```javascript
async watchParentSession(parentSessionId: string) → Promise<void>
```

#### Constants

**SUBSESSION_STATUS**
```javascript
{
  ACTIVE: 'active',
  COMPLETING: 'completing',
  COMPLETED: 'completed',
  RETURNED: 'returned',
  ORPHANED: 'orphaned',
  ERROR: 'error'
}
```

#### SubSessionRelation Type
```typescript
{
  childSessionId: string,
  parentSessionId: string,
  taskToolId: string|null,
  createdAt: Date,
  lastActivityAt: Date,
  status: SUBSESSION_STATUS,
  lastAssistantMessage: string|null,
  messageCount: number,
  error: string|null,
  returnedAt?: Date
}
```

---

### OrchestratorModule Class

**File**: `backend/orchestrator/index.js`

This is the main unified interface that coordinates all managers.

#### Constructor
```javascript
constructor(cdpController, options = {})
```

**Options**:
- `templatesDir`: String (default: `./templates`)
- `parser`: Object (ResponseParser options)
- `worker`: Object (WorkerManager options)
- `orchestrator`: Object (OrchestratorManager options)
- `subSession`: Object (SubSessionManager options)

#### Initialization

**initialize()**
```javascript
async initialize() → Promise<void>
```

#### Manager Access

**templates**
```javascript
get templates() → TemplateManager
```

**orchestrators**
```javascript
get orchestrators() → OrchestratorManager
```

**workers**
```javascript
get workers() → WorkerManager
```

**parser**
```javascript
get parser() → ResponseParser
```

**subSessions**
```javascript
get subSessions() → SubSessionManager
```

#### Convenience Methods

**createAndStart(options)**
```javascript
async createAndStart({
  templateId: string,
  cwd: string,
  message: string,
  customVariables?: object
}) → Promise<OrchestratorState>
```

**getActiveSummary()**
```javascript
getActiveSummary() → Array<{
  id: string,
  templateId: string,
  status: string,
  currentPhase: string,
  taskCount: number,
  activeWorkers: number
}>
```

**confirmTasksAndSpawn(orchestratorId, modifications)**
```javascript
async confirmTasksAndSpawn(
  orchestratorId: string,
  modifications: {
    [taskId: string]: {
      skip?: boolean,
      priority?: number
    }
  }
) → Promise<{
  workersCreated: number,
  tasksQueued: number,
  skipped: number
}>
```

**cancelAndCleanup(orchestratorId, options)**
```javascript
async cancelAndCleanup(
  orchestratorId: string,
  options: {
    archiveWorkers?: boolean,
    deleteWorkers?: boolean,
    removeState?: boolean
  }
) → Promise<{
  cancelled: boolean,
  workers: object,
  archived: boolean
}>
```

---

## Configuration Options

### Orchestrator Configuration

```javascript
{
  // Persistence
  persistenceEnabled: true,
  persistencePath: './data/orchestrators.json',
  saveDebounceMs: 1000,

  // Monitoring
  pollInterval: 3000  // Main orchestrator polling interval
}
```

### Worker Configuration

```javascript
{
  maxWorkers: 5,                    // Max concurrent workers
  pollInterval: 2000,               // Worker polling interval
  workerTimeout: 300000,            // 5 minutes
  retryLimit: 2,                    // Max retries per worker
  spawnDelay: 500,                  // Delay between spawns
  progressDetectionInterval: 30000  // Expected progress interval
}
```

### SubSession Configuration

```javascript
{
  pollInterval: 5000,              // SubSession polling interval
  inactivityThreshold: 60000,      // 60s inactivity → completing
  confirmationDelay: 30000,        // 30s more → extract result
  resultPrefix: '**[Resultat de sous-tache]**\n\n',
  resultSuffix: '',
  maxMessageLength: 50000,
  autoArchiveOnReturn: false,
  detectTaskSpawn: true,
  taskSpawnWindow: 10000           // 10s window for linking
}
```

### Template Configuration

Templates can define configuration that overrides defaults:

```json
{
  "config": {
    "maxWorkers": 5,
    "workerTimeout": 300000,
    "autoSpawn": false,
    "parallelExecution": true,
    "retryOnError": true,
    "maxRetries": 2,
    "sessionPrefix": "__orch_",
    "pollInterval": 2000,
    "hideWorkersFromList": true
  }
}
```

---

## API Endpoints

The orchestrator system is designed to be integrated into a backend server. Expected endpoints:

### Orchestrator Endpoints

**POST /api/orchestrator**
```javascript
{
  templateId: string,
  cwd: string,
  message: string,
  customVariables?: object
}
→ { orchestratorId: string, status: string }
```

**GET /api/orchestrator/:id**
```javascript
→ OrchestratorState
```

**GET /api/orchestrator**
```javascript
→ OrchestratorState[]
```

**POST /api/orchestrator/:id/start**
```javascript
→ { success: boolean }
```

**POST /api/orchestrator/:id/pause**
```javascript
→ { success: boolean }
```

**POST /api/orchestrator/:id/resume**
```javascript
→ { success: boolean }
```

**POST /api/orchestrator/:id/cancel**
```javascript
→ { success: boolean }
```

**POST /api/orchestrator/:id/confirm-tasks**
```javascript
{
  modifications?: {
    [taskId]: { skip?: boolean, priority?: number }
  }
}
→ { workersCreated: number, tasksQueued: number }
```

**DELETE /api/orchestrator/:id**
```javascript
{
  archiveWorkers?: boolean,
  deleteWorkers?: boolean,
  removeState?: boolean
}
→ { success: boolean }
```

### Template Endpoints

**GET /api/orchestrator/templates**
```javascript
→ Template[]
```

**GET /api/orchestrator/templates/:id**
```javascript
→ Template
```

**POST /api/orchestrator/templates**
```javascript
{
  id?: string,
  name: string,
  extends?: string,
  config?: object,
  prompts?: object,
  // ...
}
→ Template
```

**PUT /api/orchestrator/templates/:id**
```javascript
{
  name?: string,
  config?: object,
  // ...
}
→ Template
```

**DELETE /api/orchestrator/templates/:id**
```javascript
→ { success: boolean }
```

**POST /api/orchestrator/templates/:id/duplicate**
```javascript
{
  newName: string
}
→ Template
```

### Worker Endpoints

**GET /api/orchestrator/:id/workers**
```javascript
→ WorkerState[]
```

**GET /api/orchestrator/:id/workers/:sessionId**
```javascript
→ WorkerState
```

**POST /api/orchestrator/:id/workers/:sessionId/cancel**
```javascript
→ { success: boolean }
```

**POST /api/orchestrator/:id/workers/:sessionId/pause**
```javascript
→ { success: boolean }
```

**POST /api/orchestrator/:id/workers/:sessionId/resume**
```javascript
→ { success: boolean }
```

**POST /api/orchestrator/:id/workers/:sessionId/retry**
```javascript
→ { success: boolean }
```

**GET /api/orchestrator/:id/workers/stats**
```javascript
→ AggregatedStats
```

### SubSession Endpoints

**POST /api/subsession/register**
```javascript
{
  childSessionId: string,
  parentSessionId: string,
  taskToolId?: string
}
→ SubSessionRelation
```

**POST /api/subsession/watch/:parentSessionId**
```javascript
→ { success: boolean }
```

**GET /api/subsession/parent/:parentSessionId**
```javascript
→ SubSessionRelation[]
```

**POST /api/subsession/:childSessionId/force-return**
```javascript
→ { success: boolean, message: string }
```

**DELETE /api/subsession/:childSessionId**
```javascript
{
  archiveSession?: boolean
}
→ { success: boolean }
```

**GET /api/subsession/stats**
```javascript
→ SubSessionStats
```

---

## WebSocket Events

Real-time updates via WebSocket:

### Orchestrator Events

```javascript
// Lifecycle
'orchestrator:created' → { id, templateId, cwd, status }
'orchestrator:started' → { id, mainSessionId, phase }
'orchestrator:phaseChanged' → { id, previousPhase, currentPhase, status }
'orchestrator:paused' → { id, previousStatus }
'orchestrator:resumed' → { id, status, phase }
'orchestrator:cancelled' → { id, phase }

// Phase Completion
'orchestrator:analysisComplete' → { id, analysis }
'orchestrator:tasksReady' → { id, taskCount, parallelGroups, tasks }
'orchestrator:completed' → { id, status, aggregation?, stats }

// Progress
'orchestrator:progress' → { id, stats }

// Errors
'orchestrator:error' → { id, operation, error, timestamp }

// Cleanup
'orchestrator:cleanup' → { id, archived, deleted, removed }
```

### Worker Events

```javascript
// Lifecycle
'worker:spawning' → { sessionId, orchestratorId, taskId }
'worker:spawned' → { sessionId, orchestratorId, taskId, task }
'worker:started' → { sessionId, orchestratorId, taskId }
'worker:paused' → { sessionId, orchestratorId, taskId }
'worker:resumed' → { sessionId, orchestratorId, taskId }
'worker:cancelled' → { sessionId, orchestratorId, taskId }

// Progress
'worker:progress' → { sessionId, orchestratorId, taskId, progress, status, currentAction, toolStats }

// Completion
'worker:completed' → { sessionId, orchestratorId, taskId, output, outputFiles }
'worker:failed' → { sessionId, orchestratorId, taskId, error }
'worker:timeout' → { sessionId, orchestratorId, taskId }

// Retry
'worker:retrying' → { sessionId, orchestratorId, taskId, retryCount }

// Cleanup
'workers:archived' → { orchestratorId, count, errors }
'workers:deleted' → { orchestratorId, count }
```

### SubSession Events

```javascript
// Registration
'subsession:registered' → { childSessionId, parentSessionId, taskToolId, timestamp }
'subsession:unregistered' → { childSessionId, parentSessionId, timestamp }

// Status
'subsession:statusChanged' → { childSessionId, parentSessionId, previousStatus, newStatus, timestamp }

// Activity
'subsession:activity' → { childSessionId, parentSessionId, messageCount, timestamp }

// Results
'subsession:resultReturned' → { childSessionId, parentSessionId, messageLength, timestamp }

// Special States
'subsession:orphaned' → { childSessionId, parentSessionId, timestamp }
'subsession:error' → { childSessionId, parentSessionId, error, timestamp }
'subsession:archived' → { childSessionId, timestamp }

// Monitoring
'subsession:monitoring:started' → { timestamp }
'subsession:monitoring:stopped' → { timestamp }
```

### Template Events

```javascript
'template:loaded' → { id, isSystem }
'template:created' → { id, name }
'template:updated' → { id, name }
'template:deleted' → { id }
'template:error' → { file?, error }
```

---

## Response Parser Delimiters and Format

### Delimiter Configuration

**Default Delimiters**:
```javascript
{
  delimiterStart: '<<<ORCHESTRATOR_RESPONSE>>>',
  delimiterEnd: '<<<END_ORCHESTRATOR_RESPONSE>>>'
}
```

**Custom Delimiters** (via template):
```json
{
  "prompts": {
    "responseFormat": {
      "delimiterStart": "<<<CUSTOM_START>>>",
      "delimiterEnd": "<<<CUSTOM_END>>>",
      "type": "json"
    }
  }
}
```

### Response Format

All orchestrator responses follow this structure:

```
[Optional text before]

<<<ORCHESTRATOR_RESPONSE>>>
{
  "phase": "analysis|task_list|progress|completion|aggregation|verification",
  "data": {
    // Phase-specific fields
  }
}
<<<END_ORCHESTRATOR_RESPONSE>>>

[Optional text after]
```

### Phase-Specific Formats

#### Analysis Phase
```json
{
  "phase": "analysis",
  "data": {
    "summary": "string (required)",
    "recommended_splits": "number (required)",
    "key_files": ["string"],
    "estimated_complexity": "low|medium|high",
    "components": ["any"],
    "notes": "string",
    "warnings": ["string"]
  }
}
```

#### Task List Phase
```json
{
  "phase": "task_list",
  "data": {
    "tasks": [
      {
        "id": "string (required)",
        "title": "string (required)",
        "description": "string (required)",
        "scope": ["string"],
        "priority": "number",
        "dependencies": ["string"],
        "estimated_tokens": "number"
      }
    ],
    "total_tasks": "number",
    "parallelizable_groups": [["string"]],
    "execution_order": ["string"]
  }
}
```

#### Progress Phase
```json
{
  "phase": "progress",
  "data": {
    "task_id": "string (required)",
    "status": "in_progress|working|processing (required)",
    "progress_percent": "number (0-100)",
    "current_action": "string",
    "files_processed": "number",
    "files_total": "number",
    "output_preview": "string"
  }
}
```

#### Completion Phase
```json
{
  "phase": "completion",
  "data": {
    "task_id": "string (required)",
    "status": "success|partial|failed|timeout (required)",
    "summary": "string",
    "output_files": ["string"],
    "output": "any",
    "error": "string",
    "warnings": ["string"],
    "metrics": "object"
  }
}
```

#### Aggregation Phase
```json
{
  "phase": "aggregation",
  "data": {
    "status": "success|needs_input|failed (required)",
    "summary": "string",
    "conflicts": [
      {
        "type": "string",
        "description": "string",
        "resolution": "string",
        "options": ["string"]
      }
    ],
    "merged_output": "string",
    "output_files": ["string"]
  }
}
```

#### Verification Phase
```json
{
  "phase": "verification",
  "data": {
    "status": "passed|failed|passed_with_warnings (required)",
    "summary": "string",
    "issues": [
      {
        "severity": "error|warning|info",
        "description": "string",
        "location": "string",
        "suggested_fix": "string"
      }
    ],
    "auto_fixed": ["string"]
  }
}
```

---

## Schema Validation Rules

### Template Validation Rules

#### Required Fields
- `id`: String matching pattern `^[a-z0-9_-]+$`
- `name`: String with minimum length 1
- `prompts`: Object with required prompt definitions

#### Optional Fields
- `description`: String
- `icon`: String (emoji or icon class)
- `version`: String matching pattern `^\d+\.\d+\.\d+$`
- `author`: String
- `tags`: Array of strings
- `extends`: String (parent template ID)
- `config`: Config object
- `phases`: Phases object
- `variables`: Object with string/number/boolean values
- `hooks`: Hooks object
- `ui`: UI configuration object

#### Inheritance Relaxation
Templates with `extends` field don't require:
- `prompts` (inherited from parent)
- All config fields (inherited from parent)

#### Validation Process
1. Check required top-level fields
2. Validate against JSON Schema (if available)
3. Check `extends` reference exists (if specified)
4. For inherited templates, skip missing field errors for inheritable properties
5. Validate prompt structure if present
6. Check for circular inheritance

#### Config Constraints
```javascript
{
  maxWorkers: { min: 1, max: 20, default: 5 },
  workerTimeout: { min: 10000, max: 3600000, default: 300000 },
  maxRetries: { min: 0, max: 5, default: 2 },
  pollInterval: { min: 500, max: 30000, default: 2000 }
}
```

#### Prompt Validation
Each prompt definition must have:
- `system`: Required string with minimum length 1
- `user`: Optional string
- `format`: Optional format specification object

### Response Validation Rules

#### Analysis Response
**Required**: `summary`, `recommended_splits`
**Optional**: `key_files`, `estimated_complexity`, `notes`, `warnings`, `components`

**Type Checks**:
- `recommended_splits` must be number
- `key_files` must be array
- `estimated_complexity` must be string (if present)

#### Task List Response
**Required**: `tasks` (array)
**Optional**: `total_tasks`, `parallelizable_groups`, `execution_order`

**Task Object Required**: `id`, `title`, `description`
**Task Object Optional**: `scope`, `priority`, `dependencies`, `estimated_tokens`

**Type Checks**:
- `tasks` must be array
- `total_tasks` must be number
- Each task must be object with required fields

#### Progress Response
**Required**: `task_id`, `status`
**Optional**: `progress_percent`, `current_action`, `files_processed`, `files_total`, `output_preview`

**Type Checks**:
- `progress_percent` must be number 0-100

#### Completion Response
**Required**: `task_id`, `status`
**Optional**: `summary`, `output_files`, `output`, `error`, `warnings`, `metrics`

**Valid Status Values**: `success`, `partial`, `failed`, `timeout`

**Type Checks**:
- `output_files` must be array

#### Aggregation Response
**Required**: `status`
**Optional**: `summary`, `conflicts`, `merged_output`, `output_files`

**Valid Status Values**: `success`, `needs_input`, `failed`

**Type Checks**:
- `conflicts` must be array
- `output_files` must be array

---

## State Transitions and Lifecycle Events

### Orchestrator State Machine

```
CREATED
  ↓ start()
ANALYZING (phase: analysis)
  ↓ analysis complete
PLANNING (phase: taskPlanning)
  ↓ tasks created
CONFIRMING (waiting for user approval)
  ↓ confirmTasksAndSpawn()
SPAWNING (creating worker sessions)
  ↓ workers spawned
RUNNING (phase: workerExecution)
  ↓ all workers complete
AGGREGATING (phase: aggregation, if enabled)
  ↓ aggregation complete
VERIFYING (phase: verification, if enabled)
  ↓ verification complete
COMPLETED

// Error paths
(any status) → pause() → PAUSED → resume() → (previous status)
(any status) → cancel() → CANCELLED
(any status) → ERROR (on unhandled error)
```

### Worker State Machine

```
PENDING (task queued)
  ↓ slot available
SPAWNING (creating session)
  ↓ session created
RUNNING (executing task)
  ↓ timeout detected
TIMEOUT
  OR
  ↓ completion response
COMPLETED
  OR
  ↓ error
FAILED
  OR
  ↓ user cancels
CANCELLED

// Pause/Resume
RUNNING → pause() → PAUSED → resume() → RUNNING

// Retry
(FAILED|TIMEOUT|CANCELLED) → retry() → PENDING → (respawn)
```

### SubSession State Machine

```
ACTIVE (subsession running)
  ↓ 60s inactivity
COMPLETING (waiting for confirmation)
  ↓ 30s more inactivity
COMPLETED (ready for extraction)
  ↓ extractAndReturnResult()
RETURNED (result sent to parent)
  ↓ (optional) autoArchiveOnReturn
ARCHIVED

// Error paths
(any) → parent deleted → ORPHANED
(any) → extraction error → ERROR

// Resume from inactivity
COMPLETING → new activity → ACTIVE
```

### Phase Transitions

#### Valid Phase Transitions

```
ANALYSIS → TASK_PLANNING (auto)
TASK_PLANNING → (stays in TASK_PLANNING, status: CONFIRMING)
CONFIRMING → WORKER_EXECUTION (manual via confirmTasksAndSpawn)
WORKER_EXECUTION → AGGREGATION (auto, if enabled)
WORKER_EXECUTION → COMPLETED (auto, if aggregation disabled)
AGGREGATION → VERIFICATION (auto, if enabled)
AGGREGATION → COMPLETED (auto, if verification disabled)
VERIFICATION → COMPLETED (auto)
```

#### Phase Skipping

- Aggregation can be skipped if `phases.aggregation.enabled = false`
- Verification can be skipped if `phases.verification.enabled = false`
- If both skipped: `WORKER_EXECUTION → COMPLETED`

---

## Notable TODOs and Implementation Notes

### TODO Comments Found

Based on code analysis, no explicit TODO/FIXME/HACK comments were found in the orchestrator source code. The system appears to be fully implemented.

However, some areas for potential enhancement:

#### Automatic Retry
Currently, retry requires manual triggering. Automatic retry on timeout/failure could be implemented:
```javascript
// In WorkerManager.pollWorker()
if (worker.status === 'timeout' || worker.status === 'failed') {
  if (worker.retryCount < this.config.retryLimit && this.config.autoRetry) {
    await this.retryWorker(worker.sessionId);
    await this.spawnWorker(...);
  }
}
```

#### Hooks Implementation
Template hooks are defined in schema but not implemented:
```json
{
  "hooks": {
    "onAnalysisComplete": "callback-name",
    "onTasksGenerated": "callback-name",
    // ...
  }
}
```

Potential implementation would execute custom code at lifecycle points.

#### Smart Merge Strategy
Aggregation supports `mergeStrategy: "smart-merge"` but implementation details depend on Claude's capabilities. Could be enhanced with conflict resolution algorithms.

#### Template Hot Reload
Currently requires restart to reload templates. Could implement file watcher:
```javascript
fs.watch(templatesDir, async (eventType, filename) => {
  if (filename.endsWith('.json')) {
    await this.templateManager.loadAllTemplates();
  }
});
```

#### Worker Heartbeat
Could implement explicit heartbeat mechanism instead of relying on transcript polling:
```javascript
// Workers periodically send heartbeat
{
  "phase": "heartbeat",
  "data": { "timestamp": "ISO-8601", "alive": true }
}
```

#### Partial Result Recovery
If orchestrator crashes mid-execution, workers continue running but results may be lost. Could implement:
- Periodic worker state snapshots
- Result buffering
- Crash recovery on restart

### Design Decisions and Rationale

#### Why Polling Instead of WebSockets?
The system polls transcripts instead of using WebSockets from CDP because:
- CDP may not support WebSocket subscriptions for all events
- Polling is simpler and more reliable
- 2-3 second intervals provide good responsiveness without overwhelming the system

#### Why Two Operational Modes?
**Structured Mode** (5-phase) provides:
- Deterministic workflow
- Better progress visibility
- Centralized control

**SubSession Mode** provides:
- Natural Claude workflow
- Simpler prompts
- Flexibility in coordination

Supporting both gives users choice based on task complexity.

#### Why Debounced Persistence?
Orchestrator state is saved with 1-second debounce to:
- Reduce disk I/O
- Batch rapid state changes
- Prevent write conflicts

#### Why Session ID Naming Convention?
The `local___orch_` prefix with double underscores:
- Makes orchestrator sessions easily filterable
- Prevents collision with user sessions
- Provides clear hierarchy (orchestrator → worker → task)

---

## Summary

The Orchestrator System is a comprehensive multi-agent coordination framework with:

- **5-Phase Lifecycle**: Analysis → Planning → Execution → Aggregation → Verification
- **Parallel Worker Management**: Spawn, monitor, and coordinate multiple worker sessions
- **Template System**: JSON-based configuration with inheritance and variable substitution
- **Response Parsing**: Extract structured JSON from Claude responses with error recovery
- **Sub-Session Support**: Natural Task spawning with automatic result propagation
- **State Persistence**: Survive server restarts
- **Comprehensive Events**: Real-time progress tracking via EventEmitter
- **Schema Validation**: Ensure template and response correctness

The system supports both **structured orchestration** (explicit task planning and worker spawning) and **natural sub-session mode** (Claude spawns agents freely), providing flexibility for different use cases.

---

**End of Documentation**

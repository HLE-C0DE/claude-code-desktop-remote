# Template System Specification

## Overview

Templates are JSON configuration files that define how an orchestrator behaves. They control:
- Prompts injected at each phase
- Phase enable/disable and configuration
- Worker settings (parallelism, timeouts, retries)
- UI presentation
- Custom variables

## Template Inheritance

All templates inherit from `_default.json`. Custom templates can override any field.

```
_default.json (base)
       │
       ├─── documentation.json (system)
       │
       ├─── exploration.json (system)
       │
       ├─── implementation.json (system)
       │
       └─── custom/
              ├─── my-template.json (user)
              └─── team-workflow.json (user)
```

### Merge Strategy
- Objects: deep merge (child overrides parent)
- Arrays: replace entirely (no merge)
- Primitives: child wins

## Template Schema

### Root Structure

```json
{
  "$schema": "./schema.json",

  "id": "unique-template-id",
  "name": "Human Readable Name",
  "description": "What this template does",
  "icon": "emoji or icon class",
  "version": "1.0.0",
  "author": "system | username",
  "tags": ["documentation", "analysis"],

  "extends": "_default",

  "config": { /* runtime configuration */ },
  "phases": { /* phase definitions */ },
  "prompts": { /* prompt templates */ },
  "variables": { /* custom variables */ },
  "hooks": { /* lifecycle hooks */ },
  "ui": { /* UI customization */ }
}
```

### Config Section

```json
{
  "config": {
    "maxWorkers": 5,
    "workerTimeout": 300000,
    "autoSpawn": true,
    "parallelExecution": true,
    "retryOnError": true,
    "maxRetries": 2,
    "sessionPrefix": "__orch_",
    "pollInterval": 2000,
    "hideWorkersFromList": true
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| maxWorkers | number | 5 | Max concurrent worker sessions |
| workerTimeout | number | 300000 | Worker timeout in ms (5min) |
| autoSpawn | boolean | false | Auto-spawn workers without confirmation |
| parallelExecution | boolean | true | Allow parallel worker execution |
| retryOnError | boolean | true | Retry failed workers |
| maxRetries | number | 2 | Max retry attempts per worker |
| sessionPrefix | string | "__orch_" | Prefix for hidden worker sessions |
| pollInterval | number | 2000 | Transcript polling interval in ms |
| hideWorkersFromList | boolean | true | Hide worker sessions from main list |

### Phases Section

```json
{
  "phases": {
    "analysis": {
      "enabled": true,
      "timeout": 120000,
      "tools": {
        "required": ["Task"],
        "subagentType": "Explore"
      },
      "validation": {
        "requiredFields": ["summary", "recommended_splits"]
      }
    },

    "taskPlanning": {
      "enabled": true,
      "timeout": 180000,
      "validation": {
        "minTasks": 1,
        "maxTasks": 50,
        "requireDependencies": false,
        "requireScope": true
      }
    },

    "workerExecution": {
      "progressReporting": true,
      "progressInterval": 30000,
      "completionMarkers": ["<<<TASK_COMPLETE>>>", "<<<TASK_FAILED>>>"]
    },

    "aggregation": {
      "enabled": true,
      "timeout": 300000,
      "mergeStrategy": "concatenate",
      "conflictResolution": "ask"
    },

    "verification": {
      "enabled": false,
      "timeout": 180000,
      "autoFix": false
    }
  }
}
```

### Prompts Section

```json
{
  "prompts": {
    "responseFormat": {
      "delimiterStart": "<<<ORCHESTRATOR_RESPONSE>>>",
      "delimiterEnd": "<<<END_ORCHESTRATOR_RESPONSE>>>",
      "type": "json"
    },

    "analysis": {
      "system": "System prompt for analysis phase...\n\nAvailable variables:\n- {USER_REQUEST}\n- {CWD}\n- {PROJECT_NAME}",
      "user": "User prompt template with {USER_REQUEST}",
      "format": {
        "phase": "analysis",
        "requiredFields": ["summary", "recommended_splits"],
        "optionalFields": ["key_files", "notes", "warnings", "estimated_complexity"]
      }
    },

    "taskPlanning": {
      "system": "System prompt for task planning...",
      "user": "Create tasks based on: {ANALYSIS_SUMMARY}",
      "format": {
        "phase": "task_list",
        "requiredFields": ["tasks"],
        "optionalFields": ["parallelizable_groups", "execution_order"],
        "taskSchema": {
          "required": ["id", "title", "description"],
          "optional": ["scope", "priority", "dependencies", "estimated_tokens"]
        }
      }
    },

    "worker": {
      "system": "Worker system prompt...",
      "user": "Execute task:\nID: {TASK_ID}\nTitle: {TASK_TITLE}\nDescription: {TASK_DESCRIPTION}\nScope: {TASK_SCOPE}\n\nOriginal request: {ORIGINAL_REQUEST}",
      "format": {
        "progressPhase": "progress",
        "completionPhase": "completion"
      }
    },

    "aggregation": {
      "system": "Aggregation system prompt...",
      "user": "Merge these outputs:\n{WORKER_OUTPUTS}"
    },

    "verification": {
      "system": "Verification system prompt...",
      "user": "Verify this output:\n{MERGED_OUTPUT}"
    }
  }
}
```

### Variables Section

Custom variables that can be used in prompts with `{VARIABLE_NAME}` syntax.

```json
{
  "variables": {
    "OUTPUT_FORMAT": "markdown",
    "LANGUAGE": "english",
    "VERBOSITY": "detailed",
    "INCLUDE_EXAMPLES": true,
    "MAX_FILE_SIZE": 1000,
    "CUSTOM_INSTRUCTION": "Focus on public APIs only"
  }
}
```

### Hooks Section (Future)

```json
{
  "hooks": {
    "onAnalysisComplete": null,
    "onTasksGenerated": "validate-tasks.js",
    "onWorkerStart": null,
    "onWorkerComplete": null,
    "onAllWorkersComplete": "merge-outputs.js",
    "onError": "notify-error.js"
  }
}
```

### UI Section

```json
{
  "ui": {
    "color": "#4A90D9",
    "icon": "file-text",
    "showWorkerDetails": true,
    "showTokenEstimate": true,
    "showProgressBar": true,
    "progressStyle": "detailed",
    "workerColumns": ["status", "progress", "tools", "time"]
  }
}
```

## Default Template (_default.json)

```json
{
  "$schema": "./schema.json",
  "id": "_default",
  "name": "Default Template",
  "description": "Base template - all others inherit from this",
  "version": "1.0.0",
  "author": "system",

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
  },

  "phases": {
    "analysis": {
      "enabled": true,
      "timeout": 120000
    },
    "taskPlanning": {
      "enabled": true,
      "timeout": 180000,
      "validation": {
        "minTasks": 1,
        "maxTasks": 50
      }
    },
    "workerExecution": {
      "progressReporting": true,
      "progressInterval": 30000
    },
    "aggregation": {
      "enabled": true,
      "timeout": 300000,
      "mergeStrategy": "concatenate"
    },
    "verification": {
      "enabled": false
    }
  },

  "prompts": {
    "responseFormat": {
      "delimiterStart": "<<<ORCHESTRATOR_RESPONSE>>>",
      "delimiterEnd": "<<<END_ORCHESTRATOR_RESPONSE>>>",
      "type": "json"
    },

    "analysis": {
      "system": "# ORCHESTRATOR MODE - ANALYSIS PHASE\n\nYou are operating in ORCHESTRATOR MODE. Your role is to ANALYZE and PLAN how to break down the user's request into parallel sub-tasks.\n\n## Instructions:\n1. Use the Task tool with subagent_type=\"Explore\" to understand the codebase\n2. Identify the scope of work needed\n3. Determine optimal task splitting\n\n## Response Format (MANDATORY):\nAfter your analysis, you MUST respond with this exact format:\n\n<<<ORCHESTRATOR_RESPONSE>>>\n{\n  \"phase\": \"analysis\",\n  \"data\": {\n    \"summary\": \"Brief description of what you found\",\n    \"key_files\": [\"list\", \"of\", \"relevant\", \"files\"],\n    \"estimated_complexity\": \"low|medium|high\",\n    \"recommended_splits\": <number>,\n    \"notes\": \"Any important observations\"\n  }\n}\n<<<END_ORCHESTRATOR_RESPONSE>>>\n\nDo NOT proceed to implementation. Wait for further instructions.\n\n{CUSTOM_INSTRUCTIONS}",
      "user": "Analyze this request and plan the task breakdown:\n\n{USER_REQUEST}",
      "format": {
        "requiredFields": ["summary", "recommended_splits"]
      }
    },

    "taskPlanning": {
      "system": "# ORCHESTRATOR MODE - TASK PLANNING\n\nBased on your analysis, create a detailed task list for parallel execution.\n\n## Requirements:\n- Each task should be independently executable\n- Identify dependencies between tasks\n- Group parallelizable tasks together\n\n## Response Format (MANDATORY):\n\n<<<ORCHESTRATOR_RESPONSE>>>\n{\n  \"phase\": \"task_list\",\n  \"data\": {\n    \"total_tasks\": <number>,\n    \"tasks\": [\n      {\n        \"id\": \"task_001\",\n        \"title\": \"Short title\",\n        \"description\": \"What this task should accomplish\",\n        \"scope\": [\"files/to/work/on\"],\n        \"priority\": 1,\n        \"dependencies\": []\n      }\n    ],\n    \"parallelizable_groups\": [[\"task_001\", \"task_002\"], [\"task_003\"]]\n  }\n}\n<<<END_ORCHESTRATOR_RESPONSE>>>",
      "user": "Create the task list based on your analysis:\n\nAnalysis Summary: {ANALYSIS_SUMMARY}\n\nOriginal Request: {USER_REQUEST}",
      "format": {
        "requiredFields": ["tasks"]
      }
    },

    "worker": {
      "system": "# WORKER MODE - TASK EXECUTION\n\nYou are a WORKER agent executing a specific sub-task.\n\n## Your Task:\n- ID: {TASK_ID}\n- Title: {TASK_TITLE}\n- Description: {TASK_DESCRIPTION}\n- Scope: {TASK_SCOPE}\n\n## Instructions:\n1. Focus ONLY on your assigned task\n2. Do NOT work outside your defined scope\n3. Report progress periodically\n4. Report completion when done\n\n## Progress Report (use every few actions):\n<<<ORCHESTRATOR_RESPONSE>>>\n{\"phase\": \"progress\", \"data\": {\"task_id\": \"{TASK_ID}\", \"status\": \"in_progress\", \"progress_percent\": <0-100>, \"current_action\": \"...\"}}\n<<<END_ORCHESTRATOR_RESPONSE>>>\n\n## Completion Report (when done):\n<<<ORCHESTRATOR_RESPONSE>>>\n{\"phase\": \"completion\", \"data\": {\"task_id\": \"{TASK_ID}\", \"status\": \"success\", \"summary\": \"What was done\", \"output_files\": [...]}}\n<<<END_ORCHESTRATOR_RESPONSE>>>\n\n## Error Report (if failed):\n<<<ORCHESTRATOR_RESPONSE>>>\n{\"phase\": \"completion\", \"data\": {\"task_id\": \"{TASK_ID}\", \"status\": \"failed\", \"error\": \"What went wrong\"}}\n<<<END_ORCHESTRATOR_RESPONSE>>>",
      "user": "Execute your assigned task now.\n\nOriginal user request (for context): {ORIGINAL_REQUEST}"
    },

    "aggregation": {
      "system": "# ORCHESTRATOR MODE - AGGREGATION\n\nAll worker tasks are complete. Review and merge the outputs.\n\n## Instructions:\n1. Review each worker's output\n2. Check for conflicts or duplications\n3. Merge into a coherent final result\n4. Report any issues found\n\n## Response Format:\n<<<ORCHESTRATOR_RESPONSE>>>\n{\"phase\": \"aggregation\", \"data\": {\"status\": \"success\", \"summary\": \"...\", \"conflicts\": [], \"merged_output\": \"...\"}}\n<<<END_ORCHESTRATOR_RESPONSE>>>",
      "user": "Merge these worker outputs:\n\n{WORKER_OUTPUTS}"
    }
  },

  "variables": {},

  "ui": {
    "color": "#666666",
    "showWorkerDetails": true,
    "showTokenEstimate": true,
    "progressStyle": "detailed"
  }
}
```

## Example: Documentation Template

```json
{
  "$schema": "./schema.json",
  "id": "documentation",
  "name": "Documentation Generator",
  "description": "Generate structured documentation for a project",
  "icon": "book",
  "version": "1.0.0",
  "author": "system",
  "tags": ["documentation", "analysis", "markdown"],

  "extends": "_default",

  "config": {
    "maxWorkers": 8,
    "autoSpawn": true
  },

  "phases": {
    "verification": {
      "enabled": true,
      "autoFix": false
    }
  },

  "prompts": {
    "analysis": {
      "system": "# DOCUMENTATION ORCHESTRATOR - ANALYSIS\n\nYou are planning documentation generation for a codebase.\n\n## Your Goal:\n1. Explore the codebase structure\n2. Identify documentable components (APIs, modules, configs, etc.)\n3. Recommend how to split the documentation work\n\n## Use Task tool:\nSpawn an Explore agent to analyze the codebase.\n\n## Response Format:\n<<<ORCHESTRATOR_RESPONSE>>>\n{\n  \"phase\": \"analysis\",\n  \"data\": {\n    \"summary\": \"Project overview\",\n    \"key_files\": [\"important files to document\"],\n    \"components\": [\n      {\"type\": \"api\", \"files\": [...], \"complexity\": \"high\"},\n      {\"type\": \"config\", \"files\": [...], \"complexity\": \"low\"}\n    ],\n    \"recommended_splits\": <number>,\n    \"notes\": \"Observations about documentation needs\"\n  }\n}\n<<<END_ORCHESTRATOR_RESPONSE>>>\n\n{CUSTOM_INSTRUCTIONS}",
      "user": "Analyze this project for documentation:\n\n{USER_REQUEST}\n\nOutput format preference: {OUTPUT_FORMAT}\nLanguage: {LANGUAGE}\nVerbosity: {VERBOSITY}"
    },

    "worker": {
      "system": "# DOCUMENTATION WORKER\n\nYou are writing documentation for a specific part of the codebase.\n\n## Your Assignment:\n- Component: {TASK_TITLE}\n- Files: {TASK_SCOPE}\n- Description: {TASK_DESCRIPTION}\n\n## Documentation Guidelines:\n- Format: {OUTPUT_FORMAT}\n- Language: {LANGUAGE}\n- Verbosity: {VERBOSITY}\n- Include examples: {INCLUDE_EXAMPLES}\n\n## Instructions:\n1. Read the relevant files\n2. Understand the functionality\n3. Write clear, structured documentation\n4. Do NOT include implementation code unless examples are requested\n\n## Report completion:\n<<<ORCHESTRATOR_RESPONSE>>>\n{\"phase\": \"completion\", \"data\": {\"task_id\": \"{TASK_ID}\", \"status\": \"success\", \"output_files\": [\"docs/...\"], \"summary\": \"What was documented\"}}\n<<<END_ORCHESTRATOR_RESPONSE>>>",
      "user": "Write documentation for your assigned component.\n\nOriginal request: {ORIGINAL_REQUEST}"
    }
  },

  "variables": {
    "OUTPUT_FORMAT": "markdown",
    "LANGUAGE": "english",
    "VERBOSITY": "detailed",
    "INCLUDE_EXAMPLES": true
  },

  "ui": {
    "color": "#4A90D9",
    "icon": "book"
  }
}
```

## Template Validation

Templates must be validated against the JSON Schema before use:

1. Check required fields (id, name, prompts)
2. Validate prompt format (must include delimiters)
3. Validate phase configuration
4. Check variable references in prompts
5. Validate inheritance chain

## Variable Substitution

Variables in prompts are substituted at runtime:

| Variable | Source | Example |
|----------|--------|---------|
| `{USER_REQUEST}` | Original user message | "Create docs..." |
| `{CWD}` | Working directory | "/home/user/project" |
| `{PROJECT_NAME}` | Extracted from cwd | "my-project" |
| `{ANALYSIS_SUMMARY}` | From analysis phase | "Found 5 modules..." |
| `{TASK_ID}` | Current task ID | "task_001" |
| `{TASK_TITLE}` | Current task title | "API Documentation" |
| `{TASK_DESCRIPTION}` | Task description | "Document REST endpoints" |
| `{TASK_SCOPE}` | Task scope files | "backend/server.js" |
| `{ORIGINAL_REQUEST}` | User's original request | "Create docs..." |
| `{WORKER_OUTPUTS}` | Aggregated outputs | "Worker 1: ...\nWorker 2: ..." |
| `{CUSTOM_INSTRUCTIONS}` | User's custom additions | "Focus on public APIs" |
| Custom variables | From template variables | Any value defined |

## Storage

- System templates: `backend/orchestrator/templates/*.json`
- User templates: `backend/orchestrator/templates/custom/*.json`
- Schema: `backend/orchestrator/templates/schema.json`

Templates are loaded at server startup and cached. Changes require server restart or explicit reload via API.

# Big Tasks / Orchestrator System

## Overview

This documentation describes the "Big Tasks" or "Orchestrator" system - a feature that enables Claude to manage complex, multi-step tasks by spawning and coordinating multiple parallel worker sessions.

## Problem Statement

Claude Code has a built-in Task tool that can spawn subagents, but:
- Subagents cannot spawn other subagents (no nesting)
- Limited to ~7 parallel agents
- No custom control over agent behavior
- No persistent tracking across sessions

Our solution: **Server-side orchestration** that "hacks" Claude by:
1. Injecting specialized prompts that force structured responses
2. Creating multiple hidden sessions as "workers"
3. Monitoring and aggregating results
4. Providing a unified UI for tracking progress

## Documentation Structure

| Document | Description | Implementation Task |
|----------|-------------|---------------------|
| [01-ARCHITECTURE.md](./01-ARCHITECTURE.md) | System overview, flow diagrams, components | Context for all tasks |
| [02-TEMPLATES.md](./02-TEMPLATES.md) | Template system design, schema, inheritance | Task 1: TemplateManager |
| [03-PROTOCOL.md](./03-PROTOCOL.md) | Communication protocol, response formats | Task 2: ResponseParser |
| [04-BACKEND-MODULES.md](./04-BACKEND-MODULES.md) | Backend module specifications | Tasks 3-5: Core modules |
| [05-API-ENDPOINTS.md](./05-API-ENDPOINTS.md) | REST API specifications | Task 6: API routes |
| [06-UI-SPECS.md](./06-UI-SPECS.md) | Frontend UI specifications | Task 7: UI components |
| [07-IMPLEMENTATION-PLAN.md](./07-IMPLEMENTATION-PLAN.md) | Step-by-step plan with prompts | Task orchestration |

## Quick Start for Developers

1. Read [01-ARCHITECTURE.md](./01-ARCHITECTURE.md) for overall understanding
2. Pick a task from [07-IMPLEMENTATION-PLAN.md](./07-IMPLEMENTATION-PLAN.md)
3. Read the corresponding spec document
4. Use the provided context prompt to start a fresh Claude session

## Key Concepts

### Orchestrator
A special session type that coordinates work across multiple worker sessions.

### Template
A JSON configuration that defines how an orchestrator behaves (prompts, phases, settings).

### Worker
A hidden Claude session that executes a specific sub-task assigned by the orchestrator.

### Protocol
The structured JSON format used for communication between our server and Claude.

## File Structure (Target)

```
backend/
  orchestrator/
    index.js                 # Main exports
    OrchestratorManager.js   # Active orchestrator state management
    TemplateManager.js       # Template loading/validation
    ResponseParser.js        # Parse Claude responses
    WorkerManager.js         # Spawn/monitor workers
    templates/
      schema.json            # JSON Schema for validation
      _default.json          # Base template (inheritance)
      documentation.json     # System template
      exploration.json       # System template
      custom/                # User templates

public/
  orchestrator/
    orchestrator-ui.js       # Orchestrator UI logic
    template-editor.js       # Template editor
    orchestrator.css         # Styles
```

# SubSession System

## Overview

The SubSession system provides a **natural, non-intrusive way** to manage multi-agent workflows in Claude Desktop. Instead of requiring Claude to follow a strict structured response protocol, subsessions work by:

1. Letting Claude naturally use the Task tool to spawn agents
2. Automatically detecting when spawned sessions become inactive
3. Returning the last assistant message back to the parent session

This approach aligns better with how Claude Code naturally works and avoids the protocol compliance issues seen with the structured `<<<ORCHESTRATOR_RESPONSE>>>` format.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        PARENT SESSION                                    │
│  (Main Claude instance working on a task)                               │
│                                                                         │
│  1. Claude decides to spawn a Task agent                                │
│  2. SubSessionManager detects Task tool usage                           │
│  3. New session created -> auto-linked as subsession                    │
│  4. Parent continues or waits for results                               │
└─────────────────────────────────────────────────────────────────────────┘
         │                                    ▲
         │ Task tool spawns                   │ Result returned
         ▼                                    │
┌─────────────────────────────────────────────────────────────────────────┐
│                        CHILD SESSION (SubSession)                        │
│                                                                         │
│  1. Receives task from parent                                           │
│  2. Works on the task naturally                                         │
│  3. Becomes inactive (60+ seconds)                                      │
│  4. SubSessionManager detects completion                                │
│  5. Last message extracted and sent to parent                           │
└─────────────────────────────────────────────────────────────────────────┘
```

## SubSession Lifecycle

### Status Flow

```
ACTIVE ──(60s inactivity)──> COMPLETING ──(30s confirm)──> COMPLETED ──> RETURNED
   │                              │                              │
   │                              │                              └──> (archived)
   │                              │
   └──(new activity)──────────────┘

Failure paths:
ACTIVE/COMPLETING ──(session deleted)──> ERROR
ACTIVE/COMPLETING ──(parent deleted)──> ORPHANED
```

### Status Definitions

| Status | Description |
|--------|-------------|
| `active` | Session is actively being used, messages are being exchanged |
| `completing` | Inactivity detected (60s default), waiting for confirmation |
| `completed` | Confirmed done, ready for result extraction |
| `returned` | Result sent back to parent session |
| `orphaned` | Parent session no longer exists |
| `error` | Error during processing |

## Configuration

### Default Settings

```javascript
{
  pollInterval: 5000,              // Poll every 5 seconds
  inactivityThreshold: 60000,      // 60 seconds = mark as completing
  confirmationDelay: 30000,        // 30 seconds additional = confirmed complete
  resultPrefix: '**[Resultat de sous-tache]**\n\n',
  resultSuffix: '',
  maxMessageLength: 50000,         // Truncate long messages
  autoArchiveOnReturn: false,      // Archive session after return
  detectTaskSpawn: true,           // Auto-detect Task tool usage
  taskSpawnWindow: 10000           // 10s window to link new sessions
}
```

### Customization

When creating orchestrators with SubSession mode:

```json
{
  "config": {
    "useSubSessions": true,
    "inactivityThreshold": 45000,    // Shorter inactivity detection
    "confirmationDelay": 15000,      // Faster confirmation
    "autoArchiveOnReturn": true      // Clean up after completion
  }
}
```

## API Reference

### Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/subsessions` | List all subsessions with stats |
| GET | `/api/subsessions/:childId` | Get specific subsession |
| POST | `/api/subsessions/register` | Manually register a subsession |
| POST | `/api/subsessions/:childId/force-return` | Force result return |
| DELETE | `/api/subsessions/:childId` | Unregister a subsession |
| GET | `/api/subsessions/parent/:parentId` | Get children of a parent |
| POST | `/api/subsessions/cleanup` | Cleanup old/orphaned sessions |
| POST | `/api/subsessions/start-monitoring` | Start monitoring loop |
| POST | `/api/subsessions/stop-monitoring` | Stop monitoring loop |
| POST | `/api/subsessions/watch/:parentId` | Watch a parent for Task spawns |
| POST | `/api/subsessions/scan/:parentId` | Scan parent for Task invocations |
| POST | `/api/subsessions/auto-detect` | Trigger auto-detection |

### WebSocket Events

| Event | Description |
|-------|-------------|
| `subsession:registered` | New subsession registered |
| `subsession:statusChanged` | Status changed (active->completing, etc.) |
| `subsession:activity` | New activity detected in subsession |
| `subsession:resultReturned` | Result sent back to parent |
| `subsession:orphaned` | Parent session no longer exists |
| `subsession:error` | Error during processing |
| `subsession:archived` | Session was archived |
| `subsession:monitoring:started` | Monitoring loop started |
| `subsession:monitoring:stopped` | Monitoring loop stopped |

## Usage Examples

### Manual Registration

```javascript
// Register when you know a session is a child of another
POST /api/subsessions/register
{
  "childSessionId": "local_abc123",
  "parentSessionId": "local_xyz789",
  "taskToolId": "task_001"  // optional
}
```

### Watch a Parent Session

```javascript
// Start watching a session for Task tool usage
POST /api/subsessions/watch/local_xyz789

// The system will:
// 1. Scan the session's transcript for Task tool invocations
// 2. Register pending Task spawns
// 3. Auto-link new sessions created within the time window
```

### Force Return

```javascript
// If you need to get results immediately (don't wait for inactivity)
POST /api/subsessions/local_abc123/force-return

// Returns:
{
  "success": true,
  "result": {
    "success": true,
    "message": "The extracted last assistant message...",
    "formatted": "**[Resultat de sous-tache]**\n\nThe extracted..."
  }
}
```

## Templates

### SubSession-Mode Templates

Two new templates are available that use the SubSession system:

#### `subsession-doc` - Documentation Generator
- Lets Claude naturally spawn Task agents to explore and document
- No structured response format required
- Results automatically aggregated

#### `subsession-task` - Complex Task Handler
- For any complex multi-part task
- Claude coordinates work through natural Task spawning
- Suitable for features, refactoring, analysis, etc.

### Template Configuration

```json
{
  "config": {
    "useSubSessions": true,        // Enable SubSession mode
    "autoSpawn": false,            // Don't auto-spawn workers (let Claude decide)
    "inactivityThreshold": 60000,  // 60 seconds
    "confirmationDelay": 30000     // 30 seconds
  },
  "phases": {
    "analysis": { "enabled": true },
    "taskPlanning": { "enabled": false },    // Not needed
    "workerExecution": { "enabled": false }, // Not needed
    "aggregation": { "enabled": false },     // Claude handles this
    "verification": { "enabled": false }     // Optional
  }
}
```

## Comparison with Structured Mode

| Aspect | Structured Mode (`<<<ORCHESTRATOR_RESPONSE>>>`) | SubSession Mode |
|--------|-----------------------------------------------|-----------------|
| **Protocol** | Strict JSON format required | Natural conversation |
| **Compliance** | Often fails when Claude deviates | Always works |
| **Flexibility** | Limited to defined phases | Claude decides workflow |
| **Complexity** | Complex prompts, parsing | Simple detection |
| **Reliability** | Depends on Claude following format | Robust inactivity detection |
| **Use Case** | Predictable, repeatable workflows | Dynamic, adaptive tasks |

## Best Practices

### For Template Authors

1. **Don't require specific formats**: Let Claude work naturally
2. **Provide clear context**: Tell Claude about the Task tool and available agents
3. **Set expectations**: Explain that results will be returned automatically
4. **Keep it simple**: The simpler the instructions, the better compliance

### For API Users

1. **Watch parent sessions early**: Call `/watch/:parentId` before the task starts
2. **Don't poll too aggressively**: The system handles polling internally
3. **Handle orphaned sessions**: Clean up periodically with `/cleanup`
4. **Use force-return sparingly**: Let the inactivity detection work naturally

### For Claude Prompts

1. **Mention the return mechanism**: "Your Task agent's results will be returned automatically"
2. **Encourage natural workflow**: "Use Task agents whenever you need specialized help"
3. **Don't over-specify**: Avoid micromanaging how Claude should structure its work

## Troubleshooting

### Results Not Returning

1. Check if the subsession is registered: `GET /api/subsessions`
2. Verify the session exists and has messages
3. Check if the last message is from the assistant
4. Try force-return: `POST /api/subsessions/:id/force-return`

### Sessions Not Being Detected

1. Ensure `detectTaskSpawn: true` in config
2. Check if parent is being watched: `POST /api/subsessions/watch/:parentId`
3. Verify the timing - new sessions must appear within `taskSpawnWindow` (10s default)
4. Manually trigger detection: `POST /api/subsessions/auto-detect`

### Parent Not Receiving Results

1. Check parent session still exists
2. Verify subsession status is `returned`
3. Check for errors in the event stream
4. Look at server logs for `[SubSessionManager]` messages

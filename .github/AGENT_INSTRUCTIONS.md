# Instructions for Claude and AI Agents

## 🚨 MANDATORY DOCUMENTATION REQUIREMENT

If you are Claude (or any AI agent) working on this codebase, you **MUST** follow this protocol:

### Step 1: Read Documentation FIRST
**BEFORE writing, modifying, or analyzing ANY code**, you MUST read the relevant documentation from `DocClaude/`.

### Step 2: Locate the Right Documentation
Start with: [`DocClaude/DocClaude_00_INDEX.md`](../DocClaude/DocClaude_00_INDEX.md)

This index will direct you to the specific documentation file(s) for your task:

| Your Task | Required Reading |
|-----------|------------------|
| Authentication, security, sessions, PIN | `DocClaude_Authentication.md` |
| CDP, command injection, process detection | `DocClaude_CDPInjection.md` |
| Session caching, polling, lifecycle | `DocClaude_SessionManagement.md` |
| Orchestrator, workers, templates | `DocClaude_Orchestrator.md` |
| UI, frontend, components | `DocClaude_Frontend.md` |
| WebSocket, real-time events | `DocClaude_WebSocket.md` |
| API endpoints, routes | `DocClaude_APIEndpoints.md` |
| Translations, i18n | `DocClaude_i18n.md` |
| Usage tracking, token counting | `DocClaude_UsageTracking.md` |

### Step 3: Read BOTH Parts
Each documentation file has:
- **PART 1**: Verbose explanation of how the system works
- **PART 2**: API reference with functions, variables, inputs, outputs

**You MUST read BOTH parts completely.**

### Step 4: Reference Code Examples
Every documentation file contains 50+ real code examples. Study them before writing new code.

### Step 5: Follow Established Patterns
The documentation shows you the existing patterns. Follow them to maintain consistency.

### Step 6: NOW Read the Source Code
Only after completing steps 1-5 should you read the actual source files.

---

## Why This Matters

### Without Reading Documentation:
- ❌ You will waste time reading thousands of lines of code
- ❌ You will miss important context and architectural decisions
- ❌ You risk breaking existing functionality
- ❌ You may recreate features that already exist
- ❌ Your code will be inconsistent with established patterns
- ❌ You won't understand security implications
- ❌ You'll miss documented API contracts

### With Documentation:
- ✅ Understand the system in minutes instead of hours
- ✅ Know exactly which functions to call
- ✅ Understand all data structures
- ✅ Follow security best practices
- ✅ Maintain API compatibility
- ✅ Write consistent, maintainable code
- ✅ Complete tasks faster and more accurately

---

## What's in the Documentation

- **200,000 words** of technical documentation
- **87+ API endpoints** fully documented
- **46 WebSocket events** catalogued
- **100+ functions** with complete signatures
- **500+ code examples** from actual codebase
- **15+ classes** with full method references
- **All data structures** defined TypeScript-style
- **Security mechanisms** explained in detail
- **Performance characteristics** documented
- **Integration patterns** between systems

---

## Workflow Example

**WRONG ❌:**
```
User: "Add a new API endpoint for deleting sessions"
Claude: [Reads backend/server.js, guesses at patterns, writes code]
→ Result: Inconsistent with other endpoints, missing rate limiting, wrong auth
```

**CORRECT ✅:**
```
User: "Add a new API endpoint for deleting sessions"
Claude: [Reads DocClaude_APIEndpoints.md]
        [Sees all 87 endpoints with patterns]
        [Reads DocClaude_Authentication.md for auth requirements]
        [Reads DocClaude_SessionManagement.md for session lifecycle]
        [References existing DELETE endpoint patterns]
        [Implements following documented conventions]
→ Result: Consistent, secure, properly rate-limited, follows patterns
```

---

## Quick Reference Links

- **Master Index**: [`DocClaude/DocClaude_00_INDEX.md`](../DocClaude/DocClaude_00_INDEX.md)
- **Quick Lookup**: [`DocClaude/README.md`](../DocClaude/README.md)
- **Main README**: [`README.md`](../README.md)
- **Project Root**: `C:\Users\lescu\Desktop\Projects\ClaudeCode_Remote`

---

## Known TODOs

Only **1 TODO** exists in the entire codebase:

- **File**: `public/app.js:4335`
- **TODO**: `// TODO: Open template manager modal`
- **Status**: Not implemented (UI feature for template management)
- **Impact**: Low (API works, UI convenience missing)

Do NOT implement this TODO unless specifically requested by the user.

---

## Enforcement

This is **NOT optional**. This is a **MANDATORY requirement** for all AI agents working on this codebase.

Every time you are asked to modify code:

1. ✅ Read the documentation first
2. ✅ Understand the architecture
3. ✅ Reference existing patterns
4. ✅ THEN write code

---

## Questions?

If you're unsure which documentation to read, start with the Master Index:
[`DocClaude/DocClaude_00_INDEX.md`](../DocClaude/DocClaude_00_INDEX.md)

It has a complete overview and will guide you to the right files.

---

## Searching Documentation

Use the **Grep tool** to search across documentation files:

- **Find which docs mention a topic**:
  ```
  Grep pattern:"your_topic" path:"DocClaude/" output_mode:"files_with_matches"
  ```

- **Find specific content**:
  ```
  Grep pattern:"function_name" path:"DocClaude/" output_mode:"content"
  ```

- **Search specific documentation file**:
  ```
  Grep pattern:"API" path:"DocClaude/DocClaude_APIEndpoints.md" output_mode:"content" -C:3
  ```

---

**Last Updated**: 2026-01-18
**Documentation Coverage**: 100%

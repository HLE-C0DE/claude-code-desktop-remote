# Documentation Search Guide for Claude

## 🔍 How to Search Documentation Files

As Claude Code CLI agent, you have powerful search tools at your disposal. **DO NOT** use `Ctrl+F` or browser-based search - use the proper CLI tools.

---

## Primary Tool: Grep

The **Grep tool** is your primary search mechanism for documentation.

### Basic Searches

#### 1. Find Which Docs Mention a Topic
```
Grep pattern:"your_search_term" path:"DocClaude/" output_mode:"files_with_matches"
```

**Example**: Find docs mentioning "authentication"
```
Grep pattern:"authentication" path:"DocClaude/" output_mode:"files_with_matches"
```

**Result**: List of files containing "authentication"

---

#### 2. Search for Content Across All Docs
```
Grep pattern:"your_search_term" path:"DocClaude/" output_mode:"content"
```

**Example**: Find all mentions of "sessionCache"
```
Grep pattern:"sessionCache" path:"DocClaude/" output_mode:"content"
```

**Result**: Lines containing "sessionCache" with file paths

---

#### 3. Search Specific Documentation File
```
Grep pattern:"search_term" path:"DocClaude/DocClaude_FileName.md" output_mode:"content"
```

**Example**: Find API endpoint details
```
Grep pattern:"POST /api" path:"DocClaude/DocClaude_APIEndpoints.md" output_mode:"content"
```

---

#### 4. Search with Context Lines
```
Grep pattern:"search_term" path:"DocClaude/" output_mode:"content" -C:3
```

**Example**: Find WebSocket events with context
```
Grep pattern:"session-updated" path:"DocClaude/DocClaude_WebSocket.md" output_mode:"content" -C:5
```

**Result**: Matching lines with 5 lines of context before and after

---

#### 5. Case-Insensitive Search
```
Grep pattern:"search_term" path:"DocClaude/" output_mode:"content" -i:true
```

**Example**: Find "API" or "api"
```
Grep pattern:"api" path:"DocClaude/" output_mode:"content" -i:true
```

---

## Secondary Tool: Read

Use **Read tool** to view complete documentation files.

### Reading Complete File
```
Read file_path:"DocClaude/DocClaude_00_INDEX.md"
```

### Reading Specific Section (with offset/limit)
```
Read file_path:"DocClaude/DocClaude_APIEndpoints.md" offset:500 limit:100
```

**Use case**: When you know approximately where information is located

---

## Search Strategies

### Strategy 1: Topic Discovery
**Goal**: "I need to work on X, which docs should I read?"

```bash
# Step 1: Check the index first
Read file_path:"DocClaude/DocClaude_00_INDEX.md"

# Step 2: Search for your topic across all docs
Grep pattern:"your_topic" path:"DocClaude/" output_mode:"files_with_matches"

# Step 3: Read the relevant doc(s)
Read file_path:"DocClaude/DocClaude_[RelevantDoc].md"
```

---

### Strategy 2: Function/API Lookup
**Goal**: "I need to find where function X is documented"

```bash
# Search for the function name
Grep pattern:"functionName" path:"DocClaude/" output_mode:"content" -C:5

# This gives you context around the function
```

---

### Strategy 3: Understanding a System
**Goal**: "I need to understand how authentication works"

```bash
# Step 1: Find the right doc
Grep pattern:"authentication" path:"DocClaude/" output_mode:"files_with_matches"

# Step 2: Read PART 1 for concepts
Read file_path:"DocClaude/DocClaude_Authentication.md" limit:500

# Step 3: Search for specific aspects
Grep pattern:"PIN validation" path:"DocClaude/DocClaude_Authentication.md" output_mode:"content" -C:10

# Step 4: Read PART 2 for API reference
Read file_path:"DocClaude/DocClaude_Authentication.md" offset:1000
```

---

### Strategy 4: Finding Code Examples
**Goal**: "I need an example of how to use X"

```bash
# Search for code blocks mentioning your topic
Grep pattern:"Example.*your_topic" path:"DocClaude/" output_mode:"content" -C:20

# Or search for function calls
Grep pattern:"functionName\(" path:"DocClaude/" output_mode:"content" -C:10
```

---

### Strategy 5: Understanding Dependencies
**Goal**: "What other systems does X interact with?"

```bash
# Search for mentions in multiple doc files
Grep pattern:"system_name" path:"DocClaude/" output_mode:"content"

# Check which docs mention it
Grep pattern:"system_name" path:"DocClaude/" output_mode:"files_with_matches"

# Read those docs to understand interactions
```

---

## Common Search Patterns

### Find All API Endpoints
```
Grep pattern:"^(GET|POST|PUT|DELETE|PATCH)" path:"DocClaude/DocClaude_APIEndpoints.md" output_mode:"content"
```

### Find All WebSocket Events
```
Grep pattern:"Event:" path:"DocClaude/DocClaude_WebSocket.md" output_mode:"content"
```

### Find Function Signatures
```
Grep pattern:"function.*\(.*\)" path:"DocClaude/" output_mode:"content"
```

### Find Data Structures
```
Grep pattern:"interface|type|class" path:"DocClaude/" output_mode:"content" -C:10
```

### Find Configuration Options
```
Grep pattern:"config|configuration|options" path:"DocClaude/" output_mode:"content" -i:true
```

### Find Security Information
```
Grep pattern:"security|auth|token|session" path:"DocClaude/" output_mode:"content" -i:true
```

---

## Advanced Grep Features

### Regular Expressions
```
Grep pattern:"API.*endpoint" path:"DocClaude/" output_mode:"content"
```

### Multiple File Types
```
Grep pattern:"search_term" path:"DocClaude/" glob:"*.md" output_mode:"content"
```

### Limit Results
```
Grep pattern:"search_term" path:"DocClaude/" output_mode:"content" head_limit:20
```

---

## Quick Reference Table

| Task | Command |
|------|---------|
| Find relevant docs | `Grep pattern:"topic" path:"DocClaude/" output_mode:"files_with_matches"` |
| Search all docs | `Grep pattern:"term" path:"DocClaude/" output_mode:"content"` |
| Search specific file | `Grep pattern:"term" path:"DocClaude/File.md" output_mode:"content"` |
| Get context | Add `-C:5` for 5 lines of context |
| Case insensitive | Add `-i:true` |
| Read full doc | `Read file_path:"DocClaude/File.md"` |
| Read section | `Read file_path:"DocClaude/File.md" offset:500 limit:100` |

---

## Common Mistakes to Avoid

❌ **DON'T**: Use "Ctrl+F" (no GUI)
❌ **DON'T**: Use bash `grep` command (use Grep tool instead)
❌ **DON'T**: Use `cat` to read files (use Read tool)
❌ **DON'T**: Search without checking index first

✅ **DO**: Use Grep tool for searching
✅ **DO**: Use Read tool for reading files
✅ **DO**: Start with `DocClaude_00_INDEX.md`
✅ **DO**: Use appropriate output modes

---

## Examples by Use Case

### "I need to add a new API endpoint"
```bash
# 1. Find API endpoint documentation
Read file_path:"DocClaude/DocClaude_00_INDEX.md"

# 2. Search for endpoint patterns
Grep pattern:"POST /api" path:"DocClaude/DocClaude_APIEndpoints.md" output_mode:"content" -C:10

# 3. Read authentication requirements
Grep pattern:"authentication" path:"DocClaude/DocClaude_APIEndpoints.md" output_mode:"content" -C:5

# 4. Check middleware patterns
Grep pattern:"middleware" path:"DocClaude/" output_mode:"content"
```

### "I need to understand session management"
```bash
# 1. Read session management doc
Read file_path:"DocClaude/DocClaude_SessionManagement.md"

# 2. Search for cache mechanism
Grep pattern:"cache" path:"DocClaude/DocClaude_SessionManagement.md" output_mode:"content" -C:5

# 3. Find related systems
Grep pattern:"session" path:"DocClaude/" output_mode:"files_with_matches"
```

### "I need to modify the frontend"
```bash
# 1. Read frontend architecture
Read file_path:"DocClaude/DocClaude_Frontend.md" limit:500

# 2. Search for specific component
Grep pattern:"component_name" path:"DocClaude/DocClaude_Frontend.md" output_mode:"content" -C:10

# 3. Check WebSocket integration
Grep pattern:"WebSocket" path:"DocClaude/DocClaude_Frontend.md" output_mode:"content"
```

---

## Pro Tips

1. **Always start with the index**: `Read file_path:"DocClaude/DocClaude_00_INDEX.md"`
2. **Use files_with_matches first**: Narrow down which docs to read
3. **Then use content mode**: Get detailed information
4. **Add context**: Use `-C:5` or `-C:10` for surrounding lines
5. **Combine tools**: Grep to find, Read to understand
6. **Search before reading**: Know what you're looking for
7. **Read BOTH parts**: PART 1 (concepts) + PART 2 (API reference)

---

## Remember

- Documentation is **200,000 words** across 10 files
- Use **Grep** to find what you need quickly
- Use **Read** to understand completely
- **Never** start coding without searching docs first

---

**Last Updated**: 2026-01-18

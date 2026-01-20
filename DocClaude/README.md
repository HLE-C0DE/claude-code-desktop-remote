# 📚 ClaudeCode_Remote Documentation

## 🚨 ATTENTION: This Documentation is MANDATORY

If you're Claude (or any AI agent) working on this codebase: **STOP**. Read this documentation BEFORE touching any code.

---

## 📖 Start Here

**Master Index**: [DocClaude_00_INDEX.md](./DocClaude_00_INDEX.md)

This index contains:
- Complete project overview
- Documentation file navigation
- TODO findings from codebase
- Quick reference guide by task type

---

## 📋 All Documentation Files

| File | System Covered | Size | Key Topics |
|------|----------------|------|------------|
| [DocClaude_00_INDEX.md](./DocClaude_00_INDEX.md) | Master Index | 15 KB | Overview, navigation, TODO tracker |
| [DocClaude_Authentication.md](./DocClaude_Authentication.md) | Auth & Security | 66 KB | PIN auth, sessions, rate limiting, IP blacklisting |
| [DocClaude_CDPInjection.md](./DocClaude_CDPInjection.md) | CDP Integration | 80 KB | Chrome DevTools Protocol, 9 injection strategies |
| [DocClaude_SessionManagement.md](./DocClaude_SessionManagement.md) | Sessions | 57 KB | Session lifecycle, caching, polling, cleanup |
| [DocClaude_Orchestrator.md](./DocClaude_Orchestrator.md) | Orchestration | 97 KB | 5-phase lifecycle, workers, templates, parsing |
| [DocClaude_Frontend.md](./DocClaude_Frontend.md) | Frontend UI | 71 KB | SPA architecture, components, rendering, state |
| [DocClaude_WebSocket.md](./DocClaude_WebSocket.md) | Real-time Comms | 97 KB | WebSocket events, broadcasting, reconnection |
| [DocClaude_APIEndpoints.md](./DocClaude_APIEndpoints.md) | REST API | 79 KB | All 87+ endpoints with request/response schemas |
| [DocClaude_i18n.md](./DocClaude_i18n.md) | Internationalization | 35 KB | Language detection, translations, 200+ keys |
| [DocClaude_UsageTracking.md](./DocClaude_UsageTracking.md) | Usage Tracking | 82 KB | Token counting, plan detection, sliding window |

**Total**: 696 KB (~200,000 words of technical documentation)

---

## 🎯 Quick Task Lookup

### "I need to fix authentication"
→ [DocClaude_Authentication.md](./DocClaude_Authentication.md)

### "I need to modify session behavior"
→ [DocClaude_SessionManagement.md](./DocClaude_SessionManagement.md)

### "I need to work on the UI"
→ [DocClaude_Frontend.md](./DocClaude_Frontend.md) + [DocClaude_i18n.md](./DocClaude_i18n.md)

### "I need to add/modify API endpoints"
→ [DocClaude_APIEndpoints.md](./DocClaude_APIEndpoints.md)

### "I need to work on WebSocket events"
→ [DocClaude_WebSocket.md](./DocClaude_WebSocket.md)

### "I need to modify orchestrator system"
→ [DocClaude_Orchestrator.md](./DocClaude_Orchestrator.md) ⚠️ Read the ENTIRE file - it's complex!

### "I need to work on CDP/command injection"
→ [DocClaude_CDPInjection.md](./DocClaude_CDPInjection.md)

### "I need to modify usage tracking"
→ [DocClaude_UsageTracking.md](./DocClaude_UsageTracking.md)

### "I need to add translations"
→ [DocClaude_i18n.md](./DocClaude_i18n.md)

---

## 📚 Documentation Structure

Each documentation file has **2 PARTS**:

### PART 1: Verbose Explanation of Functionality
- How the system works (conceptual understanding)
- Architecture and design philosophy
- Workflows and lifecycle diagrams
- Integration with other systems
- Security considerations
- Performance characteristics

### PART 2: Important Variables/Inputs/Outputs
- Complete API reference
- Function signatures with parameters and return types
- Data structure definitions (TypeScript-style)
- Configuration options
- Error codes and responses
- Code examples and usage patterns

---

## ✅ Pre-Work Checklist

**BEFORE touching ANY code:**

- [ ] I have read [DocClaude_00_INDEX.md](./DocClaude_00_INDEX.md)
- [ ] I have identified which system(s) I'll be working with
- [ ] I have read the COMPLETE documentation file(s) for those systems
- [ ] I have studied PART 1 to understand the architecture
- [ ] I have referenced PART 2 for specific implementations
- [ ] I have reviewed code examples in the documentation
- [ ] I understand the data structures and API signatures
- [ ] I know which other systems are affected by my changes
- [ ] NOW I can read the actual code files

---

## 🎓 Why This Documentation Matters

### Without Documentation:
- ❌ Hours spent reading code to understand architecture
- ❌ Risk of breaking existing functionality
- ❌ Recreating features that already exist
- ❌ Inconsistent patterns across codebase
- ❌ Breaking API contracts
- ❌ Misunderstanding WebSocket event structure
- ❌ Security vulnerabilities from not understanding auth flow

### With Documentation:
- ✅ Understand architecture in minutes
- ✅ Follow established patterns
- ✅ Know all existing endpoints/events
- ✅ Maintain API compatibility
- ✅ Implement features correctly first time
- ✅ Understand security implications
- ✅ Speed up development significantly

---

## 📊 What's Documented

- ✅ **87+ API endpoints** with complete request/response schemas
- ✅ **46 WebSocket events** with payload structures
- ✅ **100+ functions** with signatures and descriptions
- ✅ **15+ classes** with complete method references
- ✅ **200+ translation keys** catalogued and organized
- ✅ **500+ code examples** showing real usage
- ✅ **All data structures** defined TypeScript-style
- ✅ **Security mechanisms** explained in detail
- ✅ **Performance characteristics** documented
- ✅ **Error handling** strategies covered

---

## 🚀 Getting Started

1. **New to the project?**
   - Start with [DocClaude_00_INDEX.md](./DocClaude_00_INDEX.md)
   - This gives you complete project overview in 15 KB

2. **Working on specific feature?**
   - Use the Quick Task Lookup above
   - Read the COMPLETE documentation file (both parts)

3. **Making changes?**
   - Reference documentation for existing patterns
   - Update documentation if you change behavior
   - Check which other systems are affected

---

## 💡 Pro Tips

1. **Use Grep tool to search**: Documentation is searchable - find exactly what you need
   - Example: `Grep pattern:"WebSocket" path:"DocClaude/" output_mode:"files_with_matches"`
   - Search specific doc: `Grep pattern:"API" path:"DocClaude/DocClaude_APIEndpoints.md" output_mode:"content"`
2. **Read BOTH parts**: PART 1 for concepts, PART 2 for implementation
3. **Check examples**: Every file has 50+ real code examples
4. **Cross-reference**: Complex tasks involve multiple systems - read all related docs
5. **Trust the docs**: They're accurate (generated from actual codebase analysis)
6. **Use Read tool efficiently**: Use offset/limit parameters for large files if needed

---

## 🔍 Known TODOs

Only **1 TODO** found in entire codebase:

- **File**: `public/app.js:4335`
- **TODO**: `// TODO: Open template manager modal`
- **Context**: UI feature for orchestrator template management
- **Impact**: Low (API exists, UI missing)
- **Details**: See [DocClaude_Orchestrator.md](./DocClaude_Orchestrator.md)

---

## 📝 Documentation Maintenance

If you **add new features** or **change existing behavior**:

1. Update the relevant documentation file(s)
2. Follow the same 2-part structure
3. Add code examples
4. Update data structure definitions
5. Update the INDEX if you add new major systems

---

## 🎯 Documentation Quality Guarantee

Each file includes:
- ✅ Extremely verbose explanations
- ✅ Complete API references
- ✅ Real code examples from the codebase
- ✅ Data structure definitions
- ✅ Sequence diagrams (text format)
- ✅ Error handling documentation
- ✅ Configuration options
- ✅ Security considerations
- ✅ Performance notes
- ✅ Integration patterns

---

## 📅 Documentation Info

- **Created**: 2026-01-18
- **Coverage**: 100% of major systems
- **Format**: Markdown
- **Total Size**: 696 KB
- **Total Words**: ~200,000
- **Code Examples**: 500+

---

## ⚠️ Final Warning

**This documentation is MANDATORY, not optional.**

Skipping documentation leads to:
- Bugs from misunderstanding
- Wasted time
- Broken integrations
- Inconsistent code
- Security issues

**Reading documentation first leads to:**
- Faster development
- Correct implementations
- Consistent patterns
- Maintained architecture
- Better code quality

---

**Start with**: [DocClaude_00_INDEX.md](./DocClaude_00_INDEX.md)

**Last Updated**: 2026-01-18

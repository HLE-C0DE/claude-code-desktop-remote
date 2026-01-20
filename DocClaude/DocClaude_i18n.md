# ClaudeCode_Remote - Internationalization (i18n) System Documentation

**File**: `public/i18n.js`
**Test Interface**: `public/test-i18n.html`
**Last Updated**: 2026-01-18

---

## PART 1: VERBOSE EXPLANATION OF FUNCTIONALITY

### Overview

The i18n system is a **lightweight, class-based internationalization solution** designed to provide bilingual support (French and English) across the ClaudeCode_Remote web interface. The system is built with a focus on simplicity, performance, and seamless user experience without requiring page reloads.

### Architecture and Design Philosophy

The i18n implementation follows these core principles:

1. **Single Global Instance**: The system creates one global `I18n` class instance (`window.i18n`) that is shared across all pages.

2. **Namespace-Based Organization**: Translations are organized into logical namespaces (e.g., `launcher`, `app`, `home`, `session`) that correspond to different parts of the application interface.

3. **No External Dependencies**: The system is self-contained with no external libraries, keeping the bundle size minimal.

4. **Fallback Strategy**: All translations fall back to French (`fr`) if a key is missing in the current language, and ultimately return the key itself if not found anywhere.

5. **Client-Side Only**: Language detection and switching happen entirely in the browser without server-side involvement.

### Language Detection System

The language detection follows a **3-tier priority system**:

#### Priority 1: User Preference (Saved in LocalStorage)
- **Key**: `claudecode_lang`
- **Values**: `'fr'` or `'en'`
- If a user has previously selected a language, it is stored and takes precedence over all other methods.

#### Priority 2: Browser Locale Detection
- **Method**: `navigator.language || navigator.userLanguage`
- **Logic**: If the browser language starts with `'fr'` (e.g., `fr-FR`, `fr-CA`), French is selected; otherwise, English is chosen.
- This automatic detection happens **only on the first visit** when no saved preference exists.

#### Priority 3: Default Fallback
- **Default**: English (`'en'`)
- Used if neither saved preference nor browser detection provides a valid result.

**Implementation Flow**:
```javascript
detectLanguage() {
    // 1. Check localStorage first
    const savedLang = localStorage.getItem('claudecode_lang');
    if (savedLang && (savedLang === 'fr' || savedLang === 'en')) {
        return savedLang;
    }

    // 2. Detect from browser on first load
    const browserLang = navigator.language || navigator.userLanguage;
    const detectedLang = (browserLang && browserLang.toLowerCase().startsWith('fr')) ? 'fr' : 'en';

    // 3. Save detected language for future visits
    localStorage.setItem('claudecode_lang', detectedLang);

    return detectedLang;
}
```

### Translation Key Organization and Namespacing

Translations are structured as a **nested object hierarchy** with two levels:

1. **Top Level**: Language code (`fr`, `en`)
2. **Second Level**: Feature namespace (`launcher`, `app`, `home`, `session`, etc.)
3. **Third Level**: Specific translation keys

**Example Structure**:
```javascript
translations = {
    fr: {
        launcher: {
            title: "🚀 ClaudeCode_Remote",
            subtitle: "Votre serveur est prêt !"
        },
        app: {
            backBtn: "← Retour",
            loading: "Chargement..."
        }
    },
    en: { /* ... */ }
}
```

**Key Naming Conventions**:
- Use **camelCase** for key names (e.g., `serverActive`, `scanQR`)
- Use descriptive names that indicate the UI element (e.g., `copyBtn`, `shareTitle`)
- Group related translations under the same namespace

### Dynamic Language Switching Without Page Reload

The system supports **instant language switching** through the following mechanism:

1. **Language Toggle**: Users can switch languages using the `toggleLanguage()` method.
2. **State Update**: The new language is saved to `localStorage` and the `currentLang` property is updated.
3. **DOM Update**: The HTML document's `lang` attribute is updated: `document.documentElement.lang = lang`
4. **UI Re-render**: The application re-renders translated text by calling translation functions again.

**No Page Reload Required**: All language changes happen in-memory, making the switch instantaneous.

**Implementation**:
```javascript
setLanguage(lang) {
    if (lang === 'fr' || lang === 'en') {
        this.currentLang = lang;
        localStorage.setItem('claudecode_lang', lang);
        document.documentElement.lang = lang;
        return true;
    }
    return false;
}

toggleLanguage() {
    const newLang = this.getAlternativeLanguage();
    this.setLanguage(newLang);
    return newLang;
}
```

### Fallback Mechanism to English

The translation retrieval system implements a **robust fallback chain**:

1. **Primary Lookup**: Try to find the key in the current language.
2. **Fallback to French**: If not found, search in French translations.
3. **Key Return**: If still not found, return the original key string.

This ensures that missing translations never break the UI - they simply display the key name or the French version.

**Implementation Details**:
```javascript
t(key, replacements = {}) {
    const keys = key.split('.');
    let value = this.translations[this.currentLang];

    // Navigate through nested object
    for (const k of keys) {
        if (value && typeof value === 'object') {
            value = value[k];
        } else {
            // Fallback to French
            value = this.translations['fr'];
            for (const k2 of keys) {
                if (value && typeof value === 'object') {
                    value = value[k2];
                } else {
                    return key; // Return key if not found
                }
            }
            break;
        }
    }

    // Apply variable substitution
    if (typeof value === 'string') {
        for (const [placeholder, replacement] of Object.entries(replacements)) {
            value = value.replace(new RegExp(`\\{${placeholder}\\}`, 'g'), replacement);
        }
    }

    return value || key;
}
```

### DOM Attribute System (data-i18n)

The system includes **limited support** for DOM-based translation via the `data-i18n` attribute:

**Current Implementation**:
- Only one instance found in the codebase: `data-i18n-loading` in `launcher.html`
- This appears to be a **legacy or planned feature** that is not actively used
- Most translations are applied programmatically via JavaScript

**How It Would Work** (if fully implemented):
```html
<span data-i18n="app.backBtn"></span>
<!-- Would be replaced with: "← Retour" or "← Back" -->
```

**Note**: The main application uses **programmatic translation** via `window.i18n.t()` rather than DOM attributes.

### Plural Forms Handling

**Current Status**: The system does **NOT have built-in plural form handling**.

**Workaround Used**:
The application uses variable interpolation with conditional logic in the calling code:

```javascript
// Example from pinLogin.attemptsWarning
// French: "Attention: {count} tentative{plural} restante{plural}"
// English: "Warning: {count} attempt{plural} remaining"

// Usage would require manual plural logic:
const plural = count > 1 ? 's' : '';
const message = t('pinLogin.attemptsWarning', { count, plural });
```

**Limitation**: This approach requires developers to manually handle plural logic in the calling code rather than in the translation strings themselves.

### Variable Interpolation in Translations

The system supports **placeholder-based variable substitution** using curly braces `{variableName}`.

**Syntax**: `{placeholder}` in translation strings

**Examples**:
```javascript
// Translation definitions:
launcher: {
    emailBody: "Bonjour,\n\nVoici le lien :\n\n{url}\n\nÀ bientôt !",
    shareMessage: "🚀 Accède à mon serveur :\n{url}",
    logsCount: "{count} logs"
}

// Usage:
t('launcher.emailBody', { url: 'https://example.com' })
// Result: "Bonjour,\n\nVoici le lien :\n\nhttps://example.com\n\nÀ bientôt !"

t('launcher.logsCount', { count: 42 })
// Result: "42 logs"
```

**Multiple Variables**:
```javascript
// Translation:
app: {
    inMinutes: "dans {minutes} min",
    inHours: "dans {hours}h {minutes}min"
}

// Usage:
t('app.inHours', { hours: 2, minutes: 30 })
// Result: "dans 2h 30min"
```

**Implementation**:
- Uses **RegEx replacement** with global flag
- All placeholders in a string are replaced in a single pass
- Placeholders can appear multiple times and will all be replaced

### Dynamic Content Translation

The application uses **JavaScript-driven dynamic translation** rather than automatic DOM scanning.

**Pattern Used in app.js**:
```javascript
// Helper function for easy translation access
function t(key, replacements = {}) {
    return window.i18n ? window.i18n.t(key, replacements) : key.split('.').pop();
}
```

**Common Usage Patterns**:

1. **Direct DOM Manipulation**:
```javascript
document.getElementById('page-title').textContent = t('launcher.title');
document.getElementById('status-text').textContent = t('launcher.serverActive');
```

2. **Template Literals**:
```javascript
const html = `
    <button>${t('app.close')}</button>
    <span>${t('app.loading')}</span>
`;
```

3. **Dynamic Updates on Language Change**:
```javascript
function updateAllTranslations() {
    document.getElementById('result-1').textContent = t('launcher.title');
    document.getElementById('result-2').textContent = t('launcher.subtitle');
    // ... update all UI elements
}

function toggleLanguage() {
    window.i18n.toggleLanguage();
    updateAllTranslations(); // Re-render UI
}
```

### RTL (Right-to-Left) Support

**Current Status**: **NO RTL support implemented**

The system only supports left-to-right (LTR) languages (French and English). There is:
- No `dir` attribute management
- No RTL-specific CSS
- No Arabic, Hebrew, or other RTL language support

**Future Implementation** would require:
```javascript
setLanguage(lang) {
    // ... existing code ...
    const rtlLanguages = ['ar', 'he'];
    document.documentElement.dir = rtlLanguages.includes(lang) ? 'rtl' : 'ltr';
}
```

### Translation Loading and Initialization

**Loading Strategy**: **Inline/Embedded**

All translations are **embedded directly in the i18n.js file** as a JavaScript object. This means:

1. **No Async Loading**: Translations are immediately available on script load
2. **No Network Requests**: No separate JSON files to fetch
3. **Single Bundle**: All languages load together (small size impact given only 2 languages)

**Initialization Flow**:
```javascript
// 1. Define translations object (lines 4-524)
const translations = { fr: {...}, en: {...} };

// 2. Create I18n class (lines 527-623)
class I18n {
    constructor() {
        this.currentLang = this.detectLanguage(); // Auto-detect
        this.translations = translations;
    }
}

// 3. Create global instance (line 626)
window.i18n = new I18n();

// 4. Ready to use immediately
console.log(window.i18n.t('launcher.title')); // Works immediately
```

**Advantages**:
- Zero latency
- No loading states needed
- Works offline immediately

**Disadvantages**:
- All translations load even if only one language is used
- Cannot dynamically load additional languages
- Bundle size increases with more languages

### Performance Considerations

#### Memory Footprint
- **Translation Storage**: ~20-30 KB for both French and English combined
- **Single Instance**: Only one `I18n` object created globally
- **No Caching Layer**: Direct object property access is fast enough

#### Runtime Performance
- **Translation Lookup**: O(n) where n = depth of key (typically 2-3 levels)
- **Variable Replacement**: O(m) where m = number of placeholders
- **No Pre-compilation**: Translations are resolved on each call

#### Optimization Strategies Used
1. **Simple Object Access**: No complex parsing or compilation
2. **Direct Property Navigation**: Uses standard JavaScript object traversal
3. **RegEx Caching**: RegEx patterns are created on-demand but not cached (potential improvement area)

#### Potential Optimizations
```javascript
// Current: Creates new RegEx each time
value.replace(new RegExp(`\\{${placeholder}\\}`, 'g'), replacement)

// Optimized: Cache compiled RegEx patterns
// Could implement a RegEx cache for frequently used placeholders
```

#### Browser Compatibility
- **Modern Browsers**: Full support (ES6+ syntax used)
- **localStorage**: Required (graceful degradation could be added)
- **Navigator API**: Standard `navigator.language` detection

---

## PART 2: IMPORTANT VARIABLES/INPUTS/OUTPUTS

### I18n Class API

#### Constructor
```javascript
new I18n()
```
- **Returns**: `I18n` instance
- **Side Effects**:
  - Auto-detects language
  - Sets `document.documentElement.lang`
  - May write to `localStorage`

#### Methods

##### `detectLanguage()`
```javascript
detectLanguage(): string
```
- **Returns**: `'fr'` or `'en'`
- **Logic**:
  1. Check `localStorage.getItem('claudecode_lang')`
  2. Check `navigator.language`
  3. Default to `'en'`
- **Side Effects**: Writes to localStorage on first detection

##### `setLanguage(lang)`
```javascript
setLanguage(lang: string): boolean
```
- **Parameters**:
  - `lang` (string): Must be `'fr'` or `'en'`
- **Returns**: `true` if successful, `false` if invalid language
- **Side Effects**:
  - Updates `this.currentLang`
  - Writes to `localStorage.setItem('claudecode_lang', lang)`
  - Sets `document.documentElement.lang`

##### `t(key, replacements)`
```javascript
t(key: string, replacements?: object): string
```
- **Parameters**:
  - `key` (string): Dot-separated translation key (e.g., `'app.backBtn'`)
  - `replacements` (object, optional): Key-value pairs for variable substitution
- **Returns**: Translated string or the key itself if not found
- **Examples**:
  ```javascript
  t('launcher.title')
  // Returns: "🚀 ClaudeCode_Remote"

  t('launcher.shareMessage', { url: 'https://example.com' })
  // Returns: "🚀 Accède à mon serveur :\nhttps://example.com"

  t('app.logsCount', { count: 5 })
  // Returns: "5 logs"
  ```

##### `getCurrentLanguage()`
```javascript
getCurrentLanguage(): string
```
- **Returns**: Current language code (`'fr'` or `'en'`)
- **Example**: `window.i18n.getCurrentLanguage() // 'fr'`

##### `getCurrentLanguageName()`
```javascript
getCurrentLanguageName(): string
```
- **Returns**: Full name of current language
  - `'Français'` if current language is French
  - `'English'` if current language is English

##### `getAlternativeLanguage()`
```javascript
getAlternativeLanguage(): string
```
- **Returns**: The opposite language code
  - Returns `'en'` if current is `'fr'`
  - Returns `'fr'` if current is `'en'`

##### `getAlternativeLanguageName()`
```javascript
getAlternativeLanguageName(): string
```
- **Returns**: Full name of alternative language
  - Returns `'English'` if current is French
  - Returns `'Français'` if current is English

##### `toggleLanguage()`
```javascript
toggleLanguage(): string
```
- **Returns**: New language code after toggle
- **Side Effects**: Same as `setLanguage()`
- **Example**:
  ```javascript
  // Current: 'fr'
  const newLang = window.i18n.toggleLanguage();
  // newLang: 'en', current language is now 'en'
  ```

### Translation Key Catalog

All translation keys are organized by namespace. Each namespace contains keys for specific parts of the application.

#### Namespace: `launcher` (QR Code Launch Page)

**General UI**:
- `title`: Main page title
- `subtitle`: Subtitle/description
- `serverActive`: Server status - active
- `serverStopped`: Server status - stopped
- `scanQR`: QR code instruction text
- `loading`: Loading state text
- `footerVersion`: Footer version text

**Buttons & Actions**:
- `copyBtn`: Copy button text
- `copied`: Copied confirmation text
- `shareTitle`: Share section title
- `shutdownBtn`: Server shutdown button

**Alerts & Confirmations**:
- `shutdownConfirm`: Shutdown confirmation dialog
- `shutdownInProgress`: Shutdown in progress message
- `shutdownSuccess`: Shutdown success message
- `shutdownError`: Shutdown error message
- `serverStoppedMessage`: Server stopped confirmation
- `closeWindow`: Close window instruction

**Toast Messages**:
- `urlCopied`: URL copied toast
- `copyError`: Copy error toast
- `qrDownload`: QR download toast
- `notionCopied`: Notion copy success toast
- `discordCopied`: Discord copy success toast
- `connectionError`: Connection error toast

**Sharing Features**:
- `emailSubject`: Email subject template (variable: `{url}`)
- `emailBody`: Email body template (variable: `{url}`)
- `shareMessage`: Generic share message (variable: `{url}`)

#### Namespace: `app` (Main Application Interface)

**Navigation**:
- `backBtn`: Back button text

**Connection States**:
- `statusConnecting`: Connecting indicator
- `connecting`: Connecting status
- `connected`: Connected status
- `disconnected`: Disconnected status
- `reconnecting`: Reconnecting status
- `error`: Error status

**CDP (Chrome DevTools Protocol)**:
- `cdpTooltip`: CDP tooltip description
- `cdpLabel`: CDP port label
- `cdpNotAvailable`: CDP unavailable warning
- `cdpWarning`: CDP warning message
- `retryConnection`: Retry connection button
- `external`: External connection type
- `local`: Local connection type

**Server Logs**:
- `logsBtn`: Logs button text
- `logsBtnTooltip`: Logs button tooltip
- `serverLogsTitle`: Server logs modal title
- `logsCount`: Log count display (variable: `{count}`)
- `allLevels`: All log levels filter
- `logLevel`: Log level
- `infoLevel`: Info level
- `warnLevel`: Warn level
- `errorLevel`: Error level
- `searchPlaceholder`: Search input placeholder
- `clearLogs`: Clear logs button
- `refresh`: Refresh button
- `loadingLogs`: Loading logs message

**Tasks**:
- `tasksTitle`: Tasks panel title

**Credits & Usage Dashboard**:
- `creditsTitle`: Credits dashboard title
- `loading`: Loading state
- `availableNow`: Available tokens label
- `tokens`: Tokens unit
- `used`: Used indicator
- `nextRefresh`: Next refresh label
- `windowStart`: Window start label
- `currentRate`: Current rate label
- `tokensPerMin`: Tokens per minute unit
- `refreshData`: Refresh data button
- `unknown`: Unknown value placeholder

**Sessions List**:
- `activeSessions`: Active sessions section title
- `inactiveSessions`: Inactive sessions section title
- `showInactive`: Show inactive sessions button
- `hideInactive`: Hide inactive sessions button
- `noActiveSessions`: No active sessions message
- `noInactiveSessions`: No inactive sessions message

**Session Details**:
- `sessionNotFound`: Session not found error
- `noMessages`: No messages state
- `messages`: Messages label
- `inputTokens`: Input tokens label
- `outputTokens`: Output tokens label
- `cacheCreationTokens`: Cache creation tokens label
- `cacheReadTokens`: Cache read tokens label
- `loadMore`: Load more button
- `loadingMore`: Loading more message

**Errors**:
- `errorTitle`: Error modal title
- `errorLoading`: Error loading message

**Tools & Actions**:
- `toolUse`: Tool use indicator
- `toolResult`: Tool result indicator
- `thinking`: Thinking/processing indicator

**Time Formatting**:
- `inMinutes`: Time in minutes (variable: `{minutes}`)
- `inHours`: Time in hours and minutes (variables: `{hours}`, `{minutes}`)
- `now`: Current time indicator

**Generic Buttons**:
- `close`: Close button
- `cancel`: Cancel button
- `confirm`: Confirm button
- `delete`: Delete button
- `deleteAll`: Delete all button
- `remove`: Remove button

#### Namespace: `home` (Home Page / Sessions Overview)

**Empty States**:
- `noSessions`: No sessions title
- `noSessionsDesc`: No sessions description
- `noSessionsInfo`: No sessions configuration info
- `noActiveSession`: No active session message

**General**:
- `newSession`: New session button
- `sessions`: Sessions label
- `refresh`: Refresh button
- `activeSessions`: Active sessions section
- `pastSessions`: Past sessions section

#### Namespace: `newSessionModal` (New Session Creation Modal)

**Form Labels**:
- `title`: Modal title
- `nameLabel`: Session name label
- `namePlaceholder`: Session name placeholder
- `nameHint`: Session name hint text
- `pathLabel`: Working directory path label
- `pathPlaceholder`: Path placeholder
- `pathHint`: Path hint text
- `messageLabel`: Initial message label
- `messagePlaceholder`: Message placeholder
- `messageHint`: Message hint text

**Path Management**:
- `favorites`: Favorites tab/section
- `recents`: Recents tab/section
- `projects`: Projects found section
- `manageFavorites`: Manage favorites button
- `addToFavorites`: Add to favorites button
- `removeFromFavorites`: Remove from favorites button
- `noPathsRecorded`: No paths recorded message
- `pathsWillAppearHere`: Paths will appear here message
- `nicknamePlaceholder`: Nickname placeholder

**Favorites Management**:
- `manageFavoritesTitle`: Manage favorites modal title
- `noFavorites`: No favorites message
- `addFavoritesHint`: Add favorites hint

**Actions**:
- `cancelBtn`: Cancel button
- `launchBtn`: Launch session button

**Success Messages**:
- `sessionCreated`: Session created message
- `sessionCreatedWithName`: Session created with name (variable: `{name}`)

**Errors**:
- `errorCreating`: Error creating message
- `errorMessage`: Error message template (variable: `{message}`)

**Orchestrator Options** (Advanced Session Type):
- `sessionType`: Session type label
- `sessionTypeClassic`: Classic session option
- `sessionTypeClassicDesc`: Classic session description
- `sessionTypeOrchestrator`: Orchestrator session option
- `sessionTypeOrchestratorDesc`: Orchestrator description
- `templateLabel`: Template selection label
- `templatePlaceholder`: Template placeholder
- `templateSystemGroup`: System templates group
- `templateUserGroup`: User templates group
- `templateManage`: Manage templates button
- `advancedOptions`: Advanced options section
- `autoSpawnWorkers`: Auto-spawn workers checkbox
- `maxWorkersLabel`: Max workers label
- `customVariables`: Custom variables section
- `editVariables`: Edit variables button
- `orchestratorCreating`: Creating orchestrator message
- `orchestratorCreated`: Orchestrator created success
- `orchestratorError`: Orchestrator error message
- `noTemplatesAvailable`: No templates message
- `loadingTemplates`: Loading templates message

#### Namespace: `orchestratorVariables` (Orchestrator Variables Editor)

- `title`: Modal title
- `description`: Modal description
- `cancelBtn`: Cancel button
- `applyBtn`: Apply button
- `addVariable`: Add variable button
- `variableName`: Variable name label
- `variableValue`: Variable value label
- `removeVariable`: Remove variable button

#### Namespace: `session` (Session Detail Page)

**Status Indicators**:
- `statusThinking`: Claude working status
- `statusWaiting`: Waiting status
- `statusIdle`: Idle status
- `statusActive`: Active status
- `noMessage`: No message state

**Info Labels**:
- `status`: Status label
- `messagesCount`: Messages count label
- `directory`: Directory label
- `branch`: Git branch label
- `lastActivity`: Last activity label

**Conversation**:
- `conversation`: Conversation section title
- `sendMessage`: Send message section title
- `messagePlaceholder`: Message input placeholder
- `sendBtn`: Send button
- `interruptBtn`: Interrupt button
- `noMessagesInSession`: No messages in session

**Session Expiration**:
- `expirationWarning`: Expiration warning (variable: `{minutes}`)
- `extendSession`: Extend session button
- `sessionExtended`: Session extended success message

#### Namespace: `contextWidget` (Context Window Widget)

- `title`: Widget title
- `estimateBadge`: Estimation badge text
- `userMessages`: User messages label
- `assistantMessages`: Assistant messages label
- `toolResults`: Tool results label
- `systemPrompt`: System prompt label

#### Namespace: `pinLogin` (PIN Authentication Page)

- `title`: Page title
- `subtitle`: Page subtitle
- `placeholder`: PIN input placeholder
- `loginBtn`: Login button
- `verifying`: Verifying status
- `pinError`: PIN format error
- `incorrectPin`: Incorrect PIN error
- `attemptsWarning`: Attempts remaining warning (variables: `{count}`, `{plural}`)
- `connectionError`: Connection error message

#### Namespace: `blocked` (Blocked Access Page)

- `title`: Page title
- `message`: Blocked message
- `ipBlocked`: IP blocked message
- `instruction`: Unblock instructions

#### Namespace: `security` (Security Notifications)

- `ipBlocked`: IP blocked notification (variable: `{ip}`)
- `multipleAttempts`: Multiple attempts alert

### Supported Languages and Codes

| Language Code | Language Name | Native Name | Status |
|--------------|---------------|-------------|---------|
| `fr` | French | Français | Full support (default fallback) |
| `en` | English | English | Full support |

**Language Code Format**: ISO 639-1 (2-letter codes)

### Translation Object Structure

```javascript
// Top-level structure
{
    'fr': { /* French translations */ },
    'en': { /* English translations */ }
}

// Second-level structure (namespaces)
{
    'fr': {
        launcher: { /* launcher translations */ },
        app: { /* app translations */ },
        home: { /* home translations */ },
        newSessionModal: { /* modal translations */ },
        orchestratorVariables: { /* orchestrator translations */ },
        session: { /* session translations */ },
        contextWidget: { /* widget translations */ },
        pinLogin: { /* login translations */ },
        blocked: { /* blocked page translations */ },
        security: { /* security translations */ }
    }
}

// Third-level structure (translation keys)
{
    'fr': {
        launcher: {
            title: "string",
            subtitle: "string",
            // ... more keys
        }
    }
}
```

### API for Adding Translations

#### Adding a New Language

```javascript
// 1. Add language to translations object in i18n.js
const translations = {
    fr: { /* ... */ },
    en: { /* ... */ },
    es: {  // New language
        launcher: {
            title: "🚀 ClaudeCode_Remote",
            subtitle: "¡Tu servidor está listo!"
            // ... all keys must be provided
        },
        app: { /* ... */ },
        // ... all namespaces must be provided
    }
};

// 2. Update setLanguage() validation
setLanguage(lang) {
    if (lang === 'fr' || lang === 'en' || lang === 'es') {  // Add 'es'
        // ...
    }
}

// 3. Update detectLanguage() if needed
detectLanguage() {
    const browserLang = navigator.language || navigator.userLanguage;
    if (browserLang.startsWith('fr')) return 'fr';
    if (browserLang.startsWith('es')) return 'es';  // Add Spanish
    return 'en';
}
```

#### Adding New Translation Keys

```javascript
// 1. Add to BOTH language objects
const translations = {
    fr: {
        app: {
            // ... existing keys
            newFeature: "Nouvelle fonctionnalité"  // Add here
        }
    },
    en: {
        app: {
            // ... existing keys
            newFeature: "New feature"  // And here
        }
    }
};

// 2. Use in your code
const text = window.i18n.t('app.newFeature');
// or
const text = t('app.newFeature');  // Using helper function
```

#### Adding a New Namespace

```javascript
const translations = {
    fr: {
        // ... existing namespaces
        newFeature: {  // New namespace
            title: "Titre",
            description: "Description",
            action: "Action"
        }
    },
    en: {
        // ... existing namespaces
        newFeature: {  // Must mirror structure
            title: "Title",
            description: "Description",
            action: "Action"
        }
    }
};

// Usage
t('newFeature.title');
t('newFeature.description');
```

### DOM Attributes Used

#### `data-i18n-loading` (Custom Attribute)
- **File**: `launcher.html` (line 441)
- **Usage**: Appears to be a marker for loading state
- **Example**: `<a href="#" data-i18n-loading>Chargement...</a>`
- **Note**: This is NOT actively used by the i18n system; it's a static marker

#### `lang` Attribute (HTML Standard)
- **Element**: `<html lang="...">`
- **Set By**: `document.documentElement.lang = lang`
- **Values**: `'fr'` or `'en'`
- **Purpose**: Indicates document language for accessibility and SEO

### LocalStorage Keys

#### `claudecode_lang`
- **Type**: String
- **Values**: `'fr'` | `'en'`
- **Purpose**: Stores user's preferred language
- **Set By**: `localStorage.setItem('claudecode_lang', lang)`
- **Read By**: `localStorage.getItem('claudecode_lang')`
- **Lifecycle**: Persists across sessions until manually cleared

**Storage Flow**:
```javascript
// First visit - auto-detection
detectLanguage() -> saves to localStorage

// Subsequent visits - reads from localStorage
detectLanguage() -> returns saved value

// User changes language
setLanguage('en') -> updates localStorage
```

### Configuration Options

The i18n system has **no external configuration file**. Configuration is done by modifying the `i18n.js` source:

#### Configurable Constants

```javascript
// SUPPORTED LANGUAGES (implicit)
const supportedLanguages = ['fr', 'en'];

// DEFAULT FALLBACK LANGUAGE (hardcoded)
const defaultFallback = 'fr';  // Line 575: fallback to French

// LOCALSTORAGE KEY (hardcoded)
const storageKey = 'claudecode_lang';  // Line 536
```

#### Non-Configurable Aspects
- Translation structure (nested objects)
- Variable placeholder syntax (`{variable}`)
- Namespace organization
- Fallback behavior

### Event System

**Current Status**: **NO custom event system implemented**

The i18n class does not emit events when language changes. Applications must manually trigger UI updates.

**Pattern Used**:
```javascript
function toggleLanguage() {
    window.i18n.toggleLanguage();  // Changes language
    updateAllTranslations();       // Manual UI update
}
```

**Potential Event-Based Implementation**:
```javascript
// Could be added to setLanguage():
setLanguage(lang) {
    // ... existing code
    const event = new CustomEvent('languagechange', {
        detail: { oldLang: this.currentLang, newLang: lang }
    });
    window.dispatchEvent(event);
}

// Usage:
window.addEventListener('languagechange', (e) => {
    console.log(`Language changed from ${e.detail.oldLang} to ${e.detail.newLang}`);
    updateAllTranslations();
});
```

### Global Helper Function (app.js)

The main application defines a **convenience wrapper** for translation:

```javascript
// File: public/app.js (lines 5-8)
function t(key, replacements = {}) {
    return window.i18n ? window.i18n.t(key, replacements) : key.split('.').pop();
}
```

**Features**:
- **Null Safety**: Returns last part of key if `window.i18n` is undefined
- **Shorter Syntax**: `t('app.backBtn')` instead of `window.i18n.t('app.backBtn')`
- **Same Signature**: Accepts same parameters as `window.i18n.t()`

**Usage Count**: Used **149 times** throughout `app.js`

### Test Interface (test-i18n.html)

The test page provides a comprehensive testing environment for the i18n system.

#### Features

1. **System Status Display**:
   - Detected language
   - Browser language
   - Saved language (localStorage)
   - HTML lang attribute

2. **Translation Tests**:
   - Launcher namespace tests (4 examples)
   - App namespace tests (4 examples)
   - Variable interpolation test

3. **Interactive Actions**:
   - Language toggle button (top-right)
   - Refresh tests button
   - Clear localStorage button
   - Reload page button

4. **Visual Feedback**:
   - Language flag indicator
   - Real-time translation updates
   - Styled test cards

#### Test Categories

**Launcher Tests**:
- `launcher.title`
- `launcher.subtitle`
- `launcher.scanQR`
- `launcher.shareMessage` (with `{url}` variable)

**App Tests**:
- `app.backBtn`
- `app.cdpLabel`
- `app.tasksTitle`
- `app.serverLogsTitle`

#### Functions

```javascript
// Update system status display
function updateStatus()

// Run all translation tests
function testAllTranslations()

// Toggle between languages
function toggleLanguage()

// Clear localStorage and reload
function clearStorage()
```

#### Usage

1. Open: `http://localhost:PORT/test-i18n.html`
2. Click language toggle to switch languages
3. Observe translations update in real-time
4. Test localStorage persistence by reloading
5. Clear storage to test auto-detection

### TODO Comments

**No TODO comments found** in `public/i18n.js` or `public/test-i18n.html`.

The implementation appears to be complete for its intended scope (French/English bilingual support).

### Summary Statistics

- **Total Translation Keys**: ~200+ keys across all namespaces
- **Namespaces**: 10 (launcher, app, home, newSessionModal, orchestratorVariables, session, contextWidget, pinLogin, blocked, security)
- **Supported Languages**: 2 (French, English)
- **File Size**: ~27 KB (i18n.js)
- **Dependencies**: 0 (pure vanilla JavaScript)
- **Browser Compatibility**: Modern browsers (ES6+)
- **LocalStorage Usage**: 1 key (`claudecode_lang`)
- **Global Variables**: 1 (`window.i18n`)

### Best Practices for Developers

1. **Always provide both languages** when adding new keys
2. **Use descriptive key names** that indicate the UI element
3. **Group related keys** under appropriate namespaces
4. **Test language toggle** after adding new translations
5. **Use variable interpolation** for dynamic content
6. **Handle plurals manually** in calling code (system doesn't auto-pluralize)
7. **Update test-i18n.html** when adding critical new features
8. **Never use translation keys in localStorage or URLs** (keys may change)
9. **Prefer programmatic translation** over DOM attributes for now
10. **Check fallback behavior** works correctly for new keys

---

**End of Documentation**

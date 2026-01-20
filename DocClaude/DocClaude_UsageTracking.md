# DocClaude Usage Tracking System Documentation

## Table of Contents
1. [Part 1: Verbose Explanation of Functionality](#part-1-verbose-explanation-of-functionality)
   - [Architecture Overview](#architecture-overview)
   - [API Key Validation and Account Tier Detection](#api-key-validation-and-account-tier-detection)
   - [Plan Types and Limits](#plan-types-and-limits)
   - [Token Counting Methodology](#token-counting-methodology)
   - [Usage Data Structure and Calculation](#usage-data-structure-and-calculation)
   - [Sliding Window Mechanism](#sliding-window-mechanism)
   - [Hourly and Daily Usage Aggregation](#hourly-and-daily-usage-aggregation)
   - [Cache Mechanism and Data Persistence](#cache-mechanism-and-data-persistence)
   - [Auto-Refresh Intervals](#auto-refresh-intervals)
   - [Usage Widget UI Implementation](#usage-widget-ui-implementation)
   - [Visual Indicators and Progress Bars](#visual-indicators-and-progress-bars)
   - [Usage Warnings and Alerts](#usage-warnings-and-alerts)
2. [Part 2: Important Variables/Inputs/Outputs](#part-2-important-variablesinputsoutputs)
   - [AnthropicUsageTracker Class](#anthropicusagetracker-class)
   - [Usage Data Structures](#usage-data-structures)
   - [Plan Configuration](#plan-configuration)
   - [API Endpoints](#api-endpoints)
   - [UI Functions and Components](#ui-functions-and-components)
   - [Error Handling](#error-handling)

---

# PART 1: VERBOSE EXPLANATION OF FUNCTIONALITY

## Architecture Overview

The DocClaude Usage Tracking System is a comprehensive monitoring solution designed to track and display Anthropic Claude API usage, specifically tailored for Claude Code users. The system consists of three primary architectural layers:

1. **Backend Tracker Layer** (`backend/anthropic-usage-tracker.js`): A Node.js EventEmitter-based class that monitors local Claude Code session files to calculate token usage in real-time.

2. **Server API Layer** (`backend/server.js`): Express.js REST API endpoints that expose usage data to the frontend through authenticated routes and WebSocket connections.

3. **Frontend UI Layer** (`public/app.js`): Interactive Vue.js-style components that render usage statistics, progress bars, and visual alerts for end users.

### Data Flow Architecture

```
Local Claude Session Files (.jsonl)
         ↓
AnthropicUsageTracker (reads every 5 minutes)
         ↓
Current Usage State + History
         ↓
WebSocket Broadcast + REST API
         ↓
Frontend UI Components
         ↓
User Visualization (Widget, Progress Bars, Alerts)
```

The architecture is **file-based** rather than API-based. Instead of querying Anthropic's API for usage statistics, the system reads local Claude Code session files stored in `~/.claude/projects/` and calculates token usage directly from the `usage` field in assistant message events.

### Why File-Based Tracking?

The system uses file-based tracking because:
1. **Anthropic API Limitation**: Claude Code does not expose a public API endpoint for usage/credit limits
2. **Real-Time Accuracy**: Local session files contain exact token counts from API responses
3. **No Additional API Costs**: Reading local files doesn't consume API credits
4. **Offline Capability**: Usage can be calculated even without internet connectivity

---

## API Key Validation and Account Tier Detection

### API Key Configuration

The AnthropicUsageTracker is initialized with an API key parameter:

```javascript
const usageTracker = new AnthropicUsageTracker({
  apiKey: process.env.ANTHROPIC_API_KEY,
  dataDir: path.join(require('os').homedir(), '.claude-monitor')
});
```

**However**, the API key is **not actively used** for fetching usage data. The `fetchUsageFromAnthropicAPI()` method explicitly throws an error stating "API endpoint non disponible" (API endpoint not available). This is because Anthropic does not provide a public endpoint for Claude Code usage limits.

### Account Tier Detection Algorithm

The system implements an **intelligent automatic detection** mechanism for determining the user's Claude Code plan tier. This detection is crucial because different tiers have different token limits within the 5-hour sliding window.

#### Detection Method: P90 (90th Percentile) Analysis

The `detectPlan()` and `estimateLimit()` methods work together to determine the user's plan:

1. **Step 1: Collect Historical Data**
   - The tracker accumulates usage history over time
   - Each history entry contains the token count at a specific timestamp

2. **Step 2: Identify "Limit Hits"**
   - A "limit hit" is detected when usage reaches ≥95% of a known limit (19K, 44K, 88K, 220K, 880K)
   - The system filters history entries that fall within 95%-105% of known limits
   - Example: If usage reaches 18,050 tokens (95% of 19,000), it's considered a "limit hit" for the Pro plan

3. **Step 3: Calculate P90 Value**
   - If at least 3 limit hits are detected, sort them and find the 90th percentile value
   - Example: With 10 limit hits ranging from 18,500 to 19,200, P90 might be 19,100

4. **Step 4: Map to Closest Known Limit**
   - The P90 value is matched to the nearest predefined limit
   - Known limits: `[19000, 44000, 88000, 220000, 880000]`
   - Example: P90 of 19,100 maps to 19,000 (Pro plan)

5. **Fallback Strategy**
   - If fewer than 3 limit hits exist, use all historical sessions
   - Calculate P90 across all usage values
   - Find the smallest known limit that exceeds P90 by ≤20%
   - Default fallback: 44,000 tokens if no pattern is detected

### Plan Detection Example

```javascript
// Example: User has history showing consistent 88K limit hits
// History: [85000, 86500, 87800, 88100, 88000, 87900, ...]

// Step 1: Filter limit hits (≥95% of 88K = 83,600)
const limitHits = [85000, 86500, 87800, 88100, 88000, 87900];

// Step 2: Sort and find P90
const sorted = [85000, 86500, 87800, 87900, 88000, 88100];
const p90Index = Math.floor(6 * 0.9); // = 5
const p90Value = sorted[5]; // = 88100

// Step 3: Find closest limit
// |19000 - 88100| = 69100
// |88000 - 88100| = 100 ← CLOSEST
// Detected plan: max5 (88,000 tokens)
```

### Why P90 Instead of Max?

The system uses the **90th percentile** instead of the maximum value because:
- **Outlier Resistance**: Occasional anomalies don't skew detection
- **Statistical Stability**: P90 represents typical "ceiling" behavior
- **Conservative Approach**: Slightly underestimates rather than overestimates limits

---

## Plan Types and Limits

The system supports four distinct plan types, each with specific token limits for the 5-hour sliding window:

### Plan Configuration Object

```javascript
this.plans = {
  pro: {
    limit: 19000,  // 19K tokens per 5-hour window
    name: 'Pro'
  },
  max5: {
    limit: 88000,  // 88K tokens per 5-hour window
    name: 'Max5'
  },
  max20: {
    limit: 220000, // 220K tokens per 5-hour window
    name: 'Max20'
  },
  custom: {
    limit: null,   // Dynamically calculated
    name: 'Custom'
  }
};
```

### Plan Characteristics

#### 1. Pro Plan (19,000 tokens)
- **Target Users**: Individual developers, small projects
- **Typical Use Case**: 2-4 medium conversations per 5-hour window
- **Detection Threshold**: Usage consistently approaching 18,000-19,500 tokens
- **Warning Trigger**: 50% (9,500 tokens), 80% (15,200 tokens)

#### 2. Max5 Plan (88,000 tokens)
- **Target Users**: Professional developers, medium-sized projects
- **Typical Use Case**: 10-15 extensive conversations per 5-hour window
- **Detection Threshold**: Usage consistently approaching 83,000-92,000 tokens
- **Warning Trigger**: 50% (44,000 tokens), 80% (70,400 tokens)

#### 3. Max20 Plan (220,000 tokens)
- **Target Users**: Large teams, enterprise projects
- **Typical Use Case**: 25+ extensive conversations per 5-hour window
- **Detection Threshold**: Usage consistently approaching 209,000-231,000 tokens
- **Warning Trigger**: 50% (110,000 tokens), 80% (176,000 tokens)

#### 4. Custom Plan (Dynamic)
- **Purpose**: Handles unknown or non-standard limits
- **Calculation**: Uses P90 estimation algorithm (see previous section)
- **Default Fallback**: 44,000 tokens if no history exists
- **Common Limits**: The system recognizes `[19000, 44000, 88000, 220000, 880000]` as valid limits

### How Plans Are Applied

The `updateCurrentUsage()` method applies the detected plan:

```javascript
updateCurrentUsage(usage) {
  const detectedPlan = this.detectPlan(usage.tokensUsed);

  this.currentUsage = {
    tokensUsed: usage.tokensUsed,
    tokensLimit: this.plans[detectedPlan].limit || this.estimateLimit(usage.tokensUsed),
    tokensRemaining: this.calculateRemaining(usage.tokensUsed, detectedPlan),
    percentageUsed: this.calculatePercentage(usage.tokensUsed, detectedPlan),
    plan: detectedPlan,
    // ... other fields
  };
}
```

### Remaining Tokens Calculation

```javascript
calculateRemaining(tokensUsed, plan) {
  const limit = this.plans[plan].limit || this.estimateLimit(tokensUsed);
  return Math.max(0, limit - tokensUsed);
}
```

- **Formula**: `remaining = max(0, limit - used)`
- **Floor Protection**: Never returns negative values
- **Dynamic Limits**: If plan is 'custom', calls `estimateLimit()` dynamically

### Percentage Calculation

```javascript
calculatePercentage(tokensUsed, plan) {
  const limit = this.plans[plan].limit || this.estimateLimit(tokensUsed);
  return limit > 0 ? (tokensUsed / limit) * 100 : 0;
}
```

- **Formula**: `percentage = (used / limit) × 100`
- **Zero Protection**: Returns 0 if limit is 0 (prevents division by zero)
- **Range**: 0% to >100% (can exceed 100% if over limit)

---

## Token Counting Methodology

### What Counts Toward the Limit?

**CRITICAL UNDERSTANDING**: The token counting methodology is based on empirical testing with Claude Code Usage Monitor. According to the inline comments and implementation:

```javascript
// IMPORTANT: Selon les tests avec Claude Code Usage Monitor, seuls les input_tokens
// et output_tokens comptent dans la limite de la fenêtre glissante.
// Les cache_creation_input_tokens et cache_read_input_tokens NE COMPTENT PAS.
const tokensUsed = inputTokens + outputTokens;
```

### Token Types Explained

Claude API returns four token types in the `usage` field of each response:

1. **`input_tokens`**: Standard input tokens (user message + conversation context)
   - **Counted**: ✅ YES
   - **Cost**: Full price per token

2. **`output_tokens`**: Tokens generated by Claude in the response
   - **Counted**: ✅ YES
   - **Cost**: Typically higher price per token than input

3. **`cache_creation_input_tokens`**: Tokens used to create prompt cache
   - **Counted**: ❌ NO
   - **Cost**: Charged separately but not counted toward 5-hour limit

4. **`cache_read_input_tokens`**: Tokens read from prompt cache
   - **Counted**: ❌ NO
   - **Cost**: Significantly discounted, not counted toward limit

### Extraction from Session Files

The `extractTokensFromSession()` method parses `.jsonl` files:

```javascript
extractTokensFromSession(sessionPath, todayStart, fiveHoursAgo) {
  let currentPeriod = 0;  // Tokens in 5-hour window
  let daily = 0;          // Tokens today
  let messageCount = 0;   // Number of messages

  const lines = fs.readFileSync(sessionPath, 'utf-8').trim().split('\n');

  for (const line of lines) {
    const event = JSON.parse(line);

    // Only process assistant messages with usage data
    if (event.type === 'assistant' && event.message?.usage) {
      const usage = event.message.usage;
      const eventDate = new Date(event.timestamp);

      // Extract token types
      const inputTokens = usage.input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
      const cacheReadTokens = usage.cache_read_input_tokens || 0;

      // Total = ONLY input + output
      const tokensUsed = inputTokens + outputTokens;

      // Add to 5-hour window if within range
      if (eventDate >= fiveHoursAgo) {
        currentPeriod += tokensUsed;
        messageCount++;
      }

      // Add to daily total if today
      if (eventDate >= todayStart) {
        daily += tokensUsed;
      }
    }
  }

  return { currentPeriod, daily, messageCount };
}
```

### Session File Format

Claude Code session files (`.jsonl`) contain JSON-lines format:

```json
{"type":"user","message":"Hello Claude","timestamp":"2026-01-18T10:30:00Z"}
{"type":"assistant","message":{"content":"Hello!","usage":{"input_tokens":150,"output_tokens":50,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},"timestamp":"2026-01-18T10:30:05Z"}
```

### Multi-Session Aggregation

The `calculateUsageFromSessions()` method aggregates across all sessions:

```javascript
calculateUsageFromSessions() {
  const projectsDir = path.join(claudeDir, 'projects');
  const now = new Date();
  const fiveHoursAgo = new Date(now.getTime() - (5 * 60 * 60 * 1000));

  let currentPeriodTokens = 0;
  let dailyTokens = 0;

  // Iterate through all project directories
  for (const projectDir of fs.readdirSync(projectsDir)) {
    const projectPath = path.join(projectsDir, projectDir);

    // Find all session files (exclude agent- files)
    const sessionFiles = fs.readdirSync(projectPath)
      .filter(file => file.endsWith('.jsonl') && !file.startsWith('agent-'));

    // Extract tokens from each session
    for (const sessionFile of sessionFiles) {
      const sessionPath = path.join(projectPath, sessionFile);
      const tokens = this.extractTokensFromSession(sessionPath, todayStart, fiveHoursAgo);
      currentPeriodTokens += tokens.currentPeriod;
      dailyTokens += tokens.daily;
    }
  }

  return {
    tokensUsed: currentPeriodTokens,
    dailyUsage: dailyTokens,
    timestamp: now.toISOString()
  };
}
```

### Example Token Calculation

**Scenario**: User has 3 active sessions in the past 5 hours

**Session 1** (2 hours ago):
- Message 1: `input_tokens: 500, output_tokens: 300` → **800 tokens**
- Message 2: `input_tokens: 600, output_tokens: 400, cache_read_input_tokens: 2000` → **1000 tokens** (cache ignored)

**Session 2** (4 hours ago):
- Message 1: `input_tokens: 1200, output_tokens: 800` → **2000 tokens**

**Session 3** (6 hours ago):
- Message 1: `input_tokens: 500, output_tokens: 200` → **Not counted** (outside 5-hour window)

**Total Counted**: 800 + 1000 + 2000 = **3,800 tokens**

---

## Usage Data Structure and Calculation

### Core Data Structure: `currentUsage`

The `currentUsage` object is the central state container for all usage metrics:

```javascript
this.currentUsage = {
  // Primary Metrics
  tokensUsed: 0,           // Total tokens in 5-hour sliding window
  tokensRemaining: 0,      // Tokens remaining until limit
  tokensLimit: 0,          // Maximum tokens for current plan
  percentageUsed: 0,       // Percentage of limit consumed (0-100+)

  // Plan Information
  plan: 'custom',          // Detected plan: 'pro', 'max5', 'max20', 'custom'

  // Temporal Metadata
  lastUpdate: null,        // ISO timestamp of last refresh
  nextRefresh: null,       // ISO timestamp when tokens will reset

  // Rate Metrics
  currentRate: 0,          // Tokens consumed per minute (recent trend)
  dailyUsage: 0,           // Total tokens used today (midnight to now)
  hourlyAverage: 0,        // Average tokens per hour over 24 hours

  // Predictions
  estimatedTimeUntilLimit: null  // Hours until limit reached (based on currentRate)
};
```

### Field-by-Field Explanation

#### `tokensUsed` (Integer)
- **Definition**: Total tokens consumed within the 5-hour sliding window
- **Calculation**: Sum of `input_tokens + output_tokens` from all messages in window
- **Range**: 0 to infinity (can exceed limit)
- **Update Frequency**: Every 5 minutes via auto-refresh
- **Example**: 15,432 tokens

#### `tokensRemaining` (Integer)
- **Definition**: Tokens available before hitting the limit
- **Calculation**: `max(0, tokensLimit - tokensUsed)`
- **Range**: 0 to tokensLimit
- **Floor Protection**: Never negative (clamped to 0)
- **Example**: 3,568 tokens

#### `tokensLimit` (Integer)
- **Definition**: Maximum tokens allowed in 5-hour window for current plan
- **Source**: Plan configuration or P90 estimation
- **Values**: 19000 (Pro), 88000 (Max5), 220000 (Max20), or dynamic
- **Example**: 19,000 tokens

#### `percentageUsed` (Float)
- **Definition**: Percentage of limit consumed
- **Calculation**: `(tokensUsed / tokensLimit) × 100`
- **Range**: 0.0 to infinity (can exceed 100.0)
- **Precision**: Typically displayed to 1 decimal place
- **Example**: 81.2%

#### `plan` (String)
- **Definition**: Detected account plan tier
- **Values**: `'pro'`, `'max5'`, `'max20'`, `'custom'`
- **Detection**: Via P90 algorithm or default to 'custom'
- **Display**: Uppercase badge in UI (e.g., "CUSTOM")
- **Example**: "max5"

#### `lastUpdate` (ISO String)
- **Definition**: Timestamp when usage data was last refreshed
- **Format**: ISO 8601 string (`"2026-01-18T14:30:00.000Z"`)
- **Source**: `new Date().toISOString()`
- **Purpose**: Display "Last updated" time to user
- **Example**: "2026-01-18T14:30:00.000Z"

#### `nextRefresh` (ISO String)
- **Definition**: Timestamp when tokens will begin to expire
- **Calculation**: Complex (see Sliding Window Mechanism section)
- **Format**: ISO 8601 string
- **Purpose**: Show countdown timer to user
- **Example**: "2026-01-18T19:30:00.000Z"

#### `currentRate` (Integer)
- **Definition**: Tokens consumed per minute (recent trend)
- **Calculation**: Token increase over last hour divided by minutes
- **Range**: 0 to high values (typically 0-200 for active usage)
- **Purpose**: Predict when limit will be reached
- **Example**: 42 tokens/minute

#### `dailyUsage` (Integer)
- **Definition**: Total tokens used from midnight (00:00) to now
- **Calculation**: Sum of tokens from all messages since `todayStart`
- **Purpose**: Track daily consumption patterns
- **Reset**: Automatically at midnight (local time)
- **Example**: 45,678 tokens

#### `hourlyAverage` (Integer)
- **Definition**: Average tokens per hour over past 24 hours
- **Calculation**: `sum(dailyUsage over 24h) / 24`
- **Purpose**: Show sustained usage patterns
- **Example**: 1,903 tokens/hour

#### `estimatedTimeUntilLimit` (Float or null)
- **Definition**: Hours until limit is reached (based on current rate)
- **Calculation**: `tokensRemaining / (currentRate * 60)`
- **Range**: null (if rate is 0) or positive float
- **Purpose**: Warning predictor for heavy usage
- **Example**: 1.42 hours

### Calculation Flow

```
┌─────────────────────────────────────┐
│ Load Session Files from Disk        │
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│ Extract Tokens (input + output)     │
│ - Filter by 5-hour window           │
│ - Filter by today (daily)           │
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│ Aggregate Across All Sessions       │
│ - Sum currentPeriodTokens            │
│ - Sum dailyTokens                    │
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│ Detect Plan (P90 Algorithm)         │
│ - Determine tokensLimit              │
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│ Calculate Derived Metrics            │
│ - tokensRemaining                    │
│ - percentageUsed                     │
│ - nextRefresh                        │
│ - currentRate                        │
│ - hourlyAverage                      │
│ - estimatedTimeUntilLimit            │
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│ Update currentUsage Object           │
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│ Emit 'usage-updated' Event           │
│ - Broadcast via WebSocket            │
│ - Available via REST API             │
└─────────────────────────────────────┘
```

---

## Sliding Window Mechanism

### What is a Sliding Window?

Claude Code implements a **5-hour rolling sliding window** for token limits. This means:
- At any given moment, only tokens from the past 5 hours count toward your limit
- As time passes, old tokens "fall off" the window and new tokens can be consumed
- The window is **continuous** and **rolling**, not fixed to specific hours

### Example Visualization

```
Current Time: 14:30

Window Start: 09:30 (14:30 - 5 hours)
Window End:   14:30 (now)

Timeline:
08:00 ─┬─ Message A (500 tokens) → NOT COUNTED (outside window)
       │
09:00 ─┤
       │
09:30 ─┼─ [WINDOW START]
       │
10:00 ─┼─ Message B (1000 tokens) → COUNTED
       │
11:00 ─┼─ Message C (1500 tokens) → COUNTED
       │
12:00 ─┼─ Message D (2000 tokens) → COUNTED
       │
13:00 ─┼─ Message E (500 tokens) → COUNTED
       │
14:00 ─┼─ Message F (800 tokens) → COUNTED
       │
14:30 ─┼─ [WINDOW END / NOW]

Total in Window: 1000 + 1500 + 2000 + 500 + 800 = 5,800 tokens
```

### Hour Rounding Mechanism

**CRITICAL**: Claude Code Usage Monitor rounds the oldest message timestamp to the nearest hour **downward** before calculating the refresh time. This is explicitly implemented:

```javascript
roundToHour(date) {
  const rounded = new Date(date);
  rounded.setMinutes(0, 0, 0);  // Set minutes, seconds, milliseconds to 0
  return rounded;
}
```

**Example**:
- Oldest message in window: `10:37:42`
- Rounded start time: `10:00:00`
- Next refresh: `10:00:00 + 5 hours = 15:00:00`

This means tokens expire **on the hour**, not at exact 5-hour intervals from each message.

### Next Refresh Calculation

The `estimateNextRefresh()` method implements sophisticated logic:

```javascript
estimateNextRefresh() {
  const now = new Date();
  const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

  // CASE 1: We have an oldest message in the window
  if (this.oldestMessageInWindow) {
    // Round the oldest message to the hour
    const oldestTime = new Date(this.oldestMessageInWindow);
    const roundedStartTime = this.roundToHour(oldestTime);

    // Next refresh = rounded start + 5 hours
    const nextRefresh = new Date(roundedStartTime.getTime() + FIVE_HOURS_MS);

    // CASE 1A: Refresh is in the future (tokens still active)
    if (nextRefresh > now) {
      return nextRefresh.toISOString();
    }

    // CASE 1B: Refresh is in the past (tokens expired, anticipate next)
    const roundedNow = this.roundToHour(now);
    const anticipatedRefresh = new Date(roundedNow.getTime() + FIVE_HOURS_MS);
    return anticipatedRefresh.toISOString();
  }

  // CASE 2: No messages in window (empty state)
  // Anticipate next 5-hour window starting from current hour
  const roundedNow = this.roundToHour(now);
  const anticipatedRefresh = new Date(roundedNow.getTime() + FIVE_HOURS_MS);
  return anticipatedRefresh.toISOString();
}
```

### Refresh Scenarios

#### Scenario 1: Active Usage, Tokens in Window

```
Current Time: 14:30
Oldest Message: 10:45 → Rounded to 10:00
Next Refresh: 10:00 + 5h = 15:00

Status: Tokens will start expiring at 15:00
Time Until Refresh: 30 minutes
```

#### Scenario 2: Tokens Recently Expired

```
Current Time: 15:10
Oldest Message: 09:55 → Rounded to 09:00
Next Refresh: 09:00 + 5h = 14:00 (in the past!)

Status: Tokens already expired, anticipate next window
Anticipated Refresh: 15:00 + 5h = 20:00
Time Until Refresh: 4 hours 50 minutes
```

#### Scenario 3: No Recent Usage (Empty Window)

```
Current Time: 14:30
Oldest Message: None

Status: No active tokens, anticipate next window
Anticipated Refresh: 14:00 + 5h = 19:00
Time Until Refresh: 4 hours 30 minutes
```

### Finding the Oldest Message

The `findOldestMessageInWindow()` method scans all sessions:

```javascript
findOldestMessageInWindow(projectsDir, fiveHoursAgo) {
  let oldestTimestamp = null;

  // Iterate through all project directories
  for (const projectDir of projectDirs) {
    const projectPath = path.join(projectsDir, projectDir);
    const sessionFiles = fs.readdirSync(projectPath)
      .filter(file => file.endsWith('.jsonl') && !file.startsWith('agent-'));

    // Check each session file
    for (const sessionFile of sessionFiles) {
      const sessionPath = path.join(projectPath, sessionFile);
      const oldest = this.findOldestInSession(sessionPath, fiveHoursAgo);

      // Keep track of the overall oldest
      if (oldest && (!oldestTimestamp || oldest < oldestTimestamp)) {
        oldestTimestamp = oldest;
      }
    }
  }

  return oldestTimestamp;
}
```

### Why Sliding Windows Matter

1. **Fairness**: Users aren't penalized for time-of-day clustering
2. **Flexibility**: Heavy usage in morning doesn't block afternoon work (after 5h)
3. **Predictability**: Users can see exactly when capacity will recover
4. **Smoothing**: Prevents "hard resets" at midnight or fixed intervals

---

## Hourly and Daily Usage Aggregation

### Daily Usage Tracking

Daily usage represents the total tokens consumed from midnight (00:00) to the current time. This is **separate** from the 5-hour sliding window and provides a different perspective on consumption patterns.

#### Daily Usage Calculation

```javascript
// In extractTokensFromSession():
const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

// For each message:
const eventDate = new Date(event.timestamp);
if (eventDate >= todayStart) {
  daily += tokensUsed;
}
```

**Key Points**:
- `todayStart` is set to midnight of the current day (00:00:00)
- All messages with timestamps >= `todayStart` are summed
- Daily usage **resets automatically** at midnight (local time)
- Daily usage is **independent** of the 5-hour window

#### Daily vs. 5-Hour Window

```
Example Timeline (Current time: 14:30):

00:00 ─┬─ [DAILY START]
       │
02:00 ─┼─ Message A (1000 tokens)
       │   ├─ Daily: YES ✅
       │   └─ 5h Window: NO ❌ (too old)
       │
09:30 ─┼─ [5-HOUR WINDOW START]
       │
10:00 ─┼─ Message B (2000 tokens)
       │   ├─ Daily: YES ✅
       │   └─ 5h Window: YES ✅
       │
14:30 ─┼─ [NOW]

Daily Usage: 1000 + 2000 = 3,000 tokens
5h Window Usage: 2000 tokens
```

### Hourly Average Calculation

The hourly average provides insight into sustained usage patterns over the past 24 hours:

```javascript
calculateHourlyAverage() {
  if (this.usageHistory.length < 2) return 0;

  // Filter history to last 24 hours
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentHistory = this.usageHistory.filter(h =>
    new Date(h.timestamp) >= oneDayAgo
  );

  if (recentHistory.length < 2) return 0;

  // Sum all daily usage values
  const totalTokens = recentHistory.reduce((sum, h) =>
    sum + (h.dailyUsage || 0), 0
  );

  // Divide by 24 hours
  return Math.round(totalTokens / 24);
}
```

**Important Notes**:
- Uses `dailyUsage` field from history entries (not 5-hour window tokens)
- Requires at least 2 history entries
- Returns **rounded integer** (no decimals)
- Recalculated every 5 minutes during auto-refresh

#### Hourly Average Example

```
History over 24 hours:
- Entry 1 (00:00): dailyUsage = 0
- Entry 2 (01:00): dailyUsage = 500
- Entry 3 (02:00): dailyUsage = 1200
- Entry 4 (03:00): dailyUsage = 1200
- Entry 5 (04:00): dailyUsage = 2800
... (20 more entries) ...
- Entry 24 (23:00): dailyUsage = 45000

Total daily usage across all entries: 120,000 tokens
Hourly average: 120,000 / 24 = 5,000 tokens/hour
```

### Current Rate Calculation (Tokens per Minute)

The current rate represents the **velocity** of token consumption based on recent trends:

```javascript
calculateCurrentRate() {
  if (this.usageHistory.length < 2) return 0;

  // Get last 12 entries (1 hour if refresh every 5 min)
  const recent = this.usageHistory.slice(-12);
  if (recent.length < 2) return 0;

  const firstEntry = recent[0];
  const lastEntry = recent[recent.length - 1];

  // Calculate time difference
  const timeDiff = new Date(lastEntry.timestamp) - new Date(firstEntry.timestamp);
  const minutesDiff = timeDiff / (1000 * 60);

  if (minutesDiff === 0) return 0;

  // Calculate token difference (sliding window delta)
  const tokensDiff = lastEntry.tokensUsed - firstEntry.tokensUsed;

  // Only return positive rates (increasing usage)
  return tokensDiff > 0 ? Math.round(tokensDiff / minutesDiff) : 0;
}
```

**Key Insights**:
- **Window**: Last 12 history entries (~1 hour if refresh is 5 minutes)
- **Delta Calculation**: Measures **change** in sliding window tokens
- **Positive Only**: Returns 0 if usage is decreasing (tokens expiring faster than added)
- **Rounded**: Integer result (no decimals)

#### Rate Calculation Example

```
History (last 12 entries, 5-minute intervals):

Time    TokensUsed (5h window)
13:30   10,000
13:35   10,200  (+200 in 5 min)
13:40   10,500  (+300 in 5 min)
13:45   10,800  (+300 in 5 min)
13:50   11,200  (+400 in 5 min)
13:55   11,600  (+400 in 5 min)
14:00   12,000  (+400 in 5 min)
14:05   12,300  (+300 in 5 min)
14:10   12,500  (+200 in 5 min)
14:15   12,700  (+200 in 5 min)
14:20   12,800  (+100 in 5 min)
14:25   12,900  (+100 in 5 min)

First entry: 10,000 (13:30)
Last entry: 12,900 (14:25)
Token difference: 12,900 - 10,000 = 2,900 tokens
Time difference: 55 minutes
Rate: 2,900 / 55 = 52.7 → 53 tokens/minute
```

### Usage Prediction

The system predicts when the limit will be reached using the current rate:

```javascript
calculatePredictions() {
  const { tokensRemaining, currentRate } = this.currentUsage;

  if (currentRate === 0) {
    this.currentUsage.estimatedTimeUntilLimit = null;
    return;
  }

  // Convert rate to tokens per hour
  const tokensPerHour = currentRate * 60;

  // Calculate hours until limit
  const hoursUntilLimit = tokensRemaining / tokensPerHour;
  this.currentUsage.estimatedTimeUntilLimit = hoursUntilLimit;
}
```

**Example**:
- Tokens remaining: 5,000
- Current rate: 50 tokens/minute = 3,000 tokens/hour
- Estimated time: 5,000 / 3,000 = 1.67 hours ≈ 1 hour 40 minutes

---

## Cache Mechanism and Data Persistence

### History File Persistence

The system persists usage history to disk to maintain state across application restarts:

```javascript
// File location
this.historyFile = path.join(this.dataDir, 'usage-history.json');
// Example: ~/.claude-monitor/usage-history.json
```

### History Data Structure

Each history entry contains three fields:

```javascript
{
  timestamp: "2026-01-18T14:30:00.000Z",  // ISO string
  tokensUsed: 12500,                      // Tokens in 5h window at this time
  dailyUsage: 45000                       // Total tokens today at this time
}
```

**Important**: `tokensUsed` represents the **snapshot** of the sliding window at that timestamp, not a cumulative total.

### Loading History

```javascript
loadHistory() {
  try {
    if (fs.existsSync(this.historyFile)) {
      const data = fs.readFileSync(this.historyFile, 'utf-8');
      const loaded = JSON.parse(data);

      // Clean history: keep only last 24 hours
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      this.usageHistory = loaded.filter(h =>
        new Date(h.timestamp) >= oneDayAgo
      );

      console.log(`Historique chargé: ${this.usageHistory.length} entrées`);

      // Save immediately if we cleaned old data
      if (this.usageHistory.length !== loaded.length) {
        console.log(`Nettoyage: ${loaded.length - this.usageHistory.length} entrées obsolètes supprimées`);
        this.saveHistory();
      }
    }
  } catch (error) {
    console.error('Erreur lors du chargement de l\'historique:', error.message);
    this.usageHistory = [];
  }
}
```

**Key Behaviors**:
1. **Automatic Cleanup**: Entries older than 24 hours are discarded
2. **Migration**: If old data is removed, file is re-saved immediately
3. **Error Handling**: If load fails, history resets to empty array `[]`
4. **Startup Load**: Called in constructor before any usage calculations

### Saving History

```javascript
saveHistory() {
  try {
    fs.writeFileSync(
      this.historyFile,
      JSON.stringify(this.usageHistory, null, 2),
      'utf-8'
    );
  } catch (error) {
    console.error('Erreur lors de la sauvegarde de l\'historique:', error.message);
  }
}
```

**Save Triggers**:
1. After every usage refresh (every 5 minutes)
2. After adding a new history entry
3. After cleanup of old entries

### Adding History Entries

```javascript
addToHistory(usage) {
  const entry = {
    timestamp: usage.timestamp,
    tokensUsed: usage.tokensUsed,      // 5h window snapshot
    dailyUsage: usage.dailyUsage || 0
  };

  this.usageHistory.push(entry);

  // Keep only last 24 hours
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  this.usageHistory = this.usageHistory.filter(h =>
    new Date(h.timestamp) >= oneDayAgo
  );

  // Persist to disk
  this.saveHistory();
}
```

**Retention Policy**:
- **Window**: 24 hours (rolling)
- **Frequency**: New entry every 5 minutes (288 entries per day max)
- **Storage**: JSON file (~50 KB for 288 entries)

### Cache vs. Persistence Clarification

**IMPORTANT**: The system does NOT cache API responses because it doesn't use the Anthropic API. Instead:

1. **No API Caching**: There are no API responses to cache
2. **File Reading**: Session files are read directly from disk every 5 minutes
3. **History Persistence**: Only usage history is persisted between restarts
4. **No TTL**: History uses time-based filtering (24h), not TTL expiration

### Example History File

```json
[
  {
    "timestamp": "2026-01-18T10:00:00.000Z",
    "tokensUsed": 8500,
    "dailyUsage": 25000
  },
  {
    "timestamp": "2026-01-18T10:05:00.000Z",
    "tokensUsed": 8800,
    "dailyUsage": 25300
  },
  {
    "timestamp": "2026-01-18T10:10:00.000Z",
    "tokensUsed": 9200,
    "dailyUsage": 25700
  }
]
```

### History Retrieval API

```javascript
getHistory(hours = 24) {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
  return this.usageHistory.filter(h => new Date(h.timestamp) >= cutoff);
}
```

**Usage**:
- `getHistory()` → Last 24 hours (default)
- `getHistory(12)` → Last 12 hours
- `getHistory(1)` → Last 1 hour

---

## Auto-Refresh Intervals

### Backend Auto-Refresh

The backend tracker initializes with a 5-minute auto-refresh interval:

```javascript
async initialize() {
  console.log('Initialisation du tracker d\'usage Anthropic...');

  // Create data directory if needed
  if (!fs.existsSync(this.dataDir)) {
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  // Load initial data
  await this.refreshUsage();

  // Start auto-refresh (every 5 minutes)
  this.startAutoRefresh(5 * 60 * 1000);

  console.log('Tracker d\'usage initialisé');
}
```

#### Auto-Refresh Implementation

```javascript
startAutoRefresh(interval) {
  // Clear existing interval if any
  if (this.refreshInterval) {
    clearInterval(this.refreshInterval);
  }

  // Start new interval
  this.refreshInterval = setInterval(() => {
    this.refreshUsage();
  }, interval);
}
```

**Parameters**:
- `interval`: Milliseconds between refreshes (default: 300,000 = 5 minutes)

#### Refresh Lifecycle

```
┌──────────────────────────────────────┐
│ App Startup                          │
└────────────┬─────────────────────────┘
             │
             ▼
┌──────────────────────────────────────┐
│ usageTracker.initialize()            │
│ - Load history from disk             │
│ - refreshUsage() (immediate)         │
│ - startAutoRefresh(5 min)            │
└────────────┬─────────────────────────┘
             │
             ▼
     ┌───────────────┐
     │ Every 5 min   │
     └───┬───────────┘
         │
         ▼
┌──────────────────────────────────────┐
│ refreshUsage()                       │
│ 1. calculateUsageFromSessions()      │
│ 2. updateCurrentUsage()              │
│ 3. addToHistory()                    │
│ 4. calculatePredictions()            │
│ 5. emit('usage-updated')             │
└────────────┬─────────────────────────┘
             │
             ▼
┌──────────────────────────────────────┐
│ Broadcast to WebSocket clients       │
└──────────────────────────────────────┘
```

### Frontend Auto-Refresh

The frontend implements its own auto-refresh for the UI:

```javascript
const USAGE_AUTO_REFRESH_MS = 5 * 60 * 1000; // 5 minutes

function startUsageAutoRefresh() {
  // Clear existing interval
  if (usageAutoRefreshInterval) {
    clearInterval(usageAutoRefreshInterval);
  }

  // Start new interval
  usageAutoRefreshInterval = setInterval(async () => {
    // Only refresh if on home page
    if (getCurrentRoute() === 'home') {
      try {
        const data = await apiRequest('/api/usage/current');
        currentUsage = data.usage;
        renderUsageWidget();  // Update UI only
        console.log('Auto-refresh usage effectué');
      } catch (error) {
        console.error('Erreur auto-refresh usage:', error);
      }
    }
  }, USAGE_AUTO_REFRESH_MS);
}
```

**Key Features**:
1. **Route-Aware**: Only refreshes when user is on home page
2. **Partial Update**: Updates widget only, not entire page
3. **Error Handling**: Logs errors but doesn't crash
4. **Independent**: Runs separately from backend refresh

#### Stopping Auto-Refresh

```javascript
function stopUsageAutoRefresh() {
  if (usageAutoRefreshInterval) {
    clearInterval(usageAutoRefreshInterval);
    usageAutoRefreshInterval = null;
  }
}
```

**Called When**:
- User logs out
- User navigates away from home page (optional optimization)
- App shutdown/cleanup

### Manual Refresh

Users can manually trigger a refresh via the UI button:

```javascript
async function refreshUsage() {
  try {
    const data = await apiRequest('/api/usage/refresh', { method: 'POST' });
    currentUsage = data.usage;
    renderUsageWidget();
    return data.usage;
  } catch (error) {
    console.error('Erreur lors du rafraîchissement de l\'usage:', error);
    return null;
  }
}
```

**Triggers**:
- User clicks "🔄" refresh button in usage widget
- Manual page refresh (F5)

### WebSocket Real-Time Updates

In addition to polling, the frontend receives real-time updates via WebSocket:

```javascript
// In backend server.js:
usageTracker.on('usage-updated', (usage) => {
  broadcastToClients({
    type: 'usage-updated',
    usage: usage,
    timestamp: new Date().toISOString()
  });
});

// In frontend app.js:
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);

  if (data.type === 'usage-updated') {
    currentUsage = data.usage;
    if (getCurrentRoute() === 'home') {
      renderUsageWidget();
    }
  }
};
```

**Advantages**:
1. **Low Latency**: Updates appear immediately (no 5-minute wait)
2. **No Polling Overhead**: Server pushes updates
3. **Multi-Tab Sync**: All browser tabs receive updates simultaneously

### Refresh Interval Trade-offs

| Interval | Pros | Cons |
|----------|------|------|
| 1 minute | Very fresh data | High disk I/O, battery drain |
| 5 minutes (current) | Balanced, reasonable freshness | Slight delay in updates |
| 10 minutes | Lower overhead | Stale data, poor UX |

**Current Choice**: 5 minutes provides a good balance between data freshness and system resource usage.

---

## Usage Widget UI Implementation

### Widget Structure

The usage widget is a collapsible card component rendered in the home page:

```html
<div id="usage-widget-container">
  <div class="card usage-card usage-card-collapsed">
    <!-- Collapsed Header (Always Visible) -->
    <div class="usage-header-collapsed" onclick="toggleUsageWidget()">
      <div class="usage-summary">
        <h3>💳 Crédits Claude Code</h3>
        <span class="usage-summary-text">81% · 15,432/19,000 · Refresh 15:00</span>
      </div>
      <div class="usage-header-actions">
        <button onclick="refreshUsage()" class="btn btn-small">🔄</button>
        <span class="usage-toggle-icon">▼</span>
      </div>
    </div>

    <!-- Expanded Content (Hidden by Default) -->
    <div class="usage-content hidden">
      <!-- Availability -->
      <div class="usage-availability">...</div>

      <!-- Progress Bar -->
      <div class="usage-progress">...</div>

      <!-- Stats -->
      <div class="usage-stats">...</div>

      <!-- Info -->
      <div class="usage-info">...</div>

      <!-- Plan Badge -->
      <div class="usage-plan">...</div>
    </div>
  </div>
</div>
```

### Rendering Function

```javascript
function renderUsageWidget() {
  const container = document.getElementById('usage-widget-container');
  if (!container) return;

  // Handle loading state
  if (!currentUsage) {
    container.innerHTML = `
      <div class="card usage-card usage-card-collapsed">
        <div class="usage-header-collapsed" onclick="toggleUsageWidget()">
          <div class="usage-summary">
            <h3>${t('app.creditsTitle')}</h3>
            <span class="usage-summary-text">${t('app.loading')}</span>
          </div>
          <div class="usage-header-actions">
            <button onclick="refreshUsage()" class="btn btn-small">🔄</button>
            <span class="usage-toggle-icon">▼</span>
          </div>
        </div>
      </div>
    `;
    return;
  }

  // Calculate display values
  const percentage = currentUsage.percentageUsed;
  const barColor = percentage < 50 ? '#4caf50' :
                   percentage < 80 ? '#ff9800' : '#f44336';

  const tokensUsed = formatNumber(currentUsage.tokensUsed);
  const tokensLimit = formatNumber(currentUsage.tokensLimit);
  const tokensRemaining = formatNumber(currentUsage.tokensRemaining);
  const dailyUsage = formatNumber(currentUsage.dailyUsage);

  const nextRefreshTime = currentUsage.nextRefresh
    ? getTimeUntil(new Date(currentUsage.nextRefresh))
    : t('app.unknown');
  const nextRefreshHour = currentUsage.nextRefresh
    ? formatRefreshHour(new Date(currentUsage.nextRefresh))
    : '--:--';

  const windowStartHour = currentUsage.nextRefresh
    ? formatRefreshHour(new Date(new Date(currentUsage.nextRefresh).getTime() - 5 * 60 * 60 * 1000))
    : '--:--';

  // Compact summary for collapsed state
  const summaryText = `${percentage.toFixed(0)}% · ${tokensUsed}/${tokensLimit} · Refresh ${nextRefreshHour}`;

  // Render full widget HTML
  container.innerHTML = `
    <div class="card usage-card ${usageWidgetExpanded ? '' : 'usage-card-collapsed'}">
      <!-- Header -->
      <div class="usage-header-collapsed" onclick="toggleUsageWidget()">
        <div class="usage-summary">
          <h3>${t('app.creditsTitle')}</h3>
          <span class="usage-summary-text ${usageWidgetExpanded ? 'hidden' : ''}">${summaryText}</span>
        </div>
        <div class="usage-header-actions">
          <button onclick="refreshUsage()" class="btn btn-small" title="${t('app.refreshData')}">🔄</button>
          <span class="usage-toggle-icon ${usageWidgetExpanded ? 'expanded' : ''}">▼</span>
        </div>
      </div>

      <!-- Expanded content -->
      <div class="usage-content ${usageWidgetExpanded ? '' : 'hidden'}">
        <!-- [See detailed sections below] -->
      </div>
    </div>
  `;
}
```

### Availability Section

Shows the main metric: tokens remaining

```html
<div class="usage-availability">
  <div class="availability-main">
    <span class="availability-label">Disponible maintenant</span>
    <span class="availability-value">3,568</span>
    <span class="availability-unit">tokens</span>
  </div>
</div>
```

**CSS Styling**:
- Large font size for the number (emphasis on remaining capacity)
- Color-coded based on percentage (green/orange/red)

### Progress Bar Section

Visual representation of usage percentage:

```html
<div class="usage-progress">
  <div class="progress-bar-container">
    <div class="progress-bar" style="width: 81.2%; background-color: #ff9800;"></div>
  </div>
  <div class="progress-text">81.2% utilisé (15,432 / 19,000)</div>
</div>
```

**Dynamic Styling**:
- `width`: Set to `percentageUsed`
- `background-color`:
  - Green (`#4caf50`) if < 50%
  - Orange (`#ff9800`) if 50-80%
  - Red (`#f44336`) if > 80%

### Stats Section

Detailed metrics grid:

```html
<div class="usage-stats">
  <div class="stat-item">
    <span class="stat-label">Période (fenêtre):</span>
    <span class="stat-value">10:00 - 15:00</span>
  </div>
  <div class="stat-item">
    <span class="stat-label">Prochaine réinit:</span>
    <span class="stat-value">Dans 30 min (15:00)</span>
  </div>
  <div class="stat-item">
    <span class="stat-label">Aujourd'hui:</span>
    <span class="stat-value">45,678 tokens</span>
  </div>
  <div class="stat-item">
    <span class="stat-label">Taux actuel:</span>
    <span class="stat-value">42 tok/min</span>
  </div>
</div>
```

### Info Section

Help text explaining the sliding window:

```html
<div class="usage-info">
  <p>
    ℹ️ Ces crédits se rechargent progressivement sur une fenêtre glissante de 5 heures.
    Les tokens utilisés expirent 5 heures après leur utilisation.
  </p>
</div>
```

### Plan Badge

Shows detected plan type:

```html
<div class="usage-plan">
  <span class="plan-badge">Plan: MAX5</span>
</div>
```

**Styling**:
- Uppercase plan name
- Badge-style UI element
- Color-coded (optional)

### Toggle Function

```javascript
function toggleUsageWidget() {
  usageWidgetExpanded = !usageWidgetExpanded;
  renderUsageWidget();
}
```

**Behavior**:
- Flips `usageWidgetExpanded` boolean
- Re-renders entire widget
- Toggle icon rotates (▼ ↔ ▲)

### Number Formatting

```javascript
function formatNumber(num) {
  return num.toLocaleString('fr-FR'); // "15 432" instead of "15432"
}
```

**Localization**:
- Uses French locale (space separator)
- Can be adapted for other locales

### Time Formatting

```javascript
function formatRefreshHour(date) {
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;  // "15:00"
}

function getTimeUntil(date) {
  const now = new Date();
  const diff = date - now;
  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  if (hours > 0) {
    return `${hours}h ${mins}m`;
  } else {
    return `${mins} min`;
  }
}
```

### Internationalization (i18n)

The widget uses translation keys:

```javascript
const t = (key) => window.i18n ? window.i18n.t(key) : key;

// Usage:
t('app.creditsTitle')     // "Crédits Claude Code"
t('app.availableNow')     // "Disponible maintenant"
t('app.tokens')           // "tokens"
t('app.used')             // "utilisé"
t('app.refreshData')      // "Rafraîchir les données"
```

---

## Visual Indicators and Progress Bars

### Progress Bar Implementation

The progress bar is a two-layer div system:

```html
<div class="progress-bar-container">
  <div class="progress-bar" style="width: 81.2%; background-color: #ff9800;"></div>
</div>
```

**CSS** (typical):
```css
.progress-bar-container {
  width: 100%;
  height: 20px;
  background-color: #e0e0e0;  /* Gray background */
  border-radius: 10px;
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  transition: width 0.3s ease, background-color 0.3s ease;
  border-radius: 10px;
}
```

**Animation**:
- Smooth width transition when usage changes
- Color transition when crossing thresholds

### Color Thresholds

```javascript
const percentage = currentUsage.percentageUsed;
const barColor = percentage < 50 ? '#4caf50' :
                 percentage < 80 ? '#ff9800' : '#f44336';
```

| Percentage | Color | Hex | Meaning |
|------------|-------|-----|---------|
| 0-49% | Green | `#4caf50` | Safe usage |
| 50-79% | Orange | `#ff9800` | Moderate usage, caution |
| 80-100% | Red | `#f44336` | High usage, warning |
| >100% | Red | `#f44336` | Over limit |

### Visual Indicators

#### 1. Summary Text Color

The collapsed summary text also changes color:

```javascript
<span class="usage-summary-text" style="color: ${barColor};">
  ${summaryText}
</span>
```

#### 2. Availability Value Color

The "tokens remaining" number changes color:

```css
.availability-value {
  color: ${barColor};
  font-size: 2em;
  font-weight: bold;
}
```

#### 3. Icon Indicators

Different icons for different states:

```javascript
const icon = percentage < 50 ? '✅' :
             percentage < 80 ? '⚠️' :
             percentage < 100 ? '🚨' : '❌';
```

- ✅ Green: Safe
- ⚠️ Orange: Caution
- 🚨 Red: Warning
- ❌ Red: Over limit

### Context Widget (Session-Level)

Sessions also have a context widget showing prompt cache usage:

```javascript
function renderContextWidget(contextUsage) {
  if (!contextUsage) return '';

  const { estimatedTokens, maxTokens, percentage, breakdown, warningLevel, isEstimate } = contextUsage;

  const colorMap = {
    'low': '#4caf50',      // Green
    'medium': '#ff9800',   // Orange
    'high': '#f44336',     // Rouge
    'critical': '#d32f2f'  // Dark red
  };
  const barColor = colorMap[warningLevel] || '#4caf50';

  const iconMap = {
    'low': '✅',
    'medium': '⚠️',
    'high': '🚨',
    'critical': '❌'
  };
  const icon = iconMap[warningLevel] || '✅';

  return `
    <div class="context-widget">
      <div class="context-header" onclick="toggleContextDetails()">
        <div class="context-title">
          <span class="context-icon">${icon}</span>
          <span class="context-label">Contexte de session</span>
          ${isEstimate ? '<span class="context-estimate-badge">~</span>' : ''}
        </div>
        <div class="context-summary">
          <span class="context-percentage">${percentage.toFixed(1)}%</span>
          <span class="context-tokens">${formatK(estimatedTokens)} / ${formatK(maxTokens)}</span>
          <span class="context-toggle">▼</span>
        </div>
      </div>
      <div class="context-progress-container">
        <div class="context-progress-bar">
          <div class="context-progress-fill"
               style="width: ${Math.min(100, percentage)}%; background-color: ${barColor};"></div>
        </div>
      </div>
      <div class="context-details" style="display: none;">
        <!-- Breakdown of token types -->
      </div>
    </div>
  `;
}
```

**Warning Levels**:
- `low`: 0-50% (Green ✅)
- `medium`: 50-80% (Orange ⚠️)
- `high`: 80-100% (Red 🚨)
- `critical`: >100% (Dark Red ❌)

---

## Usage Warnings and Alerts

### Warning Trigger Thresholds

Warnings are triggered based on percentage thresholds:

```javascript
// No explicit warning system in current code, but thresholds are visual
const percentage = currentUsage.percentageUsed;

if (percentage >= 80) {
  // RED zone - high usage warning
  // Visual: Red progress bar, red numbers, 🚨 icon
} else if (percentage >= 50) {
  // ORANGE zone - moderate usage caution
  // Visual: Orange progress bar, ⚠️ icon
} else {
  // GREEN zone - safe usage
  // Visual: Green progress bar, ✅ icon
}
```

### Potential Alert System (Not Currently Implemented)

While not explicitly implemented, the system could add alerts:

```javascript
// Example: Alert when crossing 80% threshold
if (percentage >= 80 && !this.alertShown80) {
  showAlert('warning', 'Vous avez utilisé 80% de vos crédits. Attention!');
  this.alertShown80 = true;
}

// Example: Alert when approaching limit with current rate
if (currentUsage.estimatedTimeUntilLimit < 1.0) { // Less than 1 hour
  showAlert('danger', `Au rythme actuel, vous atteindrez la limite dans ${formatTime(currentUsage.estimatedTimeUntilLimit)}`);
}

// Example: Alert when over limit
if (percentage > 100) {
  showAlert('error', 'Vous avez dépassé votre limite de tokens!');
}
```

### Visual Warning Indicators

#### 1. Color-Coded Progress Bar
- Automatically changes color as usage increases
- No explicit threshold checks needed (continuous gradient possible)

#### 2. Numeric Warnings

```javascript
// Example: Show "tokens remaining" in red when low
<span class="availability-value" style="color: ${tokensRemaining < 1000 ? '#f44336' : barColor};">
  ${formatNumber(tokensRemaining)}
</span>
```

#### 3. Textual Warnings

```javascript
// Example: Add warning text when usage is high
${percentage >= 80 ? `
  <div class="usage-warning">
    ⚠️ Attention: Vous avez consommé ${percentage.toFixed(0)}% de vos crédits.
    Envisagez de réduire votre utilisation ou d'attendre le prochain refresh à ${nextRefreshHour}.
  </div>
` : ''}
```

### Refresh Countdown as Warning

The "next refresh" countdown serves as a natural warning system:

```javascript
const nextRefreshTime = getTimeUntil(new Date(currentUsage.nextRefresh));

// Example display:
"Prochaine réinit: Dans 15 min (15:00)"
"Prochaine réinit: Dans 2h 30m (17:00)"
```

**User Interpretation**:
- Short time (< 30 min) + high usage (> 80%) = "Wait for refresh"
- Long time (> 3 hours) + high usage = "Reduce usage now"

### Rate-Based Warnings

The current rate can predict problems:

```javascript
// Example: Warning if rate will exceed limit before refresh
const nextRefresh = new Date(currentUsage.nextRefresh);
const timeUntilRefresh = (nextRefresh - new Date()) / (1000 * 60 * 60); // hours
const tokensPerHour = currentUsage.currentRate * 60;
const projectedTokens = currentUsage.tokensUsed + (tokensPerHour * timeUntilRefresh);

if (projectedTokens > currentUsage.tokensLimit) {
  showAlert('warning', `Au rythme actuel (${currentUsage.currentRate} tok/min), vous dépasserez la limite avant le refresh!`);
}
```

### Error State Handling

If usage data fails to load:

```javascript
if (!currentUsage) {
  container.innerHTML = `
    <div class="card usage-card error-state">
      <div class="usage-error">
        ❌ Erreur lors du chargement des données d'usage.
        <button onclick="refreshUsage()">Réessayer</button>
      </div>
    </div>
  `;
  return;
}
```

---

# PART 2: IMPORTANT VARIABLES/INPUTS/OUTPUTS

## AnthropicUsageTracker Class

### Constructor Options

```javascript
new AnthropicUsageTracker(options)
```

**Input Parameters**:
```javascript
{
  apiKey: string,      // Anthropic API key (not used for fetching)
  dataDir: string      // Directory for usage-history.json
}
```

**Defaults**:
```javascript
{
  apiKey: process.env.ANTHROPIC_API_KEY,
  dataDir: path.join(os.homedir(), '.claude-monitor')
}
```

### Class Properties

```javascript
class AnthropicUsageTracker {
  // Configuration
  apiKey: string
  dataDir: string
  historyFile: string  // Computed: path.join(dataDir, 'usage-history.json')

  // Plan definitions
  plans: {
    pro: { limit: 19000, name: 'Pro' },
    max5: { limit: 88000, name: 'Max5' },
    max20: { limit: 220000, name: 'Max20' },
    custom: { limit: null, name: 'Custom' }
  }

  // Current state
  currentUsage: {
    tokensUsed: number,
    tokensRemaining: number,
    tokensLimit: number,
    percentageUsed: number,
    plan: string,
    lastUpdate: string,
    nextRefresh: string,
    currentRate: number,
    dailyUsage: number,
    hourlyAverage: number,
    estimatedTimeUntilLimit: number | null
  }

  // History
  usageHistory: Array<{
    timestamp: string,
    tokensUsed: number,
    dailyUsage: number
  }>

  // Internal state
  oldestMessageInWindow: Date | null
  refreshInterval: NodeJS.Timer | null
}
```

### Public Methods

#### `initialize(): Promise<void>`
Initializes the tracker and starts auto-refresh.

**Input**: None
**Output**: Promise (resolves when initialized)
**Side Effects**:
- Creates `dataDir` if not exists
- Calls `refreshUsage()` immediately
- Starts 5-minute auto-refresh interval
- Logs initialization status

**Example**:
```javascript
const tracker = new AnthropicUsageTracker();
await tracker.initialize();
console.log('Tracker ready');
```

---

#### `refreshUsage(): Promise<void>`
Recalculates usage from session files and updates state.

**Input**: None
**Output**: Promise (resolves when refresh complete)
**Side Effects**:
- Reads all `.jsonl` files in `~/.claude/projects/`
- Updates `currentUsage` object
- Adds entry to `usageHistory`
- Saves history to disk
- Emits `'usage-updated'` event

**Example**:
```javascript
await tracker.refreshUsage();
console.log(`Usage: ${tracker.currentUsage.tokensUsed} tokens`);
```

---

#### `getCurrentUsage(): Object`
Returns the current usage state.

**Input**: None
**Output**: `currentUsage` object (see structure above)

**Example**:
```javascript
const usage = tracker.getCurrentUsage();
console.log(`${usage.percentageUsed.toFixed(1)}% used`);
```

---

#### `getHistory(hours = 24): Array<Object>`
Returns usage history for the specified time period.

**Input**:
- `hours` (number, default 24): Number of hours to retrieve

**Output**: Array of history entries
```javascript
[
  {
    timestamp: "2026-01-18T10:00:00Z",
    tokensUsed: 8500,
    dailyUsage: 25000
  },
  // ...
]
```

**Example**:
```javascript
const lastHour = tracker.getHistory(1);
console.log(`${lastHour.length} entries in last hour`);
```

---

#### `startAutoRefresh(interval): void`
Starts automatic usage refresh.

**Input**:
- `interval` (number): Milliseconds between refreshes

**Output**: None
**Side Effects**: Sets `refreshInterval` timer

**Example**:
```javascript
tracker.startAutoRefresh(5 * 60 * 1000); // 5 minutes
```

---

#### `stop(): void`
Stops the auto-refresh timer.

**Input**: None
**Output**: None
**Side Effects**: Clears `refreshInterval`

**Example**:
```javascript
tracker.stop();
console.log('Tracker stopped');
```

---

### Private Methods

#### `calculateUsageFromSessions(): Object`
Scans local session files and calculates token usage.

**Input**: None (reads from filesystem)
**Output**:
```javascript
{
  tokensUsed: number,        // Tokens in 5-hour window
  dailyUsage: number,        // Tokens today
  timestamp: string,         // ISO timestamp
  oldestMessageTimestamp: Date | null
}
```

**Side Effects**: Reads multiple `.jsonl` files from disk

---

#### `extractTokensFromSession(sessionPath, todayStart, fiveHoursAgo): Object`
Extracts token counts from a single session file.

**Input**:
- `sessionPath` (string): Absolute path to `.jsonl` file
- `todayStart` (Date): Midnight of current day
- `fiveHoursAgo` (Date): Current time minus 5 hours

**Output**:
```javascript
{
  currentPeriod: number,  // Tokens in 5-hour window
  daily: number,          // Tokens today
  messageCount: number    // Number of messages in window
}
```

**Side Effects**: Reads file from disk

---

#### `detectPlan(tokensUsed): string`
Detects the user's plan tier.

**Input**:
- `tokensUsed` (number): Current token usage

**Output**: Plan name (`'pro'`, `'max5'`, `'max20'`, `'custom'`)

**Current Implementation**: Always returns `'custom'` (defers to `estimateLimit()`)

---

#### `estimateLimit(tokensUsed): number`
Estimates the token limit using P90 algorithm.

**Input**:
- `tokensUsed` (number): Current token usage

**Output**: Estimated limit (integer)

**Algorithm**:
1. Find "limit hits" (usage ≥95% of known limits)
2. Calculate P90 of limit hits
3. Map to closest known limit
4. Fallback to 44,000 if insufficient data

**Example**:
```javascript
const limit = tracker.estimateLimit(17500);
// Returns: 19000 (Pro plan detected)
```

---

#### `calculateRemaining(tokensUsed, plan): number`
Calculates tokens remaining until limit.

**Input**:
- `tokensUsed` (number): Current usage
- `plan` (string): Plan name

**Output**: Remaining tokens (integer, minimum 0)

**Formula**: `max(0, limit - used)`

---

#### `calculatePercentage(tokensUsed, plan): number`
Calculates usage percentage.

**Input**:
- `tokensUsed` (number): Current usage
- `plan` (string): Plan name

**Output**: Percentage (float, 0-100+)

**Formula**: `(used / limit) × 100`

---

#### `estimateNextRefresh(): string`
Calculates when tokens will begin to expire.

**Input**: None (uses `oldestMessageInWindow` state)
**Output**: ISO timestamp string

**Algorithm**:
1. Find oldest message in 5-hour window
2. Round timestamp to hour (downward)
3. Add 5 hours
4. If result is past, anticipate next window

**Example**:
```javascript
// Oldest message: 10:37:42
// Rounded: 10:00:00
// Next refresh: 15:00:00
const next = tracker.estimateNextRefresh();
// Returns: "2026-01-18T15:00:00.000Z"
```

---

#### `calculateCurrentRate(): number`
Calculates tokens per minute based on recent trend.

**Input**: None (uses `usageHistory`)
**Output**: Tokens per minute (integer, minimum 0)

**Algorithm**:
1. Take last 12 history entries (~1 hour)
2. Calculate token difference between first and last
3. Divide by minutes elapsed
4. Return 0 if negative (tokens expiring faster than added)

---

#### `calculateHourlyAverage(): number`
Calculates average tokens per hour over 24 hours.

**Input**: None (uses `usageHistory`)
**Output**: Tokens per hour (integer)

**Algorithm**:
1. Filter history to last 24 hours
2. Sum `dailyUsage` from all entries
3. Divide by 24

---

#### `calculatePredictions(): void`
Updates `estimatedTimeUntilLimit` field.

**Input**: None (uses `currentUsage` state)
**Output**: None (updates state)

**Side Effects**: Sets `currentUsage.estimatedTimeUntilLimit`

**Formula**: `tokensRemaining / (currentRate * 60)`

---

#### `addToHistory(usage): void`
Adds a usage snapshot to history.

**Input**:
```javascript
{
  tokensUsed: number,
  dailyUsage: number,
  timestamp: string
}
```

**Output**: None
**Side Effects**:
- Appends to `usageHistory` array
- Filters to last 24 hours
- Saves to disk via `saveHistory()`

---

#### `loadHistory(): void`
Loads usage history from disk.

**Input**: None (reads from `historyFile`)
**Output**: None
**Side Effects**:
- Reads `usage-history.json`
- Parses JSON
- Filters to last 24 hours
- Saves cleaned data if modified

---

#### `saveHistory(): void`
Saves usage history to disk.

**Input**: None (uses `usageHistory` state)
**Output**: None
**Side Effects**: Writes `usage-history.json` (pretty-printed, 2-space indent)

---

### Events

The tracker extends `EventEmitter` and emits:

#### `'usage-updated'`
Emitted after each successful refresh.

**Payload**: `currentUsage` object

**Example**:
```javascript
tracker.on('usage-updated', (usage) => {
  console.log(`Usage updated: ${usage.percentageUsed.toFixed(1)}%`);
});
```

---

## Usage Data Structures

### Current Usage Object

```typescript
interface CurrentUsage {
  tokensUsed: number;           // Total in 5h window
  tokensRemaining: number;      // Until limit
  tokensLimit: number;          // Max for plan
  percentageUsed: number;       // 0-100+
  plan: string;                 // 'pro'|'max5'|'max20'|'custom'
  lastUpdate: string;           // ISO timestamp
  nextRefresh: string;          // ISO timestamp
  currentRate: number;          // Tokens/minute
  dailyUsage: number;           // Total today
  hourlyAverage: number;        // Avg tokens/hour (24h)
  estimatedTimeUntilLimit: number | null; // Hours (or null)
}
```

**Example**:
```json
{
  "tokensUsed": 15432,
  "tokensRemaining": 3568,
  "tokensLimit": 19000,
  "percentageUsed": 81.22,
  "plan": "pro",
  "lastUpdate": "2026-01-18T14:30:00.000Z",
  "nextRefresh": "2026-01-18T15:00:00.000Z",
  "currentRate": 42,
  "dailyUsage": 45678,
  "hourlyAverage": 1903,
  "estimatedTimeUntilLimit": 1.42
}
```

---

### History Entry Object

```typescript
interface HistoryEntry {
  timestamp: string;    // ISO timestamp
  tokensUsed: number;   // Snapshot of 5h window at this time
  dailyUsage: number;   // Total tokens today at this time
}
```

**Example**:
```json
{
  "timestamp": "2026-01-18T14:30:00.000Z",
  "tokensUsed": 15432,
  "dailyUsage": 45678
}
```

---

### Usage Response Format (API)

```typescript
interface UsageResponse {
  usage: CurrentUsage;
  timestamp: string;
}
```

**Example**:
```json
{
  "usage": {
    "tokensUsed": 15432,
    "tokensRemaining": 3568,
    "tokensLimit": 19000,
    "percentageUsed": 81.22,
    "plan": "pro",
    "lastUpdate": "2026-01-18T14:30:00.000Z",
    "nextRefresh": "2026-01-18T15:00:00.000Z",
    "currentRate": 42,
    "dailyUsage": 45678,
    "hourlyAverage": 1903,
    "estimatedTimeUntilLimit": 1.42
  },
  "timestamp": "2026-01-18T14:30:15.000Z"
}
```

---

### History Response Format (API)

```typescript
interface HistoryResponse {
  history: HistoryEntry[];
  hours: number;
  count: number;
}
```

**Example**:
```json
{
  "history": [
    {
      "timestamp": "2026-01-18T10:00:00.000Z",
      "tokensUsed": 8500,
      "dailyUsage": 25000
    },
    {
      "timestamp": "2026-01-18T10:05:00.000Z",
      "tokensUsed": 8800,
      "dailyUsage": 25300
    }
  ],
  "hours": 24,
  "count": 2
}
```

---

## Plan Configuration

### Plan Definition Structure

```typescript
interface PlanDefinition {
  limit: number | null;  // Token limit (null for custom)
  name: string;          // Display name
}

interface Plans {
  pro: PlanDefinition;
  max5: PlanDefinition;
  max20: PlanDefinition;
  custom: PlanDefinition;
}
```

**Actual Configuration**:
```javascript
this.plans = {
  pro: {
    limit: 19000,    // 19K tokens
    name: 'Pro'
  },
  max5: {
    limit: 88000,    // 88K tokens
    name: 'Max5'
  },
  max20: {
    limit: 220000,   // 220K tokens
    name: 'Max20'
  },
  custom: {
    limit: null,     // Dynamically estimated
    name: 'Custom'
  }
};
```

### Known Limits Array

Used by P90 estimation algorithm:

```javascript
const COMMON_LIMITS = [19000, 44000, 88000, 220000, 880000];
```

**Purpose**:
- Match P90 values to known tiers
- Fallback limits when plan is unclear
- Detection of "limit hit" events (≥95% of these values)

---

## API Endpoints

### `GET /api/usage/current`

Retrieves current usage state.

**Authentication**: Required (`authMiddleware`)

**Request**:
```http
GET /api/usage/current HTTP/1.1
Authorization: Bearer <token>
```

**Response**:
```json
{
  "usage": {
    "tokensUsed": 15432,
    "tokensRemaining": 3568,
    "tokensLimit": 19000,
    "percentageUsed": 81.22,
    "plan": "pro",
    "lastUpdate": "2026-01-18T14:30:00.000Z",
    "nextRefresh": "2026-01-18T15:00:00.000Z",
    "currentRate": 42,
    "dailyUsage": 45678,
    "hourlyAverage": 1903,
    "estimatedTimeUntilLimit": 1.42
  },
  "timestamp": "2026-01-18T14:30:15.000Z"
}
```

**Error Response**:
```json
{
  "error": "Error message",
  "message": "Detailed error"
}
```

**Status Codes**:
- `200 OK`: Success
- `401 Unauthorized`: Missing/invalid auth token
- `500 Internal Server Error`: Tracker error

---

### `GET /api/usage/history`

Retrieves usage history.

**Authentication**: Required (`authMiddleware`)

**Query Parameters**:
- `hours` (optional, default 24): Number of hours to retrieve

**Request**:
```http
GET /api/usage/history?hours=12 HTTP/1.1
Authorization: Bearer <token>
```

**Response**:
```json
{
  "history": [
    {
      "timestamp": "2026-01-18T10:00:00.000Z",
      "tokensUsed": 8500,
      "dailyUsage": 25000
    },
    {
      "timestamp": "2026-01-18T10:05:00.000Z",
      "tokensUsed": 8800,
      "dailyUsage": 25300
    }
  ],
  "hours": 12,
  "count": 2
}
```

**Error Response**:
```json
{
  "error": "Error message",
  "message": "Detailed error"
}
```

**Status Codes**:
- `200 OK`: Success
- `401 Unauthorized`: Missing/invalid auth token
- `500 Internal Server Error`: Tracker error

---

### `POST /api/usage/refresh`

Manually triggers usage refresh.

**Authentication**: Required (`authMiddleware`)

**Request**:
```http
POST /api/usage/refresh HTTP/1.1
Authorization: Bearer <token>
```

**Response**:
```json
{
  "success": true,
  "usage": {
    "tokensUsed": 15432,
    "tokensRemaining": 3568,
    "tokensLimit": 19000,
    "percentageUsed": 81.22,
    "plan": "pro",
    "lastUpdate": "2026-01-18T14:30:15.000Z",
    "nextRefresh": "2026-01-18T15:00:00.000Z",
    "currentRate": 42,
    "dailyUsage": 45678,
    "hourlyAverage": 1903,
    "estimatedTimeUntilLimit": 1.42
  }
}
```

**Error Response**:
```json
{
  "error": "Error message",
  "message": "Detailed error"
}
```

**Status Codes**:
- `200 OK`: Success
- `401 Unauthorized`: Missing/invalid auth token
- `500 Internal Server Error`: Refresh failed

**Side Effects**:
- Triggers `refreshUsage()` on backend tracker
- Emits `'usage-updated'` event to WebSocket clients
- Saves new history entry to disk

---

## UI Functions and Components

### `renderUsageWidget(): void`

Renders the usage widget in the DOM.

**Input**: None (uses global `currentUsage`)
**Output**: None (updates DOM)

**DOM Target**: `#usage-widget-container`

**Side Effects**: Replaces innerHTML of container

**Called By**:
- Initial page load (`renderHomePage()`)
- WebSocket `'usage-updated'` event
- Manual refresh button click
- Auto-refresh interval (every 5 minutes)
- Language change event

---

### `toggleUsageWidget(): void`

Toggles collapsed/expanded state.

**Input**: None
**Output**: None

**Side Effects**:
- Flips `usageWidgetExpanded` boolean
- Calls `renderUsageWidget()` to update DOM

**Example**:
```javascript
// Widget starts collapsed
usageWidgetExpanded = false;

// User clicks header
toggleUsageWidget();
// Now: usageWidgetExpanded = true, widget expands

// User clicks again
toggleUsageWidget();
// Now: usageWidgetExpanded = false, widget collapses
```

---

### `refreshUsage(): Promise<Object | null>`

Manually refreshes usage data from server.

**Input**: None
**Output**: Promise resolving to usage object or null

**Side Effects**:
- Sends POST to `/api/usage/refresh`
- Updates `currentUsage` global
- Calls `renderUsageWidget()`

**Example**:
```javascript
const usage = await refreshUsage();
if (usage) {
  console.log('Refreshed:', usage.percentageUsed);
}
```

---

### `startUsageAutoRefresh(): void`

Starts frontend auto-refresh timer.

**Input**: None
**Output**: None

**Side Effects**:
- Clears existing `usageAutoRefreshInterval`
- Sets new interval (5 minutes)
- Only refreshes when on home route

**Called By**:
- App initialization (after authentication)

---

### `stopUsageAutoRefresh(): void`

Stops frontend auto-refresh timer.

**Input**: None
**Output**: None

**Side Effects**: Clears `usageAutoRefreshInterval`

**Called By**:
- Logout
- App cleanup

---

### `formatNumber(num): string`

Formats numbers with locale-specific separators.

**Input**: Number
**Output**: Formatted string

**Example**:
```javascript
formatNumber(15432) // "15 432" (French)
formatNumber(1500)  // "1 500"
```

---

### `formatRefreshHour(date): string`

Formats time as HH:MM.

**Input**: Date object
**Output**: Time string (HH:MM)

**Example**:
```javascript
formatRefreshHour(new Date('2026-01-18T15:00:00Z'))
// Output: "15:00"
```

---

### `getTimeUntil(date): string`

Calculates human-readable time until a date.

**Input**: Date object
**Output**: String (e.g., "2h 30m", "45 min")

**Example**:
```javascript
const future = new Date(Date.now() + 2.5 * 60 * 60 * 1000);
getTimeUntil(future) // "2h 30m"
```

---

## Error Handling

### Backend Error Handling

#### File Read Errors

```javascript
try {
  const content = fs.readFileSync(sessionPath, 'utf-8');
  // ... process content
} catch (error) {
  console.error(`Erreur lors de la lecture de ${sessionPath}:`, error.message);
  // Continue with next file (graceful degradation)
}
```

**Strategy**: Log error, continue processing other files

---

#### History Load Errors

```javascript
loadHistory() {
  try {
    if (fs.existsSync(this.historyFile)) {
      const data = fs.readFileSync(this.historyFile, 'utf-8');
      this.usageHistory = JSON.parse(data);
    }
  } catch (error) {
    console.error('Erreur lors du chargement de l\'historique:', error.message);
    this.usageHistory = []; // Reset to empty
  }
}
```

**Strategy**: Reset to empty array on failure

---

#### Refresh Errors

```javascript
async refreshUsage() {
  try {
    const usage = await this.calculateUsageFromSessions();
    this.updateCurrentUsage(usage);
    this.addToHistory(usage);
    this.emit('usage-updated', this.currentUsage);
  } catch (error) {
    console.error('Erreur lors du rafraîchissement de l\'usage:', error.message);
    console.error(error.stack);
    // Don't throw - keep system running
  }
}
```

**Strategy**: Log error, don't crash, keep old data

---

### API Error Handling

#### `/api/usage/current`

```javascript
app.get('/api/usage/current', authMiddleware, (req, res) => {
  try {
    const usage = usageTracker.getCurrentUsage();
    res.json({ usage, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({
      error: 'Usage retrieval failed',
      message: error.message
    });
  }
});
```

**Error Response**:
- Status: 500
- Body: `{ error: string, message: string }`

---

#### `/api/usage/refresh`

```javascript
app.post('/api/usage/refresh', authMiddleware, async (req, res) => {
  try {
    await usageTracker.refreshUsage();
    const usage = usageTracker.getCurrentUsage();
    res.json({ success: true, usage });
  } catch (error) {
    res.status(500).json({
      error: 'Refresh failed',
      message: error.message
    });
  }
});
```

**Error Response**:
- Status: 500
- Body: `{ error: string, message: string }`

---

### Frontend Error Handling

#### Fetch Errors

```javascript
async function refreshUsage() {
  try {
    const data = await apiRequest('/api/usage/refresh', { method: 'POST' });
    currentUsage = data.usage;
    renderUsageWidget();
    return data.usage;
  } catch (error) {
    console.error('Erreur lors du rafraîchissement de l\'usage:', error);
    return null; // Graceful failure
  }
}
```

**Strategy**: Log error, return null, keep UI showing old data

---

#### Render Errors

```javascript
function renderUsageWidget() {
  const container = document.getElementById('usage-widget-container');
  if (!container) return; // Guard: element not found

  if (!currentUsage) {
    // Show loading state instead of crashing
    container.innerHTML = `<div>Loading...</div>`;
    return;
  }

  // ... normal rendering
}
```

**Strategy**: Graceful degradation, show loading/error states

---

### WebSocket Error Handling

#### Connection Errors

```javascript
ws.onerror = (error) => {
  console.error('WebSocket error:', error);
  // Auto-reconnect handled by browser
};

ws.onclose = () => {
  console.log('WebSocket closed');
  // Fallback to polling (auto-refresh still active)
};
```

**Strategy**: Log errors, rely on auto-refresh as fallback

---

## Cache TTL and Invalidation

### No Traditional Cache TTL

**Important**: The system does NOT implement traditional cache TTL because:
1. No API responses are cached
2. Data is calculated fresh from local files every 5 minutes
3. History uses time-based filtering (24 hours), not TTL expiration

### History "TTL" (Time-Based Filtering)

```javascript
// In addToHistory():
const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
this.usageHistory = this.usageHistory.filter(h =>
  new Date(h.timestamp) >= oneDayAgo
);
```

**Effective TTL**: 24 hours (rolling window)

**Cleanup Triggers**:
- After each new history entry
- On history load (startup)

### Invalidation Strategies

#### 1. Time-Based Invalidation (Auto-Refresh)

```javascript
// Every 5 minutes, data is recalculated from source
this.refreshInterval = setInterval(() => {
  this.refreshUsage(); // Full recalculation
}, 5 * 60 * 1000);
```

**Invalidation**: Every 5 minutes (automatic)

---

#### 2. Manual Invalidation (User Action)

```javascript
// User clicks refresh button
async function refreshUsage() {
  const data = await apiRequest('/api/usage/refresh', { method: 'POST' });
  currentUsage = data.usage; // Immediate invalidation
  renderUsageWidget();
}
```

**Invalidation**: On-demand (user-triggered)

---

#### 3. Event-Based Invalidation (WebSocket)

```javascript
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'usage-updated') {
    currentUsage = data.usage; // Push invalidation
    renderUsageWidget();
  }
};
```

**Invalidation**: Real-time (server push)

---

### No Stale-While-Revalidate

The system does NOT use stale-while-revalidate patterns. Instead:
- **Old data is kept** if refresh fails
- **No loading spinners** during background refresh
- **Error messages** only appear if data is completely unavailable

---

## TODO Comments and Future Improvements

**Search Results**: No TODO, FIXME, XXX, or HACK comments found in `backend/anthropic-usage-tracker.js`.

### Potential Future Improvements (Inferred)

1. **Implement Persistent Plan Detection**
   - Currently always returns 'custom'
   - Could cache detected plan between restarts

2. **Add Alert System**
   - Visual warnings at 50%, 80%, 100% thresholds
   - Email/push notifications when approaching limit

3. **Historical Charts**
   - Graph of usage over 24 hours
   - Trend analysis and predictions

4. **Multi-User Support**
   - Track usage per API key
   - Aggregate team usage

5. **Cost Calculation**
   - Estimate USD cost based on token usage
   - Budget tracking

6. **Smart Refresh Intervals**
   - Faster refresh during active usage
   - Slower refresh during idle periods

7. **Cache Optimization**
   - Only read modified session files
   - Use file watchers instead of polling

8. **Export Functionality**
   - Export usage history as CSV/JSON
   - Generate usage reports

---

## Summary

The DocClaude Usage Tracking System is a sophisticated monitoring solution that:

1. **Reads local Claude Code session files** instead of querying APIs
2. **Implements a 5-hour sliding window** for token limits (aligned with Claude Code behavior)
3. **Auto-detects plan tiers** using P90 statistical analysis
4. **Provides real-time updates** via WebSocket and auto-refresh
5. **Persists history** for trend analysis and predictions
6. **Displays visual indicators** with color-coded progress bars and warnings
7. **Handles errors gracefully** without crashing the application

The system is production-ready and provides comprehensive visibility into Claude Code API usage.

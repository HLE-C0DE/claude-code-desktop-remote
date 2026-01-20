/**
 * OrchestratorManager.js
 *
 * Manages orchestrator lifecycle, state, and phase transitions.
 * Coordinates the flow between analysis, task planning, worker execution,
 * and aggregation phases.
 */

'use strict';

const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');

/**
 * Valid orchestrator statuses
 */
const ORCHESTRATOR_STATUS = {
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
};

/**
 * Valid orchestrator phases
 */
const ORCHESTRATOR_PHASE = {
  ANALYSIS: 'analysis',
  TASK_PLANNING: 'taskPlanning',
  WORKER_EXECUTION: 'workerExecution',
  AGGREGATION: 'aggregation',
  VERIFICATION: 'verification'
};

/**
 * Phase to status mapping
 */
const PHASE_STATUS_MAP = {
  [ORCHESTRATOR_PHASE.ANALYSIS]: ORCHESTRATOR_STATUS.ANALYZING,
  [ORCHESTRATOR_PHASE.TASK_PLANNING]: ORCHESTRATOR_STATUS.PLANNING,
  [ORCHESTRATOR_PHASE.WORKER_EXECUTION]: ORCHESTRATOR_STATUS.RUNNING,
  [ORCHESTRATOR_PHASE.AGGREGATION]: ORCHESTRATOR_STATUS.AGGREGATING,
  [ORCHESTRATOR_PHASE.VERIFICATION]: ORCHESTRATOR_STATUS.VERIFYING
};

/**
 * Create a new OrchestratorState object
 * @param {Object} options - State initialization options
 * @returns {Object} New orchestrator state
 */
function createOrchestratorState(options = {}) {
  const now = new Date();
  return {
    id: options.id || `orch_${uuidv4().substring(0, 12)}`,
    templateId: options.templateId || null,
    template: options.template || null,
    mainSessionId: options.mainSessionId || null,
    cwd: options.cwd || null,
    userRequest: options.userRequest || '',

    status: ORCHESTRATOR_STATUS.CREATED,
    currentPhase: ORCHESTRATOR_PHASE.ANALYSIS,

    analysis: null,
    tasks: [],
    parallelGroups: [],

    workers: new Map(),

    stats: {
      totalTools: 0,
      reads: 0,
      writes: 0,
      edits: 0,
      bash: 0,
      glob: 0,
      grep: 0,
      task: 0,
      other: 0
    },

    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,

    errors: []
  };
}

/**
 * OrchestratorManager class
 * Manages orchestrator lifecycle and state transitions
 */
class OrchestratorManager extends EventEmitter {
  /**
   * Create a new OrchestratorManager
   * @param {TemplateManager} templateManager - Template manager instance
   * @param {ResponseParser} responseParser - Response parser instance
   * @param {CDPController} cdpController - CDP controller instance
   */
  constructor(templateManager, responseParser, cdpController, options = {}) {
    super();
    this.templateManager = templateManager;
    this.responseParser = responseParser;
    this.cdpController = cdpController;
    this.orchestrators = new Map(); // id -> OrchestratorState

    // Monitoring state
    this.monitoringInterval = null;
    this.isMonitoring = false;
    this.pollInterval = 3000; // Poll every 3 seconds
    this.lastTranscriptLength = new Map(); // sessionId -> last message count

    // Persistence configuration
    this.persistenceEnabled = options.persistenceEnabled !== false; // Default: enabled
    this.persistencePath = options.persistencePath || path.join(__dirname, 'data', 'orchestrators.json');
    this.saveDebounceMs = options.saveDebounceMs || 1000; // Debounce saves
    this._saveTimeout = null;
  }

  // ==================== Persistence Methods ====================

  /**
   * Load orchestrators from persistent storage
   * @returns {Promise<number>} Number of orchestrators loaded
   */
  async loadFromDisk() {
    if (!this.persistenceEnabled) {
      console.log('[OrchestratorManager] Persistence disabled, skipping load');
      return 0;
    }

    try {
      // Ensure data directory exists
      const dataDir = path.dirname(this.persistencePath);
      await fs.mkdir(dataDir, { recursive: true });

      // Check if file exists
      try {
        await fs.access(this.persistencePath);
      } catch {
        console.log('[OrchestratorManager] No persistence file found, starting fresh');
        return 0;
      }

      // Read and parse file
      const data = await fs.readFile(this.persistencePath, 'utf8');
      const orchestratorData = JSON.parse(data);

      let loadedCount = 0;
      for (const orchData of orchestratorData) {
        try {
          // Reconstruct the orchestrator state
          const state = this._deserializeState(orchData);
          this.orchestrators.set(state.id, state);
          loadedCount++;
          console.log(`[OrchestratorManager] Loaded orchestrator: ${state.id} (status: ${state.status})`);
        } catch (err) {
          console.error(`[OrchestratorManager] Failed to load orchestrator: ${err.message}`);
        }
      }

      console.log(`[OrchestratorManager] Loaded ${loadedCount} orchestrators from disk`);
      return loadedCount;
    } catch (error) {
      console.error('[OrchestratorManager] Failed to load from disk:', error.message);
      return 0;
    }
  }

  /**
   * Save all orchestrators to persistent storage
   * @returns {Promise<void>}
   */
  async saveToDisk() {
    if (!this.persistenceEnabled) {
      return;
    }

    try {
      // Ensure data directory exists
      const dataDir = path.dirname(this.persistencePath);
      await fs.mkdir(dataDir, { recursive: true });

      // Serialize all orchestrators
      const orchestratorData = [];
      for (const state of this.orchestrators.values()) {
        orchestratorData.push(this._serializeState(state));
      }

      // Write to file
      await fs.writeFile(
        this.persistencePath,
        JSON.stringify(orchestratorData, null, 2),
        'utf8'
      );

      console.log(`[OrchestratorManager] Saved ${orchestratorData.length} orchestrators to disk`);
    } catch (error) {
      console.error('[OrchestratorManager] Failed to save to disk:', error.message);
    }
  }

  /**
   * Schedule a debounced save to disk
   * @private
   */
  _scheduleSave() {
    if (!this.persistenceEnabled) {
      return;
    }

    // Clear existing timeout
    if (this._saveTimeout) {
      clearTimeout(this._saveTimeout);
    }

    // Schedule new save
    this._saveTimeout = setTimeout(() => {
      this.saveToDisk().catch(err => {
        console.error('[OrchestratorManager] Debounced save failed:', err.message);
      });
    }, this.saveDebounceMs);
  }

  /**
   * Serialize orchestrator state for persistence
   * @private
   */
  _serializeState(state) {
    // Convert Map to object for JSON serialization
    const workers = {};
    if (state.workers instanceof Map) {
      for (const [key, value] of state.workers) {
        workers[key] = value;
      }
    } else if (state.workers && typeof state.workers === 'object') {
      Object.assign(workers, state.workers);
    }

    return {
      id: state.id,
      templateId: state.templateId,
      template: state.template, // Include full template for restoration
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
      errors: state.errors,
      _previousStatus: state._previousStatus,
      _previousPhase: state._previousPhase
    };
  }

  /**
   * Deserialize orchestrator state from persistence
   * @private
   */
  _deserializeState(data) {
    // Convert workers object back to Map
    const workers = new Map();
    if (data.workers && typeof data.workers === 'object') {
      for (const [key, value] of Object.entries(data.workers)) {
        workers.set(key, value);
      }
    }

    // Parse dates
    const parseDate = (val) => val ? new Date(val) : null;

    return {
      id: data.id,
      templateId: data.templateId,
      template: data.template,
      mainSessionId: data.mainSessionId,
      cwd: data.cwd,
      userRequest: data.userRequest || '',
      status: data.status || ORCHESTRATOR_STATUS.CREATED,
      currentPhase: data.currentPhase || ORCHESTRATOR_PHASE.ANALYSIS,
      analysis: data.analysis || null,
      tasks: data.tasks || [],
      parallelGroups: data.parallelGroups || [],
      workers,
      stats: data.stats || {
        totalTools: 0, reads: 0, writes: 0, edits: 0,
        bash: 0, glob: 0, grep: 0, task: 0, other: 0
      },
      customVariables: data.customVariables || {},
      createdAt: parseDate(data.createdAt) || new Date(),
      updatedAt: parseDate(data.updatedAt) || new Date(),
      startedAt: parseDate(data.startedAt),
      completedAt: parseDate(data.completedAt),
      errors: data.errors || [],
      _previousStatus: data._previousStatus,
      _previousPhase: data._previousPhase
    };
  }

  // ==================== Lifecycle Methods ====================

  /**
   * Create a new orchestrator
   * @param {Object} options - Creation options
   * @param {string} options.templateId - Template ID to use
   * @param {string} options.cwd - Working directory
   * @param {string} options.message - User message/request
   * @param {Object} options.customVariables - Custom variable overrides
   * @returns {Promise<Object>} Created orchestrator state
   */
  async create(options = {}) {
    const { templateId, cwd, message, customVariables = {} } = options;

    // Validate required options
    if (!templateId) {
      throw new Error('templateId is required');
    }
    if (!cwd) {
      throw new Error('cwd is required');
    }
    if (!message) {
      throw new Error('message is required');
    }

    try {
      // Load and resolve template
      const template = await this.templateManager.getTemplate(templateId);

      // Generate orchestrator ID
      const id = `orch_${uuidv4().substring(0, 12)}`;

      // Create state object
      const state = createOrchestratorState({
        id,
        templateId,
        template,
        cwd,
        userRequest: message
      });

      // Store custom variables for prompt generation
      state.customVariables = customVariables;

      // Store orchestrator
      this.orchestrators.set(id, state);

      // Persist to disk
      this._scheduleSave();

      // Emit creation event
      this.emit('orchestrator:created', {
        id,
        templateId,
        cwd,
        status: state.status
      });

      return state;
    } catch (error) {
      this._emitError(null, 'create', error);
      throw error;
    }
  }

  /**
   * Start an orchestrator (begin analysis phase)
   * @param {string} orchestratorId - Orchestrator ID
   * @returns {Promise<Object>} Updated orchestrator state
   */
  async start(orchestratorId) {
    const state = this._getStateOrThrow(orchestratorId);

    // Validate state
    if (state.status !== ORCHESTRATOR_STATUS.CREATED &&
        state.status !== ORCHESTRATOR_STATUS.PAUSED) {
      throw new Error(`Cannot start orchestrator in status: ${state.status}`);
    }

    try {
      // If resuming from paused, handle appropriately
      if (state.status === ORCHESTRATOR_STATUS.PAUSED) {
        return this.resume(orchestratorId);
      }

      // Generate system and user prompts separately
      const variables = this._buildVariables(state);
      const promptConfig = state.template.prompts[ORCHESTRATOR_PHASE.ANALYSIS];

      if (!promptConfig) {
        throw new Error('Template missing analysis prompt configuration');
      }

      // Build system prompt (hidden)
      const systemPrompt = promptConfig.system ?
        this.templateManager.substituteVariables(promptConfig.system, variables) :
        '';

      // Build user prompt (visible and "pimped")
      let userPrompt = promptConfig.user ?
        this.templateManager.substituteVariables(promptConfig.user, variables) :
        state.userRequest;

      // Add orchestrator badge to user message
      userPrompt = `🎭 **ORCHESTRATOR MODE** - ${state.template.name}\n\n${userPrompt}`;

      // Create main session with system prompt (will be hidden)
      const session = await this.cdpController.startNewSessionWithMessage(
        state.cwd,
        systemPrompt || userPrompt, // Fallback to userPrompt if no system
        {
          title: `[Orchestrator] ${state.template.name || state.templateId}`
        }
      );

      // Wait for session to be fully initialized before sending follow-up message
      // Claude Desktop needs time to initialize the session after creation
      if (systemPrompt) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        await this.cdpController.sendMessage(session.sessionId, userPrompt);
      }

      // Update state
      state.mainSessionId = session.sessionId;
      state.status = ORCHESTRATOR_STATUS.ANALYZING;
      state.startedAt = new Date();
      this._updateTimestamp(state);

      // Emit started event
      this.emit('orchestrator:started', {
        id: orchestratorId,
        mainSessionId: state.mainSessionId,
        phase: state.currentPhase
      });

      // Initialize lastTranscriptLength to prevent re-processing initial messages
      const messageCount = systemPrompt ? 2 : 1; // 2 if system+user, 1 if only user
      this.lastTranscriptLength.set(state.mainSessionId, messageCount);

      // Start monitoring if not already running
      if (!this.isMonitoring) {
        this.startMonitoring();
      }

      return state;
    } catch (error) {
      state.status = ORCHESTRATOR_STATUS.ERROR;
      state.errors.push({
        phase: ORCHESTRATOR_PHASE.ANALYSIS,
        error: error.message,
        timestamp: new Date()
      });
      this._updateTimestamp(state);
      this._emitError(orchestratorId, 'start', error);
      throw error;
    }
  }

  /**
   * Pause an orchestrator
   * @param {string} orchestratorId - Orchestrator ID
   * @returns {Promise<Object>} Updated orchestrator state
   */
  async pause(orchestratorId) {
    const state = this._getStateOrThrow(orchestratorId);

    // Validate state - can only pause running orchestrators
    const pausableStatuses = [
      ORCHESTRATOR_STATUS.ANALYZING,
      ORCHESTRATOR_STATUS.PLANNING,
      ORCHESTRATOR_STATUS.RUNNING,
      ORCHESTRATOR_STATUS.AGGREGATING
    ];

    if (!pausableStatuses.includes(state.status)) {
      throw new Error(`Cannot pause orchestrator in status: ${state.status}`);
    }

    // Store previous status for resume
    state._previousStatus = state.status;
    state._previousPhase = state.currentPhase;
    state.status = ORCHESTRATOR_STATUS.PAUSED;
    this._updateTimestamp(state);

    this.emit('orchestrator:paused', {
      id: orchestratorId,
      previousStatus: state._previousStatus
    });

    return state;
  }

  /**
   * Resume a paused orchestrator
   * @param {string} orchestratorId - Orchestrator ID
   * @returns {Promise<Object>} Updated orchestrator state
   */
  async resume(orchestratorId) {
    const state = this._getStateOrThrow(orchestratorId);

    if (state.status !== ORCHESTRATOR_STATUS.PAUSED) {
      throw new Error(`Cannot resume orchestrator in status: ${state.status}`);
    }

    // Restore previous status
    state.status = state._previousStatus || ORCHESTRATOR_STATUS.ANALYZING;
    state.currentPhase = state._previousPhase || ORCHESTRATOR_PHASE.ANALYSIS;
    delete state._previousStatus;
    delete state._previousPhase;
    this._updateTimestamp(state);

    this.emit('orchestrator:resumed', {
      id: orchestratorId,
      status: state.status,
      phase: state.currentPhase
    });

    return state;
  }

  /**
   * Cancel an orchestrator
   * @param {string} orchestratorId - Orchestrator ID
   * @returns {Promise<Object>} Updated orchestrator state
   */
  async cancel(orchestratorId) {
    const state = this._getStateOrThrow(orchestratorId);

    // Can cancel at any non-terminal status
    const terminalStatuses = [
      ORCHESTRATOR_STATUS.COMPLETED,
      ORCHESTRATOR_STATUS.CANCELLED,
      ORCHESTRATOR_STATUS.ERROR
    ];

    if (terminalStatuses.includes(state.status)) {
      throw new Error(`Cannot cancel orchestrator in status: ${state.status}`);
    }

    state.status = ORCHESTRATOR_STATUS.CANCELLED;
    state.completedAt = new Date();
    this._updateTimestamp(state);

    this.emit('orchestrator:cancelled', {
      id: orchestratorId,
      phase: state.currentPhase
    });

    return state;
  }

  // ==================== Monitoring ====================

  /**
   * Start monitoring all active orchestrators
   * Polls main sessions for new responses and advances phases
   */
  startMonitoring() {
    if (this.isMonitoring) {
      return;
    }

    this.isMonitoring = true;
    this.monitoringInterval = setInterval(() => {
      this.pollAllOrchestrators().catch(err => {
        console.error('[OrchestratorManager] Polling error:', err.message);
      });
    }, this.pollInterval);

    console.log('[OrchestratorManager] Monitoring started');
  }

  /**
   * Stop monitoring
   */
  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    this.isMonitoring = false;
    console.log('[OrchestratorManager] Monitoring stopped');
  }

  /**
   * Poll all active orchestrators for new responses
   */
  async pollAllOrchestrators() {
    const activeOrchestrators = Array.from(this.orchestrators.values()).filter(orch => {
      return [
        ORCHESTRATOR_STATUS.ANALYZING,
        ORCHESTRATOR_STATUS.PLANNING,
        ORCHESTRATOR_STATUS.CONFIRMING,
        ORCHESTRATOR_STATUS.AGGREGATING
      ].includes(orch.status) && orch.mainSessionId;
    });

    for (const orch of activeOrchestrators) {
      try {
        await this.pollOrchestrator(orch.id);
      } catch (error) {
        console.error(`[OrchestratorManager] Error polling ${orch.id}:`, error.message);
      }
    }
  }

  /**
   * Poll a specific orchestrator for new responses
   * @param {string} orchestratorId - Orchestrator ID
   */
  async pollOrchestrator(orchestratorId) {
    const state = this.orchestrators.get(orchestratorId);
    if (!state || !state.mainSessionId) {
      return;
    }

    try {
      // Get transcript from CDP
      const transcript = await this.cdpController.getTranscript(state.mainSessionId);

      if (!transcript || !transcript.messages) {
        return;
      }

      // Check if there are new messages since last poll
      const lastLength = this.lastTranscriptLength.get(state.mainSessionId) || 0;
      const currentLength = transcript.messages.length;

      if (currentLength <= lastLength) {
        return; // No new messages
      }

      // Update last length
      this.lastTranscriptLength.set(state.mainSessionId, currentLength);

      // Get only new messages
      const newMessages = transcript.messages.slice(lastLength);

      console.log(`[OrchestratorManager] Polling ${orchestratorId}: ${newMessages.length} new message(s), status: ${state.status}, phase: ${state.currentPhase}`);

      // Look for orchestrator responses in new messages
      for (const message of newMessages) {
        if (message.role === 'assistant' && message.content) {
          // Log message preview for debugging
          const contentPreview = message.content.substring(0, 200).replace(/\n/g, ' ');
          console.log(`[OrchestratorManager] Assistant message preview: "${contentPreview}..."`);

          // Check if Claude spawned a Task() agent instead of returning structured response
          if (message.content.includes('Task tool') || message.content.includes('subagent_type')) {
            if (!message.content.includes('<<<ORCHESTRATOR_RESPONSE>>>')) {
              console.warn(`[OrchestratorManager] WARNING: Claude may have spawned a Task() agent instead of returning <<<ORCHESTRATOR_RESPONSE>>>. This bypasses the orchestration system!`);
            }
          }

          // Try to parse orchestrator response
          const parseResult = this.responseParser.parse(message.content);

          console.log(`[OrchestratorManager] Parse result: found=${parseResult.found}, phase=${parseResult.phase || 'N/A'}, error=${parseResult.error || 'none'}`);

          if (parseResult.found && !parseResult.error) {
            console.log(`[OrchestratorManager] Found valid response in ${orchestratorId}, phase: ${parseResult.phase}`);

            // Process the phase
            await this.processPhase(orchestratorId, {
              messages: transcript.messages,
              lastMessage: message
            });

            // Continue processing remaining messages instead of breaking
            // This allows handling multiple responses in the same poll cycle
          } else if (!parseResult.found) {
            console.log(`[OrchestratorManager] No <<<ORCHESTRATOR_RESPONSE>>> delimiter found in message`);
          }
        }
      }

    } catch (error) {
      console.error(`[OrchestratorManager] Error polling orchestrator ${orchestratorId}:`, error.message);
    }
  }

  // ==================== Phase Management ====================

  /**
   * Process current phase based on transcript
   * @param {string} orchestratorId - Orchestrator ID
   * @param {Object} transcript - Transcript data from CDP
   * @returns {Promise<Object>} Processing result
   */
  async processPhase(orchestratorId, transcript) {
    const state = this._getStateOrThrow(orchestratorId);

    // Skip if paused or terminal
    if (state.status === ORCHESTRATOR_STATUS.PAUSED ||
        state.status === ORCHESTRATOR_STATUS.COMPLETED ||
        state.status === ORCHESTRATOR_STATUS.CANCELLED ||
        state.status === ORCHESTRATOR_STATUS.ERROR) {
      return { phaseComplete: false, nextPhase: null };
    }

    try {
      // Extract text from transcript
      const text = this._extractTranscriptText(transcript);

      // Parse for orchestrator responses
      const results = this.responseParser.parseMultiple(text);

      console.log(`[OrchestratorManager] Parsed ${results.length} responses from transcript`);
      if (results.length > 0) {
        console.log(`[OrchestratorManager] First result:`, {
          found: results[0].found,
          phase: results[0].phase,
          hasData: !!results[0].data
        });
      }

      // Find the latest valid response for current phase
      const relevantResult = this._findRelevantResponse(results, state.currentPhase);

      if (!relevantResult || !relevantResult.found) {
        console.log(`[OrchestratorManager] No relevant result found for phase ${state.currentPhase}`);
        return { phaseComplete: false, nextPhase: null };
      }

      // Process based on phase
      let nextPhase = null;

      console.log(`[OrchestratorManager] Processing phase ${state.currentPhase}, response phase: ${relevantResult.phase}`);

      switch (state.currentPhase) {
        case ORCHESTRATOR_PHASE.ANALYSIS:
          if (relevantResult.phase === 'analysis') {
            console.log(`[OrchestratorManager] Handling analysis response...`);
            await this.handleAnalysisResponse(orchestratorId, relevantResult.data);
            console.log(`[OrchestratorManager] Analysis saved:`, state.analysis ? 'YES' : 'NO');
            nextPhase = ORCHESTRATOR_PHASE.TASK_PLANNING;
          }
          break;

        case ORCHESTRATOR_PHASE.TASK_PLANNING:
          if (relevantResult.phase === 'task_list') {
            await this.handleTaskListResponse(orchestratorId, relevantResult.data);
            // Don't auto-advance - wait for user confirmation
            // nextPhase = ORCHESTRATOR_PHASE.WORKER_EXECUTION;
            state.status = ORCHESTRATOR_STATUS.CONFIRMING;
            this.emit('orchestrator:tasksReady', {
              id: orchestratorId,
              taskCount: state.tasks.length
            });
          }
          break;

        case ORCHESTRATOR_PHASE.AGGREGATION:
          if (relevantResult.phase === 'aggregation') {
            await this.handleAggregationResponse(orchestratorId, relevantResult.data);
            const hasVerification = state.template?.phases?.verification?.enabled;
            nextPhase = hasVerification ? ORCHESTRATOR_PHASE.VERIFICATION : null;
          }
          break;

        case ORCHESTRATOR_PHASE.VERIFICATION:
          // Verification complete
          state.status = ORCHESTRATOR_STATUS.COMPLETED;
          state.completedAt = new Date();
          this.emit('orchestrator:completed', {
            id: orchestratorId,
            status: 'success'
          });
          break;

        case ORCHESTRATOR_PHASE.WORKER_EXECUTION:
          // Workers are running, no specific response handling needed
          // Status is updated by WorkerManager callbacks
          console.log(`[OrchestratorManager] Worker execution phase - monitoring workers`);
          break;

        default:
          console.log(`[OrchestratorManager] Unhandled phase: ${state.currentPhase}`);
          break;
      }

      // Auto-advance to next phase if applicable
      if (nextPhase) {
        await this.advanceToPhase(orchestratorId, nextPhase);
        return { phaseComplete: true, nextPhase };
      }

      return { phaseComplete: false, nextPhase: null };
    } catch (error) {
      this._emitError(orchestratorId, 'processPhase', error);
      return { phaseComplete: false, nextPhase: null, error: error.message };
    }
  }

  /**
   * Advance orchestrator to a specific phase
   * @param {string} orchestratorId - Orchestrator ID
   * @param {string} phase - Target phase
   * @returns {Promise<Object>} Updated orchestrator state
   */
  async advanceToPhase(orchestratorId, phase) {
    const state = this._getStateOrThrow(orchestratorId);

    // Validate phase
    if (!Object.values(ORCHESTRATOR_PHASE).includes(phase)) {
      throw new Error(`Invalid phase: ${phase}`);
    }

    const previousPhase = state.currentPhase;
    state.currentPhase = phase;
    state.status = PHASE_STATUS_MAP[phase] || state.status;
    this._updateTimestamp(state);

    // Generate and inject prompt for new phase if needed
    if (phase === ORCHESTRATOR_PHASE.TASK_PLANNING) {
      await this._injectPhasePrompt(state, phase);
    } else if (phase === ORCHESTRATOR_PHASE.AGGREGATION) {
      await this._injectPhasePrompt(state, phase);
    } else if (phase === ORCHESTRATOR_PHASE.VERIFICATION) {
      await this._injectPhasePrompt(state, phase);
    }

    this.emit('orchestrator:phaseChanged', {
      id: orchestratorId,
      previousPhase,
      currentPhase: phase,
      status: state.status
    });

    return state;
  }

  /**
   * Handle analysis phase response
   * @param {string} orchestratorId - Orchestrator ID
   * @param {Object} data - Analysis data from Claude
   */
  async handleAnalysisResponse(orchestratorId, data) {
    const state = this._getStateOrThrow(orchestratorId);

    // Validate analysis data
    const validation = this.responseParser.validatePhase('analysis', data);
    if (!validation.valid) {
      state.errors.push({
        phase: ORCHESTRATOR_PHASE.ANALYSIS,
        error: `Invalid analysis data: ${validation.errors.join(', ')}`,
        timestamp: new Date()
      });
      // Continue anyway with warnings
    }

    // Store analysis
    state.analysis = {
      summary: data.summary,
      recommendedSplits: data.recommended_splits,
      keyFiles: data.key_files || [],
      estimatedComplexity: data.estimated_complexity || 'medium',
      components: data.components || [],
      notes: data.notes || null,
      warnings: data.warnings || []
    };
    this._updateTimestamp(state);

    this.emit('orchestrator:analysisComplete', {
      id: orchestratorId,
      analysis: state.analysis
    });
  }

  /**
   * Handle task list response
   * @param {string} orchestratorId - Orchestrator ID
   * @param {Object} data - Task list data from Claude
   */
  async handleTaskListResponse(orchestratorId, data) {
    const state = this._getStateOrThrow(orchestratorId);

    // Validate task list data
    const validation = this.responseParser.validatePhase('task_list', data);
    if (!validation.valid) {
      throw new Error(`Invalid task list: ${validation.errors.join(', ')}`);
    }

    // Validate each task has required fields
    const tasks = data.tasks || [];
    const validatedTasks = [];

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];

      // Required fields
      if (!task.id) {
        throw new Error(`Task at index ${i} missing required field: id`);
      }
      if (!task.title) {
        throw new Error(`Task at index ${i} missing required field: title`);
      }
      if (!task.description) {
        throw new Error(`Task at index ${i} missing required field: description`);
      }

      validatedTasks.push({
        id: task.id,
        title: task.title,
        description: task.description,
        scope: task.scope || null,
        priority: task.priority || 'normal',
        dependencies: task.dependencies || [],
        estimatedTokens: task.estimated_tokens || null
      });
    }

    // Store tasks
    state.tasks = validatedTasks;

    // Calculate parallel groups if provided, otherwise compute
    if (data.parallelizable_groups && Array.isArray(data.parallelizable_groups)) {
      state.parallelGroups = data.parallelizable_groups;
    } else {
      state.parallelGroups = this._computeParallelGroups(validatedTasks);
    }

    this._updateTimestamp(state);

    this.emit('orchestrator:tasksReady', {
      id: orchestratorId,
      taskCount: validatedTasks.length,
      parallelGroups: state.parallelGroups.length,
      tasks: validatedTasks
    });
  }

  /**
   * Handle aggregation phase response
   * @param {string} orchestratorId - Orchestrator ID
   * @param {Object} data - Aggregation data from Claude
   */
  async handleAggregationResponse(orchestratorId, data) {
    const state = this._getStateOrThrow(orchestratorId);

    // Validate aggregation data
    const validation = this.responseParser.validatePhase('aggregation', data);
    if (!validation.valid) {
      state.errors.push({
        phase: ORCHESTRATOR_PHASE.AGGREGATION,
        error: `Invalid aggregation data: ${validation.errors.join(', ')}`,
        timestamp: new Date()
      });
    }

    // Store aggregation result
    state.aggregation = {
      status: data.status,
      summary: data.summary || null,
      conflicts: data.conflicts || [],
      mergedOutput: data.merged_output || null,
      outputFiles: data.output_files || []
    };

    // Check if verification is enabled
    const hasVerification = state.template?.phases?.verification?.enabled;

    if (!hasVerification || data.status === 'success') {
      // Mark as completed if no verification or aggregation successful
      state.status = ORCHESTRATOR_STATUS.COMPLETED;
      state.completedAt = new Date();

      this.emit('orchestrator:completed', {
        id: orchestratorId,
        status: 'success',
        aggregation: state.aggregation
      });
    }

    this._updateTimestamp(state);
  }

  // ==================== State Management ====================

  /**
   * Get orchestrator by ID
   * @param {string} orchestratorId - Orchestrator ID
   * @returns {Object|null} Orchestrator state or null
   */
  get(orchestratorId) {
    return this.orchestrators.get(orchestratorId) || null;
  }

  /**
   * Get all orchestrators
   * @returns {Array<Object>} Array of all orchestrator states
   */
  getAll() {
    return Array.from(this.orchestrators.values());
  }

  /**
   * Get orchestrator status summary
   * @param {string} orchestratorId - Orchestrator ID
   * @returns {Object|null} Status summary or null
   */
  getStatus(orchestratorId) {
    const state = this.orchestrators.get(orchestratorId);
    if (!state) return null;

    return {
      id: state.id,
      status: state.status,
      currentPhase: state.currentPhase,
      taskCount: state.tasks.length,
      completedTasks: this._countCompletedTasks(state),
      stats: { ...state.stats },
      errors: state.errors.length,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      startedAt: state.startedAt,
      completedAt: state.completedAt
    };
  }

  /**
   * Update aggregated tool statistics
   * @param {string} orchestratorId - Orchestrator ID
   * @param {Object} toolStats - Tool statistics to merge
   */
  updateStats(orchestratorId, toolStats) {
    const state = this.orchestrators.get(orchestratorId);
    if (!state) return;

    // Merge stats
    for (const [key, value] of Object.entries(toolStats)) {
      if (typeof value === 'number') {
        if (state.stats[key] !== undefined) {
          state.stats[key] += value;
        } else {
          state.stats.other += value;
        }
        state.stats.totalTools += value;
      }
    }

    this._updateTimestamp(state);

    this.emit('orchestrator:progress', {
      id: orchestratorId,
      stats: { ...state.stats }
    });
  }

  // ==================== Helpers ====================

  /**
   * Generate prompt for a phase with variable substitution
   * @param {Object} template - Resolved template
   * @param {string} phase - Phase name
   * @param {Object} variables - Variables for substitution
   * @returns {string} Generated prompt
   */
  generatePrompt(template, phase, variables = {}) {
    if (!template || !template.prompts) {
      throw new Error('Template missing prompts configuration');
    }

    // Map phase to prompt key
    const promptKeyMap = {
      [ORCHESTRATOR_PHASE.ANALYSIS]: 'analysis',
      [ORCHESTRATOR_PHASE.TASK_PLANNING]: 'taskPlanning',
      [ORCHESTRATOR_PHASE.AGGREGATION]: 'aggregation',
      [ORCHESTRATOR_PHASE.VERIFICATION]: 'verification'
    };

    const promptKey = promptKeyMap[phase];
    if (!promptKey) {
      throw new Error(`Unknown phase for prompt generation: ${phase}`);
    }

    const promptConfig = template.prompts[promptKey];
    if (!promptConfig) {
      throw new Error(`Template missing prompt for phase: ${phase}`);
    }

    // Build full prompt from system and user parts
    let fullPrompt = '';

    // Add system prompt if present
    if (promptConfig.system) {
      fullPrompt += promptConfig.system;
    }

    // Add user prompt if present
    if (promptConfig.user) {
      if (fullPrompt) fullPrompt += '\n\n---\n\n';
      fullPrompt += promptConfig.user;
    }

    // Fallback to 'template' field for backward compatibility
    if (!fullPrompt && promptConfig.template) {
      fullPrompt = promptConfig.template;
    }

    if (!fullPrompt) {
      throw new Error(`Template prompt for phase '${phase}' has no content (missing system/user/template)`);
    }

    // Substitute variables
    return this.templateManager.substituteVariables(fullPrompt, variables);
  }

  /**
   * Build worker tasks from task list
   * @param {string} orchestratorId - Orchestrator ID
   * @returns {Array<Object>} Worker task definitions
   */
  buildWorkerTasks(orchestratorId) {
    const state = this._getStateOrThrow(orchestratorId);

    if (!state.tasks || state.tasks.length === 0) {
      return [];
    }

    return state.tasks.map(task => ({
      orchestratorId,
      taskId: task.id,
      task: { ...task },
      dependencies: task.dependencies || [],
      priority: task.priority || 'normal'
    }));
  }

  /**
   * Cleanup orchestrator resources
   * @param {string} orchestratorId - Orchestrator ID
   * @param {Object} options - Cleanup options
   * @param {boolean} options.archiveWorkers - Archive worker sessions
   * @param {boolean} options.deleteWorkers - Delete worker sessions
   * @param {boolean} options.removeState - Remove orchestrator from memory
   * @returns {Promise<void>}
   */
  async cleanup(orchestratorId, options = {}) {
    const state = this.orchestrators.get(orchestratorId);
    if (!state) return;

    const {
      archiveWorkers = true,
      deleteWorkers = false,
      removeState = false
    } = options;

    try {
      // Archive or delete worker sessions
      if (state.workers && state.workers.size > 0) {
        for (const [taskId, sessionId] of state.workers) {
          try {
            if (deleteWorkers) {
              // Note: CDP controller may not support delete, archive instead
              await this.cdpController.archiveSession(sessionId);
            } else if (archiveWorkers) {
              await this.cdpController.archiveSession(sessionId);
            }
          } catch (err) {
            console.error(`Failed to cleanup worker ${sessionId}:`, err.message);
          }
        }
      }

      // Remove from memory if requested
      if (removeState) {
        this.orchestrators.delete(orchestratorId);
        // Clean up monitoring state to prevent memory leak
        if (state.mainSessionId) {
          this.lastTranscriptLength.delete(state.mainSessionId);
        }
        // Persist deletion to disk
        this._scheduleSave();
      }

      this.emit('orchestrator:cleanup', {
        id: orchestratorId,
        archived: archiveWorkers,
        deleted: deleteWorkers,
        removed: removeState
      });
    } catch (error) {
      this._emitError(orchestratorId, 'cleanup', error);
      throw error;
    }
  }

  // ==================== Private Methods ====================

  /**
   * Get state or throw error if not found
   * @private
   */
  _getStateOrThrow(orchestratorId) {
    const state = this.orchestrators.get(orchestratorId);
    if (!state) {
      throw new Error(`Orchestrator not found: ${orchestratorId}`);
    }
    return state;
  }

  /**
   * Update timestamp on state
   * @private
   */
  _updateTimestamp(state) {
    state.updatedAt = new Date();
    // Persist changes to disk
    this._scheduleSave();
  }

  /**
   * Emit error event
   * @private
   */
  _emitError(orchestratorId, operation, error) {
    this.emit('orchestrator:error', {
      id: orchestratorId,
      operation,
      error: error.message,
      timestamp: new Date()
    });
  }

  /**
   * Build variables object for prompt substitution
   * @private
   */
  _buildVariables(state) {
    const variables = {
      USER_REQUEST: state.userRequest,
      CWD: state.cwd,
      TEMPLATE_NAME: state.template?.name || state.templateId,
      ORCHESTRATOR_ID: state.id,
      ...(state.customVariables || {})
    };

    // Add analysis data if available
    if (state.analysis) {
      variables.ANALYSIS_SUMMARY = state.analysis.summary;
      variables.RECOMMENDED_SPLITS = state.analysis.recommendedSplits;
      variables.KEY_FILES = state.analysis.keyFiles;
    }

    // Add tasks data if available
    if (state.tasks && state.tasks.length > 0) {
      variables.TASK_COUNT = state.tasks.length;
      variables.TASKS_JSON = JSON.stringify(state.tasks, null, 2);
    }

    return variables;
  }

  /**
   * Extract text content from transcript
   * @private
   */
  _extractTranscriptText(transcript) {
    if (!transcript) return '';

    // Handle transcript object with messages array
    if (transcript.messages && Array.isArray(transcript.messages)) {
      return transcript.messages
        .map(msg => {
          if (typeof msg === 'string') return msg;
          if (msg.content) return msg.content;
          if (msg.text) return msg.text;
          return '';
        })
        .join('\n\n');
    }

    // Handle array of messages
    if (Array.isArray(transcript)) {
      return transcript
        .map(msg => {
          if (typeof msg === 'string') return msg;
          if (msg.content) return msg.content;
          if (msg.text) return msg.text;
          return '';
        })
        .join('\n\n');
    }

    // Handle single message object
    if (transcript.content) return transcript.content;
    if (transcript.text) return transcript.text;
    if (typeof transcript === 'string') return transcript;

    return '';
  }

  /**
   * Find relevant response for current phase
   * @private
   */
  _findRelevantResponse(results, currentPhase) {
    if (!results || results.length === 0) return null;

    // Map phase to expected response phase
    const phaseResponseMap = {
      [ORCHESTRATOR_PHASE.ANALYSIS]: 'analysis',
      [ORCHESTRATOR_PHASE.TASK_PLANNING]: 'task_list',
      [ORCHESTRATOR_PHASE.AGGREGATION]: 'aggregation',
      [ORCHESTRATOR_PHASE.VERIFICATION]: 'verification'
    };

    const expectedPhase = phaseResponseMap[currentPhase];

    // Find most recent matching response (last in array)
    for (let i = results.length - 1; i >= 0; i--) {
      if (results[i].found && results[i].phase === expectedPhase) {
        return results[i];
      }
    }

    return null;
  }

  /**
   * Compute parallel groups from tasks based on dependencies
   * @private
   */
  _computeParallelGroups(tasks) {
    const groups = [];
    const completed = new Set();
    const remaining = new Set(tasks.map(t => t.id));

    while (remaining.size > 0) {
      const group = [];

      // Find all tasks whose dependencies are satisfied
      for (const taskId of remaining) {
        const task = tasks.find(t => t.id === taskId);
        const deps = task.dependencies || [];
        const depsCompleted = deps.every(dep => completed.has(dep));

        if (depsCompleted) {
          group.push(taskId);
        }
      }

      // No progress possible - circular dependency
      if (group.length === 0) {
        // Add remaining as final group (break cycle)
        groups.push(Array.from(remaining));
        break;
      }

      // Add group and mark as completed
      groups.push(group);
      for (const taskId of group) {
        completed.add(taskId);
        remaining.delete(taskId);
      }
    }

    return groups;
  }

  /**
   * Count completed tasks based on worker states
   * @private
   */
  _countCompletedTasks(state) {
    let count = 0;
    // This would be updated when WorkerManager reports completion
    // For now, return 0 as workers aren't yet implemented
    return count;
  }

  /**
   * Inject prompt for a phase into main session
   * @private
   */
  async _injectPhasePrompt(state, phase) {
    if (!state.mainSessionId) {
      throw new Error('No main session to inject prompt into');
    }

    const prompt = this.generatePrompt(
      state.template,
      phase,
      this._buildVariables(state)
    );

    await this.cdpController.sendMessage(state.mainSessionId, prompt);
  }
}

// Export class and constants
module.exports = OrchestratorManager;
module.exports.ORCHESTRATOR_STATUS = ORCHESTRATOR_STATUS;
module.exports.ORCHESTRATOR_PHASE = ORCHESTRATOR_PHASE;
module.exports.createOrchestratorState = createOrchestratorState;

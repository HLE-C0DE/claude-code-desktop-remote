/**
 * WorkerManager.js
 *
 * Manages worker sessions for orchestrated tasks. Handles spawning, monitoring,
 * and lifecycle management of worker Claude sessions via CDP.
 */

'use strict';

const EventEmitter = require('events');

/**
 * Tool patterns for extracting tool usage from transcript
 * These patterns match Claude's typical tool invocation patterns
 */
const TOOL_PATTERNS = {
  read: /(?:Read|Reading|read_file|ReadFile|Glob|glob)/gi,
  write: /(?:Write|Writing|write_file|WriteFile)/gi,
  edit: /(?:Edit|Editing|edit_file|EditFile)/gi,
  bash: /(?:Bash|bash|execute|shell|terminal)/gi,
  search: /(?:Grep|grep|search|ripgrep|rg)/gi,
  web: /(?:WebFetch|WebSearch|web_fetch|web_search)/gi,
  task: /(?:Task\s*\(|subagent|TodoWrite)/gi
};

/**
 * Default configuration for WorkerManager
 */
const DEFAULT_CONFIG = {
  maxWorkers: 5,
  pollInterval: 2000,
  workerTimeout: 300000, // 5 minutes
  retryLimit: 2,
  spawnDelay: 500, // Delay between spawning workers to avoid rate limits
  progressDetectionInterval: 30000 // Expect progress every 30s
};

/**
 * WorkerManager class - manages worker session lifecycle
 */
class WorkerManager extends EventEmitter {
  /**
   * Create a new WorkerManager
   * @param {CDPController} cdpController - CDP controller for session management
   * @param {ResponseParser} responseParser - Parser for orchestrator responses
   * @param {Object} config - Configuration options
   */
  constructor(cdpController, responseParser, config = {}) {
    super();
    this.cdpController = cdpController;
    this.responseParser = responseParser;
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Worker state storage
    this.workers = new Map(); // sessionId -> WorkerState
    this.taskToSession = new Map(); // taskId -> sessionId
    this.orchestratorWorkers = new Map(); // orchestratorId -> Set<sessionId>

    // Task queue for pending tasks
    this.taskQueue = [];
    this.activeCount = 0;

    // Monitoring state
    this.monitoringInterval = null;
    this.isMonitoring = false;

    // Template manager reference (set externally)
    this.templateManager = null;
  }

  /**
   * Set template manager reference for variable substitution
   * @param {TemplateManager} templateManager
   */
  setTemplateManager(templateManager) {
    this.templateManager = templateManager;
  }

  // ==================== Worker Lifecycle ====================

  /**
   * Spawn a single worker for a task
   * @param {string} orchestratorId - Parent orchestrator ID
   * @param {Object} task - Task definition
   * @param {Object} template - Resolved template
   * @param {Object} variables - Variables for prompt substitution
   * @returns {Promise<WorkerState>} Created worker state
   */
  async spawnWorker(orchestratorId, task, template, variables = {}) {
    // Generate session ID with the required naming convention
    const sessionId = this._generateSessionId(orchestratorId, task.id);

    // Check if worker already exists
    if (this.workers.has(sessionId)) {
      throw new Error(`Worker with session ID '${sessionId}' already exists`);
    }

    // Create initial worker state
    const workerState = this._createWorkerState(sessionId, orchestratorId, task);

    // Store worker state
    this.workers.set(sessionId, workerState);
    this.taskToSession.set(task.id, sessionId);

    // Track by orchestrator
    if (!this.orchestratorWorkers.has(orchestratorId)) {
      this.orchestratorWorkers.set(orchestratorId, new Set());
    }
    this.orchestratorWorkers.get(orchestratorId).add(sessionId);

    // Update status to spawning
    workerState.status = 'spawning';
    this.emit('worker:spawning', { sessionId, orchestratorId, taskId: task.id });

    try {
      // Build the worker prompt
      const workerPrompt = this._buildWorkerPrompt(template, task, variables);

      // Get CWD from variables
      const cwd = variables.CWD || process.cwd();

      // Create the session via CDP with the worker prompt
      const session = await this.cdpController.startNewSessionWithMessage(
        cwd,
        workerPrompt,
        {
          title: this._generateSessionTitle(task),
          useWorktree: false
        }
      );

      // Update worker state with actual session info
      workerState.sessionId = session.sessionId || sessionId;
      workerState.status = 'running';
      workerState.startedAt = new Date();
      workerState.lastPollAt = new Date();

      // Update maps if session ID changed
      if (session.sessionId && session.sessionId !== sessionId) {
        this.workers.delete(sessionId);
        this.workers.set(session.sessionId, workerState);
        this.taskToSession.set(task.id, session.sessionId);
        this.orchestratorWorkers.get(orchestratorId).delete(sessionId);
        this.orchestratorWorkers.get(orchestratorId).add(session.sessionId);
      }

      this.activeCount++;

      this.emit('worker:spawned', {
        sessionId: workerState.sessionId,
        orchestratorId,
        taskId: task.id,
        task: task
      });

      this.emit('worker:started', {
        sessionId: workerState.sessionId,
        orchestratorId,
        taskId: task.id
      });

      return workerState;

    } catch (error) {
      // Update worker state on failure
      workerState.status = 'failed';
      workerState.error = error.message;
      workerState.completedAt = new Date();

      this.emit('worker:failed', {
        sessionId,
        orchestratorId,
        taskId: task.id,
        error: error.message
      });

      throw error;
    }
  }

  /**
   * Spawn multiple workers for a batch of tasks
   * @param {string} orchestratorId - Parent orchestrator ID
   * @param {Array} tasks - Array of task definitions
   * @param {Object} template - Resolved template
   * @param {Object} variables - Variables for prompt substitution
   * @returns {Promise<Array<WorkerState>>} Created worker states
   */
  async spawnBatch(orchestratorId, tasks, template, variables = {}) {
    const results = [];
    const tasksToSpawn = tasks.slice(0, this.config.maxWorkers - this.activeCount);

    for (const task of tasksToSpawn) {
      try {
        const worker = await this.spawnWorker(orchestratorId, task, template, variables);
        results.push(worker);

        // Add delay between spawns to avoid rate limiting
        if (this.config.spawnDelay > 0) {
          await this._delay(this.config.spawnDelay);
        }
      } catch (error) {
        console.error(`Failed to spawn worker for task ${task.id}:`, error.message);
        // Continue spawning other workers
      }
    }

    // Queue remaining tasks
    const remainingTasks = tasks.slice(tasksToSpawn.length);
    if (remainingTasks.length > 0) {
      this.queueTasks(remainingTasks.map(task => ({
        orchestratorId,
        task,
        template,
        variables
      })));
    }

    return results;
  }

  // ==================== Monitoring ====================

  /**
   * Start the monitoring loop
   */
  startMonitoring() {
    if (this.isMonitoring) {
      return;
    }

    this.isMonitoring = true;
    this.monitoringInterval = setInterval(
      () => this.pollAllWorkers().catch(err => {
        console.error('[WorkerManager] Polling error:', err.message);
      }),
      this.config.pollInterval
    );

    console.log('[WorkerManager] Monitoring started');
  }

  /**
   * Stop the monitoring loop
   */
  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    this.isMonitoring = false;
    console.log('[WorkerManager] Monitoring stopped');
  }

  /**
   * Poll a single worker for updates
   * @param {string} sessionId - Worker session ID
   * @returns {Promise<Object>} Update result
   */
  async pollWorker(sessionId) {
    const worker = this.workers.get(sessionId);
    if (!worker) {
      return { hasUpdate: false, error: 'Worker not found' };
    }

    // Skip workers that aren't running
    if (!['running', 'spawning'].includes(worker.status)) {
      return { hasUpdate: false, state: worker };
    }

    try {
      // Get the transcript from the session
      const transcript = await this.cdpController.getTranscript(sessionId);
      worker.lastPollAt = new Date();

      if (!transcript || transcript.length === 0) {
        return { hasUpdate: false, state: worker };
      }

      // Parse transcript for orchestrator responses
      const fullText = this._extractTextFromTranscript(transcript);
      const responses = this.responseParser.parseMultiple(fullText);

      let hasUpdate = false;

      // Process each response
      for (const response of responses) {
        if (!response.found || response.error) {
          continue;
        }

        const updateResult = this._processWorkerResponse(worker, response);
        if (updateResult.hasUpdate) {
          hasUpdate = true;
        }
      }

      // Extract tool statistics from transcript
      const toolStats = this._extractToolStats(fullText);
      if (this._hasToolStatsChanged(worker.toolStats, toolStats)) {
        worker.toolStats = toolStats;
        hasUpdate = true;
      }

      // Check for timeout
      if (this._isWorkerTimedOut(worker)) {
        worker.status = 'timeout';
        worker.error = `Worker timed out after ${this.config.workerTimeout}ms`;
        worker.completedAt = new Date();
        this.activeCount = Math.max(0, this.activeCount - 1);

        this.emit('worker:timeout', {
          sessionId: worker.sessionId,
          orchestratorId: worker.orchestratorId,
          taskId: worker.taskId
        });

        hasUpdate = true;
      }

      // Check for completion in transcript text (fallback detection)
      if (worker.status === 'running' && !hasUpdate) {
        const fallback = this.responseParser.detectFallback(fullText);
        if (fallback.detected && fallback.probablePhase === 'completion' && fallback.confidence > 0.7) {
          // Likely completed but didn't use proper format
          worker.currentAction = 'Possibly completed (format not detected)';
          hasUpdate = true;
        }
      }

      if (hasUpdate) {
        this.emit('worker:progress', {
          sessionId: worker.sessionId,
          orchestratorId: worker.orchestratorId,
          taskId: worker.taskId,
          progress: worker.progress,
          status: worker.status,
          currentAction: worker.currentAction,
          toolStats: worker.toolStats
        });
      }

      return { hasUpdate, state: worker };

    } catch (error) {
      console.error(`[WorkerManager] Error polling worker ${sessionId}:`, error.message);
      return { hasUpdate: false, error: error.message, state: worker };
    }
  }

  /**
   * Poll all active workers
   * @returns {Promise<Array>} Array of update results
   */
  async pollAllWorkers() {
    const updates = [];

    for (const [sessionId, worker] of this.workers) {
      if (['running', 'spawning'].includes(worker.status)) {
        const result = await this.pollWorker(sessionId);
        if (result.hasUpdate) {
          updates.push(result);
        }
      }
    }

    // Process queue if there are free slots
    await this._processQueueIfNeeded();

    return updates;
  }

  // ==================== State Management ====================

  /**
   * Get worker by session ID
   * @param {string} sessionId
   * @returns {WorkerState|null}
   */
  getWorker(sessionId) {
    return this.workers.get(sessionId) || null;
  }

  /**
   * Get worker by task ID
   * @param {string} taskId
   * @returns {WorkerState|null}
   */
  getWorkerByTaskId(taskId) {
    const sessionId = this.taskToSession.get(taskId);
    if (!sessionId) return null;
    return this.workers.get(sessionId) || null;
  }

  /**
   * Get all workers for an orchestrator
   * @param {string} orchestratorId
   * @returns {Array<WorkerState>}
   */
  getAllWorkers(orchestratorId) {
    const sessionIds = this.orchestratorWorkers.get(orchestratorId);
    if (!sessionIds) return [];

    return Array.from(sessionIds)
      .map(id => this.workers.get(id))
      .filter(Boolean);
  }

  /**
   * Get active (running) workers for an orchestrator
   * @param {string} orchestratorId
   * @returns {Array<WorkerState>}
   */
  getActiveWorkers(orchestratorId) {
    return this.getAllWorkers(orchestratorId)
      .filter(w => ['running', 'spawning'].includes(w.status));
  }

  /**
   * Get completed workers for an orchestrator
   * @param {string} orchestratorId
   * @returns {Array<WorkerState>}
   */
  getCompletedWorkers(orchestratorId) {
    return this.getAllWorkers(orchestratorId)
      .filter(w => w.status === 'completed');
  }

  /**
   * Get failed workers for an orchestrator
   * @param {string} orchestratorId
   * @returns {Array<WorkerState>}
   */
  getFailedWorkers(orchestratorId) {
    return this.getAllWorkers(orchestratorId)
      .filter(w => ['failed', 'timeout', 'cancelled'].includes(w.status));
  }

  // ==================== Task Queue ====================

  /**
   * Add tasks to the queue
   * @param {Array} tasks - Array of { orchestratorId, task, template, variables }
   */
  queueTasks(tasks) {
    this.taskQueue.push(...tasks);
    console.log(`[WorkerManager] Queued ${tasks.length} tasks. Queue size: ${this.taskQueue.length}`);
  }

  /**
   * Process queued tasks, spawning workers for available slots
   * @param {string} orchestratorId - Optional filter by orchestrator
   * @param {Object} template - Template for new workers
   * @param {Object} variables - Variables for prompt substitution
   * @returns {Promise<number>} Number of tasks spawned
   */
  async processQueue(orchestratorId, template, variables) {
    let spawned = 0;
    const availableSlots = this.config.maxWorkers - this.activeCount;

    if (availableSlots <= 0 || this.taskQueue.length === 0) {
      return 0;
    }

    // Get tasks to spawn (optionally filtered by orchestrator)
    const tasksToProcess = [];
    const remainingQueue = [];

    for (const queuedTask of this.taskQueue) {
      if (tasksToProcess.length >= availableSlots) {
        remainingQueue.push(queuedTask);
      } else if (!orchestratorId || queuedTask.orchestratorId === orchestratorId) {
        tasksToProcess.push(queuedTask);
      } else {
        remainingQueue.push(queuedTask);
      }
    }

    this.taskQueue = remainingQueue;

    // Spawn workers for selected tasks
    for (const { orchestratorId: orchId, task, template: t, variables: v } of tasksToProcess) {
      try {
        await this.spawnWorker(
          orchId,
          task,
          template || t,
          variables || v
        );
        spawned++;

        if (this.config.spawnDelay > 0) {
          await this._delay(this.config.spawnDelay);
        }
      } catch (error) {
        console.error(`[WorkerManager] Failed to spawn queued task ${task.id}:`, error.message);
      }
    }

    return spawned;
  }

  // ==================== Worker Control ====================

  /**
   * Pause a worker (stop monitoring but keep session)
   * @param {string} sessionId
   */
  async pauseWorker(sessionId) {
    const worker = this.workers.get(sessionId);
    if (!worker) {
      throw new Error(`Worker ${sessionId} not found`);
    }

    if (worker.status !== 'running') {
      throw new Error(`Cannot pause worker in status: ${worker.status}`);
    }

    worker.status = 'paused';
    worker.pausedAt = new Date();

    this.emit('worker:paused', {
      sessionId: worker.sessionId,
      orchestratorId: worker.orchestratorId,
      taskId: worker.taskId
    });
  }

  /**
   * Resume a paused worker
   * @param {string} sessionId
   */
  async resumeWorker(sessionId) {
    const worker = this.workers.get(sessionId);
    if (!worker) {
      throw new Error(`Worker ${sessionId} not found`);
    }

    if (worker.status !== 'paused') {
      throw new Error(`Cannot resume worker in status: ${worker.status}`);
    }

    worker.status = 'running';
    delete worker.pausedAt;

    // Extend timeout from resume time
    worker.startedAt = new Date();

    this.emit('worker:resumed', {
      sessionId: worker.sessionId,
      orchestratorId: worker.orchestratorId,
      taskId: worker.taskId
    });
  }

  /**
   * Cancel a worker
   * @param {string} sessionId
   */
  async cancelWorker(sessionId) {
    const worker = this.workers.get(sessionId);
    if (!worker) {
      throw new Error(`Worker ${sessionId} not found`);
    }

    const wasActive = ['running', 'spawning', 'paused'].includes(worker.status);

    worker.status = 'cancelled';
    worker.completedAt = new Date();

    if (wasActive) {
      this.activeCount = Math.max(0, this.activeCount - 1);
    }

    this.emit('worker:cancelled', {
      sessionId: worker.sessionId,
      orchestratorId: worker.orchestratorId,
      taskId: worker.taskId
    });

    // Try to process queue after cancellation
    await this._processQueueIfNeeded();
  }

  /**
   * Retry a failed worker
   * @param {string} sessionId
   * @returns {Promise<WorkerState>} New worker state
   */
  async retryWorker(sessionId) {
    const worker = this.workers.get(sessionId);
    if (!worker) {
      throw new Error(`Worker ${sessionId} not found`);
    }

    if (!['failed', 'timeout', 'cancelled'].includes(worker.status)) {
      throw new Error(`Cannot retry worker in status: ${worker.status}`);
    }

    if (worker.retryCount >= this.config.retryLimit) {
      throw new Error(`Worker has exceeded retry limit (${this.config.retryLimit})`);
    }

    // Get template and variables from original task context
    // These should be stored or passed in
    const { orchestratorId, task } = worker;

    // Increment retry count
    worker.retryCount++;

    this.emit('worker:retrying', {
      sessionId: worker.sessionId,
      orchestratorId,
      taskId: task.id,
      retryCount: worker.retryCount
    });

    // Reset worker state for retry
    worker.status = 'pending';
    worker.progress = 0;
    worker.currentAction = 'Retrying...';
    worker.error = null;
    worker.output = null;
    worker.outputFiles = [];
    worker.completedAt = null;
    worker.startedAt = null;

    // Note: In a real implementation, you'd need to store the template and variables
    // or get them from the OrchestratorManager
    // For now, we just reset the state and let the caller handle re-spawning

    return worker;
  }

  // ==================== Results ====================

  /**
   * Collect all outputs from completed workers
   * @param {string} orchestratorId
   * @returns {Array<Object>} Array of { taskId, output, outputFiles, status }
   */
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

  /**
   * Get aggregated statistics from all workers
   * @param {string} orchestratorId
   * @returns {Object} Aggregated statistics
   */
  getAggregatedStats(orchestratorId) {
    const workers = this.getAllWorkers(orchestratorId);

    const stats = {
      totalWorkers: workers.length,
      completed: 0,
      failed: 0,
      running: 0,
      pending: 0,
      paused: 0,
      cancelled: 0,
      timeout: 0,
      totalProgress: 0,
      toolStats: {
        total: 0,
        reads: 0,
        writes: 0,
        edits: 0,
        bash: 0,
        search: 0,
        web: 0,
        task: 0
      },
      averageProgress: 0,
      totalRetries: 0
    };

    for (const worker of workers) {
      // Count by status
      switch (worker.status) {
        case 'completed':
          stats.completed++;
          break;
        case 'failed':
          stats.failed++;
          break;
        case 'running':
        case 'spawning':
          stats.running++;
          break;
        case 'pending':
          stats.pending++;
          break;
        case 'paused':
          stats.paused++;
          break;
        case 'cancelled':
          stats.cancelled++;
          break;
        case 'timeout':
          stats.timeout++;
          break;
      }

      // Aggregate progress
      stats.totalProgress += worker.progress || 0;

      // Aggregate tool stats
      if (worker.toolStats) {
        for (const [key, value] of Object.entries(worker.toolStats)) {
          if (typeof value === 'number' && stats.toolStats.hasOwnProperty(key)) {
            stats.toolStats[key] += value;
          }
        }
      }

      // Count retries
      stats.totalRetries += worker.retryCount || 0;
    }

    // Calculate average progress
    if (workers.length > 0) {
      stats.averageProgress = Math.round(stats.totalProgress / workers.length);
    }

    // Calculate tool total
    stats.toolStats.total =
      stats.toolStats.reads +
      stats.toolStats.writes +
      stats.toolStats.edits +
      stats.toolStats.bash +
      stats.toolStats.search +
      stats.toolStats.web +
      stats.toolStats.task;

    return stats;
  }

  // ==================== Cleanup ====================

  /**
   * Archive all workers for an orchestrator
   * @param {string} orchestratorId
   */
  async archiveWorkers(orchestratorId) {
    const workers = this.getAllWorkers(orchestratorId);
    const errors = [];

    for (const worker of workers) {
      // Skip workers that are still running
      if (['running', 'spawning'].includes(worker.status)) {
        await this.cancelWorker(worker.sessionId);
      }

      try {
        await this.cdpController.archiveSession(worker.sessionId);
      } catch (error) {
        console.error(`[WorkerManager] Failed to archive worker ${worker.sessionId}:`, error.message);
        errors.push({ sessionId: worker.sessionId, error: error.message });
      }
    }

    // Clean up internal state
    this._cleanupOrchestratorState(orchestratorId);

    this.emit('workers:archived', {
      orchestratorId,
      count: workers.length,
      errors
    });

    return { archived: workers.length - errors.length, errors };
  }

  /**
   * Delete workers from internal state (without archiving)
   * @param {string} orchestratorId
   */
  async deleteWorkers(orchestratorId) {
    const workers = this.getAllWorkers(orchestratorId);

    for (const worker of workers) {
      if (['running', 'spawning'].includes(worker.status)) {
        this.activeCount = Math.max(0, this.activeCount - 1);
      }
    }

    this._cleanupOrchestratorState(orchestratorId);

    this.emit('workers:deleted', {
      orchestratorId,
      count: workers.length
    });
  }

  // ==================== Private Methods ====================

  /**
   * Generate session ID following the naming convention
   * @private
   */
  _generateSessionId(orchestratorId, taskId) {
    // Format: local___orch_{orchestratorId}_worker_{taskId}
    // The double underscore makes them filterable
    return `local___orch_${orchestratorId}_worker_${taskId}`;
  }

  /**
   * Generate a session title for the worker
   * @private
   */
  _generateSessionTitle(task) {
    const prefix = '[Worker]';
    const title = task.title || task.id;
    return `${prefix} ${title}`.substring(0, 100);
  }

  /**
   * Create initial worker state object
   * @private
   */
  _createWorkerState(sessionId, orchestratorId, task) {
    return {
      sessionId,
      orchestratorId,
      taskId: task.id,
      task,

      status: 'pending',
      progress: 0,
      currentAction: 'Initializing...',

      toolStats: {
        total: 0,
        reads: 0,
        writes: 0,
        edits: 0,
        bash: 0,
        search: 0,
        web: 0,
        task: 0
      },

      output: null,
      outputFiles: [],
      error: null,

      retryCount: 0,
      lastPollAt: null,
      startedAt: null,
      completedAt: null
    };
  }

  /**
   * Build the worker prompt from template
   * @private
   */
  _buildWorkerPrompt(template, task, variables) {
    // Get worker prompt from template
    const workerPrompts = template.prompts?.worker;
    if (!workerPrompts) {
      throw new Error('Template missing worker prompts');
    }

    // Build variables for substitution
    const promptVars = {
      ...variables,
      TASK_ID: task.id,
      TASK_TITLE: task.title,
      TASK_DESCRIPTION: task.description,
      TASK_SCOPE: Array.isArray(task.scope) ? task.scope.join(', ') : (task.scope || ''),
      TASK_TYPE: task.type || 'general',
      TASK_PRIORITY: task.priority || 1,
      ORIGINAL_REQUEST: variables.USER_REQUEST || variables.ORIGINAL_REQUEST || ''
    };

    // Use template manager if available for substitution
    let systemPrompt = workerPrompts.system || '';
    let userPrompt = workerPrompts.user || '';

    if (this.templateManager) {
      systemPrompt = this.templateManager.substituteVariables(systemPrompt, promptVars);
      userPrompt = this.templateManager.substituteVariables(userPrompt, promptVars);
    } else {
      // Simple substitution fallback
      for (const [key, value] of Object.entries(promptVars)) {
        const pattern = new RegExp(`\\{${key}\\}`, 'g');
        systemPrompt = systemPrompt.replace(pattern, String(value || ''));
        userPrompt = userPrompt.replace(pattern, String(value || ''));
      }
    }

    // Combine system and user prompts
    // The user prompt is what gets sent as the initial message
    return `${systemPrompt}\n\n---\n\n${userPrompt}`;
  }

  /**
   * Extract text content from transcript array
   * @private
   */
  _extractTextFromTranscript(transcript) {
    if (!Array.isArray(transcript)) {
      return '';
    }

    const textParts = [];

    for (const message of transcript) {
      // Handle different message structures
      if (typeof message === 'string') {
        textParts.push(message);
      } else if (message.content) {
        if (typeof message.content === 'string') {
          textParts.push(message.content);
        } else if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (typeof part === 'string') {
              textParts.push(part);
            } else if (part.text) {
              textParts.push(part.text);
            }
          }
        }
      } else if (message.text) {
        textParts.push(message.text);
      }
    }

    return textParts.join('\n\n');
  }

  /**
   * Process a parsed orchestrator response and update worker state
   * @private
   */
  _processWorkerResponse(worker, response) {
    const { phase, data } = response;

    switch (phase) {
      case 'progress':
        return this._handleProgressResponse(worker, data);

      case 'completion':
        return this._handleCompletionResponse(worker, data);

      default:
        // Unknown phase for worker
        return { hasUpdate: false };
    }
  }

  /**
   * Handle progress response
   * @private
   */
  _handleProgressResponse(worker, data) {
    const hasUpdate =
      worker.progress !== data.progress_percent ||
      worker.currentAction !== data.current_action;

    if (data.progress_percent !== undefined) {
      worker.progress = Math.min(99, Math.max(0, data.progress_percent));
    }

    if (data.current_action) {
      worker.currentAction = data.current_action;
    }

    if (data.output_preview) {
      worker.outputPreview = data.output_preview;
    }

    return { hasUpdate };
  }

  /**
   * Handle completion response
   * @private
   */
  _handleCompletionResponse(worker, data) {
    const previousStatus = worker.status;

    if (data.status === 'success' || data.status === 'partial') {
      worker.status = 'completed';
      worker.progress = 100;
      worker.output = data.output || data.summary || null;
      worker.outputFiles = data.output_files || [];
      worker.currentAction = 'Completed';

      if (data.metrics) {
        worker.metrics = data.metrics;
      }
    } else if (data.status === 'failed') {
      worker.status = 'failed';
      worker.error = data.error || 'Unknown error';
      worker.currentAction = 'Failed';

      if (data.partial_progress) {
        worker.partialProgress = data.partial_progress;
      }
    }

    worker.completedAt = new Date();

    if (previousStatus === 'running') {
      this.activeCount = Math.max(0, this.activeCount - 1);
    }

    // Emit appropriate event
    if (worker.status === 'completed') {
      this.emit('worker:completed', {
        sessionId: worker.sessionId,
        orchestratorId: worker.orchestratorId,
        taskId: worker.taskId,
        output: worker.output,
        outputFiles: worker.outputFiles
      });
    } else if (worker.status === 'failed') {
      this.emit('worker:failed', {
        sessionId: worker.sessionId,
        orchestratorId: worker.orchestratorId,
        taskId: worker.taskId,
        error: worker.error
      });
    }

    return { hasUpdate: true };
  }

  /**
   * Extract tool usage statistics from transcript text
   * @private
   */
  _extractToolStats(text) {
    const stats = {
      total: 0,
      reads: 0,
      writes: 0,
      edits: 0,
      bash: 0,
      search: 0,
      web: 0,
      task: 0
    };

    for (const [key, pattern] of Object.entries(TOOL_PATTERNS)) {
      const matches = text.match(pattern);
      if (matches) {
        stats[key] = matches.length;
        stats.total += matches.length;
      }
    }

    return stats;
  }

  /**
   * Check if tool stats have changed
   * @private
   */
  _hasToolStatsChanged(oldStats, newStats) {
    if (!oldStats) return true;

    for (const key of Object.keys(newStats)) {
      if (oldStats[key] !== newStats[key]) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if a worker has timed out
   * @private
   */
  _isWorkerTimedOut(worker) {
    if (!worker.startedAt || worker.status !== 'running') {
      return false;
    }

    const elapsed = Date.now() - worker.startedAt.getTime();
    return elapsed > this.config.workerTimeout;
  }

  /**
   * Process queue if there are available slots
   * @private
   */
  async _processQueueIfNeeded() {
    if (this.taskQueue.length === 0) {
      return;
    }

    const availableSlots = this.config.maxWorkers - this.activeCount;
    if (availableSlots <= 0) {
      return;
    }

    // Process up to availableSlots tasks
    const tasksToProcess = this.taskQueue.splice(0, availableSlots);

    for (const { orchestratorId, task, template, variables } of tasksToProcess) {
      try {
        await this.spawnWorker(orchestratorId, task, template, variables);

        if (this.config.spawnDelay > 0) {
          await this._delay(this.config.spawnDelay);
        }
      } catch (error) {
        console.error(`[WorkerManager] Failed to spawn queued task:`, error.message);
        // Don't re-queue failed tasks automatically
      }
    }
  }

  /**
   * Clean up internal state for an orchestrator
   * @private
   */
  _cleanupOrchestratorState(orchestratorId) {
    const sessionIds = this.orchestratorWorkers.get(orchestratorId);
    if (!sessionIds) return;

    for (const sessionId of sessionIds) {
      const worker = this.workers.get(sessionId);
      if (worker) {
        this.taskToSession.delete(worker.taskId);
      }
      this.workers.delete(sessionId);
    }

    this.orchestratorWorkers.delete(orchestratorId);

    // Remove from queue any tasks for this orchestrator
    this.taskQueue = this.taskQueue.filter(t => t.orchestratorId !== orchestratorId);
  }

  /**
   * Delay helper
   * @private
   */
  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = WorkerManager;

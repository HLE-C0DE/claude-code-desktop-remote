/**
 * OrchestratorModule - Main export for the orchestration system
 *
 * Provides a unified interface for template management, orchestrator lifecycle,
 * worker management, and response parsing.
 *
 * Usage:
 *   const OrchestratorModule = require('./orchestrator');
 *   const orchestrator = new OrchestratorModule(cdpController, options);
 *   await orchestrator.initialize();
 */

'use strict';

const path = require('path');
const EventEmitter = require('events');
const TemplateManager = require('./TemplateManager');
const ResponseParser = require('./ResponseParser');
const OrchestratorManager = require('./OrchestratorManager');
const WorkerManager = require('./WorkerManager');
const SubSessionManager = require('./SubSessionManager');

/**
 * Main orchestrator module that coordinates all sub-managers
 */
class OrchestratorModule extends EventEmitter {
  /**
   * Create a new OrchestratorModule
   * @param {CDPController} cdpController - CDP controller for session management
   * @param {Object} options - Configuration options
   * @param {string} options.templatesDir - Directory containing templates
   * @param {Object} options.parser - ResponseParser options
   * @param {Object} options.worker - WorkerManager options
   */
  constructor(cdpController, options = {}) {
    super();

    this.cdpController = cdpController;
    this.options = options;

    // Determine templates directory
    const templatesDir = options.templatesDir ||
      path.join(__dirname, 'templates');

    // Initialize sub-managers
    this.templateManager = new TemplateManager(templatesDir);

    this.responseParser = new ResponseParser(options.parser || {});

    this.orchestratorManager = new OrchestratorManager(
      this.templateManager,
      this.responseParser,
      cdpController,
      options.orchestrator || {} // Pass orchestrator-specific options (e.g., persistencePath)
    );

    this.workerManager = new WorkerManager(
      cdpController,
      this.responseParser,
      options.worker || {}
    );

    this.subSessionManager = new SubSessionManager(
      cdpController,
      options.subSession || {}
    );

    // Set up cross-references
    this.workerManager.setTemplateManager(this.templateManager);

    // Track initialization state
    this.initialized = false;

    // Set up event forwarding
    this._setupEventForwarding();
  }

  /**
   * Initialize the orchestrator module
   * Loads templates and persisted orchestrators
   */
  async initialize() {
    if (this.initialized) {
      return;
    }

    try {
      // Initialize template manager (loads templates)
      await this.templateManager.initialize();

      // Load persisted orchestrators from disk
      const loadedCount = await this.orchestratorManager.loadFromDisk();

      this.initialized = true;
      this.emit('initialized', {
        templateCount: (await this.templateManager.getAllTemplates()).length,
        orchestratorCount: loadedCount,
        timestamp: new Date()
      });

      console.log(`[OrchestratorModule] Initialized successfully (${loadedCount} orchestrators restored)`);
    } catch (error) {
      this.emit('error', {
        operation: 'initialize',
        error: error.message,
        timestamp: new Date()
      });
      throw error;
    }
  }

  /**
   * Get template manager
   * @returns {TemplateManager}
   */
  get templates() {
    return this.templateManager;
  }

  /**
   * Get orchestrator manager
   * @returns {OrchestratorManager}
   */
  get orchestrators() {
    return this.orchestratorManager;
  }

  /**
   * Get worker manager
   * @returns {WorkerManager}
   */
  get workers() {
    return this.workerManager;
  }

  /**
   * Get response parser
   * @returns {ResponseParser}
   */
  get parser() {
    return this.responseParser;
  }

  /**
   * Get subsession manager
   * @returns {SubSessionManager}
   */
  get subSessions() {
    return this.subSessionManager;
  }

  // ==================== Convenience Methods ====================

  /**
   * Create and start an orchestrator in one step
   * @param {Object} options - Creation options
   * @returns {Promise<Object>} Orchestrator state
   */
  async createAndStart(options) {
    const orch = await this.orchestratorManager.create(options);
    await this.orchestratorManager.start(orch.id);
    return orch;
  }

  /**
   * Get a summary of all active orchestrators
   * @returns {Array<Object>} Array of orchestrator summaries
   */
  getActiveSummary() {
    return this.orchestratorManager.getAll()
      .filter(o => !['completed', 'cancelled', 'error'].includes(o.status))
      .map(o => ({
        id: o.id,
        templateId: o.templateId,
        status: o.status,
        currentPhase: o.currentPhase,
        taskCount: o.tasks?.length || 0,
        activeWorkers: this.workerManager.getActiveWorkers(o.id).length
      }));
  }

  /**
   * Confirm tasks and spawn workers for an orchestrator
   * @param {string} orchestratorId - Orchestrator ID
   * @param {Object} modifications - Optional task modifications
   * @returns {Promise<Object>} Spawn result
   */
  async confirmTasksAndSpawn(orchestratorId, modifications = {}) {
    const orch = this.orchestratorManager.get(orchestratorId);
    if (!orch) {
      throw new Error(`Orchestrator not found: ${orchestratorId}`);
    }

    // Apply any modifications to tasks
    if (modifications && Object.keys(modifications).length > 0) {
      for (const [taskId, mods] of Object.entries(modifications)) {
        const task = orch.tasks.find(t => t.id === taskId);
        if (task) {
          if (mods.skip) {
            task.skipped = true;
          }
          if (mods.priority !== undefined) {
            task.priority = mods.priority;
          }
        }
      }
    }

    // Filter out skipped tasks
    const tasksToSpawn = orch.tasks.filter(t => !t.skipped);

    // Build variables for worker prompts
    const variables = {
      USER_REQUEST: orch.userRequest,
      CWD: orch.cwd,
      TEMPLATE_NAME: orch.template?.name || orch.templateId,
      ORCHESTRATOR_ID: orch.id,
      ...(orch.customVariables || {})
    };

    // Spawn workers
    const workers = await this.workerManager.spawnBatch(
      orchestratorId,
      tasksToSpawn,
      orch.template,
      variables
    );

    // Update orchestrator status
    orch.status = 'running';
    orch.currentPhase = 'workerExecution';

    // Start monitoring if not already running
    if (!this.workerManager.isMonitoring) {
      this.workerManager.startMonitoring();
    }

    return {
      workersCreated: workers.length,
      tasksQueued: tasksToSpawn.length - workers.length,
      skipped: orch.tasks.length - tasksToSpawn.length
    };
  }

  /**
   * Cancel an orchestrator and cleanup all workers
   * @param {string} orchestratorId - Orchestrator ID
   * @param {Object} options - Cleanup options
   * @returns {Promise<Object>} Cleanup result
   */
  async cancelAndCleanup(orchestratorId, options = {}) {
    const {
      archiveWorkers = true,
      deleteWorkers = false
    } = options;

    // Cancel the orchestrator
    await this.orchestratorManager.cancel(orchestratorId);

    // Archive or delete workers
    let workerCleanup;
    if (deleteWorkers) {
      await this.workerManager.deleteWorkers(orchestratorId);
      workerCleanup = { deleted: true };
    } else if (archiveWorkers) {
      workerCleanup = await this.workerManager.archiveWorkers(orchestratorId);
    }

    // Cleanup orchestrator state if requested
    if (options.removeState) {
      await this.orchestratorManager.cleanup(orchestratorId, { removeState: true });
    }

    return {
      cancelled: true,
      workers: workerCleanup || {},
      archived: archiveWorkers
    };
  }

  // ==================== Private Methods ====================

  /**
   * Set up event forwarding from sub-managers to this module
   * @private
   */
  _setupEventForwarding() {
    // Forward template manager events
    this.templateManager.on('template:loaded', (data) => {
      this.emit('template:loaded', data);
    });
    this.templateManager.on('template:created', (data) => {
      this.emit('template:created', data);
    });
    this.templateManager.on('template:updated', (data) => {
      this.emit('template:updated', data);
    });
    this.templateManager.on('template:deleted', (data) => {
      this.emit('template:deleted', data);
    });
    this.templateManager.on('template:error', (data) => {
      this.emit('template:error', data);
    });

    // Forward orchestrator manager events
    this.orchestratorManager.on('orchestrator:created', (data) => {
      this.emit('orchestrator:created', data);
    });
    this.orchestratorManager.on('orchestrator:started', (data) => {
      this.emit('orchestrator:started', data);
    });
    this.orchestratorManager.on('orchestrator:phaseChanged', (data) => {
      this.emit('orchestrator:phaseChanged', data);
    });
    this.orchestratorManager.on('orchestrator:analysisComplete', (data) => {
      this.emit('orchestrator:analysisComplete', data);
    });
    this.orchestratorManager.on('orchestrator:tasksReady', (data) => {
      this.emit('orchestrator:tasksReady', data);
    });
    this.orchestratorManager.on('orchestrator:progress', (data) => {
      this.emit('orchestrator:progress', data);
    });
    this.orchestratorManager.on('orchestrator:completed', (data) => {
      this.emit('orchestrator:completed', data);
    });
    this.orchestratorManager.on('orchestrator:error', (data) => {
      this.emit('orchestrator:error', data);
    });
    this.orchestratorManager.on('orchestrator:cancelled', (data) => {
      this.emit('orchestrator:cancelled', data);
    });
    this.orchestratorManager.on('orchestrator:paused', (data) => {
      this.emit('orchestrator:paused', data);
    });
    this.orchestratorManager.on('orchestrator:resumed', (data) => {
      this.emit('orchestrator:resumed', data);
    });

    // Forward worker manager events
    this.workerManager.on('worker:spawned', (data) => {
      this.emit('worker:spawned', data);
    });
    this.workerManager.on('worker:started', (data) => {
      this.emit('worker:started', data);
    });
    this.workerManager.on('worker:progress', (data) => {
      this.emit('worker:progress', data);
    });
    this.workerManager.on('worker:completed', (data) => {
      this.emit('worker:completed', data);
      // Update orchestrator stats when worker completes
      this._updateOrchestratorOnWorkerComplete(data);
    });
    this.workerManager.on('worker:failed', (data) => {
      this.emit('worker:failed', data);
    });
    this.workerManager.on('worker:timeout', (data) => {
      this.emit('worker:timeout', data);
    });
    this.workerManager.on('worker:cancelled', (data) => {
      this.emit('worker:cancelled', data);
    });
    this.workerManager.on('worker:retrying', (data) => {
      this.emit('worker:retrying', data);
    });
    this.workerManager.on('workers:archived', (data) => {
      this.emit('workers:archived', data);
    });

    // Forward subsession manager events
    this.subSessionManager.on('subsession:registered', (data) => {
      this.emit('subsession:registered', data);
    });
    this.subSessionManager.on('subsession:statusChanged', (data) => {
      this.emit('subsession:statusChanged', data);
    });
    this.subSessionManager.on('subsession:activity', (data) => {
      this.emit('subsession:activity', data);
    });
    this.subSessionManager.on('subsession:resultReturned', (data) => {
      this.emit('subsession:resultReturned', data);
    });
    this.subSessionManager.on('subsession:orphaned', (data) => {
      this.emit('subsession:orphaned', data);
    });
    this.subSessionManager.on('subsession:error', (data) => {
      this.emit('subsession:error', data);
    });
    this.subSessionManager.on('subsession:archived', (data) => {
      this.emit('subsession:archived', data);
    });
    this.subSessionManager.on('subsession:unregistered', (data) => {
      this.emit('subsession:unregistered', data);
    });
    this.subSessionManager.on('monitoring:started', (data) => {
      this.emit('subsession:monitoring:started', data);
    });
    this.subSessionManager.on('monitoring:stopped', (data) => {
      this.emit('subsession:monitoring:stopped', data);
    });
  }

  /**
   * Update orchestrator state when a worker completes
   * @private
   */
  _updateOrchestratorOnWorkerComplete(data) {
    const orch = this.orchestratorManager.get(data.orchestratorId);
    if (!orch) return;

    // Get aggregated stats from all workers
    const stats = this.workerManager.getAggregatedStats(data.orchestratorId);

    // Update orchestrator stats
    orch.stats = {
      totalTools: stats.toolStats.total,
      reads: stats.toolStats.reads,
      writes: stats.toolStats.writes,
      edits: stats.toolStats.edits,
      bash: stats.toolStats.bash,
      grep: stats.toolStats.search,
      other: stats.toolStats.web + stats.toolStats.task
    };

    // Check if all workers are done
    const allWorkers = this.workerManager.getAllWorkers(data.orchestratorId);
    const activeWorkers = this.workerManager.getActiveWorkers(data.orchestratorId);

    if (allWorkers.length > 0 && activeWorkers.length === 0) {
      // All workers done - advance to aggregation if configured
      const hasAggregation = orch.template?.phases?.aggregation?.enabled;
      if (hasAggregation && orch.currentPhase === 'workerExecution') {
        this.orchestratorManager.advanceToPhase(orch.id, 'aggregation').catch(err => {
          console.error('[OrchestratorModule] Failed to advance to aggregation:', err.message);
        });
      } else if (!hasAggregation) {
        // Mark as completed
        orch.status = 'completed';
        orch.completedAt = new Date();
        this.emit('orchestrator:completed', {
          id: orch.id,
          status: 'success',
          stats: orch.stats
        });
      }
    }
  }
}

// Export the main module class
module.exports = OrchestratorModule;

// Also export individual managers for direct access if needed
module.exports.TemplateManager = TemplateManager;
module.exports.ResponseParser = ResponseParser;
module.exports.OrchestratorManager = OrchestratorManager;
module.exports.WorkerManager = WorkerManager;
module.exports.SubSessionManager = SubSessionManager;

// Export constants from OrchestratorManager
module.exports.ORCHESTRATOR_STATUS = OrchestratorManager.ORCHESTRATOR_STATUS;
module.exports.ORCHESTRATOR_PHASE = OrchestratorManager.ORCHESTRATOR_PHASE;

// Export constants from SubSessionManager
module.exports.SUBSESSION_STATUS = SubSessionManager.SUBSESSION_STATUS;

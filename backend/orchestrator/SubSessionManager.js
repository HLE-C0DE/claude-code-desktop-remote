/**
 * SubSessionManager.js
 *
 * Manages parent-child session relationships for orchestrated tasks.
 * Instead of forcing Claude to return structured responses, this manager:
 * 1. Tracks sessions that are linked to a parent session
 * 2. Monitors subsession activity (last message timestamp)
 * 3. Detects completion via inactivity (configurable threshold)
 * 4. Extracts last assistant message and sends it back to parent session
 *
 * This allows Claude to naturally use the Task tool to spawn agents,
 * with automatic result propagation back to the parent session.
 */

'use strict';

const EventEmitter = require('events');

/**
 * SubSession relationship statuses
 */
const SUBSESSION_STATUS = {
  ACTIVE: 'active',           // Subsession is actively being used
  COMPLETING: 'completing',   // Inactivity detected, waiting for confirmation
  COMPLETED: 'completed',     // Marked as done, ready for result extraction
  RETURNED: 'returned',       // Result sent back to parent
  ORPHANED: 'orphaned',       // Parent session no longer exists
  ERROR: 'error'              // Error during processing
};

/**
 * Default configuration for SubSessionManager
 */
const DEFAULT_CONFIG = {
  pollInterval: 5000,              // Poll every 5 seconds
  inactivityThreshold: 60000,      // 60 seconds of inactivity = completing
  confirmationDelay: 30000,        // 30 seconds additional wait to confirm completion
  resultPrefix: '**[Resultat de sous-tache]**\n\n',
  resultSuffix: '',
  maxMessageLength: 50000,         // Max length of message to return
  autoArchiveOnReturn: false,      // Archive subsession after returning result
  detectTaskSpawn: true,           // Try to detect Task tool spawns
  taskSpawnWindow: 10000           // Time window to link new session to Task spawn (10s)
};

/**
 * SubSession relationship model
 * @typedef {Object} SubSessionRelation
 * @property {string} childSessionId - The subsession ID
 * @property {string} parentSessionId - The parent session ID
 * @property {string} taskToolId - Optional Task tool invocation ID
 * @property {Date} createdAt - When the relation was created
 * @property {Date} lastActivityAt - Last activity timestamp
 * @property {string} status - Current status (SUBSESSION_STATUS)
 * @property {string|null} lastAssistantMessage - Extracted message when completed
 * @property {number} messageCount - Number of messages seen
 * @property {string|null} error - Error message if status is ERROR
 */

/**
 * SubSessionManager class - manages subsession lifecycle and result propagation
 */
class SubSessionManager extends EventEmitter {
  /**
   * Create a new SubSessionManager
   * @param {CDPController} cdpController - CDP controller for session management
   * @param {Object} config - Configuration options
   */
  constructor(cdpController, config = {}) {
    super();
    this.cdpController = cdpController;
    this.config = { ...DEFAULT_CONFIG, ...config };

    // SubSession relationship storage
    this.relations = new Map(); // childSessionId -> SubSessionRelation

    // Reverse lookup: parent -> children
    this.parentToChildren = new Map(); // parentSessionId -> Set<childSessionId>

    // Task spawn detection
    this.pendingTaskSpawns = new Map(); // parentSessionId -> { timestamp, taskToolId }

    // Monitoring state
    this.monitoringInterval = null;
    this.isMonitoring = false;

    // Session message cache for activity tracking
    this.sessionMessageCache = new Map(); // sessionId -> { count, lastContent, timestamp }
  }

  // ==================== Lifecycle Methods ====================

  /**
   * Start the monitoring loop
   */
  startMonitoring() {
    if (this.isMonitoring) {
      return;
    }

    this.isMonitoring = true;
    this.monitoringInterval = setInterval(
      () => this._pollAllSubSessions().catch(err => {
        console.error('[SubSessionManager] Polling error:', err.message);
      }),
      this.config.pollInterval
    );

    console.log('[SubSessionManager] Monitoring started');
    this.emit('monitoring:started', { timestamp: new Date() });
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
    console.log('[SubSessionManager] Monitoring stopped');
    this.emit('monitoring:stopped', { timestamp: new Date() });
  }

  // ==================== Session Registration ====================

  /**
   * Register a new subsession relationship
   * @param {string} childSessionId - The child/subsession ID
   * @param {string} parentSessionId - The parent session ID
   * @param {Object} options - Additional options
   * @param {string} options.taskToolId - Optional Task tool invocation ID
   * @returns {SubSessionRelation} The created relation
   */
  registerSubSession(childSessionId, parentSessionId, options = {}) {
    // Validate session IDs
    if (!childSessionId || !parentSessionId) {
      throw new Error('Both childSessionId and parentSessionId are required');
    }

    // Prevent circular references
    if (childSessionId === parentSessionId) {
      throw new Error('A session cannot be its own parent');
    }

    // Check if already registered
    if (this.relations.has(childSessionId)) {
      const existing = this.relations.get(childSessionId);
      console.warn(`[SubSessionManager] Session ${childSessionId} already registered with parent ${existing.parentSessionId}`);
      return existing;
    }

    // Create relation
    const now = new Date();
    const relation = {
      childSessionId,
      parentSessionId,
      taskToolId: options.taskToolId || null,
      createdAt: now,
      lastActivityAt: now,
      status: SUBSESSION_STATUS.ACTIVE,
      lastAssistantMessage: null,
      messageCount: 0,
      error: null
    };

    // Store relation
    this.relations.set(childSessionId, relation);

    // Update reverse lookup
    if (!this.parentToChildren.has(parentSessionId)) {
      this.parentToChildren.set(parentSessionId, new Set());
    }
    this.parentToChildren.get(parentSessionId).add(childSessionId);

    console.log(`[SubSessionManager] Registered subsession: ${childSessionId} -> parent: ${parentSessionId}`);

    this.emit('subsession:registered', {
      childSessionId,
      parentSessionId,
      taskToolId: options.taskToolId,
      timestamp: now
    });

    // Start monitoring if not already running
    if (!this.isMonitoring) {
      this.startMonitoring();
    }

    return relation;
  }

  /**
   * Register a pending Task tool spawn
   * Call this when a Task tool is invoked in a parent session
   * @param {string} parentSessionId - The parent session ID
   * @param {string} taskToolId - The Task tool invocation ID
   */
  registerTaskSpawn(parentSessionId, taskToolId = null) {
    this.pendingTaskSpawns.set(parentSessionId, {
      timestamp: Date.now(),
      taskToolId
    });

    console.log(`[SubSessionManager] Registered pending Task spawn for parent: ${parentSessionId}`);

    // Clean up old pending spawns
    this._cleanupPendingSpawns();
  }

  /**
   * Try to auto-detect and link a new session to a pending Task spawn
   * @param {string} newSessionId - The newly created session ID
   * @returns {boolean} True if linked, false otherwise
   */
  tryLinkToTaskSpawn(newSessionId) {
    const now = Date.now();

    for (const [parentSessionId, spawn] of this.pendingTaskSpawns) {
      // Check if within time window
      if (now - spawn.timestamp <= this.config.taskSpawnWindow) {
        // Link the session
        this.registerSubSession(newSessionId, parentSessionId, {
          taskToolId: spawn.taskToolId
        });

        // Remove from pending
        this.pendingTaskSpawns.delete(parentSessionId);

        console.log(`[SubSessionManager] Auto-linked session ${newSessionId} to Task spawn from ${parentSessionId}`);
        return true;
      }
    }

    return false;
  }

  // ==================== Query Methods ====================

  /**
   * Get subsession relation by child ID
   * @param {string} childSessionId
   * @returns {SubSessionRelation|null}
   */
  getRelation(childSessionId) {
    return this.relations.get(childSessionId) || null;
  }

  /**
   * Get all children for a parent session
   * @param {string} parentSessionId
   * @returns {Array<SubSessionRelation>}
   */
  getChildren(parentSessionId) {
    const childIds = this.parentToChildren.get(parentSessionId);
    if (!childIds) return [];

    return Array.from(childIds)
      .map(id => this.relations.get(id))
      .filter(Boolean);
  }

  /**
   * Get all active (non-returned) children for a parent
   * @param {string} parentSessionId
   * @returns {Array<SubSessionRelation>}
   */
  getActiveChildren(parentSessionId) {
    return this.getChildren(parentSessionId)
      .filter(r => r.status !== SUBSESSION_STATUS.RETURNED);
  }

  /**
   * Get all subsessions by status
   * @param {string} status - SUBSESSION_STATUS value
   * @returns {Array<SubSessionRelation>}
   */
  getByStatus(status) {
    return Array.from(this.relations.values())
      .filter(r => r.status === status);
  }

  /**
   * Check if a session is a registered subsession
   * @param {string} sessionId
   * @returns {boolean}
   */
  isSubSession(sessionId) {
    return this.relations.has(sessionId);
  }

  /**
   * Check if a session has active subsessions
   * @param {string} sessionId
   * @returns {boolean}
   */
  hasActiveSubSessions(sessionId) {
    return this.getActiveChildren(sessionId).length > 0;
  }

  // ==================== Status Management ====================

  /**
   * Update the status of a subsession
   * @param {string} childSessionId
   * @param {string} newStatus - SUBSESSION_STATUS value
   * @param {Object} updates - Additional updates to apply
   */
  updateStatus(childSessionId, newStatus, updates = {}) {
    const relation = this.relations.get(childSessionId);
    if (!relation) {
      throw new Error(`SubSession not found: ${childSessionId}`);
    }

    const previousStatus = relation.status;
    relation.status = newStatus;

    // Apply additional updates
    Object.assign(relation, updates);

    console.log(`[SubSessionManager] Status change: ${childSessionId} ${previousStatus} -> ${newStatus}`);

    this.emit('subsession:statusChanged', {
      childSessionId,
      parentSessionId: relation.parentSessionId,
      previousStatus,
      newStatus,
      timestamp: new Date()
    });
  }

  /**
   * Mark a subsession as having activity
   * @param {string} childSessionId
   * @param {number} messageCount - Current message count
   */
  recordActivity(childSessionId, messageCount) {
    const relation = this.relations.get(childSessionId);
    if (!relation) return;

    const now = new Date();
    const hadActivity = messageCount > relation.messageCount;

    relation.lastActivityAt = now;
    relation.messageCount = messageCount;

    // Reset to active if was completing and got new activity
    if (hadActivity && relation.status === SUBSESSION_STATUS.COMPLETING) {
      this.updateStatus(childSessionId, SUBSESSION_STATUS.ACTIVE);
    }

    if (hadActivity) {
      this.emit('subsession:activity', {
        childSessionId,
        parentSessionId: relation.parentSessionId,
        messageCount,
        timestamp: now
      });
    }
  }

  // ==================== Result Handling ====================

  /**
   * Extract and return the result from a completed subsession
   * @param {string} childSessionId
   * @returns {Promise<Object>} Result object
   */
  async extractAndReturnResult(childSessionId) {
    const relation = this.relations.get(childSessionId);
    if (!relation) {
      throw new Error(`SubSession not found: ${childSessionId}`);
    }

    if (relation.status === SUBSESSION_STATUS.RETURNED) {
      return { alreadyReturned: true, message: relation.lastAssistantMessage };
    }

    try {
      // Get the transcript
      const transcript = await this.cdpController.getTranscript(childSessionId);

      // Extract last assistant message
      const lastMessage = this._extractLastAssistantMessage(transcript);

      if (!lastMessage) {
        throw new Error('No assistant message found in subsession');
      }

      // Store the message
      relation.lastAssistantMessage = lastMessage;

      // Check if parent still exists
      const parentExists = await this._checkSessionExists(relation.parentSessionId);

      if (!parentExists) {
        this.updateStatus(childSessionId, SUBSESSION_STATUS.ORPHANED, {
          error: 'Parent session no longer exists'
        });
        this.emit('subsession:orphaned', {
          childSessionId,
          parentSessionId: relation.parentSessionId,
          timestamp: new Date()
        });
        return { orphaned: true, message: lastMessage };
      }

      // Format the result message
      const formattedMessage = this._formatResultMessage(lastMessage, relation);

      // Send to parent session
      await this.cdpController.sendMessage(relation.parentSessionId, formattedMessage);

      // Update status
      this.updateStatus(childSessionId, SUBSESSION_STATUS.RETURNED, {
        returnedAt: new Date()
      });

      this.emit('subsession:resultReturned', {
        childSessionId,
        parentSessionId: relation.parentSessionId,
        messageLength: formattedMessage.length,
        timestamp: new Date()
      });

      // Optionally archive the subsession
      if (this.config.autoArchiveOnReturn) {
        try {
          await this.cdpController.archiveSession(childSessionId);
          this.emit('subsession:archived', {
            childSessionId,
            timestamp: new Date()
          });
        } catch (err) {
          console.warn(`[SubSessionManager] Failed to archive subsession ${childSessionId}:`, err.message);
        }
      }

      return { success: true, message: lastMessage, formatted: formattedMessage };

    } catch (error) {
      this.updateStatus(childSessionId, SUBSESSION_STATUS.ERROR, {
        error: error.message
      });

      this.emit('subsession:error', {
        childSessionId,
        parentSessionId: relation.parentSessionId,
        error: error.message,
        timestamp: new Date()
      });

      throw error;
    }
  }

  /**
   * Manually trigger result return for a subsession
   * @param {string} childSessionId
   * @returns {Promise<Object>} Result object
   */
  async forceReturn(childSessionId) {
    const relation = this.relations.get(childSessionId);
    if (!relation) {
      throw new Error(`SubSession not found: ${childSessionId}`);
    }

    // Mark as completing first
    if (relation.status === SUBSESSION_STATUS.ACTIVE) {
      this.updateStatus(childSessionId, SUBSESSION_STATUS.COMPLETING);
    }

    // Then extract and return
    return this.extractAndReturnResult(childSessionId);
  }

  // ==================== Cleanup ====================

  /**
   * Unregister a subsession
   * @param {string} childSessionId
   * @param {Object} options
   * @param {boolean} options.archiveSession - Archive the session
   */
  async unregister(childSessionId, options = {}) {
    const relation = this.relations.get(childSessionId);
    if (!relation) return;

    // Archive if requested
    if (options.archiveSession) {
      try {
        await this.cdpController.archiveSession(childSessionId);
      } catch (err) {
        console.warn(`[SubSessionManager] Failed to archive session ${childSessionId}:`, err.message);
      }
    }

    // Remove from storage
    this.relations.delete(childSessionId);

    // Update reverse lookup
    const parentChildren = this.parentToChildren.get(relation.parentSessionId);
    if (parentChildren) {
      parentChildren.delete(childSessionId);
      if (parentChildren.size === 0) {
        this.parentToChildren.delete(relation.parentSessionId);
      }
    }

    // Clear from cache
    this.sessionMessageCache.delete(childSessionId);

    this.emit('subsession:unregistered', {
      childSessionId,
      parentSessionId: relation.parentSessionId,
      timestamp: new Date()
    });

    // Stop monitoring if no more subsessions
    if (this.relations.size === 0 && this.isMonitoring) {
      this.stopMonitoring();
    }
  }

  /**
   * Unregister all children of a parent session
   * @param {string} parentSessionId
   * @param {Object} options
   */
  async unregisterAllChildren(parentSessionId, options = {}) {
    const children = this.getChildren(parentSessionId);
    for (const child of children) {
      await this.unregister(child.childSessionId, options);
    }
  }

  /**
   * Clean up orphaned and old returned subsessions
   * @param {Object} options
   * @param {number} options.maxAge - Max age in ms for returned sessions (default: 1 hour)
   */
  async cleanup(options = {}) {
    const maxAge = options.maxAge || 3600000; // 1 hour
    const now = Date.now();

    const toRemove = [];

    for (const [childId, relation] of this.relations) {
      // Remove orphaned sessions
      if (relation.status === SUBSESSION_STATUS.ORPHANED) {
        toRemove.push(childId);
        continue;
      }

      // Remove old returned sessions
      if (relation.status === SUBSESSION_STATUS.RETURNED && relation.returnedAt) {
        const age = now - new Date(relation.returnedAt).getTime();
        if (age > maxAge) {
          toRemove.push(childId);
        }
      }
    }

    for (const childId of toRemove) {
      await this.unregister(childId, { archiveSession: false });
    }

    console.log(`[SubSessionManager] Cleanup: removed ${toRemove.length} subsessions`);

    return { removed: toRemove.length };
  }

  // ==================== Statistics ====================

  /**
   * Get statistics about managed subsessions
   * @returns {Object} Statistics object
   */
  getStats() {
    const stats = {
      total: this.relations.size,
      byStatus: {
        [SUBSESSION_STATUS.ACTIVE]: 0,
        [SUBSESSION_STATUS.COMPLETING]: 0,
        [SUBSESSION_STATUS.COMPLETED]: 0,
        [SUBSESSION_STATUS.RETURNED]: 0,
        [SUBSESSION_STATUS.ORPHANED]: 0,
        [SUBSESSION_STATUS.ERROR]: 0
      },
      parents: this.parentToChildren.size,
      pendingTaskSpawns: this.pendingTaskSpawns.size,
      isMonitoring: this.isMonitoring
    };

    for (const relation of this.relations.values()) {
      if (stats.byStatus.hasOwnProperty(relation.status)) {
        stats.byStatus[relation.status]++;
      }
    }

    return stats;
  }

  // ==================== Auto-Detection Methods ====================

  /**
   * Scan a parent session's transcript for Task tool invocations
   * This should be called when monitoring a session that might spawn children
   * @param {string} parentSessionId - The parent session ID to scan
   * @returns {Promise<Array>} Array of detected Task tool invocations
   */
  async scanForTaskSpawns(parentSessionId) {
    if (!this.config.detectTaskSpawn) {
      return [];
    }

    try {
      const transcript = await this.cdpController.getTranscript(parentSessionId);
      if (!transcript || !transcript.messages) {
        return [];
      }

      const taskInvocations = [];

      for (const message of transcript.messages) {
        if (message.role === 'assistant' && message.content) {
          // Look for Task tool invocations in the content
          const taskMatches = this._extractTaskToolInvocations(message.content);
          for (const match of taskMatches) {
            // Register as pending spawn if not already known
            if (!this.pendingTaskSpawns.has(parentSessionId)) {
              this.registerTaskSpawn(parentSessionId, match.taskId);
            }
            taskInvocations.push(match);
          }
        }
      }

      return taskInvocations;
    } catch (error) {
      console.error(`[SubSessionManager] Error scanning for Task spawns in ${parentSessionId}:`, error.message);
      return [];
    }
  }

  /**
   * Auto-detect and link new sessions to pending Task spawns
   * This should be called periodically or when new sessions are detected
   * @returns {Promise<number>} Number of sessions linked
   */
  async autoDetectNewSessions() {
    if (!this.config.detectTaskSpawn) {
      return 0;
    }

    try {
      // Get all current sessions
      const sessions = await this.cdpController.getAllSessions(true); // Force refresh
      if (!sessions || sessions.length === 0) {
        return 0;
      }

      let linkedCount = 0;

      for (const session of sessions) {
        const sessionId = session.sessionId || session.id;
        if (!sessionId) continue;

        // Skip if already registered
        if (this.relations.has(sessionId)) {
          continue;
        }

        // Try to link to a pending Task spawn
        if (this.tryLinkToTaskSpawn(sessionId)) {
          linkedCount++;
        }
      }

      return linkedCount;
    } catch (error) {
      console.error('[SubSessionManager] Error auto-detecting new sessions:', error.message);
      return 0;
    }
  }

  /**
   * Watch a parent session for Task tool usage and auto-link spawned sessions
   * This is the main entry point for automatic subsession management
   * @param {string} parentSessionId - The parent session ID to watch
   */
  async watchParentSession(parentSessionId) {
    console.log(`[SubSessionManager] Watching parent session: ${parentSessionId}`);

    // Scan for existing Task spawns
    await this.scanForTaskSpawns(parentSessionId);

    // Auto-detect will be called during polling
    // Start monitoring if not already running
    if (!this.isMonitoring) {
      this.startMonitoring();
    }
  }

  /**
   * Extract Task tool invocations from message content
   * @private
   */
  _extractTaskToolInvocations(content) {
    const invocations = [];

    // Pattern 1: Look for Task tool blocks (XML-like format used in tool calls)
    const taskToolPattern = /<invoke name="Task"[^>]*>[\s\S]*?<\/antml:invoke>/gi;
    const matches = content.match(taskToolPattern);

    if (matches) {
      for (const match of matches) {
        // Extract task ID if present
        const idMatch = match.match(/task_?id["\s:=]+["']?([^"'\s<>]+)/i);
        invocations.push({
          taskId: idMatch ? idMatch[1] : `auto_${Date.now()}`,
          raw: match.substring(0, 200)
        });
      }
    }

    // Pattern 2: Look for subagent_type mentions (indicates Task tool usage)
    if (content.includes('subagent_type') || content.includes('Task tool')) {
      // This is a heuristic - the actual Task invocation happened
      if (invocations.length === 0) {
        invocations.push({
          taskId: `inferred_${Date.now()}`,
          raw: 'Task tool usage detected'
        });
      }
    }

    return invocations;
  }

  // ==================== Private Methods ====================

  /**
   * Poll all subsessions for activity and completion
   * @private
   */
  async _pollAllSubSessions() {
    const now = Date.now();

    for (const [childId, relation] of this.relations) {
      // Skip already returned or error sessions
      if (relation.status === SUBSESSION_STATUS.RETURNED ||
          relation.status === SUBSESSION_STATUS.ORPHANED ||
          relation.status === SUBSESSION_STATUS.ERROR) {
        continue;
      }

      try {
        // Get transcript to check for activity
        const transcript = await this.cdpController.getTranscript(childId);

        if (!transcript || !transcript.messages) {
          // Session might be deleted
          const exists = await this._checkSessionExists(childId);
          if (!exists) {
            this.updateStatus(childId, SUBSESSION_STATUS.ERROR, {
              error: 'Session no longer exists'
            });
            continue;
          }
        }

        const messageCount = transcript?.messages?.length || 0;
        const lastMessage = this._getLastMessage(transcript);
        const lastMessageIsAssistant = lastMessage?.role === 'assistant';

        // Check if there's new activity
        const cached = this.sessionMessageCache.get(childId);
        const hasNewActivity = !cached || cached.count !== messageCount;

        if (hasNewActivity) {
          // Update cache
          this.sessionMessageCache.set(childId, {
            count: messageCount,
            lastContent: lastMessage?.content?.substring(0, 200),
            timestamp: now
          });

          // Record activity
          this.recordActivity(childId, messageCount);
        }

        // Check for inactivity
        const timeSinceActivity = now - new Date(relation.lastActivityAt).getTime();

        if (relation.status === SUBSESSION_STATUS.ACTIVE) {
          // Check if should mark as completing
          if (timeSinceActivity >= this.config.inactivityThreshold && lastMessageIsAssistant) {
            console.log(`[SubSessionManager] Inactivity detected for ${childId} (${timeSinceActivity}ms)`);
            this.updateStatus(childId, SUBSESSION_STATUS.COMPLETING);
          }
        } else if (relation.status === SUBSESSION_STATUS.COMPLETING) {
          // Check if should mark as completed
          const completingTime = now - new Date(relation.lastActivityAt).getTime();
          if (completingTime >= this.config.inactivityThreshold + this.config.confirmationDelay) {
            console.log(`[SubSessionManager] Completion confirmed for ${childId}`);
            this.updateStatus(childId, SUBSESSION_STATUS.COMPLETED);

            // Auto-return result
            this.extractAndReturnResult(childId).catch(err => {
              console.error(`[SubSessionManager] Failed to return result for ${childId}:`, err.message);
            });
          }
        }

      } catch (error) {
        console.error(`[SubSessionManager] Error polling ${childId}:`, error.message);
      }
    }

    // Clean up old pending spawns
    this._cleanupPendingSpawns();

    // Auto-detect new sessions (periodically, not every poll)
    if (this.config.detectTaskSpawn && this.pendingTaskSpawns.size > 0) {
      await this.autoDetectNewSessions();
    }
  }

  /**
   * Clean up old pending Task spawns
   * @private
   */
  _cleanupPendingSpawns() {
    const now = Date.now();
    const expired = [];

    for (const [parentId, spawn] of this.pendingTaskSpawns) {
      if (now - spawn.timestamp > this.config.taskSpawnWindow * 2) {
        expired.push(parentId);
      }
    }

    for (const parentId of expired) {
      this.pendingTaskSpawns.delete(parentId);
    }
  }

  /**
   * Check if a session exists
   * @private
   */
  async _checkSessionExists(sessionId) {
    try {
      const session = await this.cdpController.getSession(sessionId);
      return session !== null && session !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * Get the last message from a transcript
   * @private
   */
  _getLastMessage(transcript) {
    if (!transcript || !transcript.messages || transcript.messages.length === 0) {
      return null;
    }
    return transcript.messages[transcript.messages.length - 1];
  }

  /**
   * Extract the last assistant message from a transcript
   * @private
   */
  _extractLastAssistantMessage(transcript) {
    if (!transcript || !transcript.messages) {
      return null;
    }

    // Find last assistant message
    for (let i = transcript.messages.length - 1; i >= 0; i--) {
      const msg = transcript.messages[i];
      if (msg.role === 'assistant' && msg.content) {
        let content = msg.content;

        // Handle structured content
        if (typeof content !== 'string') {
          if (Array.isArray(content)) {
            content = content
              .map(part => {
                if (typeof part === 'string') return part;
                if (part.text) return part.text;
                if (part.type === 'text' && part.content) return part.content;
                return '';
              })
              .join('\n');
          } else if (content.text) {
            content = content.text;
          }
        }

        // Truncate if too long
        if (content.length > this.config.maxMessageLength) {
          content = content.substring(0, this.config.maxMessageLength) +
            '\n\n[... message truncated due to length ...]';
        }

        return content;
      }
    }

    return null;
  }

  /**
   * Format the result message for the parent session
   * @private
   */
  _formatResultMessage(message, relation) {
    let formatted = this.config.resultPrefix;

    // Add task info if available
    if (relation.taskToolId) {
      formatted += `*Task ID: ${relation.taskToolId}*\n\n`;
    }

    formatted += message;

    if (this.config.resultSuffix) {
      formatted += this.config.resultSuffix;
    }

    return formatted;
  }
}

// Export class and constants
module.exports = SubSessionManager;
module.exports.SUBSESSION_STATUS = SUBSESSION_STATUS;
module.exports.DEFAULT_CONFIG = DEFAULT_CONFIG;

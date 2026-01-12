/**
 * Command Injector - Service principal pour l'injection de commandes dans Claude Code
 * Coordonne la détection des processus et les stratégies d'injection
 */

const EventEmitter = require('events');
const ProcessDetector = require('./process-detector');
const InjectionStrategies = require('./injection-strategies');

class CommandInjector extends EventEmitter {
  constructor(options = {}) {
    super();
    this.detector = new ProcessDetector();
    this.strategies = new InjectionStrategies();

    // Configuration
    this.config = {
      preferredMethod: options.preferredMethod || 'auto',
      tmuxSession: options.tmuxSession || null,
      windowTitle: options.windowTitle || null,
      retryAttempts: options.retryAttempts || 2,
      retryDelay: options.retryDelay || 1000,
      ...options
    };

    // État
    this.commandQueue = new Map(); // sessionId -> command[]
    this.lastInjection = null;
    this.stats = {
      totalInjections: 0,
      successfulInjections: 0,
      failedInjections: 0,
      methodStats: {}
    };
  }

  /**
   * Injecte une commande/message dans Claude Code
   * @param {string} sessionId - ID de session (optionnel)
   * @param {string} command - Commande/message à injecter
   * @returns {Promise<{success, method, error}>}
   */
  async injectCommand(sessionId, command) {
    console.log(`[CommandInjector] Injection de commande: "${command.substring(0, 50)}..."`);

    const startTime = Date.now();
    let result;

    try {
      // Émettre l'événement de début
      this.emit('injection-started', { sessionId, command, timestamp: new Date().toISOString() });

      // Étape 1: Détecter le processus/session Claude
      const processInfo = await this.detector.findClaudeProcess(sessionId);

      if (!processInfo || !processInfo.method || processInfo.method === 'none') {
        console.warn('[CommandInjector] Aucune session Claude détectée, tentative avec méthode par défaut');
      }

      console.log(`[CommandInjector] Méthode détectée: ${processInfo?.method || 'none'}`);

      // Étape 2: Choisir et exécuter la stratégie d'injection
      const method = this.config.preferredMethod === 'auto'
        ? processInfo?.method || 'windows-sendkeys'
        : this.config.preferredMethod;

      result = await this.executeInjection(method, command, processInfo);

      // Étape 3: Retry si échec
      if (!result.success && this.config.retryAttempts > 0) {
        result = await this.retryInjection(command, processInfo, method);
      }

      // Mise à jour des stats
      this.updateStats(result.method, result.success);
      this.lastInjection = {
        sessionId,
        command,
        result,
        timestamp: new Date().toISOString(),
        duration: Date.now() - startTime
      };

      // Émettre l'événement de résultat
      this.emit(result.success ? 'injection-success' : 'injection-failed', {
        sessionId,
        command,
        result,
        duration: Date.now() - startTime
      });

      return result;

    } catch (error) {
      console.error('[CommandInjector] Erreur lors de l\'injection:', error.message);

      result = {
        success: false,
        method: 'unknown',
        error: error.message
      };

      this.updateStats('unknown', false);
      this.emit('injection-error', { sessionId, command, error: error.message });

      return result;
    }
  }

  /**
   * Exécute l'injection avec la méthode spécifiée
   */
  async executeInjection(method, command, processInfo) {
    console.log(`[CommandInjector] Exécution avec méthode: ${method}`);

    switch (method) {
      case 'tmux':
        const tmuxSession = this.config.tmuxSession ||
          processInfo?.terminal?.sessions?.[0]?.name ||
          'claude-code';
        return await this.strategies.injectViaTmux(tmuxSession, command);

      case 'wsl-tmux':
        const wslSession = this.config.tmuxSession ||
          processInfo?.terminal?.sessions?.[0]?.name ||
          'claude-code';
        return await this.strategies.injectViaWSLTmux(wslSession, command);

      case 'screen':
        const screenSession = this.config.screenSession ||
          processInfo?.terminal?.sessions?.[0]?.name;
        if (!screenSession) {
          return { success: false, method: 'screen', error: 'Aucune session screen trouvée' };
        }
        return await this.strategies.injectViaScreen(screenSession, command);

      case 'windows-sendkeys':
        const windowTitle = this.config.windowTitle || processInfo?.windowTitle;
        return await this.strategies.injectViaWindowsSendKeys(command, windowTitle);

      case 'electron-uiautomation':
        return await this.strategies.injectViaElectronUIAutomation(command, processInfo);

      case 'electron-clipboard':
        return await this.strategies.injectViaElectronClipboard(command, processInfo);

      case 'macos-applescript':
        const appName = this.config.terminalApp || 'Terminal';
        return await this.strategies.injectViaMacOSAppleScript(command, appName);

      case 'clipboard':
        return await this.strategies.injectViaClipboard(command);

      default:
        // Fallback automatique selon la plateforme
        return await this.autoFallback(command, processInfo);
    }
  }

  /**
   * Fallback automatique selon la plateforme
   * Priorité Windows: Claude Desktop (Electron) > Terminal SendKeys > Clipboard
   */
  async autoFallback(command, processInfo) {
    const platform = process.platform;

    console.log(`[CommandInjector] Auto-fallback pour plateforme: ${platform}`);

    if (platform === 'win32') {
      // Priorité 1: Claude Desktop App (Electron) via UI Automation
      console.log('[CommandInjector] Recherche de Claude Desktop App...');
      const claudeDesktop = await this.strategies.findClaudeDesktopWindow();

      if (claudeDesktop) {
        console.log(`[CommandInjector] Claude Desktop trouvee (PID: ${claudeDesktop.pid}), utilisation de electron-uiautomation`);
        let result = await this.strategies.injectViaElectronUIAutomation(command);

        if (result.success) {
          return result;
        }

        // Si UI Automation échoue, essayer clipboard pour Electron
        console.log('[CommandInjector] UI Automation echouee, tentative avec electron-clipboard');
        result = await this.strategies.injectViaElectronClipboard(command, claudeDesktop);

        if (result.success) {
          return result;
        }
      }

      // Priorité 2: Terminal via SendKeys
      console.log('[CommandInjector] Tentative avec SendKeys (terminal)');
      let result = await this.strategies.injectViaWindowsSendKeys(
        command,
        processInfo?.windowTitle
      );

      if (!result.success) {
        console.log('[CommandInjector] SendKeys échoué, tentative avec clipboard générique');
        result = await this.strategies.injectViaClipboard(command);
      }

      return result;

    } else if (platform === 'darwin') {
      // Sur macOS, essayer AppleScript puis clipboard
      let result = await this.strategies.injectViaMacOSAppleScript(command);

      if (!result.success) {
        console.log('[CommandInjector] AppleScript échoué, tentative avec clipboard');
        result = await this.strategies.injectViaClipboard(command);
      }

      return result;

    } else {
      // Sur Linux, essayer tmux, screen, puis clipboard
      if (processInfo?.terminal?.type === 'tmux') {
        const session = processInfo.terminal.sessions[0]?.name;
        if (session) {
          return await this.strategies.injectViaTmux(session, command);
        }
      }

      if (processInfo?.terminal?.type === 'screen') {
        const session = processInfo.terminal.sessions[0]?.name;
        if (session) {
          return await this.strategies.injectViaScreen(session, command);
        }
      }

      return await this.strategies.injectViaClipboard(command);
    }
  }

  /**
   * Retente l'injection avec d'autres méthodes
   * Ordre de priorité Windows: electron-uiautomation > electron-clipboard > windows-sendkeys > clipboard
   */
  async retryInjection(command, processInfo, failedMethod) {
    console.log(`[CommandInjector] Retry après échec de ${failedMethod}`);

    const platform = process.platform;
    const fallbackMethods = [];

    // Définir les méthodes de fallback selon la plateforme
    if (platform === 'win32') {
      // Sur Windows, prioriser les méthodes Electron si Claude Desktop est disponible
      fallbackMethods.push('electron-uiautomation', 'electron-clipboard', 'windows-sendkeys', 'clipboard');
    } else if (platform === 'darwin') {
      fallbackMethods.push('macos-applescript', 'tmux', 'clipboard');
    } else {
      fallbackMethods.push('tmux', 'screen', 'clipboard');
    }

    // Retirer la méthode qui a déjà échoué
    const methodsToTry = fallbackMethods.filter(m => m !== failedMethod);

    for (let attempt = 0; attempt < Math.min(this.config.retryAttempts, methodsToTry.length); attempt++) {
      const method = methodsToTry[attempt];
      console.log(`[CommandInjector] Retry ${attempt + 1}/${this.config.retryAttempts} avec ${method}`);

      await this.delay(this.config.retryDelay);

      const result = await this.executeInjection(method, command, processInfo);
      if (result.success) {
        return result;
      }
    }

    return {
      success: false,
      method: 'retry-exhausted',
      error: 'Toutes les méthodes d\'injection ont échoué'
    };
  }

  /**
   * Obtient le statut de disponibilité de l'injection
   */
  async getStatus(sessionId = null) {
    const processInfo = await this.detector.findClaudeProcess(sessionId);
    const systemInfo = this.detector.getSystemInfo();

    // Tester les méthodes disponibles
    const methodsStatus = {};
    for (const method of systemInfo.supportedMethods) {
      methodsStatus[method] = await this.strategies.testMethod(method);
    }

    return {
      available: processInfo?.method && processInfo.method !== 'none',
      detectedMethod: processInfo?.method || 'none',
      processInfo: processInfo,
      systemInfo: systemInfo,
      methodsStatus: methodsStatus,
      config: {
        preferredMethod: this.config.preferredMethod,
        tmuxSession: this.config.tmuxSession,
        windowTitle: this.config.windowTitle
      },
      stats: this.stats,
      lastInjection: this.lastInjection,
      recommendation: this.getRecommendation(processInfo, methodsStatus)
    };
  }

  /**
   * Génère une recommandation basée sur l'état actuel
   */
  getRecommendation(processInfo, methodsStatus) {
    const platform = process.platform;

    if (processInfo?.method === 'tmux') {
      return 'Injection disponible via tmux. Les commandes seront envoyées directement à la session.';
    }

    if (processInfo?.method === 'screen') {
      return 'Injection disponible via screen. Les commandes seront envoyées directement à la session.';
    }

    if (platform === 'win32') {
      // Vérifier si Claude Desktop est disponible
      if (methodsStatus?.['electron-uiautomation']?.claudeDesktopFound) {
        return 'Claude Desktop App détectée. Les messages seront envoyés directement dans l\'application via UI Automation.';
      }

      if (methodsStatus?.['electron-clipboard']?.claudeDesktopFound) {
        return 'Claude Desktop App détectée. Les messages seront envoyés via clipboard + focus automatique.';
      }

      if (processInfo?.windowTitle) {
        return `Injection disponible via Windows SendKeys vers "${processInfo.windowTitle}".`;
      }
      return 'Injection via Windows SendKeys. Assurez-vous que la fenêtre Claude est visible et active.';
    }

    if (platform === 'darwin') {
      return 'Injection via AppleScript. Terminal sera activé automatiquement.';
    }

    return 'Aucune méthode fiable détectée. L\'injection utilisera le presse-papiers (nécessite fenêtre active).';
  }

  /**
   * Configure les paramètres d'injection
   */
  configure(options) {
    Object.assign(this.config, options);
    console.log('[CommandInjector] Configuration mise à jour:', this.config);
    return this.config;
  }

  /**
   * Queue une commande pour exécution ultérieure
   */
  queueCommand(sessionId, command) {
    if (!this.commandQueue.has(sessionId)) {
      this.commandQueue.set(sessionId, []);
    }

    const queueItem = {
      id: this.generateId(),
      command,
      timestamp: new Date().toISOString(),
      status: 'pending'
    };

    this.commandQueue.get(sessionId).push(queueItem);

    this.emit('command-queued', { sessionId, item: queueItem });

    return queueItem;
  }

  /**
   * Exécute les commandes en attente pour une session
   */
  async processQueue(sessionId) {
    const queue = this.commandQueue.get(sessionId);
    if (!queue || queue.length === 0) {
      return { processed: 0, results: [] };
    }

    const results = [];
    const pendingCommands = queue.filter(item => item.status === 'pending');

    for (const item of pendingCommands) {
      item.status = 'processing';

      const result = await this.injectCommand(sessionId, item.command);

      item.status = result.success ? 'completed' : 'failed';
      item.result = result;
      item.processedAt = new Date().toISOString();

      results.push({
        id: item.id,
        command: item.command,
        result: result
      });

      // Délai entre les commandes
      await this.delay(500);
    }

    return {
      processed: results.length,
      results: results
    };
  }

  /**
   * Obtient les commandes en queue pour une session
   */
  getQueuedCommands(sessionId) {
    return this.commandQueue.get(sessionId) || [];
  }

  /**
   * Vide la queue d'une session
   */
  clearQueue(sessionId) {
    this.commandQueue.delete(sessionId);
    this.emit('queue-cleared', { sessionId });
  }

  /**
   * Met à jour les statistiques
   */
  updateStats(method, success) {
    this.stats.totalInjections++;

    if (success) {
      this.stats.successfulInjections++;
    } else {
      this.stats.failedInjections++;
    }

    if (!this.stats.methodStats[method]) {
      this.stats.methodStats[method] = { total: 0, success: 0, failed: 0 };
    }

    this.stats.methodStats[method].total++;
    if (success) {
      this.stats.methodStats[method].success++;
    } else {
      this.stats.methodStats[method].failed++;
    }
  }

  /**
   * Réinitialise les statistiques
   */
  resetStats() {
    this.stats = {
      totalInjections: 0,
      successfulInjections: 0,
      failedInjections: 0,
      methodStats: {}
    };
  }

  /**
   * Génère un ID unique
   */
  generateId() {
    return `inj_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Utilitaire de délai
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = CommandInjector;

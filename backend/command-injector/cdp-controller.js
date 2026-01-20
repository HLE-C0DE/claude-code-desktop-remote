/**
 * CDP Controller - Controls Claude Desktop via Chrome DevTools Protocol
 * Requires Claude Desktop to be running with --remote-debugging-port=9222
 *
 * OPTIMIZED: Uses persistent WebSocket connection instead of creating new ones
 */

const WebSocket = require('ws');
const http = require('http');

class CDPController {
    constructor(port = 9222) {
        this.port = port;
        this.wsConnection = null;
        this.messageId = 0;
        this.pendingRequests = new Map();
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 1000;
        this.lastTargetUrl = null;

        // Cache pour éviter les requêtes répétées
        this.cache = {
            sessions: null,
            sessionsTimestamp: 0,
            sessionsCacheDuration: 2000, // 2 secondes
        };
    }

    /**
     * Get available debug targets from Claude Desktop
     */
    async getDebugTargets() {
        return new Promise((resolve, reject) => {
            const req = http.get(`http://localhost:${this.port}/json`, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error('Failed to parse debug targets'));
                    }
                });
            });
            req.on('error', (e) => {
                reject(new Error(`Cannot connect to Claude Desktop debug port: ${e.message}`));
            });
            req.setTimeout(5000, () => {
                req.destroy();
                reject(new Error('Connection timeout - is Claude Desktop running in debug mode?'));
            });
        });
    }

    /**
     * Check if Claude Desktop is running in debug mode
     */
    async isDebugModeAvailable() {
        try {
            const targets = await this.getDebugTargets();
            return targets.some(t => t.url.includes('claude.ai'));
        } catch {
            return false;
        }
    }

    /**
     * Get the main Claude page target
     */
    async getMainPageTarget() {
        const targets = await this.getDebugTargets();
        const mainPage = targets.find(t => t.url.includes('claude.ai'));
        if (!mainPage) {
            throw new Error('Claude main page not found');
        }
        return mainPage;
    }

    /**
     * Ensure we have a persistent WebSocket connection
     */
    async ensureConnection() {
        // Si connexion active et ouverte, la réutiliser
        if (this.wsConnection && this.wsConnection.readyState === WebSocket.OPEN) {
            return this.wsConnection;
        }

        // Éviter les connexions multiples simultanées
        if (this.isConnecting) {
            // Attendre que la connexion en cours se termine
            return new Promise((resolve, reject) => {
                const checkInterval = setInterval(() => {
                    if (!this.isConnecting) {
                        clearInterval(checkInterval);
                        if (this.wsConnection && this.wsConnection.readyState === WebSocket.OPEN) {
                            resolve(this.wsConnection);
                        } else {
                            reject(new Error('Connection failed'));
                        }
                    }
                }, 100);

                // Timeout après 10 secondes
                setTimeout(() => {
                    clearInterval(checkInterval);
                    reject(new Error('Connection timeout'));
                }, 10000);
            });
        }

        this.isConnecting = true;

        try {
            const mainPage = await this.getMainPageTarget();
            this.lastTargetUrl = mainPage.webSocketDebuggerUrl;

            return new Promise((resolve, reject) => {
                const ws = new WebSocket(mainPage.webSocketDebuggerUrl);

                const timeout = setTimeout(() => {
                    this.isConnecting = false;
                    ws.close();
                    reject(new Error('WebSocket connection timeout'));
                }, 10000);

                ws.on('open', () => {
                    clearTimeout(timeout);
                    this.wsConnection = ws;
                    this.isConnecting = false;
                    this.reconnectAttempts = 0;
                    console.log('[CDP] Persistent WebSocket connection established');
                    resolve(ws);
                });

                ws.on('message', (data) => {
                    try {
                        const response = JSON.parse(data);
                        if (response.id && this.pendingRequests.has(response.id)) {
                            const { resolve, reject } = this.pendingRequests.get(response.id);
                            this.pendingRequests.delete(response.id);

                            if (response.error) {
                                reject(new Error(response.error.message));
                            } else if (response.result && response.result.exceptionDetails) {
                                reject(new Error(response.result.exceptionDetails.text || 'Execution error'));
                            } else {
                                resolve(response.result?.result?.value);
                            }
                        }
                    } catch (e) {
                        console.error('[CDP] Error parsing message:', e);
                    }
                });

                ws.on('close', () => {
                    console.log('[CDP] WebSocket connection closed');
                    this.wsConnection = null;
                    this.isConnecting = false;

                    // Rejeter toutes les requêtes en attente
                    for (const [id, { reject }] of this.pendingRequests) {
                        reject(new Error('Connection closed'));
                    }
                    this.pendingRequests.clear();
                });

                ws.on('error', (err) => {
                    clearTimeout(timeout);
                    console.error('[CDP] WebSocket error:', err.message);
                    this.isConnecting = false;
                    reject(err);
                });
            });
        } catch (err) {
            this.isConnecting = false;
            throw err;
        }
    }

    /**
     * Close the persistent connection
     */
    closeConnection() {
        if (this.wsConnection) {
            this.wsConnection.close();
            this.wsConnection = null;
        }
        this.pendingRequests.clear();
        this.cache.sessions = null;
    }

    /**
     * Execute JavaScript in Claude Desktop context using persistent connection
     */
    async executeJS(code, awaitPromise = true) {
        const ws = await this.ensureConnection();
        const id = ++this.messageId;

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error('Execution timeout'));
            }, 30000);

            this.pendingRequests.set(id, {
                resolve: (value) => {
                    clearTimeout(timeout);
                    resolve(value);
                },
                reject: (err) => {
                    clearTimeout(timeout);
                    reject(err);
                }
            });

            const message = {
                id,
                method: 'Runtime.evaluate',
                params: {
                    expression: code,
                    returnByValue: true,
                    awaitPromise
                }
            };

            try {
                ws.send(JSON.stringify(message));
            } catch (err) {
                this.pendingRequests.delete(id);
                clearTimeout(timeout);
                // Connexion perdue, réessayer
                this.wsConnection = null;
                reject(err);
            }
        });
    }

    /**
     * Get all sessions from Claude Desktop (with caching)
     * OPTIMIZED: Charge un compte de messages approximatif pour chaque session
     * @param {boolean} forceRefresh - Force refresh from CDP instead of using cache
     * @param {boolean} includeHidden - Include hidden orchestrator worker sessions (default: false)
     */
    async getAllSessions(forceRefresh = false, includeHidden = false) {
        // Vérifier le cache
        const now = Date.now();
        if (!forceRefresh &&
            this.cache.sessions &&
            (now - this.cache.sessionsTimestamp) < this.cache.sessionsCacheDuration) {
            let sessions = this.cache.sessions;
            // Filter hidden orchestrator workers unless explicitly included
            if (!includeHidden) {
                sessions = sessions.filter(s => !s.sessionId || !s.sessionId.includes('__orch_'));
            }
            return sessions;
        }

        const sessions = await this.executeJS(`
            (async () => {
                const sessions = await window['claude.web'].LocalSessions.getAll();
                // OPTIMISATION PERFORMANCE: Ne PAS charger les transcripts ici
                // Le transcript sera chargé uniquement quand la session est ouverte via getTranscript()
                // Cela réduit le temps de chargement initial de 10-30s à 1-2s
                const enrichedSessions = sessions.map(session => {
                    return {
                        ...session,
                        messageCount: 0, // Sera mis à jour lors du premier chargement de la session
                        pendingQuestions: [] // Idem
                    };
                });
                return enrichedSessions;
            })()
        `);

        // Mettre en cache (always cache the full list including hidden)
        this.cache.sessions = sessions;
        this.cache.sessionsTimestamp = now;

        // Filter hidden orchestrator workers unless explicitly included
        if (!includeHidden) {
            return sessions.filter(s => !s.sessionId || !s.sessionId.includes('__orch_'));
        }

        return sessions;
    }

    /**
     * Invalidate sessions cache
     */
    invalidateSessionsCache() {
        this.cache.sessions = null;
        this.cache.sessionsTimestamp = 0;
    }

    /**
     * Get current session ID
     */
    async getCurrentSessionId() {
        const url = await this.executeJS('window.location.href');
        const match = url.match(/local_[a-f0-9-]+/);
        return match ? match[0] : null;
    }

    /**
     * Validate and sanitize sessionId format
     * @private
     */
    validateSessionId(sessionId) {
        // Ensure sessionId has the correct format
        if (!sessionId.startsWith('local_')) {
            sessionId = 'local_' + sessionId;
        }

        // Validation: local_ followed by UUID or short hex (6+ chars)
        // Formats acceptés: local_c6db55 ou local_c6db556b-80f7-4cf9-a5e1-65ce516fd3d9
        if (!/^local_[a-f0-9]{6,}(-[a-f0-9]{4,})*$/.test(sessionId)) {
            throw new Error(`Invalid session ID format: ${sessionId}`);
        }

        return sessionId;
    }

    /**
     * Switch to a different session
     */
    async switchSession(sessionId) {
        sessionId = this.validateSessionId(sessionId);

        const url = `https://claude.ai/claude-code-desktop/${sessionId}`;
        await this.executeJS(`window.location.href = ${JSON.stringify(url)}`);

        // Invalider le cache car la session courante a changé
        this.invalidateSessionsCache();

        // Wait a bit for navigation
        await new Promise(resolve => setTimeout(resolve, 500));

        return { success: true, sessionId };
    }

    /**
     * Send a message to a specific session
     */
    async sendMessage(sessionId, message, attachments = []) {
        sessionId = this.validateSessionId(sessionId);

        // Use JSON.stringify for safe escaping (handles all special chars)
        await this.executeJS(`
            (async () => {
                await window['claude.web'].LocalSessions.sendMessage(
                    ${JSON.stringify(sessionId)},
                    ${JSON.stringify(message)},
                    ${JSON.stringify(attachments)}
                );
            })()
        `);

        // Invalider le cache après envoi de message
        this.invalidateSessionsCache();

        return { success: true, sessionId, message };
    }

    /**
     * Start a new session (requires message in options)
     */
    async startNewSession(cwd, options = {}) {
        const result = await this.executeJS(`
            (async () => {
                return await window['claude.web'].LocalSessions.start({
                    cwd: '${cwd.replace(/\\/g, '\\\\')}',
                    ...${JSON.stringify(options)}
                });
            })()
        `);

        // Invalider le cache
        this.invalidateSessionsCache();

        return result;
    }

    /**
     * Start a new session with an initial message
     * L'API LocalSessions.start() attend: { cwd: string, message: string, title?: string, ... }
     * Le title est passé directement si fourni dans les options
     * useWorktree: false pour travailler directement dans le dossier spécifié
     */
    async startNewSessionWithMessage(cwd, message, options = {}) {
        // Fusionner les options avec useWorktree: false par défaut
        const finalOptions = {
            useWorktree: false,
            ...options,
            cwd: cwd,
            message: message
        };

        console.log('[CDP] Création de session avec options:', JSON.stringify(finalOptions, null, 2));

        const result = await this.executeJS(`
            (async () => {
                return await window['claude.web'].LocalSessions.start(
                    ${JSON.stringify(finalOptions)}
                );
            })()
        `);

        console.log('[CDP] Session créée, résultat brut:', JSON.stringify(result, null, 2));

        // Invalider le cache
        this.invalidateSessionsCache();

        // Si un titre a été fourni, pas besoin d'attendre la génération
        if (options.title) {
            console.log('[CDP] Titre fourni par l\'utilisateur:', options.title);
        }

        // Récupérer la session mise à jour
        if (result && result.sessionId) {
            try {
                const updatedSession = await this.getSession(result.sessionId);
                console.log('[CDP] Session mise à jour:', JSON.stringify(updatedSession, null, 2));
                return updatedSession;
            } catch (err) {
                console.warn('[CDP] Impossible de récupérer la session mise à jour:', err.message);
                return result;
            }
        }

        return result;
    }

    /**
     * Get session details
     */
    async getSession(sessionId) {
        if (!sessionId.startsWith('local_')) {
            sessionId = 'local_' + sessionId;
        }

        return await this.executeJS(`
            (async () => {
                return await window['claude.web'].LocalSessions.getSession('${sessionId}');
            })()
        `);
    }

    /**
     * Get transcript (all messages) for a session
     */
    async getTranscript(sessionId) {
        if (!sessionId.startsWith('local_')) {
            sessionId = 'local_' + sessionId;
        }

        return await this.executeJS(`
            (async () => {
                return await window['claude.web'].LocalSessions.getTranscript('${sessionId}');
            })()
        `);
    }

    /**
     * Archive a session
     */
    async archiveSession(sessionId) {
        if (!sessionId.startsWith('local_')) {
            sessionId = 'local_' + sessionId;
        }

        await this.executeJS(`
            (async () => {
                await window['claude.web'].LocalSessions.archive('${sessionId}');
            })()
        `);

        // Invalider le cache
        this.invalidateSessionsCache();

        return { success: true, sessionId };
    }

    /**
     * Get all pending tool permissions across all sessions
     * Returns array of { sessionId, requestId, toolName, input, suggestions }
     * OPTIMIZED: Utilise le cache des sessions si disponible
     * IMPORTANT: Filtre les AskUserQuestion qui doivent être traitées comme questions
     */
    async getPendingPermissions() {
        // Utiliser getAllSessions qui gère le cache
        const sessions = await this.getAllSessions();
        const pendingPermissions = [];

        for (const session of sessions) {
            if (session.pendingToolPermissions && session.pendingToolPermissions.length > 0) {
                for (const perm of session.pendingToolPermissions) {
                    // FILTRE: Exclure AskUserQuestion des permissions
                    // AskUserQuestion doit être traitée via getPendingQuestions()
                    if (perm.toolName === 'AskUserQuestion') {
                        continue;
                    }

                    pendingPermissions.push({
                        sessionId: session.sessionId,
                        requestId: perm.requestId,
                        toolName: perm.toolName,
                        input: perm.input,
                        suggestions: perm.suggestions
                    });
                }
            }
        }

        return pendingPermissions;
    }

    /**
     * Get all pending questions (AskUserQuestion) across all sessions
     * Returns array of { sessionId, questionId, questions }
     * FALLBACK: Si pendingQuestions est vide, chercher dans pendingToolPermissions
     */
    async getPendingQuestions() {
        const sessions = await this.getAllSessions();
        const pendingQuestions = [];

        for (const session of sessions) {
            // Méthode 1: Chercher dans pendingQuestions (natif Claude Desktop)
            if (session.pendingQuestions && session.pendingQuestions.length > 0) {
                for (const q of session.pendingQuestions) {
                    pendingQuestions.push({
                        sessionId: session.sessionId,
                        questionId: q.questionId || q.id,
                        questions: q.questions || [],
                        metadata: q.metadata || {}
                    });
                }
            }

            // Méthode 2 (FALLBACK): Chercher AskUserQuestion dans pendingToolPermissions
            // Claude Desktop met parfois AskUserQuestion dans les permissions d'outils
            if (session.pendingToolPermissions && session.pendingToolPermissions.length > 0) {
                for (const perm of session.pendingToolPermissions) {
                    if (perm.toolName === 'AskUserQuestion' && perm.input) {
                        // Transformer la permission AskUserQuestion en vraie question
                        pendingQuestions.push({
                            sessionId: session.sessionId,
                            questionId: perm.requestId,
                            questions: perm.input.questions || [],
                            metadata: perm.input.metadata || {}
                        });
                    }
                }
            }
        }

        return pendingQuestions;
    }

    /**
     * Respond to a question (AskUserQuestion)
     * @param {string} questionId - The question ID
     * @param {object} answers - Object mapping question indices to selected answers
     *
     * FALLBACK: Si respondToQuestion échoue, essayer respondToPermission
     * car Claude Desktop peut traiter AskUserQuestion comme une permission
     */
    async respondToQuestion(questionId, answers) {
        console.log('[CDP] respondToQuestion appelé:', { questionId, answers });

        try {
            // Méthode 1: Utiliser l'API dédiée aux questions (si elle existe)
            console.log('[CDP] Tentative avec respondToQuestion...');
            const result = await this.executeJS(`
                (async () => {
                    await window['claude.web'].LocalSessions.respondToQuestion(
                        ${JSON.stringify(questionId)},
                        ${JSON.stringify(answers)}
                    );
                    return { success: true, method: 'respondToQuestion' };
                })()
            `);
            console.log('[CDP] respondToQuestion réussie:', result);

            // Invalider le cache après réponse
            this.invalidateSessionsCache();
            return { success: true, questionId, method: 'respondToQuestion' };

        } catch (error) {
            console.log('[CDP] respondToQuestion échouée:', error.message);
            console.log('[CDP] Tentative via respondToPermission...');

            try {
                // Méthode 2 (FALLBACK): Traiter comme une permission
                // Claude Desktop utilise parfois respondToPermission pour AskUserQuestion
                const result = await this.executeJS(`
                    (async () => {
                        await window['claude.web'].LocalSessions.respondToPermission(
                            ${JSON.stringify(questionId)},
                            'once',
                            ${JSON.stringify(answers)}
                        );
                        return { success: true, method: 'respondToPermission' };
                    })()
                `);
                console.log('[CDP] respondToPermission réussie:', result);

                // Invalider le cache après réponse
                this.invalidateSessionsCache();
                return { success: true, questionId, method: 'respondToPermission' };

            } catch (error2) {
                console.error('[CDP] Les deux méthodes ont échoué:', error2.message);
                throw new Error(`Impossible de répondre à la question: ${error.message} / ${error2.message}`);
            }
        }
    }

    /**
     * Respond to a tool permission request
     * @param {string} requestId - The permission request ID
     * @param {string} decision - 'once', 'always', or 'deny'
     * @param {object} updatedInput - Optional updated input for the tool
     */
    async respondToPermission(requestId, decision, updatedInput = null) {
        // Use JSON.stringify for safe escaping
        const inputJson = updatedInput !== null ? JSON.stringify(updatedInput) : 'undefined';

        await this.executeJS(`
            (async () => {
                await window['claude.web'].LocalSessions.respondToToolPermission(
                    ${JSON.stringify(requestId)},
                    ${JSON.stringify(decision)},
                    ${inputJson}
                );
            })()
        `);

        // Invalider le cache après réponse à une permission
        this.invalidateSessionsCache();

        return { success: true, requestId, decision };
    }
}

module.exports = CDPController;

// CLI usage
if (require.main === module) {
    const controller = new CDPController();
    const [,, command, ...args] = process.argv;

    const commands = {
        async status() {
            const available = await controller.isDebugModeAvailable();
            console.log('Debug mode available:', available);
            if (available) {
                const sessionId = await controller.getCurrentSessionId();
                console.log('Current session:', sessionId);
            }
        },
        async sessions() {
            const sessions = await controller.getAllSessions();
            console.log(JSON.stringify(sessions, null, 2));
        },
        async switch(sessionId) {
            const result = await controller.switchSession(sessionId);
            console.log('Switched to:', result.sessionId);
        },
        async send(sessionId, message) {
            const result = await controller.sendMessage(sessionId, message);
            console.log('Message sent to:', result.sessionId);
        },
        async current() {
            const sessionId = await controller.getCurrentSessionId();
            console.log('Current session:', sessionId);
        }
    };

    if (commands[command]) {
        commands[command](...args)
            .catch(err => {
                console.error('Error:', err.message);
                process.exit(1);
            })
            .finally(() => {
                controller.closeConnection();
            });
    } else {
        console.log('Usage: node cdp-controller.js <command> [args]');
        console.log('Commands: status, sessions, switch <sessionId>, send <sessionId> <message>, current');
    }
}

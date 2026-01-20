const express = require('express');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const WebSocket = require('ws');
const http = require('http');
const AnthropicUsageTracker = require('./anthropic-usage-tracker');
const PinManager = require('./pin-manager');
const CommandInjector = require('./command-injector');
const FavoritesManager = require('./favorites-manager');
const CDPConnectionMonitor = require('./cdp-connection-monitor');

// === CACHE BACKEND POUR SESSIONS ===
// Cache avec TTL pour réduire la charge CDP
const sessionCache = new Map();
const SESSION_CACHE_TTL_MS = 5000; // 5 secondes

function getCachedSession(sessionId) {
  const cached = sessionCache.get(sessionId);
  if (cached && (Date.now() - cached.timestamp) < SESSION_CACHE_TTL_MS) {
    return cached.data;
  }
  return null;
}

function setCachedSession(sessionId, data) {
  sessionCache.set(sessionId, {
    data,
    timestamp: Date.now()
  });
}

function invalidateSessionCache(sessionId) {
  if (sessionId) {
    sessionCache.delete(sessionId);
  } else {
    sessionCache.clear();
  }
}

// Nettoyage automatique du cache toutes les 30 secondes
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, cached] of sessionCache.entries()) {
    if ((now - cached.timestamp) > SESSION_CACHE_TTL_MS) {
      sessionCache.delete(sessionId);
    }
  }
}, 30000);

// === SYSTÈME DE LOGS SERVEUR ===
// Buffer circulaire pour stocker les derniers logs
const MAX_LOGS = 1000;
const serverLogs = [];

// SSE clients pour streaming logs en temps réel
const sseClients = new Set();

// Fonction pour ajouter un log au buffer
function addServerLog(level, ...args) {
  const timestamp = new Date().toISOString();
  const message = args.map(arg =>
    typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
  ).join(' ');

  const logEntry = {
    timestamp,
    level,
    message
  };

  serverLogs.push(logEntry);
  if (serverLogs.length > MAX_LOGS) {
    serverLogs.shift(); // Supprimer le plus ancien
  }

  // Toujours afficher dans la console originale (même si cachée par le .bat)
  const originalLog = originalConsole[level] || originalConsole.log;
  originalLog.apply(console, args);

  // STREAMING: Envoyer aux clients SSE connectés
  broadcastLogToSSE(logEntry);
}

function broadcastLogToSSE(logEntry) {
  const data = JSON.stringify(logEntry);
  sseClients.forEach(client => {
    try {
      client.write(`data: ${data}\n\n`);
    } catch (error) {
      // Client déconnecté, on le retire
      sseClients.delete(client);
    }
  });
}

// Sauvegarder les fonctions console originales
const originalConsole = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  info: console.info,
  debug: console.debug
};

// Intercepter tous les console.log/error/warn
console.log = (...args) => addServerLog('log', ...args);
console.error = (...args) => addServerLog('error', ...args);
console.warn = (...args) => addServerLog('warn', ...args);
console.info = (...args) => addServerLog('info', ...args);
console.debug = (...args) => addServerLog('debug', ...args);

console.log('[LOGS] Système de logs serveur initialisé');
// === FIN SYSTÈME DE LOGS ===

// Charger les variables d'environnement
dotenv.config();

// Parser les arguments de ligne de commande pour le PIN
// Format: node server.js --pin=1234
const args = process.argv.slice(2);
let cliPin = null;
for (const arg of args) {
  if (arg.startsWith('--pin=')) {
    cliPin = arg.split('=')[1];
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const CLAUDE_DIR = process.env.CLAUDE_DIR || path.join(require('os').homedir(), '.claude');

// Initialiser le tracker d'usage
const usageTracker = new AnthropicUsageTracker({
  apiKey: process.env.ANTHROPIC_API_KEY,
  dataDir: path.join(require('os').homedir(), '.claude-monitor')
});

// Initialiser le gestionnaire de PIN
// Priorite: argument CLI > variable d'environnement
const pinManager = new PinManager({
  pin: cliPin || process.env.CLAUDECODE_PIN,
  maxAttemptsPerIP: 3,
  globalAlertThreshold: 5
});

// Initialiser l'injecteur de commandes
const commandInjector = new CommandInjector({
  preferredMethod: process.env.INJECTION_METHOD || 'auto',
  tmuxSession: process.env.TMUX_SESSION_NAME || null,
  windowTitle: process.env.INJECTION_WINDOW_TITLE || null,
  retryAttempts: parseInt(process.env.INJECTION_RETRY_ATTEMPTS) || 2,
  retryDelay: parseInt(process.env.INJECTION_RETRY_DELAY) || 1000
});

// Initialiser le controleur CDP (Chrome DevTools Protocol) pour Claude Desktop
const CDPController = require('./command-injector/cdp-controller');
const cdpController = new CDPController(9222);

// Initialiser le gestionnaire de favoris
const favoritesManager = new FavoritesManager({
  dataDir: path.join(require('os').homedir(), '.claude-monitor')
});

// Initialiser le moniteur de connexions CDP
const cdpMonitor = new CDPConnectionMonitor({
  port: 9222,
  checkInterval: 5000 // Vérifier toutes les 5 secondes
});

// Initialiser le module d'orchestration
const OrchestratorModule = require('./orchestrator');
const orchestratorModule = new OrchestratorModule(cdpController, {
  templatesDir: path.join(__dirname, 'orchestrator/templates'),
  worker: {
    maxWorkers: 5,
    pollInterval: 2000,
    workerTimeout: 300000 // 5 minutes
  }
});

// Rate limiter specifique pour la creation d'orchestrateurs
const orchestratorCreateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10, // 10 creations max par minute
  message: { error: 'Trop de creations d\'orchestrateurs, ralentissez' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => pinManager.getClientIP(req)
});

// Créer le serveur HTTP
const server = http.createServer(app);

// Middleware - Security Headers
// Allow localhost and Cloudflare tunnel domains
const allowedOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    // Allow localhost
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    // Allow Cloudflare tunnel domains (*.trycloudflare.com)
    if (origin.endsWith('.trycloudflare.com') || origin.includes('.trycloudflare.com')) {
      return callback(null, true);
    }
    console.warn(`[Security] Blocked CORS request from origin: ${origin}`);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-session-token']
}));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: https:; " +
    "connect-src 'self' ws: wss:; " +
    "font-src 'self'; " +
    "object-src 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self'"
  );
  next();
});

app.use(express.json({ limit: '1mb' })); // Limit request body size
app.use(express.static(path.join(__dirname, '../public')));

// Rate limiting - Protection contre brute force et DoS
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 tentatives max
  message: { error: 'Trop de tentatives de connexion, réessayez dans 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
  // Use IP from pinManager for consistency
  keyGenerator: (req) => pinManager.getClientIP(req)
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 200, // 200 requêtes par minute (polling permissions + sessions + usage)
  message: { error: 'Trop de requêtes, ralentissez' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => pinManager.getClientIP(req)
});

const strictLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10, // 10 requêtes max pour opérations sensibles
  message: { error: 'Trop de requêtes pour cette opération sensible' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => pinManager.getClientIP(req)
});

// Apply general API rate limit to all /api routes
app.use('/api/', apiLimiter);

// Middleware d'authentification par PIN
const pinAuthMiddleware = (req, res, next) => {
  // Si pas de PIN configure, on autorise directement
  if (!pinManager.isPinEnabled()) {
    return next();
  }

  const ip = pinManager.getClientIP(req);

  // Verifier si l'IP est blacklistee
  if (pinManager.isIPBlocked(ip)) {
    return res.status(403).json({
      error: 'IP bloquee',
      message: 'Trop de tentatives echouees. Cette IP est bloquee pour cette session serveur.',
      blocked: true
    });
  }

  // Verifier le token de session dans le header ou le cookie
  const sessionToken = req.headers['x-session-token'] || req.cookies?.sessionToken;

  if (pinManager.isSessionValid(sessionToken, ip)) {
    return next();
  }

  // Pas de session valide, demander authentification
  return res.status(401).json({
    error: 'Authentification requise',
    pinRequired: true,
    message: 'Veuillez entrer le PIN pour acceder a cette ressource'
  });
};

// Ancien middleware d'authentification (pour compatibilite)
// SÉCURITÉ: Middleware d'authentification unifié
const authMiddleware = (req, res, next) => {
  const ip = pinManager.getClientIP(req);

  // Si PIN activé, TOUJOURS vérifier
  if (pinManager.isPinEnabled()) {
    // Vérifier si l'IP est bloquée
    if (pinManager.isIPBlocked(ip)) {
      return res.status(403).json({
        error: 'Accès bloqué',
        blocked: true
      });
    }

    // Vérifier le token de session PIN
    // Support query param pour EventSource (SSE) qui ne peut pas envoyer de headers
    const sessionToken = req.headers['x-session-token'] ||
                        req.cookies?.sessionToken ||
                        req.query?.token;

    console.log('[AUTH DEBUG]', {
      endpoint: req.path,
      hasHeader: !!req.headers['x-session-token'],
      hasCookie: !!req.cookies?.sessionToken,
      hasQuery: !!req.query?.token,
      sessionToken: sessionToken?.substring(0, 10) + '...',
      ip
    });

    if (pinManager.isSessionValid(sessionToken, ip)) {
      return next();
    }

    // Pas de session PIN valide
    return res.status(401).json({
      error: 'Authentification requise',
      pinRequired: true,
      message: 'Veuillez entrer le PIN pour accéder à cette ressource'
    });
  }

  // Si PIN désactivé, on autorise
  // SÉCURITÉ: Plus de fallback AUTH_TOKEN (porte dérobée supprimée)
  return next();
};

// Routes API
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'ClaudeCode_Remote API',
    timestamp: new Date().toISOString(),
    claudeDir: CLAUDE_DIR,
    pinEnabled: pinManager.isPinEnabled(),
    // Debug: voir si le PIN est bien reçu
    _debug: {
      cliArgs: process.argv.slice(2),
      cliPin: cliPin,
      envPin: process.env.CLAUDECODE_PIN ? '***' : null
    }
  });
});

// ============================================================================
// Routes API pour l'authentification PIN
// ============================================================================

// Verifier si le PIN est requis
app.get('/api/auth/status', (req, res) => {
  const ip = pinManager.getClientIP(req);
  const sessionToken = req.headers['x-session-token'];

  res.json({
    pinEnabled: pinManager.isPinEnabled(),
    authenticated: pinManager.isSessionValid(sessionToken, ip),
    blocked: pinManager.isIPBlocked(ip)
  });
});

// Tentative de connexion avec PIN (with strict rate limiting)
app.post('/api/auth/login', authLimiter, (req, res) => {
  const { pin } = req.body;
  const ip = pinManager.getClientIP(req);

  if (!pin) {
    return res.status(400).json({
      error: 'Le champ "pin" est requis'
    });
  }

  const result = pinManager.attemptLogin(ip, pin);

  if (result.success) {
    res.json({
      success: true,
      token: result.token,
      message: 'Authentification reussie'
    });
  } else {
    const status = result.blocked ? 403 : 401;
    res.status(status).json({
      success: false,
      error: result.error,
      blocked: result.blocked || false,
      attemptsRemaining: result.attemptsRemaining
    });
  }
});

// Deconnexion
app.post('/api/auth/logout', (req, res) => {
  const sessionToken = req.headers['x-session-token'];

  if (sessionToken) {
    pinManager.logout(sessionToken);
  }

  res.json({ success: true, message: 'Deconnexion reussie' });
});

// Informations sur la session (temps restant avant expiration)
app.get('/api/auth/session-info', (req, res) => {
  const sessionToken = req.headers['x-session-token'];
  const ip = pinManager.getClientIP(req);

  if (!pinManager.isPinEnabled()) {
    // PIN non active, pas de timeout
    return res.json({
      pinEnabled: false,
      sessionValid: true,
      noExpiration: true
    });
  }

  const sessionInfo = pinManager.getSessionInfo(sessionToken, ip);

  if (!sessionInfo) {
    return res.status(401).json({
      sessionValid: false,
      error: 'Session invalide ou expiree'
    });
  }

  res.json({
    pinEnabled: true,
    sessionValid: true,
    authenticatedAt: sessionInfo.authenticatedAt,
    expiresAt: sessionInfo.expiresAt,
    remainingMs: sessionInfo.remainingMs,
    sessionTimeout: sessionInfo.sessionTimeout
  });
});

// Rafraichir la session (prolonger sans re-authentification)
app.post('/api/auth/refresh', (req, res) => {
  const sessionToken = req.headers['x-session-token'];
  const ip = pinManager.getClientIP(req);

  if (!pinManager.isPinEnabled()) {
    return res.json({
      success: true,
      noExpiration: true,
      message: 'PIN non active, pas de timeout'
    });
  }

  const result = pinManager.refreshSession(sessionToken, ip);

  if (result.success) {
    res.json({
      success: true,
      expiresAt: result.expiresAt,
      remainingMs: result.remainingMs,
      message: result.message
    });
  } else {
    res.status(401).json({
      success: false,
      error: result.error
    });
  }
});

// Statistiques de securite (pour l'admin/debug)
app.get('/api/auth/stats', pinAuthMiddleware, (req, res) => {
  res.json(pinManager.getStats());
});

app.get('/api/sessions', authMiddleware, async (req, res) => {
  try {
    const cdpAvailable = await cdpController.isDebugModeAvailable();

    if (!cdpAvailable) {
      return res.status(503).json({
        error: 'CDP not available. Start Claude Desktop with --remote-debugging-port=9222'
      });
    }

    const cdpSessions = await cdpController.getAllSessions();
    const currentSessionId = await cdpController.getCurrentSessionId();

    // Helper pour extraire le nom du dossier depuis le chemin
    const extractFolderName = (cwd) => {
      if (!cwd) return null;
      const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : null;
    };

    // Helper pour obtenir un nom de session fiable
    // Logique: titre CDP (si valide) > nom du dossier > "Nouvelle session..."
    const getSessionName = (session) => {
      // Vérifier si le titre existe ET n'est pas vide
      const title = session.title?.trim();
      // Exclure les titres génériques de Claude Desktop (bugs de génération de titre)
      const invalidTitles = ['Local Session', 'Nouvelle session...', ''];
      if (title && title.length > 0 && !invalidTitles.includes(title)) {
        return title;
      }
      // Fallback sur le nom du dossier
      const folderName = extractFolderName(session.cwd);
      if (folderName && folderName.length > 0) {
        return folderName;
      }
      // Dernier fallback
      return 'Nouvelle session...';
    };

    // Transformer les sessions CDP au format attendu par le frontend
    // isRunning = session ouverte/active (PAS "Claude travaille")
    // On cherche isGenerating/isStreaming/isBusy pour "thinking"
    const sessions = cdpSessions.map(s => {
      const isActuallyWorking = s.isGenerating || s.isStreaming || s.isBusy || false;
      let status = 'idle';
      if (isActuallyWorking) {
        status = 'thinking';
      } else if (s.sessionId === currentSessionId || s.isRunning) {
        status = 'waiting';
      }

      const sessionName = getSessionName(s);
      return {
        id: s.sessionId,
        projectName: sessionName,
        sessionSummary: s.title?.trim() || null, // Garder le titre CDP original s'il existe
        cwd: s.cwd,
        lastActivity: new Date(s.lastActivityAt).toISOString(),
        status: status,
        messageCount: s.messageCount || 0,
        isCurrent: s.sessionId === currentSessionId,
        model: s.model,
        planMode: false // Removed permissionManager dependency
      };
    });

    // Trier par date d'activité décroissante
    sessions.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));

    res.json({
      sessions: sessions,
      count: sessions.length,
      source: 'cdp'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Error fetching sessions',
      message: error.message
    });
  }
});

/**
 * Formate l'input d'un outil pour affichage lisible
 */
function formatToolInput(toolName, input) {
  if (!input) return 'Paramètres inconnus';

  switch (toolName) {
    case 'Bash':
      return `Commande: ${input.command || 'inconnue'}`;
    case 'Edit':
      return `Fichier: ${input.file_path || 'inconnu'}`;
    case 'Write':
      return `Fichier: ${input.file_path || 'inconnu'}`;
    case 'Read':
      return `Fichier: ${input.file_path || 'inconnu'}`;
    case 'Glob':
      return `Pattern: ${input.pattern || 'inconnu'}${input.path ? ` dans ${input.path}` : ''}`;
    case 'Grep':
      return `Recherche: ${input.pattern || 'inconnu'}${input.path ? ` dans ${input.path}` : ''}`;
    case 'WebFetch':
      const url = input.url || 'URL inconnue';
      return `URL: ${url.length > 60 ? url.substring(0, 60) + '...' : url}`;
    case 'WebSearch':
      return `Recherche: "${input.query || 'inconnue'}"`;
    case 'Task':
      return `Agent: ${input.description || input.subagent_type || 'inconnu'}`;
    case 'ExitPlanMode':
      // Afficher le plan de manière lisible
      if (input.plan) {
        const planPreview = input.plan.substring(0, 200) + (input.plan.length > 200 ? '...' : '');
        return `Plan: ${planPreview}`;
      }
      return 'Sortie du mode plan';
    case 'EnterPlanMode':
      return 'Passage en mode plan';
    default:
      const inputStr = JSON.stringify(input);
      return inputStr.length > 100 ? inputStr.substring(0, 100) + '...' : inputStr;
  }
}

/**
 * Extrait le contenu textuel d'un message CDP
 * Les messages assistant ont content sous forme de tableau: [{type:"text", text:"..."}, {type:"tool_use", ...}]
 * Les messages user ont content sous forme de string ou tableau avec tool_result
 */
function extractMessageContent(entry) {
  const rawContent = entry.message?.content || entry.content;

  if (!rawContent) return { text: '', toolUses: [], isToolResult: false };

  // Si c'est déjà une string (cas des messages user simples)
  if (typeof rawContent === 'string') {
    return { text: rawContent, toolUses: [], isToolResult: false };
  }

  // Si c'est un tableau (cas des messages assistant ou user avec tool_result)
  if (Array.isArray(rawContent)) {
    const textParts = [];
    const toolUses = [];
    let isToolResult = false;

    for (const block of rawContent) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolUses.push({
          id: block.id,
          name: block.name,
          input: block.input
        });
      } else if (block.type === 'tool_result') {
        // C'est un résultat d'outil, pas un vrai message utilisateur
        isToolResult = true;
      }
    }

    return {
      text: textParts.join('\n'),
      toolUses,
      isToolResult
    };
  }

  // Fallback - essayer de convertir en string
  return { text: String(rawContent), toolUses: [], isToolResult: false };
}

/**
 * Convertit les toolUses en format tool_action pour l'affichage agrégé
 */
function convertToolUsesToActions(toolUses) {
  if (!toolUses || toolUses.length === 0) return [];

  const toolMap = new Map();

  for (const tool of toolUses) {
    const toolName = tool.name;
    if (!toolMap.has(toolName)) {
      toolMap.set(toolName, { tool: toolName, count: 0, files: [] });
    }

    const entry = toolMap.get(toolName);
    entry.count++;

    // Extraire le nom du fichier si disponible
    const input = tool.input || {};
    if (input.file_path) {
      const fileName = require('path').basename(input.file_path);
      if (!entry.files.includes(fileName)) {
        entry.files.push(fileName);
      }
    } else if (input.path) {
      const fileName = require('path').basename(input.path);
      if (!entry.files.includes(fileName)) {
        entry.files.push(fileName);
      }
    } else if (input.command) {
      const cmd = input.command.substring(0, 30) + (input.command.length > 30 ? '...' : '');
      if (!entry.files.includes(cmd)) {
        entry.files.push(cmd);
      }
    } else if (input.pattern) {
      if (!entry.files.includes(input.pattern)) {
        entry.files.push(input.pattern);
      }
    }
  }

  return Array.from(toolMap.values());
}

/**
 * Détecte l'activité de Claude dans le transcript
 * Retourne:
 * - lastToolUse: { name, timestamp } du dernier outil utilisé
 * - lastAssistantText: timestamp du dernier message texte de Claude
 * - lastUserMessage: timestamp du dernier message utilisateur
 * - isToolRunning: true si un tool_use n'a pas encore de tool_result
 * - isWaitingForResponse: true si dernier message est user sans réponse assistant après
 */
/**
 * Détecte si Claude est en train de travailler (utilise des outils)
 * Nouvelle logique simplifiée :
 * - L'indicateur apparaît dès qu'un tool_use est détecté
 * - L'indicateur disparaît quand Claude envoie un message texte OU quand l'utilisateur interrompt
 */
function detectClaudeActivity(transcript) {
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return {
      isToolActive: false,
      lastMessageType: null
    };
  }

  let hasActiveToolUse = false;
  let lastMessageType = null;

  // Parcourir le transcript dans l'ordre chronologique
  for (const entry of transcript) {
    const rawContent = entry.message?.content || entry.content;

    if (!rawContent) continue;

    // Message avec contenu tableau (peut contenir tool_use, text, etc.)
    if (Array.isArray(rawContent)) {
      for (const block of rawContent) {
        // Détecter tool_use = Claude travaille
        if (block.type === 'tool_use') {
          hasActiveToolUse = true;
          lastMessageType = 'tool_use';
        }
        // Détecter message texte de Claude = arrêt
        else if (block.type === 'text' && block.text && block.text.trim()) {
          if (entry.type === 'assistant') {
            hasActiveToolUse = false;
            lastMessageType = 'assistant_text';
          }
        }
      }
    }

    // Détecter interruption utilisateur
    if (entry.type === 'user' && typeof rawContent === 'string') {
      if (rawContent.trim() === '[Request interrupted by user]') {
        hasActiveToolUse = false;
        lastMessageType = 'user_interrupt';
      }
    }
  }

  return {
    isToolActive: hasActiveToolUse,
    lastMessageType: lastMessageType
  };
}

/**
 * Extrait les données TodoWrite du contenu d'un message
 * Retourne les todos (même si toutes complétées) pour pouvoir comparer avec les précédentes
 */
function extractTodoData(toolUses) {
  if (!toolUses || toolUses.length === 0) return null;

  const todoUse = toolUses.find(t => t.name === 'TodoWrite');
  if (!todoUse || !todoUse.input?.todos) return null;

  return todoUse.input.todos;
}

/**
 * Vérifie si une liste de todos a des tâches actives (non complétées)
 */
function hasActiveTodos(todos) {
  if (!todos || todos.length === 0) return false;
  return todos.some(t => t.status !== 'completed');
}

/**
 * Estime l'utilisation du contexte basée sur le transcript de la session
 * Retourne une estimation des tokens utilisés et du pourcentage de contexte
 *
 * Limites de contexte par modèle (approximatif):
 * - Claude Sonnet 4.5: 200K tokens standard, 500K Enterprise
 * - Claude Opus 4.5: 200K tokens
 * - Claude Haiku 3.5: 200K tokens
 *
 * Note: Cette estimation est approximative car:
 * - Les tokens réels dépendent de la tokenization BPE
 * - Le system prompt et les tools prennent une partie du contexte
 * - Les images/fichiers ont leurs propres ratios de tokens
 */
function estimateContextUsage(transcript, model = 'claude-sonnet-4-5') {
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return {
      estimatedTokens: 0,
      maxTokens: 200000,
      percentage: 0,
      breakdown: {
        userMessages: 0,
        assistantMessages: 0,
        toolResults: 0,
        systemOverhead: 0
      },
      isEstimate: true,
      warningLevel: 'low' // low, medium, high, critical
    };
  }

  // Constantes d'estimation
  const CHARS_PER_TOKEN = 4; // Approximation moyenne pour anglais/français
  const SYSTEM_OVERHEAD_TOKENS = 15000; // System prompt + tools (estimation)
  const MAX_CONTEXT_TOKENS = 200000; // Limite standard

  let userTokens = 0;
  let assistantTokens = 0;
  let toolResultTokens = 0;

  for (const entry of transcript) {
    const rawContent = entry.message?.content || entry.content;
    if (!rawContent) continue;

    let contentLength = 0;

    if (typeof rawContent === 'string') {
      contentLength = rawContent.length;
    } else if (Array.isArray(rawContent)) {
      for (const block of rawContent) {
        if (block.type === 'text' && block.text) {
          contentLength += block.text.length;
        } else if (block.type === 'tool_use') {
          // Les tool_use comptent aussi (nom + input JSON)
          contentLength += (block.name?.length || 0) + JSON.stringify(block.input || {}).length;
        } else if (block.type === 'tool_result') {
          // Les tool_result peuvent être volumineux
          if (typeof block.content === 'string') {
            contentLength += block.content.length;
          } else if (Array.isArray(block.content)) {
            for (const c of block.content) {
              if (c.type === 'text' && c.text) {
                contentLength += c.text.length;
              }
            }
          }
        }
      }
    }

    const estimatedTokens = Math.ceil(contentLength / CHARS_PER_TOKEN);

    if (entry.type === 'user') {
      // Vérifier si c'est un tool_result (message user contenant tool_result)
      const hasToolResult = Array.isArray(rawContent) &&
        rawContent.some(b => b.type === 'tool_result');
      if (hasToolResult) {
        toolResultTokens += estimatedTokens;
      } else {
        userTokens += estimatedTokens;
      }
    } else if (entry.type === 'assistant') {
      assistantTokens += estimatedTokens;
    }
  }

  const totalTokens = userTokens + assistantTokens + toolResultTokens + SYSTEM_OVERHEAD_TOKENS;
  // Ne pas plafonner à 100% - permettre d'afficher les dépassements
  const percentage = (totalTokens / MAX_CONTEXT_TOKENS) * 100;

  // Déterminer le niveau d'alerte
  // critical = dépassement (>100%) ou proche (>=90%)
  let warningLevel = 'low';
  if (percentage >= 100) {
    warningLevel = 'critical'; // Dépassement !
  } else if (percentage >= 90) {
    warningLevel = 'high'; // Proche de la limite
  } else if (percentage >= 75) {
    warningLevel = 'medium';
  } else if (percentage >= 50) {
    warningLevel = 'medium';
  }

  return {
    estimatedTokens: totalTokens,
    maxTokens: MAX_CONTEXT_TOKENS,
    percentage: Math.round(percentage * 10) / 10, // 1 décimale
    breakdown: {
      userMessages: userTokens,
      assistantMessages: assistantTokens,
      toolResults: toolResultTokens,
      systemOverhead: SYSTEM_OVERHEAD_TOKENS
    },
    isEstimate: true,
    warningLevel,
    messageCount: transcript.length
  };
}

/**
 * Agréger les messages CDP: fusionner les tool_actions consécutives
 * et garder un seul message 'task' (le plus récent) à sa position chronologique
 *
 * Ordre chronologique préservé: tool_action -> message -> tool_action -> message
 * Le bloc tâches reste à la position du dernier TodoWrite, pas après le dernier assistant
 */
/**
 * Fusionne des toolActions en agrégeant celles du même type
 * Ex: [{tool:'Grep',count:1}, {tool:'Grep',count:1}] => [{tool:'Grep',count:2}]
 */
function mergeToolActions(existing, newActions) {
  const toolMap = new Map();

  // Ajouter les actions existantes
  for (const action of existing) {
    if (toolMap.has(action.tool)) {
      const entry = toolMap.get(action.tool);
      entry.count += action.count;
      // Fusionner les fichiers sans doublons
      for (const file of action.files || []) {
        if (!entry.files.includes(file)) {
          entry.files.push(file);
        }
      }
    } else {
      toolMap.set(action.tool, {
        tool: action.tool,
        count: action.count,
        files: [...(action.files || [])]
      });
    }
  }

  // Ajouter les nouvelles actions
  for (const action of newActions) {
    if (toolMap.has(action.tool)) {
      const entry = toolMap.get(action.tool);
      entry.count += action.count;
      // Fusionner les fichiers sans doublons
      for (const file of action.files || []) {
        if (!entry.files.includes(file)) {
          entry.files.push(file);
        }
      }
    } else {
      toolMap.set(action.tool, {
        tool: action.tool,
        count: action.count,
        files: [...(action.files || [])]
      });
    }
  }

  return Array.from(toolMap.values());
}

function aggregateCDPMessages(messages) {
  const result = [];
  let lastTaskMessage = null;
  let lastTaskInsertIndex = -1;
  let currentToolActionBlock = null; // Accumuler les tool_actions consécutifs

  for (const msg of messages) {
    if (msg.role === 'tool_action') {
      // Fusionner avec le bloc de tool_actions en cours
      if (currentToolActionBlock) {
        // Fusionner les toolActions en agrégeant par type (Read ×2, Grep ×3, etc.)
        currentToolActionBlock.toolActions = mergeToolActions(
          currentToolActionBlock.toolActions,
          msg.toolActions
        );
        // Mettre à jour le timestamp au plus récent
        currentToolActionBlock.timestamp = msg.timestamp;
      } else {
        // Créer un nouveau bloc de tool_actions
        currentToolActionBlock = {
          uuid: msg.uuid,
          role: 'tool_action',
          toolActions: [...msg.toolActions],
          timestamp: msg.timestamp
        };
      }
    } else {
      // Si on rencontre un message non-tool_action, flusher le bloc de tools en cours
      if (currentToolActionBlock) {
        result.push(currentToolActionBlock);
        currentToolActionBlock = null;
      }

      if (msg.role === 'task') {
        // Garder le plus récent ET fixer sa position chronologique maintenant
        lastTaskMessage = msg;
        lastTaskInsertIndex = result.length;
      } else {
        // Message réel (user ou assistant)
        result.push(msg);
      }
    }
  }

  // Flusher le dernier bloc de tool_actions s'il existe
  if (currentToolActionBlock) {
    result.push(currentToolActionBlock);
  }

  // Insérer le task à sa position chronologique (là où le dernier TodoWrite a été appelé)
  if (lastTaskMessage && lastTaskMessage.todos && lastTaskMessage.todos.length > 0) {
    if (lastTaskInsertIndex === -1 || lastTaskInsertIndex > result.length) {
      result.push(lastTaskMessage);
    } else {
      result.splice(lastTaskInsertIndex, 0, lastTaskMessage);
    }
  }

  return result;
}

app.get('/api/session/:id', authMiddleware, async (req, res) => {
  try {
    let sessionId = req.params.id;

    // Ensure sessionId has local_ prefix
    if (!sessionId.startsWith('local_')) {
      sessionId = 'local_' + sessionId;
    }

    // OPTIMISATION: Vérifier le cache avant de charger depuis CDP
    const cached = getCachedSession(sessionId);
    if (cached) {
      res.setHeader('X-Cache-Hit', 'true');
      return res.json(cached);
    }

    const cdpAvailable = await cdpController.isDebugModeAvailable();

    if (!cdpAvailable) {
      return res.status(503).json({
        error: 'CDP not available. Start Claude Desktop with --remote-debugging-port=9222'
      });
    }

    // Include hidden sessions (like orchestrator workers) when looking up by ID
    // since the user explicitly requested this specific session
    const cdpSessions = await cdpController.getAllSessions(false, true);
    const currentSessionId = await cdpController.getCurrentSessionId();
    const cdpSession = cdpSessions.find(s => s.sessionId === sessionId);

    if (!cdpSession) {
      return res.status(404).json({
        error: 'Session not found',
        sessionId: sessionId
      });
    }

    // Récupérer le transcript (messages) de la session
    let messages = [];
    let rawTranscript = []; // Garder le transcript brut pour la détection d'outils
    try {
      const transcript = await cdpController.getTranscript(sessionId);
      rawTranscript = transcript; // Sauvegarder pour detectRunningTool
      if (Array.isArray(transcript)) {
        const rawMessages = [];
        let pendingAgentPrompts = 0; // Compteur de prompts d'agents à cacher
        let lastAssistantHadTaskTool = false; // Le dernier assistant a-t-il utilisé Task?

        for (const entry of transcript) {
          if (entry.type !== 'user' && entry.type !== 'assistant') continue;

          const { text, toolUses, isToolResult } = extractMessageContent(entry);
          const timestamp = entry.timestamp || entry.message?.timestamp || entry.createdAt || new Date().toISOString();

          if (entry.type === 'user') {
            if (isToolResult) continue;

            // Ignorer les messages automatiques
            if (text && (
              text.includes('<observed_from_primary_session>') ||
              text.includes('You are a Claude-Mem') ||
              text.includes('<local-command-') ||
              text.includes('<command-name>')
            )) continue;

            if (text) {
              // Marquer comme prompt d'agent si:
              // 1. On a des prompts d'agents en attente
              // 2. ET le dernier message assistant a utilisé le tool Task
              const isAgentPrompt = pendingAgentPrompts > 0 && lastAssistantHadTaskTool;
              if (isAgentPrompt) {
                pendingAgentPrompts--;
              }

              rawMessages.push({
                uuid: entry.uuid || `user-${rawMessages.length}`,
                role: 'user',
                content: text,
                timestamp: timestamp,
                isAgentPrompt: isAgentPrompt // Marquer si c'est un prompt d'agent
              });
            }

            // Reset après un message user
            lastAssistantHadTaskTool = false;
          } else if (entry.type === 'assistant') {
            // Compter le nombre d'agents spawnés (tool Task)
            const taskToolCount = toolUses.filter(t => t.name === 'Task').length;
            lastAssistantHadTaskTool = taskToolCount > 0;

            if (taskToolCount > 0) {
              pendingAgentPrompts += taskToolCount;
              console.log(`[Agent Spawn] Détecté ${taskToolCount} spawn(s) d'agent(s), ${pendingAgentPrompts} prompts à cacher`);
            }

            const todoData = extractTodoData(toolUses);

            // Créer message task séparé pour les todos
            if (todoData) {
              rawMessages.push({
                uuid: (entry.uuid || `assistant-${rawMessages.length}`) + '-todo',
                role: 'task',
                todos: todoData,
                timestamp: timestamp
              });
            }

            // Préparer les tool actions (si présentes)
            const otherToolUses = toolUses.filter(t => t.name !== 'TodoWrite');
            const toolActions = otherToolUses.length > 0 ? convertToolUsesToActions(otherToolUses) : null;

            // Filtrer les messages d'observation
            const isObservation = text && (
              text.includes('<observation>') ||
              text.includes("I'm ready to observe") ||
              text.includes('Waiting for tool execution')
            );

            // Créer le message assistant (si texte présent et non observation)
            if (text && text.trim() && !isObservation) {
              rawMessages.push({
                uuid: entry.uuid || `assistant-${rawMessages.length}`,
                role: 'assistant',
                content: text,
                timestamp: timestamp
              });
            }

            // Créer un message tool_action SÉPARÉ (si tools présents)
            if (toolActions) {
              rawMessages.push({
                uuid: (entry.uuid || `assistant-${rawMessages.length}`) + '-tools',
                role: 'tool_action',
                toolActions: toolActions,
                timestamp: timestamp
              });
            }
          }
        }

        messages = aggregateCDPMessages(rawMessages);
      }
    } catch (transcriptError) {
      console.error('Error fetching transcript:', transcriptError.message);
    }

    // Détecter l'activité de Claude dans le transcript
    const activity = detectClaudeActivity(rawTranscript);

    // Estimer l'utilisation du contexte
    const contextUsage = estimateContextUsage(rawTranscript, cdpSession.model);

    // Debug log pour le timer thinking
    if (activity.lastToolUse || activity.lastAssistantText || activity.lastUserMessage) {
      console.log('[Thinking Debug]', {
        lastToolUse: activity.lastToolUse ? { name: activity.lastToolUse.name, timestamp: activity.lastToolUse.timestamp } : null,
        lastAssistantText: activity.lastAssistantText,
        lastUserMessage: activity.lastUserMessage,
        isToolRunning: activity.isToolRunning,
        isWaitingForResponse: activity.isWaitingForResponse
      });
    }

    // Helper pour extraire le nom du dossier
    const extractFolderName = (cwd) => {
      if (!cwd) return null;
      const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : null;
    };

    // Helper pour obtenir un nom de session fiable
    const getSessionName = (session) => {
      const title = session.title?.trim();
      // Exclure les titres génériques de Claude Desktop
      const invalidTitles = ['Local Session', 'Nouvelle session...', ''];
      if (title && title.length > 0 && !invalidTitles.includes(title)) {
        return title;
      }
      const folderName = extractFolderName(session.cwd);
      if (folderName && folderName.length > 0) {
        return folderName;
      }
      return 'Nouvelle session...';
    };

    // Déterminer le statut - nouvelle logique simplifiée
    // Claude travaille uniquement si un outil est actif (tool_use détecté)
    const status = activity.isToolActive ? 'thinking' : 'idle';

    const sessionName = getSessionName(cdpSession);
    const responseData = {
      session: {
        id: cdpSession.sessionId,
        projectName: sessionName,
        sessionSummary: cdpSession.title?.trim() || null,
        cwd: cdpSession.cwd,
        lastActivity: new Date(cdpSession.lastActivityAt).toISOString(),
        status: status,
        isThinking: activity.isToolActive,
        messageCount: messages.length,
        isCurrent: cdpSession.sessionId === currentSessionId,
        model: cdpSession.model,
        planMode: false,
        messages: messages, // Remis temporairement pour debug
        // Estimation de l'utilisation du contexte
        contextUsage: contextUsage
      }
    };

    // OPTIMISATION: Mettre en cache la réponse pour 5 secondes
    setCachedSession(sessionId, responseData);
    res.setHeader('X-Cache-Hit', 'false');

    res.json(responseData);

    // Debug info uniquement si query param debug=true (optimisation performance)
    // Utilisation: /api/session/:id?debug=true
    // Désactivé par défaut pour réduire la taille du payload de ~10%
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors de la récupération de la session',
      message: error.message
    });
  }
});

// Route obsolète supprimée - utiliser /api/send à la place (CDP uniquement)

// OPTIMISATION: Endpoint paginé pour les messages
// Permet de charger les messages par batch (50-100 à la fois)
// Réduit payload de 1-2 MB à 50-100 KB
app.get('/api/session/:id/messages', authMiddleware, async (req, res) => {
  try {
    let sessionId = req.params.id;

    // Ensure sessionId has local_ prefix
    if (!sessionId.startsWith('local_')) {
      sessionId = 'local_' + sessionId;
    }

    const offset = parseInt(req.query.offset) || 0;
    const limit = parseInt(req.query.limit) || 50;

    const cdpAvailable = await cdpController.isDebugModeAvailable();
    if (!cdpAvailable) {
      return res.status(503).json({
        error: 'CDP not available'
      });
    }

    // Récupérer le transcript complet
    const transcript = await cdpController.getTranscript(sessionId);
    let messages = [];

    if (Array.isArray(transcript)) {
      const rawMessages = [];
      let pendingAgentPrompts = 0; // Compteur de prompts d'agents à cacher
      let lastAssistantHadTaskTool = false; // Le dernier assistant a-t-il utilisé Task?

      for (const entry of transcript) {
        if (entry.type !== 'user' && entry.type !== 'assistant') continue;

        const { text, toolUses, isToolResult } = extractMessageContent(entry);
        const timestamp = entry.timestamp || entry.message?.timestamp || entry.createdAt || new Date().toISOString();

        if (entry.type === 'user') {
          if (isToolResult) continue;

          // Ignorer les messages automatiques
          if (text && (
            text.includes('<observed_from_primary_session>') ||
            text.includes('You are a Claude-Mem') ||
            text.includes('IMPORTANT: Ignore any')
          )) {
            continue;
          }

          // Marquer comme prompt d'agent si:
          // 1. On a des prompts d'agents en attente
          // 2. ET le dernier message assistant a utilisé le tool Task
          const isAgentPrompt = pendingAgentPrompts > 0 && lastAssistantHadTaskTool;
          if (isAgentPrompt) {
            pendingAgentPrompts--;
          }

          rawMessages.push({
            uuid: entry.uuid || crypto.randomUUID(),
            role: 'user',
            content: text,
            timestamp: timestamp,
            isAgentPrompt: isAgentPrompt // Marquer si c'est un prompt d'agent
          });

          // Reset après un message user
          lastAssistantHadTaskTool = false;
        } else if (entry.type === 'assistant') {
          // Compter le nombre d'agents spawnés (tool Task)
          const taskToolCount = toolUses.filter(t => t.name === 'Task').length;
          lastAssistantHadTaskTool = taskToolCount > 0;

          if (taskToolCount > 0) {
            pendingAgentPrompts += taskToolCount;
            console.log(`[Agent Spawn] Détecté ${taskToolCount} spawn(s) d'agent(s), ${pendingAgentPrompts} prompts à cacher`);
          }

          const todoData = extractTodoData(toolUses);

          // Créer message task séparé pour les todos
          if (todoData) {
            rawMessages.push({
              uuid: (entry.uuid || `assistant-${rawMessages.length}`) + '-todo',
              role: 'task',
              todos: todoData,
              timestamp: timestamp
            });
          }

          // Préparer les tool actions (si présentes)
          const otherToolUses = toolUses.filter(t => t.name !== 'TodoWrite');
          const toolActions = otherToolUses.length > 0 ? convertToolUsesToActions(otherToolUses) : null;

          // Filtrer les messages d'observation
          const isObservation = text && (
            text.includes('<observation>') ||
            text.includes("I'm ready to observe") ||
            text.includes('Waiting for tool execution')
          );

          // Créer le message assistant (si texte présent et non observation)
          if (text && text.trim() && !isObservation) {
            rawMessages.push({
              uuid: entry.uuid || `assistant-${rawMessages.length}`,
              role: 'assistant',
              content: text,
              timestamp: timestamp
            });
          }

          // Créer un message tool_action SÉPARÉ (si tools présents)
          if (toolActions) {
            rawMessages.push({
              uuid: (entry.uuid || `assistant-${rawMessages.length}`) + '-tools',
              role: 'tool_action',
              toolActions: toolActions,
              timestamp: timestamp
            });
          }
        }
      }

      // Agréger les messages CDP (tasks, tool_action)
      messages = aggregateCDPMessages(rawMessages);
    }

    // Pagination: extraire le sous-ensemble demandé
    const total = messages.length;
    const paginatedMessages = messages.slice(offset, offset + limit);
    const hasMore = (offset + limit) < total;

    res.json({
      messages: paginatedMessages,
      pagination: {
        offset,
        limit,
        total,
        hasMore,
        returned: paginatedMessages.length
      }
    });

  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors de la récupération des messages paginés',
      message: error.message
    });
  }
});

// STREAMING: Endpoint SSE pour les logs serveur en temps réel
app.get('/api/logs/stream', authMiddleware, (req, res) => {
  // Configurer les headers SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Désactiver buffering nginx

  // Ajouter le client à la liste
  sseClients.add(res);

  console.log(`[SSE] Client connecté (${sseClients.size} clients actifs)`);

  // Envoyer les logs existants d'abord (derniers 100)
  const recentLogs = serverLogs.slice(-100);
  recentLogs.forEach(log => {
    try {
      res.write(`data: ${JSON.stringify(log)}\n\n`);
    } catch (error) {
      // Ignore si client déjà déconnecté
    }
  });

  // Heartbeat toutes les 30 secondes pour garder la connexion active
  const heartbeat = setInterval(() => {
    try {
      res.write(`:heartbeat\n\n`);
    } catch (error) {
      clearInterval(heartbeat);
      sseClients.delete(res);
    }
  }, 30000);

  // Nettoyer quand le client se déconnecte
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    console.log(`[SSE] Client déconnecté (${sseClients.size} clients actifs)`);
  });
});

// Routes API pour l'usage (crédits/tokens)
app.get('/api/usage/current', authMiddleware, (req, res) => {
  try {
    const usage = usageTracker.getCurrentUsage();
    res.json({
      usage: usage,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors de la récupération de l\'usage actuel',
      message: error.message
    });
  }
});

app.get('/api/usage/history', authMiddleware, (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const history = usageTracker.getHistory(hours);
    res.json({
      history: history,
      hours: hours,
      count: history.length
    });
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors de la récupération de l\'historique',
      message: error.message
    });
  }
});

app.post('/api/usage/refresh', authMiddleware, async (req, res) => {
  try {
    await usageTracker.refreshUsage();
    const usage = usageTracker.getCurrentUsage();
    res.json({
      success: true,
      usage: usage
    });
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors du rafraîchissement de l\'usage',
      message: error.message
    });
  }
});

// ============================================================================
// Routes API pour la gestion des favoris
// ============================================================================

// Obtenir tous les favoris
app.get('/api/favorites', authMiddleware, (req, res) => {
  try {
    const favorites = favoritesManager.getAll();
    res.json({
      favorites: favorites,
      count: favorites.length
    });
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors de la récupération des favoris',
      message: error.message
    });
  }
});

// Ajouter un favori
app.post('/api/favorites', authMiddleware, (req, res) => {
  try {
    const { path, nickname } = req.body;

    if (!path || typeof path !== 'string') {
      return res.status(400).json({
        error: 'Le champ "path" est requis'
      });
    }

    const favorite = favoritesManager.add(path, nickname);
    res.json({
      success: true,
      favorite: favorite,
      message: 'Favori ajouté'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors de l\'ajout du favori',
      message: error.message
    });
  }
});

// Retirer un favori
app.delete('/api/favorites', authMiddleware, (req, res) => {
  try {
    const { path } = req.body;

    if (!path || typeof path !== 'string') {
      return res.status(400).json({
        error: 'Le champ "path" est requis'
      });
    }

    const removed = favoritesManager.remove(path);
    if (!removed) {
      return res.status(404).json({
        error: 'Favori non trouvé'
      });
    }

    res.json({
      success: true,
      message: 'Favori retiré'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors de la suppression du favori',
      message: error.message
    });
  }
});

// Mettre à jour le surnom d'un favori
app.patch('/api/favorites', authMiddleware, (req, res) => {
  try {
    const { path, nickname } = req.body;

    if (!path || typeof path !== 'string') {
      return res.status(400).json({
        error: 'Le champ "path" est requis'
      });
    }

    if (!nickname || typeof nickname !== 'string') {
      return res.status(400).json({
        error: 'Le champ "nickname" est requis'
      });
    }

    const favorite = favoritesManager.updateNickname(path, nickname);
    res.json({
      success: true,
      favorite: favorite,
      message: 'Surnom mis à jour'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors de la mise à jour du surnom',
      message: error.message
    });
  }
});

// Réorganiser les favoris
app.post('/api/favorites/reorder', authMiddleware, (req, res) => {
  try {
    const { orderedPaths } = req.body;

    if (!Array.isArray(orderedPaths)) {
      return res.status(400).json({
        error: 'Le champ "orderedPaths" doit être un tableau'
      });
    }

    const favorites = favoritesManager.reorder(orderedPaths);
    res.json({
      success: true,
      favorites: favorites,
      message: 'Favoris réorganisés'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors de la réorganisation',
      message: error.message
    });
  }
});

// Vider tous les favoris
app.delete('/api/favorites/all', authMiddleware, (req, res) => {
  try {
    favoritesManager.clear();
    res.json({
      success: true,
      message: 'Tous les favoris ont été supprimés'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors de la suppression des favoris',
      message: error.message
    });
  }
});

// Statistiques des favoris
app.get('/api/favorites/stats', authMiddleware, (req, res) => {
  try {
    const stats = favoritesManager.getStats();
    res.json({
      stats: stats
    });
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors de la récupération des statistiques',
      message: error.message
    });
  }
});

// ============================================================================
// Routes API pour le moniteur de connexions CDP
// ============================================================================

// Obtenir les statistiques du moniteur CDP
app.get('/api/cdp-monitor/stats', authMiddleware, (req, res) => {
  try {
    const stats = cdpMonitor.getStats();
    res.json({
      stats: stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors de la récupération des statistiques',
      message: error.message
    });
  }
});

// Obtenir l'historique des connexions CDP
app.get('/api/cdp-monitor/history', authMiddleware, (req, res) => {
  try {
    const history = cdpMonitor.getHistory();
    res.json({
      history: history,
      count: history.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors de la récupération de l\'historique',
      message: error.message
    });
  }
});

// Réinitialiser les statistiques du moniteur CDP
app.post('/api/cdp-monitor/reset', authMiddleware, (req, res) => {
  try {
    cdpMonitor.resetStats();
    res.json({
      success: true,
      message: 'Statistiques réinitialisées',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors de la réinitialisation',
      message: error.message
    });
  }
});

// Démarrer/arrêter le moniteur CDP
app.post('/api/cdp-monitor/toggle', authMiddleware, (req, res) => {
  try {
    const { enabled } = req.body;

    if (enabled) {
      cdpMonitor.start();
    } else {
      cdpMonitor.stop();
    }

    res.json({
      success: true,
      isMonitoring: cdpMonitor.isMonitoring,
      message: enabled ? 'Surveillance activée' : 'Surveillance désactivée',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors du basculement',
      message: error.message
    });
  }
});

// ============================================================================
// Routes API pour les permissions (hook system)
// ============================================================================

// Route appelee par le hook Claude Code pour demander une autorisation
// Cette route bloque jusqu'a ce que l'utilisateur reponde ou timeout mobile
// Routes hooks obsolètes supprimées - utiliser CDP uniquement
// Route pour répondre à une permission (CDP uniquement)
app.post('/api/permission/respond', authMiddleware, async (req, res) => {
  try {
    const { requestId, decision, updatedInput } = req.body;

    if (!requestId || !decision) {
      return res.status(400).json({
        error: 'requestId and decision are required'
      });
    }

    const validDecisions = ['once', 'always', 'deny'];
    if (!validDecisions.includes(decision)) {
      return res.status(400).json({
        error: `decision must be one of: ${validDecisions.join(', ')}`
      });
    }

    const cdpAvailable = await cdpController.isDebugModeAvailable();
    if (!cdpAvailable) {
      return res.status(503).json({
        error: 'CDP not available'
      });
    }

    const result = await cdpController.respondToPermission(requestId, decision, updatedInput);

    broadcastToClients({
      type: 'cdp-permission-responded',
      requestId,
      decision
    });

    res.json({
      success: true,
      requestId,
      decision
    });
  } catch (error) {
    console.error('[Permission CDP] Error:', error.message);
    res.status(500).json({
      error: 'Error responding to permission',
      message: error.message
    });
  }
});

// Routes obsolètes supprimées (always-allow, plan-mode) - fonctionnalités hook supprimées

// Route pour obtenir les demandes en attente (hooks + CDP)
app.get('/api/permission/pending', authMiddleware, async (req, res) => {
  try {
    const cdpAvailable = await cdpController.isDebugModeAvailable();

    if (!cdpAvailable) {
      return res.json({ pending: [], count: 0 });
    }

    const cdpPending = await cdpController.getPendingPermissions();
    const formatted = cdpPending.map(p => {
      // Extraire le toolName avec fallback si undefined
      let toolName = p.toolName;
      if (!toolName && p.input && p.input.name) {
        toolName = p.input.name;
      }
      if (!toolName) {
        toolName = 'Unknown';
      }

      // Calculer expiresAt (5 minutes après maintenant)
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString();

      // Déterminer le niveau de risque basé sur le type d'outil
      let riskLevel = 'low';
      if (['Bash', 'Write', 'Edit'].includes(toolName)) {
        riskLevel = 'high';
      } else if (['Task', 'WebFetch', 'WebSearch'].includes(toolName)) {
        riskLevel = 'medium';
      }

      return {
        id: p.requestId,
        requestId: p.requestId,
        sessionId: p.sessionId,
        toolName: toolName,
        toolInput: p.input,
        displayInput: formatToolInput(toolName, p.input),
        suggestions: p.suggestions,
        riskLevel: riskLevel,
        createdAt: now.toISOString(),
        expiresAt: expiresAt,
        source: 'cdp'
      };
    });

    res.json({
      pending: formatted,
      count: formatted.length
    });
  } catch (error) {
    res.status(500).json({
      error: 'Error fetching permissions',
      message: error.message
    });
  }
});

// Routes hooks obsolètes supprimées (request, history, delete)

// ============================================================================
// Routes API pour les questions (AskUserQuestion)
// ============================================================================

// Récupérer les questions en attente
app.get('/api/question/pending', authMiddleware, async (req, res) => {
  try {
    const cdpAvailable = await cdpController.isDebugModeAvailable();

    if (!cdpAvailable) {
      return res.json({ pending: [], count: 0 });
    }

    const cdpPending = await cdpController.getPendingQuestions();
    const formatted = cdpPending.map(q => ({
      id: q.questionId,
      questionId: q.questionId,
      sessionId: q.sessionId,
      questions: q.questions,
      metadata: q.metadata,
      createdAt: new Date().toISOString(),
      source: 'cdp'
    }));

    res.json({
      pending: formatted,
      count: formatted.length
    });
  } catch (error) {
    res.status(500).json({
      error: 'Error fetching questions',
      message: error.message
    });
  }
});

// Répondre à une question
app.post('/api/question/respond', authMiddleware, async (req, res) => {
  try {
    const { questionId, answers } = req.body;

    if (!questionId) {
      return res.status(400).json({ error: 'Missing questionId' });
    }

    if (!answers || typeof answers !== 'object') {
      return res.status(400).json({ error: 'Missing or invalid answers' });
    }

    const cdpAvailable = await cdpController.isDebugModeAvailable();
    if (!cdpAvailable) {
      return res.status(503).json({ error: 'CDP not available' });
    }

    const result = await cdpController.respondToQuestion(questionId, answers);

    // Notifier via WebSocket
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'cdp-question-answered',
          questionId,
          answers
        }));
      }
    });

    res.json(result);
  } catch (error) {
    console.error('[Question] Error responding:', error);
    console.error('[Question] Full error stack:', error.stack);
    console.error('[Question] questionId:', questionId);
    console.error('[Question] answers:', JSON.stringify(answers, null, 2));
    res.status(500).json({
      error: 'Error responding to question',
      message: error.message,
      details: error.stack
    });
  }
});

// ============================================================================
// Routes API pour les logs serveur
// ============================================================================

// Récupérer les logs serveur
app.get('/api/logs', authMiddleware, (req, res) => {
  const { level, limit, search } = req.query;

  let filteredLogs = [...serverLogs];

  // Filtrer par niveau si spécifié
  if (level && level !== 'all') {
    filteredLogs = filteredLogs.filter(log => log.level === level);
  }

  // Filtrer par recherche texte si spécifié
  if (search) {
    const searchLower = search.toLowerCase();
    filteredLogs = filteredLogs.filter(log =>
      log.message.toLowerCase().includes(searchLower)
    );
  }

  // Limiter le nombre de logs retournés
  const limitNum = limit ? parseInt(limit) : 500;
  if (filteredLogs.length > limitNum) {
    filteredLogs = filteredLogs.slice(-limitNum);
  }

  res.json({
    logs: filteredLogs,
    total: serverLogs.length,
    filtered: filteredLogs.length
  });
});

// Vider les logs serveur
app.delete('/api/logs', authMiddleware, (req, res) => {
  const count = serverLogs.length;
  serverLogs.length = 0;
  console.log('[LOGS] Buffer de logs vidé');
  res.json({ message: 'Logs cleared', count });
});

// ============================================================================
// Routes API pour l'injection de commandes (envoi de messages a Claude Code)
// ============================================================================

// Injecter une commande/message dans Claude Code
app.post('/api/inject', strictLimiter, authMiddleware, async (req, res) => {
  try {
    const { message, sessionId } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({
        error: 'Le champ "message" est requis et doit etre une chaine de caracteres'
      });
    }

    console.log(`[API Inject] Injection demandee: "${message.substring(0, 50)}..."`);

    const result = await commandInjector.injectCommand(sessionId || null, message);

    if (result.success) {
      res.json({
        success: true,
        method: result.method,
        message: `Message injecte via ${result.method}`,
        details: result
      });
    } else {
      res.status(500).json({
        success: false,
        method: result.method,
        error: result.error,
        message: 'Echec de l\'injection. Verifiez que Claude Code est actif et visible.'
      });
    }
  } catch (error) {
    console.error('[API Inject] Erreur:', error.message);
    res.status(500).json({
      error: 'Erreur lors de l\'injection',
      message: error.message
    });
  }
});

// Injecter une commande pour une session specifique
app.post('/api/session/:id/inject', authMiddleware, async (req, res) => {
  try {
    const { message } = req.body;
    const sessionId = req.params.id;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({
        error: 'Le champ "message" est requis et doit etre une chaine de caracteres'
      });
    }

    console.log(`[API Inject] Injection pour session ${sessionId}: "${message.substring(0, 50)}..."`);

    const result = await commandInjector.injectCommand(sessionId, message);

    if (result.success) {
      // Broadcast aux clients WebSocket
      broadcastToClients({
        type: 'message-injected',
        sessionId: sessionId,
        message: message,
        method: result.method,
        timestamp: new Date().toISOString()
      });

      res.json({
        success: true,
        sessionId: sessionId,
        method: result.method,
        message: `Message injecte via ${result.method}`,
        details: result
      });
    } else {
      res.status(500).json({
        success: false,
        sessionId: sessionId,
        method: result.method,
        error: result.error,
        message: 'Echec de l\'injection. Verifiez que Claude Code est actif et visible.'
      });
    }
  } catch (error) {
    console.error('[API Inject] Erreur:', error.message);
    res.status(500).json({
      error: 'Erreur lors de l\'injection',
      message: error.message
    });
  }
});

// Route obsolète supprimée - Mode plan géré nativement par Claude Desktop

// Obtenir le statut de l'injection (methodes disponibles, etc.)
app.get('/api/inject/status', authMiddleware, async (req, res) => {
  try {
    const status = await commandInjector.getStatus();

    res.json({
      ...status,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors de la recuperation du statut',
      message: error.message
    });
  }
});

// Configurer les parametres d'injection
app.post('/api/inject/configure', authMiddleware, (req, res) => {
  try {
    const { preferredMethod, tmuxSession, windowTitle, retryAttempts, retryDelay } = req.body;

    const config = commandInjector.configure({
      preferredMethod,
      tmuxSession,
      windowTitle,
      retryAttempts,
      retryDelay
    });

    res.json({
      success: true,
      config: config,
      message: 'Configuration mise a jour'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors de la configuration',
      message: error.message
    });
  }
});

// Obtenir les statistiques d'injection
app.get('/api/inject/stats', authMiddleware, (req, res) => {
  try {
    const status = commandInjector.stats;
    const lastInjection = commandInjector.lastInjection;

    res.json({
      stats: status,
      lastInjection: lastInjection,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors de la recuperation des statistiques',
      message: error.message
    });
  }
});

// Queue une commande pour execution ulterieure
app.post('/api/inject/queue', authMiddleware, (req, res) => {
  try {
    const { message, sessionId } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({
        error: 'Le champ "message" est requis'
      });
    }

    const item = commandInjector.queueCommand(sessionId || 'default', message);

    res.json({
      success: true,
      item: item,
      message: 'Commande ajoutee a la queue'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors de l\'ajout a la queue',
      message: error.message
    });
  }
});

// Executer les commandes en queue
app.post('/api/inject/queue/process', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.body;

    const result = await commandInjector.processQueue(sessionId || 'default');

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors du traitement de la queue',
      message: error.message
    });
  }
});

// Obtenir les commandes en queue
app.get('/api/inject/queue/:sessionId?', authMiddleware, (req, res) => {
  try {
    const sessionId = req.params.sessionId || 'default';
    const queue = commandInjector.getQueuedCommands(sessionId);

    res.json({
      sessionId: sessionId,
      queue: queue,
      count: queue.length
    });
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors de la recuperation de la queue',
      message: error.message
    });
  }
});

// Vider la queue d'une session
app.delete('/api/inject/queue/:sessionId?', authMiddleware, (req, res) => {
  try {
    const sessionId = req.params.sessionId || 'default';
    commandInjector.clearQueue(sessionId);

    res.json({
      success: true,
      sessionId: sessionId,
      message: 'Queue videe'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors du vidage de la queue',
      message: error.message
    });
  }
});

// Lister toutes les fenetres Claude disponibles (Desktop App et Terminal)
app.get('/api/inject/windows', authMiddleware, async (req, res) => {
  try {
    const windows = await commandInjector.strategies.listAllClaudeWindows();

    res.json({
      windows: windows,
      count: windows.length,
      recommendation: windows.length > 0
        ? `${windows.length} fenetre(s) Claude trouvee(s). Utilisez le PID pour cibler une fenetre specifique.`
        : 'Aucune fenetre Claude trouvee. Assurez-vous que Claude Desktop ou Claude Code est lance.',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors de la liste des fenetres',
      message: error.message
    });
  }
});

// Obtenir la meilleure methode d'injection disponible
app.get('/api/inject/best-method', authMiddleware, async (req, res) => {
  try {
    const bestMethod = await commandInjector.strategies.getBestMethod();

    res.json({
      ...bestMethod,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors de la detection de la meilleure methode',
      message: error.message
    });
  }
});

// =====================================================
// CDP Controller - Control Claude Desktop via DevTools
// =====================================================
// (CDPController initialisé en haut du fichier)

// Endpoint de debug pour chercher l'état "thinking" dans le DOM/React
// Accessible via: fetch('/api/debug/thinking-state').then(r => r.json()).then(console.log)
app.get('/api/debug/thinking-state', authMiddleware, async (req, res) => {
  try {
    const result = await cdpController.executeJS(`
      (function() {
        const results = {};

        // 1. Chercher le texte d'indicateur visible
        const thinkingTerms = ['meandering', 'simmering', 'churning', 'marinating', 'reticulating', 'pondering'];
        const bodyText = document.body.innerText.toLowerCase();
        results.visibleIndicator = null;
        for (const term of thinkingTerms) {
          if (bodyText.includes(term)) {
            results.visibleIndicator = term;
            break;
          }
        }

        // 2. Chercher des éléments avec des classes liées au streaming/loading
        const streamingEls = document.querySelectorAll('[class*="stream"], [class*="loading"], [class*="typing"], [class*="generat"]');
        results.streamingElements = streamingEls.length;
        if (streamingEls.length > 0) {
          results.streamingClasses = Array.from(streamingEls).slice(0, 5).map(el => el.className);
        }

        // 3. Chercher l'état React (si accessible)
        const reactRoot = document.getElementById('root');
        if (reactRoot && reactRoot._reactRootContainer) {
          results.hasReactRoot = true;
        }

        // 4. Chercher dans window pour des états globaux
        results.windowKeys = Object.keys(window).filter(k =>
          k.toLowerCase().includes('stream') ||
          k.toLowerCase().includes('generat') ||
          k.toLowerCase().includes('loading') ||
          k.toLowerCase().includes('thinking')
        );

        return results;
      })()
    `, false);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint de debug pour explorer les APIs Claude Desktop
// Accessible via: fetch('/api/debug/apis').then(r => r.json()).then(console.log)
app.get('/api/debug/apis', authMiddleware, async (req, res) => {
  try {
    const apis = await cdpController.executeJS(`
      (function() {
        const claudeWeb = window['claude.web'];
        if (!claudeWeb) return { error: 'claude.web not found' };

        const result = {
          topLevelKeys: Object.keys(claudeWeb),
          localSessionsMethods: claudeWeb.LocalSessions ? Object.keys(claudeWeb.LocalSessions) : null
        };

        // Explorer chaque clé de premier niveau
        for (const key of Object.keys(claudeWeb)) {
          if (typeof claudeWeb[key] === 'object' && claudeWeb[key] !== null) {
            result[key + '_keys'] = Object.keys(claudeWeb[key]);
          }
        }

        return result;
      })()
    `, false);
    res.json(apis);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint de debug pour voir la structure des sessions CDP
// Accessible via: fetch('/api/debug/sessions').then(r => r.json()).then(console.log)
// Use ?includeHidden=true to include orchestrator worker sessions
app.get('/api/debug/sessions', authMiddleware, async (req, res) => {
  try {
    // Debug endpoint includes hidden sessions by default
    const includeHidden = req.query.includeHidden !== 'false';
    const sessions = await cdpController.getAllSessions(false, includeHidden);
    if (!sessions || sessions.length === 0) {
      return res.json({ message: 'No sessions found', sessions: [] });
    }

    // Retourner la structure complète pour debug
    const firstSession = sessions[0];
    res.json({
      sessionCount: sessions.length,
      includeHidden,
      firstSessionKeys: Object.keys(firstSession),
      firstSessionFull: firstSession,
      allSessions: sessions
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint de debug pour explorer les informations de contexte/tokens d'une session
// Accessible via: fetch('/api/debug/context/SESSION_ID').then(r => r.json()).then(console.log)
app.get('/api/debug/context/:sessionId?', authMiddleware, async (req, res) => {
  try {
    let sessionId = req.params.sessionId;

    // Si pas de sessionId, utiliser la session courante
    if (!sessionId) {
      sessionId = await cdpController.getCurrentSessionId();
    }

    if (!sessionId) {
      return res.status(404).json({ error: 'No session found' });
    }

    // Ensure sessionId has local_ prefix
    if (!sessionId.startsWith('local_')) {
      sessionId = 'local_' + sessionId;
    }

    // Explorer toutes les données disponibles pour cette session
    const result = await cdpController.executeJS(`
      (async function() {
        const claudeWeb = window['claude.web'];
        if (!claudeWeb) return { error: 'claude.web not found' };

        const sessionId = ${JSON.stringify(sessionId)};
        const result = {
          sessionId: sessionId,
          apis: {}
        };

        // 1. LocalSessions - toutes les méthodes disponibles
        if (claudeWeb.LocalSessions) {
          result.apis.LocalSessions = Object.keys(claudeWeb.LocalSessions);

          // Récupérer les données de la session
          try {
            const session = await claudeWeb.LocalSessions.getSession(sessionId);
            result.sessionData = session;
            result.sessionKeys = session ? Object.keys(session) : null;
          } catch (e) {
            result.sessionError = e.message;
          }

          // Récupérer le transcript pour compter les tokens (approximatif)
          try {
            const transcript = await claudeWeb.LocalSessions.getTranscript(sessionId);
            if (transcript && Array.isArray(transcript)) {
              result.transcriptLength = transcript.length;
              // Chercher des infos de tokens dans les entrées
              const entryWithUsage = transcript.find(e => e.usage || e.tokenCount || e.tokens);
              if (entryWithUsage) {
                result.sampleEntryWithUsage = entryWithUsage;
              }
              // Examiner la structure du dernier message assistant
              const lastAssistant = [...transcript].reverse().find(e => e.type === 'assistant');
              if (lastAssistant) {
                result.lastAssistantKeys = Object.keys(lastAssistant);
                result.lastAssistantSample = {
                  type: lastAssistant.type,
                  usage: lastAssistant.usage,
                  tokens: lastAssistant.tokens,
                  tokenCount: lastAssistant.tokenCount,
                  model: lastAssistant.model
                };
              }
            }
          } catch (e) {
            result.transcriptError = e.message;
          }
        }

        // 2. Chercher d'autres APIs liées au contexte/tokens
        for (const key of Object.keys(claudeWeb)) {
          const api = claudeWeb[key];
          if (typeof api === 'object' && api !== null) {
            const methods = Object.keys(api);
            const contextMethods = methods.filter(m =>
              m.toLowerCase().includes('context') ||
              m.toLowerCase().includes('token') ||
              m.toLowerCase().includes('usage') ||
              m.toLowerCase().includes('limit')
            );
            if (contextMethods.length > 0) {
              result.apis[key + '_context_related'] = contextMethods;
            }
          }
        }

        // 3. Chercher dans window pour des états globaux liés au contexte
        result.windowContextKeys = Object.keys(window).filter(k =>
          k.toLowerCase().includes('context') ||
          k.toLowerCase().includes('token') ||
          k.toLowerCase().includes('usage') ||
          k.toLowerCase().includes('limit')
        );

        return result;
      })()
    `, true);

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Vérifier si le mode debug CDP est disponible
app.get('/api/status', authMiddleware, async (req, res) => {
  try {
    const available = await cdpController.isDebugModeAvailable();
    let currentSession = null;

    if (available) {
      currentSession = await cdpController.getCurrentSessionId();
    }

    res.json({
      available,
      currentSession,
      port: 9222,
      message: available
        ? 'Claude Desktop est en mode debug'
        : 'Claude Desktop n\'est pas en mode debug. Lancez-le avec --remote-debugging-port=9222',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.json({
      available: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Lister toutes les sessions Desktop (alternative à /api/sessions)
// Use ?includeHidden=true to include orchestrator worker sessions
app.get('/api/cdp-sessions', authMiddleware, async (req, res) => {
  try {
    // By default, filter out hidden orchestrator worker sessions
    const includeHidden = req.query.includeHidden === 'true';
    const sessions = await cdpController.getAllSessions(false, includeHidden);
    const currentSession = await cdpController.getCurrentSessionId();

    res.json({
      sessions: sessions.map(s => ({
        ...s,
        isCurrent: s.sessionId === currentSession
      })),
      currentSession,
      includeHidden,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors de la récupération des sessions',
      message: error.message,
      debugModeRequired: error.message.includes('debug')
    });
  }
});

// Changer de session active
app.post('/api/switch-session', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId requis' });
    }

    const result = await cdpController.switchSession(sessionId);

    // Broadcast aux clients WebSocket
    broadcastToClients({
      type: 'cdp-session-switched',
      sessionId: result.sessionId,
      timestamp: new Date().toISOString()
    });

    res.json({
      success: true,
      sessionId: result.sessionId,
      message: `Session changée vers ${result.sessionId}`,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors du changement de session',
      message: error.message
    });
  }
});

// Envoyer un message à une session spécifique
app.post('/api/send', strictLimiter, authMiddleware, async (req, res) => {
  try {
    const { sessionId, message, attachments = [] } = req.body;

    if (!sessionId || !message) {
      return res.status(400).json({ error: 'sessionId et message requis' });
    }

    const result = await cdpController.sendMessage(sessionId, message, attachments);

    res.json({
      success: true,
      sessionId: result.sessionId,
      message: 'Message envoyé',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors de l\'envoi du message',
      message: error.message
    });
  }
});

// Créer une nouvelle session
app.post('/api/new-session', authMiddleware, async (req, res) => {
  try {
    const { cwd, message, options = {} } = req.body;

    if (!cwd) {
      return res.status(400).json({ error: 'cwd (chemin de travail) requis' });
    }

    if (!message) {
      return res.status(400).json({ error: 'message (message initial) requis' });
    }

    // Créer la session avec le message initial
    const result = await cdpController.startNewSessionWithMessage(cwd, message, options);

    res.json({
      success: true,
      session: result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors de la création de la session',
      message: error.message
    });
  }
});

// Obtenir les détails d'une session (alternative à /api/session/:id)
app.get('/api/session-details/:sessionId', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await cdpController.getSession(sessionId);

    res.json({
      session,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors de la récupération de la session',
      message: error.message
    });
  }
});

// Archiver une session
app.post('/api/archive-session/:sessionId', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const result = await cdpController.archiveSession(sessionId);

    res.json({
      success: true,
      sessionId: result.sessionId,
      message: 'Session archivée',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors de l\'archivage de la session',
      message: error.message
    });
  }
});

// ============================================================================
// Routes API pour l'orchestrateur (Big Tasks)
// ============================================================================

// --- Template Endpoints ---

// GET /api/orchestrator/templates - List all templates
app.get('/api/orchestrator/templates', authMiddleware, async (req, res) => {
  try {
    const templates = await orchestratorModule.templates.getAllTemplates();
    res.json({
      success: true,
      templates: templates,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// GET /api/orchestrator/templates/:id - Get template details
app.get('/api/orchestrator/templates/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const resolved = req.query.resolved !== 'false'; // Default true

    let template;
    if (resolved) {
      template = await orchestratorModule.templates.getTemplate(id);
    } else {
      template = orchestratorModule.templates.templates.get(id);
      if (!template) {
        return res.status(404).json({
          success: false,
          error: 'NotFoundError',
          message: `Template '${id}' not found`,
          timestamp: new Date().toISOString()
        });
      }
    }

    res.json({
      success: true,
      template: template,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: 'NotFoundError',
        message: error.message,
        timestamp: new Date().toISOString()
      });
    }
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// POST /api/orchestrator/templates - Create new template
app.post('/api/orchestrator/templates', authMiddleware, async (req, res) => {
  try {
    const templateData = req.body;

    if (!templateData.name) {
      return res.status(400).json({
        success: false,
        error: 'ValidationError',
        message: 'Template name is required',
        timestamp: new Date().toISOString()
      });
    }

    const template = await orchestratorModule.templates.createTemplate(templateData);
    res.status(201).json({
      success: true,
      template: template,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    if (error.message.includes('already exists')) {
      return res.status(409).json({
        success: false,
        error: 'ConflictError',
        message: error.message,
        timestamp: new Date().toISOString()
      });
    }
    if (error.message.includes('Invalid template') || error.message.includes('cannot')) {
      return res.status(400).json({
        success: false,
        error: 'ValidationError',
        message: error.message,
        timestamp: new Date().toISOString()
      });
    }
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// PUT /api/orchestrator/templates/:id - Update template
app.put('/api/orchestrator/templates/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const templateData = req.body;

    const template = await orchestratorModule.templates.updateTemplate(id, templateData);
    res.json({
      success: true,
      template: template,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: 'NotFoundError',
        message: error.message,
        timestamp: new Date().toISOString()
      });
    }
    if (error.message.includes('system template') || error.message.includes('Cannot update')) {
      return res.status(403).json({
        success: false,
        error: 'ForbiddenError',
        message: error.message,
        timestamp: new Date().toISOString()
      });
    }
    if (error.message.includes('Invalid template')) {
      return res.status(400).json({
        success: false,
        error: 'ValidationError',
        message: error.message,
        timestamp: new Date().toISOString()
      });
    }
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// DELETE /api/orchestrator/templates/:id - Delete template
app.delete('/api/orchestrator/templates/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    await orchestratorModule.templates.deleteTemplate(id);
    res.json({
      success: true,
      message: 'Template deleted',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: 'NotFoundError',
        message: error.message,
        timestamp: new Date().toISOString()
      });
    }
    if (error.message.includes('system template') || error.message.includes('Cannot delete')) {
      return res.status(403).json({
        success: false,
        error: 'ForbiddenError',
        message: error.message,
        timestamp: new Date().toISOString()
      });
    }
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// POST /api/orchestrator/templates/:id/duplicate - Duplicate template
app.post('/api/orchestrator/templates/:id/duplicate', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'ValidationError',
        message: 'New template name is required',
        timestamp: new Date().toISOString()
      });
    }

    const template = await orchestratorModule.templates.duplicateTemplate(id, name);
    res.status(201).json({
      success: true,
      template: template,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: 'NotFoundError',
        message: error.message,
        timestamp: new Date().toISOString()
      });
    }
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// POST /api/orchestrator/templates/import - Import template from JSON
app.post('/api/orchestrator/templates/import', authMiddleware, async (req, res) => {
  try {
    const { template: templateData } = req.body;

    if (!templateData) {
      return res.status(400).json({
        success: false,
        error: 'ValidationError',
        message: 'Template data is required',
        timestamp: new Date().toISOString()
      });
    }

    const template = await orchestratorModule.templates.createTemplate(templateData);
    res.status(201).json({
      success: true,
      template: template,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    if (error.message.includes('already exists')) {
      return res.status(409).json({
        success: false,
        error: 'ConflictError',
        message: error.message,
        timestamp: new Date().toISOString()
      });
    }
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// GET /api/orchestrator/templates/export - Export all custom templates
app.get('/api/orchestrator/templates/export', authMiddleware, async (req, res) => {
  try {
    const allTemplates = await orchestratorModule.templates.getAllTemplates();
    const customTemplates = allTemplates.filter(t => !t.isSystem);

    // Get full template data for each custom template
    const fullTemplates = await Promise.all(
      customTemplates.map(t => orchestratorModule.templates.getTemplate(t.id))
    );

    res.json({
      success: true,
      templates: fullTemplates,
      exportedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// --- Orchestrator Endpoints ---

// POST /api/orchestrator/create - Create new orchestrator session
app.post('/api/orchestrator/create', orchestratorCreateLimiter, authMiddleware, async (req, res) => {
  try {
    const { templateId, cwd, message, customVariables, options } = req.body;

    // Validate required fields
    if (!templateId) {
      return res.status(400).json({
        success: false,
        error: 'ValidationError',
        message: 'templateId is required',
        timestamp: new Date().toISOString()
      });
    }
    if (!cwd) {
      return res.status(400).json({
        success: false,
        error: 'ValidationError',
        message: 'cwd is required',
        timestamp: new Date().toISOString()
      });
    }
    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'ValidationError',
        message: 'message is required',
        timestamp: new Date().toISOString()
      });
    }

    // Create orchestrator
    const orchestrator = await orchestratorModule.orchestrators.create({
      templateId,
      cwd,
      message,
      customVariables: customVariables || {}
    });

    // Auto-start orchestrator (create main session and begin analysis)
    const autoStart = options?.autoStart !== false; // Default: true
    if (autoStart) {
      try {
        await orchestratorModule.orchestrators.start(orchestrator.id);
      } catch (startError) {
        console.error('[Orchestrator API] Failed to auto-start:', startError.message);
        // Continue anyway - user can manually start later
      }
    }

    // Get updated state after start
    const updatedOrchestrator = orchestratorModule.orchestrators.get(orchestrator.id);

    res.status(201).json({
      success: true,
      orchestrator: {
        id: updatedOrchestrator.id,
        templateId: updatedOrchestrator.templateId,
        mainSessionId: updatedOrchestrator.mainSessionId,
        status: updatedOrchestrator.status,
        currentPhase: updatedOrchestrator.currentPhase,
        createdAt: updatedOrchestrator.createdAt.toISOString()
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: 'NotFoundError',
        message: error.message,
        timestamp: new Date().toISOString()
      });
    }
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// GET /api/orchestrator/by-session/:sessionId - Find orchestrator by session ID
app.get('/api/orchestrator/by-session/:sessionId', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.params;

    // Search all orchestrators for one with this mainSessionId
    const allOrchestrators = orchestratorModule.orchestrators.getAll();
    console.log('[Orchestrator API] Looking for session:', sessionId);
    console.log('[Orchestrator API] Available orchestrators:', allOrchestrators.map(o => ({ id: o.id, mainSessionId: o.mainSessionId })));
    const orchestrator = allOrchestrators.find(o => o.mainSessionId === sessionId);

    if (!orchestrator) {
      return res.status(404).json({
        success: false,
        error: 'NotFoundError',
        message: `No orchestrator found for session '${sessionId}'`,
        timestamp: new Date().toISOString()
      });
    }

    // Return orchestrator ID only (lightweight)
    res.json({
      success: true,
      orchestratorId: orchestrator.id,
      templateId: orchestrator.templateId,
      status: orchestrator.status,
      currentPhase: orchestrator.currentPhase,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// GET /api/orchestrator/:id - Get orchestrator details
app.get('/api/orchestrator/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const orchestrator = orchestratorModule.orchestrators.get(id);

    if (!orchestrator) {
      return res.status(404).json({
        success: false,
        error: 'NotFoundError',
        message: `Orchestrator '${id}' not found`,
        timestamp: new Date().toISOString()
      });
    }

    // Get worker states
    const workers = orchestratorModule.workers.getAllWorkers(id);
    const workerMap = {};
    for (const worker of workers) {
      workerMap[worker.taskId] = {
        sessionId: worker.sessionId,
        status: worker.status,
        progress: worker.progress,
        currentAction: worker.currentAction,
        toolStats: worker.toolStats
      };
    }

    res.json({
      success: true,
      orchestrator: {
        id: orchestrator.id,
        templateId: orchestrator.templateId,
        mainSessionId: orchestrator.mainSessionId,
        status: orchestrator.status,
        currentPhase: orchestrator.currentPhase,
        analysis: orchestrator.analysis,
        tasks: orchestrator.tasks,
        workers: workerMap,
        stats: orchestrator.stats,
        createdAt: orchestrator.createdAt?.toISOString(),
        startedAt: orchestrator.startedAt?.toISOString(),
        completedAt: orchestrator.completedAt?.toISOString()
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// GET /api/orchestrator/:id/status - Get orchestrator status (lightweight)
app.get('/api/orchestrator/:id/status', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const status = orchestratorModule.orchestrators.getStatus(id);

    if (!status) {
      return res.status(404).json({
        success: false,
        error: 'NotFoundError',
        message: `Orchestrator '${id}' not found`,
        timestamp: new Date().toISOString()
      });
    }

    // Get worker progress summary
    const workers = orchestratorModule.workers.getAllWorkers(id);
    const progress = {
      total: workers.length,
      completed: workers.filter(w => w.status === 'completed').length,
      running: workers.filter(w => ['running', 'spawning'].includes(w.status)).length,
      pending: workers.filter(w => w.status === 'pending').length,
      failed: workers.filter(w => ['failed', 'timeout', 'cancelled'].includes(w.status)).length,
      percent: workers.length > 0
        ? Math.round((workers.filter(w => w.status === 'completed').length / workers.length) * 100)
        : 0
    };

    res.json({
      success: true,
      status: {
        id: status.id,
        status: status.status,
        phase: status.currentPhase,
        progress: progress,
        stats: status.stats
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// POST /api/orchestrator/:id/message - Send message to orchestrator main session
app.post('/api/orchestrator/:id/message', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({
        success: false,
        error: 'ValidationError',
        message: 'Message is required and must be a non-empty string',
        timestamp: new Date().toISOString()
      });
    }

    const orchestrator = orchestratorModule.orchestrators.get(id);
    if (!orchestrator) {
      return res.status(404).json({
        success: false,
        error: 'NotFoundError',
        message: `Orchestrator '${id}' not found`,
        timestamp: new Date().toISOString()
      });
    }

    if (!orchestrator.mainSessionId) {
      return res.status(400).json({
        success: false,
        error: 'InvalidStateError',
        message: 'Orchestrator does not have a main session yet. Start the orchestrator first.',
        timestamp: new Date().toISOString()
      });
    }

    // Send message to the main session
    await cdpController.sendMessage(orchestrator.mainSessionId, message.trim());

    res.json({
      success: true,
      message: 'Message sent successfully',
      sessionId: orchestrator.mainSessionId,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error(`[API] Error sending message to orchestrator ${req.params.id}:`, error);
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// POST /api/orchestrator/:id/start - Start orchestration
app.post('/api/orchestrator/:id/start', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    await orchestratorModule.orchestrators.start(id);

    const orchestrator = orchestratorModule.orchestrators.get(id);
    res.json({
      success: true,
      message: 'Orchestration started',
      status: orchestrator.status,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: 'NotFoundError',
        message: error.message,
        timestamp: new Date().toISOString()
      });
    }
    if (error.message.includes('Cannot start')) {
      return res.status(400).json({
        success: false,
        error: 'ValidationError',
        message: error.message,
        timestamp: new Date().toISOString()
      });
    }
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// POST /api/orchestrator/:id/confirm-tasks - Confirm tasks and spawn workers
app.post('/api/orchestrator/:id/confirm-tasks', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { modifications } = req.body;

    const result = await orchestratorModule.confirmTasksAndSpawn(id, modifications);

    res.json({
      success: true,
      message: 'Workers spawned',
      workersCreated: result.workersCreated,
      tasksQueued: result.tasksQueued,
      skipped: result.skipped,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: 'NotFoundError',
        message: error.message,
        timestamp: new Date().toISOString()
      });
    }
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// POST /api/orchestrator/:id/pause - Pause orchestrator
app.post('/api/orchestrator/:id/pause', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    await orchestratorModule.orchestrators.pause(id);

    // Count paused workers
    const activeWorkers = orchestratorModule.workers.getActiveWorkers(id);

    res.json({
      success: true,
      message: 'Orchestrator paused',
      pausedWorkers: activeWorkers.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: 'NotFoundError',
        message: error.message,
        timestamp: new Date().toISOString()
      });
    }
    if (error.message.includes('Cannot pause')) {
      return res.status(400).json({
        success: false,
        error: 'ValidationError',
        message: error.message,
        timestamp: new Date().toISOString()
      });
    }
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// POST /api/orchestrator/:id/resume - Resume orchestrator
app.post('/api/orchestrator/:id/resume', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    await orchestratorModule.orchestrators.resume(id);

    res.json({
      success: true,
      message: 'Orchestrator resumed',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: 'NotFoundError',
        message: error.message,
        timestamp: new Date().toISOString()
      });
    }
    if (error.message.includes('Cannot resume')) {
      return res.status(400).json({
        success: false,
        error: 'ValidationError',
        message: error.message,
        timestamp: new Date().toISOString()
      });
    }
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// POST /api/orchestrator/:id/cancel - Cancel orchestrator
app.post('/api/orchestrator/:id/cancel', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { archiveWorkers = true, deleteWorkers = false } = req.body;

    const result = await orchestratorModule.cancelAndCleanup(id, {
      archiveWorkers,
      deleteWorkers
    });

    res.json({
      success: true,
      message: 'Orchestrator cancelled',
      cleanedUp: {
        workers: result.workers,
        archived: result.archived
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: 'NotFoundError',
        message: error.message,
        timestamp: new Date().toISOString()
      });
    }
    if (error.message.includes('Cannot cancel')) {
      return res.status(400).json({
        success: false,
        error: 'ValidationError',
        message: error.message,
        timestamp: new Date().toISOString()
      });
    }
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// --- Worker Endpoints ---

// GET /api/orchestrator/:id/workers - List all workers
app.get('/api/orchestrator/:id/workers', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { status: statusFilter } = req.query;

    // Check orchestrator exists
    const orchestrator = orchestratorModule.orchestrators.get(id);
    if (!orchestrator) {
      return res.status(404).json({
        success: false,
        error: 'NotFoundError',
        message: `Orchestrator '${id}' not found`,
        timestamp: new Date().toISOString()
      });
    }

    let workers = orchestratorModule.workers.getAllWorkers(id);

    // Filter by status if provided
    if (statusFilter) {
      workers = workers.filter(w => w.status === statusFilter);
    }

    res.json({
      success: true,
      workers: workers.map(w => ({
        taskId: w.taskId,
        sessionId: w.sessionId,
        status: w.status,
        progress: w.progress,
        currentAction: w.currentAction,
        toolStats: w.toolStats,
        startedAt: w.startedAt?.toISOString(),
        completedAt: w.completedAt?.toISOString()
      })),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// GET /api/orchestrator/:id/workers/:taskId - Get specific worker
app.get('/api/orchestrator/:id/workers/:taskId', authMiddleware, async (req, res) => {
  try {
    const { id, taskId } = req.params;

    // Check orchestrator exists
    const orchestrator = orchestratorModule.orchestrators.get(id);
    if (!orchestrator) {
      return res.status(404).json({
        success: false,
        error: 'NotFoundError',
        message: `Orchestrator '${id}' not found`,
        timestamp: new Date().toISOString()
      });
    }

    const worker = orchestratorModule.workers.getWorkerByTaskId(taskId);
    if (!worker || worker.orchestratorId !== id) {
      return res.status(404).json({
        success: false,
        error: 'NotFoundError',
        message: `Worker for task '${taskId}' not found`,
        timestamp: new Date().toISOString()
      });
    }

    res.json({
      success: true,
      worker: {
        taskId: worker.taskId,
        sessionId: worker.sessionId,
        task: worker.task,
        status: worker.status,
        progress: worker.progress,
        currentAction: worker.currentAction,
        output: worker.output,
        outputFiles: worker.outputFiles,
        error: worker.error,
        toolStats: worker.toolStats,
        retryCount: worker.retryCount,
        startedAt: worker.startedAt?.toISOString(),
        completedAt: worker.completedAt?.toISOString()
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// POST /api/orchestrator/:id/workers/:taskId/retry - Retry failed worker
app.post('/api/orchestrator/:id/workers/:taskId/retry', authMiddleware, async (req, res) => {
  try {
    const { id, taskId } = req.params;

    // Check orchestrator exists
    const orchestrator = orchestratorModule.orchestrators.get(id);
    if (!orchestrator) {
      return res.status(404).json({
        success: false,
        error: 'NotFoundError',
        message: `Orchestrator '${id}' not found`,
        timestamp: new Date().toISOString()
      });
    }

    const worker = orchestratorModule.workers.getWorkerByTaskId(taskId);
    if (!worker || worker.orchestratorId !== id) {
      return res.status(404).json({
        success: false,
        error: 'NotFoundError',
        message: `Worker for task '${taskId}' not found`,
        timestamp: new Date().toISOString()
      });
    }

    const retryResult = await orchestratorModule.workers.retryWorker(worker.sessionId);

    res.json({
      success: true,
      message: 'Worker retry started',
      newSessionId: retryResult.sessionId,
      retryCount: retryResult.retryCount,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    if (error.message.includes('Cannot retry') || error.message.includes('exceeded')) {
      return res.status(400).json({
        success: false,
        error: 'ValidationError',
        message: error.message,
        timestamp: new Date().toISOString()
      });
    }
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// POST /api/orchestrator/:id/workers/:taskId/cancel - Cancel specific worker
app.post('/api/orchestrator/:id/workers/:taskId/cancel', authMiddleware, async (req, res) => {
  try {
    const { id, taskId } = req.params;

    // Check orchestrator exists
    const orchestrator = orchestratorModule.orchestrators.get(id);
    if (!orchestrator) {
      return res.status(404).json({
        success: false,
        error: 'NotFoundError',
        message: `Orchestrator '${id}' not found`,
        timestamp: new Date().toISOString()
      });
    }

    const worker = orchestratorModule.workers.getWorkerByTaskId(taskId);
    if (!worker || worker.orchestratorId !== id) {
      return res.status(404).json({
        success: false,
        error: 'NotFoundError',
        message: `Worker for task '${taskId}' not found`,
        timestamp: new Date().toISOString()
      });
    }

    await orchestratorModule.workers.cancelWorker(worker.sessionId);

    res.json({
      success: true,
      message: 'Worker cancelled',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ============================================================================
// Routes SubSession (Sous-sessions avec retour automatique)
// ============================================================================

// GET /api/subsessions - List all subsessions
app.get('/api/subsessions', authMiddleware, async (req, res) => {
  try {
    const stats = orchestratorModule.subSessions.getStats();
    const relations = Array.from(orchestratorModule.subSessions.relations.values());

    res.json({
      success: true,
      stats,
      subsessions: relations.map(r => ({
        childSessionId: r.childSessionId,
        parentSessionId: r.parentSessionId,
        status: r.status,
        messageCount: r.messageCount,
        createdAt: r.createdAt,
        lastActivityAt: r.lastActivityAt,
        error: r.error
      })),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// GET /api/subsessions/:childId - Get specific subsession
app.get('/api/subsessions/:childId', authMiddleware, async (req, res) => {
  try {
    const { childId } = req.params;
    const relation = orchestratorModule.subSessions.getRelation(childId);

    if (!relation) {
      return res.status(404).json({
        success: false,
        error: 'NotFound',
        message: `SubSession not found: ${childId}`,
        timestamp: new Date().toISOString()
      });
    }

    res.json({
      success: true,
      subsession: relation,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// POST /api/subsessions/register - Manually register a subsession
app.post('/api/subsessions/register', authMiddleware, async (req, res) => {
  try {
    const { childSessionId, parentSessionId, taskToolId } = req.body;

    if (!childSessionId || !parentSessionId) {
      return res.status(400).json({
        success: false,
        error: 'ValidationError',
        message: 'childSessionId and parentSessionId are required',
        timestamp: new Date().toISOString()
      });
    }

    const relation = orchestratorModule.subSessions.registerSubSession(
      childSessionId,
      parentSessionId,
      { taskToolId }
    );

    res.json({
      success: true,
      subsession: relation,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// POST /api/subsessions/:childId/force-return - Force return result to parent
app.post('/api/subsessions/:childId/force-return', authMiddleware, async (req, res) => {
  try {
    const { childId } = req.params;
    const result = await orchestratorModule.subSessions.forceReturn(childId);

    res.json({
      success: true,
      result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// DELETE /api/subsessions/:childId - Unregister a subsession
app.delete('/api/subsessions/:childId', authMiddleware, async (req, res) => {
  try {
    const { childId } = req.params;
    const archiveSession = req.query.archive === 'true';

    await orchestratorModule.subSessions.unregister(childId, { archiveSession });

    res.json({
      success: true,
      message: 'SubSession unregistered',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// GET /api/subsessions/parent/:parentId - Get all children for a parent
app.get('/api/subsessions/parent/:parentId', authMiddleware, async (req, res) => {
  try {
    const { parentId } = req.params;
    const children = orchestratorModule.subSessions.getChildren(parentId);

    res.json({
      success: true,
      parentSessionId: parentId,
      children: children.map(r => ({
        childSessionId: r.childSessionId,
        status: r.status,
        messageCount: r.messageCount,
        lastActivityAt: r.lastActivityAt
      })),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// POST /api/subsessions/cleanup - Cleanup old/orphaned subsessions
app.post('/api/subsessions/cleanup', authMiddleware, async (req, res) => {
  try {
    const maxAge = req.body.maxAge || 3600000; // 1 hour default
    const result = await orchestratorModule.subSessions.cleanup({ maxAge });

    res.json({
      success: true,
      result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// POST /api/subsessions/start-monitoring - Start subsession monitoring
app.post('/api/subsessions/start-monitoring', authMiddleware, async (req, res) => {
  try {
    orchestratorModule.subSessions.startMonitoring();

    res.json({
      success: true,
      message: 'Monitoring started',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// POST /api/subsessions/stop-monitoring - Stop subsession monitoring
app.post('/api/subsessions/stop-monitoring', authMiddleware, async (req, res) => {
  try {
    orchestratorModule.subSessions.stopMonitoring();

    res.json({
      success: true,
      message: 'Monitoring stopped',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// POST /api/subsessions/watch/:parentId - Watch a parent session for Task spawns
app.post('/api/subsessions/watch/:parentId', authMiddleware, async (req, res) => {
  try {
    const { parentId } = req.params;

    await orchestratorModule.subSessions.watchParentSession(parentId);

    res.json({
      success: true,
      message: `Now watching parent session: ${parentId}`,
      pendingSpawns: orchestratorModule.subSessions.pendingTaskSpawns.size,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// POST /api/subsessions/scan/:parentId - Scan parent session for Task tool invocations
app.post('/api/subsessions/scan/:parentId', authMiddleware, async (req, res) => {
  try {
    const { parentId } = req.params;

    const taskInvocations = await orchestratorModule.subSessions.scanForTaskSpawns(parentId);

    res.json({
      success: true,
      parentSessionId: parentId,
      taskInvocations,
      pendingSpawns: orchestratorModule.subSessions.pendingTaskSpawns.size,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// POST /api/subsessions/auto-detect - Trigger auto-detection of new sessions
app.post('/api/subsessions/auto-detect', authMiddleware, async (req, res) => {
  try {
    const linkedCount = await orchestratorModule.subSessions.autoDetectNewSessions();

    res.json({
      success: true,
      linkedCount,
      totalSubSessions: orchestratorModule.subSessions.relations.size,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'InternalError',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ============================================================================
// Fin des routes orchestrateur
// ============================================================================

// Servir l'application web
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// WebSocket pour les mises à jour en temps réel
const wss = new WebSocket.Server({ server });

// Diffuser un message à tous les clients WebSocket connectés
function broadcastToClients(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// Event listeners pour sessionManager supprimés - CDP gère les mises à jour via WebSocket

// Écouter les événements du tracker d'usage
usageTracker.on('usage-updated', (usage) => {
  broadcastToClients({
    type: 'usage-updated',
    usage: usage,
    timestamp: new Date().toISOString()
  });
});

// Event listeners pour permissionManager supprimés - CDP gère les permissions via WebSocket

// Ecouter les evenements du gestionnaire de PIN
pinManager.on('ip-blocked', (data) => {
  console.log(`[SECURITE] IP bloquee: ${data.ip} apres ${data.attempts} tentatives`);
  broadcastToClients({
    type: 'security-ip-blocked',
    ip: data.ip,
    attempts: data.attempts,
    timestamp: new Date().toISOString()
  });
});

pinManager.on('security-alert', (data) => {
  console.log(`[SECURITE ALERTE] ${data.distinctIPs} IPs differentes ont echoue (${data.totalAttempts} tentatives totales)`);
  if (data.lockdownActivated) {
    console.log('[SECURITE] VERROUILLAGE GLOBAL ACTIVE - Nouvelles connexions bloquees');
  }
  broadcastToClients({
    type: 'security-alert',
    alertType: data.type,
    distinctIPs: data.distinctIPs,
    totalAttempts: data.totalAttempts,
    lockdownActivated: data.lockdownActivated || false,
    timestamp: new Date().toISOString()
  });
});

pinManager.on('global-lockdown', (data) => {
  console.log(`[SECURITE] VERROUILLAGE GLOBAL: ${data.reason}`);
  broadcastToClients({
    type: 'global-lockdown',
    reason: data.reason,
    message: 'Le serveur est en mode verrouillage. Seules les sessions deja authentifiees restent actives.',
    timestamp: new Date().toISOString()
  });
});

pinManager.on('login-failed', (data) => {
  broadcastToClients({
    type: 'security-login-failed',
    ip: data.ip,
    attemptsRemaining: data.attemptsRemaining,
    timestamp: new Date().toISOString()
  });
});

// Ecouter les evenements de l'injecteur de commandes
commandInjector.on('injection-started', (data) => {
  console.log(`[CommandInjector] Injection demarree: ${data.command.substring(0, 30)}...`);
  broadcastToClients({
    type: 'injection-started',
    sessionId: data.sessionId,
    command: data.command,
    timestamp: data.timestamp
  });
});

commandInjector.on('injection-success', (data) => {
  console.log(`[CommandInjector] Injection reussie via ${data.result.method}`);
  broadcastToClients({
    type: 'injection-success',
    sessionId: data.sessionId,
    command: data.command,
    method: data.result.method,
    duration: data.duration,
    timestamp: new Date().toISOString()
  });
});

commandInjector.on('injection-failed', (data) => {
  console.log(`[CommandInjector] Injection echouee: ${data.result.error}`);
  broadcastToClients({
    type: 'injection-failed',
    sessionId: data.sessionId,
    command: data.command,
    method: data.result.method,
    error: data.result.error,
    duration: data.duration,
    timestamp: new Date().toISOString()
  });
});

commandInjector.on('injection-error', (data) => {
  console.error(`[CommandInjector] Erreur d'injection: ${data.error}`);
  broadcastToClients({
    type: 'injection-error',
    sessionId: data.sessionId,
    command: data.command,
    error: data.error,
    timestamp: new Date().toISOString()
  });
});

commandInjector.on('command-queued', (data) => {
  broadcastToClients({
    type: 'command-queued',
    sessionId: data.sessionId,
    item: data.item,
    timestamp: new Date().toISOString()
  });
});

// Écouter les événements du moniteur CDP
cdpMonitor.on('connections-detected', (data) => {
  broadcastToClients({
    type: 'cdp-connections-detected',
    count: data.count,
    connections: data.connections,
    timestamp: data.timestamp.toISOString()
  });
});

cdpMonitor.on('connection-count-changed', (data) => {
  console.log(`[CDPMonitor] Connexions: ${data.previous} -> ${data.current}`);
  broadcastToClients({
    type: 'cdp-connection-count-changed',
    previous: data.previous,
    current: data.current,
    connections: data.connections,
    timestamp: data.timestamp.toISOString()
  });
});

cdpMonitor.on('new-connection', (data) => {
  console.log(`[CDPMonitor] Nouvelle connexion détectée! Count: ${data.count}`);
  broadcastToClients({
    type: 'cdp-new-connection',
    count: data.count,
    connections: data.connections,
    timestamp: data.timestamp.toISOString()
  });
});

// Ecouter les evenements de l'orchestrateur (Big Tasks)
orchestratorModule.on('orchestrator:created', (data) => {
  console.log(`[Orchestrator] Created: ${data.id}`);
  broadcastToClients({
    type: 'orchestrator:created',
    data: data,
    timestamp: new Date().toISOString()
  });
});

orchestratorModule.on('orchestrator:started', (data) => {
  console.log(`[Orchestrator] Started: ${data.id}`);
  broadcastToClients({
    type: 'orchestrator:started',
    data: data,
    timestamp: new Date().toISOString()
  });
});

orchestratorModule.on('orchestrator:phaseChanged', (data) => {
  console.log(`[Orchestrator] Phase changed: ${data.id} -> ${data.currentPhase}`);
  broadcastToClients({
    type: 'orchestrator:phaseChanged',
    data: data,
    timestamp: new Date().toISOString()
  });
});

orchestratorModule.on('orchestrator:analysisComplete', (data) => {
  console.log(`[Orchestrator] Analysis complete: ${data.id}`);
  broadcastToClients({
    type: 'orchestrator:analysisComplete',
    data: data,
    timestamp: new Date().toISOString()
  });
});

orchestratorModule.on('orchestrator:tasksReady', (data) => {
  console.log(`[Orchestrator] Tasks ready: ${data.id} (${data.taskCount} tasks)`);
  broadcastToClients({
    type: 'orchestrator:tasksReady',
    data: data,
    timestamp: new Date().toISOString()
  });
});

orchestratorModule.on('orchestrator:progress', (data) => {
  broadcastToClients({
    type: 'orchestrator:progress',
    data: data,
    timestamp: new Date().toISOString()
  });
});

orchestratorModule.on('orchestrator:completed', (data) => {
  console.log(`[Orchestrator] Completed: ${data.id}`);
  broadcastToClients({
    type: 'orchestrator:completed',
    data: data,
    timestamp: new Date().toISOString()
  });
});

orchestratorModule.on('orchestrator:error', (data) => {
  console.error(`[Orchestrator] Error: ${data.id} - ${data.error}`);
  broadcastToClients({
    type: 'orchestrator:error',
    data: data,
    timestamp: new Date().toISOString()
  });
});

orchestratorModule.on('orchestrator:cancelled', (data) => {
  console.log(`[Orchestrator] Cancelled: ${data.id}`);
  broadcastToClients({
    type: 'orchestrator:cancelled',
    data: data,
    timestamp: new Date().toISOString()
  });
});

orchestratorModule.on('orchestrator:paused', (data) => {
  console.log(`[Orchestrator] Paused: ${data.id}`);
  broadcastToClients({
    type: 'orchestrator:paused',
    data: data,
    timestamp: new Date().toISOString()
  });
});

orchestratorModule.on('orchestrator:resumed', (data) => {
  console.log(`[Orchestrator] Resumed: ${data.id}`);
  broadcastToClients({
    type: 'orchestrator:resumed',
    data: data,
    timestamp: new Date().toISOString()
  });
});

// Worker events
orchestratorModule.on('worker:spawned', (data) => {
  console.log(`[Worker] Spawned: ${data.taskId} (${data.sessionId})`);
  broadcastToClients({
    type: 'worker:spawned',
    data: data,
    timestamp: new Date().toISOString()
  });
});

orchestratorModule.on('worker:progress', (data) => {
  broadcastToClients({
    type: 'worker:progress',
    data: data,
    timestamp: new Date().toISOString()
  });
});

orchestratorModule.on('worker:completed', (data) => {
  console.log(`[Worker] Completed: ${data.taskId}`);
  broadcastToClients({
    type: 'worker:completed',
    data: data,
    timestamp: new Date().toISOString()
  });
});

orchestratorModule.on('worker:failed', (data) => {
  console.error(`[Worker] Failed: ${data.taskId} - ${data.error}`);
  broadcastToClients({
    type: 'worker:failed',
    data: data,
    timestamp: new Date().toISOString()
  });
});

orchestratorModule.on('worker:timeout', (data) => {
  console.warn(`[Worker] Timeout: ${data.taskId}`);
  broadcastToClients({
    type: 'worker:timeout',
    data: data,
    timestamp: new Date().toISOString()
  });
});

orchestratorModule.on('worker:cancelled', (data) => {
  console.log(`[Worker] Cancelled: ${data.taskId}`);
  broadcastToClients({
    type: 'worker:cancelled',
    data: data,
    timestamp: new Date().toISOString()
  });
});

// SubSession events
orchestratorModule.on('subsession:registered', (data) => {
  console.log(`[SubSession] Registered: ${data.childSessionId} -> parent: ${data.parentSessionId}`);
  broadcastToClients({
    type: 'subsession:registered',
    data: data,
    timestamp: new Date().toISOString()
  });
});

orchestratorModule.on('subsession:statusChanged', (data) => {
  console.log(`[SubSession] Status changed: ${data.childSessionId} ${data.previousStatus} -> ${data.newStatus}`);
  broadcastToClients({
    type: 'subsession:statusChanged',
    data: data,
    timestamp: new Date().toISOString()
  });
});

orchestratorModule.on('subsession:activity', (data) => {
  // Don't log every activity to avoid spam
  broadcastToClients({
    type: 'subsession:activity',
    data: data,
    timestamp: new Date().toISOString()
  });
});

orchestratorModule.on('subsession:resultReturned', (data) => {
  console.log(`[SubSession] Result returned: ${data.childSessionId} -> ${data.parentSessionId}`);
  broadcastToClients({
    type: 'subsession:resultReturned',
    data: data,
    timestamp: new Date().toISOString()
  });
});

orchestratorModule.on('subsession:orphaned', (data) => {
  console.warn(`[SubSession] Orphaned: ${data.childSessionId} (parent: ${data.parentSessionId})`);
  broadcastToClients({
    type: 'subsession:orphaned',
    data: data,
    timestamp: new Date().toISOString()
  });
});

orchestratorModule.on('subsession:error', (data) => {
  console.error(`[SubSession] Error: ${data.childSessionId} - ${data.error}`);
  broadcastToClients({
    type: 'subsession:error',
    data: data,
    timestamp: new Date().toISOString()
  });
});

orchestratorModule.on('subsession:archived', (data) => {
  console.log(`[SubSession] Archived: ${data.childSessionId}`);
  broadcastToClients({
    type: 'subsession:archived',
    data: data,
    timestamp: new Date().toISOString()
  });
});

orchestratorModule.on('subsession:monitoring:started', (data) => {
  console.log('[SubSession] Monitoring started');
  broadcastToClients({
    type: 'subsession:monitoring:started',
    data: data,
    timestamp: new Date().toISOString()
  });
});

orchestratorModule.on('subsession:monitoring:stopped', (data) => {
  console.log('[SubSession] Monitoring stopped');
  broadcastToClients({
    type: 'subsession:monitoring:stopped',
    data: data,
    timestamp: new Date().toISOString()
  });
});

// Heartbeat interval pour détecter les connexions mortes
const WS_HEARTBEAT_INTERVAL = 30000; // 30 secondes

wss.on('connection', (ws, req) => {
  // Authentication check for WebSocket
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  const ip = pinManager.getClientIP(req);

  // Verify session token if PIN is enabled
  if (pinManager.isPinEnabled()) {
    if (!token || !pinManager.isSessionValid(token, ip)) {
      console.log(`[WebSocket] Rejected connection from ${ip} - invalid or missing token`);
      ws.close(4001, 'Unauthorized - Invalid or missing session token');
      return;
    }
    console.log(`[WebSocket] Authenticated connection from ${ip}`);
  } else {
    console.log(`[WebSocket] Connection from ${ip} (no auth required)`);
  }

  // Marquer la connexion comme vivante
  ws.isAlive = true;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      // Gérer le ping/pong pour le heartbeat
      if (data.type === 'ping') {
        ws.isAlive = true;
        ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
        return;
      }

      if (data.type === 'pong') {
        ws.isAlive = true;
        return;
      }

      console.log('Message reçu:', data);
    } catch (e) {
      console.log('Message non-JSON reçu:', message.toString());
    }
  });

  ws.on('close', () => {
    console.log('Client WebSocket déconnecté');
  });

  ws.on('error', (error) => {
    console.error('Erreur WebSocket client:', error.message);
  });

  // Envoyer un message de bienvenue
  ws.send(JSON.stringify({
    type: 'connected',
    message: 'Connecte au serveur ClaudeCode_Remote',
    pinEnabled: pinManager.isPinEnabled(),
    timestamp: new Date().toISOString()
  }));

  // Envoyer l'usage actuel
  ws.send(JSON.stringify({
    type: 'usage-updated',
    usage: usageTracker.getCurrentUsage(),
    timestamp: new Date().toISOString()
  }));

  // Sessions et permissions sont désormais chargées via CDP par le frontend
});

// Heartbeat: vérifier périodiquement les connexions WebSocket mortes
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('Terminaison connexion WebSocket inactive');
      return ws.terminate();
    }

    ws.isAlive = false;
    // Envoyer un ping au client
    try {
      ws.send(JSON.stringify({ type: 'ping', timestamp: new Date().toISOString() }));
    } catch (e) {
      // Ignorer les erreurs d'envoi
    }
  });
}, WS_HEARTBEAT_INTERVAL);

// Nettoyer le heartbeat à l'arrêt
wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

// Endpoint pour arrêter le serveur proprement (depuis l'interface web)
app.post('/api/shutdown', authMiddleware, (req, res) => {
  console.log('\n🛑 Demande d\'arrêt reçue depuis l\'interface web');

  res.json({
    success: true,
    message: 'Serveur en cours d\'arrêt...'
  });

  // Arrêter proprement après avoir envoyé la réponse
  setTimeout(() => {
    console.log('👋 Arrêt du serveur...');

    // Fermer toutes les connexions WebSocket
    wss.clients.forEach((ws) => {
      try {
        ws.send(JSON.stringify({ type: 'shutdown', message: 'Le serveur s\'arrête' }));
        ws.close();
      } catch (e) {
        // Ignorer les erreurs
      }
    });

    // Fermer le serveur WebSocket
    wss.close(() => {
      console.log('✓ WebSocket fermé');
    });

    // Fermer la connexion CDP persistante
    cdpController.closeConnection();
    console.log('✓ Connexion CDP fermée');

    // Arrêter le moniteur CDP
    cdpMonitor.stop();
    console.log('✓ Moniteur CDP arrêté');

    // Fermer le serveur HTTP
    server.close(() => {
      console.log('✓ Serveur HTTP fermé');
      console.log('✓ Arrêt terminé\n');
      process.exit(0);
    });

    // Forcer l'arrêt après 5 secondes si la fermeture propre échoue
    setTimeout(() => {
      console.log('⚠ Forçage de l\'arrêt...');
      process.exit(0);
    }, 5000);
  }, 500);
});

// Démarrer le serveur
server.listen(PORT, async () => {
  const pinStatus = pinManager.isPinEnabled() ? 'ACTIVE (PIN requis)' : 'DESACTIVE';

  console.log(`
╔══════════════════════════════════════════════════════════╗
║  ClaudeCode_Remote v1.1                                  ║
╠══════════════════════════════════════════════════════════╣
║  Serveur demarre sur le port ${PORT}                        ║
║  URL: http://localhost:${PORT}                              ║
║  API: http://localhost:${PORT}/api/health                   ║
║  WebSocket: ws://localhost:${PORT}                          ║
╠══════════════════════════════════════════════════════════╣
║  Securite PIN: ${pinStatus.padEnd(38)}║
╚══════════════════════════════════════════════════════════╝
  `);

  if (process.env.DEBUG === 'true') {
    console.log('Mode DEBUG activé');
    console.log('Dossier Claude:', CLAUDE_DIR);
  }

  // Gestionnaire de sessions supprimé - utilise CDP uniquement
  console.log('✓ Mode CDP-only actif');

  // Initialiser le tracker d'usage
  try {
    await usageTracker.initialize();
    console.log('✓ Tracker d\'usage initialisé');
  } catch (error) {
    console.error('✗ Erreur lors de l\'initialisation du tracker:', error.message);
  }

  // Démarrer le moniteur de connexions CDP
  try {
    cdpMonitor.start();
    console.log('✓ Moniteur de connexions CDP démarré (port 9222)');
  } catch (error) {
    console.error('✗ Erreur lors du démarrage du moniteur CDP:', error.message);
  }

  // Initialiser le module d'orchestration
  try {
    await orchestratorModule.initialize();
    console.log('✓ Module d\'orchestration initialisé');
  } catch (error) {
    console.error('✗ Erreur lors de l\'initialisation de l\'orchestrateur:', error.message);
  }
});

// Gestion des erreurs
process.on('uncaughtException', (error) => {
  console.error('Erreur non gérée:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Promise rejetée non gérée:', reason);
});

// Gestion propre de l'arrêt (Ctrl+C, kill, etc.)
process.on('SIGINT', () => {
  console.log('\n🛑 Signal SIGINT reçu, arrêt propre...');
  cdpMonitor.stop();
  cdpController.closeConnection();
  wss.close();
  server.close(() => {
    console.log('✓ Arrêt terminé');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Signal SIGTERM reçu, arrêt propre...');
  cdpMonitor.stop();
  cdpController.closeConnection();
  wss.close();
  server.close(() => {
    console.log('✓ Arrêt terminé');
    process.exit(0);
  });
});

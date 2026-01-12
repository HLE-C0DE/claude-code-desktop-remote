// ============================================================================
// i18n Helper
// ============================================================================

// Fonction helper pour traduire facilement dans app.js
function t(key, replacements = {}) {
  return window.i18n ? window.i18n.t(key, replacements) : key.split('.').pop();
}

// Configuration
const API_BASE = window.location.origin;
const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = `${WS_PROTOCOL}//${window.location.host}`;
let ws = null;

// SÉCURITÉ: Effacement forcé des tokens au chargement pour forcer ré-authentification
// Cela empêche les bypasses via tokens persistants dans localStorage
if (localStorage.getItem('authToken') || localStorage.getItem('sessionToken')) {
  console.log('[Security] Effacement tokens au chargement pour ré-authentification');
  localStorage.removeItem('authToken');
  localStorage.removeItem('sessionToken');
}

let authToken = '';  // Plus de lecture depuis localStorage
let sessionToken = '';  // Plus de lecture depuis localStorage

let sessions = {};
let currentUsage = null;
let usageWidgetExpanded = false;
let usageAutoRefreshInterval = null;
const USAGE_AUTO_REFRESH_MS = 5 * 60 * 1000; // Auto-refresh toutes les 5 minutes

// Authentification PIN
let pinRequired = false;
let isAuthenticated = false;

// État des sections rétractables
let inactiveSessionsExpanded = false;

// Gestion des permissions
let pendingPermissions = []; // Demandes d'autorisation en attente
let permissionTimers = {}; // Timers pour le countdown

// Gestion des questions (AskUserQuestion)
let pendingQuestions = []; // Questions en attente

// État pour le rendu incrémental (évite le scintillement)
let currentRenderedSession = null; // ID de la session actuellement rendue
let currentRenderedMessageCount = 0; // Nombre de messages rendus
let lastTodosHash = null; // Hash des dernières tâches affichées (évite re-render inutile)
let lastKnownToolUse = null; // Dernier outil utilisé connu
let lastKnownAssistantText = null; // Dernier texte assistant connu

// Polling pour les sessions CDP en mode "thinking"
let sessionPollingInterval = null;
const SESSION_POLLING_MS = 3000; // Polling toutes les 3 secondes quand Claude travaille
const SESSION_POLLING_BURST_MS = 1000; // Polling rapide (1000ms) pendant le démarrage - optimisé pour réduire la charge
let sessionPollingBurstCount = 0; // Compteur pour le burst rapide
const SESSION_POLLING_BURST_MAX = 10; // 10 polls rapides = 10 secondes de burst
let sessionPollingIdleCount = 0; // Compteur pour continuer le polling même en idle
const SESSION_POLLING_IDLE_MAX = 20; // Après 20 cycles idle, passer en mode slow
const SESSION_POLLING_SLOW_MS = 60000; // Polling 1x par minute en mode slow
let sessionPollingSlowMode = false; // Mode slow activé après idle prolongé

// OPTIMISATION: Détection de changement pour backoff intelligent
let lastSessionHash = null;
let sessionNoChangeCount = 0;
const SESSION_NO_CHANGE_MAX = 5; // Après 5 polls sans changement, augmenter le délai

// Polling pour les permissions CDP (ne passent par WebSocket)
let permissionPollingInterval = null;
const PERMISSION_POLLING_MS = 3000; // Polling toutes les 3 secondes pour les permissions - optimisé pour réduire la charge

// Smart polling: réduit la fréquence quand rien ne change
let lastPermissionsHash = null;
let permissionNoChangeCount = 0;
const PERMISSION_POLLING_MAX_MS = 8000; // Max 8 secondes entre les polls si rien ne change - augmenté pour backoff plus agressif

// WebSocket heartbeat
let wsHeartbeatInterval = null;
let wsReconnectAttempts = 0;
const WS_HEARTBEAT_MS = 30000; // Ping toutes les 30 secondes
const WS_RECONNECT_DELAY_BASE = 2000; // Délai de base pour reconnexion

// Gestion des chemins favoris et récents pour nouvelle session
const RECENT_PATHS_KEY = 'claudeRemote_recentPaths';
const FAVORITE_PATHS_KEY = 'claudeRemote_favoritePaths';
const MAX_RECENT_PATHS = 10;

// Debug: Log des événements thinking pour analyse
let thinkingDebugLog = [];
const MAX_DEBUG_LOG_ENTRIES = 500;

// Compteur de connexions CDP
let cdpConnectionCount = 0;
let cdpConnections = [];
let cdpMonitorStats = null;

// Éléments DOM
const statusIndicator = document.getElementById('status');
const statusText = document.getElementById('status-text');
const appContent = document.getElementById('app-content');
const backBtn = document.getElementById('back-btn');

// ============================================================================
// WebSocket et Connexion
// ============================================================================

function updateStatus(connected) {
  if (connected) {
    statusIndicator.className = 'status-indicator connected';
    statusText.textContent = window.i18n ? window.i18n.t('app.connected') : 'Connecté';
  } else {
    statusIndicator.className = 'status-indicator disconnected';
    statusText.textContent = window.i18n ? window.i18n.t('app.disconnected') : 'Déconnecté';
  }
}

function connectWebSocket() {
  // SÉCURITÉ: Bloquer connexion WebSocket si PIN requis mais non authentifié
  if (pinRequired && !isAuthenticated) {
    console.log('[WebSocket] Connexion bloquée - authentification PIN requise');
    return;
  }

  // Fermer proprement l'ancien WebSocket s'il existe
  if (ws) {
    // Supprimer les handlers pour éviter les callbacks indésirables
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    ws.onopen = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }

  // Nettoyer l'ancien heartbeat
  if (wsHeartbeatInterval) {
    clearInterval(wsHeartbeatInterval);
    wsHeartbeatInterval = null;
  }

  // SÉCURITÉ: Utiliser la variable globale sessionToken, PAS le localStorage
  // Le localStorage a été effacé au chargement pour forcer ré-authentification
  const wsUrlWithAuth = sessionToken ? `${WS_URL}?token=${encodeURIComponent(sessionToken)}` : WS_URL;
  ws = new WebSocket(wsUrlWithAuth);

  ws.onopen = () => {
    console.log('WebSocket connecté');
    updateStatus(true);
    wsReconnectAttempts = 0;

    // Démarrer le heartbeat
    startHeartbeat();

    // Recharger les données à la reconnexion
    reloadAllData();
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      // Répondre au ping du serveur
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      // Ignorer les pong
      if (data.type === 'pong') {
        return;
      }

      handleWebSocketMessage(data);
    } catch (e) {
      console.error('Erreur de parsing WebSocket:', e);
    }
  };

  ws.onerror = (error) => {
    console.error('Erreur WebSocket:', error);
    updateStatus(false);
  };

  ws.onclose = () => {
    console.log('WebSocket déconnecté');
    updateStatus(false);

    // Arrêter le heartbeat
    if (wsHeartbeatInterval) {
      clearInterval(wsHeartbeatInterval);
      wsHeartbeatInterval = null;
    }

    // Reconnexion avec backoff exponentiel
    wsReconnectAttempts++;
    const delay = Math.min(WS_RECONNECT_DELAY_BASE * Math.pow(1.5, wsReconnectAttempts), 30000);
    console.log(`Reconnexion dans ${delay}ms (tentative ${wsReconnectAttempts})`);

    showReconnectingStatus();
    setTimeout(connectWebSocket, delay);
  };
}

function startHeartbeat() {
  wsHeartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, WS_HEARTBEAT_MS);
}

async function reloadAllData() {
  // Ne pas recharger si pas authentifie
  if (!isAuthenticated) {
    console.log('Rechargement ignore - non authentifie');
    return;
  }

  console.log('Rechargement des données après reconnexion...');
  try {
    // Recharger les sessions, l'usage et les favoris en parallèle
    await Promise.all([
      loadSessions(),
      loadUsage(),
      loadPendingPermissions(),
      loadFavorites(),
      loadCDPMonitorStats()
    ]);

    // Rafraîchir la vue actuelle
    handleRouteChange();
    console.log('Données rechargées avec succès');
  } catch (error) {
    console.error('Erreur lors du rechargement des données:', error);
  }
}

async function loadPendingPermissions() {
  try {
    const data = await apiRequest('/api/permission/pending');
    const requests = data.pending || data.requests || [];

    // Nettoyer les permissions qui ne sont plus dans la liste (ont été résolues)
    const currentIds = new Set(requests.map(r => r.id));
    const removedPermissions = pendingPermissions.filter(p => !currentIds.has(p.id));
    removedPermissions.forEach(p => {
      console.log('[Permission] Permission résolue (disparue du serveur):', p.id);
      hidePermissionModal(p.id);
    });
    pendingPermissions = pendingPermissions.filter(p => currentIds.has(p.id));

    // Ajouter les nouvelles permissions
    if (requests.length > 0) {
      requests.forEach(req => {
        if (!pendingPermissions.find(p => p.id === req.id)) {
          pendingPermissions.push(req);
          console.log('[Permission] Nouvelle permission:', req.toolName, req.source || 'hook');
          // Jouer un son et vibrer pour les nouvelles permissions
          playNotificationSound();
          if (navigator.vibrate) {
            navigator.vibrate([200, 100, 200]);
          }
        }
      });
    }

    // Afficher la première permission si disponible et pas déjà affichée
    if (pendingPermissions.length > 0) {
      const modal = document.getElementById('permission-modal');
      if (!modal) {
        showPermissionModal(pendingPermissions[0]);
      }
      renderPermissionBadge();
    } else {
      renderPermissionBadge();
    }
  } catch (error) {
    console.error('Erreur lors du chargement des permissions:', error);
  }
}

// Charger les questions en attente (AskUserQuestion)
async function loadPendingQuestions() {
  try {
    const data = await apiRequest('/api/question/pending');
    const questions = data.pending || [];

    // Nettoyer les questions résolues
    const currentIds = new Set(questions.map(q => q.id));
    const removedQuestions = pendingQuestions.filter(q => !currentIds.has(q.id));
    removedQuestions.forEach(q => {
      console.log('[Question] Question résolue:', q.id);
      hideQuestionModal(q.id);
    });
    pendingQuestions = pendingQuestions.filter(q => currentIds.has(q.id));

    // Ajouter les nouvelles questions
    if (questions.length > 0) {
      questions.forEach(q => {
        if (!pendingQuestions.find(pq => pq.id === q.id)) {
          pendingQuestions.push(q);
          console.log('[Question] Nouvelle question:', q.id);
          playNotificationSound();
          if (navigator.vibrate) {
            navigator.vibrate([200, 100, 200]);
          }
        }
      });
    }

    // Afficher la première question si pas de modal permission/question affiché
    if (pendingQuestions.length > 0) {
      const permModal = document.getElementById('permission-modal');
      const qModal = document.getElementById('question-modal');
      if (!permModal && !qModal) {
        showQuestionModal(pendingQuestions[0]);
      }
    }
  } catch (error) {
    console.error('Erreur lors du chargement des questions:', error);
  }
}

// Démarrer le polling des permissions et questions CDP avec smart polling
function startPermissionPolling() {
  if (permissionPollingInterval) return; // Déjà en cours

  console.log('[Permission/Question] Démarrage du polling CDP (smart polling)');

  // Fonction pour calculer le délai dynamique
  const getPollingDelay = () => {
    // Si un modal est affiché, polling rapide (1s) pour détecter les résolutions externes
    const permModal = document.getElementById('permission-modal');
    const qModal = document.getElementById('question-modal');
    if (permModal || qModal) {
      return 1000; // 1 seconde quand modal affiché
    }
    // Si rien n'a changé depuis plusieurs polls, augmenter l'intervalle progressivement
    if (permissionNoChangeCount > 5) {
      return Math.min(PERMISSION_POLLING_MS * (1 + (permissionNoChangeCount - 5) * 0.3), PERMISSION_POLLING_MAX_MS);
    }
    return PERMISSION_POLLING_MS;
  };

  // Fonction de polling récursive avec délai dynamique
  const poll = async () => {
    if (!isAuthenticated) {
      permissionPollingInterval = setTimeout(poll, getPollingDelay());
      return;
    }

    try {
      // Charger les permissions et questions en parallèle
      const oldPermHash = JSON.stringify(pendingPermissions.map(p => p.id).sort());
      const oldQHash = JSON.stringify(pendingQuestions.map(q => q.id).sort());

      await Promise.all([
        loadPendingPermissions(),
        loadPendingQuestions()
      ]);

      // Calculer les nouveaux hash
      const newPermHash = JSON.stringify(pendingPermissions.map(p => p.id).sort());
      const newQHash = JSON.stringify(pendingQuestions.map(q => q.id).sort());

      if (oldPermHash === newPermHash && oldQHash === newQHash) {
        permissionNoChangeCount++;
      } else {
        permissionNoChangeCount = 0; // Reset si changement
      }
    } catch (error) {
      console.error('[Permission/Question] Erreur polling:', error);
    }

    // Planifier le prochain poll avec délai dynamique
    const delay = getPollingDelay();
    permissionPollingInterval = setTimeout(poll, delay);
  };

  // Démarrer le polling
  permissionPollingInterval = setTimeout(poll, PERMISSION_POLLING_MS);
}

// Arrêter le polling des permissions
function stopPermissionPolling() {
  if (permissionPollingInterval) {
    console.log('[Permission] Arrêt du polling CDP');
    clearTimeout(permissionPollingInterval);  // clearTimeout au lieu de clearInterval
    permissionPollingInterval = null;
  }
  permissionNoChangeCount = 0;
}

function showReconnectingStatus() {
  statusIndicator.className = 'status-indicator reconnecting';
  statusText.textContent = window.i18n ? window.i18n.t('app.reconnecting') : 'Reconnexion...';
}

function handleWebSocketMessage(data) {
  console.log('Message WebSocket:', data);

  // Autoriser uniquement les evenements de securite si pas authentifie
  const securityEvents = ['security-ip-blocked', 'security-alert', 'security-login-failed', 'connected'];
  if (!isAuthenticated && !securityEvents.includes(data.type)) {
    return;
  }

  switch (data.type) {
    case 'connected':
      console.log('Connecté au serveur');
      break;

    case 'sessions-list':
      // Ignorer sessions-list si on a déjà des données CDP
      // (évite le race condition où WebSocket envoie des données file-based
      // alors que l'API a déjà chargé les sessions CDP plus récentes)
      if (Object.keys(sessions).length === 0) {
        data.sessions.forEach(session => {
          sessions[session.id] = session;
        });
        if (getCurrentRoute() === 'home') {
          renderHomePage();
        }
      }
      break;

    // OBSOLETE: Ces événements ne sont plus envoyés par le backend CDP
    // Les sessions sont maintenant gérées via polling et rechargement manuel
    // case 'session-added':
    // case 'session-updated':
    // case 'session-deleted':

    case 'usage-updated':
      currentUsage = data.usage;
      if (getCurrentRoute() === 'home') {
        renderUsageWidget();
      }
      break;

    // OBSOLETE: Ces événements ne sont plus envoyés par le backend CDP
    // Les permissions sont maintenant gérées via polling (loadPendingPermissions)
    // case 'permission-requested':
    // case 'permissions-pending':
    // case 'permission-responded': (remplacé par cdp-permission-responded)
    // case 'permission-timeout':
    // case 'permission-cancelled':

    // Evenements de securite PIN
    case 'security-ip-blocked':
    case 'security-alert':
    case 'security-login-failed':
      handleSecurityWebSocketEvents(data);
      break;

    // Evenements d'injection de commandes
    case 'injection-started':
      handleInjectionStarted(data);
      break;

    case 'injection-success':
      handleInjectionSuccess(data);
      break;

    case 'injection-failed':
      handleInjectionFailed(data);
      break;

    case 'injection-error':
      handleInjectionError(data);
      break;

    case 'message-injected':
      handleMessageInjected(data);
      break;

    case 'cdp-session-switched':
      handleCDPSessionSwitched(data);
      break;

    case 'cdp-permission-responded':
      handlePermissionResponded(data.requestId, data.decision === 'once' || data.decision === 'always');
      break;

    // Événements du moniteur de connexions CDP
    case 'cdp-connections-detected':
    case 'cdp-connection-count-changed':
      handleCDPConnectionUpdate(data);
      break;

    case 'cdp-new-connection':
      handleNewCDPConnection(data);
      break;
  }
}

// ============================================================================
// Injection Event Handlers
// ============================================================================

function handleInjectionStarted(data) {
  console.log('[Injection] Demarree:', data.command?.substring(0, 30));
  showInjectionNotification('Envoi en cours...', 'info');
}

function handleInjectionSuccess(data) {
  console.log('[Injection] Reussie via', data.method);
  showInjectionNotification(`Message envoye via ${data.method}`, 'success');
}

function handleInjectionFailed(data) {
  console.log('[Injection] Echouee:', data.error);
  showInjectionNotification(`Echec: ${data.error}`, 'error');
}

function handleInjectionError(data) {
  console.error('[Injection] Erreur:', data.error);
  showInjectionNotification(`Erreur: ${data.error}`, 'error');
}

function handleMessageInjected(data) {
  console.log('[Injection] Message injecte dans session', data.sessionId);
  // Recharger la session si on est dessus
  if (getCurrentRoute() === 'session' && getCurrentSessionId() === data.sessionId) {
    loadSessionDetail(data.sessionId);
  }
}

function handleCDPSessionSwitched(data) {
  console.log('[CDP] Session changee vers', data.sessionId);
  // Recharger la liste des sessions pour mettre a jour isCurrent
  loadSessions();
  // Si on est sur la page session, rediriger vers la nouvelle session active
  if (getCurrentRoute() === 'session') {
    goToSession(data.sessionId);
  }
}

// ============================================================================
// CDP Monitor Event Handlers
// ============================================================================

function handleCDPConnectionUpdate(data) {
  cdpConnectionCount = data.current || data.count || 0;
  cdpConnections = data.connections || [];
  // Log simplifié : affiche seulement le count et les types de connexions
  const types = cdpConnections.map(c => c.type || 'unknown').join(', ');
  console.log(`[CDPMonitor] ${cdpConnectionCount} connexion(s) active(s) [${types}]`);
  updateCDPConnectionDisplay();
}

function handleNewCDPConnection(data) {
  cdpConnectionCount = data.connections.length;
  cdpConnections = data.connections || [];
  updateCDPConnectionDisplay();

  // Afficher une notification si des connexions suspectes
  if (cdpConnectionCount > 0) {
    showCDPConnectionAlert(cdpConnectionCount);
  }
}

function updateCDPConnectionDisplay() {
  const counterElement = document.getElementById('cdp-connection-counter');
  if (counterElement) {
    counterElement.textContent = cdpConnectionCount;

    // Ajouter une classe si des connexions sont détectées
    const container = document.getElementById('cdp-connection-container');
    if (container) {
      if (cdpConnectionCount > 0) {
        container.classList.add('has-connections');
      } else {
        container.classList.remove('has-connections');
      }
    }

    // MODE DISTANT: Afficher simplement le nombre de connexions (serveur backend uniquement)
    const detailsElement = document.getElementById('cdp-connection-details');
    if (detailsElement && cdpConnections && cdpConnections.length > 0) {
      detailsElement.textContent = `(${cdpConnections.length} distant)`;
      detailsElement.className = 'cdp-details';
    } else if (detailsElement) {
      detailsElement.textContent = '';
    }
  }
}

function showCDPConnectionAlert(count) {
  // OPTIMISATION: Notification désactivée pour réduire le bruit visuel
  // La connexion directe est normale pour ce serveur qui utilise CDP
  // Les connexions sont monitorées via le badge dans le header
  return;
}

async function loadCDPMonitorStats() {
  try {
    const data = await apiRequest('/api/cdp-monitor/stats');

    if (data.stats) {
      cdpMonitorStats = data.stats;
      cdpConnectionCount = data.stats.currentConnectionCount || 0;
      updateCDPConnectionDisplay();
    }
  } catch (error) {
    console.error('Erreur lors du chargement des stats CDP monitor:', error);
  }
}

function showInjectionNotification(message, type = 'info') {
  // Supprimer l'ancienne notification
  const existing = document.getElementById('injection-notification');
  if (existing) existing.remove();

  const notification = document.createElement('div');
  notification.id = 'injection-notification';
  notification.className = `injection-notification injection-${type}`;

  const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : '⏳';

  notification.innerHTML = `
    <span class="notification-icon">${icon}</span>
    <span class="notification-message">${escapeHtml(message)}</span>
  `;

  document.body.appendChild(notification);

  // Auto-supprimer apres 3 secondes
  setTimeout(() => {
    if (notification.parentElement) {
      notification.classList.add('fade-out');
      setTimeout(() => notification.remove(), 300);
    }
  }, 3000);
}

function showCDPError() {
  const appContent = document.getElementById('app-content');
  if (!appContent) return;

  const cdpTitle = t('app.cdpNotAvailable');
  const cdpDescription = t('app.cdpWarning');

  appContent.innerHTML = `
    <div class="cdp-error-container">
      <div class="cdp-error-icon">⚠️</div>
      <h1 class="cdp-error-title">${cdpTitle}</h1>
      <p class="cdp-error-description">
        ${cdpDescription}
      </p>
      <div class="cdp-error-steps">
        <h3>Comment activer le mode debug:</h3>
        <ol>
          <li>Fermez Claude Desktop complètement</li>
          <li>Lancez Claude Desktop avec le flag: <code>--remote-debugging-port=9222</code></li>
          <li>Rechargez cette page</li>
        </ol>
      </div>
      <button onclick="window.location.reload()" class="btn btn-primary">
        🔄 Recharger la page
      </button>
    </div>
  `;
}

// ============================================================================
// API Requests
// ============================================================================

async function apiRequest(endpoint, options = {}) {
  // SÉCURITÉ: Bloquer les requêtes API si PIN requis mais non authentifié
  // Exception: endpoints /api/auth/ nécessaires pour l'authentification
  if (pinRequired && !isAuthenticated && !endpoint.includes('/api/auth/')) {
    console.warn('[API] Requête bloquée - authentification requise:', endpoint);
    throw new Error('Authentification requise');
  }

  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };

  // SÉCURITÉ: Utiliser uniquement sessionToken (pas authToken - ancien système)
  if (sessionToken) {
    headers['X-Session-Token'] = sessionToken;
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers
  });

  // Si 401, forcer re-login
  if (response.status === 401 && pinRequired) {
    isAuthenticated = false;
    authToken = '';
    sessionToken = '';
    localStorage.removeItem('authToken');
    localStorage.removeItem('sessionToken');
    renderPinLoginPage();
    throw new Error('Session expirée, veuillez vous reconnecter');
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return await response.json();
}

async function loadSessions() {
  try {
    const data = await apiRequest('/api/sessions');
    data.sessions.forEach(session => {
      sessions[session.id] = session;
    });
    return data.sessions;
  } catch (error) {
    console.error('Erreur lors du chargement des sessions:', error);

    // Si CDP n'est pas disponible (503), afficher erreur fatale
    if (error.message && error.message.includes('CDP not available')) {
      showCDPError();
    }

    return [];
  }
}

async function loadSessionDetail(sessionId) {
  try {
    // OPTIMISATION: Charger session metadata + derniers 100 messages seulement
    const data = await apiRequest(`/api/session/${sessionId}`);

    // Charger les derniers messages via endpoint paginé
    const messagesData = await apiRequest(`/api/session/${sessionId}/messages?offset=0&limit=100`);

    // Si la session existe déjà et a des anciens messages chargés, les garder
    const existingSession = sessions[sessionId];
    let allMessages = messagesData.messages;

    if (existingSession && existingSession.messages && existingSession.messages.length > messagesData.messages.length) {
      // Garder les anciens messages chargés + mettre à jour avec les nouveaux
      // Les nouveaux messages sont à la fin (messages récents), les anciens au début
      const existingOldMessages = existingSession.messages.slice(0, existingSession.messages.length - messagesData.messages.length);
      allMessages = [...existingOldMessages, ...messagesData.messages];
    }

    // Construire session hybride avec metadata + messages paginés
    const session = {
      ...data.session,
      messages: allMessages,
      pagination: messagesData.pagination // { offset, limit, total, hasMore }
    };

    sessions[sessionId] = session;
    renderSessionPage(session);

    // Gérer le polling pour les sessions CDP en mode "thinking"
    manageSessionPolling(sessionId, session);
  } catch (error) {
    console.error('Erreur lors du chargement de la session:', error);
    stopSessionPolling();
    appContent.innerHTML = `
      <div class="card error-card">
        <h2>${t('app.errorTitle')}</h2>
        <p>${error.message}</p>
        <button onclick="goHome()" class="btn btn-primary">${t('app.backBtn')}</button>
      </div>
    `;
  }
}

// OPTIMISATION: Charger plus de messages (pagination)
async function loadMoreMessages(sessionId) {
  const session = sessions[sessionId];
  if (!session || !session.pagination || !session.pagination.hasMore) {
    return;
  }

  const loadMoreBtn = document.getElementById('load-more-messages');
  if (loadMoreBtn) {
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = t('app.loadingMore');
  }

  try {
    const currentOffset = session.pagination.offset + session.pagination.returned;
    const messagesData = await apiRequest(`/api/session/${sessionId}/messages?offset=${currentOffset}&limit=100`);

    // Ajouter les nouveaux messages au début (messages plus anciens)
    session.messages = [...messagesData.messages, ...session.messages];
    session.pagination = messagesData.pagination;

    // Re-render la page avec tous les messages
    renderSessionPage(session);
  } catch (error) {
    console.error('Erreur lors du chargement des messages supplémentaires:', error);
    showInjectionNotification('Erreur de chargement des messages', 'error');
  } finally {
    const loadMoreBtn = document.getElementById('load-more-messages');
    if (loadMoreBtn) {
      loadMoreBtn.disabled = false;
      loadMoreBtn.textContent = t('app.loadMore');
    }
  }
}

/**
 * Gérer le polling automatique pour les sessions CDP
 * Démarre le polling si la session est en mode "thinking", l'arrête sinon
 */
function manageSessionPolling(sessionId, session) {
  // Seulement pour les sessions CDP (local_*)
  const isCDPSession = sessionId.startsWith('local_');

  if (isCDPSession) {
    // Démarrer le polling si pas déjà actif
    if (!sessionPollingInterval) {
      console.log('[Polling] Démarrage du polling unifié pour session CDP');
      sessionPollingBurstCount = 0; // Reset burst counter
      sessionPollingIdleCount = 0; // Reset idle counter

      // Fonction de polling avec gestion du burst rapide
      const pollSession = async () => {
        // Vérifier qu'on est toujours sur cette session
        if (getCurrentRoute() !== 'session' || getCurrentSessionId() !== sessionId) {
          stopSessionPolling();
          return;
        }

        try {
          const data = await apiRequest(`/api/session/${sessionId}`);
          sessions[sessionId] = data.session;

          // OPTIMISATION: Détection de changement intelligent
          const currentHash = JSON.stringify({
            status: data.session.status,
            messageCount: data.session.messageCount,
            isThinking: data.session.isThinking
          });

          const hasChanged = currentHash !== lastSessionHash;
          lastSessionHash = currentHash;

          if (hasChanged) {
            // Données changées - reset backoff
            sessionNoChangeCount = 0;
          } else {
            // Pas de changement - augmenter backoff
            sessionNoChangeCount++;
          }

          // Mise à jour incrémentale
          updateSessionPageIncremental(data.session);

          // Gérer le compteur idle basé sur le statut ET le nombre de messages
          const isIdle = data.session.status === 'idle';

          if (isIdle) {
            sessionPollingIdleCount++;

            if (sessionPollingIdleCount >= SESSION_POLLING_IDLE_MAX && !sessionPollingSlowMode) {
              console.log('[Polling] Session idle prolongée, passage en mode slow (1x/min)');
              sessionPollingSlowMode = true;
            }
          } else {
            // Reset le compteur idle et repasser en mode normal si la session redevient active
            if (sessionPollingSlowMode) {
              console.log('[Polling] Session active, retour au polling normal');
            }
            sessionPollingIdleCount = 0;
            sessionPollingSlowMode = false;
          }
        } catch (error) {
          console.error('[Polling] Erreur:', error);
        }

        // Gérer le burst rapide initial (10 secondes)
        sessionPollingBurstCount++;

        // Déterminer le délai: burst > normal > slow > backoff intelligent
        let delay;
        if (sessionPollingBurstCount < SESSION_POLLING_BURST_MAX) {
          delay = SESSION_POLLING_BURST_MS;
        } else if (sessionPollingSlowMode) {
          delay = SESSION_POLLING_SLOW_MS;
        } else {
          delay = SESSION_POLLING_MS;

          // OPTIMISATION: Backoff intelligent si pas de changement détecté
          if (sessionNoChangeCount >= SESSION_NO_CHANGE_MAX) {
            delay = Math.min(delay * 2, 10000); // Doubler le délai jusqu'à max 10s
          }
        }

        if (sessionPollingBurstCount === SESSION_POLLING_BURST_MAX) {
          console.log('[Polling] Fin du burst rapide, passage au polling normal');
        }

        // Planifier le prochain poll
        sessionPollingInterval = setTimeout(pollSession, delay);
      };

      // Démarrer immédiatement avec burst rapide
      pollSession();
    } else {
      // Le polling est déjà actif, reset les compteurs idle ET burst
      sessionPollingIdleCount = 0;
      sessionPollingBurstCount = 0; // Reset aussi le burst pour relancer un cycle rapide
      sessionPollingSlowMode = false; // Sortir du mode slow
      console.log('[Polling] Polling déjà actif, reset des compteurs et mode normal');
    }
  } else {
    // Pas une session CDP, arrêter le polling
    stopSessionPolling();
  }
}

/**
 * Arrêter le polling de session
 */
function stopSessionPolling() {
  if (sessionPollingInterval) {
    clearTimeout(sessionPollingInterval); // Utiliser clearTimeout (car setTimeout dans la nouvelle logique)
    sessionPollingInterval = null;
    sessionPollingBurstCount = 0; // Reset le compteur de burst
    sessionPollingIdleCount = 0; // Reset le compteur idle
    sessionPollingSlowMode = false; // Reset le mode slow
    console.log('[Polling] Arrêté');
  }
}

async function sendMessage(sessionId, message) {
  try {
    const data = await apiRequest(`/api/send`, {
      method: 'POST',
      body: JSON.stringify({ sessionId, message })
    });
    return data;
  } catch (error) {
    console.error('Erreur lors de l\'envoi du message:', error);
    throw error;
  }
}

// ============================================================================
// Injection de commandes (envoi direct a Claude Code)
// ============================================================================

let injectionStatus = null;

async function loadInjectionStatus() {
  try {
    const data = await apiRequest('/api/inject/status');
    injectionStatus = data;
    return data;
  } catch (error) {
    console.error('Erreur lors du chargement du statut d\'injection:', error);
    return null;
  }
}

async function injectMessage(sessionId, message) {
  try {
    // Utiliser l'API CDP pour envoyer le message directement dans Claude Desktop
    const data = await apiRequest('/api/send', {
      method: 'POST',
      body: JSON.stringify({ sessionId, message })
    });
    return data;
  } catch (error) {
    console.error('Erreur lors de l\'envoi du message via CDP:', error);
    throw error;
  }
}

async function switchToSession(sessionId) {
  try {
    showInjectionNotification('Changement de session...', 'info');
    const data = await apiRequest('/api/switch-session', {
      method: 'POST',
      body: JSON.stringify({ sessionId })
    });
    if (data.success) {
      showInjectionNotification('Session activée dans Claude Desktop', 'success');
      // Recharger les sessions pour mettre à jour les statuts
      await loadSessions();
      if (getCurrentRoute() === 'home') {
        renderHomePage();
      }
    }
    return data;
  } catch (error) {
    console.error('Erreur lors du changement de session:', error);
    showInjectionNotification(`Erreur: ${error.message}`, 'error');
    throw error;
  }
}

async function loadUsage() {
  try {
    const data = await apiRequest('/api/usage/current');
    currentUsage = data.usage;
    return data.usage;
  } catch (error) {
    console.error('Erreur lors du chargement de l\'usage:', error);
    return null;
  }
}

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

// ============================================================================
// Routing
// ============================================================================

function getCurrentRoute() {
  const hash = window.location.hash.slice(1);
  if (hash.startsWith('session/')) return 'session';
  return 'home';
}

function getCurrentSessionId() {
  const hash = window.location.hash.slice(1);
  if (hash.startsWith('session/')) {
    return hash.split('/')[1];
  }
  return null;
}

function goHome() {
  window.location.hash = '';
}

function goToSession(sessionId) {
  window.location.hash = `session/${sessionId}`;
}

function goBack() {
  // Nettoyer l'état de la session actuelle avant de naviguer
  currentRenderedSession = null;
  currentRenderedMessageCount = 0;
  lastTodosHash = null;
  lastKnownToolUse = null;
  lastKnownAssistantText = null;

  // Arrêter le polling immédiatement
  stopSessionPolling();

  // Forcer le rendu de la page d'accueil (contourne le check isAuthenticated)
  backBtn.style.display = 'none';
  renderHomePage();

  // Mettre à jour le hash
  window.location.hash = '';
}

function handleRouteChange() {
  // Ne pas changer de route si pas authentifie
  if (!isAuthenticated) {
    return;
  }

  const route = getCurrentRoute();

  if (route === 'home') {
    backBtn.style.display = 'none';
    // Nettoyer l'état de session
    currentRenderedSession = null;
    currentRenderedMessageCount = 0;
    lastTodosHash = null;
    lastKnownToolUse = null;
    lastKnownAssistantText = null;
    // Arrêter le polling quand on quitte une session
    stopSessionPolling();

    // Rendre immédiatement avec les données en cache
    renderHomePage();

    // Mémoriser l'état actuel pour éviter un re-render inutile
    const previousSessionKeys = JSON.stringify(Object.keys(sessions).sort());

    // Recharger les sessions en arrière-plan
    loadSessions().then(() => {
      if (getCurrentRoute() === 'home') {
        // Ne re-render QUE si les sessions ont réellement changé
        const newSessionKeys = JSON.stringify(Object.keys(sessions).sort());
        if (newSessionKeys !== previousSessionKeys) {
          renderHomePage();
        }
      }
    }).catch(err => console.error('Erreur refresh sessions:', err));
  } else if (route === 'session') {
    backBtn.style.display = 'inline-block';
    const sessionId = getCurrentSessionId();
    loadSessionDetail(sessionId);
  }
}

// ============================================================================
// Rendering
// ============================================================================

/**
 * Rend le widget d'estimation du contexte de la session
 * Affiche une barre de progression avec la répartition des tokens
 */
function renderContextWidget(contextUsage) {
  if (!contextUsage) return '';

  const { estimatedTokens, maxTokens, percentage, breakdown, warningLevel, isEstimate } = contextUsage;

  // Couleurs selon le niveau d'alerte (cohérence pastille/barre)
  const colorMap = {
    'low': '#4caf50',      // Vert
    'medium': '#ff9800',   // Orange
    'high': '#f44336',     // Rouge
    'critical': '#d32f2f'  // Rouge foncé (dépassement)
  };
  const barColor = colorMap[warningLevel] || '#4caf50';

  // Icône selon le niveau (couleurs cohérentes avec la barre)
  const iconMap = {
    'low': '🟢',      // Vert
    'medium': '🟡',   // Jaune/Orange
    'high': '🟠',     // Orange
    'critical': '🔴'  // Rouge
  };
  const icon = iconMap[warningLevel] || '📊';

  // Formater les nombres
  const formatK = (n) => {
    if (n >= 1000) {
      return (n / 1000).toFixed(1) + 'K';
    }
    return n.toString();
  };

  // Calculer les pourcentages pour la répartition
  const totalTokens = breakdown.userMessages + breakdown.assistantMessages + breakdown.toolResults + breakdown.systemOverhead;
  const userPct = totalTokens > 0 ? (breakdown.userMessages / totalTokens * 100).toFixed(1) : 0;
  const assistantPct = totalTokens > 0 ? (breakdown.assistantMessages / totalTokens * 100).toFixed(1) : 0;
  const toolPct = totalTokens > 0 ? (breakdown.toolResults / totalTokens * 100).toFixed(1) : 0;
  const systemPct = totalTokens > 0 ? (breakdown.systemOverhead / totalTokens * 100).toFixed(1) : 0;

  return `
    <div class="context-widget">
      <div class="context-header" onclick="toggleContextDetails()">
        <div class="context-title">
          <span class="context-icon">${icon}</span>
          <span class="context-label">${i18n.t('contextWidget.title')}</span>
          ${isEstimate ? `<span class="context-estimate-badge" title="${i18n.t('contextWidget.estimateBadge')}">~</span>` : ''}
        </div>
        <div class="context-summary">
          <span class="context-percentage">${percentage.toFixed(1)}%</span>
          <span class="context-tokens">${formatK(estimatedTokens)} / ${formatK(maxTokens)}</span>
          <span class="context-toggle" id="context-toggle-icon">▼</span>
        </div>
      </div>
      <div class="context-progress-container">
        <div class="context-progress-bar">
          <div class="context-progress-fill" style="width: ${Math.min(100, percentage)}%; background-color: ${barColor};"></div>
        </div>
      </div>
      <div class="context-details" id="context-details" style="display: none;">
        <div class="context-breakdown">
          <div class="context-breakdown-item">
            <span class="breakdown-color" style="background-color: #2196f3;"></span>
            <span class="breakdown-label">${i18n.t('contextWidget.userMessages')}</span>
            <span class="breakdown-value">${formatK(breakdown.userMessages)} (${userPct}%)</span>
          </div>
          <div class="context-breakdown-item">
            <span class="breakdown-color" style="background-color: #9c27b0;"></span>
            <span class="breakdown-label">${i18n.t('contextWidget.assistantMessages')}</span>
            <span class="breakdown-value">${formatK(breakdown.assistantMessages)} (${assistantPct}%)</span>
          </div>
          <div class="context-breakdown-item">
            <span class="breakdown-color" style="background-color: #ff9800;"></span>
            <span class="breakdown-label">${i18n.t('contextWidget.toolResults')}</span>
            <span class="breakdown-value">${formatK(breakdown.toolResults)} (${toolPct}%)</span>
          </div>
          <div class="context-breakdown-item">
            <span class="breakdown-color" style="background-color: #607d8b;"></span>
            <span class="breakdown-label">${i18n.t('contextWidget.systemPrompt')}</span>
            <span class="breakdown-value">${formatK(breakdown.systemOverhead)} (${systemPct}%)</span>
          </div>
        </div>
        <div class="context-note">
          <small>⚠️ Estimation approximative basée sur le contenu de la conversation (~4 caractères/token)</small>
        </div>
      </div>
    </div>
  `;
}

/**
 * Toggle l'affichage des détails du contexte
 */
function toggleContextDetails() {
  const details = document.getElementById('context-details');
  const icon = document.getElementById('context-toggle-icon');
  if (details) {
    const isHidden = details.style.display === 'none';
    details.style.display = isHidden ? 'block' : 'none';
    if (icon) {
      icon.textContent = isHidden ? '▲' : '▼';
    }
  }
}

function renderUsageWidget() {
  const container = document.getElementById('usage-widget-container');
  if (!container) return;

  if (!currentUsage) {
    container.innerHTML = `
      <div class="card usage-card usage-card-collapsed">
        <div class="usage-header-collapsed" onclick="toggleUsageWidget()">
          <div class="usage-summary">
            <h3>${window.i18n ? window.i18n.t('app.creditsTitle') : '💳 Crédits Claude Code'}</h3>
            <span class="usage-summary-text">${window.i18n ? window.i18n.t('app.loading') : 'Chargement...'}</span>
          </div>
          <div class="usage-header-actions">
            <button onclick="event.stopPropagation(); refreshUsage()" class="btn btn-small">🔄</button>
            <span class="usage-toggle-icon">▼</span>
          </div>
        </div>
      </div>
    `;
    return;
  }

  const percentage = currentUsage.percentageUsed;
  const barColor = percentage < 50 ? '#4caf50' : percentage < 80 ? '#ff9800' : '#f44336';

  // Formater les nombres avec des espaces
  const tokensUsed = formatNumber(currentUsage.tokensUsed);
  const tokensLimit = formatNumber(currentUsage.tokensLimit);
  const tokensRemaining = formatNumber(currentUsage.tokensRemaining);
  const dailyUsage = formatNumber(currentUsage.dailyUsage);
  const currentRate = formatNumber(currentUsage.currentRate);

  // Calculer le temps jusqu'au prochain refresh (heure exacte)
  const nextRefreshTime = currentUsage.nextRefresh ? getTimeUntil(new Date(currentUsage.nextRefresh)) : t('app.unknown');
  const nextRefreshHour = currentUsage.nextRefresh ? formatRefreshHour(new Date(currentUsage.nextRefresh)) : '--:--';

  // Calculer l'heure de début de la fenêtre (refresh - 5h)
  const windowStartHour = currentUsage.nextRefresh
    ? formatRefreshHour(new Date(new Date(currentUsage.nextRefresh).getTime() - 5 * 60 * 60 * 1000))
    : '--:--';

  // Résumé compact pour l'état non déroulé
  const summaryText = `${percentage.toFixed(0)}% · ${tokensUsed}/${tokensLimit} · Refresh ${nextRefreshHour}`;

  container.innerHTML = `
    <div class="card usage-card ${usageWidgetExpanded ? '' : 'usage-card-collapsed'}">
      <div class="usage-header-collapsed" onclick="toggleUsageWidget()">
        <div class="usage-summary">
          <h3>${t('app.creditsTitle')}</h3>
          <span class="usage-summary-text ${usageWidgetExpanded ? 'hidden' : ''}">${summaryText}</span>
        </div>
        <div class="usage-header-actions">
          <button onclick="event.stopPropagation(); refreshUsage()" class="btn btn-small" title="${t('app.refreshData')}">🔄</button>
          <span class="usage-toggle-icon ${usageWidgetExpanded ? 'expanded' : ''}">▼</span>
        </div>
      </div>

      <div class="usage-content ${usageWidgetExpanded ? '' : 'hidden'}">
        <!-- Disponibilité actuelle -->
        <div class="usage-availability">
          <div class="availability-main">
            <span class="availability-label">${t('app.availableNow')}</span>
            <span class="availability-value">${tokensRemaining}</span>
            <span class="availability-unit">${t('app.tokens')}</span>
          </div>
        </div>

        <!-- Barre de progression -->
        <div class="usage-progress">
          <div class="progress-bar-container">
            <div class="progress-bar" style="width: ${percentage}%; background-color: ${barColor};"></div>
          </div>
          <div class="progress-text">${percentage.toFixed(1)}% ${t('app.used')} (${tokensUsed} / ${tokensLimit})</div>
        </div>

        <!-- Tokens -->
        <div class="usage-stats">
          <div class="stat-item">
            <span class="stat-icon">🔄</span>
            <div class="stat-content">
              <span class="stat-label">${t('app.nextRefresh')}</span>
              <span class="stat-value-small">${nextRefreshTime}</span>
            </div>
          </div>

          <div class="stat-item">
            <span class="stat-icon">📊</span>
            <div class="stat-content">
              <span class="stat-label">${t('app.windowStart')}</span>
              <span class="stat-value-small">${windowStartHour}</span>
            </div>
          </div>

          <div class="stat-item">
            <span class="stat-icon">⏱️</span>
            <div class="stat-content">
              <span class="stat-label">${t('app.currentRate')}</span>
              <span class="stat-value-small">~${currentRate} ${t('app.tokensPerMin')}</span>
            </div>
          </div>
        </div>

        <!-- Plan -->
        <div class="usage-plan">
          <span class="plan-badge">Plan: ${currentUsage.plan.toUpperCase()}</span>
        </div>
      </div>
    </div>
  `;
}

function toggleUsageWidget() {
  usageWidgetExpanded = !usageWidgetExpanded;
  renderUsageWidget();
}

function formatRefreshHour(date) {
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

// Auto-refresh silencieux de l'usage (sans re-render complet de la page)
function startUsageAutoRefresh() {
  // Arrêter l'ancien interval s'il existe
  if (usageAutoRefreshInterval) {
    clearInterval(usageAutoRefreshInterval);
  }

  usageAutoRefreshInterval = setInterval(async () => {
    // Seulement rafraîchir si on est sur la page d'accueil
    if (getCurrentRoute() === 'home') {
      try {
        const data = await apiRequest('/api/usage/current');
        currentUsage = data.usage;
        // Mettre à jour uniquement le widget, pas toute la page
        renderUsageWidget();
        console.log('Auto-refresh usage effectué');
      } catch (error) {
        console.error('Erreur auto-refresh usage:', error);
      }
    }
  }, USAGE_AUTO_REFRESH_MS);
}

function stopUsageAutoRefresh() {
  if (usageAutoRefreshInterval) {
    clearInterval(usageAutoRefreshInterval);
    usageAutoRefreshInterval = null;
  }
}

function renderHomePage() {
  const sessionsList = Object.values(sessions).sort((a, b) => {
    return new Date(b.lastActivity) - new Date(a.lastActivity);
  });

  // Séparer les sessions actives et inactives
  const activeSessions = sessionsList.filter(s => s.status !== 'idle');
  const inactiveSessions = sessionsList.filter(s => s.status === 'idle');

  if (sessionsList.length === 0) {
    appContent.innerHTML = `
      <div class="card empty-state">
        <div class="empty-icon">💤</div>
        <h2>${i18n.t('home.noSessions')}</h2>
        <p>${i18n.t('home.noSessionsDesc')}</p>
        <p class="info-text">${i18n.t('home.noSessionsInfo')}</p>
        <button onclick="showNewSessionModal()" class="btn btn-primary" style="margin-top: 1rem;">
          ➕ ${i18n.t('home.newSession')}
        </button>
      </div>
    `;
    return;
  }

  // Fonction pour générer le HTML d'une session
  const renderSessionCard = (session) => {
    const statusColor = session.status === 'thinking' ? 'status-thinking' :
                       session.status === 'waiting' ? 'status-waiting' : 'status-idle';

    const statusLabels = {
      'thinking': i18n.t('session.statusThinking'),
      'waiting': i18n.t('session.statusWaiting'),
      'idle': i18n.t('session.statusIdle'),
      'active': i18n.t('session.statusActive')
    };
    const statusLabel = statusLabels[session.status] || session.status;

    const lastActivity = new Date(session.lastActivity);
    const timeAgo = getTimeAgo(lastActivity);

    const lastMsg = session.lastMessage ? session.lastMessage.substring(0, 80) : i18n.t('session.noMessage');
    const displayName = session.projectName || session.id.substring(0, 8) + '...';

    return `
      <div class="session-card" data-session-id="${escapeHtml(session.id)}">
        <div class="session-header">
          <div class="session-id">
            <span class="session-emoji">💬</span>
            <span class="session-id-text" title="${escapeHtml(session.id)}">${escapeHtml(displayName)}</span>
          </div>
          <span class="session-badge ${statusColor}">${statusLabel}</span>
        </div>
        <div class="session-info">
          <div class="session-meta">
            <span>🕒 ${timeAgo}</span>
          </div>
          ${session.cwd ? `<div class="session-path">📁 ${escapeHtml(session.cwd)}</div>` : ''}
          <div class="session-preview">${escapeHtml(lastMsg)}${session.lastMessage && session.lastMessage.length > 80 ? '...' : ''}</div>
        </div>
      </div>
    `;
  };

  const activeSessionsHTML = activeSessions.map(renderSessionCard).join('');
  const inactiveSessionsHTML = inactiveSessions.map(renderSessionCard).join('');

  // Section sessions actives (toujours visible)
  const activeSectionHTML = activeSessions.length > 0 ? `
    <div class="sessions-section">
      <div class="sessions-section-header">
        <h2>${i18n.t('home.activeSessions')} (${activeSessions.length})</h2>
      </div>
      <div class="sessions-list">
        ${activeSessionsHTML}
      </div>
    </div>
  ` : `
    <div class="sessions-section">
      <div class="sessions-section-header">
        <h2>${i18n.t('home.activeSessions')} (0)</h2>
      </div>
      <div class="empty-section">
        <p>${i18n.t('home.noActiveSession')}</p>
      </div>
    </div>
  `;

  // Section sessions inactives (rétractable)
  const inactiveSectionHTML = inactiveSessions.length > 0 ? `
    <div class="sessions-section sessions-section-collapsible">
      <div class="sessions-section-header clickable" onclick="toggleInactiveSessions()">
        <h2>
          <span class="collapse-icon ${inactiveSessionsExpanded ? 'expanded' : ''}">▶</span>
          ${i18n.t('home.pastSessions')} (${inactiveSessions.length})
        </h2>
      </div>
      <div class="sessions-list ${inactiveSessionsExpanded ? '' : 'collapsed'}">
        ${inactiveSessionsHTML}
      </div>
    </div>
  ` : '';

  appContent.innerHTML = `
    <div class="home-container">
      <!-- Widget d'usage des crédits -->
      <div id="usage-widget-container"></div>

      <!-- Sessions -->
      <div class="sessions-container">
        <div class="sessions-header">
          <h2>${i18n.t('home.sessions')}</h2>
          <div class="sessions-header-actions">
            <button onclick="showNewSessionModal()" class="btn btn-primary btn-small">➕ ${i18n.t('home.newSession')}</button>
            <button onclick="loadSessions().then(() => renderHomePage())" class="btn btn-small">🔄 ${i18n.t('home.refresh')}</button>
          </div>
        </div>

        ${activeSectionHTML}
        ${inactiveSectionHTML}
      </div>
    </div>
  `;

  // Rendre le widget d'usage après l'insertion du HTML
  setTimeout(() => renderUsageWidget(), 0);

  // Attacher les event listeners aux session cards (sécurité: pas de onclick inline)
  document.querySelectorAll('.session-card').forEach(card => {
    card.addEventListener('click', () => {
      const sessionId = card.getAttribute('data-session-id');
      if (sessionId) {
        goToSession(sessionId);
      }
    });
  });
}

function toggleInactiveSessions() {
  inactiveSessionsExpanded = !inactiveSessionsExpanded;
  renderHomePage();
}

function renderSessionPage(session) {
  if (!session) {
    appContent.innerHTML = `<div class="card"><p>${t('app.sessionNotFound')}</p></div>`;
    return;
  }

  const messages = session.messages || [];

  // Reset de l'état de la tasklist quand on change de session
  sessionTasklistState = {
    lastHash: null,
    lastTodos: null,
    isExpanded: false,
    autoCloseTimer: null,
    isUserExpanded: false
  };

  // Mettre à jour l'état du rendu pour la mise à jour incrémentale
  currentRenderedSession = session.id;
  currentRenderedMessageCount = messages.length;

  // Utiliser renderSingleMessage pour un rendu uniforme avec data-uuid
  const messagesHTML = messages.map(msg => renderSingleMessage(msg)).join('');

  const statusColor = session.status === 'thinking' ? 'status-thinking' :
                     session.status === 'waiting' ? 'status-waiting' : 'status-idle';

  // Labels de statut plus clairs en français
  const statusLabels = {
    'thinking': 'Claude travaille...',
    'waiting': 'En attente',
    'idle': 'Inactif',
    'active': 'En cours' // Fallback
  };
  const statusLabel = statusLabels[session.status] || session.status;

  // Indicateur de travail - géré séparément comme pastille fixe
  const thinkingState = computeThinkingState(session);

  // Nom d'affichage de la session (résumé de session ou nom projet)
  const displayName = session.sessionSummary || session.projectName || session.id.substring(0, 12) + '...';

  // Rendu du widget de contexte (si disponible)
  const contextWidget = session.contextUsage ? renderContextWidget(session.contextUsage) : '';

  appContent.innerHTML = `
    <div class="session-detail">
      <div class="card session-info-card">
        <h2>${escapeHtml(displayName)}</h2>
        <div class="session-id-small">ID: ${session.id}</div>
        <div class="session-metadata">
          <div class="meta-item">
            <strong>${i18n.t('session.status')}:</strong>
            <span class="session-badge ${statusColor}">${statusLabel}</span>
          </div>
          <div class="meta-item">
            <strong>${i18n.t('session.messagesCount')}:</strong> ${session.messageCount}
          </div>
          ${session.cwd ? `<div class="meta-item"><strong>${i18n.t('session.directory')}:</strong> <code>${session.cwd}</code></div>` : ''}
          ${session.gitBranch ? `<div class="meta-item"><strong>${i18n.t('session.branch')}:</strong> <code>${session.gitBranch}</code></div>` : ''}
          <div class="meta-item">
            <strong>${i18n.t('session.lastActivity')}:</strong> ${new Date(session.lastActivity).toLocaleString(i18n.getCurrentLanguage() === 'fr' ? 'fr-FR' : 'en-US')}
          </div>
        </div>
        ${contextWidget}
      </div>

      <div class="card messages-card resizable-card">
        <h3>💬 ${i18n.t('session.conversation')}</h3>
        ${session.pagination && session.pagination.hasMore ? `
          <div class="load-more-container">
            <button id="load-more-messages" onclick="loadMoreMessages('${session.id}')" class="btn btn-secondary">
              📜 ${t('app.loadMore')} (${session.pagination.total - session.pagination.returned})
            </button>
          </div>
        ` : ''}
        <div class="messages-container" id="messages-container">
          ${messagesHTML.length > 0 ? messagesHTML : `<p class="info-message">${i18n.t('session.noMessagesInSession')}</p>`}
        </div>
        <div class="session-task-list" id="session-task-list" style="display: none;"></div>
        <div class="thinking-indicator" id="thinking-indicator" style="display: none;">
          <span class="thinking-dot"></span><span class="thinking-dot"></span><span class="thinking-dot"></span> ${i18n.t('session.statusThinking')}
        </div>
        <div class="resize-handle"></div>
      </div>

      <div class="card session-actions-card" id="session-actions-card">
        <h3>${i18n.t('session.sendMessage')}</h3>

        <div class="message-input-container">
          <textarea id="message-input"
                    class="message-input"
                    placeholder="${i18n.t('session.messagePlaceholder')}"
                    rows="3"></textarea>
          <div class="message-actions">
            <button onclick="handleInjectMessage('${session.id}')" class="btn btn-primary">
              ${i18n.t('session.sendBtn')}
            </button>
            <button onclick="handleInterruptRequest('${session.id}')"
                    class="btn btn-danger btn-interrupt"
                    style="display: ${session.status === 'thinking' ? 'inline-block' : 'none'}">
              ⏸️ ${i18n.t('session.interruptBtn')}
            </button>
          </div>
        </div>
      </div>

    </div>
  `;

  // Initialiser le redimensionnement de la conversation
  initResizableConversation();

  // Initialiser la tasklist et le thinking indicator
  setTimeout(() => {
    const container = document.getElementById('messages-container');
    if (container) {
      updateTaskMessage(container, messages);

      // Afficher le thinking indicator si Claude travaille
      const thinkingEl = document.getElementById('thinking-indicator');
      if (thinkingEl) {
        thinkingEl.style.display = thinkingState.isThinking ? 'flex' : 'none';
      }

      // Scroll to bottom of messages
      container.scrollTop = container.scrollHeight;
    }
  }, 100);
}

/**
 * Mise à jour incrémentale de la page session (évite le scintillement)
 * Utilise une approche par UUID pour ajouter/mettre à jour uniquement les éléments nécessaires
 */
function updateSessionPageIncremental(session) {
  const messages = session.messages || [];
  const container = document.getElementById('messages-container');

  // Si la structure de base n'existe pas ou si on change de session, faire un rendu complet
  if (!container || currentRenderedSession !== session.id) {
    renderSessionPage(session);
    return;
  }

  // Mettre à jour les métadonnées (statut, nombre de messages, etc.) sans re-rendre tout
  updateSessionMetadata(session);

  // Sauvegarder la position de scroll avant modifications
  const wasAtBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 50;
  const oldScrollTop = container.scrollTop;

  // Créer un Set des UUIDs actuels dans le DOM
  const existingUuids = new Set();
  container.querySelectorAll('[data-uuid]').forEach(el => {
    existingUuids.add(el.getAttribute('data-uuid'));
  });

  // Créer un Set des UUIDs des nouveaux messages
  const newMessageUuids = new Set(messages.map(msg => msg.uuid));

  // Supprimer les messages qui n'existent plus (cas rare)
  container.querySelectorAll('[data-uuid]').forEach(el => {
    const uuid = el.getAttribute('data-uuid');
    if (!newMessageUuids.has(uuid)) {
      el.remove();
    }
  });

  // Ajouter uniquement les nouveaux messages (sauf les tasks qui sont gérés par updateTaskMessage)
  let hasNewMessages = false;
  for (const msg of messages) {
    // Skip les messages task - ils sont gérés séparément par updateTaskMessage
    if (msg.role === 'task') continue;

    if (!existingUuids.has(msg.uuid)) {
      const html = renderSingleMessage(msg);
      // Créer un élément temporaire pour parser le HTML
      const temp = document.createElement('div');
      temp.innerHTML = html;
      const newElement = temp.firstElementChild;
      if (newElement) {
        newElement.setAttribute('data-uuid', msg.uuid);
        container.appendChild(newElement);
        hasNewMessages = true;
      }
    }
  }

  // Mettre à jour le task message (TodoWrite) - il change souvent
  updateTaskMessage(container, messages);

  // Ne plus ouvrir automatiquement la tasklist à chaque nouveau message
  // L'ouverture automatique se fait uniquement lors d'une mise à jour de tâche dans updateTaskMessage()

  // Gérer le thinking indicator - positionné en absolute dans messages-card
  const thinkingState = computeThinkingState(session);
  const thinkingEl = document.getElementById('thinking-indicator');
  if (thinkingEl) {
    thinkingEl.style.display = thinkingState.isThinking ? 'flex' : 'none';
  }

  // Gérer le message "aucun message"
  const emptyMsg = container.querySelector('.info-message');
  if (messages.length === 0 && !emptyMsg) {
    container.innerHTML = `<p class="info-message">${t('app.noMessages')}</p>`;
  } else if (messages.length > 0 && emptyMsg) {
    emptyMsg.remove();
  }

  // Restaurer/ajuster le scroll
  if (hasNewMessages && wasAtBottom) {
    container.scrollTop = container.scrollHeight;
  } else if (!hasNewMessages) {
    container.scrollTop = oldScrollTop;
  }

  // Mettre à jour l'état
  currentRenderedMessageCount = messages.length;
}

/**
 * Calcule si on doit afficher "Claude travaille"
 * Logique simplifiée :
 * - Active dès envoi de message utilisateur
 * - Active dès détection de lecture ou tool use (backend détecte via CDP)
 * - Désactive dès réception d'un message assistant
 */
let lastThinkingState = null; // Pour détecter les changements

function computeThinkingState(session) {
  // La bulle est active si Claude est en train de travailler (backend le détecte via CDP)
  const shouldShowThinking = session.status === 'thinking' || session.isThinking || false;

  console.log('[ThinkingDebug] State:', {
    status: session.status,
    isThinking: session.isThinking,
    shouldShow: shouldShowThinking
  });

  // Logger le changement d'état
  if (lastThinkingState !== shouldShowThinking) {
    logThinkingEvent(session.id, shouldShowThinking ? 'SHOW' : 'HIDE', {
      status: session.status,
      isThinking: session.isThinking,
      messageCount: session.messageCount,
      lastActivity: session.lastActivity
    });
    lastThinkingState = shouldShowThinking;
  }

  return { isThinking: shouldShowThinking };
}

/**
 * Logger un événement thinking pour le debug
 */
function logThinkingEvent(sessionId, event, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    sessionId,
    event, // 'SHOW' ou 'HIDE'
    details
  };

  thinkingDebugLog.push(entry);
  console.log('[ThinkingDebug] Event logged:', entry);

  // Limiter la taille du log
  if (thinkingDebugLog.length > MAX_DEBUG_LOG_ENTRIES) {
    thinkingDebugLog = thinkingDebugLog.slice(-MAX_DEBUG_LOG_ENTRIES);
  }
}

/**
 * Toggle le panneau debug
 */
function toggleDebugPanel() {
  const panel = document.getElementById('debug-panel');
  const icon = document.getElementById('debug-toggle-icon');
  if (panel && icon) {
    const isHidden = panel.style.display === 'none';
    panel.style.display = isHidden ? 'block' : 'none';
    icon.textContent = isHidden ? '▼' : '▶';
  }
}

/**
 * Collecter toutes les données de debug pour une session
 */
async function collectDebugData(sessionId) {
  const session = sessions[sessionId];
  if (!session) {
    console.error('[Debug] Session not found:', sessionId);
    return null;
  }

  // Extraire les tool_use des messages
  // Le backend transforme les messages et crée des entrées avec role: "tool_action"
  const toolUses = [];
  if (session.messages) {
    session.messages.forEach((msg, index) => {
      // Méthode 1: Messages avec role "tool_action" (format transformé par le backend)
      if (msg.role === 'tool_action' && msg.toolActions) {
        msg.toolActions.forEach(action => {
          toolUses.push({
            messageIndex: index,
            uuid: msg.uuid,
            toolName: action.tool,
            count: action.count,
            files: action.files,
            timestamp: msg.timestamp
          });
        });
      }

      // Méthode 2: Messages assistant avec content array (format brut API)
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        msg.content.forEach(block => {
          if (block.type === 'tool_use') {
            toolUses.push({
              messageIndex: index,
              uuid: msg.uuid,
              toolName: block.name,
              toolId: block.id,
              input: block.input,
              timestamp: msg.timestamp
            });
          }
        });
      }
    });
  }

  // Filtrer les events thinking pour cette session
  const thinkingEvents = thinkingDebugLog.filter(e => e.sessionId === sessionId);

  return {
    exportedAt: new Date().toISOString(),
    session: {
      id: session.id,
      status: session.status,
      isThinking: session.isThinking,
      messageCount: session.messageCount,
      cwd: session.cwd,
      gitBranch: session.gitBranch,
      projectName: session.projectName,
      sessionSummary: session.sessionSummary,
      lastActivity: session.lastActivity,
      createdAt: session.createdAt
    },
    messages: session.messages || [],
    toolUses,
    thinkingEvents,
    stats: {
      totalMessages: (session.messages || []).length,
      totalToolUses: toolUses.length,
      totalThinkingEvents: thinkingEvents.length,
      thinkingShowCount: thinkingEvents.filter(e => e.event === 'SHOW').length,
      thinkingHideCount: thinkingEvents.filter(e => e.event === 'HIDE').length
    }
  };
}

/**
 * Exporter les données de debug en fichier JSON
 */
async function exportDebugData(sessionId) {
  const debugData = await collectDebugData(sessionId);
  if (!debugData) return;

  // Créer le fichier à télécharger
  const blob = new Blob([JSON.stringify(debugData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `claude-debug-${sessionId.substring(0, 12)}-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  // Afficher un aperçu dans le panel
  showDebugPreview(debugData);
}

/**
 * Copier les données de debug dans le presse-papier
 */
async function copyDebugDataToClipboard(sessionId) {
  const debugData = await collectDebugData(sessionId);
  if (!debugData) return;

  try {
    await navigator.clipboard.writeText(JSON.stringify(debugData, null, 2));
    showInjectionNotification('Debug data copié!', 'success');
    showDebugPreview(debugData);
  } catch (err) {
    console.error('[Debug] Clipboard error:', err);
    showInjectionNotification('Erreur copie presse-papier', 'error');
  }
}

/**
 * Vider le log de debug
 */
function clearThinkingDebugLog() {
  thinkingDebugLog = [];
  lastThinkingState = null;
  const countEl = document.getElementById('debug-event-count');
  if (countEl) countEl.textContent = '0';
  showInjectionNotification('Log debug vidé', 'success');
}

/**
 * Afficher un aperçu des données de debug
 */
function showDebugPreview(debugData) {
  const preview = document.getElementById('debug-preview');
  if (!preview) return;

  preview.innerHTML = `
    <div class="debug-preview-content">
      <h4>📊 Résumé Export</h4>
      <ul>
        <li><strong>Messages:</strong> ${debugData.stats.totalMessages}</li>
        <li><strong>Tool Uses:</strong> ${debugData.stats.totalToolUses}</li>
        <li><strong>Thinking Events:</strong> ${debugData.stats.totalThinkingEvents}
          (${debugData.stats.thinkingShowCount} SHOW / ${debugData.stats.thinkingHideCount} HIDE)</li>
      </ul>
      <h4>🕐 Derniers événements thinking</h4>
      <div class="debug-events-list">
        ${debugData.thinkingEvents.slice(-5).map(e => `
          <div class="debug-event ${e.event === 'SHOW' ? 'debug-event-show' : 'debug-event-hide'}">
            <span class="debug-event-time">${new Date(e.timestamp).toLocaleTimeString('fr-FR')}</span>
            <span class="debug-event-type">${e.event}</span>
            <span class="debug-event-detail">status: ${e.details.status || 'N/A'}</span>
          </div>
        `).join('') || '<p class="info-text">Aucun événement enregistré</p>'}
      </div>
    </div>
  `;
}

/**
 * Formate le nom d'un outil pour l'affichage dans la bulle "Claude travaille"
 */
function formatToolName(toolName) {
  const toolLabels = {
    'Read': 'Lecture de fichier...',
    'Write': 'Écriture de fichier...',
    'Edit': 'Modification de fichier...',
    'Bash': 'Exécution de commande...',
    'Glob': 'Recherche de fichiers...',
    'Grep': 'Recherche dans le code...',
    'Task': 'Lancement d\'agent...',
    'WebFetch': 'Récupération web...',
    'WebSearch': 'Recherche web...',
    'TodoWrite': 'Mise à jour des tâches...',
    'AskUserQuestion': 'Question à l\'utilisateur...',
    'NotebookEdit': 'Modification de notebook...',
    'EnterPlanMode': 'Passage en mode plan...',
    'ExitPlanMode': 'Sortie du mode plan...'
  };

  return toolLabels[toolName] || `Utilisation de ${toolName}...`;
}

/**
 * Génère un hash simple pour comparer les todos
 */
function hashTodos(todos) {
  if (!todos || todos.length === 0) return null;
  return JSON.stringify(todos.map(t => ({ c: t.content, s: t.status })));
}

/**
 * Détecte si une tâche a changé de status (en particulier completed ou in_progress)
 * Retourne true si au moins une tâche a changé de status
 */
function detectStatusChange(oldTodos, newTodos) {
  if (!oldTodos || !newTodos) return false;
  if (oldTodos.length !== newTodos.length) return false;

  for (let i = 0; i < oldTodos.length; i++) {
    const oldTask = oldTodos[i];
    const newTask = newTodos[i];

    // Même contenu mais status différent
    if (oldTask.content === newTask.content && oldTask.status !== newTask.status) {
      return true;
    }
  }

  return false;
}

// État global pour la tasklist dans session-task-list
let sessionTasklistState = {
  lastHash: null,
  lastTodos: null, // Pour détecter les changements de status
  isExpanded: false,
  autoCloseTimer: null,
  isUserExpanded: false // true si l'utilisateur a cliqué pour ouvrir
};

/**
 * Met à jour le message de task (TodoWrite) sans tout re-rendre
 * Utilise un hash pour éviter les re-renders inutiles à chaque poll
 */
function updateTaskMessage(container, messages) {
  const taskMsg = messages.find(m => m.role === 'task');
  const sessionTaskList = document.getElementById('session-task-list');

  if (taskMsg && taskMsg.todos && taskMsg.todos.length > 0) {
    const newHash = hashTodos(taskMsg.todos);
    const hasChanged = newHash !== sessionTasklistState.lastHash;
    const isFirstRender = sessionTasklistState.lastHash === null;

    // Afficher la task list dans le messages-container
    if (sessionTaskList) {
      sessionTaskList.style.display = 'block';

      // Ne re-render QUE si les données ont changé ou premier rendu
      if (hasChanged || isFirstRender) {
        const isCollapsed = !sessionTasklistState.isExpanded;
        sessionTaskList.innerHTML = renderTaskMessage(taskMsg.todos, taskMsg.uuid, isCollapsed);

        // Ajouter l'event listener pour toggle
        const taskMessage = sessionTaskList.querySelector('.task-message');
        if (taskMessage) {
          taskMessage.addEventListener('click', handleTasklistToggle);

          // Si c'est une mise à jour (pas le premier render)
          if (!isFirstRender) {
            // Animation pulse
            taskMessage.classList.add('pulse-update');
            setTimeout(() => taskMessage.classList.remove('pulse-update'), 600);

            // Détecter si une tâche a changé de status (completed/in_progress)
            const hasStatusChange = detectStatusChange(sessionTasklistState.lastTodos, taskMsg.todos);

            // Ouvrir temporairement SEULEMENT si une tâche change de status ET l'utilisateur n'a pas ouvert manuellement
            if (hasStatusChange && !sessionTasklistState.isUserExpanded) {
              expandTasklist(taskMessage, true); // true = auto-close après 3s
            }

            // Auto-scroll vers la tâche en cours si la tasklist est déjà ouverte
            if (sessionTasklistState.isExpanded) {
              setTimeout(() => scrollToActiveTask(taskMessage), 150);
            }
          }

          // Sauvegarder les todos pour la prochaine comparaison
          sessionTasklistState.lastTodos = JSON.parse(JSON.stringify(taskMsg.todos));

          // Mettre à jour l'état visuel si déjà expanded
          if (sessionTasklistState.isExpanded) {
            taskMessage.classList.remove('collapsed');
            taskMessage.classList.add('expanded');
          }
        }

        sessionTasklistState.lastHash = newHash;
      }
    }
  } else {
    // Pas de tâches, cacher la task list et reset l'état
    if (sessionTaskList) {
      sessionTaskList.style.display = 'none';
      sessionTaskList.innerHTML = '';
    }
    sessionTasklistState.lastHash = null;
    sessionTasklistState.lastTodos = null;
    sessionTasklistState.isExpanded = false;
    sessionTasklistState.isUserExpanded = false;
    if (sessionTasklistState.autoCloseTimer) {
      clearTimeout(sessionTasklistState.autoCloseTimer);
      sessionTasklistState.autoCloseTimer = null;
    }
  }
}

/**
 * Gère le toggle de la tasklist (clic utilisateur)
 */
function handleTasklistToggle(event) {
  const taskMessage = event.currentTarget;

  if (taskMessage.classList.contains('collapsed')) {
    // Ouvrir manuellement (pas d'auto-close)
    sessionTasklistState.isUserExpanded = true;
    expandTasklist(taskMessage, false);
  } else {
    // Fermer
    collapseTasklist(taskMessage);
    sessionTasklistState.isUserExpanded = false;
  }
}

/**
 * Expand la tasklist
 * @param {HTMLElement} taskMessage - L'élément task-message
 * @param {boolean} autoClose - Si true, ferme automatiquement après 3s
 */
function expandTasklist(taskMessage, autoClose = false) {
  // Annuler tout timer en cours
  if (sessionTasklistState.autoCloseTimer) {
    clearTimeout(sessionTasklistState.autoCloseTimer);
    sessionTasklistState.autoCloseTimer = null;
  }

  taskMessage.classList.remove('collapsed');
  taskMessage.classList.add('expanded');
  sessionTasklistState.isExpanded = true;

  // Auto-scroll vers la tâche en cours
  setTimeout(() => scrollToActiveTask(taskMessage), 100);

  if (autoClose) {
    sessionTasklistState.autoCloseTimer = setTimeout(() => {
      collapseTasklist(taskMessage);
      sessionTasklistState.autoCloseTimer = null;
    }, 3000);
  }
}

/**
 * Collapse la tasklist
 */
function collapseTasklist(taskMessage) {
  taskMessage.classList.remove('expanded');
  taskMessage.classList.add('collapsed');
  sessionTasklistState.isExpanded = false;

  // Annuler le timer si présent
  if (sessionTasklistState.autoCloseTimer) {
    clearTimeout(sessionTasklistState.autoCloseTimer);
    sessionTasklistState.autoCloseTimer = null;
  }
}

/**
 * Scroll vers la tâche en cours (in_progress) ou la première non complétée
 * Si toutes les tâches sont completed, scroll vers le bas
 */
function scrollToActiveTask(taskMessage) {
  const taskList = taskMessage.querySelector('.task-list');
  if (!taskList) return;

  // Chercher la tâche in_progress ou la première pending
  const activeTask = taskList.querySelector('.task-item.task-in_progress') ||
                     taskList.querySelector('.task-item.task-pending');

  if (activeTask) {
    // Scroll vers la tâche active
    activeTask.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } else {
    // Toutes les tâches sont complétées, scroll vers le bas avec animation
    taskList.scrollTo({ top: taskList.scrollHeight, behavior: 'smooth' });
  }
}

/**
 * Ouvre temporairement la tasklist (peek) lors d'activité (nouveaux messages, tools)
 * Ne fait rien si l'utilisateur a manuellement ouvert la tasklist
 */
function triggerTasklistPeek() {
  // Ne pas interférer si l'utilisateur a ouvert manuellement
  if (sessionTasklistState.isUserExpanded) return;

  // Vérifier qu'il y a une tasklist visible
  const sessionTaskList = document.getElementById('session-task-list');
  if (!sessionTaskList || sessionTaskList.style.display === 'none') return;

  const taskMessage = sessionTaskList.querySelector('.task-message');
  if (!taskMessage) return;

  // Ouvrir avec auto-close de 3s
  expandTasklist(taskMessage, true);
}

/**
 * Met à jour uniquement les métadonnées de la session (statut, badge, etc.)
 */
function updateSessionMetadata(session) {
  // Mettre à jour le badge de statut
  const statusBadge = document.querySelector('.session-badge');
  if (statusBadge) {
    const statusLabels = {
      'thinking': 'Claude travaille...',
      'waiting': 'En attente',
      'idle': 'Inactif',
      'active': 'En cours'
    };
    const statusColor = session.status === 'thinking' ? 'status-thinking' :
                       session.status === 'waiting' ? 'status-waiting' : 'status-idle';
    statusBadge.className = `session-badge ${statusColor}`;
    statusBadge.textContent = statusLabels[session.status] || session.status;
  }

  // Mettre à jour le compteur de messages
  const messageCountEl = document.querySelector('.meta-item strong');
  if (messageCountEl && messageCountEl.textContent === 'Messages:') {
    const countSpan = messageCountEl.parentElement;
    if (countSpan) {
      countSpan.innerHTML = `<strong>Messages:</strong> ${session.messageCount}`;
    }
  }

  // Mettre à jour le widget de contexte si disponible
  if (session.contextUsage) {
    updateContextWidget(session.contextUsage);
  }
}

/**
 * Met à jour le widget de contexte de manière incrémentale (sans re-render complet)
 */
function updateContextWidget(contextUsage) {
  const widget = document.querySelector('.context-widget');
  if (!widget) return;

  const { estimatedTokens, maxTokens, percentage, breakdown, warningLevel, isEstimate } = contextUsage;

  // Couleurs selon le niveau d'alerte (cohérence pastille/barre)
  const colorMap = {
    'low': '#4caf50',      // Vert
    'medium': '#ff9800',   // Orange
    'high': '#f44336',     // Rouge
    'critical': '#d32f2f'  // Rouge foncé (dépassement)
  };
  const barColor = colorMap[warningLevel] || '#4caf50';

  // Icône selon le niveau (couleurs cohérentes avec la barre)
  const iconMap = {
    'low': '🟢',      // Vert
    'medium': '🟡',   // Jaune/Orange
    'high': '🟠',     // Orange
    'critical': '🔴'  // Rouge
  };
  const icon = iconMap[warningLevel] || '📊';

  // Formater les nombres
  const formatK = (n) => {
    if (n >= 1000) {
      return (n / 1000).toFixed(1) + 'K';
    }
    return n.toString();
  };

  // Mettre à jour les éléments
  const iconEl = widget.querySelector('.context-icon');
  if (iconEl) iconEl.textContent = icon;

  const percentageEl = widget.querySelector('.context-percentage');
  if (percentageEl) percentageEl.textContent = percentage.toFixed(1) + '%';

  const tokensEl = widget.querySelector('.context-tokens');
  if (tokensEl) tokensEl.textContent = `${formatK(estimatedTokens)} / ${formatK(maxTokens)}`;

  const fillEl = widget.querySelector('.context-progress-fill');
  if (fillEl) {
    fillEl.style.width = `${Math.min(100, percentage)}%`;
    fillEl.style.backgroundColor = barColor;
  }

  // Mettre à jour les détails du breakdown si visibles
  const detailsEl = widget.querySelector('.context-details');
  if (detailsEl && detailsEl.style.display !== 'none') {
    const totalTokens = breakdown.userMessages + breakdown.assistantMessages + breakdown.toolResults + breakdown.systemOverhead;
    const breakdownItems = widget.querySelectorAll('.context-breakdown-item .breakdown-value');
    if (breakdownItems.length >= 4) {
      breakdownItems[0].textContent = `${formatK(breakdown.userMessages)} (${(breakdown.userMessages / totalTokens * 100).toFixed(1)}%)`;
      breakdownItems[1].textContent = `${formatK(breakdown.assistantMessages)} (${(breakdown.assistantMessages / totalTokens * 100).toFixed(1)}%)`;
      breakdownItems[2].textContent = `${formatK(breakdown.toolResults)} (${(breakdown.toolResults / totalTokens * 100).toFixed(1)}%)`;
      breakdownItems[3].textContent = `${formatK(breakdown.systemOverhead)} (${(breakdown.systemOverhead / totalTokens * 100).toFixed(1)}%)`;
    }
  }
}

/**
 * Rend un seul message (utilisé pour le rendu incrémental)
 * Chaque message a un data-uuid pour permettre les mises à jour ciblées
 */
function renderSingleMessage(msg) {
  const uuid = msg.uuid || '';

  // Affichage des tool actions (Read, Edit, Write, Bash...)
  if (msg.role === 'tool_action' && msg.toolActions) {
    return `<div class="tool-action" data-uuid="${uuid}">${renderToolActionBadges(msg.toolActions)}</div>`;
  }

  // Les messages de type 'task' (TodoWrite) sont affichés dans session-task-list
  // Ne pas les rendre dans le flux de messages pour éviter les doublons
  if (msg.role === 'task' && msg.todos) {
    return ''; // Retourne vide, la tasklist est gérée par updateTaskMessage
  }

  // Affichage spécial pour AskUserQuestion
  if (msg.role === 'assistant' && msg.toolUse && msg.toolUse.name === 'AskUserQuestion') {
    return renderAskUserQuestionMessage(msg, uuid);
  }

  // Affichage spécial pour EnterPlanMode
  if (msg.role === 'assistant' && msg.toolUse && msg.toolUse.name === 'EnterPlanMode') {
    return renderPlanModeMessage(msg, uuid, 'enter');
  }

  // Affichage spécial pour ExitPlanMode
  if (msg.role === 'assistant' && msg.toolUse && msg.toolUse.name === 'ExitPlanMode') {
    return renderPlanModeMessage(msg, uuid, 'exit');
  }

  const time = new Date(msg.timestamp).toLocaleTimeString('fr-FR');
  const roleClass = msg.role === 'user' ? 'message-user' : 'message-assistant';
  const roleIcon = msg.role === 'user' ? '👤' : '🤖';
  const roleName = msg.role === 'user' ? 'Vous' : 'Claude';

  // Construire le HTML du message (si y'a du contenu)
  let html = '';

  if (msg.content && msg.content.trim()) {
    html += `
      <div class="message ${roleClass}" data-uuid="${uuid}">
        <div class="message-header">
          <span class="message-role">${roleIcon} ${roleName}</span>
          <span class="message-time">${time}</span>
        </div>
        <div class="message-content">${formatMessage(msg.content)}</div>
      </div>
    `;
  }

  // LEGACY CODE SUPPRIMÉ: les toolActions sont maintenant dans des messages tool_action séparés
  // (lignes 2267-2268 gèrent l'affichage)

  return html;
}

// ============================================================================
// Redimensionnement de la conversation
// ============================================================================

// État pour le redimensionnement
let resizeState = {
  isResizing: false,
  startY: 0,
  startHeight: 0
};

// Event handlers globaux (attachés une seule fois)
let globalResizeHandlersAttached = false;

function attachGlobalResizeHandlers() {
  if (globalResizeHandlersAttached) return;
  globalResizeHandlersAttached = true;

  document.addEventListener('mousemove', (e) => {
    if (!resizeState.isResizing) return;

    const container = document.getElementById('messages-container');
    if (!container) return;

    const deltaY = e.clientY - resizeState.startY;
    const newHeight = Math.max(200, Math.min(1200, resizeState.startHeight + deltaY));

    container.style.maxHeight = newHeight + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!resizeState.isResizing) return;

    const container = document.getElementById('messages-container');
    const card = document.querySelector('.messages-card');

    resizeState.isResizing = false;
    if (card) card.classList.remove('resizing');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    // Sauvegarder la hauteur dans localStorage
    if (container) {
      const currentHeight = parseInt(container.style.maxHeight) || container.offsetHeight;
      localStorage.setItem('conversationHeight', currentHeight);
      console.log('[Resize] Hauteur sauvegardée:', currentHeight);
    }
  });
}

/**
 * Initialise le redimensionnement de la conversation
 */
function initResizableConversation() {
  const messagesCard = document.querySelector('.messages-card');
  const resizeHandle = document.querySelector('.resize-handle');
  const messagesContainer = document.getElementById('messages-container');

  console.log('[Resize] Init:', {
    hasCard: !!messagesCard,
    hasHandle: !!resizeHandle,
    hasContainer: !!messagesContainer
  });

  if (!messagesCard || !resizeHandle || !messagesContainer) return;

  // Récupérer la hauteur sauvegardée ou utiliser la hauteur par défaut
  const savedHeight = localStorage.getItem('conversationHeight');
  if (savedHeight) {
    messagesContainer.style.maxHeight = savedHeight + 'px';
    console.log('[Resize] Hauteur restaurée:', savedHeight);
  }

  // Attacher les handlers globaux une seule fois
  attachGlobalResizeHandlers();

  // Retirer l'ancien listener s'il existe
  const oldHandler = resizeHandle._resizeHandler;
  if (oldHandler) {
    resizeHandle.removeEventListener('mousedown', oldHandler);
  }

  // Créer le nouveau handler
  const mouseDownHandler = (e) => {
    const container = document.getElementById('messages-container');
    const card = document.querySelector('.messages-card');
    if (!container || !card) return;

    console.log('[Resize] MouseDown - Start resize');

    resizeState.isResizing = true;
    resizeState.startY = e.clientY;
    resizeState.startHeight = container.offsetHeight;

    // Ajouter une classe pour indiquer qu'on est en train de redimensionner
    card.classList.add('resizing');
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';

    e.preventDefault();
    e.stopPropagation();
  };

  // Sauvegarder le handler pour pouvoir le retirer plus tard
  resizeHandle._resizeHandler = mouseDownHandler;
  resizeHandle.addEventListener('mousedown', mouseDownHandler);

  console.log('[Resize] Listeners attachés');
}

// ============================================================================
// Actions
// ============================================================================

async function handleSendMessage(sessionId) {
  const input = document.getElementById('message-input');
  const message = input.value.trim();

  if (!message) {
    alert('Veuillez entrer un message');
    return;
  }

  try {
    await sendMessage(sessionId, message);
    input.value = '';
    alert('Message envoyé ! Claude Code devrait le traiter prochainement.');

    // Recharger la session après 2 secondes
    setTimeout(() => {
      loadSessionDetail(sessionId);
    }, 2000);
  } catch (error) {
    alert(`Erreur: ${error.message}`);
  }
}

async function handleInjectMessage(sessionId) {
  const input = document.getElementById('message-input');
  const message = input.value.trim();

  if (!message) {
    showInjectionNotification('Veuillez entrer un message', 'error');
    return;
  }

  // Desactiver le bouton pendant l'envoi
  const sendBtn = document.querySelector('.message-actions .btn-primary');
  if (sendBtn) {
    sendBtn.disabled = true;
    sendBtn.textContent = 'Envoi...';
  }

  try {
    const result = await injectMessage(sessionId, message);

    if (result.success) {
      input.value = '';
      showInjectionNotification('Message envoyé via CDP', 'success');

      // Recharger immédiatement la session pour afficher le message utilisateur
      // loadSessionDetail va appeler manageSessionPolling qui reset le compteur idle
      await loadSessionDetail(sessionId);
    } else {
      showInjectionNotification(result.error || 'Echec de l\'envoi', 'error');
    }
  } catch (error) {
    showInjectionNotification(`Erreur: ${error.message}`, 'error');
  } finally {
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Envoyer';
    }
  }
}

/**
 * Gère l'interruption de la requête en cours
 * Envoie le message d'interruption et force l'arrêt de l'indicateur
 */
async function handleInterruptRequest(sessionId) {
  // Message d'interruption standard
  const message = '[Request interrupted by user]';

  try {
    // Envoyer le message d'interruption
    await injectMessage(sessionId, message);
    showInjectionNotification('Interruption envoyée...', 'info');

    // Forcer immédiatement le status à 'idle' côté frontend
    // (comme si on cliquait sur Stop dans Claude Desktop)
    if (sessions[sessionId]) {
      sessions[sessionId].status = 'idle';
      sessions[sessionId].isThinking = false;
      updateSessionPageIncremental(sessions[sessionId]);
    }

    // Recharger après 2 secondes pour synchroniser avec le backend
    setTimeout(() => {
      loadSessionDetail(sessionId);
    }, 2000);
  } catch (error) {
    showInjectionNotification(`Erreur: ${error.message}`, 'error');
  }
}

function showInjectionStatusModal() {
  // Supprimer l'ancienne modal
  const existing = document.getElementById('injection-status-modal');
  if (existing) existing.remove();

  if (!injectionStatus) {
    showInjectionNotification('Impossible de charger le statut', 'error');
    return;
  }

  const modal = document.createElement('div');
  modal.id = 'injection-status-modal';
  modal.className = 'injection-status-modal';

  const availableClass = injectionStatus.available ? 'status-available' : 'status-unavailable';
  const availableText = injectionStatus.available ? 'Disponible' : 'Non disponible';

  // Generer la liste des methodes
  const methodsHTML = Object.entries(injectionStatus.methodsStatus || {}).map(([method, status]) => {
    const statusClass = status.available ? 'method-available' : 'method-unavailable';
    const statusIcon = status.available ? '✅' : '❌';
    return `
      <div class="method-item ${statusClass}">
        <span class="method-icon">${statusIcon}</span>
        <span class="method-name">${method}</span>
      </div>
    `;
  }).join('');

  modal.innerHTML = `
    <div class="injection-modal-content">
      <div class="injection-modal-header">
        <h2>Statut d'injection</h2>
        <button onclick="document.getElementById('injection-status-modal').remove()" class="modal-close">×</button>
      </div>

      <div class="injection-status-body">
        <div class="status-main ${availableClass}">
          <span class="status-indicator-large"></span>
          <span class="status-text-large">${availableText}</span>
        </div>

        <div class="status-details">
          <div class="status-item">
            <strong>Methode detectee:</strong>
            <span>${injectionStatus.detectedMethod || 'Aucune'}</span>
          </div>

          <div class="status-item">
            <strong>Plateforme:</strong>
            <span>${injectionStatus.systemInfo?.platform || 'Inconnue'}</span>
          </div>

          ${injectionStatus.processInfo?.windowTitle ? `
            <div class="status-item">
              <strong>Fenetre:</strong>
              <span>${escapeHtml(injectionStatus.processInfo.windowTitle)}</span>
            </div>
          ` : ''}
        </div>

        <div class="methods-list">
          <h4>Methodes disponibles</h4>
          ${methodsHTML || '<p>Aucune methode disponible</p>'}
        </div>

        <div class="recommendation">
          <h4>Recommandation</h4>
          <p>${escapeHtml(injectionStatus.recommendation || 'Aucune')}</p>
        </div>

        ${injectionStatus.stats ? `
          <div class="injection-stats">
            <h4>Statistiques</h4>
            <div class="stats-grid">
              <div class="stat">
                <span class="stat-value">${injectionStatus.stats.totalInjections || 0}</span>
                <span class="stat-label">Total</span>
              </div>
              <div class="stat success">
                <span class="stat-value">${injectionStatus.stats.successfulInjections || 0}</span>
                <span class="stat-label">Reussies</span>
              </div>
              <div class="stat error">
                <span class="stat-value">${injectionStatus.stats.failedInjections || 0}</span>
                <span class="stat-label">Echouees</span>
              </div>
            </div>
          </div>
        ` : ''}
      </div>

      <div class="injection-modal-footer">
        <button onclick="loadInjectionStatus().then(showInjectionStatusModal)" class="btn btn-secondary">
          Rafraichir
        </button>
        <button onclick="document.getElementById('injection-status-modal').remove()" class="btn btn-primary">
          Fermer
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
}

// ============================================================================
// Permission Management
// ============================================================================

// OBSOLETE: Cette fonction n'est plus appelée car les permissions ne sont plus envoyées par WebSocket
// Les permissions sont maintenant chargées via loadPendingPermissions() en polling
function handlePermissionRequested(request) {
  // Ajouter a la liste si pas deja present
  if (!pendingPermissions.find(p => p.id === request.id)) {
    pendingPermissions.push(request);
  }

  // Jouer un son de notification
  playNotificationSound();

  // Vibrer sur mobile
  if (navigator.vibrate) {
    navigator.vibrate([200, 100, 200]);
  }

  // Afficher la modal
  showPermissionModal(request);

  console.log('[Permission] Nouvelle demande:', request);
}

function handlePermissionResponded(requestId, approved) {
  // Retirer de la liste
  pendingPermissions = pendingPermissions.filter(p => p.id !== requestId);

  // Arreter le timer
  if (permissionTimers[requestId]) {
    clearInterval(permissionTimers[requestId]);
    delete permissionTimers[requestId];
  }

  // Fermer la modal si c'est celle affichee
  hidePermissionModal(requestId);

  console.log(`[Permission] Reponse: ${requestId} - ${approved ? 'APPROVED' : 'REJECTED'}`);
}

// OBSOLETE: Ces fonctions ne sont plus appelées avec CDP
function handlePermissionTimeout(requestId) {
  pendingPermissions = pendingPermissions.filter(p => p.id !== requestId);

  if (permissionTimers[requestId]) {
    clearInterval(permissionTimers[requestId]);
    delete permissionTimers[requestId];
  }

  hidePermissionModal(requestId);

  console.log(`[Permission] Timeout: ${requestId}`);
}

// OBSOLETE: Ces fonctions ne sont plus appelées avec CDP
function handlePermissionCancelled(requestId) {
  pendingPermissions = pendingPermissions.filter(p => p.id !== requestId);

  if (permissionTimers[requestId]) {
    clearInterval(permissionTimers[requestId]);
    delete permissionTimers[requestId];
  }

  hidePermissionModal(requestId);
}

function showPermissionModal(request) {
  // Supprimer l'ancienne modal si elle existe
  const existingModal = document.getElementById('permission-modal');
  if (existingModal) {
    existingModal.remove();
  }

  // Creer la modal
  const modal = document.createElement('div');
  modal.id = 'permission-modal';
  modal.className = 'permission-modal';
  modal.dataset.requestId = request.id;

  const riskClass = `risk-${request.riskLevel || 'low'}`;
  const riskLabel = {
    'low': 'Faible',
    'medium': 'Moyen',
    'high': 'Eleve'
  }[request.riskLevel] || 'Inconnu';

  // Affichage spécial pour ExitPlanMode : montrer le plan de manière lisible
  let planDisplay = '';
  if (request.toolName === 'ExitPlanMode' && request.toolInput && request.toolInput.plan) {
    planDisplay = `
      <div class="permission-plan">
        <h3>📋 Plan proposé :</h3>
        <div class="plan-content">
          ${formatMessage(request.toolInput.plan)}
        </div>
      </div>
    `;
  }

  modal.innerHTML = `
    <div class="permission-modal-content">
      <div class="permission-modal-header">
        <h2>Autorisation requise</h2>
        <span class="permission-timer" id="permission-timer-${request.id}">5:00</span>
      </div>

      <div class="permission-details">
        <div class="permission-tool">
          <span class="permission-tool-icon">${getToolIcon(request.toolName)}</span>
          <span class="permission-tool-name">${escapeHtml(request.toolName)}</span>
          <span class="permission-risk ${riskClass}">${riskLabel}</span>
        </div>

        <div class="permission-description">
          ${escapeHtml(request.description || request.displayInput || formatToolDescription(request))}
        </div>

        ${planDisplay}

        <div class="permission-input">
          <pre>${escapeHtml(JSON.stringify(request.toolInput, null, 2))}</pre>
        </div>
      </div>

      <div class="permission-actions">
        <button class="btn btn-approve" onclick="respondToPermission('${request.id}', true, false)">
          Autoriser
        </button>
        <button class="btn btn-approve-all" onclick="respondToPermission('${request.id}', true, true)">
          Toujours autoriser
        </button>
        <button class="btn btn-reject" onclick="respondToPermission('${request.id}', false, false)">
          Refuser
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Demarrer le timer
  startPermissionTimer(request.id, request.expiresAt);
}

function hidePermissionModal(requestId) {
  const modal = document.getElementById('permission-modal');
  if (modal && modal.dataset.requestId === requestId) {
    modal.remove();
  }

  // S'il reste des permissions en attente, afficher la suivante
  if (pendingPermissions.length > 0) {
    showPermissionModal(pendingPermissions[0]);
  } else if (pendingQuestions.length > 0) {
    // Sinon, afficher une question si disponible
    showQuestionModal(pendingQuestions[0]);
  }
}

// ============================================================================
// Gestion des questions (AskUserQuestion)
// ============================================================================

function showQuestionModal(questionRequest) {
  // Supprimer l'ancienne modal si elle existe
  const existingModal = document.getElementById('question-modal');
  if (existingModal) {
    existingModal.remove();
  }

  // Creer la modal
  const modal = document.createElement('div');
  modal.id = 'question-modal';
  modal.className = 'permission-modal question-modal';
  modal.dataset.questionId = questionRequest.id;

  // Initialiser le compteur de question actuelle
  if (!modal.dataset.currentQuestion) {
    modal.dataset.currentQuestion = '0';
  }
  const currentQuestionIndex = parseInt(modal.dataset.currentQuestion || '0');
  const totalQuestions = (questionRequest.questions || []).length;

  // Afficher seulement la question actuelle (pagination)
  const questionsHTML = (questionRequest.questions || []).slice(currentQuestionIndex, currentQuestionIndex + 1).map((q, relativeIndex) => {
    const index = currentQuestionIndex + relativeIndex;
    const optionsHTML = (q.options || []).map((opt, optIndex) => `
      <button class="question-option-btn"
              onclick="selectQuestionOption('${questionRequest.id}', ${index}, '${escapeHtml(opt.label)}')"
              data-question="${index}"
              data-option="${optIndex}">
        <span class="option-label">${escapeHtml(opt.label)}</span>
        ${opt.description ? `<span class="option-desc">${escapeHtml(opt.description)}</span>` : ''}
      </button>
    `).join('');

    return `
      <div class="question-block" data-question-index="${index}">
        <div class="question-header-text">
          ${q.header ? `<span class="question-tag">${escapeHtml(q.header)}</span>` : ''}
          <span class="question-text">${escapeHtml(q.question)}</span>
        </div>
        <div class="question-options-grid">
          ${optionsHTML}
        </div>
        <div class="question-custom-input" style="display: none;">
          <input type="text" class="question-custom-text" placeholder="Votre réponse..." />
          <button class="btn btn-small" onclick="confirmCustomAnswer('${questionRequest.id}', ${index})">OK</button>
        </div>
        <button class="btn btn-small btn-other" onclick="showCustomInput('${questionRequest.id}', ${index})">
          Autre...
        </button>
      </div>
    `;
  }).join('');

  modal.innerHTML = `
    <div class="permission-modal-content question-modal-content">
      <div class="permission-modal-header">
        <h2>❓ Claude pose une question</h2>
        ${totalQuestions > 1 ? `<span class="question-progress">Question ${currentQuestionIndex + 1}/${totalQuestions}</span>` : ''}
      </div>

      <div class="question-container">
        ${questionsHTML}
      </div>

      <div class="question-actions">
        ${currentQuestionIndex > 0 ? `<button class="btn btn-secondary" onclick="previousQuestion('${questionRequest.id}')">← Précédent</button>` : ''}
        ${currentQuestionIndex < totalQuestions - 1
          ? `<button class="btn btn-primary" onclick="nextQuestion('${questionRequest.id}')" id="next-question-btn" disabled>Suivant →</button>`
          : `<button class="btn btn-approve" onclick="submitQuestionAnswers('${questionRequest.id}')" id="submit-question-btn" disabled>Envoyer les réponses</button>`
        }
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  modal.dataset.currentQuestion = currentQuestionIndex.toString();
}

// État des réponses sélectionnées
const selectedQuestionAnswers = {};

// Navigation entre les questions (pagination)
function nextQuestion(questionId) {
  const modal = document.getElementById('question-modal');
  if (!modal) return;

  const currentIndex = parseInt(modal.dataset.currentQuestion || '0');
  const questionRequest = pendingQuestions.find(q => q.id === questionId);
  if (!questionRequest) return;

  const totalQuestions = (questionRequest.questions || []).length;

  // Vérifier si la question actuelle a une réponse
  if (!selectedQuestionAnswers[questionId] || !selectedQuestionAnswers[questionId][currentIndex]) {
    alert('Veuillez répondre à cette question avant de continuer');
    return;
  }

  // Passer à la question suivante
  if (currentIndex < totalQuestions - 1) {
    modal.dataset.currentQuestion = (currentIndex + 1).toString();
    showQuestionModal(questionRequest);
  }
}

function previousQuestion(questionId) {
  const modal = document.getElementById('question-modal');
  if (!modal) return;

  const currentIndex = parseInt(modal.dataset.currentQuestion || '0');
  const questionRequest = pendingQuestions.find(q => q.id === questionId);
  if (!questionRequest) return;

  // Revenir à la question précédente
  if (currentIndex > 0) {
    modal.dataset.currentQuestion = (currentIndex - 1).toString();
    showQuestionModal(questionRequest);
  }
}

function selectQuestionOption(questionId, questionIndex, optionLabel) {
  // Initialiser si nécessaire
  if (!selectedQuestionAnswers[questionId]) {
    selectedQuestionAnswers[questionId] = {};
  }

  // Enregistrer la réponse
  selectedQuestionAnswers[questionId][questionIndex] = optionLabel;

  // Mettre à jour l'UI - désélectionner les autres options de cette question
  const questionBlock = document.querySelector(`[data-question-index="${questionIndex}"]`);
  if (questionBlock) {
    questionBlock.querySelectorAll('.question-option-btn').forEach(btn => {
      btn.classList.remove('selected');
    });
    // Sélectionner l'option cliquée
    const clickedBtn = questionBlock.querySelector(`[data-option][onclick*="'${optionLabel.replace(/'/g, "\\'")}'"]:not(.btn-other)`);
    if (clickedBtn) {
      clickedBtn.classList.add('selected');
    } else {
      // Fallback: chercher par contenu
      questionBlock.querySelectorAll('.question-option-btn').forEach(btn => {
        if (btn.querySelector('.option-label')?.textContent === optionLabel) {
          btn.classList.add('selected');
        }
      });
    }
  }

  // Vérifier si toutes les questions ont une réponse
  checkAllQuestionsAnswered(questionId);
}

function showCustomInput(questionId, questionIndex) {
  const questionBlock = document.querySelector(`[data-question-index="${questionIndex}"]`);
  if (questionBlock) {
    const customInput = questionBlock.querySelector('.question-custom-input');
    if (customInput) {
      customInput.style.display = 'flex';
      customInput.querySelector('input').focus();
    }
  }
}

function confirmCustomAnswer(questionId, questionIndex) {
  const questionBlock = document.querySelector(`[data-question-index="${questionIndex}"]`);
  if (questionBlock) {
    const input = questionBlock.querySelector('.question-custom-text');
    const value = input?.value?.trim();
    if (value) {
      selectQuestionOption(questionId, questionIndex, value);
      // Masquer l'input custom
      const customInput = questionBlock.querySelector('.question-custom-input');
      if (customInput) {
        customInput.style.display = 'none';
      }
    }
  }
}

function checkAllQuestionsAnswered(questionId) {
  const modal = document.getElementById('question-modal');
  if (!modal) return;

  const currentIndex = parseInt(modal.dataset.currentQuestion || '0');
  const questionRequest = pendingQuestions.find(q => q.id === questionId);
  if (!questionRequest) return;

  const totalQuestions = (questionRequest.questions || []).length;
  const answeredCount = Object.keys(selectedQuestionAnswers[questionId] || {}).length;

  // Activer le bouton "Suivant" si la question actuelle a une réponse
  const nextBtn = document.getElementById('next-question-btn');
  if (nextBtn) {
    const currentQuestionAnswered = selectedQuestionAnswers[questionId] && selectedQuestionAnswers[questionId][currentIndex];
    nextBtn.disabled = !currentQuestionAnswered;
  }

  // Activer le bouton "Envoyer" si toutes les questions sont répondues
  const submitBtn = document.getElementById('submit-question-btn');
  if (submitBtn) {
    submitBtn.disabled = answeredCount < totalQuestions;
  }
}

async function submitQuestionAnswers(questionId) {
  const answers = selectedQuestionAnswers[questionId];
  if (!answers) return;

  console.log('[Question] Envoi des réponses:', { questionId, answers });

  try {
    const response = await apiRequest('/api/question/respond', {
      method: 'POST',
      body: JSON.stringify({ questionId, answers })
    });

    console.log('[Question] Réponse du serveur:', response);

    // Nettoyer
    delete selectedQuestionAnswers[questionId];
    pendingQuestions = pendingQuestions.filter(q => q.id !== questionId);
    hideQuestionModal(questionId);

  } catch (error) {
    console.error('[Question] Erreur lors de la réponse:', error);
    console.error('[Question] Détails de l\'erreur:', error.message, error.stack);
    alert('Erreur lors de l\'envoi de la réponse: ' + (error.message || 'Erreur inconnue'));
  }
}

function hideQuestionModal(questionId) {
  const modal = document.getElementById('question-modal');
  if (modal && modal.dataset.questionId === questionId) {
    modal.remove();
  }

  // S'il reste des questions en attente, afficher la suivante
  if (pendingQuestions.length > 0) {
    showQuestionModal(pendingQuestions[0]);
  } else if (pendingPermissions.length > 0) {
    // Sinon, afficher une permission si disponible
    showPermissionModal(pendingPermissions[0]);
  }
}

function startPermissionTimer(requestId, expiresAt) {
  const timerElement = document.getElementById(`permission-timer-${requestId}`);
  if (!timerElement) return;

  const updateTimer = () => {
    const now = new Date();
    const expires = new Date(expiresAt);
    const remaining = Math.max(0, expires - now);

    if (remaining <= 0) {
      timerElement.textContent = 'Expire!';
      clearInterval(permissionTimers[requestId]);
      return;
    }

    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    timerElement.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;

    // Changer la couleur si moins de 30 secondes
    if (remaining < 30000) {
      timerElement.classList.add('timer-critical');
    }
  };

  updateTimer();
  permissionTimers[requestId] = setInterval(updateTimer, 1000);
}

// Variable pour éviter les doubles clics
const respondingPermissions = new Set();

async function respondToPermission(requestId, allow, alwaysAllow = false) {
  // Empêcher les doubles clics
  if (respondingPermissions.has(requestId)) {
    console.warn('[Permission] Réponse déjà en cours pour', requestId);
    return;
  }

  respondingPermissions.add(requestId);

  try {
    // Désactiver les boutons immédiatement
    const modal = document.getElementById('permission-modal');
    if (modal) {
      const buttons = modal.querySelectorAll('button');
      buttons.forEach(btn => btn.disabled = true);
    }

    // CDP-only: envoyer la décision
    const decision = alwaysAllow ? 'always' : (allow ? 'once' : 'deny');
    const response = await apiRequest('/api/permission/respond', {
      method: 'POST',
      body: JSON.stringify({
        requestId: requestId,
        decision: decision
      })
    });

    console.log('[Permission] Reponse envoyee:', response);

    // Feedback visuel
    if (modal) {
      modal.classList.add(allow ? 'approved' : 'rejected');
      if (alwaysAllow) {
        modal.classList.add('always-approved');
      }
      setTimeout(() => hidePermissionModal(requestId), 300);
    }

  } catch (error) {
    console.error('[Permission] Erreur:', error);
    alert('Erreur lors de la reponse: ' + error.message);

    // Réactiver les boutons en cas d'erreur
    const modal = document.getElementById('permission-modal');
    if (modal) {
      const buttons = modal.querySelectorAll('button');
      buttons.forEach(btn => btn.disabled = false);
    }
  } finally {
    // Toujours retirer de la liste après un délai
    setTimeout(() => {
      respondingPermissions.delete(requestId);
    }, 1000);
  }
}

function formatToolDescription(request) {
  const toolName = request.toolName;
  const input = request.toolInput || {};

  switch (toolName) {
    case 'Bash':
      return `Executer: ${input.command || 'commande'}`;
    case 'Edit':
      return `Modifier: ${input.file_path || 'fichier'}`;
    case 'Write':
      return `Ecrire: ${input.file_path || 'fichier'}`;
    case 'Read':
      return `Lire: ${input.file_path || 'fichier'}`;
    case 'WebFetch':
      const url = input.url || 'URL';
      const truncatedUrl = url.length > 50 ? url.substring(0, 50) + '...' : url;
      return `Fetch Web: ${truncatedUrl}`;
    case 'WebSearch':
      const query = input.query || 'recherche';
      const truncatedQuery = query.length > 40 ? query.substring(0, 40) + '...' : query;
      return `Recherche Web: "${truncatedQuery}"`;
    default:
      return `${toolName}`;
  }
}

function playNotificationSound() {
  try {
    // Creer un contexte audio
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.frequency.value = 800;
    oscillator.type = 'sine';

    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);

    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.3);
  } catch (e) {
    // Ignorer si audio non supporte
  }
}

// Afficher le badge de permissions en attente
function renderPermissionBadge() {
  const existingBadge = document.getElementById('permission-badge');
  if (existingBadge) {
    existingBadge.remove();
  }

  if (pendingPermissions.length === 0) return;

  const badge = document.createElement('div');
  badge.id = 'permission-badge';
  badge.className = 'permission-badge pulse';
  badge.innerHTML = `
    <span class="badge-count">${pendingPermissions.length}</span>
    <span class="badge-text">autorisation${pendingPermissions.length > 1 ? 's' : ''}</span>
  `;
  badge.onclick = () => {
    if (pendingPermissions.length > 0) {
      showPermissionModal(pendingPermissions[0]);
    }
  };

  document.body.appendChild(badge);
}

// ============================================================================
// Nouvelle Session Management
// ============================================================================

/**
 * Récupérer les chemins récents depuis localStorage
 */
function getRecentPaths() {
  try {
    const stored = localStorage.getItem(RECENT_PATHS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch (e) {
    return [];
  }
}

/**
 * Ajouter un chemin aux récents
 */
function addToRecentPaths(path) {
  const recents = getRecentPaths().filter(p => p !== path);
  recents.unshift(path);
  const trimmed = recents.slice(0, MAX_RECENT_PATHS);
  localStorage.setItem(RECENT_PATHS_KEY, JSON.stringify(trimmed));
}

// ============================================================================
// Gestion des favoris (via API serveur pour persistance)
// ============================================================================

// Cache des favoris côté client (mis à jour via API)
let favoritesCache = [];

/**
 * Charger les favoris depuis le serveur
 */
async function loadFavorites() {
  try {
    const data = await apiRequest('/api/favorites');
    favoritesCache = data.favorites || [];
    return favoritesCache;
  } catch (error) {
    console.error('Erreur lors du chargement des favoris:', error);
    // Fallback sur localStorage en cas d'erreur
    try {
      const stored = localStorage.getItem(FAVORITE_PATHS_KEY);
      favoritesCache = stored ? JSON.parse(stored) : [];
    } catch (e) {
      favoritesCache = [];
    }
    return favoritesCache;
  }
}

/**
 * Récupérer les chemins favoris (depuis le cache)
 */
function getFavoritePaths() {
  // Retourner uniquement les chemins (paths) des favoris
  return favoritesCache.map(f => f.path);
}

/**
 * Obtenir le surnom d'un favori
 */
function getFavoriteNickname(path) {
  const favorite = favoritesCache.find(f => f.path === path);
  return favorite?.nickname || null;
}

/**
 * Ajouter/Retirer un chemin des favoris (via API)
 */
async function toggleFavoritePath(path) {
  const isFavorite = getFavoritePaths().includes(path);

  try {
    if (isFavorite) {
      // Retirer des favoris
      await apiRequest('/api/favorites', {
        method: 'DELETE',
        body: JSON.stringify({ path })
      });
    } else {
      // Ajouter aux favoris
      await apiRequest('/api/favorites', {
        method: 'POST',
        body: JSON.stringify({ path })
      });
    }

    // Recharger les favoris depuis le serveur
    await loadFavorites();
    return !isFavorite; // true si ajouté, false si retiré
  } catch (error) {
    console.error('Erreur lors du toggle favori:', error);
    // Fallback sur localStorage en cas d'erreur
    const favorites = getFavoritePaths();
    const index = favorites.indexOf(path);
    if (index === -1) {
      favorites.unshift(path);
    } else {
      favorites.splice(index, 1);
    }
    localStorage.setItem(FAVORITE_PATHS_KEY, JSON.stringify(favorites));
    return index === -1;
  }
}

/**
 * Vérifier si un chemin est favori
 */
function isPathFavorite(path) {
  return getFavoritePaths().includes(path);
}

/**
 * Mettre à jour le surnom d'un favori (via API)
 */
async function updateFavoriteNickname(path, nickname) {
  try {
    await apiRequest('/api/favorites', {
      method: 'PATCH',
      body: JSON.stringify({ path, nickname })
    });
    await loadFavorites();
    return true;
  } catch (error) {
    console.error('Erreur lors de la mise à jour du surnom:', error);
    return false;
  }
}

/**
 * Supprimer un favori (via API)
 */
async function removeFavorite(path) {
  try {
    await apiRequest('/api/favorites', {
      method: 'DELETE',
      body: JSON.stringify({ path })
    });
    await loadFavorites();
    return true;
  } catch (error) {
    console.error('Erreur lors de la suppression du favori:', error);
    return false;
  }
}

/**
 * Supprimer un chemin des récents
 */
function removeFromRecentPaths(path) {
  const recents = getRecentPaths().filter(p => p !== path);
  localStorage.setItem(RECENT_PATHS_KEY, JSON.stringify(recents));
}

/**
 * Afficher le modal de création de nouvelle session
 */
async function showNewSessionModal() {
  // Supprimer l'ancienne modal si elle existe
  const existingModal = document.getElementById('new-session-modal');
  if (existingModal) {
    existingModal.remove();
  }

  // Charger les favoris depuis le serveur
  await loadFavorites();

  const favorites = getFavoritePaths();
  const recents = getRecentPaths();

  // Extraire les chemins des sessions existantes
  const sessionPaths = Object.values(sessions)
    .map(s => s.cwd)
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i); // Unique

  const modal = document.createElement('div');
  modal.id = 'new-session-modal';
  modal.className = 'new-session-modal';

  // Générer la liste des favoris avec surnoms
  const favoritesHTML = favorites.length > 0 ? `
    <div class="path-section">
      <div class="path-section-header">
        <h3>${i18n.t('newSessionModal.favorites')}</h3>
        <button class="btn btn-small" onclick="event.stopPropagation(); showManageFavoritesModal()" title="${i18n.t('newSessionModal.manageFavorites')}">
          ⚙️ ${i18n.t('newSessionModal.manageFavorites')}
        </button>
      </div>
      <div class="path-list">
        ${favorites.map(path => {
          const nickname = getFavoriteNickname(path);
          const displayName = nickname || truncatePath(path);
          return `
          <div class="path-item" onclick="selectPathForNewSession('${escapeHtml(path.replace(/\\/g, '\\\\').replace(/'/g, "\\'"))}')">
            <span class="path-icon">📁</span>
            <div class="path-text-container">
              <span class="path-text" title="${escapeHtml(path)}">${escapeHtml(displayName)}</span>
              ${nickname ? `<span class="path-subtext">${escapeHtml(truncatePath(path))}</span>` : ''}
            </div>
            <button class="path-action" onclick="event.stopPropagation(); toggleFavoriteAndRefresh('${escapeHtml(path.replace(/\\/g, '\\\\').replace(/'/g, "\\'"))}')" title="${i18n.t('newSessionModal.removeFromFavorites')}">
              ⭐
            </button>
          </div>
        `}).join('')}
      </div>
    </div>
  ` : '';

  // Générer la liste des récents (exclure les favoris)
  const recentsFiltered = recents.filter(p => !favorites.includes(p));
  const recentsHTML = recentsFiltered.length > 0 ? `
    <div class="path-section">
      <h3>${i18n.t('newSessionModal.recents')}</h3>
      <div class="path-list">
        ${recentsFiltered.map(path => `
          <div class="path-item" onclick="selectPathForNewSession('${escapeHtml(path.replace(/\\/g, '\\\\').replace(/'/g, "\\'"))}')">
            <span class="path-icon">📁</span>
            <span class="path-text" title="${escapeHtml(path)}">${escapeHtml(truncatePath(path))}</span>
            <button class="path-action" onclick="event.stopPropagation(); toggleFavoriteAndRefresh('${escapeHtml(path.replace(/\\/g, '\\\\').replace(/'/g, "\\'"))}')" title="${i18n.t('newSessionModal.addToFavorites')}">
              ☆
            </button>
            <button class="path-action path-action-remove" onclick="event.stopPropagation(); removeRecentAndRefresh('${escapeHtml(path.replace(/\\/g, '\\\\').replace(/'/g, "\\'"))}')" title="${i18n.t('app.delete')}">
              ×
            </button>
          </div>
        `).join('')}
      </div>
    </div>
  ` : '';

  // Générer la liste des projets actifs (sessions existantes, exclure favoris et récents)
  const projectsFiltered = sessionPaths.filter(p => !favorites.includes(p) && !recents.includes(p));
  const projectsHTML = projectsFiltered.length > 0 ? `
    <div class="path-section">
      <h3>${i18n.t('newSessionModal.projects')}</h3>
      <div class="path-list">
        ${projectsFiltered.map(path => `
          <div class="path-item" onclick="selectPathForNewSession('${escapeHtml(path.replace(/\\/g, '\\\\').replace(/'/g, "\\'"))}')">
            <span class="path-icon">📁</span>
            <span class="path-text" title="${escapeHtml(path)}">${escapeHtml(truncatePath(path))}</span>
            <button class="path-action" onclick="event.stopPropagation(); toggleFavoriteAndRefresh('${escapeHtml(path.replace(/\\/g, '\\\\').replace(/'/g, "\\'"))}')" title="${i18n.t('newSessionModal.addToFavorites')}">
              ☆
            </button>
          </div>
        `).join('')}
      </div>
    </div>
  ` : '';

  modal.innerHTML = `
    <div class="new-session-modal-content">
      <div class="new-session-modal-header">
        <h2>${i18n.t('newSessionModal.title')}</h2>
        <button onclick="hideNewSessionModal()" class="modal-close">×</button>
      </div>

      <div class="new-session-modal-body">
        <div class="name-input-section">
          <label for="new-session-name">${i18n.t('newSessionModal.nameLabel')}</label>
          <div class="name-input-wrapper">
            <input
              type="text"
              id="new-session-name"
              placeholder="${i18n.t('newSessionModal.namePlaceholder')}"
              autocomplete="off"
              maxlength="100"
            />
          </div>
          <p class="path-hint">${i18n.t('newSessionModal.nameHint')}</p>
        </div>

        <div class="path-input-section">
          <label for="new-session-path">${i18n.t('newSessionModal.pathLabel')}</label>
          <div class="path-input-wrapper">
            <input
              type="text"
              id="new-session-path"
              placeholder="${i18n.t('newSessionModal.pathPlaceholder')}"
              autocomplete="off"
            />
          </div>
          <p class="path-hint">${i18n.t('newSessionModal.pathHint')}</p>
        </div>

        <div class="message-input-section">
          <label for="new-session-message">${i18n.t('newSessionModal.messageLabel')}</label>
          <div class="message-input-wrapper">
            <textarea
              id="new-session-message"
              placeholder="${i18n.t('newSessionModal.messagePlaceholder')}"
              rows="3"
            ></textarea>
          </div>
          <p class="path-hint">${i18n.t('newSessionModal.messageHint')}</p>
        </div>

        ${favoritesHTML}
        ${recentsHTML}
        ${projectsHTML}

        ${favorites.length === 0 && recentsFiltered.length === 0 && projectsFiltered.length === 0 ? `
          <div class="empty-paths">
            <p>${i18n.t('newSessionModal.noPathsRecorded')}</p>
            <p class="path-hint">${i18n.t('newSessionModal.pathsWillAppearHere')}</p>
          </div>
        ` : ''}
      </div>

      <div class="new-session-modal-footer">
        <button onclick="hideNewSessionModal()" class="btn btn-secondary">
          ${i18n.t('newSessionModal.cancelBtn')}
        </button>
        <button onclick="createNewSessionFromModal()" class="btn btn-primary" id="create-session-btn">
          ${i18n.t('newSessionModal.launchBtn')}
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Focus sur l'input nom de session
  setTimeout(() => {
    const nameInput = document.getElementById('new-session-name');
    if (nameInput) nameInput.focus();
  }, 100);

  // Permettre de valider avec Entrée sur tous les champs
  const nameInput = document.getElementById('new-session-name');
  const pathInput = document.getElementById('new-session-path');

  if (nameInput) {
    nameInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        pathInput?.focus();
      }
    });
  }

  if (pathInput) {
    pathInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const messageInput = document.getElementById('new-session-message');
        messageInput?.focus();
      }
    });
  }
}

/**
 * Fermer le modal de nouvelle session
 */
function hideNewSessionModal() {
  const modal = document.getElementById('new-session-modal');
  if (modal) {
    modal.remove();
  }
}

/**
 * Afficher le modal de gestion des favoris
 */
async function showManageFavoritesModal() {
  // Fermer le modal de nouvelle session
  hideNewSessionModal();

  // Charger les favoris depuis le serveur
  await loadFavorites();

  const modal = document.createElement('div');
  modal.id = 'manage-favorites-modal';
  modal.className = 'new-session-modal'; // Réutiliser le même style

  const favorites = favoritesCache; // Utiliser le cache complet (avec nicknames)

  modal.innerHTML = `
    <div class="new-session-modal-content">
      <div class="new-session-modal-header">
        <h2>${i18n.t('newSessionModal.manageFavoritesTitle')}</h2>
        <button onclick="hideManageFavoritesModal()" class="modal-close">×</button>
      </div>

      <div class="new-session-modal-body">
        ${favorites.length === 0 ? `
          <div class="empty-state">
            <p>${i18n.t('newSessionModal.noFavorites')}</p>
            <p>${i18n.t('newSessionModal.addFavoritesHint')}</p>
          </div>
        ` : `
          <div class="favorites-list">
            ${favorites.map((fav, index) => `
              <div class="favorite-item" data-path="${escapeHtml(fav.path)}">
                <div class="favorite-item-content">
                  <span class="path-icon">📁</span>
                  <div class="favorite-item-details">
                    <input
                      type="text"
                      class="favorite-nickname-input"
                      value="${escapeHtml(fav.nickname || '')}"
                      placeholder="${i18n.t('newSessionModal.nicknamePlaceholder')}"
                      onchange="updateFavoriteNicknameFromInput('${escapeHtml(fav.path.replace(/\\/g, '\\\\').replace(/'/g, "\\'"))}', this.value)"
                    />
                    <span class="favorite-path" title="${escapeHtml(fav.path)}">${escapeHtml(fav.path)}</span>
                  </div>
                </div>
                <div class="favorite-item-actions">
                  <button
                    class="btn btn-small btn-danger"
                    onclick="removeFavoriteAndRefresh('${escapeHtml(fav.path.replace(/\\/g, '\\\\').replace(/'/g, "\\'"))}')"
                    title="${i18n.t('app.delete')}"
                  >
                    🗑️ ${i18n.t('app.delete')}
                  </button>
                </div>
              </div>
            `).join('')}
          </div>
        `}

        <div class="modal-footer">
          <button onclick="hideManageFavoritesModal(); showNewSessionModal()" class="btn">
            ${t('app.backBtn')}
          </button>
          ${favorites.length > 0 ? `
            <button onclick="clearAllFavoritesAndRefresh()" class="btn btn-danger">
              🗑️ ${t('app.deleteAll')}
            </button>
          ` : ''}
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Fermer en cliquant à l'extérieur
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      hideManageFavoritesModal();
    }
  });
}

/**
 * Cacher le modal de gestion des favoris
 */
function hideManageFavoritesModal() {
  const modal = document.getElementById('manage-favorites-modal');
  if (modal) {
    modal.remove();
  }
}

/**
 * Mettre à jour le surnom depuis l'input
 */
async function updateFavoriteNicknameFromInput(path, nickname) {
  const trimmed = nickname.trim();
  if (trimmed) {
    await updateFavoriteNickname(path, trimmed);
  }
  // Rafraîchir le modal
  await showManageFavoritesModal();
}

/**
 * Supprimer un favori et rafraîchir
 */
async function removeFavoriteAndRefresh(path) {
  if (confirm(`Supprimer ce favori ?\n\n${path}`)) {
    await removeFavorite(path);
    await showManageFavoritesModal();
  }
}

/**
 * Tout supprimer et rafraîchir
 */
async function clearAllFavoritesAndRefresh() {
  if (confirm('Êtes-vous sûr de vouloir supprimer TOUS les favoris ?')) {
    try {
      await apiRequest('/api/favorites/all', { method: 'DELETE' });
      await loadFavorites();
      await showManageFavoritesModal();
    } catch (error) {
      console.error('Erreur lors de la suppression des favoris:', error);
      alert('Erreur lors de la suppression des favoris');
    }
  }
}

/**
 * Sélectionner un chemin pour la nouvelle session
 */
function selectPathForNewSession(path) {
  const input = document.getElementById('new-session-path');
  if (input) {
    input.value = path;
    input.focus();
  }
}

/**
 * Toggle favori et rafraîchir le modal
 */
async function toggleFavoriteAndRefresh(path) {
  await toggleFavoritePath(path);
  await showNewSessionModal(); // Rafraîchir
}

/**
 * Supprimer des récents et rafraîchir le modal
 */
function removeRecentAndRefresh(path) {
  removeFromRecentPaths(path);
  showNewSessionModal(); // Rafraîchir
}

/**
 * Tronquer un chemin pour l'affichage
 */
function truncatePath(path, maxLength = 50) {
  if (path.length <= maxLength) return path;

  // Essayer de garder le nom du projet visible
  const parts = path.split(/[/\\]/);
  const projectName = parts[parts.length - 1] || parts[parts.length - 2];

  if (projectName && projectName.length < maxLength - 5) {
    return '...' + path.slice(-(maxLength - 3));
  }

  return path.slice(0, 20) + '...' + path.slice(-27);
}

/**
 * Créer une nouvelle session depuis le modal
 */
async function createNewSessionFromModal() {
  const nameInput = document.getElementById('new-session-name');
  const pathInput = document.getElementById('new-session-path');
  const messageInput = document.getElementById('new-session-message');
  const createBtn = document.getElementById('create-session-btn');

  if (!nameInput || !pathInput || !messageInput) return;

  const sessionName = nameInput.value.trim();
  const cwd = pathInput.value.trim();
  const message = messageInput.value.trim();

  if (!sessionName) {
    showNewSessionNotification('Veuillez entrer un nom pour la session', 'error');
    nameInput.focus();
    return;
  }

  if (!cwd) {
    showNewSessionNotification('Veuillez entrer un chemin de dossier', 'error');
    pathInput.focus();
    return;
  }

  if (!message) {
    showNewSessionNotification('Veuillez entrer un message initial', 'error');
    messageInput.focus();
    return;
  }

  // Désactiver le bouton pendant la création
  if (createBtn) {
    createBtn.disabled = true;
    createBtn.innerHTML = '⏳ Création en cours...';
  }

  try {
    // Envoyer le nom de session via les options
    const response = await apiRequest('/api/new-session', {
      method: 'POST',
      body: JSON.stringify({
        cwd,
        message,
        options: { title: sessionName }
      })
    });

    if (response.success) {
      // Ajouter aux récents
      addToRecentPaths(cwd);

      // Fermer le modal
      hideNewSessionModal();

      // Récupérer le sessionId
      const sessionId = response.session?.sessionId;

      if (sessionId) {
        // Notification immédiate avec le nom choisi par l'utilisateur
        showNewSessionNotification(`Session "${sessionName}" créée!`, 'success');

        // Recharger les sessions et naviguer vers la nouvelle session
        await loadSessions();
        renderHomePage();
        goToSession(sessionId);
      } else {
        // Pas de sessionId, comportement fallback
        showNewSessionNotification(i18n.t('newSessionModal.sessionCreated'), 'success');
        setTimeout(async () => {
          await loadSessions();
          renderHomePage();
        }, 1500);
      }
    } else {
      showNewSessionNotification(response.error || i18n.t('newSessionModal.errorCreating'), 'error');
    }
  } catch (error) {
    console.error('Erreur création session:', error);
    showNewSessionNotification(i18n.t('newSessionModal.errorMessage', { message: error.message }), 'error');
  } finally {
    if (createBtn) {
      createBtn.disabled = false;
      createBtn.innerHTML = '🚀 Lancer la session';
    }
  }
}

/**
 * Afficher une notification pour la création de session
 */
function showNewSessionNotification(message, type = 'info') {
  // Supprimer l'ancienne notification si elle existe
  const existing = document.getElementById('new-session-notification');
  if (existing) existing.remove();

  const notification = document.createElement('div');
  notification.id = 'new-session-notification';
  notification.className = `new-session-notification ${type}`;
  notification.innerHTML = `
    <span class="notification-icon">${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}</span>
    <span class="notification-message">${escapeHtml(message)}</span>
  `;

  document.body.appendChild(notification);

  // Auto-supprimer après 4 secondes
  setTimeout(() => {
    if (notification.parentNode) {
      notification.classList.add('fade-out');
      setTimeout(() => notification.remove(), 300);
    }
  }, 4000);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Obtenir l'icône pour un outil
 */
function getToolIcon(toolName) {
  const icons = {
    'Read': '📖',
    'Edit': '✏️',
    'Write': '📝',
    'Bash': '💻',
    'Glob': '🔍',
    'Grep': '🔎',
    'Task': '🤖',
    'WebFetch': '🌐',
    'WebSearch': '🔗',
    'NotebookEdit': '📓',
    'TodoWrite': '✅',
    'AskUserQuestion': '❓'
  };
  return icons[toolName] || '⚙️';
}

/**
 * Obtenir un aperçu des inputs d'un outil
 */
function getToolInputPreview(tool) {
  if (!tool.input) return '<em>pas de paramètres</em>';

  const input = tool.input;

  switch (tool.name) {
    case 'Read':
      return `<code>${escapeHtml(input.file_path || '')}</code>`;
    case 'Edit':
    case 'Write':
      return `<code>${escapeHtml(input.file_path || '')}</code>`;
    case 'Bash':
      const cmd = input.command || '';
      const preview = cmd.length > 60 ? cmd.substring(0, 60) + '...' : cmd;
      return `<code>${escapeHtml(preview)}</code>`;
    case 'Glob':
      return `<code>${escapeHtml(input.pattern || '')}</code>`;
    case 'Grep':
      return `<code>${escapeHtml(input.pattern || '')}</code>`;
    case 'WebFetch':
    case 'WebSearch':
      return `<code>${escapeHtml(input.url || input.query || '')}</code>`;
    case 'TodoWrite':
      const count = Array.isArray(input.todos) ? input.todos.length : 0;
      return `${count} tâche(s)`;
    default:
      // Afficher un aperçu générique
      const keys = Object.keys(input);
      if (keys.length === 0) return '<em>pas de paramètres</em>';
      const firstKey = keys[0];
      const firstValue = String(input[firstKey] || '');
      const truncated = firstValue.length > 40 ? firstValue.substring(0, 40) + '...' : firstValue;
      return `${firstKey}: <code>${escapeHtml(truncated)}</code>`;
  }
}

/**
 * Parse et formate le Markdown en HTML
 * Supporte: gras, italique, code inline, blocs de code, listes, tableaux, titres, liens
 */
function formatMessage(content) {
  if (!content) return '';

  // Utiliser des placeholders uniques qui ne seront pas affectés par escapeHtml ou le parsing Markdown
  const PLACEHOLDER_PREFIX = '\u0000CODEBLOCK';
  const INLINE_PREFIX = '\u0000INLINECODE';

  // Sauvegarder les blocs de code pour les protéger du parsing
  const codeBlocks = [];
  let formatted = content.replace(/```(\w*)\n?([\s\S]*?)```/g, (match, lang, code) => {
    const index = codeBlocks.length;
    codeBlocks.push({ lang, code: escapeHtml(code.trim()) });
    return `${PLACEHOLDER_PREFIX}${index}\u0000`;
  });

  // Sauvegarder le code inline
  const inlineCode = [];
  formatted = formatted.replace(/`([^`]+)`/g, (match, code) => {
    const index = inlineCode.length;
    inlineCode.push(escapeHtml(code));
    return `${INLINE_PREFIX}${index}\u0000`;
  });

  // Escape HTML pour le reste
  formatted = escapeHtml(formatted);

  // Titres (### Titre)
  formatted = formatted.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  formatted = formatted.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  formatted = formatted.replace(/^# (.+)$/gm, '<h2>$1</h2>');

  // Gras et italique (ordre important)
  formatted = formatted.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  formatted = formatted.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  formatted = formatted.replace(/\*(.+?)\*/g, '<em>$1</em>');
  formatted = formatted.replace(/___(.+?)___/g, '<strong><em>$1</em></strong>');
  formatted = formatted.replace(/__(.+?)__/g, '<strong>$1</strong>');
  formatted = formatted.replace(/_(.+?)_/g, '<em>$1</em>');

  // Liens [texte](url) - avec validation de sécurité
  formatted = formatted.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
    // Whitelist des protocoles sûrs (bloque javascript:, data:, etc.)
    const safeProtocolRegex = /^(https?|ftp):\/\//i;
    if (!safeProtocolRegex.test(url)) {
      // Si pas de protocole sûr, retourner le texte brut échappé
      return escapeHtml(match);
    }
    // URL et texte déjà échappés par escapeHtml() avant
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });

  // Tableaux Markdown
  formatted = formatMarkdownTables(formatted);

  // Listes à puces
  formatted = formatted.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
  formatted = formatted.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

  // Listes numérotées
  formatted = formatted.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Lignes horizontales
  formatted = formatted.replace(/^[-*_]{3,}$/gm, '<hr>');

  // Convertir les sauts de ligne (mais pas dans les listes/tableaux)
  formatted = formatted.replace(/\n/g, '<br>');

  // Nettoyer les <br> après les éléments de bloc
  formatted = formatted.replace(/<\/(h[2-4]|ul|ol|table|pre|hr)><br>/g, '</$1>');
  formatted = formatted.replace(/<br><(h[2-4]|ul|ol|table|pre|hr)/g, '<$1');

  // Restaurer le code inline
  inlineCode.forEach((code, index) => {
    const placeholder = `${INLINE_PREFIX}${index}\u0000`;
    formatted = formatted.split(placeholder).join(`<code class="inline-code">${code}</code>`);
  });

  // Restaurer les blocs de code
  codeBlocks.forEach((block, index) => {
    const placeholder = `${PLACEHOLDER_PREFIX}${index}\u0000`;
    const langClass = block.lang ? ` class="language-${block.lang}"` : '';
    formatted = formatted.split(placeholder).join(`<pre><code${langClass}>${block.code}</code></pre>`);
  });

  return formatted;
}

/**
 * Parse les tableaux Markdown
 */
function formatMarkdownTables(text) {
  const lines = text.split('\n');
  const result = [];
  let inTable = false;
  let tableRows = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Détecter une ligne de tableau (commence et finit par |)
    if (line.startsWith('|') && line.endsWith('|')) {
      // Ignorer la ligne de séparation (|---|---|)
      if (/^\|[\s\-:|]+\|$/.test(line)) {
        continue;
      }

      if (!inTable) {
        inTable = true;
        tableRows = [];
      }

      // Parser les cellules
      const cells = line.slice(1, -1).split('|').map(c => c.trim());
      tableRows.push(cells);
    } else {
      // Fin du tableau
      if (inTable) {
        result.push(buildHtmlTable(tableRows));
        inTable = false;
        tableRows = [];
      }
      result.push(lines[i]);
    }
  }

  // Tableau à la fin du texte
  if (inTable && tableRows.length > 0) {
    result.push(buildHtmlTable(tableRows));
  }

  return result.join('\n');
}

/**
 * Construit une table HTML à partir des lignes parsées
 */
function buildHtmlTable(rows) {
  if (rows.length === 0) return '';

  let html = '<table class="markdown-table">';

  // Première ligne = header
  html += '<thead><tr>';
  rows[0].forEach(cell => {
    html += `<th>${cell}</th>`;
  });
  html += '</tr></thead>';

  // Reste = body
  if (rows.length > 1) {
    html += '<tbody>';
    for (let i = 1; i < rows.length; i++) {
      html += '<tr>';
      rows[i].forEach(cell => {
        html += `<td>${cell}</td>`;
      });
      html += '</tr>';
    }
    html += '</tbody>';
  }

  html += '</table>';
  return html;
}

/**
 * Affiche un message AskUserQuestion avec un badge spécial
 */
function renderAskUserQuestionMessage(msg, uuid) {
  const time = new Date(msg.timestamp).toLocaleTimeString('fr-FR');

  // Extraire les questions si disponibles
  let questionsHTML = '';
  if (msg.toolUse && msg.toolUse.input && msg.toolUse.input.questions) {
    const questions = msg.toolUse.input.questions;
    questionsHTML = questions.map(q => {
      const optionsText = q.options ? q.options.map(opt => opt.label).join(', ') : '';
      return `
        <div class="question-item">
          <div class="question-text">❓ ${escapeHtml(q.question)}</div>
          ${optionsText ? `<div class="question-options">${escapeHtml(optionsText)}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  return `
    <div class="message message-assistant ask-user-question" data-uuid="${uuid}">
      <div class="message-header">
        <span class="message-role">🤖 Claude</span>
        <span class="message-time">${time}</span>
      </div>
      <div class="message-content">
        <div class="ask-user-badge">
          ❓ Claude pose une question
        </div>
        ${questionsHTML}
        <div class="ask-user-notice">
          💡 Consultez l'interface desktop pour répondre à cette question
        </div>
        ${msg.content ? `<div class="message-text">${formatMessage(msg.content)}</div>` : ''}
      </div>
    </div>
  `;
}

/**
 * Affiche un message EnterPlanMode ou ExitPlanMode avec un style spécial
 */
function renderPlanModeMessage(msg, uuid, type) {
  const time = new Date(msg.timestamp).toLocaleTimeString('fr-FR');
  const isEnter = type === 'enter';

  const icon = isEnter ? '📋' : '✅';
  const title = isEnter ? 'Mode Plan activé' : 'Plan terminé';
  const badgeClass = isEnter ? 'plan-mode-enter' : 'plan-mode-exit';

  return `
    <div class="message message-assistant ${badgeClass}" data-uuid="${uuid}">
      <div class="message-header">
        <span class="message-role">🤖 Claude</span>
        <span class="message-time">${time}</span>
      </div>
      <div class="message-content">
        <div class="plan-mode-badge ${badgeClass}-badge">
          ${icon} ${title}
        </div>
        ${msg.content ? `<div class="message-text">${formatMessage(msg.content)}</div>` : ''}
      </div>
    </div>
  `;
}

/**
 * Rendre les badges des tool actions (Read, Edit, Write, Bash, etc.)
 * Retourne uniquement les badges sans le wrapper div
 */
function renderToolActionBadges(toolActions) {
  if (!toolActions || toolActions.length === 0) return '';

  const toolIcons = {
    'Read': '📖',
    'Edit': '✏️',
    'Write': '📝',
    'Bash': '💻',
    'Glob': '🔍',
    'Grep': '🔎',
    'Task': '🤖',
    'WebFetch': '🌐',
    'WebSearch': '🔗',
    'NotebookEdit': '📓',
    'TodoWrite': '✅',
    'AskUserQuestion': '❓',
    'EnterPlanMode': '📋',
    'ExitPlanMode': '✅',
    'default': '⚙️'
  };

  const toolLabels = {
    'Read': 'Lu',
    'Edit': 'Modifié',
    'Write': 'Écrit',
    'Bash': 'Exécuté',
    'Glob': 'Recherché',
    'Grep': 'Grep',
    'Task': 'Agent',
    'WebFetch': 'Fetch',
    'WebSearch': 'Recherche',
    'NotebookEdit': 'Notebook',
    'TodoWrite': 'Todo',
    'AskUserQuestion': 'Question',
    'EnterPlanMode': 'Plan',
    'ExitPlanMode': 'Fin Plan'
  };

  return toolActions.map(action => {
    const icon = toolIcons[action.tool] || toolIcons['default'];
    const label = toolLabels[action.tool] || action.tool;
    const toolClass = `tool-${action.tool.toLowerCase()}`;
    const countLabel = action.count === 1 ? 'fichier' : 'fichiers';

    // Déterminer le label selon le type d'outil
    let displayLabel;
    if (['Bash'].includes(action.tool)) {
      displayLabel = `${action.count} commande${action.count > 1 ? 's' : ''}`;
    } else if (['Glob', 'Grep', 'WebSearch'].includes(action.tool)) {
      displayLabel = `${action.count} recherche${action.count > 1 ? 's' : ''}`;
    } else if (['Task'].includes(action.tool)) {
      displayLabel = `${action.count} agent${action.count > 1 ? 's' : ''}`;
    } else {
      displayLabel = `${action.count} ${countLabel}`;
    }

    return `
      <span class="tool-action-badge ${toolClass}" title="${action.files.join(', ')}">
        <span class="tool-icon">${icon}</span>
        <span class="tool-label">${label}</span>
        <span class="tool-count">${displayLabel}</span>
      </span>
    `;
  }).join('');
}

/**
 * Rendre les tool actions avec le wrapper div (pour compatibilité)
 */
function renderToolActions(toolActions) {
  if (!toolActions || toolActions.length === 0) return '';
  return `<div class="tool-action">${renderToolActionBadges(toolActions)}</div>`;
}

/**
 * Rendre un message de tâches (TodoWrite)
 * @param {Array} todos - Liste des tâches
 * @param {string} uuid - UUID optionnel pour le rendu incrémental
 * @param {boolean} isCollapsed - Si true, affiche en mode rétracté
 */
function renderTaskMessage(todos, uuid = '', isCollapsed = true) {
  if (!todos || todos.length === 0) return '';

  const statusIcons = {
    'pending': '⏳',
    'in_progress': '🔄',
    'completed': '✅'
  };

  const statusLabels = {
    'pending': 'En attente',
    'in_progress': 'En cours',
    'completed': 'Terminé'
  };

  // Compter les tâches par statut
  const counts = {
    pending: todos.filter(t => t.status === 'pending').length,
    in_progress: todos.filter(t => t.status === 'in_progress').length,
    completed: todos.filter(t => t.status === 'completed').length
  };

  const total = todos.length;
  const progress = total > 0 ? Math.round((counts.completed / total) * 100) : 0;

  const tasksHTML = todos.map(todo => {
    const icon = statusIcons[todo.status] || '⏳';
    const statusClass = `task-${todo.status}`;
    const content = todo.status === 'in_progress' && todo.activeForm
      ? todo.activeForm
      : todo.content;

    return `
      <div class="task-item ${statusClass}">
        <span class="task-icon">${icon}</span>
        <span class="task-content">${escapeHtml(content)}</span>
      </div>
    `;
  }).join('');

  // Barre de progression
  const progressBarColor = progress === 100 ? '#4caf50' : progress > 50 ? '#ff9800' : '#2196f3';

  const uuidAttr = uuid ? ` data-uuid="${uuid}"` : '';
  const collapsedClass = isCollapsed ? 'collapsed' : 'expanded';

  return `
    <div class="task-message ${collapsedClass}"${uuidAttr}>
      <div class="task-header">
        <span class="task-title">📋 TACHES</span>
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <span class="task-progress-text">${counts.completed}/${total} (${progress}%)</span>
          <span class="task-toggle-indicator">▼</span>
        </div>
      </div>
      <div class="task-progress-bar">
        <div class="task-progress-fill" style="width: ${progress}%; background-color: ${progressBarColor};"></div>
      </div>
      <div class="task-list">
        ${tasksHTML}
      </div>
    </div>
  `;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function capitalizeFirst(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function getTimeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);

  if (seconds < 60) return 'À l\'instant';
  if (seconds < 3600) return `Il y a ${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `Il y a ${Math.floor(seconds / 3600)} h`;
  return `Il y a ${Math.floor(seconds / 86400)} j`;
}

function getTimeUntil(date) {
  const now = new Date();
  const seconds = Math.floor((date - now) / 1000);

  // Format exact time (HH:MM)
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const exactTime = `${hours}:${minutes}`;

  // Si dans le passé (ne devrait plus arriver avec le nouveau calcul backend)
  if (seconds < 0) return `${exactTime} (${t('app.now')})`;

  let duration;
  if (seconds < 60) {
    duration = `${seconds}s`;
  } else if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    duration = t('app.inMinutes', { minutes: mins });
  } else if (seconds < 86400) {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    duration = t('app.inHours', { hours: hrs, minutes: mins.toString().padStart(2, '0') });
  } else {
    const days = Math.floor(seconds / 86400);
    const hrs = Math.floor((seconds % 86400) / 3600);
    duration = `${days}j ${hrs}h`;
  }

  return `${exactTime} (${duration})`;
}

function formatNumber(num) {
  if (num === null || num === undefined) return '0';
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// ============================================================================
// PIN Authentication
// ============================================================================

async function checkAuthStatus() {
  try {
    // Verifier si le PIN est active sur le serveur
    const statusResponse = await fetch(`${API_BASE}/api/auth/status`);
    const data = await statusResponse.json();

    pinRequired = data.pinEnabled;

    if (!pinRequired) {
      // PIN non active sur le serveur - acces libre
      isAuthenticated = true;
      return true;
    }

    // PIN actif = toujours demander le PIN au chargement de la page
    // On ne fait pas confiance aux tokens locaux, on force la re-auth
    isAuthenticated = false;
    authToken = '';
    sessionToken = '';
    localStorage.removeItem('authToken');
    localStorage.removeItem('sessionToken');
    return false;
  } catch (error) {
    console.error('Erreur verification auth:', error);
    isAuthenticated = false;
    return false;
  }
}

function renderPinLoginPage() {
  // Cacher le bouton des logs serveur tant que non authentifié
  const serverLogsBtn = document.getElementById('server-logs-btn');
  if (serverLogsBtn) {
    serverLogsBtn.style.display = 'none';
  }

  appContent.innerHTML = `
    <div class="pin-login-container">
      <div class="card pin-login-card">
        <div class="pin-login-header">
          <h1>${i18n.t('pinLogin.title')}</h1>
          <p>${i18n.t('pinLogin.subtitle')}</p>
        </div>

        <div class="pin-input-container">
          <input type="password"
                 id="pin-input"
                 class="pin-input"
                 maxlength="6"
                 pattern="[0-9]*"
                 inputmode="numeric"
                 placeholder="${i18n.t('pinLogin.placeholder')}"
                 autocomplete="off">
          <div id="pin-error" class="pin-error hidden"></div>
        </div>

        <button onclick="submitPin()" class="btn btn-primary btn-large" id="pin-submit-btn">
          ${i18n.t('pinLogin.loginBtn')}
        </button>

        <div id="pin-attempts-warning" class="pin-attempts-warning hidden">
          <span class="warning-icon">⚠️</span>
          <span id="pin-attempts-text"></span>
        </div>
      </div>
    </div>
  `;

  // Focus sur l'input
  setTimeout(() => {
    const pinInput = document.getElementById('pin-input');
    if (pinInput) {
      pinInput.focus();
      // Soumettre avec Enter
      pinInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          submitPin();
        }
      });
    }
  }, 100);
}

async function submitPin() {
  const pinInput = document.getElementById('pin-input');
  const errorDiv = document.getElementById('pin-error');
  const submitBtn = document.getElementById('pin-submit-btn');
  const warningDiv = document.getElementById('pin-attempts-warning');
  const warningText = document.getElementById('pin-attempts-text');

  const pin = pinInput.value.trim();

  if (pin.length !== 6 || !/^\d{6}$/.test(pin)) {
    errorDiv.textContent = i18n.t('pinLogin.pinError');
    errorDiv.classList.remove('hidden');
    pinInput.classList.add('error');
    return;
  }

  // Desactiver le bouton pendant la requete
  submitBtn.disabled = true;
  submitBtn.textContent = i18n.t('pinLogin.verifying');
  errorDiv.classList.add('hidden');
  pinInput.classList.remove('error');

  try {
    const response = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin })
    });

    const data = await response.json();

    if (data.success) {
      // Connexion reussie
      authToken = data.token;  // Utiliser authToken comme variable principale
      sessionToken = data.token;  // Garder pour compatibilité
      localStorage.setItem('authToken', authToken);
      localStorage.setItem('sessionToken', sessionToken);
      isAuthenticated = true;

      // Réafficher le bouton des logs serveur
      const serverLogsBtn = document.getElementById('server-logs-btn');
      if (serverLogsBtn) {
        serverLogsBtn.style.display = '';
      }

      // Recharger l'application (initializeApp() va connecter le WebSocket)
      await initializeApp();

      // CRITICAL: Attacher l'event listener hashchange (sinon routing ne marche pas!)
      window.addEventListener('hashchange', handleRouteChange);
    } else {
      // Echec
      errorDiv.textContent = data.message || i18n.t('pinLogin.incorrectPin');
      errorDiv.classList.remove('hidden');
      pinInput.classList.add('error');
      pinInput.value = '';
      pinInput.focus();

      // Afficher avertissement si proche du blocage
      if (data.remainingAttempts !== undefined && data.remainingAttempts <= 2) {
        warningDiv.classList.remove('hidden');
        const plural = data.remainingAttempts > 1 ? 's' : '';
        warningText.textContent = i18n.t('pinLogin.attemptsWarning', { count: data.remainingAttempts, plural: plural });
      }

      // Si bloque
      if (data.blocked) {
        renderBlockedPage();
      }
    }
  } catch (error) {
    errorDiv.textContent = i18n.t('pinLogin.connectionError');
    errorDiv.classList.remove('hidden');
    console.error('Erreur login:', error);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = i18n.t('pinLogin.loginBtn');
  }
}

function renderBlockedPage() {
  appContent.innerHTML = `
    <div class="pin-login-container">
      <div class="card pin-blocked-card">
        <div class="blocked-icon">🚫</div>
        <h1>${i18n.t('blocked.title')}</h1>
        <p>${i18n.t('blocked.message')}</p>
        <p>${i18n.t('blocked.ipBlocked')}</p>
        <p class="blocked-info">${i18n.t('blocked.instruction')}</p>
      </div>
    </div>
  `;
}

function handleSecurityWebSocketEvents(data) {
  switch (data.type) {
    case 'security-ip-blocked':
      // Une IP a ete bloquee
      showSecurityNotification(i18n.t('security.ipBlocked', { ip: data.ip }), 'warning');
      break;

    case 'security-alert':
      // Alerte de securite globale (5+ tentatives de differentes IPs)
      showSecurityNotification(i18n.t('security.multipleAttempts'), 'danger');
      // Vibrer sur mobile
      if (navigator.vibrate) {
        navigator.vibrate([300, 100, 300, 100, 300]);
      }
      break;

    case 'security-login-failed':
      // Tentative de connexion echouee (visible par les autres clients)
      console.log(`Tentative echouee depuis ${data.ip}`);
      break;
  }
}

function showSecurityNotification(message, type = 'info') {
  // Supprimer l'ancienne notification si elle existe
  const existing = document.getElementById('security-notification');
  if (existing) existing.remove();

  const notification = document.createElement('div');
  notification.id = 'security-notification';
  notification.className = `security-notification security-${type}`;
  notification.innerHTML = `
    <span class="notification-icon">${type === 'danger' ? '🚨' : '⚠️'}</span>
    <span class="notification-message">${escapeHtml(message)}</span>
    <button onclick="this.parentElement.remove()" class="notification-close">×</button>
  `;

  document.body.appendChild(notification);

  // Auto-supprimer apres 10 secondes
  setTimeout(() => {
    if (notification.parentElement) {
      notification.remove();
    }
  }, 10000);
}

// ============================================================================
// Initialization
// ============================================================================

async function initializeApp() {
  console.log('Initialisation de l\'application...');

  // Connexion WebSocket
  connectWebSocket();

  // Charger les donnees initiales (y compris les favoris)
  await Promise.all([
    loadSessions(),
    loadUsage(),
    loadPendingPermissions(),
    loadFavorites()
  ]);

  // Gerer le routing
  handleRouteChange();

  // Demarrer l'auto-refresh de l'usage
  startUsageAutoRefresh();

  // Démarrer le polling des permissions CDP
  startPermissionPolling();

  // Initialiser les event listeners pour les logs serveur
  initializeServerLogsListeners();
}

document.addEventListener('DOMContentLoaded', async () => {
  console.log('[Auth] Vérification authentification...');

  // SÉCURITÉ: Bloquer jusqu'à vérification complète de l'authentification
  const authenticated = await checkAuthStatus();

  if (pinRequired && !authenticated) {
    console.log('[Auth] PIN requis - affichage page login');
    renderPinLoginPage();
    // SÉCURITÉ: NE PAS connecter WebSocket avant authentification
    // connectWebSocket() sera appelé APRÈS login réussi
    return;  // STOP ICI - rien d'autre ne s'exécute
  }

  // Seulement si authentifié OU pas de PIN requis
  console.log('[Auth] Authentifié - initialisation app');
  await initializeApp();

  // Gérer le routing
  window.addEventListener('hashchange', handleRouteChange);

  // Initialiser la popup tasklist
  initializeTasklistPopup();
});

/* ============================================================================
   Tasklist Popup Management
   ============================================================================ */

let tasklistAutoCloseTimer = null;
let tasklistWasCollapsed = true;

function initializeTasklistPopup() {
  const bubble = document.getElementById('tasklist-bubble');
  const closeBtn = document.getElementById('tasklist-close-btn');
  const popup = document.getElementById('tasklist-popup');

  if (!bubble || !closeBtn || !popup) return;

  // Ouvrir la popup au clic sur la bulle
  bubble.addEventListener('click', () => {
    openTasklistPopup(false); // false = ouverture manuelle, pas d'auto-close
  });

  // Fermer la popup au clic sur le bouton close
  closeBtn.addEventListener('click', () => {
    closeTasklistPopup();
  });
}

function openTasklistPopup(autoClose = false) {
  const popup = document.getElementById('tasklist-popup');
  if (!popup) return;

  // Annuler tout timer en cours
  if (tasklistAutoCloseTimer) {
    clearTimeout(tasklistAutoCloseTimer);
    tasklistAutoCloseTimer = null;
  }

  popup.classList.add('expanded');

  // Si autoClose est activé, programmer la fermeture après 3s
  if (autoClose) {
    tasklistAutoCloseTimer = setTimeout(() => {
      closeTasklistPopup();
    }, 3000);
  }
}

function closeTasklistPopup() {
  const popup = document.getElementById('tasklist-popup');
  if (!popup) return;

  // Annuler le timer si présent
  if (tasklistAutoCloseTimer) {
    clearTimeout(tasklistAutoCloseTimer);
    tasklistAutoCloseTimer = null;
  }

  popup.classList.remove('expanded');
}

function updateTasklistPopup(todos) {
  const badge = document.getElementById('tasklist-badge');
  const content = document.getElementById('tasklist-panel-content');
  const bubble = document.getElementById('tasklist-bubble');
  const popup = document.getElementById('tasklist-popup');

  if (!badge || !content || !bubble || !popup) return;

  // Calculer le hash pour détecter les changements
  const newHash = hashTodos(todos);
  const hasChanged = newHash !== lastTodosHash;

  // Mettre à jour le hash global
  const previousHash = lastTodosHash;
  lastTodosHash = newHash;

  // Compter les tâches non terminées
  const pendingCount = todos.filter(t => t.status !== 'completed').length;

  // Mettre à jour le badge
  badge.textContent = pendingCount;
  if (pendingCount === 0) {
    badge.classList.add('hidden');
  } else {
    badge.classList.remove('hidden');
  }

  // Créer le contenu de la popup
  const statusIcons = {
    'pending': '⏳',
    'in_progress': '🔄',
    'completed': '✅'
  };

  const counts = {
    pending: todos.filter(t => t.status === 'pending').length,
    in_progress: todos.filter(t => t.status === 'in_progress').length,
    completed: todos.filter(t => t.status === 'completed').length
  };

  const total = todos.length;
  const progress = total > 0 ? Math.round((counts.completed / total) * 100) : 0;
  const progressBarColor = progress === 100 ? '#4caf50' : progress > 50 ? '#ff9800' : '#2196f3';

  const tasksHTML = todos.map(todo => {
    const icon = statusIcons[todo.status] || '⏳';
    const statusClass = `task-${todo.status}`;
    const taskContent = todo.status === 'in_progress' && todo.activeForm
      ? todo.activeForm
      : todo.content;

    return `
      <div class="task-item ${statusClass}">
        <span class="task-icon">${icon}</span>
        <span class="task-content">${escapeHtml(taskContent)}</span>
      </div>
    `;
  }).join('');

  content.innerHTML = `
    <div class="task-header">
      <span class="task-progress-text">${counts.completed}/${total} (${progress}%)</span>
    </div>
    <div class="task-progress-bar">
      <div class="task-progress-fill" style="width: ${progress}%; background-color: ${progressBarColor};"></div>
    </div>
    <div class="task-list">
      ${tasksHTML}
    </div>
  `;

  // Si les tâches ont changé et que c'est une vraie mise à jour
  if (hasChanged && previousHash !== null) {
    // Animation pulse sur la bulle
    bubble.classList.add('pulse');
    setTimeout(() => bubble.classList.remove('pulse'), 600);

    // Sauvegarder l'état actuel (ouvert ou fermé)
    const isCurrentlyExpanded = popup.classList.contains('expanded');

    if (!isCurrentlyExpanded) {
      // La popup était fermée, on l'ouvre avec auto-close
      tasklistWasCollapsed = true;
      openTasklistPopup(true);
    } else {
      // La popup était déjà ouverte, on annule tout timer et on la garde ouverte
      if (tasklistAutoCloseTimer) {
        clearTimeout(tasklistAutoCloseTimer);
        tasklistAutoCloseTimer = null;
      }
    }
  }
}

// ============================================================================
// Server Logs Panel
// ============================================================================

let serverLogsOpen = false;
let serverLogsSSE = null; // EventSource pour SSE
let serverLogsBuffer = []; // Buffer local pour filtrage/search
const MAX_LOGS_BUFFER = 500; // Maximum logs en mémoire
let currentLogsFilter = { level: 'all', search: '' };

function toggleServerLogs() {
  const panel = document.getElementById('serverlogs-panel');
  const bubble = document.getElementById('serverlogs-bubble');

  serverLogsOpen = !serverLogsOpen;

  if (serverLogsOpen) {
    panel.classList.add('open');
    bubble.style.opacity = '0.7';
    connectServerLogsSSE();
  } else {
    panel.classList.remove('open');
    bubble.style.opacity = '1';
    disconnectServerLogsSSE();
  }
}

// STREAMING: Connexion SSE pour logs en temps réel
function connectServerLogsSSE() {
  if (serverLogsSSE) return; // Déjà connecté

  try {
    const token = localStorage.getItem('authToken');
    serverLogsSSE = new EventSource(`/api/logs/stream?token=${token}`);

    serverLogsSSE.onmessage = (event) => {
      try {
        const logEntry = JSON.parse(event.data);

        // Ajouter au buffer local
        serverLogsBuffer.push(logEntry);
        if (serverLogsBuffer.length > MAX_LOGS_BUFFER) {
          serverLogsBuffer.shift(); // Retirer le plus ancien
        }

        // Re-render avec filtrage
        applyLogsFilter();
      } catch (error) {
        console.error('[ServerLogs SSE] Parse error:', error);
      }
    };

    serverLogsSSE.onerror = (error) => {
      console.error('[ServerLogs SSE] Connection error:', error);
      // Tenter de reconnecter après 5 secondes
      setTimeout(() => {
        if (serverLogsOpen) {
          disconnectServerLogsSSE();
          connectServerLogsSSE();
        }
      }, 5000);
    };

    console.log('[ServerLogs SSE] Connecté au stream de logs');
  } catch (error) {
    console.error('[ServerLogs SSE] Connection failed:', error);
  }
}

function disconnectServerLogsSSE() {
  if (serverLogsSSE) {
    serverLogsSSE.close();
    serverLogsSSE = null;
    console.log('[ServerLogs SSE] Déconnecté');
  }
}

// Appliquer filtres local sur le buffer
function applyLogsFilter() {
  let filtered = serverLogsBuffer;

  // Filtre par level
  if (currentLogsFilter.level !== 'all') {
    filtered = filtered.filter(log => log.level === currentLogsFilter.level);
  }

  // Filtre par search
  if (currentLogsFilter.search) {
    const search = currentLogsFilter.search.toLowerCase();
    filtered = filtered.filter(log =>
      log.message.toLowerCase().includes(search) ||
      log.timestamp.toLowerCase().includes(search)
    );
  }

  renderServerLogs(filtered, serverLogsBuffer.length, filtered.length);
}

// État pour les alertes serveur
let serverAlertState = {
  errorCount: 0
};

function renderServerLogs(logs, total, filtered) {
  const content = document.getElementById('serverlogs-panel-content');
  const badge = document.getElementById('serverlogs-badge');
  const bubble = document.getElementById('serverlogs-bubble');
  const count = document.getElementById('serverlogs-count');

  // MODE DISTANT: Compter uniquement les erreurs
  const errorCount = logs.filter(l => l.level === 'error' || l.level === 'warn').length;
  serverAlertState.errorCount = errorCount;

  // Mettre à jour le badge - uniquement si erreurs
  if (errorCount > 0) {
    badge.textContent = errorCount > 99 ? '99+' : errorCount;
    badge.style.display = 'flex';
    badge.style.background = '#f59e0b'; // Orange
    bubble.style.boxShadow = '0 4px 12px rgba(245, 158, 11, 0.4)';
  } else {
    badge.style.display = 'none';
    bubble.style.boxShadow = '0 4px 12px rgba(99, 102, 241, 0.4)';
  }

  // Mettre à jour le compteur dans le header
  count.textContent = `(${filtered}/${total})`;

  if (!content) return;

  if (logs.length === 0) {
    content.innerHTML = '<div class="serverlogs-loading">No logs</div>';
    return;
  }

  // Scroll en bas avant de mettre à jour (pour garder en bas si on était en bas)
  const wasAtBottom = content.scrollHeight - content.scrollTop <= content.clientHeight + 50;

  content.innerHTML = logs.map(log => {
    const time = new Date(log.timestamp).toLocaleTimeString('fr-FR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    return `
      <div class="serverlogs-entry level-${escapeHtml(log.level)}">
        <span class="serverlogs-entry-time">${time}</span>
        <span class="serverlogs-entry-level">${escapeHtml(log.level)}</span>
        <span class="serverlogs-entry-message">${escapeHtml(log.message)}</span>
      </div>
    `;
  }).join('');

  // Auto-scroll vers le bas si on était déjà en bas
  if (wasAtBottom) {
    content.scrollTop = content.scrollHeight;
  }
}

async function clearServerLogs() {
  if (!confirm('Effacer les logs locaux affichés ?')) return;

  // Vider le buffer local
  serverLogsBuffer = [];
  applyLogsFilter();
}

function refreshServerLogs() {
  // Reconnecter le SSE pour recharger depuis le serveur
  disconnectServerLogsSSE();
  serverLogsBuffer = [];
  connectServerLogsSSE();
}

// Initialiser le panneau de logs au chargement de la page
/**
 * Initialise les event listeners pour les logs serveur
 * Appelé depuis initializeApp() après authentification
 */
function initializeServerLogsListeners() {
  const bubble = document.getElementById('serverlogs-bubble');
  const closeBtn = document.getElementById('serverlogs-close-btn');
  const clearBtn = document.getElementById('serverlogs-clear-btn');
  const refreshBtn = document.getElementById('serverlogs-refresh-btn');
  const levelFilter = document.getElementById('serverlogs-level-filter');
  const searchInput = document.getElementById('serverlogs-search');

  if (bubble) {
    bubble.addEventListener('click', toggleServerLogs);
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (serverLogsOpen) toggleServerLogs();
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', clearServerLogs);
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', refreshServerLogs);
  }

  if (levelFilter) {
    levelFilter.addEventListener('change', () => {
      currentLogsFilter.level = levelFilter.value;
      applyLogsFilter();
    });
  }

  if (searchInput) {
    let searchTimeout;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        currentLogsFilter.search = searchInput.value;
        applyLogsFilter();
      }, 300);
    });
  }

  // Vérifier les connexions CDP périodiquement
  checkCDPConnections();
  setInterval(() => {
    checkCDPConnections();
  }, 10000);
}

/**
 * MODE DISTANT: Vérifie les connexions CDP (serveur backend uniquement)
 */
async function checkCDPConnections() {
  try {
    const response = await apiRequest('/api/cdp-monitor/stats');
    // En mode distant, on ne fait que vérifier la disponibilité
    // Pas besoin de tracker les connexions externes
  } catch (error) {
    // Silencieux si le monitor n'est pas disponible
  }
}

// Écouter les changements de langue pour re-render les vues dynamiques
window.addEventListener('languageChanged', (e) => {
  console.log('[i18n] Language changed to:', e.detail.language);

  // Re-render le widget usage si visible
  if (currentUsage) {
    renderUsageWidget();
  }

  // Re-render la vue actuelle en rechargeant la route
  const currentHash = window.location.hash;
  if (currentHash && currentHash.startsWith('#session/')) {
    // Si on est sur une session, recharger la session
    const sessionId = currentHash.replace('#session/', '');
    if (sessionId && sessions[sessionId]) {
      renderSessionPage(sessions[sessionId]);
    }
  } else if (!isAuthenticated) {
    // Si on est sur la page PIN (non authentifié), recharger la page PIN
    renderPinLoginPage();
  } else {
    // Si on est sur le dashboard, forcer un re-render via handleRouteChange
    handleRouteChange();
  }
});

// Exposer les fonctions globales
window.goHome = goHome;
window.goToSession = goToSession;
window.goBack = goBack;
window.handleSendMessage = handleSendMessage;
window.handleInjectMessage = handleInjectMessage;
window.handleInterruptRequest = handleInterruptRequest;
window.switchToSession = switchToSession;
window.refreshUsage = refreshUsage;
window.toggleUsageWidget = toggleUsageWidget;
window.respondToPermission = respondToPermission;
window.toggleInactiveSessions = toggleInactiveSessions;
window.submitPin = submitPin;
window.nextQuestion = nextQuestion;
window.previousQuestion = previousQuestion;
window.selectQuestionOption = selectQuestionOption;
window.showCustomInput = showCustomInput;
window.confirmCustomAnswer = confirmCustomAnswer;
window.submitQuestionAnswers = submitQuestionAnswers;

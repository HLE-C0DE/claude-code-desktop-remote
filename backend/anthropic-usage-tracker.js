const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

/**
 * Gestionnaire du tracking d'usage de l'API Anthropic
 * Surveille l'utilisation des tokens et calcule les statistiques
 */
class AnthropicUsageTracker extends EventEmitter {
  constructor(options = {}) {
    super();

    this.apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
    this.dataDir = options.dataDir || path.join(require('os').homedir(), '.claude-monitor');
    this.historyFile = path.join(this.dataDir, 'usage-history.json');

    // Configuration des plans
    this.plans = {
      pro: { limit: 19000, name: 'Pro' },
      max5: { limit: 88000, name: 'Max5' },
      max20: { limit: 220000, name: 'Max20' },
      custom: { limit: null, name: 'Custom' } // Détection auto
    };

    // État actuel
    this.currentUsage = {
      tokensUsed: 0,
      tokensRemaining: 0,
      tokensLimit: 0,
      percentageUsed: 0,
      plan: 'custom',
      lastUpdate: null,
      nextRefresh: null,
      currentRate: 0, // tokens/minute
      dailyUsage: 0,
      hourlyAverage: 0
    };

    // Historique
    this.usageHistory = [];

    // Charger l'historique existant
    this.loadHistory();
  }

  /**
   * Initialiser le tracker
   */
  async initialize() {
    console.log('Initialisation du tracker d\'usage Anthropic...');

    // Créer le dossier de données s'il n'existe pas
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    // Charger les données initiales
    await this.refreshUsage();

    // Démarrer le rafraîchissement automatique (toutes les 5 minutes)
    this.startAutoRefresh(5 * 60 * 1000);

    console.log('Tracker d\'usage initialisé');
  }

  /**
   * Rafraîchir les données d'usage
   */
  async refreshUsage() {
    try {
      // Toujours utiliser les sessions locales (pas d'API key)
      const usage = await this.calculateUsageFromSessions();

      // Mettre à jour l'état actuel
      this.updateCurrentUsage(usage);

      // Sauvegarder dans l'historique
      this.addToHistory(usage);

      // Calculer les prédictions
      this.calculatePredictions();

      // Émettre l'événement de mise à jour
      this.emit('usage-updated', this.currentUsage);

      console.log(`Usage mis à jour: ${this.currentUsage.tokensUsed}/${this.currentUsage.tokensLimit} tokens (${this.currentUsage.percentageUsed.toFixed(1)}%)`);

    } catch (error) {
      console.error('Erreur lors du rafraîchissement de l\'usage:', error.message);
      console.error(error.stack);
    }
  }

  /**
   * Récupérer les données d'usage depuis l'API Anthropic
   */
  async fetchUsageFromAnthropicAPI() {
    if (!this.apiKey) {
      throw new Error('Clé API Anthropic non configurée');
    }

    // L'API Anthropic n'a pas d'endpoint public pour les limites Claude Code
    // On utilise donc les sessions locales
    throw new Error('API endpoint non disponible');
  }

  /**
   * Récupérer les données d'usage depuis l'API Anthropic (legacy)
   */
  async fetchUsageFromAPI() {
    return this.fetchUsageFromAnthropicAPI();
  }

  /**
   * Calculer l'usage à partir des sessions locales
   */
  calculateUsageFromSessions() {
    const claudeDir = process.env.CLAUDE_DIR || path.join(require('os').homedir(), '.claude');
    const projectsDir = path.join(claudeDir, 'projects');

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Fenêtre glissante de 5 heures (comme Claude Code)
    const fiveHoursAgo = new Date(now.getTime() - (5 * 60 * 60 * 1000));

    let currentPeriodTokens = 0;
    let dailyTokens = 0;
    let oldestMessageInWindow = null; // Pour calculer le vrai refresh time

    try {
      if (!fs.existsSync(projectsDir)) {
        return { tokensUsed: 0, dailyUsage: 0, timestamp: now.toISOString() };
      }

      // Parcourir tous les fichiers de session
      const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      let sessionCount = 0;
      for (const projectDir of projectDirs) {
        const projectPath = path.join(projectsDir, projectDir);
        const sessionFiles = fs.readdirSync(projectPath)
          .filter(file => file.endsWith('.jsonl') && !file.startsWith('agent-'));

        for (const sessionFile of sessionFiles) {
          const sessionPath = path.join(projectPath, sessionFile);
          const tokens = this.extractTokensFromSession(sessionPath, todayStart, fiveHoursAgo);
          if (tokens.currentPeriod > 0) {
            sessionCount++;
            if (process.env.DEBUG === 'true') {
              console.log(`  Session ${sessionFile}: ${tokens.currentPeriod} tokens (${tokens.messageCount} messages)`);
            }
          }
          currentPeriodTokens += tokens.currentPeriod;
          dailyTokens += tokens.daily;
        }
      }

      console.log(`Debug: ${sessionCount} sessions actives dans fenêtre 5h (${currentPeriodTokens.toLocaleString()} tokens au total)`);

      console.log(`Debug: Tokens dans fenêtre 5h glissante (depuis ${fiveHoursAgo.toISOString()}) - Période: ${currentPeriodTokens}, Jour: ${dailyTokens}`);

    } catch (error) {
      console.error('Erreur lors du calcul de l\'usage:', error.message);
    }

    // Chercher le message le plus ancien dans la fenêtre pour calculer le refresh
    oldestMessageInWindow = this.findOldestMessageInWindow(projectsDir, fiveHoursAgo);

    return {
      tokensUsed: currentPeriodTokens,
      dailyUsage: dailyTokens,
      timestamp: now.toISOString(),
      oldestMessageTimestamp: oldestMessageInWindow
    };
  }

  /**
   * Trouver le timestamp du message le plus ancien dans la fenêtre de 5h
   */
  findOldestMessageInWindow(projectsDir, fiveHoursAgo) {
    let oldestTimestamp = null;

    try {
      const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      for (const projectDir of projectDirs) {
        const projectPath = path.join(projectsDir, projectDir);
        const sessionFiles = fs.readdirSync(projectPath)
          .filter(file => file.endsWith('.jsonl') && !file.startsWith('agent-'));

        for (const sessionFile of sessionFiles) {
          const sessionPath = path.join(projectPath, sessionFile);
          const oldest = this.findOldestInSession(sessionPath, fiveHoursAgo);
          if (oldest && (!oldestTimestamp || oldest < oldestTimestamp)) {
            oldestTimestamp = oldest;
          }
        }
      }
    } catch (error) {
      // Ignorer les erreurs
    }

    return oldestTimestamp;
  }

  /**
   * Trouver le timestamp du message le plus ancien dans une session (dans la fenêtre)
   */
  findOldestInSession(sessionPath, fiveHoursAgo) {
    let oldest = null;

    try {
      const content = fs.readFileSync(sessionPath, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.trim());

      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'assistant' && event.message?.usage && event.timestamp) {
            const eventDate = new Date(event.timestamp);
            if (eventDate >= fiveHoursAgo) {
              if (!oldest || eventDate < oldest) {
                oldest = eventDate;
              }
            }
          }
        } catch (e) {
          // Ignorer les lignes mal formées
        }
      }
    } catch (error) {
      // Ignorer les erreurs de lecture
    }

    return oldest;
  }


  /**
   * Extraire les tokens d'un fichier de session
   */
  extractTokensFromSession(sessionPath, todayStart, fiveHoursAgo) {
    let currentPeriod = 0;
    let daily = 0;
    let messageCount = 0;

    try {
      const content = fs.readFileSync(sessionPath, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.trim());

      for (const line of lines) {
        try {
          const event = JSON.parse(line);

          // Vérifier si c'est un message assistant avec usage
          if (event.type === 'assistant' && event.message?.usage) {
            const usage = event.message.usage;
            const eventDate = new Date(event.timestamp);

            // Extraire tous les types de tokens (input, output, cache)
            const inputTokens = usage.input_tokens || 0;
            const outputTokens = usage.output_tokens || 0;
            const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
            const cacheReadTokens = usage.cache_read_input_tokens || 0;

            // Total = UNIQUEMENT input + output
            // IMPORTANT: Selon les tests avec Claude Code Usage Monitor, seuls les input_tokens
            // et output_tokens comptent dans la limite de la fenêtre glissante.
            // Les cache_creation_input_tokens et cache_read_input_tokens NE COMPTENT PAS.
            const tokensUsed = inputTokens + outputTokens;

            // Compteur pour la période de 5 heures glissantes
            if (eventDate >= fiveHoursAgo) {
              currentPeriod += tokensUsed;
              messageCount++;
            }

            // Compteur pour la journée
            if (eventDate >= todayStart) {
              daily += tokensUsed;
            }
          }
        } catch (e) {
          // Ignorer les lignes mal formées
        }
      }
    } catch (error) {
      console.error(`Erreur lors de la lecture de ${sessionPath}:`, error.message);
    }

    return { currentPeriod, daily, messageCount };
  }

  /**
   * Mettre à jour l'état actuel
   */
  updateCurrentUsage(usage) {
    // Détecter le plan automatiquement
    const detectedPlan = this.detectPlan(usage.tokensUsed);

    // Stocker le timestamp du message le plus ancien pour le calcul du refresh
    this.oldestMessageInWindow = usage.oldestMessageTimestamp;

    this.currentUsage = {
      tokensUsed: usage.tokensUsed,
      tokensLimit: this.plans[detectedPlan].limit || this.estimateLimit(usage.tokensUsed),
      tokensRemaining: this.calculateRemaining(usage.tokensUsed, detectedPlan),
      percentageUsed: this.calculatePercentage(usage.tokensUsed, detectedPlan),
      plan: detectedPlan,
      lastUpdate: usage.timestamp,
      dailyUsage: usage.dailyUsage || 0,
      nextRefresh: this.estimateNextRefresh(),
      currentRate: this.calculateCurrentRate(),
      hourlyAverage: this.calculateHourlyAverage()
    };
  }

  /**
   * Détecter automatiquement le plan basé sur P90 des limites historiques
   */
  detectPlan(tokensUsed) {
    // Si on a assez d'historique, on utilise le P90 pour détecter la limite dynamique
    // Sinon on utilise 'custom' pour permettre le calcul dynamique
    return 'custom';
  }

  /**
   * Estimer la limite pour un plan custom basé sur P90 des sessions ayant atteint la limite
   * Méthode alignée avec Claude Code Usage Monitor
   */
  estimateLimit(tokensUsed) {
    // Limites connues de Claude Code
    const COMMON_LIMITS = [19000, 44000, 88000, 220000, 880000];
    const LIMIT_THRESHOLD = 0.95; // 95% = considéré comme "hit" de limite
    const DEFAULT_LIMIT = 44000; // Limite par défaut pour plan custom

    // Chercher les sessions qui ont "hit" la limite (>= 95% d'une limite connue)
    const limitHits = this.usageHistory.filter(h => {
      if (!h.tokensUsed || h.tokensUsed === 0) return false;
      // Vérifier si ce usage est proche d'une limite connue
      return COMMON_LIMITS.some(limit => {
        const ratio = h.tokensUsed / limit;
        return ratio >= LIMIT_THRESHOLD && ratio <= 1.05; // Entre 95% et 105%
      });
    });

    // Si on a des hits de limite, calculer le P90 de ces hits
    if (limitHits.length >= 3) {
      const sortedHits = [...limitHits]
        .map(h => h.tokensUsed)
        .sort((a, b) => a - b);

      const p90Index = Math.floor(sortedHits.length * 0.9);
      const p90Value = sortedHits[p90Index];

      // Trouver la limite connue la plus proche
      const closestLimit = COMMON_LIMITS.reduce((prev, curr) =>
        Math.abs(curr - p90Value) < Math.abs(prev - p90Value) ? curr : prev
      );

      console.log(`P90 calculé sur ${limitHits.length} hits de limite: ${p90Value} -> limite détectée: ${closestLimit}`);
      return closestLimit;
    }

    // Fallback: si pas assez de hits, utiliser toutes les sessions terminées
    if (this.usageHistory.length >= 5) {
      const sortedUsage = [...this.usageHistory]
        .map(h => h.tokensUsed)
        .filter(t => t > 0)
        .sort((a, b) => a - b);

      if (sortedUsage.length > 0) {
        const p90Index = Math.floor(sortedUsage.length * 0.9);
        const p90Value = sortedUsage[p90Index];

        // Trouver la limite connue la plus proche (avec marge de 20%)
        const closestLimit = COMMON_LIMITS.find(limit => p90Value <= limit * 1.2) || DEFAULT_LIMIT;
        console.log(`P90 fallback sur ${sortedUsage.length} sessions: ${p90Value} -> limite estimée: ${closestLimit}`);
        return closestLimit;
      }
    }

    // Dernier fallback: limite par défaut
    console.log(`Pas assez d'historique, utilisation de la limite par défaut: ${DEFAULT_LIMIT}`);
    return DEFAULT_LIMIT;
  }

  /**
   * Calculer les tokens restants
   */
  calculateRemaining(tokensUsed, plan) {
    const limit = this.plans[plan].limit || this.estimateLimit(tokensUsed);
    return Math.max(0, limit - tokensUsed);
  }

  /**
   * Calculer le pourcentage d'utilisation
   */
  calculatePercentage(tokensUsed, plan) {
    const limit = this.plans[plan].limit || this.estimateLimit(tokensUsed);
    return limit > 0 ? (tokensUsed / limit) * 100 : 0;
  }

  /**
   * Arrondir un timestamp à l'heure entière (comme Claude Code Usage Monitor)
   */
  roundToHour(date) {
    const rounded = new Date(date);
    rounded.setMinutes(0, 0, 0);
    return rounded;
  }

  /**
   * Estimer le prochain refresh basé sur la fenêtre glissante
   * Le refresh correspond au moment où le bloc de session expire
   * Claude Code Usage Monitor arrondit le start_time à l'heure, puis ajoute 5h
   *
   * Si pas de tokens actifs, on anticipe la prochaine fenêtre de 5h (maintenant + 5h)
   * car l'utilisateur va probablement envoyer un message bientôt
   */
  estimateNextRefresh() {
    const now = new Date();
    const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

    // Si on a le timestamp du message le plus ancien dans la fenêtre
    if (this.oldestMessageInWindow) {
      // Arrondir à l'heure comme Claude Code Usage Monitor
      const oldestTime = new Date(this.oldestMessageInWindow);
      const roundedStartTime = this.roundToHour(oldestTime);

      // Le prochain refresh = heure arrondie + 5 heures
      const nextRefresh = new Date(roundedStartTime.getTime() + FIVE_HOURS_MS);

      // Si le refresh est dans le passé, les tokens ont expiré
      // Calculer le prochain refresh basé sur maintenant (nouvelle fenêtre de 5h)
      if (nextRefresh <= now) {
        const roundedNow = this.roundToHour(now);
        const anticipatedRefresh = new Date(roundedNow.getTime() + FIVE_HOURS_MS);
        console.log(`Tokens expirés - prochain refresh anticipé: ${anticipatedRefresh.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`);
        return anticipatedRefresh.toISOString();
      }

      const minutesUntilRefresh = Math.round((nextRefresh - now) / (1000 * 60));
      const hours = Math.floor(minutesUntilRefresh / 60);
      const mins = minutesUntilRefresh % 60;
      console.log(`Prochain refresh dans ${hours}h${mins}m (${nextRefresh.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })})`);

      return nextRefresh.toISOString();
    }

    // Fallback: si pas de messages dans la fenêtre, anticiper la prochaine fenêtre
    // L'utilisateur est sur l'interface donc il va probablement envoyer un message
    const roundedNow = this.roundToHour(now);
    const anticipatedRefresh = new Date(roundedNow.getTime() + FIVE_HOURS_MS);
    console.log(`Aucun token actif - prochain refresh anticipé: ${anticipatedRefresh.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`);
    return anticipatedRefresh.toISOString();
  }

  /**
   * Calculer le taux d'utilisation actuel (tokens/minute)
   * Note: On calcule la variation des tokens dans la fenêtre glissante, pas un cumul
   */
  calculateCurrentRate() {
    if (this.usageHistory.length < 2) return 0;

    const recent = this.usageHistory.slice(-12); // Dernières 12 entrées (1 heure si refresh toutes les 5 min)
    if (recent.length < 2) return 0;

    const firstEntry = recent[0];
    const lastEntry = recent[recent.length - 1];

    const timeDiff = new Date(lastEntry.timestamp) - new Date(firstEntry.timestamp);
    const minutesDiff = timeDiff / (1000 * 60);

    if (minutesDiff === 0) return 0;

    // La différence entre deux fenêtres glissantes indique le taux réel
    // Si la fenêtre contient les mêmes tokens, le taux est 0
    // Si elle contient plus de tokens, c'est qu'on a utilisé des tokens
    const tokensDiff = lastEntry.tokensUsed - firstEntry.tokensUsed;

    // Ne retourner que des taux positifs (augmentation d'utilisation)
    return tokensDiff > 0 ? Math.round(tokensDiff / minutesDiff) : 0;
  }

  /**
   * Calculer la moyenne horaire
   */
  calculateHourlyAverage() {
    if (this.usageHistory.length < 2) return 0;

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentHistory = this.usageHistory.filter(h => new Date(h.timestamp) >= oneDayAgo);

    if (recentHistory.length < 2) return 0;

    const totalTokens = recentHistory.reduce((sum, h) => sum + (h.dailyUsage || 0), 0);
    return Math.round(totalTokens / 24);
  }

  /**
   * Calculer les prédictions
   */
  calculatePredictions() {
    const { tokensRemaining, currentRate } = this.currentUsage;

    if (currentRate === 0) {
      this.currentUsage.estimatedTimeUntilLimit = null;
      return;
    }

    // Estimer le temps avant d'atteindre la limite
    const hoursUntilLimit = tokensRemaining / currentRate;
    this.currentUsage.estimatedTimeUntilLimit = hoursUntilLimit;
  }

  /**
   * Ajouter une entrée à l'historique
   * IMPORTANT: On stocke les tokens de la fenêtre glissante actuelle (pas cumulatifs)
   */
  addToHistory(usage) {
    const entry = {
      timestamp: usage.timestamp,
      tokensUsed: usage.tokensUsed, // Tokens dans la fenêtre de 5h actuelle
      dailyUsage: usage.dailyUsage || 0
    };

    this.usageHistory.push(entry);

    // Garder seulement les 24 dernières heures pour les calculs de tendance
    // (on n'a pas besoin de garder 8 jours pour une fenêtre de 5h)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    this.usageHistory = this.usageHistory.filter(h => new Date(h.timestamp) >= oneDayAgo);

    // Sauvegarder sur disque
    this.saveHistory();
  }

  /**
   * Charger l'historique depuis le disque
   */
  loadHistory() {
    try {
      if (fs.existsSync(this.historyFile)) {
        const data = fs.readFileSync(this.historyFile, 'utf-8');
        const loaded = JSON.parse(data);

        // Nettoyer l'historique : garder seulement les dernières 24h
        // Cela supprime les anciennes données cumulatives incorrectes
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        this.usageHistory = loaded.filter(h => new Date(h.timestamp) >= oneDayAgo);

        console.log(`Historique chargé: ${this.usageHistory.length} entrées (nettoyé des anciennes données)`);

        // Si on a nettoyé des données, sauvegarder immédiatement
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

  /**
   * Sauvegarder l'historique sur disque
   */
  saveHistory() {
    try {
      fs.writeFileSync(this.historyFile, JSON.stringify(this.usageHistory, null, 2), 'utf-8');
    } catch (error) {
      console.error('Erreur lors de la sauvegarde de l\'historique:', error.message);
    }
  }


  /**
   * Démarrer le rafraîchissement automatique
   */
  startAutoRefresh(interval) {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }

    this.refreshInterval = setInterval(() => {
      this.refreshUsage();
    }, interval);
  }

  /**
   * Obtenir l'usage actuel
   */
  getCurrentUsage() {
    return this.currentUsage;
  }

  /**
   * Obtenir l'historique
   */
  getHistory(hours = 24) {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return this.usageHistory.filter(h => new Date(h.timestamp) >= cutoff);
  }

  /**
   * Arrêter le tracker
   */
  stop() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    console.log('Tracker d\'usage arrêté');
  }
}

module.exports = AnthropicUsageTracker;

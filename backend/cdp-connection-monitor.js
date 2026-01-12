/**
 * CDP Connection Monitor - Surveillance de la connexion distante au port 9222
 *
 * MODE DISTANT UNIQUEMENT: Surveille uniquement la connexion du serveur backend
 * vers Claude Desktop distant via le port 9222
 *
 * Fonctionnalités:
 * - Compte uniquement la connexion du serveur backend (notre PID)
 * - Ignore toutes les autres connexions (locales ou externes)
 * - Historique des connexions avec timestamps
 * - Support Windows et Linux
 */

const { exec } = require('child_process');
const EventEmitter = require('events');

class CDPConnectionMonitor extends EventEmitter {
  constructor(options = {}) {
    super();

    this.port = options.port || 9222;
    this.checkInterval = options.checkInterval || 5000; // Vérifier toutes les 5 secondes
    this.isMonitoring = false;
    this.intervalId = null;

    // Stockage des connexions
    this.currentConnections = new Set(); // IPs actuellement connectées
    this.connectionHistory = []; // Historique des connexions
    this.maxHistorySize = options.maxHistorySize || 100;

    // Stats
    this.stats = {
      totalConnections: 0,
      currentConnectionCount: 0,
      peakConnectionCount: 0,
      lastCheck: null,
      uniqueIPs: new Set()
    };

    // Notre propre PID pour identifier nos connexions
    this.ourPid = process.pid.toString();

    console.log(`[CDPMonitor] Initialisé pour le port ${this.port} (notre PID: ${this.ourPid})`);
  }

  /**
   * Démarrer la surveillance
   */
  start() {
    if (this.isMonitoring) {
      console.log('[CDPMonitor] Surveillance déjà active');
      return;
    }

    console.log('[CDPMonitor] Démarrage de la surveillance...');
    this.isMonitoring = true;

    // Vérification initiale
    this.checkConnections();

    // Vérifications périodiques
    this.intervalId = setInterval(() => {
      this.checkConnections();
    }, this.checkInterval);
  }

  /**
   * Arrêter la surveillance
   */
  stop() {
    if (!this.isMonitoring) {
      return;
    }

    console.log('[CDPMonitor] Arrêt de la surveillance');
    this.isMonitoring = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Vérifier les connexions actives sur le port 9222
   */
  async checkConnections() {
    try {
      const connections = await this.getActiveConnections();
      this.updateConnectionStats(connections);
      this.stats.lastCheck = new Date();

      // Émettre un événement si des connexions ont été détectées
      if (connections.length > 0) {
        this.emit('connections-detected', {
          count: connections.length,
          connections: connections,
          timestamp: new Date()
        });
      }
    } catch (error) {
      console.error('[CDPMonitor] Erreur lors de la vérification:', error.message);
    }
  }

  /**
   * Obtenir les connexions TCP actives sur le port 9222
   */
  async getActiveConnections() {
    const platform = process.platform;

    if (platform === 'win32') {
      return this.getConnectionsWindows();
    } else {
      return this.getConnectionsLinux();
    }
  }

  /**
   * Obtenir les connexions sur Windows (via netstat)
   */
  getConnectionsWindows() {
    return new Promise((resolve, reject) => {
      // netstat -ano | findstr :9222
      const command = `netstat -ano | findstr :${this.port}`;

      exec(command, (error, stdout, stderr) => {
        if (error) {
          // Si aucune connexion, netstat peut retourner une erreur
          resolve([]);
          return;
        }

        const connections = [];
        const lines = stdout.split('\n').filter(l => l.trim());

        for (const line of lines) {
          // Format: TCP    127.0.0.1:9222    127.0.0.1:12345    ESTABLISHED    1234
          const parts = line.trim().split(/\s+/);

          if (parts.length >= 4 && parts[3] === 'ESTABLISHED') {
            // Extraire l'adresse distante (remote)
            const remoteAddr = parts[2];
            const localAddr = parts[1];
            const lastColon = remoteAddr.lastIndexOf(':');
            const ip = remoteAddr.substring(0, lastColon);
            const port = remoteAddr.substring(lastColon + 1);

            if (ip) {
              const pid = parts[4] || 'unknown';
              const isOurConnection = pid === this.ourPid;

              // MODE DISTANT UNIQUEMENT: Ne compter que notre connexion serveur
              // Ignorer toutes les autres connexions (locales ou externes)
              if (isOurConnection) {
                connections.push({
                  remoteIP: ip,
                  remotePort: port,
                  localAddr: localAddr,
                  protocol: parts[0],
                  state: parts[3],
                  pid: pid,
                  isLocal: true, // Notre serveur est considéré comme local
                  isOurConnection: true,
                  connectionType: 'server' // Notre serveur backend
                });
              }
              // Toutes les autres connexions sont ignorées
            }
          }
        }

        resolve(connections);
      });
    });
  }

  /**
   * Obtenir les connexions sur Linux (via ss ou netstat)
   */
  getConnectionsLinux() {
    return new Promise((resolve, reject) => {
      // Essayer avec 'ss' d'abord (plus moderne)
      const command = `ss -tn | grep :${this.port}`;

      exec(command, (error, stdout, stderr) => {
        if (error) {
          // Si ss échoue, essayer avec netstat
          this.getConnectionsLinuxNetstat()
            .then(resolve)
            .catch(() => resolve([]));
          return;
        }

        const connections = [];
        const lines = stdout.split('\n').filter(l => l.trim());

        for (const line of lines) {
          // Format ss: ESTAB      0      0      127.0.0.1:9222      127.0.0.1:12345
          const parts = line.trim().split(/\s+/);

          if (parts.length >= 5 && parts[0] === 'ESTAB') {
            const remoteAddr = parts[4];
            const [ip, port] = remoteAddr.split(':');

            if (ip) {
              // MODE DISTANT: Sur Linux, on ne peut pas facilement identifier notre PID
              // donc on accepte toutes les connexions localhost
              const isLocal = ip === '127.0.0.1' || ip === '::1';
              if (isLocal) {
                connections.push({
                  remoteIP: ip,
                  remotePort: port,
                  protocol: 'TCP',
                  state: 'ESTABLISHED',
                  pid: 'unknown',
                  isLocal: true,
                  isOurConnection: true, // On suppose que c'est nous
                  connectionType: 'server'
                });
              }
              // Ignorer les connexions non-locales
            }
          }
        }

        resolve(connections);
      });
    });
  }

  /**
   * Fallback pour Linux avec netstat
   */
  getConnectionsLinuxNetstat() {
    return new Promise((resolve, reject) => {
      const command = `netstat -tn | grep :${this.port}`;

      exec(command, (error, stdout, stderr) => {
        if (error) {
          resolve([]);
          return;
        }

        const connections = [];
        const lines = stdout.split('\n').filter(l => l.trim());

        for (const line of lines) {
          const parts = line.trim().split(/\s+/);

          if (parts.length >= 6 && parts[5] === 'ESTABLISHED') {
            const remoteAddr = parts[4];
            const [ip, port] = remoteAddr.split(':');

            if (ip) {
              // MODE DISTANT: Ne compter que les connexions localhost
              const isLocal = ip === '127.0.0.1' || ip === '::1';
              if (isLocal) {
                connections.push({
                  remoteIP: ip,
                  remotePort: port,
                  protocol: parts[0],
                  state: parts[5],
                  pid: 'unknown',
                  isLocal: true,
                  isOurConnection: true,
                  connectionType: 'server'
                });
              }
              // Ignorer les connexions non-locales
            }
          }
        }

        resolve(connections);
      });
    });
  }

  /**
   * Mettre à jour les statistiques de connexion
   * MODE DISTANT: Ne compte que notre connexion serveur
   */
  updateConnectionStats(connections) {
    // Mettre à jour les connexions actuelles
    const previousCount = this.currentConnections.size;
    this.currentConnections.clear();

    for (const conn of connections) {
      this.currentConnections.add(conn.remoteIP);
      this.stats.uniqueIPs.add(conn.remoteIP);

      // Ajouter à l'historique
      this.connectionHistory.push({
        ip: conn.remoteIP,
        port: conn.remotePort,
        protocol: conn.protocol,
        timestamp: new Date(),
        state: conn.state,
        connectionType: conn.connectionType,
        pid: conn.pid
      });
    }

    // Limiter la taille de l'historique
    if (this.connectionHistory.length > this.maxHistorySize) {
      this.connectionHistory = this.connectionHistory.slice(-this.maxHistorySize);
    }

    // Mettre à jour les stats
    this.stats.currentConnectionCount = connections.length;
    this.stats.totalConnections += connections.length;

    if (this.stats.currentConnectionCount > this.stats.peakConnectionCount) {
      this.stats.peakConnectionCount = this.stats.currentConnectionCount;
    }

    // Émettre un événement si le nombre de connexions a changé
    if (this.stats.currentConnectionCount !== previousCount) {
      this.emit('connection-count-changed', {
        previous: previousCount,
        current: this.stats.currentConnectionCount,
        connections: connections,
        timestamp: new Date()
      });

      // Alerte si de nouvelles connexions apparaissent
      if (this.stats.currentConnectionCount > previousCount) {
        this.emit('new-connection', {
          count: this.stats.currentConnectionCount - previousCount,
          connections: connections,
          timestamp: new Date()
        });
      }
    }
  }

  /**
   * Obtenir les statistiques actuelles
   */
  getStats() {
    const recentHistory = this.connectionHistory.slice(-10);

    return {
      ...this.stats,
      uniqueIPs: Array.from(this.stats.uniqueIPs),
      isMonitoring: this.isMonitoring,
      currentConnections: Array.from(this.currentConnections),
      recentHistory: recentHistory
    };
  }

  /**
   * Obtenir l'historique complet
   */
  getHistory() {
    return this.connectionHistory;
  }

  /**
   * Réinitialiser les statistiques
   */
  resetStats() {
    this.stats = {
      totalConnections: 0,
      currentConnectionCount: 0,
      peakConnectionCount: 0,
      lastCheck: null,
      uniqueIPs: new Set()
    };
    this.connectionHistory = [];
    console.log('[CDPMonitor] Statistiques réinitialisées');
  }
}

module.exports = CDPConnectionMonitor;

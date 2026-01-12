/**
 * PIN Manager - Gestion de l'authentification par PIN et blacklist IP
 *
 * Fonctionnalites:
 * - Verification du PIN a 6 chiffres
 * - Blacklist IP apres 3 tentatives echouees consecutives
 * - Notification apres 5 tentatives echouees depuis des IPs differentes
 * - Sessions authentifiees persistantes
 */

const EventEmitter = require('events');
const crypto = require('crypto');

class PinManager extends EventEmitter {
  constructor(options = {}) {
    super();

    // PIN configure via variable d'environnement ou options
    this.pin = options.pin || process.env.CLAUDECODE_PIN || null;

    // Configuration
    this.maxAttemptsPerIP = options.maxAttemptsPerIP || 3;
    this.globalAlertThreshold = options.globalAlertThreshold || 5;
    this.sessionTimeout = options.sessionTimeout || 30 * 60 * 1000; // SÉCURITÉ: 30 minutes (réduit de 24h)

    // Stockage en memoire (reset a chaque redemarrage serveur)
    // SÉCURITÉ: Redémarrage serveur = toutes sessions invalidées
    this.ipAttempts = new Map(); // IP -> { attempts: number, lastAttempt: Date, blocked: boolean }
    this.authenticatedSessions = new Map(); // sessionToken -> { ip: string, authenticatedAt: Date }
    this.totalFailedAttempts = 0;
    this.failedAttemptIPs = new Set(); // IPs distinctes qui ont echoue
    this.globalLockdown = false; // Verrouillage global apres seuil atteint

    console.log(`[PinManager] Initialise ${this.pin ? 'avec PIN configure' : 'SANS PIN (mode non securise)'}`);
    console.log(`[PinManager] Sessions reset au démarrage du serveur`);
    console.log(`[PinManager] Session timeout: ${this.sessionTimeout / 60000} minutes`);
  }

  /**
   * Verifier si le PIN est configure
   */
  isPinEnabled() {
    return this.pin !== null && this.pin.length === 6;
  }

  /**
   * Obtenir l'IP du client depuis la requete Express
   */
  getClientIP(req) {
    // Cloudflare et autres proxies
    const forwarded = req.headers['cf-connecting-ip'] ||
                      req.headers['x-real-ip'] ||
                      req.headers['x-forwarded-for'];

    if (forwarded) {
      // x-forwarded-for peut contenir plusieurs IPs, prendre la premiere
      return forwarded.split(',')[0].trim();
    }

    return req.ip || req.connection?.remoteAddress || 'unknown';
  }

  /**
   * Verifier si une IP est blacklistee
   */
  isIPBlocked(ip) {
    const record = this.ipAttempts.get(ip);
    return record?.blocked === true;
  }

  /**
   * Generer un token de session unique
   */
  generateSessionToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Verifier si un token de session est valide
   */
  isSessionValid(token, ip) {
    if (!token) return false;

    const session = this.authenticatedSessions.get(token);
    if (!session) return false;

    // Verifier que l'IP correspond
    if (session.ip !== ip) {
      console.log(`[PinManager] Token utilise depuis une IP differente: ${ip} (original: ${session.ip})`);
      return false;
    }

    // Verifier si la session n'a pas expire
    const now = Date.now();
    if (now - session.authenticatedAt > this.sessionTimeout) {
      this.authenticatedSessions.delete(token);
      return false;
    }

    return true;
  }

  /**
   * Tenter une authentification par PIN
   * @returns {{ success: boolean, token?: string, error?: string, blocked?: boolean, lockdown?: boolean }}
   */
  attemptLogin(ip, enteredPin) {
    // Si pas de PIN configure, autoriser directement
    if (!this.isPinEnabled()) {
      const token = this.generateSessionToken();
      this.authenticatedSessions.set(token, {
        ip,
        authenticatedAt: Date.now()
      });
      return { success: true, token, message: 'PIN non configure - acces accorde' };
    }

    // Verifier si le verrouillage global est actif
    if (this.globalLockdown) {
      console.log(`[PinManager] Tentative bloquee par verrouillage global: ${ip}`);
      this.emit('lockdown-attempt', { ip, timestamp: new Date() });
      return {
        success: false,
        error: 'Serveur en verrouillage de securite. Trop de tentatives echouees detectees.',
        lockdown: true
      };
    }

    // Verifier si l'IP est blacklistee
    if (this.isIPBlocked(ip)) {
      console.log(`[PinManager] Tentative depuis IP blacklistee: ${ip}`);
      this.emit('blocked-attempt', { ip, timestamp: new Date() });
      return { success: false, error: 'IP bloquee pour cette session serveur', blocked: true };
    }

    // Obtenir ou creer le record pour cette IP
    let record = this.ipAttempts.get(ip);
    if (!record) {
      record = { attempts: 0, lastAttempt: null, blocked: false };
      this.ipAttempts.set(ip, record);
    }

    // Verifier le PIN
    if (enteredPin === this.pin) {
      // Succes - reset les tentatives pour cette IP
      record.attempts = 0;
      record.lastAttempt = new Date();

      // Creer une session authentifiee
      const token = this.generateSessionToken();
      this.authenticatedSessions.set(token, {
        ip,
        authenticatedAt: Date.now()
      });

      console.log(`[PinManager] Authentification reussie depuis ${ip}`);
      this.emit('login-success', { ip, timestamp: new Date() });

      return { success: true, token };
    }

    // Echec - incrementer les tentatives
    record.attempts++;
    record.lastAttempt = new Date();
    this.totalFailedAttempts++;
    this.failedAttemptIPs.add(ip);

    console.log(`[PinManager] Echec authentification depuis ${ip} (tentative ${record.attempts}/${this.maxAttemptsPerIP})`);

    // Verifier si on doit blacklister cette IP
    if (record.attempts >= this.maxAttemptsPerIP) {
      record.blocked = true;
      console.log(`[PinManager] IP blacklistee: ${ip}`);

      this.emit('ip-blocked', {
        ip,
        attempts: record.attempts,
        timestamp: new Date()
      });

      return {
        success: false,
        error: `Trop de tentatives echouees. IP bloquee pour cette session serveur.`,
        blocked: true,
        attemptsRemaining: 0
      };
    }

    // Verifier si on doit activer le verrouillage global
    if (!this.globalLockdown && this.failedAttemptIPs.size >= this.globalAlertThreshold) {
      this.globalLockdown = true;
      console.log(`[PinManager] VERROUILLAGE GLOBAL ACTIVE: ${this.failedAttemptIPs.size} IPs differentes ont echoue`);

      this.emit('security-alert', {
        type: 'multiple-ip-failures',
        distinctIPs: this.failedAttemptIPs.size,
        totalAttempts: this.totalFailedAttempts,
        ips: Array.from(this.failedAttemptIPs),
        timestamp: new Date(),
        lockdownActivated: true
      });

      // Broadcast a toutes les sessions authentifiees
      this.emit('global-lockdown', {
        reason: `${this.failedAttemptIPs.size} tentatives depuis des IPs differentes`,
        timestamp: new Date()
      });
    }

    this.emit('login-failed', {
      ip,
      attempts: record.attempts,
      attemptsRemaining: this.maxAttemptsPerIP - record.attempts,
      timestamp: new Date()
    });

    return {
      success: false,
      error: 'PIN incorrect',
      attemptsRemaining: this.maxAttemptsPerIP - record.attempts
    };
  }

  /**
   * Deconnecter une session
   */
  logout(token) {
    const deleted = this.authenticatedSessions.delete(token);
    return { success: deleted };
  }

  /**
   * Obtenir les statistiques de securite
   */
  getStats() {
    return {
      pinEnabled: this.isPinEnabled(),
      globalLockdown: this.globalLockdown,
      blockedIPs: Array.from(this.ipAttempts.entries())
        .filter(([_, record]) => record.blocked)
        .map(([ip, record]) => ({
          ip,
          attempts: record.attempts,
          blockedAt: record.lastAttempt
        })),
      totalFailedAttempts: this.totalFailedAttempts,
      distinctFailedIPs: this.failedAttemptIPs.size,
      activeSessions: this.authenticatedSessions.size
    };
  }

  /**
   * Desactiver le verrouillage global (admin uniquement)
   */
  disableLockdown() {
    if (this.globalLockdown) {
      this.globalLockdown = false;
      console.log('[PinManager] Verrouillage global desactive manuellement');
      this.emit('lockdown-disabled', { timestamp: new Date() });
      return { success: true, message: 'Verrouillage desactive' };
    }
    return { success: false, message: 'Pas de verrouillage actif' };
  }

  /**
   * Nettoyer les sessions expirees
   */
  cleanupExpiredSessions() {
    const now = Date.now();
    let cleaned = 0;

    for (const [token, session] of this.authenticatedSessions.entries()) {
      if (now - session.authenticatedAt > this.sessionTimeout) {
        this.authenticatedSessions.delete(token);
        cleaned++;
      }
    }

    return cleaned;
  }
}

module.exports = PinManager;

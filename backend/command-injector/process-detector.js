/**
 * Process Detector - Détecte les sessions Claude Code en cours
 * Supporte Windows (PowerShell), Linux (tmux/screen) et macOS
 */

const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const path = require('path');

class ProcessDetector {
  constructor() {
    this.platform = process.platform;
    this.claudeDir = process.env.CLAUDE_DIR || path.join(process.env.USERPROFILE || process.env.HOME, '.claude');
  }

  /**
   * Trouve le processus Claude Code pour une session donnée
   * @param {string} sessionId - Identifiant de session (optionnel)
   * @returns {Promise<{pid, method, terminal, windowTitle}>}
   */
  async findClaudeProcess(sessionId = null) {
    console.log(`[ProcessDetector] Mode distant uniquement - Connexion CDP port 9222`);

    // MODE DISTANT UNIQUEMENT - Pas de détection locale
    // On suppose que Claude Desktop tourne avec --remote-debugging-port=9222

    const result = {
      pid: null,
      method: 'remote-cdp', // Méthode distante uniquement
      terminal: { type: 'none', sessions: [] },
      windowTitle: null,
      processes: []
    };

    console.log(`[ProcessDetector] Mode distant: method=${result.method}`);
    return result;
  }

  /**
   * Détermine la meilleure méthode d'injection
   * MODE DISTANT: Toujours utiliser CDP
   */
  determineMethod(terminal, windowInfo) {
    // MODE DISTANT UNIQUEMENT - Toujours retourner remote-cdp
    return 'remote-cdp';
  }

  /**
   * Liste les processus Claude/Node en cours
   */
  async listClaudeProcesses() {
    try {
      if (this.platform === 'win32') {
        return await this.listWindowsProcesses();
      } else {
        return await this.listUnixProcesses();
      }
    } catch (error) {
      console.error('[ProcessDetector] Erreur listClaudeProcesses:', error.message);
      return [];
    }
  }

  /**
   * Liste les processus sur Windows via PowerShell
   */
  async listWindowsProcesses() {
    try {
      // Recherche des processus node avec "claude" dans la ligne de commande
      const psCommand = `
        Get-Process -Name node -ErrorAction SilentlyContinue |
        ForEach-Object {
          $proc = $_
          $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.Id)" -ErrorAction SilentlyContinue).CommandLine
          if ($cmdLine -match 'claude') {
            [PSCustomObject]@{
              PID = $proc.Id
              Name = $proc.ProcessName
              CommandLine = $cmdLine
              WindowTitle = $proc.MainWindowTitle
            }
          }
        } | ConvertTo-Json -Compress
      `;

      const { stdout } = await execPromise(`powershell -Command "${psCommand.replace(/\n/g, ' ')}"`, {
        timeout: 10000
      });

      if (!stdout.trim()) {
        return [];
      }

      const result = JSON.parse(stdout);
      const processes = Array.isArray(result) ? result : [result];

      return processes.map(p => ({
        pid: p.PID,
        name: p.Name,
        commandLine: p.CommandLine,
        windowTitle: p.WindowTitle
      }));
    } catch (error) {
      console.error('[ProcessDetector] Erreur Windows process list:', error.message);
      return [];
    }
  }

  /**
   * Liste les processus sur Unix/Mac
   */
  async listUnixProcesses() {
    try {
      const { stdout } = await execPromise(
        'ps aux | grep -i "claude\\|anthropic" | grep -v grep',
        { timeout: 5000 }
      );

      const lines = stdout.trim().split('\n').filter(l => l.trim());
      return lines.map(line => {
        const parts = line.split(/\s+/);
        return {
          user: parts[0],
          pid: parseInt(parts[1]),
          commandLine: parts.slice(10).join(' ')
        };
      });
    } catch (error) {
      // grep retourne code 1 si aucun résultat
      return [];
    }
  }

  /**
   * Trouve les sessions terminal (tmux/screen)
   */
  async findTerminalSession() {
    // Sur Windows, pas de tmux/screen natif
    if (this.platform === 'win32') {
      // Vérifier si WSL est disponible avec tmux
      const wslTmux = await this.checkWSLTmux();
      if (wslTmux.available) {
        return { type: 'wsl-tmux', sessions: wslTmux.sessions };
      }
      return { type: 'none', sessions: [] };
    }

    // Vérifier tmux
    try {
      const { stdout: tmuxOut } = await execPromise('tmux list-sessions 2>/dev/null', {
        timeout: 5000
      });

      if (tmuxOut.trim()) {
        const sessions = this.parseTmuxSessions(tmuxOut);
        return { type: 'tmux', sessions };
      }
    } catch (e) {
      // tmux non disponible ou pas de sessions
    }

    // Vérifier screen
    try {
      const { stdout: screenOut } = await execPromise('screen -ls 2>/dev/null', {
        timeout: 5000
      });

      if (screenOut.includes('Socket')) {
        const sessions = this.parseScreenSessions(screenOut);
        return { type: 'screen', sessions };
      }
    } catch (e) {
      // screen non disponible
    }

    return { type: 'none', sessions: [] };
  }

  /**
   * Vérifie si WSL avec tmux est disponible (Windows uniquement)
   */
  async checkWSLTmux() {
    if (this.platform !== 'win32') {
      return { available: false, sessions: [] };
    }

    try {
      const { stdout } = await execPromise('wsl tmux list-sessions 2>/dev/null', {
        timeout: 5000
      });

      if (stdout.trim()) {
        const sessions = this.parseTmuxSessions(stdout);
        return { available: true, sessions };
      }
    } catch (e) {
      // WSL ou tmux non disponible
    }

    return { available: false, sessions: [] };
  }

  /**
   * Parse les sessions tmux
   */
  parseTmuxSessions(output) {
    const sessions = [];
    const lines = output.split('\n').filter(l => l.trim());

    for (const line of lines) {
      // Format: "session-name: 1 windows (created Mon Jan 12 10:30:00 2026) (attached)"
      const match = line.match(/^([^:]+):/);
      if (match) {
        sessions.push({
          name: match[1].trim(),
          active: line.includes('(attached)'),
          raw: line
        });
      }
    }

    return sessions;
  }

  /**
   * Parse les sessions screen
   */
  parseScreenSessions(output) {
    const sessions = [];
    const lines = output.split('\n').filter(l => l.trim());

    for (const line of lines) {
      // Format: "12345.session-name (Attached)" ou "12345.session-name (Detached)"
      const match = line.match(/(\d+)\.([^\s]+)/);
      if (match) {
        sessions.push({
          pid: match[1],
          name: match[2],
          active: line.includes('(Attached)'),
          raw: line
        });
      }
    }

    return sessions;
  }

  /**
   * Trouve la fenêtre Claude Code sur Windows
   */
  async findClaudeWindow() {
    if (this.platform !== 'win32') {
      return null;
    }

    try {
      // Approche simplifiée: Get-Process avec filtre sur MainWindowTitle
      const psCommand = `Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object Id, ProcessName, MainWindowTitle | ConvertTo-Json -Compress`;

      const { stdout } = await execPromise(`powershell -NoProfile -Command "${psCommand}"`, {
        timeout: 10000
      });

      if (!stdout.trim() || stdout.trim() === '[]') {
        return null;
      }

      const result = JSON.parse(stdout);
      const processes = Array.isArray(result) ? result : [result];

      // Priorité 1: Claude Desktop App (processus "Claude")
      const claudeDesktopApp = processes.find(p =>
        p.ProcessName && p.ProcessName.toLowerCase() === 'claude'
      );

      if (claudeDesktopApp) {
        return {
          pid: claudeDesktopApp.Id,
          title: claudeDesktopApp.MainWindowTitle,
          processName: claudeDesktopApp.ProcessName,
          type: 'desktop-app'
        };
      }

      // Priorité 2: Fenêtre avec "claude" dans le titre (terminal avec Claude Code)
      const claudeWindow = processes.find(p =>
        p.MainWindowTitle && (
          p.MainWindowTitle.toLowerCase().includes('claude') ||
          p.MainWindowTitle.includes('anthropic')
        )
      );

      if (claudeWindow) {
        return {
          pid: claudeWindow.Id,
          title: claudeWindow.MainWindowTitle,
          processName: claudeWindow.ProcessName,
          type: 'terminal-claude'
        };
      }

      // Priorité 3: Terminal générique (Windows Terminal, PowerShell, cmd)
      const terminalProcesses = ['WindowsTerminal', 'powershell', 'pwsh', 'cmd', 'ConEmuC64', 'ConEmuC'];
      const terminalWindow = processes.find(p =>
        terminalProcesses.includes(p.ProcessName)
      );

      return terminalWindow ? {
        pid: terminalWindow.Id,
        title: terminalWindow.MainWindowTitle,
        processName: terminalWindow.ProcessName,
        type: 'terminal-generic'
      } : null;

    } catch (error) {
      console.error('[ProcessDetector] Erreur findClaudeWindow:', error.message);
      return null;
    }
  }

  /**
   * Obtient des informations sur le système
   */
  getSystemInfo() {
    return {
      platform: this.platform,
      claudeDir: this.claudeDir,
      supportedMethods: this.getSupportedMethods()
    };
  }

  /**
   * Retourne les méthodes d'injection supportées sur ce système
   * MODE DISTANT: Uniquement CDP
   */
  getSupportedMethods() {
    // MODE DISTANT UNIQUEMENT
    return ['remote-cdp'];
  }
}

module.exports = ProcessDetector;

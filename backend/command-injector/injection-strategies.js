/**
 * Injection Strategies - Méthodes pour injecter des commandes dans Claude Code
 * Supporte Windows (SendKeys, UI Automation), macOS (AppleScript), Linux (tmux/screen/PTY)
 * Support spécial pour Claude Desktop App (Electron)
 */

const { exec, spawn } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const fs = require('fs');
const path = require('path');

class InjectionStrategies {
  constructor() {
    this.platform = process.platform;
    this.lastTargetedWindow = null;
    this.claudeDesktopInfo = null;
    this.scriptsDir = path.join(__dirname, 'scripts');
  }

  /**
   * Injection via tmux (Linux/Mac)
   * @param {string} sessionName - Nom de la session tmux
   * @param {string} command - Commande à injecter
   */
  async injectViaTmux(sessionName, command) {
    console.log(`[InjectionStrategies] Injection via tmux: session=${sessionName}`);

    try {
      // Use spawn with array arguments to avoid shell injection
      await new Promise((resolve, reject) => {
        const proc = spawn('tmux', ['send-keys', '-t', sessionName, command, 'Enter'], {
          timeout: 10000,
          shell: false  // Critical: no shell interpretation
        });

        let stderr = '';
        proc.stderr.on('data', (data) => { stderr += data; });
        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(stderr || `tmux exited with code ${code}`));
        });
      });

      return {
        success: true,
        method: 'tmux',
        session: sessionName
      };
    } catch (error) {
      console.error('[InjectionStrategies] Erreur tmux:', error.message);
      return {
        success: false,
        method: 'tmux',
        error: error.message
      };
    }
  }

  /**
   * Injection via WSL tmux (Windows avec WSL)
   * @param {string} sessionName - Nom de la session tmux dans WSL
   * @param {string} command - Commande à injecter
   */
  async injectViaWSLTmux(sessionName, command) {
    console.log(`[InjectionStrategies] Injection via WSL tmux: session=${sessionName}`);

    try {
      const escaped = command.replace(/'/g, "'\\''");
      const wslCmd = `wsl tmux send-keys -t "${sessionName}" '${escaped}' Enter`;

      await execPromise(wslCmd, { timeout: 10000 });

      return {
        success: true,
        method: 'wsl-tmux',
        session: sessionName
      };
    } catch (error) {
      console.error('[InjectionStrategies] Erreur WSL tmux:', error.message);
      return {
        success: false,
        method: 'wsl-tmux',
        error: error.message
      };
    }
  }

  /**
   * Injection via screen (Linux/Mac)
   * @param {string} sessionName - Nom de la session screen
   * @param {string} command - Commande à injecter
   */
  async injectViaScreen(sessionName, command) {
    console.log(`[InjectionStrategies] Injection via screen: session=${sessionName}`);

    try {
      const escaped = command.replace(/'/g, "'\\''");
      const screenCmd = `screen -S "${sessionName}" -X stuff '${escaped}\n'`;

      await execPromise(screenCmd, { timeout: 10000 });

      return {
        success: true,
        method: 'screen',
        session: sessionName
      };
    } catch (error) {
      console.error('[InjectionStrategies] Erreur screen:', error.message);
      return {
        success: false,
        method: 'screen',
        error: error.message
      };
    }
  }

  /**
   * Injection via Windows SendKeys (PowerShell + WScript.Shell)
   * @param {string} command - Commande à injecter
   * @param {string} windowTitle - Titre de la fenêtre cible (optionnel)
   */
  async injectViaWindowsSendKeys(command, windowTitle = null) {
    console.log(`[InjectionStrategies] Injection via Windows SendKeys (windowTitle: ${windowTitle || 'auto'})`);

    if (this.platform !== 'win32') {
      return {
        success: false,
        method: 'windows-sendkeys',
        error: 'Cette méthode est uniquement disponible sur Windows'
      };
    }

    try {
      // Échapper les caractères spéciaux pour SendKeys
      const escapedCommand = this.escapeForSendKeys(command);

      // IMPORTANT: Activer la fenêtre cible AVANT d'envoyer les touches
      const activatedWindow = await this.findAndActivateClaudeWindow(windowTitle);

      if (!activatedWindow) {
        console.warn('[InjectionStrategies] Aucune fenetre Claude/terminal trouvee, envoi a la fenetre active');
      } else {
        console.log(`[InjectionStrategies] Fenetre activee: "${activatedWindow}"`);
      }

      // Petit delai apres activation pour que la fenêtre soit bien au premier plan
      await this.delay(300);

      // Use -EncodedCommand to avoid injection (Base64 encoded UTF-16LE)
      const sendKeysScript = `$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys(${JSON.stringify(escapedCommand)}); Start-Sleep -Milliseconds 100; $wshell.SendKeys('{ENTER}')`;
      const encodedScript = Buffer.from(sendKeysScript, 'utf16le').toString('base64');

      await new Promise((resolve, reject) => {
        const proc = spawn('powershell', ['-NoProfile', '-EncodedCommand', encodedScript], {
          timeout: 15000,
          shell: false
        });
        proc.on('error', reject);
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`PowerShell exited with code ${code}`)));
      });

      return {
        success: true,
        method: 'windows-sendkeys',
        windowTitle: activatedWindow || 'active window'
      };
    } catch (error) {
      console.error('[InjectionStrategies] Erreur Windows SendKeys:', error.message);
      return {
        success: false,
        method: 'windows-sendkeys',
        error: error.message
      };
    }
  }

  /**
   * Trouve et active la fenêtre Claude Code sur Windows
   * Priorité: 1) Fenêtre avec "claude" dans le titre
   *           2) Windows Terminal
   *           3) PowerShell
   *           4) cmd
   */
  async findAndActivateClaudeWindow(preferredTitle = null) {
    try {
      // Script PowerShell simplifié pour trouver et activer une fenêtre
      const script = `
$target = $null
$allProcs = Get-Process | Where-Object { $_.MainWindowTitle -ne '' }

# Chercher fenetre Claude
$target = $allProcs | Where-Object { $_.MainWindowTitle -match 'claude' } | Select-Object -First 1

# Sinon Windows Terminal
if (-not $target) { $target = $allProcs | Where-Object { $_.ProcessName -eq 'WindowsTerminal' } | Select-Object -First 1 }

# Sinon PowerShell
if (-not $target) { $target = $allProcs | Where-Object { $_.ProcessName -match 'powershell|pwsh' } | Select-Object -First 1 }

# Sinon cmd
if (-not $target) { $target = $allProcs | Where-Object { $_.ProcessName -eq 'cmd' } | Select-Object -First 1 }

if ($target) {
  $wshell = New-Object -ComObject wscript.shell
  $wshell.AppActivate($target.Id) | Out-Null
  Write-Output $target.MainWindowTitle
}
      `.trim().replace(/\n/g, '; ');

      const { stdout } = await execPromise(`powershell -NoProfile -Command "${script}"`, {
        timeout: 10000
      });

      return stdout.trim() || null;
    } catch (error) {
      console.warn('[InjectionStrategies] Erreur activation fenetre:', error.message);
      return null;
    }
  }

  /**
   * Injection via Windows UI Automation pour Claude Desktop App (Electron)
   * Utilise PowerShell avec System.Windows.Automation pour cibler le champ de saisie
   * @param {string} command - Commande à injecter
   * @param {object} windowInfo - Info sur la fenêtre cible (optionnel)
   */
  async injectViaElectronUIAutomation(command, windowInfo = null) {
    console.log(`[InjectionStrategies] Injection via Electron UI Automation`);

    if (this.platform !== 'win32') {
      return {
        success: false,
        method: 'electron-uiautomation',
        error: 'Cette méthode est uniquement disponible sur Windows'
      };
    }

    try {
      // Étape 1: Trouver la fenêtre Claude Desktop
      const claudeWindow = await this.findClaudeDesktopWindow();

      if (!claudeWindow) {
        console.warn('[InjectionStrategies] Claude Desktop App non trouvee');
        return {
          success: false,
          method: 'electron-uiautomation',
          error: 'Claude Desktop App non trouvée. Assurez-vous que l\'application est ouverte.'
        };
      }

      console.log(`[InjectionStrategies] Claude Desktop trouvee: PID=${claudeWindow.pid}, Title="${claudeWindow.title}"`);

      // Étape 2: Activer la fenêtre et attendre qu'elle soit au premier plan
      await this.activateWindowByPid(claudeWindow.pid);
      await this.delay(400);

      // Étape 3: Utiliser UI Automation pour trouver et cibler le champ de saisie
      const focusResult = await this.focusElectronInputField(claudeWindow.pid);

      if (!focusResult.success) {
        console.log('[InjectionStrategies] UI Automation echouee, fallback vers clipboard direct');
        // Fallback: utiliser clipboard + Ctrl+V directement
        return await this.injectViaElectronClipboard(command, claudeWindow);
      }

      await this.delay(200);

      // Étape 4: Copier le message dans le clipboard et coller
      await this.copyToClipboard(command);
      await this.delay(100);

      // Coller avec Ctrl+V
      await execPromise(`powershell -NoProfile -Command "$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys('^v')"`, { timeout: 5000 });
      await this.delay(150);

      // Envoyer Enter
      await execPromise(`powershell -NoProfile -Command "$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys('{ENTER}')"`, { timeout: 5000 });

      this.lastTargetedWindow = claudeWindow;

      return {
        success: true,
        method: 'electron-uiautomation',
        windowTitle: claudeWindow.title,
        pid: claudeWindow.pid
      };

    } catch (error) {
      console.error('[InjectionStrategies] Erreur Electron UI Automation:', error.message);
      return {
        success: false,
        method: 'electron-uiautomation',
        error: error.message
      };
    }
  }

  /**
   * Injection via Clipboard optimisée pour Electron (Claude Desktop)
   * Active la fenêtre, focus le champ de saisie, colle et envoie
   * @param {string} command - Commande à injecter
   * @param {object} windowInfo - Info sur la fenêtre (optionnel)
   */
  async injectViaElectronClipboard(command, windowInfo = null) {
    console.log(`[InjectionStrategies] Injection via Electron Clipboard`);

    if (this.platform !== 'win32') {
      return {
        success: false,
        method: 'electron-clipboard',
        error: 'Cette méthode est uniquement disponible sur Windows'
      };
    }

    try {
      // Trouver la fenêtre si pas fournie
      const claudeWindow = windowInfo || await this.findClaudeDesktopWindow();

      if (!claudeWindow) {
        return {
          success: false,
          method: 'electron-clipboard',
          error: 'Claude Desktop App non trouvée'
        };
      }

      // Activer la fenêtre
      await this.activateWindowByPid(claudeWindow.pid);
      await this.delay(500);

      // Script PowerShell combiné pour:
      // 1. S'assurer que la fenêtre est active
      // 2. Copier dans le clipboard
      // 3. Tab pour focus sur le champ de saisie (si nécessaire)
      // 4. Ctrl+V pour coller
      // 5. Enter pour envoyer
      const combinedScript = `
        $wshell = New-Object -ComObject wscript.shell;
        Set-Clipboard -Value ${JSON.stringify(command)};
        Start-Sleep -Milliseconds 100;
        $wshell.AppActivate(${parseInt(claudeWindow.pid, 10)});
        Start-Sleep -Milliseconds 300;
        $wshell.SendKeys('^v');
        Start-Sleep -Milliseconds 200;
        $wshell.SendKeys('{ENTER}')
      `.trim();

      const encodedScript = Buffer.from(combinedScript, 'utf16le').toString('base64');

      await new Promise((resolve, reject) => {
        const proc = spawn('powershell', ['-NoProfile', '-EncodedCommand', encodedScript], {
          timeout: 10000,
          shell: false
        });
        proc.on('error', reject);
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`PowerShell exited with code ${code}`)));
      });

      this.lastTargetedWindow = claudeWindow;

      return {
        success: true,
        method: 'electron-clipboard',
        windowTitle: claudeWindow.title,
        pid: claudeWindow.pid
      };

    } catch (error) {
      console.error('[InjectionStrategies] Erreur Electron Clipboard:', error.message);
      return {
        success: false,
        method: 'electron-clipboard',
        error: error.message
      };
    }
  }

  /**
   * Trouve spécifiquement la fenêtre Claude Desktop App
   * Distingue entre Claude Desktop (Electron) et Claude Code (Terminal)
   */
  async findClaudeDesktopWindow() {
    if (this.platform !== 'win32') {
      return null;
    }

    try {
      // Utiliser le script PowerShell externe pour éviter les problèmes d'échappement
      const scriptPath = path.join(this.scriptsDir, 'find-claude-desktop.ps1');

      const { stdout } = await execPromise(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
        { timeout: 10000 }
      );

      if (!stdout.trim()) {
        return null;
      }

      const parts = stdout.trim().split('|');
      if (parts.length >= 3) {
        this.claudeDesktopInfo = {
          pid: parseInt(parts[0]),
          processName: parts[1],
          title: parts[2]
        };
        return this.claudeDesktopInfo;
      }

      return null;
    } catch (error) {
      console.error('[InjectionStrategies] Erreur findClaudeDesktopWindow:', error.message);
      return null;
    }
  }

  /**
   * Active une fenêtre par son PID
   */
  async activateWindowByPid(pid) {
    if (this.platform !== 'win32') {
      return false;
    }

    try {
      const script = `
        $wshell = New-Object -ComObject wscript.shell;
        $wshell.AppActivate(${pid});
        Start-Sleep -Milliseconds 100;
        $wshell.AppActivate(${pid})
      `.trim().replace(/\n/g, ' ');

      await execPromise(`powershell -NoProfile -Command "${script}"`, { timeout: 5000 });
      return true;
    } catch (error) {
      console.warn('[InjectionStrategies] Erreur activateWindowByPid:', error.message);
      return false;
    }
  }

  /**
   * Utilise UI Automation pour focus le champ de saisie dans une app Electron
   * Note: Fonctionne avec les apps Electron qui exposent l'accessibilité
   */
  async focusElectronInputField(pid) {
    try {
      // Script PowerShell utilisant UI Automation
      // On cherche un élément de type Edit ou Document dans la fenêtre
      const script = `
        Add-Type -AssemblyName UIAutomationClient;
        Add-Type -AssemblyName UIAutomationTypes;

        $process = Get-Process -Id ${pid} -ErrorAction SilentlyContinue;
        if (-not $process) { Write-Output 'PROCESS_NOT_FOUND'; exit }

        $hwnd = $process.MainWindowHandle;
        if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'NO_WINDOW'; exit }

        $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd);
        if (-not $root) { Write-Output 'NO_AUTOMATION'; exit }

        # Chercher un champ de saisie (Edit, Document ou Custom avec pattern Value/Text)
        $editCondition = New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
          [System.Windows.Automation.ControlType]::Edit
        );

        $editElement = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editCondition);

        if ($editElement) {
          $editElement.SetFocus();
          Write-Output 'FOCUSED_EDIT';
        } else {
          # Essayer Document
          $docCondition = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Document
          );
          $docElement = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $docCondition);

          if ($docElement) {
            $docElement.SetFocus();
            Write-Output 'FOCUSED_DOCUMENT';
          } else {
            Write-Output 'NO_INPUT_FOUND';
          }
        }
      `.trim().replace(/\n/g, ' ');

      const { stdout } = await execPromise(`powershell -NoProfile -Command "${script}"`, { timeout: 15000 });

      const result = stdout.trim();
      console.log(`[InjectionStrategies] UI Automation result: ${result}`);

      return {
        success: result.startsWith('FOCUSED'),
        result: result
      };
    } catch (error) {
      console.warn('[InjectionStrategies] Erreur focusElectronInputField:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Liste toutes les fenêtres Claude disponibles (Desktop et Terminal)
   * Utile pour permettre à l'utilisateur de choisir la cible
   */
  async listAllClaudeWindows() {
    if (this.platform !== 'win32') {
      return [];
    }

    try {
      // Utiliser le script PowerShell externe
      const scriptPath = path.join(this.scriptsDir, 'find-claude-windows.ps1');

      const { stdout } = await execPromise(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
        { timeout: 10000 }
      );

      if (!stdout.trim()) {
        return [];
      }

      return stdout.trim().split('\n').map(line => {
        const parts = line.trim().split('|');
        return {
          pid: parseInt(parts[0]),
          processName: parts[1] || '',
          title: parts[2] || '',
          type: parts[1]?.toLowerCase() === 'claude' ? 'desktop' : 'terminal'
        };
      }).filter(w => w.pid);
    } catch (error) {
      console.error('[InjectionStrategies] Erreur listAllClaudeWindows:', error.message);
      return [];
    }
  }

  /**
   * Injection via macOS AppleScript
   * @param {string} command - Commande à injecter
   * @param {string} appName - Nom de l'application (Terminal, iTerm, etc.)
   */
  async injectViaMacOSAppleScript(command, appName = 'Terminal') {
    console.log(`[InjectionStrategies] Injection via macOS AppleScript: app=${appName}`);

    if (this.platform !== 'darwin') {
      return {
        success: false,
        method: 'macos-applescript',
        error: 'Cette méthode est uniquement disponible sur macOS'
      };
    }

    try {
      // Échapper pour AppleScript
      const escaped = command.replace(/"/g, '\\"').replace(/\\/g, '\\\\');

      const appleScript = `
        tell application "${appName}"
          activate
          delay 0.2
          tell application "System Events"
            keystroke "${escaped}"
            delay 0.1
            keystroke return
          end tell
        end tell
      `;

      await execPromise(`osascript -e '${appleScript.replace(/'/g, "'\\''")}'`, {
        timeout: 15000
      });

      return {
        success: true,
        method: 'macos-applescript',
        app: appName
      };
    } catch (error) {
      console.error('[InjectionStrategies] Erreur AppleScript:', error.message);
      return {
        success: false,
        method: 'macos-applescript',
        error: error.message
      };
    }
  }

  /**
   * Injection via clipboard + paste (cross-platform)
   * @param {string} command - Commande à injecter
   */
  async injectViaClipboard(command) {
    console.log(`[InjectionStrategies] Injection via clipboard`);

    try {
      // Copier dans le presse-papiers
      await this.copyToClipboard(command);

      // Simuler Ctrl+V / Cmd+V puis Enter
      await this.simulatePaste();
      await this.delay(100);
      await this.simulateEnter();

      return {
        success: true,
        method: 'clipboard'
      };
    } catch (error) {
      console.error('[InjectionStrategies] Erreur clipboard:', error.message);
      return {
        success: false,
        method: 'clipboard',
        error: error.message
      };
    }
  }

  /**
   * Copie du texte dans le presse-papiers
   */
  async copyToClipboard(text) {
    if (this.platform === 'win32') {
      // Windows: utiliser clip via echo
      const escaped = text.replace(/"/g, '\\"');
      await execPromise(`powershell -Command "Set-Clipboard -Value '${escaped.replace(/'/g, "''")}'"`);
    } else if (this.platform === 'darwin') {
      // macOS: utiliser pbcopy
      const escaped = text.replace(/"/g, '\\"');
      await execPromise(`echo "${escaped}" | pbcopy`);
    } else {
      // Linux: utiliser xclip
      const escaped = text.replace(/"/g, '\\"');
      await execPromise(`echo "${escaped}" | xclip -selection clipboard`);
    }
  }

  /**
   * Simule Ctrl+V / Cmd+V
   */
  async simulatePaste() {
    if (this.platform === 'win32') {
      await execPromise(`powershell -Command "$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys('^v')"`);
    } else if (this.platform === 'darwin') {
      await execPromise(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`);
    } else {
      await execPromise(`xdotool key ctrl+v`);
    }
  }

  /**
   * Simule la touche Enter
   */
  async simulateEnter() {
    if (this.platform === 'win32') {
      await execPromise(`powershell -Command "$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys('{ENTER}')"`);
    } else if (this.platform === 'darwin') {
      await execPromise(`osascript -e 'tell application "System Events" to key code 36'`);
    } else {
      await execPromise(`xdotool key Return`);
    }
  }

  /**
   * Injection via FIFO pipe (Linux uniquement)
   * @param {string} fifoPath - Chemin du FIFO
   * @param {string} command - Commande à injecter
   */
  async injectViaFIFO(fifoPath, command) {
    console.log(`[InjectionStrategies] Injection via FIFO: ${fifoPath}`);

    if (this.platform === 'win32') {
      return {
        success: false,
        method: 'fifo',
        error: 'FIFO non supporté sur Windows'
      };
    }

    try {
      if (!fs.existsSync(fifoPath)) {
        return {
          success: false,
          method: 'fifo',
          error: `FIFO non trouvé: ${fifoPath}`
        };
      }

      fs.writeFileSync(fifoPath, command + '\n');

      return {
        success: true,
        method: 'fifo',
        fifoPath: fifoPath
      };
    } catch (error) {
      console.error('[InjectionStrategies] Erreur FIFO:', error.message);
      return {
        success: false,
        method: 'fifo',
        error: error.message
      };
    }
  }

  /**
   * Échappe les caractères spéciaux pour SendKeys Windows
   */
  escapeForSendKeys(text) {
    // Caractères spéciaux SendKeys qui doivent être échappés avec {}
    const specialChars = {
      '+': '{+}',
      '^': '{^}',
      '%': '{%}',
      '~': '{~}',
      '(': '{(}',
      ')': '{)}',
      '{': '{{}',
      '}': '{}}',
      '[': '{[}',
      ']': '{]}'
    };

    let escaped = '';
    for (const char of text) {
      escaped += specialChars[char] || char;
    }

    // Échapper les apostrophes pour PowerShell
    return escaped.replace(/'/g, "''");
  }

  /**
   * Utilitaire de délai
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Teste si une méthode d'injection est disponible
   */
  async testMethod(method) {
    switch (method) {
      case 'tmux':
        try {
          await execPromise('tmux -V', { timeout: 5000 });
          return { available: true, version: (await execPromise('tmux -V')).stdout.trim() };
        } catch {
          return { available: false };
        }

      case 'screen':
        try {
          await execPromise('screen -v', { timeout: 5000 });
          return { available: true };
        } catch {
          return { available: false };
        }

      case 'windows-sendkeys':
        return { available: this.platform === 'win32' };

      case 'electron-uiautomation':
        if (this.platform !== 'win32') {
          return { available: false };
        }
        // Vérifier si Claude Desktop est présent
        const claudeWindow = await this.findClaudeDesktopWindow();
        return {
          available: !!claudeWindow,
          claudeDesktopFound: !!claudeWindow,
          windowInfo: claudeWindow
        };

      case 'electron-clipboard':
        if (this.platform !== 'win32') {
          return { available: false };
        }
        const window = await this.findClaudeDesktopWindow();
        return {
          available: !!window,
          claudeDesktopFound: !!window
        };

      case 'macos-applescript':
        return { available: this.platform === 'darwin' };

      case 'clipboard':
        return { available: true };

      default:
        return { available: false };
    }
  }

  /**
   * Obtient la meilleure méthode d'injection pour la plateforme actuelle
   */
  async getBestMethod() {
    if (this.platform === 'win32') {
      // Vérifier si Claude Desktop est disponible (priorité)
      const claudeDesktop = await this.findClaudeDesktopWindow();
      if (claudeDesktop) {
        return {
          method: 'electron-uiautomation',
          reason: 'Claude Desktop App detectee',
          target: claudeDesktop
        };
      }

      // Sinon, utiliser SendKeys pour terminal
      return {
        method: 'windows-sendkeys',
        reason: 'Fallback vers terminal/fenetre active'
      };
    }

    if (this.platform === 'darwin') {
      return {
        method: 'macos-applescript',
        reason: 'macOS AppleScript disponible'
      };
    }

    // Linux: tmux si disponible
    try {
      await execPromise('tmux -V', { timeout: 2000 });
      return {
        method: 'tmux',
        reason: 'tmux disponible'
      };
    } catch {
      return {
        method: 'clipboard',
        reason: 'Fallback vers clipboard'
      };
    }
  }
}

module.exports = InjectionStrategies;

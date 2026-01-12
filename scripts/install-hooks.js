#!/usr/bin/env node
/**
 * Script d'installation des hooks Claude Code
 *
 * Usage:
 *   node scripts/install-hooks.js         # Installer les hooks
 *   node scripts/install-hooks.js --remove # Supprimer les hooks
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Configuration
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const HOOK_SCRIPT_PATH = path.join(__dirname, '..', 'hooks', 'permission-hook.js');

// Couleurs pour le terminal
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSuccess(message) {
  log(`✓ ${message}`, 'green');
}

function logWarning(message) {
  log(`⚠ ${message}`, 'yellow');
}

function logError(message) {
  log(`✗ ${message}`, 'red');
}

function logInfo(message) {
  log(`ℹ ${message}`, 'cyan');
}

// Lire les settings actuels
function readSettings() {
  try {
    if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) {
      return {};
    }
    const content = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    logWarning(`Impossible de lire settings.json: ${error.message}`);
    return {};
  }
}

// Ecrire les settings
function writeSettings(settings) {
  try {
    // Creer le dossier si necessaire
    const dir = path.dirname(CLAUDE_SETTINGS_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const content = JSON.stringify(settings, null, 2);
    fs.writeFileSync(CLAUDE_SETTINGS_PATH, content, 'utf-8');
    return true;
  } catch (error) {
    logError(`Impossible d'ecrire settings.json: ${error.message}`);
    return false;
  }
}

// Configuration du hook
function getHookConfig() {
  // Convertir le chemin Windows en format compatible
  const hookPath = HOOK_SCRIPT_PATH.replace(/\\/g, '/');

  return {
    matcher: '*',
    hooks: [{
      type: 'command',
      command: `node "${hookPath}"`
    }]
  };
}

// Installer les hooks
function installHooks() {
  log('\n=== Installation des hooks Claude Remote ===\n', 'bright');

  // Verifier que le script hook existe
  if (!fs.existsSync(HOOK_SCRIPT_PATH)) {
    logError(`Script hook non trouve: ${HOOK_SCRIPT_PATH}`);
    process.exit(1);
  }

  logInfo(`Fichier de configuration: ${CLAUDE_SETTINGS_PATH}`);
  logInfo(`Script hook: ${HOOK_SCRIPT_PATH}\n`);

  // Lire les settings actuels
  const settings = readSettings();

  // Sauvegarder l'ancienne config
  const backupPath = CLAUDE_SETTINGS_PATH + '.backup';
  if (Object.keys(settings).length > 0) {
    fs.writeFileSync(backupPath, JSON.stringify(settings, null, 2), 'utf-8');
    logInfo(`Backup cree: ${backupPath}`);
  }

  // Initialiser hooks si necessaire
  if (!settings.hooks) {
    settings.hooks = {};
  }

  // Ajouter PreToolUse hook
  const hookConfig = getHookConfig();

  if (!settings.hooks.PreToolUse) {
    settings.hooks.PreToolUse = [];
  }

  // Verifier si le hook est deja installe
  const existingHook = settings.hooks.PreToolUse.find(h =>
    h.hooks && h.hooks.some(hh => hh.command && hh.command.includes('permission-hook.js'))
  );

  if (existingHook) {
    logWarning('Les hooks sont deja installes');
    return;
  }

  // Ajouter le hook
  settings.hooks.PreToolUse.push(hookConfig);

  // Ecrire les nouveaux settings
  if (writeSettings(settings)) {
    logSuccess('Hooks installes avec succes!');

    log('\n=== Configuration actuelle ===\n', 'bright');
    console.log(JSON.stringify(settings.hooks, null, 2));

    log('\n=== Prochaines etapes ===\n', 'bright');
    logInfo('1. Demarrez le serveur Claude Remote: npm start');
    logInfo('2. Ouvrez Claude Code dans un terminal');
    logInfo('3. Les demandes d\'autorisation apparaitront sur votre mobile!');
  }
}

// Supprimer les hooks
function removeHooks() {
  log('\n=== Suppression des hooks Claude Remote ===\n', 'bright');

  const settings = readSettings();

  if (!settings.hooks || !settings.hooks.PreToolUse) {
    logWarning('Aucun hook a supprimer');
    return;
  }

  // Filtrer pour enlever nos hooks
  settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(h =>
    !(h.hooks && h.hooks.some(hh => hh.command && hh.command.includes('permission-hook.js')))
  );

  // Nettoyer si vide
  if (settings.hooks.PreToolUse.length === 0) {
    delete settings.hooks.PreToolUse;
  }
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  if (writeSettings(settings)) {
    logSuccess('Hooks supprimes avec succes!');
  }
}

// Afficher l'aide
function showHelp() {
  console.log(`
${colors.bright}Installation des hooks Claude Remote${colors.reset}

${colors.cyan}Usage:${colors.reset}
  node scripts/install-hooks.js           Installer les hooks
  node scripts/install-hooks.js --remove  Supprimer les hooks
  node scripts/install-hooks.js --status  Verifier le statut
  node scripts/install-hooks.js --help    Afficher cette aide

${colors.cyan}Description:${colors.reset}
  Ce script configure Claude Code pour envoyer les demandes
  d'autorisation au serveur Claude Remote, permettant de
  valider les actions depuis votre telephone.

${colors.cyan}Fichiers:${colors.reset}
  Settings: ${CLAUDE_SETTINGS_PATH}
  Hook:     ${HOOK_SCRIPT_PATH}
`);
}

// Verifier le statut
function checkStatus() {
  log('\n=== Statut des hooks Claude Remote ===\n', 'bright');

  const settings = readSettings();

  logInfo(`Fichier: ${CLAUDE_SETTINGS_PATH}`);

  if (!settings.hooks || !settings.hooks.PreToolUse) {
    logWarning('Hooks non configures');
    return;
  }

  const ourHook = settings.hooks.PreToolUse.find(h =>
    h.hooks && h.hooks.some(hh => hh.command && hh.command.includes('permission-hook.js'))
  );

  if (ourHook) {
    logSuccess('Hooks installes');
    console.log('\nConfiguration:');
    console.log(JSON.stringify(ourHook, null, 2));
  } else {
    logWarning('Hooks non installes');
  }

  // Verifier que le script existe
  if (fs.existsSync(HOOK_SCRIPT_PATH)) {
    logSuccess(`Script hook present: ${HOOK_SCRIPT_PATH}`);
  } else {
    logError(`Script hook manquant: ${HOOK_SCRIPT_PATH}`);
  }
}

// Main
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  showHelp();
} else if (args.includes('--remove') || args.includes('-r')) {
  removeHooks();
} else if (args.includes('--status') || args.includes('-s')) {
  checkStatus();
} else {
  installHooks();
}

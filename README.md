# Claude Remote

> Control Claude Desktop remotely from any device — free, secure, simple.

[English](#english) | [Français](#français)

---

## English

### What is Claude Remote?

A lightweight web interface to control **Claude Desktop** from your phone, tablet, or any browser. Monitor sessions, send messages, approve permissions — all remotely.

**Features:**
- **100% Free** — Uses Cloudflare Tunnel (no account needed)
- **Secure** — PIN authentication, HTTPS encryption, brute-force protection
- **Mobile-friendly** — Responsive UI works on any device
- **Real-time** — WebSocket updates, no refresh needed
- **Bilingual** — Auto-detects browser language (English/French)
- **Simple setup** — One command to start

<img width="1351" height="1166" alt="cc-remote" src="https://github.com/user-attachments/assets/5f498fc4-e5bd-4026-b582-83dc6e67496f" />

### Requirements

- **Claude Desktop** (not Claude Code CLI)
- Node.js 16+
- Windows

### Quick Start

```bash
first-install.bat   # First time only
launch.bat          # Start the app
```

### How it works

Claude Remote connects to Claude Desktop via Chrome DevTools Protocol (CDP) on port 9222. Your desktop runs Claude, your phone controls it.

```
Your Phone          Your Desktop           Claude Desktop
    |                   |                       |
    |---> HTTPS ------> Node.js Server -------> Port 9222 (CDP)
    |    (Tunnel)       (Express + WS)          (WebSocket)
```

### Project Structure

```
claude-remote/
├── backend/
│   ├── server.js              # Main Express server
│   ├── cdp-connection-monitor.js
│   ├── pin-manager.js         # Authentication
│   ├── favorites-manager.js
│   └── command-injector/      # CDP interaction scripts
├── public/
│   ├── index.html             # Main interface
│   ├── launcher.html          # QR code launcher
│   ├── app.js                 # Frontend logic
│   ├── i18n.js                # Translation system (FR/EN)
│   └── styles.css
├── docs/
│   ├── API.md
├── scripts/
└── launch.bat
```

### Documentation

**🚨 FOR DEVELOPERS/AI AGENTS: START HERE! 🚨**

**Comprehensive Technical Documentation**: [DocClaude/](DocClaude/) — **MANDATORY reading before modifying code**

- **[Master Index](DocClaude/DocClaude_00_INDEX.md)** ⭐ Start here for complete overview
- **[Quick Reference](DocClaude/README.md)** — Task-based documentation lookup

The `DocClaude/` directory contains **~200,000 words** of detailed technical documentation covering:
- All 87+ API endpoints
- Complete architecture explanations
- 46 WebSocket events
- 100+ functions with signatures
- 500+ code examples
- Security, authentication, sessions, orchestrator, frontend, CDP, i18n, and more

**User Documentation**:
- [API Reference](docs/API.md)
- [Cloudflare Tunnel Setup](docs/CLOUDFLARE_TUNNEL.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)

### About this project

This project was built as an experiment to test Claude's coding capabilities. **I (the human) wrote zero lines of code** — Claude designed the architecture, suggested using CDP debug mode, and implemented everything.

Feel free to fork! I probably won't maintain this actively since it was a proof-of-concept. Hopefully Anthropic will add official remote features someday.

Made with Claude

---

## Français

### Qu'est-ce que Claude Remote ?

Une interface web légère pour contrôler **Claude Desktop** installé sur votre PC directement depuis votre téléphone, tablette ou navigateur. Surveillez les sessions, envoyez des messages, approuvez les permissions — à distance.

**Fonctionnalités :**
- **100% Gratuit** — Utilise Cloudflare Tunnel (sans compte)
- **Sécurisé** — Authentification PIN, chiffrement HTTPS, protection anti-bruteforce
- **Mobile-friendly** — Interface responsive sur tous appareils
- **Temps réel** — Mises à jour WebSocket, pas de refresh
- **Bilingue** — Détection automatique de la langue (Français/Anglais)
- **Simple** — Une commande pour démarrer

<img width="1351" height="1166" alt="cc-remote" src="https://github.com/user-attachments/assets/9d81a2c2-4e47-440f-9c5d-46b689520ddf" />

### Prérequis

- **Claude Desktop** (pas Claude Code CLI)
- Node.js 16+
- Windows

### Démarrage rapide

```bash
first-install.bat   # Première fois uniquement
launch.bat          # Lancer l'app
```

### Comment ça marche

Claude Remote se connecte à Claude Desktop via Chrome DevTools Protocol (CDP) sur le port 9222. Votre PC fait tourner Claude, votre téléphone le contrôle.

```
Votre Téléphone     Votre Desktop          Claude Desktop
    |                   |                       |
    |---> HTTPS ------> Serveur Node.js ------> Port 9222 (CDP)
    |    (Tunnel)       (Express + WS)          (WebSocket)
```

### Structure du projet

```
claude-remote/
├── backend/
│   ├── server.js              # Serveur Express principal
│   ├── cdp-connection-monitor.js
│   ├── pin-manager.js         # Authentification
│   ├── favorites-manager.js
│   └── command-injector/      # Scripts d'interaction CDP
├── public/
│   ├── index.html             # Interface principale
│   ├── launcher.html          # Lanceur avec QR code
│   ├── app.js                 # Logique frontend
│   ├── i18n.js                # Système de traduction (FR/EN)
│   └── styles.css
├── docs/
│   ├── API.md
├── scripts/
└── launch.bat
```

### Documentation

- [Référence API](docs/API.md)
- [Configuration Cloudflare Tunnel](docs/CLOUDFLARE_TUNNEL.md)
- [Dépannage](docs/TROUBLESHOOTING.md)

### À propos

Ce projet est une expérience pour tester les capacités de Claude. **Je (l'humain) n'ai écrit aucune ligne de code** — Claude a conçu l'architecture, suggéré le mode debug CDP, et tout implémenté.

Forkez librement ! Je ne maintiendrai probablement pas ce projet car c'était un proof-of-concept. Espérons qu'Anthropic ajoutera des fonctionnalités remote officielles un jour.

Fait avec Claude

---

## License

MIT — See [LICENSE](LICENSE)

---

## Credits

Token visualization inspired by [Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) by [@Maciek-roboblog](https://github.com/Maciek-roboblog)

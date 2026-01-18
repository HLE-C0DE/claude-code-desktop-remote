// Système de traduction i18n pour ClaudeCode_Remote
// Auto-détection de la langue du navigateur avec fallback FR

const translations = {
    fr: {
        // Launcher page (QR Code)
        launcher: {
            title: "🚀 ClaudeCode_Remote",
            subtitle: "Votre serveur est prêt !",
            serverActive: "Serveur actif",
            serverStopped: "Serveur arrêté",
            scanQR: "📱 Scannez ce QR code avec votre téléphone",
            loading: "Chargement...",
            copyBtn: "📋 Copier",
            copied: "✅ Copié !",
            shareTitle: "📤 Partager le lien",
            shutdownBtn: "🛑 Arrêter le serveur",
            shutdownConfirm: "⚠️ Voulez-vous vraiment arrêter le serveur ?\n\nLe tunnel Cloudflare sera également fermé.",
            shutdownInProgress: "🛑 Arrêt du serveur en cours...",
            shutdownSuccess: "✅ Serveur arrêté avec succès",
            shutdownError: "❌ Erreur lors de l'arrêt du serveur",
            serverStoppedMessage: "✅ Serveur arrêté",
            closeWindow: "Vous pouvez fermer cette fenêtre",
            urlCopied: "✅ URL copiée dans le presse-papier !",
            copyError: "❌ Erreur lors de la copie",
            qrDownload: "⬇️ Téléchargement du QR code...",
            notionCopied: "✅ Markdown copié ! Collez-le dans Notion (Ctrl+V)",
            discordCopied: "✅ Message copié ! Collez-le dans Discord",
            connectionError: "❌ Erreur de connexion",
            emailSubject: "🚀 ClaudeCode_Remote - Accès au serveur",
            emailBody: "Bonjour,\n\nVoici le lien pour accéder à mon serveur ClaudeCode_Remote :\n\n{url}\n\nÀ bientôt !",
            shareMessage: "🚀 Accède à mon serveur ClaudeCode_Remote :\n{url}",
            footerVersion: "ClaudeCode_Remote v1.1"
        },

        // Main app interface
        app: {
            backBtn: "← Retour",
            statusConnecting: "...",
            cdpTooltip: "Connexions directes au port 9222 (Chrome DevTools Protocol)",
            cdpLabel: "Port 9222:",
            logsBtn: "📊 Logs",
            logsBtnTooltip: "Afficher les logs serveur en temps réel",
            tasksTitle: "📋 Tâches",
            serverLogsTitle: "🖥️ Server Logs",
            logsCount: "{count} logs",
            allLevels: "All levels",
            logLevel: "Log",
            infoLevel: "Info",
            warnLevel: "Warn",
            errorLevel: "Error",
            searchPlaceholder: "Search...",
            clearLogs: "Clear logs",
            refresh: "Refresh",
            loadingLogs: "Loading logs...",

            // États de connexion
            connecting: "Connexion...",
            connected: "Connecté",
            disconnected: "Déconnecté",
            reconnecting: "Reconnexion...",
            error: "Erreur",

            // Dashboard & Usage
            creditsTitle: "💳 Crédits Claude Code",
            loading: "Chargement...",
            availableNow: "Disponible maintenant",
            tokens: "tokens",
            used: "utilisé",
            nextRefresh: "Prochain refresh",
            windowStart: "Début fenêtre",
            currentRate: "Taux actuel",
            tokensPerMin: "tokens/min",
            refreshData: "Rafraîchir les données",
            unknown: "Inconnu",

            // Sessions list
            activeSessions: "Sessions actives",
            inactiveSessions: "Sessions inactives",
            showInactive: "Afficher les sessions inactives",
            hideInactive: "Masquer les sessions inactives",
            noActiveSessions: "Aucune session active",
            noInactiveSessions: "Aucune session inactive",

            // Session details
            sessionNotFound: "Session non trouvée",
            noMessages: "Aucun message dans cette session",
            messages: "Messages",
            inputTokens: "Tokens entrée",
            outputTokens: "Tokens sortie",
            cacheCreationTokens: "Tokens création cache",
            cacheReadTokens: "Tokens lecture cache",
            loadMore: "Charger plus",
            loadingMore: "Chargement...",

            // Errors
            errorTitle: "❌ Erreur",
            errorLoading: "Erreur lors du chargement",
            cdpNotAvailable: "⚠️ Connexion CDP non disponible",
            cdpWarning: "Claude Code n'est peut-être pas lancé ou le port 9222 n'est pas accessible.",
            retryConnection: "Réessayer la connexion",

            // Tools & Actions
            toolUse: "Outil utilisé",
            toolResult: "Résultat",
            thinking: "Réflexion",

            // Time units
            inMinutes: "dans {minutes} min",
            inHours: "dans {hours}h {minutes}min",
            now: "maintenant",

            // CDP connections
            external: "externe",
            local: "local",

            // Buttons
            close: "Fermer",
            cancel: "Annuler",
            confirm: "Confirmer",
            delete: "Supprimer",
            deleteAll: "Tout supprimer",
            remove: "Retirer"
        },

        // Home page
        home: {
            noSessions: "Aucune session",
            noSessionsDesc: "Les sessions Claude Code apparaîtront ici automatiquement.",
            noSessionsInfo: "Assurez-vous que le dossier Claude est correctement configuré dans le fichier .env",
            newSession: "Nouvelle session",
            sessions: "Sessions",
            refresh: "Actualiser",
            activeSessions: "Sessions actives",
            noActiveSession: "Aucune session active",
            pastSessions: "Sessions passées"
        },

        // New session modal
        newSessionModal: {
            title: "🚀 Nouvelle session",
            nameLabel: "Nom de la session (requis)",
            namePlaceholder: "Ex: Feature login, Bug fix #123, Refactor API...",
            nameHint: "Ce nom apparaîtra dans l'interface et dans Claude Desktop",
            pathLabel: "Chemin du dossier de travail",
            pathPlaceholder: "C:\\Users\\...\\MonProjet ou /home/.../mon-projet",
            pathHint: "Entrez le chemin absolu du dossier où Claude Code travaillera",
            messageLabel: "Message initial (requis)",
            messagePlaceholder: "Ex: Aide-moi à comprendre ce projet...",
            messageHint: "Le message que Claude recevra pour démarrer la session",
            favorites: "⭐ Favoris",
            recents: "🕒 Récents",
            projects: "📂 Projets trouvés",
            manageFavorites: "Gérer",
            addToFavorites: "⭐ Ajouter aux favoris",
            removeFromFavorites: "❌ Retirer des favoris",
            noPathsRecorded: "Aucun chemin enregistré",
            pathsWillAppearHere: "Vos chemins récents et favoris apparaîtront ici",
            cancelBtn: "Annuler",
            launchBtn: "🚀 Lancer la session",
            sessionCreated: "Session créée avec succès!",
            sessionCreatedWithName: "Session \"{name}\" créée!",
            manageFavoritesTitle: "⭐ Gérer les favoris",
            noFavorites: "Aucun favori pour le moment.",
            addFavoritesHint: "Ajoutez des chemins en favoris depuis le modal \"Nouvelle session\".",
            nicknamePlaceholder: "Surnom (optionnel)",
            errorCreating: "Erreur lors de la création",
            errorMessage: "Erreur: {message}"
        },

        // Session details
        session: {
            statusThinking: "Claude travaille...",
            statusWaiting: "En attente",
            statusIdle: "Inactif",
            statusActive: "En cours",
            noMessage: "Aucun message",
            status: "Statut",
            messagesCount: "Messages",
            directory: "Répertoire",
            branch: "Branche",
            lastActivity: "Dernière activité",
            conversation: "Conversation",
            sendMessage: "Envoyer un message",
            messagePlaceholder: "Tapez votre message pour Claude...",
            sendBtn: "Envoyer",
            interruptBtn: "Interrompre",
            noMessagesInSession: "Aucun message dans cette session",
            expirationWarning: "Votre session expire dans {minutes} minute(s)",
            extendSession: "Prolonger la session",
            sessionExtended: "Session prolongée avec succès"
        },

        // Context widget
        contextWidget: {
            title: "Fenêtre de contexte",
            estimateBadge: "Estimation basée sur le contenu",
            userMessages: "Vos messages",
            assistantMessages: "Réponses Claude",
            toolResults: "Résultats outils",
            systemPrompt: "System prompt"
        },

        // PIN login page
        pinLogin: {
            title: "ClaudeCode_Remote",
            subtitle: "Entrez le PIN pour accéder à l'interface",
            placeholder: "******",
            loginBtn: "Se connecter",
            verifying: "Vérification...",
            pinError: "Le PIN doit contenir 6 chiffres",
            incorrectPin: "PIN incorrect",
            attemptsWarning: "Attention: {count} tentative{plural} restante{plural} avant blocage",
            connectionError: "Erreur de connexion au serveur"
        },

        // Blocked page
        blocked: {
            title: "Accès bloqué",
            message: "Trop de tentatives incorrectes.",
            ipBlocked: "Votre adresse IP a été bloquée pour cette session du serveur.",
            instruction: "Contactez l'administrateur ou redémarrez le serveur pour débloquer l'accès."
        },

        // Security notifications
        security: {
            ipBlocked: "IP bloquée: {ip}",
            multipleAttempts: "Alerte: Multiples tentatives d'accès détectées!"
        }
    },

    en: {
        // Launcher page (QR Code)
        launcher: {
            title: "🚀 ClaudeCode_Remote",
            subtitle: "Your server is ready!",
            serverActive: "Server active",
            serverStopped: "Server stopped",
            scanQR: "📱 Scan this QR code with your phone",
            loading: "Loading...",
            copyBtn: "📋 Copy",
            copied: "✅ Copied!",
            shareTitle: "📤 Share the link",
            shutdownBtn: "🛑 Stop server",
            shutdownConfirm: "⚠️ Do you really want to stop the server?\n\nThe Cloudflare tunnel will also be closed.",
            shutdownInProgress: "🛑 Stopping server...",
            shutdownSuccess: "✅ Server stopped successfully",
            shutdownError: "❌ Error while stopping server",
            serverStoppedMessage: "✅ Server stopped",
            closeWindow: "You can close this window",
            urlCopied: "✅ URL copied to clipboard!",
            copyError: "❌ Copy error",
            qrDownload: "⬇️ Downloading QR code...",
            notionCopied: "✅ Markdown copied! Paste it in Notion (Ctrl+V)",
            discordCopied: "✅ Message copied! Paste it in Discord",
            connectionError: "❌ Connection error",
            emailSubject: "🚀 ClaudeCode_Remote - Server access",
            emailBody: "Hello,\n\nHere is the link to access my ClaudeCode_Remote server:\n\n{url}\n\nSee you soon!",
            shareMessage: "🚀 Access my ClaudeCode_Remote server:\n{url}",
            footerVersion: "ClaudeCode_Remote v1.1"
        },

        // Main app interface
        app: {
            backBtn: "← Back",
            statusConnecting: "...",
            cdpTooltip: "Direct connections to port 9222 (Chrome DevTools Protocol)",
            cdpLabel: "Port 9222:",
            logsBtn: "📊 Logs",
            logsBtnTooltip: "Show server logs in real-time",
            tasksTitle: "📋 Tasks",
            serverLogsTitle: "🖥️ Server Logs",
            logsCount: "{count} logs",
            allLevels: "All levels",
            logLevel: "Log",
            infoLevel: "Info",
            warnLevel: "Warn",
            errorLevel: "Error",
            searchPlaceholder: "Search...",
            clearLogs: "Clear logs",
            refresh: "Refresh",
            loadingLogs: "Loading logs...",

            // Connection states
            connecting: "Connecting...",
            connected: "Connected",
            disconnected: "Disconnected",
            reconnecting: "Reconnecting...",
            error: "Error",

            // Dashboard & Usage
            creditsTitle: "💳 Claude Code Credits",
            loading: "Loading...",
            availableNow: "Available now",
            tokens: "tokens",
            used: "used",
            nextRefresh: "Next refresh",
            windowStart: "Window start",
            currentRate: "Current rate",
            tokensPerMin: "tokens/min",
            refreshData: "Refresh data",
            unknown: "Unknown",

            // Sessions list
            activeSessions: "Active sessions",
            inactiveSessions: "Inactive sessions",
            showInactive: "Show inactive sessions",
            hideInactive: "Hide inactive sessions",
            noActiveSessions: "No active sessions",
            noInactiveSessions: "No inactive sessions",

            // Session details
            sessionNotFound: "Session not found",
            noMessages: "No messages in this session",
            messages: "Messages",
            inputTokens: "Input tokens",
            outputTokens: "Output tokens",
            cacheCreationTokens: "Cache creation tokens",
            cacheReadTokens: "Cache read tokens",
            loadMore: "Load more",
            loadingMore: "Loading...",

            // Errors
            errorTitle: "❌ Error",
            errorLoading: "Error while loading",
            cdpNotAvailable: "⚠️ CDP connection unavailable",
            cdpWarning: "Claude Code may not be running or port 9222 is not accessible.",
            retryConnection: "Retry connection",

            // Tools & Actions
            toolUse: "Tool used",
            toolResult: "Result",
            thinking: "Thinking",

            // Time units
            inMinutes: "in {minutes} min",
            inHours: "in {hours}h {minutes}min",
            now: "now",

            // CDP connections
            external: "external",
            local: "local",

            // Buttons
            close: "Close",
            cancel: "Cancel",
            confirm: "Confirm",
            delete: "Delete",
            deleteAll: "Delete all",
            remove: "Remove"
        },

        // Home page
        home: {
            noSessions: "No sessions",
            noSessionsDesc: "Claude Code sessions will appear here automatically.",
            noSessionsInfo: "Make sure the Claude folder is correctly configured in the .env file",
            newSession: "New session",
            sessions: "Sessions",
            refresh: "Refresh",
            activeSessions: "Active sessions",
            noActiveSession: "No active session",
            pastSessions: "Past sessions"
        },

        // New session modal
        newSessionModal: {
            title: "🚀 New session",
            nameLabel: "Session name (required)",
            namePlaceholder: "Ex: Feature login, Bug fix #123, Refactor API...",
            nameHint: "This name will appear in the interface and in Claude Desktop",
            pathLabel: "Working directory path",
            pathPlaceholder: "C:\\Users\\...\\MyProject or /home/.../my-project",
            pathHint: "Enter the absolute path of the folder where Claude Code will work",
            messageLabel: "Initial message (required)",
            messagePlaceholder: "Ex: Help me understand this project...",
            messageHint: "The message Claude will receive to start the session",
            favorites: "⭐ Favorites",
            recents: "🕒 Recents",
            projects: "📂 Projects found",
            manageFavorites: "Manage",
            addToFavorites: "⭐ Add to favorites",
            removeFromFavorites: "❌ Remove from favorites",
            noPathsRecorded: "No paths recorded",
            pathsWillAppearHere: "Your recent and favorite paths will appear here",
            cancelBtn: "Cancel",
            launchBtn: "🚀 Launch session",
            sessionCreated: "Session created successfully!",
            sessionCreatedWithName: "Session \"{name}\" created!",
            manageFavoritesTitle: "⭐ Manage favorites",
            noFavorites: "No favorites yet.",
            addFavoritesHint: "Add paths to favorites from the \"New session\" modal.",
            nicknamePlaceholder: "Nickname (optional)",
            errorCreating: "Error while creating",
            errorMessage: "Error: {message}"
        },

        // Session details
        session: {
            statusThinking: "Claude is working...",
            statusWaiting: "Waiting",
            statusIdle: "Idle",
            statusActive: "Active",
            noMessage: "No message",
            status: "Status",
            messagesCount: "Messages",
            directory: "Directory",
            branch: "Branch",
            lastActivity: "Last activity",
            conversation: "Conversation",
            sendMessage: "Send a message",
            messagePlaceholder: "Type your message for Claude...",
            sendBtn: "Send",
            interruptBtn: "Interrupt",
            noMessagesInSession: "No messages in this session",
            expirationWarning: "Your session expires in {minutes} minute(s)",
            extendSession: "Extend session",
            sessionExtended: "Session extended successfully"
        },

        // Context widget
        contextWidget: {
            title: "Context window",
            estimateBadge: "Estimation based on content",
            userMessages: "Your messages",
            assistantMessages: "Claude responses",
            toolResults: "Tool results",
            systemPrompt: "System prompt"
        },

        // PIN login page
        pinLogin: {
            title: "ClaudeCode_Remote",
            subtitle: "Enter the PIN to access the interface",
            placeholder: "******",
            loginBtn: "Login",
            verifying: "Verifying...",
            pinError: "PIN must contain 6 digits",
            incorrectPin: "Incorrect PIN",
            attemptsWarning: "Warning: {count} attempt{plural} remaining before blocking",
            connectionError: "Server connection error"
        },

        // Blocked page
        blocked: {
            title: "Access blocked",
            message: "Too many incorrect attempts.",
            ipBlocked: "Your IP address has been blocked for this server session.",
            instruction: "Contact the administrator or restart the server to unblock access."
        },

        // Security notifications
        security: {
            ipBlocked: "IP blocked: {ip}",
            multipleAttempts: "Alert: Multiple access attempts detected!"
        }
    }
};

// Classe de gestion i18n
class I18n {
    constructor() {
        this.currentLang = this.detectLanguage();
        this.translations = translations;
    }

    // Auto-détection de la langue du navigateur
    detectLanguage() {
        // 1. Vérifier si une préférence est sauvegardée
        const savedLang = localStorage.getItem('claudecode_lang');
        if (savedLang && (savedLang === 'fr' || savedLang === 'en')) {
            return savedLang;
        }

        // 2. Premier chargement : détecter la langue du navigateur
        const browserLang = navigator.language || navigator.userLanguage;
        const detectedLang = (browserLang && browserLang.toLowerCase().startsWith('fr')) ? 'fr' : 'en';

        // Sauvegarder le choix auto-détecté pour ne plus le refaire
        localStorage.setItem('claudecode_lang', detectedLang);

        return detectedLang;
    }

    // Changer la langue
    setLanguage(lang) {
        if (lang === 'fr' || lang === 'en') {
            this.currentLang = lang;
            localStorage.setItem('claudecode_lang', lang);

            // Mettre à jour l'attribut lang du HTML
            document.documentElement.lang = lang;

            return true;
        }
        return false;
    }

    // Obtenir une traduction
    t(key, replacements = {}) {
        const keys = key.split('.');
        let value = this.translations[this.currentLang];

        for (const k of keys) {
            if (value && typeof value === 'object') {
                value = value[k];
            } else {
                // Fallback vers français si la clé n'existe pas
                value = this.translations['fr'];
                for (const k2 of keys) {
                    if (value && typeof value === 'object') {
                        value = value[k2];
                    } else {
                        return key; // Retourner la clé si rien n'est trouvé
                    }
                }
                break;
            }
        }

        // Remplacer les placeholders {key}
        if (typeof value === 'string') {
            for (const [placeholder, replacement] of Object.entries(replacements)) {
                value = value.replace(new RegExp(`\\{${placeholder}\\}`, 'g'), replacement);
            }
        }

        return value || key;
    }

    // Obtenir la langue actuelle
    getCurrentLanguage() {
        return this.currentLang;
    }

    // Obtenir le nom complet de la langue actuelle
    getCurrentLanguageName() {
        return this.currentLang === 'fr' ? 'Français' : 'English';
    }

    // Obtenir la langue alternative
    getAlternativeLanguage() {
        return this.currentLang === 'fr' ? 'en' : 'fr';
    }

    // Obtenir le nom de la langue alternative
    getAlternativeLanguageName() {
        return this.currentLang === 'fr' ? 'English' : 'Français';
    }

    // Basculer entre les langues
    toggleLanguage() {
        const newLang = this.getAlternativeLanguage();
        this.setLanguage(newLang);
        return newLang;
    }
}

// Instance globale
window.i18n = new I18n();

// Gestion des traductions pour l'interface principale
// Ce fichier doit être chargé APRÈS i18n.js et AVANT l'initialisation de l'app

// Fonction pour mettre à jour tous les textes de l'interface
function updateAppTranslations() {
    if (!window.i18n) {
        console.error('i18n not loaded');
        return;
    }

    const lang = window.i18n.getCurrentLanguage();

    // Mettre à jour l'attribut lang du HTML
    document.documentElement.lang = lang;

    // Mettre à jour le sélecteur de langue
    const altLang = window.i18n.getAlternativeLanguage();
    const langFlag = document.getElementById('lang-flag');
    const langName = document.getElementById('lang-name');
    if (langFlag && langName) {
        langFlag.textContent = altLang === 'en' ? '🇬🇧' : '🇫🇷';
        langName.textContent = window.i18n.getAlternativeLanguageName();
    }

    // Header
    const backBtn = document.getElementById('back-btn-text');
    if (backBtn) backBtn.textContent = window.i18n.t('app.backBtn');

    const cdpLabel = document.getElementById('cdp-label');
    if (cdpLabel) cdpLabel.textContent = window.i18n.t('app.cdpLabel');

    const logsBtn = document.getElementById('logs-btn-text');
    if (logsBtn) logsBtn.textContent = window.i18n.t('app.logsBtn');

    // Tasklist
    const tasklistTitle = document.getElementById('tasklist-title');
    if (tasklistTitle) tasklistTitle.textContent = window.i18n.t('app.tasksTitle');

    // Server Logs
    const serverlogsTitle = document.getElementById('serverlogs-title');
    if (serverlogsTitle) serverlogsTitle.textContent = window.i18n.t('app.serverLogsTitle');

    // Server Logs - Select options
    const optAll = document.getElementById('opt-all');
    if (optAll) optAll.textContent = window.i18n.t('app.allLevels');

    const optLog = document.getElementById('opt-log');
    if (optLog) optLog.textContent = window.i18n.t('app.logLevel');

    const optInfo = document.getElementById('opt-info');
    if (optInfo) optInfo.textContent = window.i18n.t('app.infoLevel');

    const optWarn = document.getElementById('opt-warn');
    if (optWarn) optWarn.textContent = window.i18n.t('app.warnLevel');

    const optError = document.getElementById('opt-error');
    if (optError) optError.textContent = window.i18n.t('app.errorLevel');

    // Server Logs - Search placeholder
    const serverlogsSearch = document.getElementById('serverlogs-search');
    if (serverlogsSearch) serverlogsSearch.placeholder = window.i18n.t('app.searchPlaceholder');

    // Server Logs - Loading text
    const serverlogsLoading = document.getElementById('serverlogs-loading');
    if (serverlogsLoading) serverlogsLoading.textContent = window.i18n.t('app.loadingLogs');

    // Tooltips
    const cdpContainer = document.getElementById('cdp-connection-container');
    if (cdpContainer) cdpContainer.title = window.i18n.t('app.cdpTooltip');

    const serverLogsBtn = document.getElementById('server-logs-btn');
    if (serverLogsBtn) serverLogsBtn.title = window.i18n.t('app.logsBtnTooltip');

    const clearBtn = document.getElementById('serverlogs-clear-btn');
    if (clearBtn) clearBtn.title = window.i18n.t('app.clearLogs');

    const refreshBtn = document.getElementById('serverlogs-refresh-btn');
    if (refreshBtn) refreshBtn.title = window.i18n.t('app.refresh');
}

// Fonction pour basculer la langue
function toggleLanguage() {
    if (!window.i18n) return;

    window.i18n.toggleLanguage();
    updateAppTranslations();

    // Émettre un événement personnalisé pour que d'autres parties de l'app puissent réagir
    window.dispatchEvent(new CustomEvent('languageChanged', {
        detail: { language: window.i18n.getCurrentLanguage() }
    }));
}

// Initialiser les traductions au chargement
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateAppTranslations);
} else {
    updateAppTranslations();
}

// Observer pour mettre à jour les traductions quand de nouveaux éléments sont ajoutés
const translationObserver = new MutationObserver((mutations) => {
    // Vérifier si de nouveaux éléments avec des IDs traductibles ont été ajoutés
    let shouldUpdate = false;
    for (const mutation of mutations) {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    // Vérifier si l'élément ou ses enfants ont des IDs que nous traduisons
                    if (node.id || node.querySelector('[id]')) {
                        shouldUpdate = true;
                        break;
                    }
                }
            }
        }
        if (shouldUpdate) break;
    }

    if (shouldUpdate) {
        updateAppTranslations();
    }
});

// Observer le DOM pour les changements
translationObserver.observe(document.body, {
    childList: true,
    subtree: true
});

// Exporter les fonctions pour qu'elles soient accessibles globalement
window.updateAppTranslations = updateAppTranslations;
window.toggleLanguage = toggleLanguage;

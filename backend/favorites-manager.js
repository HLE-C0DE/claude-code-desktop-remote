const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

/**
 * Gestionnaire de favoris pour les chemins de projets
 * Persistance via fichier JSON
 */
class FavoritesManager extends EventEmitter {
  constructor(options = {}) {
    super();

    // Répertoire de stockage des favoris
    this.dataDir = options.dataDir || path.join(require('os').homedir(), '.claude-monitor');
    this.filePath = path.join(this.dataDir, 'favorites.json');

    // Structure: [{ path: string, nickname: string?, addedAt: ISO date }]
    this.favorites = [];

    // Charger les favoris au démarrage
    this.load();
  }

  /**
   * Charger les favoris depuis le fichier
   */
  load() {
    try {
      // Créer le répertoire si nécessaire
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }

      // Charger le fichier JSON
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, 'utf8');
        this.favorites = JSON.parse(data);
        console.log(`[Favorites] ${this.favorites.length} favoris chargés`);
      } else {
        console.log('[Favorites] Aucun fichier de favoris trouvé, création d\'un nouveau');
        this.save();
      }
    } catch (error) {
      console.error('[Favorites] Erreur lors du chargement:', error.message);
      this.favorites = [];
    }
  }

  /**
   * Sauvegarder les favoris dans le fichier
   */
  save() {
    try {
      // Créer le répertoire si nécessaire
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }

      // Sauvegarder dans le fichier JSON
      fs.writeFileSync(this.filePath, JSON.stringify(this.favorites, null, 2), 'utf8');
      this.emit('favorites-saved', { count: this.favorites.length });
    } catch (error) {
      console.error('[Favorites] Erreur lors de la sauvegarde:', error.message);
      throw error;
    }
  }

  /**
   * Obtenir tous les favoris
   */
  getAll() {
    return this.favorites;
  }

  /**
   * Ajouter un favori
   * @param {string} path - Chemin du projet
   * @param {string} [nickname] - Surnom optionnel
   */
  add(path, nickname = null) {
    // Vérifier si le favori existe déjà
    const existing = this.favorites.find(f => f.path === path);
    if (existing) {
      // Mettre à jour le surnom si fourni
      if (nickname) {
        existing.nickname = nickname;
        this.save();
        this.emit('favorite-updated', existing);
        return existing;
      }
      return existing;
    }

    // Ajouter le nouveau favori
    const favorite = {
      path,
      nickname: nickname || null,
      addedAt: new Date().toISOString()
    };

    this.favorites.unshift(favorite);
    this.save();
    this.emit('favorite-added', favorite);
    return favorite;
  }

  /**
   * Retirer un favori
   * @param {string} path - Chemin du projet
   */
  remove(path) {
    const index = this.favorites.findIndex(f => f.path === path);
    if (index === -1) {
      return false;
    }

    const removed = this.favorites.splice(index, 1)[0];
    this.save();
    this.emit('favorite-removed', removed);
    return true;
  }

  /**
   * Mettre à jour le surnom d'un favori
   * @param {string} path - Chemin du projet
   * @param {string} nickname - Nouveau surnom
   */
  updateNickname(path, nickname) {
    const favorite = this.favorites.find(f => f.path === path);
    if (!favorite) {
      throw new Error('Favori non trouvé');
    }

    favorite.nickname = nickname;
    this.save();
    this.emit('favorite-updated', favorite);
    return favorite;
  }

  /**
   * Vérifier si un chemin est dans les favoris
   * @param {string} path - Chemin à vérifier
   */
  isFavorite(path) {
    return this.favorites.some(f => f.path === path);
  }

  /**
   * Obtenir un favori par son chemin
   * @param {string} path - Chemin du projet
   */
  get(path) {
    return this.favorites.find(f => f.path === path);
  }

  /**
   * Réorganiser les favoris (changer l'ordre)
   * @param {string[]} orderedPaths - Tableau des chemins dans le nouvel ordre
   */
  reorder(orderedPaths) {
    const newOrder = [];

    // Réorganiser selon l'ordre fourni
    for (const path of orderedPaths) {
      const favorite = this.favorites.find(f => f.path === path);
      if (favorite) {
        newOrder.push(favorite);
      }
    }

    // Ajouter les favoris manquants à la fin
    for (const favorite of this.favorites) {
      if (!newOrder.includes(favorite)) {
        newOrder.push(favorite);
      }
    }

    this.favorites = newOrder;
    this.save();
    this.emit('favorites-reordered', { count: this.favorites.length });
    return this.favorites;
  }

  /**
   * Vider tous les favoris
   */
  clear() {
    this.favorites = [];
    this.save();
    this.emit('favorites-cleared');
  }

  /**
   * Obtenir les statistiques
   */
  getStats() {
    return {
      count: this.favorites.length,
      paths: this.favorites.map(f => f.path),
      withNicknames: this.favorites.filter(f => f.nickname).length
    };
  }
}

module.exports = FavoritesManager;

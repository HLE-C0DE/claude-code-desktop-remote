# Orchestrator Module

Système d'orchestration pour gérer les "Big Tasks" - tâches complexes exécutées par plusieurs agents Claude en parallèle.

## 📁 Structure

```
backend/orchestrator/
├── index.js                    # Point d'entrée principal
├── TemplateManager.js          # Gestion des templates
├── ResponseParser.js           # Parsing des réponses Claude
├── OrchestratorManager.js      # Gestion du cycle de vie des orchestrateurs
├── WorkerManager.js            # Gestion des sessions workers
├── templates/
│   ├── schema.json            # Schéma JSON pour validation
│   ├── _default.json          # Template de base
│   ├── documentation.json     # Template pour documentation
│   └── custom/                # Templates personnalisés
├── test-orchestrator.js       # Tests unitaires
├── test-integration.js        # Tests d'intégration
└── README.md                  # Cette documentation
```

## 🚀 Quick Start

### Installation

Les dépendances sont déjà incluses dans `package.json` :
- `ajv` - Validation JSON Schema
- `uuid` - Génération d'IDs uniques

```bash
npm install
```

### Tests

```bash
# Tous les tests
npm test

# Tests unitaires seulement
npm run test:orchestrator

# Tests d'intégration seulement
npm run test:integration
```

### Utilisation

```javascript
const OrchestratorModule = require('./orchestrator');

// Initialiser le module
const orchestrator = new OrchestratorModule(cdpController, {
  templatesDir: './templates',
  worker: {
    maxWorkers: 5,
    pollInterval: 2000
  }
});

await orchestrator.initialize();

// Créer un orchestrateur
const orch = await orchestrator.orchestrators.create({
  templateId: 'documentation',
  cwd: '/path/to/project',
  message: 'Generate documentation for all modules'
});

// Démarrer l'analyse
await orchestrator.orchestrators.start(orch.id);
```

## 🏗️ Architecture

### Flow Principal

```
1. Analysis Phase
   └─> Orchestrator analyse le projet avec Task(Explore)
   └─> Génère une recommandation de découpage

2. Task Planning Phase
   └─> Orchestrator crée une liste de tâches
   └─> Chaque tâche a un scope, priorité, dépendances

3. Worker Execution Phase
   └─> Spawn N workers en parallèle (max: maxWorkers)
   └─> Chaque worker exécute sa tâche assignée
   └─> Monitoring du progrès en temps réel

4. Aggregation Phase (optionnel)
   └─> Orchestrator combine les résultats
   └─> Résolution de conflits si nécessaire

5. Verification Phase (optionnel)
   └─> Vérification finale de la qualité
```

### Modules

#### **TemplateManager**
Gestion des templates d'orchestration :
- Chargement et validation (JSON Schema)
- Héritage de templates (système d'extends)
- Substitution de variables
- CRUD pour templates personnalisés

#### **ResponseParser**
Parse les réponses structurées de Claude :
- Extraction avec délimiteurs `<<<ORCHESTRATOR_RESPONSE>>>`
- Validation par phase
- Fallback avec détection heuristique
- Récupération d'erreurs JSON

#### **OrchestratorManager**
Gestion du cycle de vie :
- Création, démarrage, pause, reprise, annulation
- Transitions de phases
- Génération de prompts
- Gestion d'état

#### **WorkerManager**
Gestion des workers :
- Spawn de sessions via CDP
- Queue de tâches (respect maxWorkers)
- Monitoring avec polling
- Agrégation de statistiques
- Timeouts et retries

## 📋 Templates

### Structure d'un Template

```json
{
  "id": "my-template",
  "name": "Mon Template",
  "description": "Description du template",
  "extends": "_default",

  "config": {
    "maxWorkers": 5,
    "autoSpawn": false
  },

  "prompts": {
    "analysis": {
      "system": "Instructions pour l'analyse...",
      "user": "Analyser: {USER_REQUEST}"
    },
    "worker": {
      "system": "Instructions pour le worker...",
      "user": "Exécuter tâche {TASK_ID}"
    }
  }
}
```

### Variables Disponibles

- `{USER_REQUEST}` - Message de l'utilisateur
- `{CWD}` - Working directory
- `{PROJECT_NAME}` - Nom du projet
- `{TASK_ID}` - ID de la tâche (workers)
- `{TASK_TITLE}` - Titre de la tâche (workers)
- `{TASK_DESCRIPTION}` - Description (workers)
- `{TASK_SCOPE}` - Fichiers concernés (workers)

## 🔌 API Endpoints

Voir `docs/orchestrator/05-API-ENDPOINTS.md` pour la documentation complète.

### Templates
- `GET /api/orchestrator/templates` - Liste des templates
- `GET /api/orchestrator/templates/:id` - Détails d'un template
- `POST /api/orchestrator/templates` - Créer un template
- `PUT /api/orchestrator/templates/:id` - Modifier un template
- `DELETE /api/orchestrator/templates/:id` - Supprimer un template

### Orchestrateurs
- `POST /api/orchestrator/create` - Créer un orchestrateur
- `GET /api/orchestrator/:id` - État d'un orchestrateur
- `POST /api/orchestrator/:id/start` - Démarrer
- `POST /api/orchestrator/:id/pause` - Mettre en pause
- `POST /api/orchestrator/:id/resume` - Reprendre
- `POST /api/orchestrator/:id/cancel` - Annuler

### Workers
- `GET /api/orchestrator/:id/workers` - Liste des workers
- `POST /api/orchestrator/:id/workers/:taskId/retry` - Réessayer
- `POST /api/orchestrator/:id/workers/:taskId/cancel` - Annuler

## 🎯 Format de Réponse

Claude doit utiliser ce format exact pour communiquer avec l'orchestrateur :

```
<<<ORCHESTRATOR_RESPONSE>>>
{
  "phase": "analysis|task_list|progress|completion|aggregation",
  "data": {
    // Données spécifiques à la phase
  }
}
<<<END_ORCHESTRATOR_RESPONSE>>>
```

### Phases

**Analysis**
```json
{
  "phase": "analysis",
  "data": {
    "summary": "Description de l'analyse",
    "recommended_splits": 5,
    "key_files": ["file1.js", "file2.js"],
    "estimated_complexity": "low|medium|high"
  }
}
```

**Task List**
```json
{
  "phase": "task_list",
  "data": {
    "tasks": [
      {
        "id": "task_001",
        "title": "Titre de la tâche",
        "description": "Description détaillée",
        "scope": ["fichiers", "concernés"],
        "priority": 1,
        "dependencies": []
      }
    ]
  }
}
```

**Progress** (depuis un worker)
```json
{
  "phase": "progress",
  "data": {
    "task_id": "task_001",
    "status": "in_progress",
    "progress_percent": 50,
    "current_action": "En train de..."
  }
}
```

**Completion** (depuis un worker)
```json
{
  "phase": "completion",
  "data": {
    "task_id": "task_001",
    "status": "success|failed|partial",
    "summary": "Résumé de ce qui a été fait",
    "output_files": ["fichiers", "modifiés"],
    "error": "Message d'erreur si failed"
  }
}
```

## 🔧 Configuration

### Worker Manager

```javascript
{
  maxWorkers: 5,              // Nombre max de workers en parallèle
  pollInterval: 2000,         // Intervalle de polling (ms)
  workerTimeout: 300000,      // Timeout par worker (ms)
  retryLimit: 2,              // Nombre de retries en cas d'erreur
  spawnDelay: 500             // Délai entre spawns (rate limiting)
}
```

### Template Config

```json
{
  "config": {
    "maxWorkers": 5,
    "workerTimeout": 300000,
    "autoSpawn": false,
    "parallelExecution": true,
    "retryOnError": true,
    "maxRetries": 2,
    "pollInterval": 2000
  }
}
```

## 📊 Events

Le module émet des événements via EventEmitter :

### Orchestrator Events
- `orchestrator:created`
- `orchestrator:started`
- `orchestrator:phaseChanged`
- `orchestrator:analysisComplete`
- `orchestrator:tasksReady`
- `orchestrator:progress`
- `orchestrator:completed`
- `orchestrator:error`
- `orchestrator:cancelled`

### Worker Events
- `worker:spawned`
- `worker:started`
- `worker:progress`
- `worker:completed`
- `worker:failed`
- `worker:timeout`
- `worker:cancelled`

### Template Events
- `template:loaded`
- `template:created`
- `template:updated`
- `template:deleted`

## 🐛 Debugging

### Logs

Les logs sont émis sur console avec préfixes :
- `[OrchestratorModule]`
- `[TemplateManager]`
- `[OrchestratorManager]`
- `[WorkerManager]`

### Common Issues

**Worker timeout**
- Augmenter `workerTimeout` dans la config
- Réduire la portée des tâches

**Too many workers spawned**
- Vérifier `maxWorkers` dans config
- Regarder la queue de tâches

**Template validation errors**
- Vérifier schema.json
- Valider JSON avec un outil externe
- Utiliser `validateTemplate()` en debug

**Claude ne suit pas le format**
- Vérifier que les prompts incluent les exemples
- Utiliser fallback detection
- Améliorer les instructions dans le prompt

## 📚 Documentation Complète

Voir le dossier `docs/orchestrator/` pour :
- Architecture détaillée
- Spécifications des templates
- Protocole de communication
- Détails des modules backend
- Spécifications UI

## ✅ Tests

### Test Coverage

- ✅ Module loading
- ✅ ResponseParser (parsing, validation, fallback)
- ✅ TemplateManager (CRUD, inheritance, validation)
- ✅ Integration (module init, events, prompt generation)
- ✅ Error handling

### Running Tests

```bash
# All tests
npm test

# Unit tests only
npm run test:orchestrator

# Integration tests only
npm run test:integration
```

## 🤝 Contributing

Pour ajouter un nouveau template :

1. Créer un fichier JSON dans `templates/` ou `templates/custom/`
2. Utiliser `extends: "_default"` pour hériter
3. Valider avec `validateTemplate()`
4. Tester avec les scripts de test

## 📝 License

MIT

/**
 * TemplateManager - Manages orchestrator templates
 *
 * Handles loading, validation, inheritance resolution, and CRUD operations
 * for orchestrator templates. System templates are read-only while custom
 * templates support full CRUD operations.
 */

const fs = require('fs').promises;
const path = require('path');
const EventEmitter = require('events');
const Ajv = require('ajv');

class TemplateManager extends EventEmitter {
  constructor(templatesDir) {
    super();
    this.templatesDir = templatesDir;
    this.customDir = path.join(templatesDir, 'custom');
    this.schema = null;
    this.schemaValidator = null;
    this.templates = new Map(); // id -> template (raw, unresolved)
    this.resolvedCache = new Map(); // id -> resolved template
    this.ajv = new Ajv({ allErrors: true, strict: false });
    this.initialized = false;
  }

  // ==================== Initialization ====================

  /**
   * Initialize the template manager
   * Loads schema and all templates from filesystem
   */
  async initialize() {
    if (this.initialized) {
      return;
    }

    try {
      // Ensure custom directory exists
      await this._ensureCustomDir();

      // Load and compile schema
      await this.loadSchema();

      // Load all templates
      await this.loadAllTemplates();

      this.initialized = true;
      this.emit('initialized', { templateCount: this.templates.size });
    } catch (error) {
      this.emit('template:error', {
        operation: 'initialize',
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Load and compile the JSON schema for template validation
   */
  async loadSchema() {
    const schemaPath = path.join(this.templatesDir, 'schema.json');

    try {
      const schemaContent = await fs.readFile(schemaPath, 'utf-8');
      this.schema = JSON.parse(schemaContent);
      this.schemaValidator = this.ajv.compile(this.schema);
      return this.schemaValidator;
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Schema file doesn't exist - use permissive validation
        console.warn('Template schema not found, using permissive validation');
        this.schema = this._getDefaultSchema();
        this.schemaValidator = this.ajv.compile(this.schema);
        return this.schemaValidator;
      }
      throw new Error(`Failed to load template schema: ${error.message}`);
    }
  }

  /**
   * Load all templates from system and custom directories
   */
  async loadAllTemplates() {
    this.templates.clear();
    this.resolvedCache.clear();

    // Load system templates (root of templates dir)
    const systemTemplates = await this._loadTemplatesFromDir(this.templatesDir, true);

    // Load custom templates
    const customTemplates = await this._loadTemplatesFromDir(this.customDir, false);

    // Merge into templates map
    for (const [id, template] of systemTemplates) {
      this.templates.set(id, template);
    }
    for (const [id, template] of customTemplates) {
      this.templates.set(id, template);
    }

    return this.templates;
  }

  // ==================== Template CRUD ====================

  /**
   * Get a template by ID with inheritance fully resolved
   */
  async getTemplate(id) {
    // Check resolved cache first
    if (this.resolvedCache.has(id)) {
      return this.resolvedCache.get(id);
    }

    const template = this.templates.get(id);
    if (!template) {
      throw new Error(`Template '${id}' not found`);
    }

    // Resolve inheritance
    const resolved = this.resolveInheritance(template);

    // Cache the resolved template
    this.resolvedCache.set(id, resolved);

    return resolved;
  }

  /**
   * Get all templates (metadata only for listing)
   */
  async getAllTemplates() {
    const templatesList = [];

    for (const [id, template] of this.templates) {
      // Skip internal templates that start with underscore (like _default)
      // unless they have explicit metadata
      const isInternal = id.startsWith('_');

      templatesList.push({
        id: template.id || id,
        name: template.name || id,
        description: template.description || '',
        icon: template.icon || null,
        author: template.author || 'unknown',
        version: template.version || '1.0.0',
        tags: template.tags || [],
        isSystem: this.isSystemTemplate(id),
        isInternal,
        extends: template.extends || null
      });
    }

    return templatesList;
  }

  /**
   * Create a new custom template
   */
  async createTemplate(templateData) {
    // Generate ID if not provided
    if (!templateData.id) {
      templateData.id = this.generateTemplateId(templateData.name || 'custom-template');
    }

    // Ensure it's not overwriting a system template
    if (this.isSystemTemplate(templateData.id)) {
      throw new Error(`Cannot create template with system ID '${templateData.id}'`);
    }

    // Check for duplicate ID
    if (this.templates.has(templateData.id)) {
      throw new Error(`Template with ID '${templateData.id}' already exists`);
    }

    // Set defaults for custom template
    templateData.author = templateData.author || 'user';
    templateData.extends = templateData.extends || '_default';

    // Validate template
    const validation = this.validateTemplate(templateData);
    if (!validation.valid) {
      throw new Error(`Invalid template: ${validation.errors.join(', ')}`);
    }

    // Check inheritance chain
    this._validateInheritanceChain(templateData);

    // Save to filesystem
    const filePath = path.join(this.customDir, `${templateData.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(templateData, null, 2), 'utf-8');

    // Add to cache
    templateData._isSystem = false;
    templateData._filePath = filePath;
    this.templates.set(templateData.id, templateData);

    // Clear resolved cache to force re-resolution
    this.resolvedCache.delete(templateData.id);

    this.emit('template:created', {
      id: templateData.id,
      name: templateData.name
    });

    return templateData;
  }

  /**
   * Update an existing custom template
   */
  async updateTemplate(id, templateData) {
    // Check if template exists
    const existing = this.templates.get(id);
    if (!existing) {
      throw new Error(`Template '${id}' not found`);
    }

    // Cannot update system templates
    if (this.isSystemTemplate(id)) {
      throw new Error(`Cannot update system template '${id}'`);
    }

    // Merge with existing data
    const updated = {
      ...existing,
      ...templateData,
      id // Preserve original ID
    };

    // Validate template
    const validation = this.validateTemplate(updated);
    if (!validation.valid) {
      throw new Error(`Invalid template: ${validation.errors.join(', ')}`);
    }

    // Check inheritance chain
    this._validateInheritanceChain(updated);

    // Save to filesystem
    const filePath = existing._filePath || path.join(this.customDir, `${id}.json`);
    await fs.writeFile(filePath, JSON.stringify(updated, null, 2), 'utf-8');

    // Update cache
    updated._isSystem = false;
    updated._filePath = filePath;
    this.templates.set(id, updated);

    // Clear resolved cache
    this.resolvedCache.delete(id);
    // Also clear cache for any templates that extend this one
    this._clearDependentCache(id);

    this.emit('template:updated', { id, name: updated.name });

    return updated;
  }

  /**
   * Delete a custom template
   */
  async deleteTemplate(id) {
    const template = this.templates.get(id);
    if (!template) {
      throw new Error(`Template '${id}' not found`);
    }

    // Cannot delete system templates
    if (this.isSystemTemplate(id)) {
      throw new Error(`Cannot delete system template '${id}'`);
    }

    // Check if any templates depend on this one
    const dependents = this._findDependentTemplates(id);
    if (dependents.length > 0) {
      throw new Error(`Cannot delete template '${id}': used by ${dependents.join(', ')}`);
    }

    // Delete from filesystem
    const filePath = template._filePath || path.join(this.customDir, `${id}.json`);
    await fs.unlink(filePath);

    // Remove from cache
    this.templates.delete(id);
    this.resolvedCache.delete(id);

    this.emit('template:deleted', { id });
  }

  /**
   * Duplicate a template to the custom folder
   */
  async duplicateTemplate(id, newName) {
    const source = await this.getTemplate(id);

    // Generate new ID
    const newId = this.generateTemplateId(newName);

    // Create copy with new identity
    const duplicate = {
      ...this._deepClone(source),
      id: newId,
      name: newName,
      author: 'user',
      extends: id, // Extend from original instead of copying everything
      // Remove internal fields
      _isSystem: undefined,
      _filePath: undefined
    };

    // Remove undefined fields
    delete duplicate._isSystem;
    delete duplicate._filePath;

    return this.createTemplate(duplicate);
  }

  // ==================== Template Processing ====================

  /**
   * Resolve template inheritance chain
   * Returns fully merged template with all inherited values
   */
  resolveInheritance(template, visited = new Set()) {
    // Check for circular inheritance
    if (visited.has(template.id)) {
      throw new Error(`Circular inheritance detected: ${Array.from(visited).join(' -> ')} -> ${template.id}`);
    }

    // Base case: no inheritance
    if (!template.extends) {
      return this._deepClone(template);
    }

    visited.add(template.id);

    const parentId = template.extends;
    const parent = this.templates.get(parentId);

    if (!parent) {
      throw new Error(`Parent template '${parentId}' not found for '${template.id}'`);
    }

    // Recursively resolve parent
    const resolvedParent = this.resolveInheritance(parent, visited);

    // Deep merge: parent + child (child wins)
    const merged = this._deepMerge(resolvedParent, template);

    // Preserve child's identity
    merged.id = template.id;
    merged.name = template.name;
    if (template.description) merged.description = template.description;

    return merged;
  }

  /**
   * Validate a template against the JSON schema
   */
  validateTemplate(template) {
    const errors = [];
    const warnings = [];

    // Required fields check
    if (!template.id) {
      errors.push('Missing required field: id');
    }
    if (!template.name) {
      errors.push('Missing required field: name');
    }

    // Templates that use extends have relaxed requirements
    const usesInheritance = !!template.extends;

    // Schema validation if available
    if (this.schemaValidator) {
      const valid = this.schemaValidator(template);
      if (!valid && this.schemaValidator.errors) {
        for (const err of this.schemaValidator.errors) {
          // Skip 'prompts' requirement errors for templates that extend another
          // They'll inherit prompts from parent
          if (usesInheritance && err.keyword === 'required' && err.params?.missingProperty === 'prompts') {
            continue;
          }
          // Also skip nested prompts requirements for inherited templates
          if (usesInheritance && err.instancePath === '/prompts' && err.keyword === 'required') {
            continue;
          }
          errors.push(`${err.instancePath || 'root'}: ${err.message}`);
        }
      }
    }

    // Check extends reference
    if (template.extends) {
      if (!this.templates.has(template.extends) && template.extends !== '_default') {
        // Allow _default even if not loaded yet (during initialization)
        if (this.initialized) {
          errors.push(`Extends non-existent template: ${template.extends}`);
        }
      }
    }

    // For base templates (no extends), prompts are required
    if (!usesInheritance && !template.prompts) {
      errors.push('Base templates must have prompts defined');
    }

    // Validate prompts have required delimiters reference
    if (template.prompts) {
      if (!template.prompts.responseFormat && !template.extends) {
        warnings.push('No responseFormat defined in prompts');
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Substitute variables in prompt text
   * Replaces {VAR_NAME} patterns with corresponding values
   */
  substituteVariables(text, variables = {}) {
    if (!text || typeof text !== 'string') {
      return text;
    }

    return text.replace(/\{([A-Z_][A-Z0-9_]*)\}/g, (match, varName) => {
      if (Object.prototype.hasOwnProperty.call(variables, varName)) {
        const value = variables[varName];

        // Handle different types
        if (value === null || value === undefined) {
          return '';
        }
        if (typeof value === 'boolean') {
          return value ? 'yes' : 'no';
        }
        if (Array.isArray(value)) {
          return value.join(', ');
        }
        if (typeof value === 'object') {
          return JSON.stringify(value);
        }
        return String(value);
      }

      // Keep original placeholder if variable not found
      return match;
    });
  }

  // ==================== Helpers ====================

  /**
   * Check if a template is a system (read-only) template
   */
  isSystemTemplate(id) {
    const template = this.templates.get(id);

    // If template doesn't exist, it's not a system template
    if (!template) {
      return false;
    }

    if (template._isSystem !== undefined) {
      return template._isSystem;
    }

    // Check if file exists in system directory (not custom)
    if (template._filePath) {
      return !template._filePath.includes(path.sep + 'custom' + path.sep);
    }

    // Default: treat as system if loaded from templates root
    return true;
  }

  /**
   * Generate a URL-safe template ID from a name
   */
  generateTemplateId(name) {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 50);

    // Ensure uniqueness
    let id = base;
    let counter = 1;
    while (this.templates.has(id)) {
      id = `${base}-${counter}`;
      counter++;
    }

    return id;
  }

  // ==================== Private Methods ====================

  /**
   * Ensure the custom templates directory exists
   */
  async _ensureCustomDir() {
    try {
      await fs.access(this.customDir);
    } catch {
      await fs.mkdir(this.customDir, { recursive: true });
    }
  }

  /**
   * Load templates from a directory
   */
  async _loadTemplatesFromDir(dir, isSystem) {
    const templates = new Map();

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        // Skip directories and non-JSON files
        if (entry.isDirectory() || !entry.name.endsWith('.json')) {
          continue;
        }

        // Skip schema.json
        if (entry.name === 'schema.json') {
          continue;
        }

        const filePath = path.join(dir, entry.name);

        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const template = JSON.parse(content);

          // Ensure ID matches filename (without .json)
          const fileId = entry.name.replace('.json', '');
          template.id = template.id || fileId;

          // Mark as system or custom
          template._isSystem = isSystem;
          template._filePath = filePath;

          templates.set(template.id, template);

          this.emit('template:loaded', {
            id: template.id,
            isSystem
          });
        } catch (parseError) {
          console.error(`Failed to parse template ${entry.name}:`, parseError.message);
          this.emit('template:error', {
            file: entry.name,
            error: parseError.message
          });
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      // Directory doesn't exist - that's ok, just return empty map
    }

    return templates;
  }

  /**
   * Validate that inheritance chain has no cycles
   */
  _validateInheritanceChain(template, visited = new Set()) {
    if (!template.extends) {
      return;
    }

    // Check for self-reference
    if (template.id && template.extends === template.id) {
      throw new Error(`Template '${template.id}' cannot extend itself`);
    }

    if (visited.has(template.extends)) {
      throw new Error(`Circular inheritance detected: ${Array.from(visited).join(' -> ')} -> ${template.extends}`);
    }

    visited.add(template.id);

    const parent = this.templates.get(template.extends);
    if (parent) {
      this._validateInheritanceChain(parent, visited);
    }
  }

  /**
   * Find templates that depend on (extend) the given template
   */
  _findDependentTemplates(id) {
    const dependents = [];

    for (const [templateId, template] of this.templates) {
      if (template.extends === id) {
        dependents.push(templateId);
      }
    }

    return dependents;
  }

  /**
   * Clear resolved cache for templates that depend on the given template
   */
  _clearDependentCache(id) {
    const dependents = this._findDependentTemplates(id);

    for (const depId of dependents) {
      this.resolvedCache.delete(depId);
      // Recursively clear dependents of dependents
      this._clearDependentCache(depId);
    }
  }

  /**
   * Deep merge two objects
   * - Objects: recursively merged
   * - Arrays: child replaces parent entirely
   * - Primitives: child wins
   */
  _deepMerge(parent, child) {
    // Handle null/undefined
    if (child === null || child === undefined) {
      return parent;
    }
    if (parent === null || parent === undefined) {
      return this._deepClone(child);
    }

    // Arrays: replace entirely
    if (Array.isArray(child)) {
      return this._deepClone(child);
    }

    // Non-objects: child wins
    if (typeof parent !== 'object' || typeof child !== 'object') {
      return child;
    }

    // Objects: merge recursively
    const result = { ...parent };

    for (const key of Object.keys(child)) {
      // Skip internal properties
      if (key.startsWith('_')) {
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(parent, key)) {
        result[key] = this._deepMerge(parent[key], child[key]);
      } else {
        result[key] = this._deepClone(child[key]);
      }
    }

    return result;
  }

  /**
   * Deep clone an object
   */
  _deepClone(obj) {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this._deepClone(item));
    }

    const clone = {};
    for (const key of Object.keys(obj)) {
      clone[key] = this._deepClone(obj[key]);
    }
    return clone;
  }

  /**
   * Get a default permissive schema when schema.json doesn't exist
   */
  _getDefaultSchema() {
    return {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['id', 'name'],
      properties: {
        id: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
        description: { type: 'string' },
        icon: { type: 'string' },
        version: { type: 'string' },
        author: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        extends: { type: 'string' },
        config: { type: 'object' },
        phases: { type: 'object' },
        prompts: { type: 'object' },
        variables: { type: 'object' },
        hooks: { type: 'object' },
        ui: { type: 'object' }
      },
      additionalProperties: true
    };
  }
}

module.exports = TemplateManager;

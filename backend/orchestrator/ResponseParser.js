/**
 * ResponseParser.js
 *
 * Parse and validate orchestrator responses from Claude.
 * Extracts structured JSON data from delimited response blocks.
 */

'use strict';

/**
 * Phase validation schemas defining required and optional fields
 */
const PHASE_SCHEMAS = {
  analysis: {
    required: ['summary', 'recommended_splits'],
    optional: ['key_files', 'estimated_complexity', 'notes', 'warnings', 'components']
  },

  task_list: {
    required: ['tasks'],
    optional: ['total_tasks', 'parallelizable_groups', 'execution_order'],
    taskSchema: {
      required: ['id', 'title', 'description'],
      optional: ['scope', 'priority', 'dependencies', 'estimated_tokens']
    }
  },

  progress: {
    required: ['task_id', 'status'],
    optional: ['progress_percent', 'current_action', 'files_processed', 'files_total', 'output_preview']
  },

  completion: {
    required: ['task_id', 'status'],
    optional: ['summary', 'output_files', 'output', 'error', 'warnings', 'metrics']
  },

  aggregation: {
    required: ['status'],
    optional: ['summary', 'conflicts', 'merged_output', 'output_files']
  }
};

/**
 * Fallback patterns for keyword-based phase detection
 */
const FALLBACK_PATTERNS = {
  analysis: [
    /analysis\s+(?:is\s+)?(?:complete|done|finished)/i,
    /(?:found|identified)\s+\d+\s+(?:components?|modules?|files?)/i,
    /recommend(?:ing|s?)\s+\d+\s+(?:tasks?|splits?)/i
  ],
  task_list: [
    /(?:task|breakdown)\s+list\s+(?:is\s+)?(?:ready|complete|created)/i,
    /created?\s+\d+\s+tasks?/i,
    /here\s+(?:are|is)\s+the\s+task/i
  ],
  progress: [
    /working\s+on/i,
    /currently\s+(?:processing|documenting|analyzing)/i,
    /progress:\s*\d+%/i
  ],
  completion: [
    /task\s+(?:is\s+)?(?:complete|done|finished)/i,
    /successfully\s+(?:completed|created|documented)/i
  ],
  error: [
    /(?:error|failed|could\s*n[o']t)/i,
    /unable\s+to/i
  ]
};

/**
 * ResponseParser class for parsing orchestrator responses
 */
class ResponseParser {
  /**
   * Create a new ResponseParser
   * @param {Object} options - Configuration options
   * @param {string} options.delimiterStart - Start delimiter for response blocks
   * @param {string} options.delimiterEnd - End delimiter for response blocks
   */
  constructor(options = {}) {
    this.delimiterStart = options.delimiterStart || '<<<ORCHESTRATOR_RESPONSE>>>';
    this.delimiterEnd = options.delimiterEnd || '<<<END_ORCHESTRATOR_RESPONSE>>>';
  }

  /**
   * Parse a single orchestrator response from text
   * @param {string} text - The text to parse
   * @returns {ParseResult} The parse result
   */
  parse(text) {
    if (!text || typeof text !== 'string') {
      return {
        found: false,
        error: 'Invalid input: text must be a non-empty string',
        raw: text
      };
    }

    const startIndex = text.indexOf(this.delimiterStart);
    if (startIndex === -1) {
      return {
        found: false,
        raw: text
      };
    }

    const endIndex = text.indexOf(this.delimiterEnd, startIndex);
    if (endIndex === -1) {
      return {
        found: false,
        error: 'Missing end delimiter',
        raw: text
      };
    }

    const jsonStart = startIndex + this.delimiterStart.length;
    const jsonContent = text.substring(jsonStart, endIndex).trim();
    const beforeText = text.substring(0, startIndex).trim();
    const afterText = text.substring(endIndex + this.delimiterEnd.length).trim();

    // Attempt to parse JSON
    const extracted = this.extractJSON(jsonContent);
    if (extracted === null) {
      return {
        found: true,
        error: 'Failed to parse JSON content',
        beforeText,
        afterText,
        raw: jsonContent
      };
    }

    // Validate basic structure
    if (!extracted.phase) {
      return {
        found: true,
        error: 'Missing required field: phase',
        beforeText,
        afterText,
        raw: jsonContent
      };
    }

    if (!extracted.data || typeof extracted.data !== 'object') {
      return {
        found: true,
        error: 'Missing or invalid required field: data',
        beforeText,
        afterText,
        raw: jsonContent
      };
    }

    return {
      found: true,
      phase: extracted.phase,
      data: extracted.data,
      beforeText,
      afterText,
      raw: jsonContent
    };
  }

  /**
   * Parse multiple orchestrator responses from text
   * @param {string} text - The text to parse
   * @returns {Array<ParseResult>} Array of parse results
   */
  parseMultiple(text) {
    if (!text || typeof text !== 'string') {
      return [];
    }

    const results = [];
    let remainingText = text;
    let searchStart = 0;

    while (true) {
      const startIndex = remainingText.indexOf(this.delimiterStart, searchStart);
      if (startIndex === -1) {
        break;
      }

      const endIndex = remainingText.indexOf(this.delimiterEnd, startIndex);
      if (endIndex === -1) {
        // Found start but no end - add error result and stop
        results.push({
          found: false,
          error: 'Missing end delimiter',
          raw: remainingText.substring(startIndex)
        });
        break;
      }

      // Extract this block
      const blockText = remainingText.substring(startIndex, endIndex + this.delimiterEnd.length);
      const beforeText = remainingText.substring(searchStart, startIndex).trim();

      // Parse the block
      const jsonStart = this.delimiterStart.length;
      const jsonEnd = blockText.length - this.delimiterEnd.length;
      const jsonContent = blockText.substring(jsonStart, jsonEnd).trim();

      const extracted = this.extractJSON(jsonContent);

      if (extracted === null) {
        results.push({
          found: true,
          error: 'Failed to parse JSON content',
          beforeText: beforeText || undefined,
          raw: jsonContent
        });
      } else if (!extracted.phase) {
        results.push({
          found: true,
          error: 'Missing required field: phase',
          beforeText: beforeText || undefined,
          raw: jsonContent
        });
      } else if (!extracted.data || typeof extracted.data !== 'object') {
        results.push({
          found: true,
          error: 'Missing or invalid required field: data',
          beforeText: beforeText || undefined,
          raw: jsonContent
        });
      } else {
        results.push({
          found: true,
          phase: extracted.phase,
          data: extracted.data,
          beforeText: beforeText || undefined,
          raw: jsonContent
        });
      }

      // Move past this block
      searchStart = endIndex + this.delimiterEnd.length;
    }

    // Add afterText to the last result if there's remaining content
    if (results.length > 0 && searchStart < remainingText.length) {
      const afterText = remainingText.substring(searchStart).trim();
      if (afterText) {
        results[results.length - 1].afterText = afterText;
      }
    }

    return results;
  }

  /**
   * Validate data against phase schema
   * @param {string} phase - The phase name
   * @param {Object} data - The data to validate
   * @returns {Object} Validation result with valid, errors, and warnings
   */
  validatePhase(phase, data) {
    const result = {
      valid: true,
      errors: [],
      warnings: []
    };

    const schema = PHASE_SCHEMAS[phase];
    if (!schema) {
      result.warnings.push(`Unknown phase: ${phase}`);
      return result;
    }

    // Check required fields
    for (const field of schema.required) {
      if (data[field] === undefined || data[field] === null) {
        result.valid = false;
        result.errors.push(`Missing required field: ${field}`);
      }
    }

    // Check for unexpected fields
    const allKnownFields = [...schema.required, ...(schema.optional || [])];
    for (const field of Object.keys(data)) {
      if (!allKnownFields.includes(field)) {
        result.warnings.push(`Unexpected field: ${field}`);
      }
    }

    // Special validation for task_list phase - validate each task
    if (phase === 'task_list' && Array.isArray(data.tasks)) {
      const taskSchema = schema.taskSchema;
      data.tasks.forEach((task, index) => {
        if (typeof task !== 'object' || task === null) {
          result.valid = false;
          result.errors.push(`Task at index ${index} is not an object`);
          return;
        }

        for (const field of taskSchema.required) {
          if (task[field] === undefined || task[field] === null) {
            result.valid = false;
            result.errors.push(`Task at index ${index} missing required field: ${field}`);
          }
        }

        // Check for unexpected task fields
        const allTaskFields = [...taskSchema.required, ...(taskSchema.optional || [])];
        for (const field of Object.keys(task)) {
          if (!allTaskFields.includes(field)) {
            result.warnings.push(`Task at index ${index} has unexpected field: ${field}`);
          }
        }
      });
    }

    // Validate specific field types
    this._validateFieldTypes(phase, data, result);

    return result;
  }

  /**
   * Validate field types for specific phases
   * @private
   */
  _validateFieldTypes(phase, data, result) {
    switch (phase) {
      case 'analysis':
        if (data.recommended_splits !== undefined && typeof data.recommended_splits !== 'number') {
          result.warnings.push('recommended_splits should be a number');
        }
        if (data.key_files !== undefined && !Array.isArray(data.key_files)) {
          result.warnings.push('key_files should be an array');
        }
        break;

      case 'task_list':
        if (data.tasks !== undefined && !Array.isArray(data.tasks)) {
          result.valid = false;
          result.errors.push('tasks must be an array');
        }
        if (data.total_tasks !== undefined && typeof data.total_tasks !== 'number') {
          result.warnings.push('total_tasks should be a number');
        }
        break;

      case 'progress':
        if (data.progress_percent !== undefined) {
          if (typeof data.progress_percent !== 'number') {
            result.warnings.push('progress_percent should be a number');
          } else if (data.progress_percent < 0 || data.progress_percent > 100) {
            result.warnings.push('progress_percent should be between 0 and 100');
          }
        }
        break;

      case 'completion':
        const validStatuses = ['success', 'partial', 'failed', 'timeout'];
        if (data.status && !validStatuses.includes(data.status)) {
          result.warnings.push(`Unknown completion status: ${data.status}`);
        }
        if (data.output_files !== undefined && !Array.isArray(data.output_files)) {
          result.warnings.push('output_files should be an array');
        }
        break;

      case 'aggregation':
        if (data.conflicts !== undefined && !Array.isArray(data.conflicts)) {
          result.warnings.push('conflicts should be an array');
        }
        if (data.output_files !== undefined && !Array.isArray(data.output_files)) {
          result.warnings.push('output_files should be an array');
        }
        break;
    }
  }

  /**
   * Attempt to detect phase from keywords when structured format is not found
   * @param {string} text - The text to analyze
   * @returns {Object} Detection result with detected, probablePhase, and confidence
   */
  detectFallback(text) {
    if (!text || typeof text !== 'string') {
      return {
        detected: false,
        probablePhase: null,
        confidence: 0
      };
    }

    const matches = {};
    let bestPhase = null;
    let bestCount = 0;

    // Check each phase's patterns
    for (const [phase, patterns] of Object.entries(FALLBACK_PATTERNS)) {
      matches[phase] = 0;
      for (const pattern of patterns) {
        if (pattern.test(text)) {
          matches[phase]++;
        }
      }
      if (matches[phase] > bestCount) {
        bestCount = matches[phase];
        bestPhase = phase;
      }
    }

    if (bestCount === 0) {
      return {
        detected: false,
        probablePhase: null,
        confidence: 0
      };
    }

    // Calculate confidence based on number of pattern matches
    // More matches = higher confidence (max 0.9 since this is heuristic)
    const maxPatterns = FALLBACK_PATTERNS[bestPhase].length;
    const confidence = Math.min(0.9, (bestCount / maxPatterns) * 0.9 + 0.1);

    return {
      detected: true,
      probablePhase: bestPhase,
      confidence: Math.round(confidence * 100) / 100
    };
  }

  /**
   * Extract and parse JSON from text, attempting to fix common errors
   * @param {string} text - The text containing JSON
   * @returns {Object|null} Parsed object or null if parsing failed
   */
  extractJSON(text) {
    if (!text || typeof text !== 'string') {
      return null;
    }

    const trimmed = text.trim();

    // First, try parsing as-is
    try {
      return JSON.parse(trimmed);
    } catch (e) {
      // Continue to fix attempts
    }

    // Try fixing common JSON errors
    const fixed = this.fixCommonJSONErrors(trimmed);
    try {
      return JSON.parse(fixed);
    } catch (e) {
      // Continue to more aggressive fixes
    }

    // Try to extract JSON object from text (in case there's surrounding text)
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (e) {
        // Try fixing the extracted JSON
        const fixedExtracted = this.fixCommonJSONErrors(jsonMatch[0]);
        try {
          return JSON.parse(fixedExtracted);
        } catch (e2) {
          // Give up
        }
      }
    }

    return null;
  }

  /**
   * Attempt to fix common JSON syntax errors
   * @param {string} jsonString - The JSON string to fix
   * @returns {string} The fixed JSON string
   */
  fixCommonJSONErrors(jsonString) {
    if (!jsonString || typeof jsonString !== 'string') {
      return jsonString;
    }

    let fixed = jsonString;

    // Remove trailing commas before ] or }
    // This handles: [1, 2, 3,] or {"a": 1,}
    fixed = fixed.replace(/,(\s*[\]}])/g, '$1');

    // Fix unquoted keys (simple cases)
    // Match: { key: "value" } -> { "key": "value" }
    fixed = fixed.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');

    // Fix single quotes to double quotes (but not inside strings)
    // This is a simplified fix - might not work for all edge cases
    fixed = fixed.replace(/:\s*'([^']*)'/g, ': "$1"');

    // Fix missing quotes around string values that look like identifiers
    // Match: "key": value -> "key": "value" (for unquoted string values)
    // Be careful not to break numbers, booleans, null, arrays, or objects
    fixed = fixed.replace(
      /:\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*([,}\]])/g,
      (match, value, terminator) => {
        // Don't quote boolean or null
        if (value === 'true' || value === 'false' || value === 'null') {
          return match;
        }
        return `: "${value}"${terminator}`;
      }
    );

    // Remove JavaScript-style comments (// and /* */)
    // Line comments
    fixed = fixed.replace(/\/\/[^\n]*/g, '');
    // Block comments
    fixed = fixed.replace(/\/\*[\s\S]*?\*\//g, '');

    // Fix escaped newlines that might cause issues
    fixed = fixed.replace(/\\\n/g, '\\n');

    // Remove BOM if present
    fixed = fixed.replace(/^\uFEFF/, '');

    // Trim whitespace
    fixed = fixed.trim();

    return fixed;
  }
}

// Export the class
module.exports = ResponseParser;

// Also export schemas and patterns for testing
module.exports.PHASE_SCHEMAS = PHASE_SCHEMAS;
module.exports.FALLBACK_PATTERNS = FALLBACK_PATTERNS;

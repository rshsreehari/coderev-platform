const path = require('path');
const { ESLint } = require('eslint');
const { reviewCodeWithAI } = require('./aiReviewer');

// ==============================================
// CONFIGURATION - Extracted Magic Numbers
// ==============================================
const CONFIG = {
  MIN_FILE_LINES_FOR_AI: parseInt(process.env.MIN_FILE_LINES_FOR_AI || '5', 10),
  MAX_FILE_LINES_FOR_AI: parseInt(process.env.MAX_FILE_LINES_FOR_AI || '1000', 10),
  CONTEXT_LINES_FOR_LOOP_DETECTION: 10,
};

// ==============================================
// ERROR HANDLING - Structured Error Codes
// ==============================================
const ERROR_CODES = {
  ESLINT_FAILED: 'ESLINT_FAILED',
  PATTERN_DETECTION_FAILED: 'PATTERN_DETECTION_FAILED',
  AI_REVIEW_FAILED: 'AI_REVIEW_FAILED',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  FORCED_FAILURE: 'FORCED_FAILURE',
};

class AnalysisError extends Error {
  constructor(code, message, originalError = null) {
    super(message);
    this.name = 'AnalysisError';
    this.code = code;
    this.originalError = originalError;
    this.stack = originalError?.stack || this.stack;
  }
}

// ==============================================
// PRE-COMPILED REGEX (Performance Optimization)
// ==============================================
const PATTERNS = {
  // Security patterns - SQL Injection
  SQL_INJECTION: /(\+\s*['"`]?\s*(SELECT|INSERT|UPDATE|DELETE|DROP|WHERE|FROM|AND|OR)\s)|(\$\{[^}]*\}.*(?:SELECT|INSERT|UPDATE|DELETE|WHERE))|(['"`]\s*\+\s*\w+.*(?:SELECT|INSERT|UPDATE|DELETE|WHERE|FROM))/i,
  SQL_QUERY_CONCAT: /(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE).*['"`]\s*\+\s*\w+|['"`]\s*\+\s*\w+.*['"`].*(?:SELECT|INSERT|UPDATE|DELETE|WHERE|FROM)/i,
  
  // Command Injection - exec with dynamic input
  COMMAND_INJECTION: /exec\s*\([^)]*(\+|\$\{|\`)/,
  CHILD_PROCESS_EXEC: /require\s*\(\s*['"`]child_process['"`]\s*\).*exec\s*\(/,
  
  // XSS - User input in HTML response
  XSS_RESPONSE: /res\.(send|write)\s*\([^)]*\+\s*\w+|res\.(send|write)\s*\([^)]*\$\{/,
  
  // Hardcoded secrets
  HARDCODED_PASSWORD: /password\s*[:=]\s*['"`][^'"` ]{3,}['"`]/i,
  HARDCODED_SECRET: /(api[_-]?key|secret|token|auth)\s*[:=]\s*['"`][^'"` ]{8,}['"`]/i,
  
  // Weak crypto
  WEAK_HASH_MD5: /createHash\s*\(\s*['"`]md5['"`]\s*\)/i,
  WEAK_HASH_SHA1: /createHash\s*\(\s*['"`]sha1['"`]\s*\)/i,
  
  // Memory leak - unbounded growth
  MEMORY_LEAK_PUSH: /\w+\s*\.\s*push\s*\([^)]+\)/,
  GLOBAL_ARRAY: /^(const|let|var)\s+\w+\s*=\s*\[\s*\]/,
  
  // Open redirect
  OPEN_REDIRECT: /res\.redirect\s*\(\s*req\.(body|query|params)/,
  
  // Insecure session
  WEAK_SESSION_ID: /Math\.random\s*\(\s*\)/,
  
  // Performance patterns
  STRING_CONCAT_ASSIGNMENT: /\w+\s*\+=\s*['"`]/,
  STRING_CONCAT_BINARY: /\w+\s*=\s*\w+\s*\+\s*['"`]/,
  REGEX_CREATION: /(new\s+RegExp\(|^\s*\/.*\/[gimuy]*\.(test|exec)\()/,
  
  // Loop detection
  LOOP_KEYWORDS: /(for|while|forEach|map|filter|reduce)\s*\(/,
  LOOP_START: /^\s*(for|while)\s*\(/,
  BLOCK_END: /^\s*\}/,
};

// Helper function to provide fix suggestions
function getFixSuggestion(ruleId) {
  const suggestions = {
    'no-eval': 'Avoid eval(). Use JSON.parse() or Function constructor with validation instead.',
    'no-implied-eval': 'Avoid passing string to setTimeout/setInterval. Use arrow function instead.',
    'no-new-func': 'Avoid Function constructor. Use proper function declaration or arrow function.',
    'no-await-in-loop': 'Move await outside loop or use Promise.all() for parallel execution.',
    'no-console': 'Remove console.log() or use proper logging library for production code.',
    'no-debugger': 'Remove debugger statements before deploying.',
    'no-unused-vars': 'Remove unused variable or prefix with underscore (_variable) if intentional.',
    'eqeqeq': 'Use === for strict equality instead of == to prevent type coercion bugs.',
    'semi': 'Add semicolon at the end of statement for consistency.',
  };
  return suggestions[ruleId] || 'Follow best practices to fix this issue.';
}

// Pattern detectors for advanced issues with COMPREHENSIVE SECURITY CHECKS
function detectPatternIssues(fileContent, fileName) {
  const issues = { security: [], performance: [], style: [] };
  const lines = fileContent.split('\n');

  // Track global arrays for memory leak detection
  const globalArrays = new Set();

  // ✅ Track loop depth properly to avoid false positives
  let loopDepth = 0;
  let braceStack = []; // Track brace context

  lines.forEach((line, index) => {
    const lineNum = index + 1;
    const trimmed = line.trim();
    const lineLower = line.toLowerCase();

    // Track global arrays defined at module level
    if (PATTERNS.GLOBAL_ARRAY.test(trimmed) && braceStack.length === 0) {
      const match = trimmed.match(/^(?:const|let|var)\s+(\w+)/);
      if (match) globalArrays.add(match[1]);
    }

    // Track entering loops (increment depth when we see loop start)
    if (PATTERNS.LOOP_START.test(trimmed) || /\.(forEach|map|filter|reduce)\s*\(/.test(line)) {
      loopDepth++;
      const openBraces = (line.match(/\{/g) || []).length;
      const closeBraces = (line.match(/\}/g) || []).length;
      braceStack.push({ type: 'loop', braces: openBraces - closeBraces });
    } else {
      const openBraces = (line.match(/\{/g) || []).length;
      const closeBraces = (line.match(/\}/g) || []).length;
      const netBraces = openBraces - closeBraces;

      if (braceStack.length > 0) {
        braceStack[braceStack.length - 1].braces += netBraces;
        while (braceStack.length > 0 && braceStack[braceStack.length - 1].braces <= 0) {
          const popped = braceStack.pop();
          if (popped.type === 'loop') {
            loopDepth = Math.max(0, loopDepth - 1);
          }
        }
      }
    }

    // ==========================================
    // 🔴 CRITICAL SECURITY CHECKS
    // ==========================================

    // 1. SQL INJECTION - String concatenation in SQL queries (including template literals)
    if ((lineLower.includes('select') || lineLower.includes('insert') || 
         lineLower.includes('update') || lineLower.includes('delete') ||
         lineLower.includes('where') || lineLower.includes('from')) && 
        (line.includes("'+") || line.includes("+ '") || line.includes('${') || line.includes('" +') ||
         /`[^`]*\$\{[^}]+\}[^`]*`/.test(line))) {
      issues.security.push({
        line: lineNum,
        message: 'SQL Injection: User input concatenated into SQL query.',
        severity: 'critical',
        rule: 'sql-injection',
        suggestion: 'Use parameterized queries: db.query("SELECT * FROM users WHERE id = ?", [userId])',
      });
    }

    // 2. COMMAND INJECTION - exec/spawn with user input
    if (/exec\s*\(/.test(line) && (line.includes('+') || line.includes('${') || line.includes('req.'))) {
      issues.security.push({
        line: lineNum,
        message: 'Command Injection: User input in shell command.',
        severity: 'critical',
        rule: 'command-injection',
        suggestion: 'Use execFile() with arguments array, never concatenate user input into commands.',
      });
    }

    // 3. XSS - User input in HTML response  
    if (/res\.(send|write)\s*\(/.test(line) && /['"`].*<.*>/.test(line) &&
        (line.includes('+') || line.includes('${'))) {
      issues.security.push({
        line: lineNum,
        message: 'XSS Vulnerability: User input rendered in HTML without escaping.',
        severity: 'high',
        rule: 'xss',
        suggestion: 'Escape HTML entities or use a templating engine with auto-escaping.',
      });
    }

    // 4. HARDCODED CREDENTIALS
    if (PATTERNS.HARDCODED_PASSWORD.test(line) && !line.includes('process.env')) {
      issues.security.push({
        line: lineNum,
        message: 'Hardcoded password detected in source code.',
        severity: 'critical',
        rule: 'hardcoded-credentials',
        suggestion: 'Use environment variables: process.env.DB_PASSWORD',
      });
    }

    // 5. WEAK CRYPTO - MD5/SHA1 for passwords
    if (PATTERNS.WEAK_HASH_MD5.test(line)) {
      issues.security.push({
        line: lineNum,
        message: 'Weak cryptography: MD5 is broken for password hashing.',
        severity: 'critical',
        rule: 'weak-crypto',
        suggestion: 'Use bcrypt or argon2 for password hashing: await bcrypt.hash(password, 12)',
      });
    }

    if (PATTERNS.WEAK_HASH_SHA1.test(line) && lineLower.includes('password')) {
      issues.security.push({
        line: lineNum,
        message: 'Weak cryptography: SHA1 is not recommended for passwords.',
        severity: 'high',
        rule: 'weak-crypto',
        suggestion: 'Use bcrypt or argon2 for password hashing.',
      });
    }

    // 6. OPEN REDIRECT - res.redirect with variable (not hardcoded URL)
    if (/res\.redirect\s*\(\s*\w+\s*\)/.test(line) && !line.includes("'") && !line.includes('"')) {
      issues.security.push({
        line: lineNum,
        message: 'Open Redirect: User-controlled redirect URL.',
        severity: 'high',
        rule: 'open-redirect',
        suggestion: 'Validate redirect URLs against a whitelist of allowed domains.',
      });
    }

    // 7. WEAK SESSION ID
    if (PATTERNS.WEAK_SESSION_ID.test(line) && lineLower.includes('session')) {
      issues.security.push({
        line: lineNum,
        message: 'Insecure session ID: Math.random() is not cryptographically secure.',
        severity: 'high',
        rule: 'weak-session',
        suggestion: 'Use crypto.randomUUID() or crypto.randomBytes(32).toString("hex")',
      });
    }

    // 8. MEMORY LEAK - Unbounded array growth
    for (const arrayName of globalArrays) {
      if (line.includes(`${arrayName}.push(`) && !line.includes('// bounded')) {
        issues.security.push({
          line: lineNum,
          message: `Memory Leak: Unbounded growth of global array "${arrayName}".`,
          severity: 'high',
          rule: 'memory-leak',
          suggestion: 'Add size limits, use LRU cache, or store in Redis/database.',
        });
      }
    }

    // ==========================================
    // ⚡ PERFORMANCE CHECKS
    // ==========================================

    // STRING CONCATENATION in loop
    if (loopDepth > 0) {
      if (PATTERNS.STRING_CONCAT_ASSIGNMENT.test(line) || PATTERNS.STRING_CONCAT_BINARY.test(line)) {
        issues.performance.push({
          line: lineNum,
          message: 'Inefficient string concatenation inside loop.',
          severity: 'high',
          rule: 'string-concat-in-loop',
          suggestion: 'Use array.push() and array.join("") for O(n) instead of O(n²) performance.',
        });
      }
    }

    // REGEX IN LOOP
    if (loopDepth > 0 && PATTERNS.REGEX_CREATION.test(trimmed)) {
      issues.performance.push({
        line: lineNum,
        message: 'Regex defined inside loop causes recompilation on each iteration.',
        severity: 'medium',
        rule: 'regex-in-loop',
        suggestion: 'Move regex definition outside the loop.',
      });
    }

    // ==========================================
    // 📝 STYLE CHECKS
    // ==========================================

    // LOOSE EQUALITY
    if (/[^!=]==[^=]/.test(line) && !/===/.test(line)) {
      issues.style.push({
        line: lineNum,
        message: 'Use strict equality (===) instead of loose equality (==).',
        severity: 'low',
        rule: 'eqeqeq',
        suggestion: 'Replace == with === to prevent type coercion bugs.',
      });
    }
  });

  return issues;
}

async function analyzeCode(fileContent, fileName) {
  // ✅ DLQ testing with structured error
  if (process.env.ALLOW_FORCE_FAIL === "true" && fileName === "force_fail.js") {
    throw new AnalysisError(ERROR_CODES.FORCED_FAILURE, "Forced failure for DLQ testing");
  }

  const startTime = Date.now();

  try {
    // ============================================
    // STAGE 1a: Pattern-based Analysis
    // ============================================
    const patternIssues = detectPatternIssues(fileContent, fileName);

    // ============================================
    // STAGE 1b: Static Analysis (ESLint)
    // ============================================

    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ['**/*.js', '**/*.jsx'],
          languageOptions: {
            ecmaVersion: 2021,
            sourceType: 'module',
            globals: {
              // Node.js globals
              __dirname: 'readonly',
              __filename: 'readonly',
              Buffer: 'readonly',
              clearImmediate: 'readonly',
              clearInterval: 'readonly',
              clearTimeout: 'readonly',
              global: 'readonly',
              process: 'readonly',
              setImmediate: 'readonly',
              setInterval: 'readonly',
              setTimeout: 'readonly',
              // Browser globals
              window: 'readonly',
              document: 'readonly',
              console: 'readonly',
              fetch: 'readonly',
            },
          },
          rules: {
            'no-eval': 'error',
            'no-implied-eval': 'error',
            'no-new-func': 'error',
            'no-await-in-loop': 'warn',
            'no-console': 'warn',
            'no-debugger': 'error',
            'no-unused-vars': 'warn',
          },
        },
      ],
    });

    const results = await eslint.lintText(fileContent, { filePath: fileName });

    const issues = {
      security: [...patternIssues.security],
      performance: [...patternIssues.performance],
      style: [...patternIssues.style],
    };

    const securityRules = ['no-eval', 'no-implied-eval', 'no-new-func'];
    const performanceRules = ['no-await-in-loop'];

    results[0].messages.forEach((msg) => {
      const issue = {
        line: msg.line,
        column: msg.column,
        message: msg.message,
        severity: msg.severity === 2 ? 'high' : 'medium',
        rule: msg.ruleId,
        file: fileName,
        suggestion: getFixSuggestion(msg.ruleId),
      };

      if (securityRules.includes(msg.ruleId)) {
        issues.security.push(issue);
      } else if (performanceRules.includes(msg.ruleId)) {
        issues.performance.push(issue);
      } else {
        issues.style.push(issue);
      }
    });

    console.log(`✅ Static analysis complete: ${issues.security.length} security, ${issues.performance.length} performance, ${issues.style.length} style issues`);

    // ============================================
    // STAGE 2: AI Analysis (Smart)
    // ============================================

    let aiSuggestions = [];

    // Only use AI if enabled and file is reasonable size (using CONFIG constants)
    const lines = fileContent.split('\n').length;
    const useAI = process.env.ENABLE_AI === 'true';

    if (useAI && lines >= CONFIG.MIN_FILE_LINES_FOR_AI && lines <= CONFIG.MAX_FILE_LINES_FOR_AI) {
      const aiContextIssues = [...issues.security, ...issues.performance].filter(i => i.severity === 'high' || i.severity === 'critical');
      aiSuggestions = await reviewCodeWithAI(fileName, fileContent, aiContextIssues);
      console.log(`🤖 AI analysis complete: ${aiSuggestions.length} suggestions found`);
    } else if (!useAI) {
      console.log('⏭️ AI review skipped (ENABLE_AI is not true)');
    } else if (lines < CONFIG.MIN_FILE_LINES_FOR_AI || lines > CONFIG.MAX_FILE_LINES_FOR_AI) {
      console.log(`⏭️ AI review skipped (file size: ${lines} lines, must be ${CONFIG.MIN_FILE_LINES_FOR_AI}-${CONFIG.MAX_FILE_LINES_FOR_AI})`);
    }

    const processingTime = Date.now() - startTime;

    // ============================================
    // Return Combined Results
    // ============================================

    return {
      fileName,
      security: issues.security,
      performance: issues.performance,
      style: issues.style,
      aiSuggestions,
      metrics: {
        reviewTime: `${(processingTime / 1000).toFixed(1)}s`,
        linesAnalyzed: lines,
        issuesFound:
          issues.security.length +
          issues.performance.length +
          issues.style.length +
          aiSuggestions.length,
        processingTimeMs: processingTime,
      },
    };
  } catch (error) {
    // ✅ Structured error handling with context
    const analysisError = new AnalysisError(
      error.code || ERROR_CODES.ESLINT_FAILED,
      `Analysis failed for ${fileName}: ${error.message}`,
      error
    );
    
    console.error('❌ Analysis error:', {
      code: analysisError.code,
      fileName,
      message: error.message,
      stack: error.stack?.split('\n').slice(0, 3).join('\n'),
    });
    
    throw analysisError;
  }
}

module.exports = { analyzeCode, AnalysisError, ERROR_CODES };
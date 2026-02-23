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
  // Security patterns
  COMMAND_INJECTION: /exec\s*\(\s*[`'"].*(\+|\$\{)/,
  
  // Performance patterns
  STRING_CONCAT_ASSIGNMENT: /\w+\s*\+=\s*['"`]/,
  STRING_CONCAT_BINARY: /\w+\s*=\s*\w+\s*\+\s*['"`]/,
  REGEX_CREATION: /(new\s+RegExp\(|^\s*\/.*\/[gimuy]*\.(test|exec)\()/,
  
  // Loop detection
  LOOP_KEYWORDS: /(for|while|forEach|map|filter|reduce)\s*\(/,
  LOOP_START: /^\s*(for|while)\s*\(/,
  BLOCK_END: /^\s*\}/,
};

// ==============================================
// MULTI-LANGUAGE DETECTION (Java, Python, etc.)
// ==============================================
function detectLanguage(fileName, fileContent) {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.java') return 'java';
  if (ext === '.py') return 'python';
  if (ext === '.go') return 'go';
  if (ext === '.rb') return 'ruby';
  if (ext === '.php') return 'php';
  if (ext === '.cs') return 'csharp';
  if (ext === '.cpp' || ext === '.c' || ext === '.h') return 'cpp';
  if (ext === '.ts' || ext === '.tsx') return 'typescript';
  if (ext === '.js' || ext === '.jsx') return 'javascript';
  // Detect by content
  if (/public\s+class\s+\w+|import\s+java\./.test(fileContent)) return 'java';
  if (/^import\s+\w+|^from\s+\w+\s+import|def\s+\w+\s*\(/.test(fileContent)) return 'python';
  return 'javascript'; // default
}

// ==============================================
// JAVA-SPECIFIC SECURITY DETECTION
// ==============================================
function detectJavaIssues(fileContent, fileName) {
  const issues = [];
  const lines = fileContent.split('\n');
  
  lines.forEach((line, index) => {
    const lineNum = index + 1;
    
    // 1. SQL INJECTION (Java-specific with proper suggestion)
    if (/executeQuery\s*\(|executeUpdate\s*\(|prepareStatement\s*\(/.test(line) && 
        /"\s*\+\s*\w+|'\s*\+\s*\w+/.test(line)) {
      issues.push({
        line: lineNum,
        message: 'SQL Injection: String concatenation in SQL query',
        severity: 'critical',
        rule: 'java/sql-injection',
        suggestion: 'Use PreparedStatement with parameterized queries:\nPreparedStatement ps = conn.prepareStatement("SELECT * FROM users WHERE id = ?");\nps.setString(1, userId);',
        category: 'security',
      });
    }
    
    // 2. HARDCODED CREDENTIALS
    if (/(?:password|passwd|pwd|secret|apikey|api_key)\s*=\s*["'][^"']{4,}["']/i.test(line) ||
        /getConnection\s*\([^)]*["'][^"']+["']\s*,\s*["'][^"']+["']\s*,\s*["'][^"']+["']/.test(line)) {
      issues.push({
        line: lineNum,
        message: 'Hardcoded credentials detected - security risk',
        severity: 'critical',
        rule: 'java/hardcoded-credentials',
        suggestion: 'Use environment variables or secure vault:\nString password = System.getenv("DB_PASSWORD");',
        category: 'security',
      });
    }
    
    // 3. WEAK CRYPTOGRAPHY (MD5, SHA1)
    if (/MessageDigest\.getInstance\s*\(\s*["'](?:MD5|SHA-?1)["']\)/i.test(line)) {
      const algo = line.match(/["'](MD5|SHA-?1)["']/i)?.[1] || 'MD5';
      issues.push({
        line: lineNum,
        message: `Weak cryptographic hash (${algo}) - vulnerable to collision attacks`,
        severity: 'critical',
        rule: 'java/weak-crypto',
        suggestion: 'Use SHA-256 or stronger:\nMessageDigest md = MessageDigest.getInstance("SHA-256");\nOr use bcrypt/scrypt for passwords.',
        category: 'security',
      });
    }
    
    // 4. COMMAND INJECTION (Runtime.exec)
    if (/Runtime\.getRuntime\(\)\.exec\s*\(/.test(line) && /\+\s*\w+|\+\s*args/.test(line)) {
      issues.push({
        line: lineNum,
        message: 'Command Injection: User input passed to Runtime.exec()',
        severity: 'critical',
        rule: 'java/command-injection',
        suggestion: 'Use ProcessBuilder with argument array and validate/sanitize all inputs:\nProcessBuilder pb = new ProcessBuilder("cmd", sanitizedArg);\nNever concatenate user input into commands.',
        category: 'security',
      });
    }
    
    // 5. UNSAFE DESERIALIZATION
    if (/ObjectInputStream|readObject\s*\(/.test(line)) {
      issues.push({
        line: lineNum,
        message: 'Unsafe deserialization - can lead to Remote Code Execution (RCE)',
        severity: 'critical',
        rule: 'java/unsafe-deserialization',
        suggestion: 'Avoid ObjectInputStream with untrusted data. Use JSON/XML with schema validation, or implement ObjectInputFilter:\nObjectInputFilter filter = ObjectInputFilter.Config.createFilter("!*");',
        category: 'security',
      });
    }
    
    // 6. RESOURCE LEAK (Connection/Stream not closed)
    if (/(?:Connection|Statement|ResultSet|InputStream|OutputStream|Reader|Writer)\s+\w+\s*=/.test(line)) {
      // Check if try-with-resources or close() is present
      const varMatch = line.match(/(?:Connection|Statement|ResultSet|InputStream|OutputStream|Reader|Writer)\s+(\w+)\s*=/);
      if (varMatch) {
        const varName = varMatch[1];
        const restOfCode = lines.slice(index).join('\n');
        const hasTryWithResources = /try\s*\([^)]*\w+\s*=/.test(lines.slice(Math.max(0, index - 5), index + 1).join('\n'));
        const hasClose = new RegExp(`${varName}\\.close\\s*\\(`).test(restOfCode);
        const hasFinally = /finally\s*\{/.test(restOfCode.substring(0, 500));
        
        if (!hasTryWithResources && !hasClose && !hasFinally) {
          issues.push({
            line: lineNum,
            message: `Resource leak: ${varMatch[0].split('=')[0].trim()} may not be closed`,
            severity: 'high',
            rule: 'java/resource-leak',
            suggestion: 'Use try-with-resources for auto-closing:\ntry (Connection conn = DriverManager.getConnection(...)) {\n    // use connection\n} // auto-closed',
            category: 'reliability',
          });
        }
      }
    }
    
    // 7. EMPTY CATCH BLOCK (Swallowed exception)
    if (/catch\s*\([^)]+\)\s*\{\s*\}/.test(line) || 
        (/catch\s*\([^)]+\)\s*\{/.test(line) && lines[index + 1]?.trim() === '}')) {
      issues.push({
        line: lineNum,
        message: 'Empty catch block swallows exception - hides errors',
        severity: 'high',
        rule: 'java/empty-catch',
        suggestion: 'At minimum, log the exception:\ncatch (Exception e) {\n    logger.error("Operation failed", e);\n    throw new RuntimeException("Operation failed", e);\n}',
        category: 'reliability',
      });
    }
    
    // 8. THREAD EXPLOSION (creating threads in loop)
    if (/new\s+Thread\s*\(/.test(line)) {
      // Check if inside a loop
      const context = lines.slice(Math.max(0, index - 10), index).join('\n');
      if (/for\s*\(|while\s*\(/.test(context)) {
        issues.push({
          line: lineNum,
          message: 'Thread explosion: Creating threads in a loop can cause DoS',
          severity: 'critical',
          rule: 'java/thread-explosion',
          suggestion: 'Use ExecutorService with bounded thread pool:\nExecutorService executor = Executors.newFixedThreadPool(10);\nexecutor.submit(() -> { /* task */ });',
          category: 'performance',
        });
      }
    }
    
    // 9. PATH TRAVERSAL
    if (/new\s+File\s*\(|new\s+FileInputStream\s*\(|new\s+FileOutputStream\s*\(/.test(line) && 
        /\+\s*\w+|args\[/.test(line)) {
      issues.push({
        line: lineNum,
        message: 'Path Traversal: User input used in file path',
        severity: 'high',
        rule: 'java/path-traversal',
        suggestion: 'Validate and canonicalize paths:\nFile file = new File(basePath, userInput).getCanonicalFile();\nif (!file.toPath().startsWith(basePath)) throw new SecurityException();',
        category: 'security',
      });
    }
    
    // 10. XXE (XML External Entity)
    if (/DocumentBuilderFactory|SAXParserFactory|XMLInputFactory/.test(line)) {
      const context = lines.slice(index, Math.min(lines.length, index + 10)).join('\n');
      if (!/setFeature.*disallow-doctype-decl|setFeature.*external-general-entities.*false/.test(context)) {
        issues.push({
          line: lineNum,
          message: 'Potential XXE vulnerability: XML parser without secure configuration',
          severity: 'high',
          rule: 'java/xxe',
          suggestion: 'Disable external entities:\nfactory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);\nfactory.setFeature("http://xml.org/sax/features/external-general-entities", false);',
          category: 'security',
        });
      }
    }
    
    // 11. INSECURE RANDOM
    if (/new\s+Random\s*\(|Math\.random\s*\(/.test(line)) {
      const context = lines.slice(Math.max(0, index - 5), index + 5).join('\n');
      if (/token|password|secret|key|session|auth|crypt/i.test(context)) {
        issues.push({
          line: lineNum,
          message: 'Insecure random number generator used for security-sensitive operation',
          severity: 'high',
          rule: 'java/insecure-random',
          suggestion: 'Use SecureRandom for security-sensitive values:\nSecureRandom random = new SecureRandom();\nbyte[] bytes = new byte[32];\nrandom.nextBytes(bytes);',
          category: 'security',
        });
      }
    }
    
    // 12. NULL POINTER DEREFERENCE
    if (/\.getString\s*\(|\.getObject\s*\(|\.next\s*\(/.test(line)) {
      const context = lines.slice(index, Math.min(lines.length, index + 3)).join('\n');
      if (!/if\s*\(\s*\w+\s*!=\s*null|!=\s*null\s*&&|Optional/.test(context) && /\.\w+\s*\(/.test(context)) {
        // Check if return value is used without null check
        if (/\w+\s*\.\s*\w+\s*\(/.test(lines[index + 1] || '')) {
          issues.push({
            line: lineNum,
            message: 'Potential NullPointerException: Return value used without null check',
            severity: 'medium',
            rule: 'java/null-pointer',
            suggestion: 'Check for null before using:\nString value = rs.getString(1);\nif (value != null) { /* use value */ }\nOr use Optional: Optional.ofNullable(value).ifPresent(...)',
            category: 'reliability',
          });
        }
      }
    }
  });
  
  // Check for missing HTTPS/SSL verification (file-level)
  if (/HttpURLConnection|HttpClient|URL\s*\(/.test(fileContent) && 
      !/setHostnameVerifier|SSLContext|TrustManager/.test(fileContent) &&
      /http:\/\//.test(fileContent)) {
    issues.push({
      line: 1,
      message: 'Insecure HTTP connection without SSL/TLS',
      severity: 'high',
      rule: 'java/insecure-http',
      suggestion: 'Use HTTPS and verify certificates:\nHttpsURLConnection conn = (HttpsURLConnection) url.openConnection();',
      category: 'security',
    });
  }
  
  return issues;
}

// ==============================================
// PYTHON-SPECIFIC SECURITY DETECTION
// ==============================================
function detectPythonIssues(fileContent, fileName) {
  const issues = [];
  const lines = fileContent.split('\n');
  
  lines.forEach((line, index) => {
    const lineNum = index + 1;
    
    // 1. SQL Injection
    if (/execute\s*\(|executemany\s*\(|raw\s*\(/.test(line) && /%s|%d|\+\s*\w+|\.format\s*\(|f["']/.test(line)) {
      issues.push({
        line: lineNum,
        message: 'SQL Injection: String formatting in SQL query',
        severity: 'critical',
        rule: 'python/sql-injection',
        suggestion: 'Use parameterized queries:\ncursor.execute("SELECT * FROM users WHERE id = %s", (user_id,))',
        category: 'security',
      });
    }
    
    // 2. Command Injection
    if (/os\.system\s*\(|subprocess\.call\s*\(.*shell\s*=\s*True|subprocess\.Popen\s*\(.*shell\s*=\s*True/.test(line)) {
      issues.push({
        line: lineNum,
        message: 'Command Injection: Shell command with potential user input',
        severity: 'critical',
        rule: 'python/command-injection',
        suggestion: 'Use subprocess with shell=False and argument list:\nsubprocess.run(["ls", "-la", path], shell=False)',
        category: 'security',
      });
    }
    
    // 3. Pickle deserialization
    if (/pickle\.load|pickle\.loads|cPickle\.load/.test(line)) {
      issues.push({
        line: lineNum,
        message: 'Unsafe deserialization: pickle can execute arbitrary code',
        severity: 'critical',
        rule: 'python/unsafe-pickle',
        suggestion: 'Use JSON for untrusted data, or use hmac to verify pickle integrity',
        category: 'security',
      });
    }
    
    // 4. Hardcoded secrets
    if (/(?:password|secret|api_key|token)\s*=\s*["'][^"']{4,}["']/i.test(line)) {
      issues.push({
        line: lineNum,
        message: 'Hardcoded credential detected',
        severity: 'critical',
        rule: 'python/hardcoded-secret',
        suggestion: 'Use environment variables: os.environ.get("API_KEY")',
        category: 'security',
      });
    }
    
    // 5. eval() usage
    if (/\beval\s*\(/.test(line)) {
      issues.push({
        line: lineNum,
        message: 'eval() executes arbitrary code - severe security risk',
        severity: 'critical',
        rule: 'python/eval',
        suggestion: 'Use ast.literal_eval() for data parsing, or avoid eval entirely',
        category: 'security',
      });
    }
  });
  
  return issues;
}

// ==============================================
// ASYNC/CONCURRENCY BUG PATTERNS
// ==============================================
const ASYNC_PATTERNS = {
  // Race conditions - shared state mutation without locks
  RACE_CONDITION_SHARED: /let\s+\w+\s*=\s*(?:0|null|undefined|\[\]|\{\})[\s\S]*?(?:async|Promise)/,
  
  // Promise overwrite - reassigning promise before awaiting
  PROMISE_OVERWRITE: /(\w+)\s*=\s*(?:fetch|axios|new Promise|\.then)[\s\S]{0,100}?\1\s*=\s*(?:fetch|axios|new Promise|\.then)/,
  
  // Missing await
  MISSING_AWAIT: /(?:const|let|var)\s+\w+\s*=\s*(?:fetch|axios\.(?:get|post|put|delete)|\.findOne|\.find\(|\.create\(|\.update\()/,
  
  // setInterval without clearInterval - potential memory leak
  INTERVAL_NO_CLEAR: /setInterval\s*\([^)]+\)/,
  
  // setTimeout in loop without proper closure
  SETTIMEOUT_IN_LOOP: /(?:for|while)\s*\([^)]+\)\s*\{[^}]*setTimeout/,
  
  // Event listener without removeEventListener
  LISTENER_NO_REMOVE: /addEventListener\s*\(\s*['"][^'"]+['"]/,
  
  // Array push in async without mutex
  ASYNC_ARRAY_PUSH: /async[^{]*\{[^}]*\.push\s*\(/,
  
  // No AbortController for fetch
  FETCH_NO_ABORT: /fetch\s*\([^)]+\)(?![\s\S]{0,50}AbortController|signal)/,
  
  // Retry without exponential backoff
  RETRY_NO_BACKOFF: /(?:retry|attempt|tries)\s*(?:\+\+|--|\+=|\-=)[\s\S]{0,200}(?:setTimeout|delay)\s*\([^,]+,\s*\d{2,4}\s*\)/,
  
  // Global state mutation in async
  GLOBAL_ASYNC_MUTATION: /(?:global|window|globalThis)\.\w+\s*=[\s\S]{0,50}(?:await|async|Promise)/,
  
  // Stale closure in useEffect/callback
  STALE_CLOSURE: /useEffect\s*\(\s*\(\s*\)\s*=>\s*\{[^}]*(?:let|const)\s+\w+[\s\S]*?setTimeout|setInterval/,
  
  // Infinite loop potential
  INFINITE_LOOP: /while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/,
  
  // forEach with async (doesn't await properly)
  FOREACH_ASYNC: /\.forEach\s*\(\s*async/,
};

// Async issue suggestions
function getAsyncSuggestion(type) {
  const suggestions = {
    'race-condition': 'Use mutex/semaphore or atomic operations. Consider using a state management library.',
    'promise-overwrite': 'Store promises in separate variables or use Promise.all() for parallel operations.',
    'missing-await': 'Add await keyword or handle the Promise with .then()/.catch().',
    'memory-leak-interval': 'Store interval ID and call clearInterval() in cleanup (useEffect return, componentWillUnmount).',
    'memory-leak-timeout': 'Use let variable outside loop to preserve timeout reference, or use closure properly.',
    'memory-leak-listener': 'Store listener reference and call removeEventListener() in cleanup.',
    'async-array-race': 'Use mutex pattern or collect results with Promise.all() instead of pushing to shared array.',
    'missing-abort-controller': 'Add AbortController to allow cancellation of in-flight requests.',
    'retry-hammering': 'Implement exponential backoff: delay = baseDelay * Math.pow(2, retryCount).',
    'global-state-corruption': 'Avoid mutating global state in async code. Use local state or proper state management.',
    'stale-closure': 'Add state variables to dependency array or use useRef for mutable values.',
    'infinite-loop': 'Add exit condition or use recursion with base case instead.',
    'foreach-async': 'Use for...of loop with await, or Promise.all(items.map(async item => ...)).',
  };
  return suggestions[type] || 'Review async/await patterns and ensure proper synchronization.';
}

// Detect async/concurrency issues
function detectAsyncIssues(fileContent, fileName) {
  const issues = [];
  const lines = fileContent.split('\n');
  
  // Track context
  const hasAsync = /async\s+function|async\s*\(|\.then\(|await\s/.test(fileContent);
  const hasReact = /import\s+.*React|useEffect|useState|useRef/.test(fileContent);
  
  // Only check for async issues if file has async patterns
  if (!hasAsync && !hasReact) {
    return issues;
  }
  
  // Check for forEach with async (common mistake)
  const forEachAsyncMatch = fileContent.match(/\.forEach\s*\(\s*async/g);
  if (forEachAsyncMatch) {
    for (let i = 0; i < lines.length; i++) {
      if (/\.forEach\s*\(\s*async/.test(lines[i])) {
        issues.push({
          line: i + 1,
          column: 1,
          message: 'forEach with async callback does not await - use for...of or Promise.all(map())',
          severity: 'high',
          rule: 'async/foreach-async',
          file: fileName,
          suggestion: getAsyncSuggestion('foreach-async'),
          category: 'concurrency',
        });
      }
    }
  }
  
  // Check for setInterval without cleanup tracking
  for (let i = 0; i < lines.length; i++) {
    if (/setInterval\s*\(/.test(lines[i]) && !/(?:const|let|var)\s+\w+\s*=\s*setInterval/.test(lines[i])) {
      issues.push({
        line: i + 1,
        column: 1,
        message: 'setInterval without storing reference - potential memory leak',
        severity: 'medium',
        rule: 'async/memory-leak-interval',
        file: fileName,
        suggestion: getAsyncSuggestion('memory-leak-interval'),
        category: 'memory-leak',
      });
    }
  }
  
  // Check for fetch without AbortController
  for (let i = 0; i < lines.length; i++) {
    if (/fetch\s*\(/.test(lines[i])) {
      // Look for AbortController in surrounding context (20 lines)
      const contextStart = Math.max(0, i - 10);
      const contextEnd = Math.min(lines.length, i + 10);
      const context = lines.slice(contextStart, contextEnd).join('\n');
      
      if (!/AbortController|signal\s*:/.test(context)) {
        issues.push({
          line: i + 1,
          column: 1,
          message: 'fetch() without AbortController - cannot cancel request on unmount',
          severity: 'low',
          rule: 'async/missing-abort-controller',
          file: fileName,
          suggestion: getAsyncSuggestion('missing-abort-controller'),
          category: 'concurrency',
        });
      }
    }
  }
  
  // Check for potential stale closures in useEffect
  if (hasReact) {
    for (let i = 0; i < lines.length; i++) {
      if (/useEffect\s*\(\s*\(\s*\)\s*=>\s*\{/.test(lines[i])) {
        // Look ahead for setTimeout/setInterval without deps
        const effectEnd = Math.min(lines.length, i + 20);
        const effectContent = lines.slice(i, effectEnd).join('\n');
        
        if (/setTimeout|setInterval/.test(effectContent) && /\[\s*\]\s*\)/.test(effectContent)) {
          issues.push({
            line: i + 1,
            column: 1,
            message: 'useEffect with setTimeout/setInterval and empty deps may cause stale closure',
            severity: 'medium',
            rule: 'async/stale-closure',
            file: fileName,
            suggestion: getAsyncSuggestion('stale-closure'),
            category: 'concurrency',
          });
        }
      }
    }
  }
  
  // Check for infinite loops
  for (let i = 0; i < lines.length; i++) {
    if (/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/.test(lines[i])) {
      // Check if there's a break or return nearby
      const loopEnd = Math.min(lines.length, i + 15);
      const loopContent = lines.slice(i, loopEnd).join('\n');
      
      if (!/break\s*;|return\s/.test(loopContent)) {
        issues.push({
          line: i + 1,
          column: 1,
          message: 'Infinite loop without break/return condition detected',
          severity: 'critical',
          rule: 'async/infinite-loop',
          file: fileName,
          suggestion: getAsyncSuggestion('infinite-loop'),
          category: 'concurrency',
        });
      }
    }
  }
  
  // Check for promise variable overwrite pattern
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const promiseAssignMatch = line.match(/(\w+)\s*=\s*(?:fetch|axios|new Promise)/);
    if (promiseAssignMatch) {
      const varName = promiseAssignMatch[1];
      // Check if same variable is reassigned before await
      for (let j = i + 1; j < Math.min(lines.length, i + 10); j++) {
        if (new RegExp(`await\\s+${varName}`).test(lines[j])) {
          break; // Properly awaited
        }
        if (new RegExp(`${varName}\\s*=\\s*(?:fetch|axios|new Promise)`).test(lines[j])) {
          issues.push({
            line: j + 1,
            column: 1,
            message: `Promise variable '${varName}' overwritten before being awaited - previous result lost`,
            severity: 'high',
            rule: 'async/promise-overwrite',
            file: fileName,
            suggestion: getAsyncSuggestion('promise-overwrite'),
            category: 'concurrency',
          });
          break;
        }
      }
    }
  }
  
  return issues;
}

// ==============================================
// SEMANTIC ANALYSIS - Deep Logic Bug Detection
// ==============================================
function detectSemanticIssues(fileContent, fileName) {
  const issues = [];
  const lines = fileContent.split('\n');
  const fullCode = fileContent;
  
  // ===== 1. EVENT LISTENER ISSUES =====
  
  // Event listener without try-catch (can crash entire system)
  if (/\.on\s*\(\s*['"][^'"]+['"]\s*,/.test(fullCode) || /addEventListener/.test(fullCode)) {
    // Check if callbacks have error handling
    const listenerMatches = fullCode.matchAll(/\.on\s*\(\s*['"]([^'"]+)['"]\s*,\s*(?:async\s*)?\(?([^)]*)\)?\s*=>\s*\{?/g);
    for (const match of listenerMatches) {
      const idx = fullCode.substring(0, match.index).split('\n').length;
      const afterMatch = fullCode.substring(match.index, match.index + 500);
      if (!/try\s*\{|\.catch\s*\(/.test(afterMatch.substring(0, 200))) {
        issues.push({
          line: idx,
          message: `Event listener '${match[1]}' has no error handling - unhandled error will crash the process`,
          severity: 'critical',
          rule: 'semantic/unprotected-listener',
          suggestion: 'Wrap callback body in try-catch or add .catch() for async handlers to prevent crashes.',
          category: 'reliability',
        });
      }
    }
    
    // Event listener memory leak - no removeEventListener/off
    if (/addEventListener|\.on\s*\(/.test(fullCode) && !/removeEventListener|\.off\s*\(|\.removeListener\s*\(/.test(fullCode)) {
      issues.push({
        line: 1,
        message: 'Event listeners added but never removed - potential memory leak',
        severity: 'high',
        rule: 'semantic/listener-leak',
        suggestion: 'Store listener references and call removeEventListener/off() in cleanup/destructor.',
        category: 'memory-leak',
      });
    }
  }
  
  // ===== 2. ASYNC LOOP RE-ENTRANCY =====
  
  // While loop with await - tasks added during await may be missed
  if (/while\s*\([^)]+\.length|while\s*\([^)]+\)\s*\{[\s\S]*?await/.test(fullCode)) {
    const whileMatch = fullCode.match(/while\s*\(([^)]+)\)/);
    if (whileMatch) {
      const lineNum = fullCode.substring(0, whileMatch.index).split('\n').length;
      // Check if there's a lock/mutex pattern
      if (!/running\s*=\s*true|locked\s*=\s*true|mutex|semaphore/i.test(fullCode)) {
        issues.push({
          line: lineNum,
          message: 'Async while loop may miss items added during await (re-entrancy bug)',
          severity: 'high',
          rule: 'semantic/async-reentry',
          suggestion: 'Use a proper job queue pattern or check queue state after each await completes.',
          category: 'concurrency',
        });
      } else {
        // Has lock but check if it's properly checked after await
        const afterAwait = fullCode.match(/await[^;]+;([\s\S]{0,100})/);
        if (afterAwait && !/\.length|queue\.|pending/.test(afterAwait[1])) {
          issues.push({
            line: lineNum,
            message: 'Items added during await may not be processed - check queue state after await',
            severity: 'medium',
            rule: 'semantic/async-reentry-check',
            suggestion: 'After await completes, re-check if new items were added: while(queue.length > 0)',
            category: 'concurrency',
          });
        }
      }
    }
  }
  
  // ===== 3. RETRY PATTERN ISSUES =====
  
  // Retry without delay (retry storm / self-DDoS)
  if (/retries?\s*(\+\+|\+\s*=\s*1)|retries?\s*<\s*\d/.test(fullCode)) {
    const hasDelay = /setTimeout|delay|sleep|backoff|wait/i.test(fullCode);
    const hasExponential = /Math\.pow|exponential|\*\s*2|\*\s*retries/i.test(fullCode);
    
    if (!hasDelay) {
      const retryLine = lines.findIndex(l => /retries?\s*(\+\+|\+\s*=)|retries?\s*</.test(l)) + 1;
      issues.push({
        line: retryLine || 1,
        message: 'Retry loop without delay - can cause retry storm / self-DDoS',
        severity: 'critical',
        rule: 'semantic/retry-storm',
        suggestion: 'Add exponential backoff: await delay(Math.pow(2, retries) * 100)',
        category: 'reliability',
      });
    } else if (!hasExponential) {
      const retryLine = lines.findIndex(l => /retries?\s*(\+\+|\+\s*=)|retries?\s*</.test(l)) + 1;
      issues.push({
        line: retryLine || 1,
        message: 'Retry with fixed delay - exponential backoff recommended',
        severity: 'medium',
        rule: 'semantic/retry-no-backoff',
        suggestion: 'Use exponential backoff: delay = baseDelay * Math.pow(2, retryAttempt)',
        category: 'reliability',
      });
    }
  }
  
  // Retry can starve other tasks (failing task pushed back, blocks queue)
  if (/\.push\s*\(\s*item\s*\)|\.push\s*\(\s*\{[^}]*retries/.test(fullCode) && /while\s*\([^)]+\.length/.test(fullCode)) {
    const pushLine = lines.findIndex(l => /\.push\s*\(.*(?:item|task|job)/.test(l)) + 1;
    issues.push({
      line: pushLine || 1,
      message: 'Failed task re-queued immediately - can starve other waiting tasks',
      severity: 'high',
      rule: 'semantic/retry-starvation',
      suggestion: 'Push failed tasks to end with delay, or use separate retry queue with lower priority.',
      category: 'concurrency',
    });
  }
  
  // ===== 4. QUEUE/BUFFER UNBOUNDED GROWTH =====
  
  // Queue/array without size limit
  if (/\.push\s*\(/.test(fullCode) && /queue|buffer|pending|tasks|items/i.test(fullCode)) {
    const hasLimit = /\.length\s*[<>]\s*\d|MAX_|LIMIT|capacity|isFull/i.test(fullCode);
    if (!hasLimit) {
      const queueLine = lines.findIndex(l => /(?:queue|buffer|pending|tasks)\s*[=:]/.test(l.toLowerCase())) + 1;
      issues.push({
        line: queueLine || 1,
        message: 'Queue/buffer grows without size limit - can cause memory exhaustion',
        severity: 'high',
        rule: 'semantic/unbounded-queue',
        suggestion: 'Add max size check: if (queue.length >= MAX_SIZE) throw new Error("Queue full")',
        category: 'memory-leak',
      });
    }
  }
  
  // ===== 5. MISSING GRACEFUL SHUTDOWN =====
  
  // Long-running process without shutdown handling
  if (/while\s*\(\s*true|setInterval|\.on\s*\(/.test(fullCode)) {
    const hasShutdown = /SIGTERM|SIGINT|shutdown|cleanup|dispose|destroy|close\s*\(|stop\s*\(/i.test(fullCode);
    if (!hasShutdown) {
      issues.push({
        line: 1,
        message: 'Long-running process without graceful shutdown handling',
        severity: 'medium',
        rule: 'semantic/no-shutdown',
        suggestion: 'Handle SIGTERM/SIGINT: process.on("SIGTERM", () => { cleanup(); process.exit(0); })',
        category: 'reliability',
      });
    }
  }
  
  // ===== 6. ERROR CONTEXT =====
  
  // Catch block without error context
  if (/catch\s*\(\s*(\w+)\s*\)/.test(fullCode)) {
    const catches = fullCode.matchAll(/catch\s*\(\s*(\w+)\s*\)\s*\{([^}]*)\}/g);
    for (const match of catches) {
      const errVar = match[1];
      const catchBody = match[2];
      // Check if error is logged with context
      if (!new RegExp(`${errVar}\\.message|${errVar}\\.stack|JSON\\.stringify\\s*\\(\\s*${errVar}`).test(catchBody)) {
        const lineNum = fullCode.substring(0, match.index).split('\n').length;
        issues.push({
          line: lineNum,
          message: 'Error caught but stack/message not preserved - poor debugging context',
          severity: 'low',
          rule: 'semantic/error-context',
          suggestion: `Log error details: console.error('Operation failed:', ${errVar}.message, ${errVar}.stack)`,
          category: 'observability',
        });
      }
    }
  }
  
  // ===== 7. SHARED STATE MUTATION =====
  
  // Class with shared state modified in async methods
  if (/class\s+\w+/.test(fullCode) && /this\.\w+\s*=/.test(fullCode) && /async\s+\w+\s*\(/.test(fullCode)) {
    // Check for potential race conditions on instance state
    const stateVars = [...fullCode.matchAll(/this\.(\w+)\s*=/g)].map(m => m[1]);
    const uniqueStateVars = [...new Set(stateVars)];
    
    if (uniqueStateVars.length > 0 && !/mutex|lock|semaphore|synchronized/i.test(fullCode)) {
      const asyncMethods = fullCode.match(/async\s+\w+/g) || [];
      if (asyncMethods.length > 0) {
        issues.push({
          line: 1,
          message: `Class has ${uniqueStateVars.length} mutable state vars (${uniqueStateVars.slice(0, 3).join(', ')}) accessed in async methods without synchronization`,
          severity: 'medium',
          rule: 'semantic/async-state-race',
          suggestion: 'Use mutex pattern or atomic operations for shared state in concurrent code.',
          category: 'concurrency',
        });
      }
    }
  }
  
  // ===== 8. CALLBACK HELL / PROMISE ANTI-PATTERNS =====
  
  // Nested callbacks without proper error propagation
  const nestedCallbacks = (fullCode.match(/=>\s*\{[^}]*=>\s*\{[^}]*=>\s*\{/g) || []).length;
  if (nestedCallbacks > 0) {
    issues.push({
      line: 1,
      message: `${nestedCallbacks} deeply nested callbacks detected - hard to debug and error-prone`,
      severity: 'medium',
      rule: 'semantic/callback-hell',
      suggestion: 'Refactor to async/await or extract nested logic into named functions.',
      category: 'maintainability',
    });
  }
  
  // ===== 9. MATH.RANDOM FOR CRITICAL DECISIONS =====
  
  // Using Math.random in retry/backoff logic (not cryptographically secure issue, but non-deterministic testing)
  if (/Math\.random\s*\(\)/.test(fullCode) && /retry|backoff|delay|test|spec/i.test(fullCode)) {
    const randomLine = lines.findIndex(l => /Math\.random\s*\(\)/.test(l)) + 1;
    issues.push({
      line: randomLine,
      message: 'Math.random() makes behavior non-deterministic - hard to test and debug',
      severity: 'low',
      rule: 'semantic/nondeterministic',
      suggestion: 'Inject random function as dependency for testability, or seed for reproducibility.',
      category: 'testability',
    });
  }
  
  // ===== 10. RATE LIMITER DESIGN FLAWS =====
  
  // Detect rate limiter patterns
  const isRateLimiter = /rate.*limit|limiter|throttle|quota/i.test(fullCode) || 
    (/limit/.test(fullCode) && /window|count|request/i.test(fullCode));
  
  if (isRateLimiter) {
    // Fixed-window rate limiter (burst-prone)
    if (/Date\.now\(\)|new Date\(\)/.test(fullCode) && /count\s*[+<>=]|\.count/.test(fullCode)) {
      const hasSliding = /sliding|token.*bucket|leaky.*bucket|rolling/i.test(fullCode);
      if (!hasSliding) {
        const windowLine = lines.findIndex(l => /window|start|timestamp/i.test(l)) + 1 || 1;
        issues.push({
          line: windowLine,
          message: 'Fixed-window rate limiter is burst-prone - allows 2x limit at window boundaries',
          severity: 'high',
          rule: 'design/fixed-window-limiter',
          suggestion: 'Use sliding window, token bucket, or leaky bucket algorithm for smooth rate limiting.',
          category: 'design',
        });
      }
    }
    
    // No Retry-After header signaling
    if (/throw.*Error|return.*false|reject/i.test(fullCode) && !/retry.*after|retryAfter|Retry-After/i.test(fullCode)) {
      issues.push({
        line: 1,
        message: 'Rate limiter does not signal retry time to clients',
        severity: 'medium',
        rule: 'design/no-retry-after',
        suggestion: 'Return or set Retry-After header: { retryAfter: Math.ceil((windowEnd - now) / 1000) }',
        category: 'design',
      });
    }
    
    // Single-process limitation (no distributed support)
    if (/this\.\w+\s*=\s*\{\}|this\.\w+\s*=\s*\[\]|new Map\(\)/.test(fullCode)) {
      const hasDistributed = /redis|memcache|database|db\.|cluster|distributed/i.test(fullCode);
      if (!hasDistributed) {
        issues.push({
          line: 1,
          message: 'In-memory rate limiter only works for single process - fails in clustered/distributed environments',
          severity: 'high',
          rule: 'design/single-process-limiter',
          suggestion: 'Use Redis or distributed cache for rate limiting in production: redis.incr(key), redis.expire()',
          category: 'design',
        });
      }
    }
  }
  
  // ===== 11. TIME-BASED ISSUES =====
  
  // Date.now() for timing-sensitive operations
  if (/Date\.now\(\)/.test(fullCode) && /[<>]=?\s*\w+\.\w+|diff|elapsed|window/i.test(fullCode)) {
    const hasMonotonic = /performance\.now|process\.hrtime|monotonic/i.test(fullCode);
    if (!hasMonotonic) {
      const timeLine = lines.findIndex(l => /Date\.now\(\)/.test(l)) + 1;
      issues.push({
        line: timeLine,
        message: 'Date.now() is affected by system clock changes/drift - unreliable for timing',
        severity: 'medium',
        rule: 'design/clock-drift',
        suggestion: 'Use performance.now() or process.hrtime() for monotonic timing in critical paths.',
        category: 'reliability',
      });
    }
  }
  
  // ===== 12. CACHE/STORAGE WITHOUT EVICTION =====
  
  // Object/Map used as cache without eviction
  if (/this\.\w+\s*=\s*\{\}|new Map\(\)|cache|store|registry/i.test(fullCode)) {
    const hasEviction = /delete\s+|\.delete\s*\(|evict|expire|ttl|lru|maxSize|max_size|cleanup/i.test(fullCode);
    const hasWeakMap = /WeakMap/.test(fullCode);
    
    if (!hasEviction && !hasWeakMap && /\[\w+\]\s*=/.test(fullCode)) {
      const cacheLine = lines.findIndex(l => /=\s*\{\}|new Map\(\)/i.test(l)) + 1 || 1;
      issues.push({
        line: cacheLine,
        message: 'Object/Map used as cache without eviction strategy - will grow unbounded',
        severity: 'high',
        rule: 'design/no-eviction',
        suggestion: 'Add TTL-based eviction, LRU policy, or use WeakMap for automatic GC of unused entries.',
        category: 'memory-leak',
      });
    }
  }
  
  // ===== 13. CONCURRENT ACCESS WITHOUT ATOMICITY =====
  
  // Read-modify-write pattern without atomicity
  if (/(\w+)\s*\+\+|(\w+)\s*\+=\s*1|(\w+)\s*=\s*\2\s*\+\s*1/.test(fullCode)) {
    // Check if this is in a concurrent context
    const isConcurrent = /async|Promise|concurrent|parallel|request|handler/i.test(fullCode);
    const hasLock = /mutex|lock|semaphore|atomic|synchronized/i.test(fullCode);
    
    if (isConcurrent && !hasLock) {
      const incrementLine = lines.findIndex(l => /\+\+|\+=\s*1/.test(l)) + 1;
      if (incrementLine > 0) {
        issues.push({
          line: incrementLine,
          message: 'Non-atomic read-modify-write (count++) in concurrent context - race condition',
          severity: 'high',
          rule: 'design/non-atomic-increment',
          suggestion: 'Use atomic operations or mutex: await mutex.acquire(); try { count++; } finally { mutex.release(); }',
          category: 'concurrency',
        });
      }
    }
  }
  
  // ===== 14. GLOBAL MUTABLE STATE =====
  
  // Global variables modified by request handlers
  if (/(?:const|let|var)\s+\w+\s*=\s*(?:new \w+|\{\}|\[\])/.test(fullCode)) {
    // Check if it's at module level and used in functions
    const moduleVars = [...fullCode.matchAll(/^(?:const|let|var)\s+(\w+)\s*=/gm)].map(m => m[1]);
    const hasMutation = moduleVars.some(v => new RegExp(`${v}\\s*\\.\\s*\\w+\\s*=|${v}\\s*\\[`).test(fullCode));
    const isInHandler = /function\s+\w*\s*\(.*req|app\.(get|post|put|delete)|router\.|handler/i.test(fullCode);
    
    if (hasMutation && isInHandler && !/singleton|instance/i.test(fullCode)) {
      issues.push({
        line: 1,
        message: 'Global mutable state shared across request handlers - unsafe under concurrent load',
        severity: 'high',
        rule: 'design/global-mutable-state',
        suggestion: 'Use request-scoped state, dependency injection, or thread-safe data structures.',
        category: 'concurrency',
      });
    }
  }
  
  // ===== 15. MISSING BACKPRESSURE =====
  
  // Queue/buffer without backpressure
  if (/\.push\s*\(|\.add\s*\(|enqueue/i.test(fullCode) && /queue|buffer|pending/i.test(fullCode)) {
    const hasBackpressure = /reject|throw|isFull|highWaterMark|backpressure|pause|maxSize/i.test(fullCode);
    if (!hasBackpressure) {
      issues.push({
        line: 1,
        message: 'Queue accepts items without backpressure - no way to signal producers to slow down',
        severity: 'medium',
        rule: 'design/no-backpressure',
        suggestion: 'Reject or block when queue is full: if (queue.length >= MAX) throw new Error("Backpressure")',
        category: 'reliability',
      });
    }
  }
  
  return issues;
}

// ==============================================
// AUTH-SPECIFIC SEMANTIC DETECTORS
// Catches refresh logic bugs, promise liveness, thundering herd
// ==============================================
function detectAuthIssues(fileContent, fileName) {
  const issues = [];
  const lines = fileContent.split('\n');
  const fullCode = fileContent;
  
  // Detect if this is auth-related code
  const isAuthCode = /refresh|token|auth|login|logout|session|credentials|bearer/i.test(fullCode);
  if (!isAuthCode) {
    return issues;
  }
  
  // ===============================================
  // 1. PROMISE LIVENESS & RESOLUTION DETECTOR
  // Catches: promises added to queue but never resolved/rejected
  // ===============================================
  
  // Pattern: Array of callbacks/promises + error path clears without resolving
  const hasCallbackQueue = /(?:pending|queue|waiting|subscribers|callbacks)\s*[\[.:]|\.push\s*\(\s*(?:resolve|reject|callback|cb|handler)/i.test(fullCode);
  
  if (hasCallbackQueue) {
    // Check for proper resolution on ALL code paths
    const resolvesAll = /\.forEach\s*\(\s*(?:\w+\s*=>\s*\w+\s*\(|(?:resolve|reject|cb|callback))/i.test(fullCode);
    const clearsWithoutResolving = /=\s*\[\s*\]|\.length\s*=\s*0|\.splice\s*\(\s*0|\.shift\s*\(\s*\)/.test(fullCode);
    const hasErrorPath = /catch\s*\(|\.catch\s*\(|if\s*\(\s*(?:error|err|e)\s*\)|error\s*\)\s*\{/i.test(fullCode);
    
    // Check if error paths also resolve pending promises
    if (hasErrorPath) {
      const catches = [...fullCode.matchAll(/catch\s*\([^)]*\)\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g)];
      for (const catchMatch of catches) {
        const catchBody = catchMatch[1];
        const lineNum = fullCode.substring(0, catchMatch.index).split('\n').length;
        
        // Error path clears queue without resolving waiters
        if (/=\s*\[\s*\]|\.length\s*=\s*0|\.splice\s*\(0/.test(catchBody) && 
            !/\.forEach|\.map\s*\(|while\s*\([^)]*\.length/.test(catchBody)) {
          issues.push({
            line: lineNum,
            message: 'Promise liveness bug: Error path clears queue without resolving pending promises - causes UI hang',
            severity: 'critical',
            rule: 'auth/promise-liveness',
            suggestion: 'Before clearing: pendingRequests.forEach(p => p.reject(error)); pendingRequests = [];',
            category: 'concurrency',
          });
        }
      }
    }
    
    // CRITICAL: Detect the specific pattern where success path resolves but error path clears without rejecting
    // Pattern: if (ok) { ...forEach...resolve... } else { ...= []... }
    const ifElsePattern = /if\s*\([^)]*\)\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}\s*else\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;
    let match;
    while ((match = ifElsePattern.exec(fullCode)) !== null) {
      const ifBlock = match[1];
      const elseBlock = match[2];
      
      // Success path has forEach with resolve
      const successHasResolve = /\.forEach\s*\([^)]*(?:resolve|reject)/.test(ifBlock);
      // Error path clears without forEach
      const errorClearsWithoutReject = /=\s*\[\s*\]/.test(elseBlock) && !/\.forEach|\.reject/.test(elseBlock);
      
      if (successHasResolve && errorClearsWithoutReject) {
        const lineNum = fullCode.substring(0, match.index).split('\n').length;
        issues.push({
          line: lineNum,
          message: 'Lost requests on error: Success resolves pending requests but error path clears queue without rejecting',
          severity: 'critical',
          rule: 'auth/lost-requests-on-error',
          suggestion: 'In error path: pendingRequests.forEach(p => p.reject(error)); pendingRequests = [];',
          category: 'concurrency',
        });
      }
    }
    
    // Check if queue is populated but no resolve/reject in some paths
    if (clearsWithoutResolving && !resolvesAll) {
      const clearLine = lines.findIndex(l => /=\s*\[\s*\]|\.length\s*=\s*0/.test(l)) + 1;
      issues.push({
        line: clearLine || 1,
        message: 'Lost requests: Callback/promise queue cleared without notifying all waiters',
        severity: 'critical',
        rule: 'auth/lost-promises',
        suggestion: 'Always notify waiters before clearing: queue.forEach(cb => cb(result)); queue = [];',
        category: 'concurrency',
      });
    }
    
    // Promises pushed but no path shows resolution
    const pushesPromise = /\.push\s*\(\s*(?:new Promise|resolve|reject|{\s*resolve|{\s*reject)/i.test(fullCode);
    const hasAnyResolve = /\.forEach\s*\([^)]*(?:resolve|reject)|while\s*\([^)]*\.length[^)]*\)[^{]*\{[^}]*(?:resolve|reject)/i.test(fullCode);
    
    if (pushesPromise && !hasAnyResolve) {
      issues.push({
        line: 1,
        message: 'Promise queue populated but no code path resolves/rejects all waiters - deadlock risk',
        severity: 'critical',
        rule: 'auth/unresolved-promises',
        suggestion: 'Ensure all queued promises are resolved: const resolve = pendingQueue.shift(); resolve(result);',
        category: 'concurrency',
      });
    }
  }
  
  // ===============================================
  // 2. AUTH REFRESH STATE MACHINE DETECTOR
  // Catches: race conditions, infinite loops, missing terminal states
  // ===============================================
  
  // Pattern: Boolean flag like isRefreshing without proper synchronization
  const refreshFlagMatch = fullCode.match(/(?:let|var)\s+(is(?:Refreshing|Loading|Fetching|Pending)|refreshing|tokenRefresh\w*)\s*=\s*(?:false|true)/i);
  
  if (refreshFlagMatch) {
    const flagName = refreshFlagMatch[1];
    const flagLine = fullCode.substring(0, refreshFlagMatch.index).split('\n').length;
    
    // Race condition: Check flag without mutex/lock
    // Pattern: if (isRefreshing) { wait } else { isRefreshing = true; refresh() }
    const checkAndSet = new RegExp(`if\\s*\\(\\s*!?${flagName}\\s*\\)[^{]*\\{[^}]*${flagName}\\s*=\\s*true`, 'i');
    const hasRaceProtection = /mutex|lock|semaphore|atomic|Promise\.race|single.*refresh|once/i.test(fullCode);
    
    if (checkAndSet.test(fullCode) && !hasRaceProtection) {
      issues.push({
        line: flagLine,
        message: `Race condition: Multiple callers can pass '${flagName}' check before flag is set - causes duplicate refresh calls`,
        severity: 'critical',
        rule: 'auth/refresh-race',
        suggestion: `Use mutex or single promise: let refreshPromise = null; if (!refreshPromise) { refreshPromise = doRefresh().finally(() => refreshPromise = null); } return refreshPromise;`,
        category: 'concurrency',
      });
    }
    
    // Missing terminal state: refresh flag set true but never reset on all paths
    const setsTrue = new RegExp(`${flagName}\\s*=\\s*true`, 'gi');
    const setsFalse = new RegExp(`${flagName}\\s*=\\s*false`, 'gi');
    const trueCount = (fullCode.match(setsTrue) || []).length;
    const falseCount = (fullCode.match(setsFalse) || []).length;
    
    if (trueCount > falseCount) {
      issues.push({
        line: flagLine,
        message: `State leak: '${flagName}' set to true ${trueCount}x but false only ${falseCount}x - may get stuck`,
        severity: 'high',
        rule: 'auth/stuck-state',
        suggestion: 'Use try/finally to ensure flag reset: try { isRefreshing = true; await refresh(); } finally { isRefreshing = false; }',
        category: 'reliability',
      });
    }
    
    // Check for finally block (proper cleanup)
    if (trueCount > 0 && !/finally\s*\{[^}]*false/.test(fullCode)) {
      issues.push({
        line: flagLine,
        message: `No finally block to reset '${flagName}' - flag stuck on error`,
        severity: 'high',
        rule: 'auth/missing-finally',
        suggestion: 'Wrap in try/finally: try { flag = true; await op(); } finally { flag = false; }',
        category: 'reliability',
      });
    }
  }
  
  // Infinite refresh loop: refresh response triggers another refresh
  const hasRefreshCall = /refresh\s*\(|refreshToken|getNewToken|renewToken/i.test(fullCode);
  const has401Check = /401|Unauthorized|token.*expired|expired.*token/i.test(fullCode);
  
  if (hasRefreshCall && has401Check) {
    // Check if refresh endpoint returning 401 causes infinite loop
    const loopEscape = /retry\s*(?:count|limit|max)|maxRetries|attempts\s*[<>]|break|return.*null|logout|clearToken|signOut/i.test(fullCode);
    
    if (!loopEscape) {
      const refreshLine = lines.findIndex(l => /refresh\s*\(|refreshToken/i.test(l)) + 1;
      issues.push({
        line: refreshLine || 1,
        message: 'Infinite refresh loop: No escape condition if refresh endpoint returns 401/invalid token',
        severity: 'critical',
        rule: 'auth/infinite-refresh',
        suggestion: 'Add max retry count or detect refresh-token-expired separately: if (isRefreshTokenExpired(error)) { logout(); return; }',
        category: 'reliability',
      });
    }
    
    // Check for forced logout on refresh failure
    const hasLogout = /logout|signOut|clearAuth|clearSession|removeToken/i.test(fullCode);
    if (!hasLogout) {
      issues.push({
        line: 1,
        message: 'Broken logout flow: No forced logout when refresh token expires - user stuck in invalid state',
        severity: 'high',
        rule: 'auth/missing-logout',
        suggestion: 'Handle refresh failure: if (refreshFailed) { clearTokens(); redirectToLogin(); }',
        category: 'reliability',
      });
    }
  }
  
  // Shared mutable global auth state (module-level variables)
  // Pattern: let token = ...; used across async functions
  const authStateVars = fullCode.match(/(?:let|var)\s+(token|accessToken|refreshToken|authToken|currentUser|isRefreshing|pendingRequests)\s*=/gi) || [];
  
  if (authStateVars.length > 0) {
    // Check if these are at module level (not inside a function)
    const lines = fileContent.split('\n');
    let funcDepth = 0;
    let moduleStateVars = [];
    
    lines.forEach((line, idx) => {
      funcDepth += (line.match(/function\s*\w*\s*\(|=>\s*\{|{\s*$/g) || []).length;
      funcDepth -= (line.match(/^\s*\}/g) || []).length;
      funcDepth = Math.max(0, funcDepth);
      
      // Module level variable declarations (depth 0)
      if (funcDepth === 0) {
        const varMatch = line.match(/(?:let|var)\s+(token|accessToken|refreshToken|authToken|currentUser|isRefreshing|pendingRequests)\s*=/i);
        if (varMatch) {
          moduleStateVars.push({ name: varMatch[1], line: idx + 1 });
        }
      }
    });
    
    if (moduleStateVars.length > 0) {
      const varNames = moduleStateVars.map(v => v.name).join(', ');
      issues.push({
        line: moduleStateVars[0].line,
        message: `Shared mutable global auth state (${varNames}): Concurrent requests can corrupt during refresh`,
        severity: 'high',
        rule: 'auth/global-state',
        suggestion: 'Encapsulate in singleton class with mutex, or use request-scoped state with AsyncLocalStorage.',
        category: 'concurrency',
      });
    }
  }
  
  // ===============================================
  // 3. THUNDERING HERD / RETRY STORM DETECTOR
  // Catches: all queued requests retried at once
  // ===============================================
  
  // Pattern: queue.forEach(cb => cb()) after success - all fire simultaneously
  const hasQueueFlush = /\.forEach\s*\(\s*(?:\w+\s*=>\s*\w+\s*\.|(?:cb|callback|resolve|req|handler)\s*=>)/i.test(fullCode);
  const hasQueue = /pending|queue|waiting|subscribers|callbacks/i.test(fullCode);
  
  if (hasQueueFlush && hasQueue) {
    // Check for staggering/batching
    const hasStagger = /setTimeout\s*\(\s*\(\s*\)\s*=>[^,]+,\s*i\s*\*|delay|stagger|batch|chunk|throttle|rateLimi|jitter|spread/i.test(fullCode);
    
    if (!hasStagger) {
      const flushLine = lines.findIndex(l => /\.forEach\s*\([^)]*(?:resolve|reject|cb|callback|handler|req\s*=>)/i.test(l)) + 1;
      issues.push({
        line: flushLine || 1,
        message: 'Refresh stampede: All queued requests retry simultaneously after refresh - can overwhelm server',
        severity: 'high',
        rule: 'auth/thundering-herd',
        suggestion: 'Stagger retries: pendingRequests.forEach((req, i) => setTimeout(() => req.retry(), i * 50));',
        category: 'reliability',
      });
    }
  }
  
  // Check for immediate retry without backoff after auth success
  const hasRetry = /retry|requeue|resend|refetch/i.test(fullCode);
  if (hasRetry && hasQueueFlush) {
    const hasBackoff = /backoff|jitter|Math\.random|delay\s*\*|spread/i.test(fullCode);
    if (!hasBackoff) {
      issues.push({
        line: 1,
        message: 'Retry storm: Immediate retries without jitter/backoff after refresh success',
        severity: 'medium',
        rule: 'auth/retry-storm',
        suggestion: 'Add jitter: const delay = baseDelay + Math.random() * 100; await sleep(delay);',
        category: 'reliability',
      });
    }
  }
  
  // ===============================================
  // 4. SILENT UI HANG DETECTION
  // Catches: async operations that never complete from user perspective
  // ===============================================
  
  // New Promise without timeout
  const hasNewPromise = /new Promise\s*\(\s*(?:async\s*)?\(?\s*(?:resolve|reject)/i.test(fullCode);
  const hasTimeout = /timeout|setTimeout.*reject|Promise\.race\s*\(\s*\[|AbortController|timeoutMs/i.test(fullCode);
  
  if (hasNewPromise && !hasTimeout) {
    const promiseLine = lines.findIndex(l => /new Promise\s*\(/i.test(l)) + 1;
    issues.push({
      line: promiseLine || 1,
      message: 'Silent hang: Promise may never resolve/reject - no timeout mechanism',
      severity: 'high',
      rule: 'auth/no-timeout',
      suggestion: 'Add timeout: Promise.race([operation, new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 30000))]);',
      category: 'reliability',
    });
  }
  
  // Return new Promise that depends on external callback
  const externalResolve = /return\s+new Promise[^}]*\.push\s*\(\s*(?:resolve|reject|\{[^}]*resolve)/i.test(fullCode);
  if (externalResolve) {
    const extLine = lines.findIndex(l => /return\s+new Promise/i.test(l)) + 1;
    issues.push({
      line: extLine || 1,
      message: 'External resolution dependency: Promise resolution depends on another callback - fragile chain',
      severity: 'medium',
      rule: 'auth/external-resolve',
      suggestion: 'Add timeout and error handling for the external callback scenario.',
      category: 'reliability',
    });
  }
  
  return issues;
}

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

// Pattern detectors for advanced issues with PROPER LOOP TRACKING
function detectPatternIssues(fileContent, fileName) {
  const issues = { security: [], performance: [], style: [] };
  const lines = fileContent.split('\n');

  //   Track loop depth properly to avoid false positives
  let loopDepth = 0;
  let braceStack = []; // Track brace context

  lines.forEach((line, index) => {
    const lineNum = index + 1;
    const trimmed = line.trim();

    // Track entering loops (increment depth when we see loop start)
    if (PATTERNS.LOOP_START.test(trimmed) || /\.(forEach|map|filter|reduce)\s*\(/.test(line)) {
      loopDepth++;
      // Count opening braces to track when loop ends
      const openBraces = (line.match(/\{/g) || []).length;
      const closeBraces = (line.match(/\}/g) || []).length;
      braceStack.push({ type: 'loop', braces: openBraces - closeBraces });
    } else {
      // Track braces for non-loop lines
      const openBraces = (line.match(/\{/g) || []).length;
      const closeBraces = (line.match(/\}/g) || []).length;
      const netBraces = openBraces - closeBraces;

      // Update brace tracking
      if (braceStack.length > 0) {
        braceStack[braceStack.length - 1].braces += netBraces;
        // If braces balance out, we've exited the loop
        while (braceStack.length > 0 && braceStack[braceStack.length - 1].braces <= 0) {
          const popped = braceStack.pop();
          if (popped.type === 'loop') {
            loopDepth = Math.max(0, loopDepth - 1);
          }
        }
      }
    }

    // 1. COMMAND INJECTION - Always check (not loop-dependent)
    if (PATTERNS.COMMAND_INJECTION.test(line)) {
      issues.security.push({
        line: lineNum,
        message: 'Potential Command Injection: Avoid dynamic strings in exec().',
        severity: 'critical',
        rule: 'command-injection',
        suggestion: 'Use execFile() with arguments array, or sanitize input with a whitelist.',
      });
    }

    // 2. STRING CONCATENATION - Only flag if INSIDE a loop
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

    // 3. REGEX IN LOOP - Only flag if INSIDE a loop
    if (loopDepth > 0 && PATTERNS.REGEX_CREATION.test(trimmed)) {
      issues.performance.push({
        line: lineNum,
        message: 'Regex defined inside loop causes recompilation on each iteration.',
        severity: 'medium',
        rule: 'regex-in-loop',
        suggestion: 'Move regex definition outside the loop: const pattern = /.../ before the loop.',
      });
    }

    // 4. LOOSE EQUALITY (Style)
    if (/[^!=]==[^=]/.test(line) && !/===/.test(line)) {
      issues.style.push({
        line: lineNum,
        message: 'Use strict equality (===) instead of loose equality (==).',
        severity: 'low',
        rule: 'eqeqeq',
        suggestion: 'Replace == with === to prevent type coercion bugs.',
      });
    }

    // 5. SQL INJECTION
    if (/(?:query|execute|raw)\s*\(\s*[`'"].*\$\{|\+\s*\w+/.test(line) || 
        /(?:query|execute)\s*\([^)]*\+\s*(?:req\.|params\.|body\.|query\.)/.test(line)) {
      issues.security.push({
        line: lineNum,
        message: 'Potential SQL Injection: User input concatenated into query.',
        severity: 'critical',
        rule: 'sql-injection',
        suggestion: 'Use parameterized queries: query("SELECT * FROM users WHERE id = $1", [userId])',
      });
    }

    // 6. XSS - innerHTML/outerHTML with dynamic content
    if (/\.innerHTML\s*=|\.outerHTML\s*=|document\.write\s*\(/.test(line) && /\$\{|\+/.test(line)) {
      issues.security.push({
        line: lineNum,
        message: 'Potential XSS: Dynamic content in innerHTML/outerHTML.',
        severity: 'critical',
        rule: 'xss-vulnerability',
        suggestion: 'Use textContent for text or sanitize HTML with DOMPurify.',
      });
    }

    // 7. HARDCODED SECRETS
    if (/(?:password|secret|api_?key|token|auth)\s*[:=]\s*['"][^'"]{8,}['"]/.test(line.toLowerCase())) {
      issues.security.push({
        line: lineNum,
        message: 'Potential hardcoded secret detected.',
        severity: 'critical',
        rule: 'hardcoded-secret',
        suggestion: 'Use environment variables: process.env.API_KEY',
      });
    }

    // 8. PATH TRAVERSAL
    if (/(?:readFile|writeFile|unlink|rmdir|access)\s*\([^)]*(?:req\.|params\.|query\.|body\.)/.test(line)) {
      issues.security.push({
        line: lineNum,
        message: 'Potential Path Traversal: User input in file operation.',
        severity: 'critical',
        rule: 'path-traversal',
        suggestion: 'Validate path with path.resolve() and ensure it stays within allowed directory.',
      });
    }

    // 9. PROTOTYPE POLLUTION
    if (/\[.*\]\s*=(?!=)|\.__proto__|Object\.assign\s*\([^,]+,\s*(?:req\.|body\.|params\.)/.test(line)) {
      issues.security.push({
        line: lineNum,
        message: 'Potential Prototype Pollution vulnerability.',
        severity: 'high',
        rule: 'prototype-pollution',
        suggestion: 'Validate object keys, use Object.create(null), or use Map instead.',
      });
    }

    // 10. INSECURE RANDOM
    if (/Math\.random\s*\(\)/.test(line) && /(?:token|password|secret|key|id|session)/i.test(line)) {
      issues.security.push({
        line: lineNum,
        message: 'Insecure random number generator used for security-sensitive value.',
        severity: 'high',
        rule: 'insecure-random',
        suggestion: 'Use crypto.randomBytes() or crypto.randomUUID() for secure random values.',
      });
    }

    // 11. MISSING ERROR HANDLING
    if (/\.catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(line) || /catch\s*\([^)]*\)\s*\{\s*\}/.test(line)) {
      issues.security.push({
        line: lineNum,
        message: 'Empty catch block swallows errors silently.',
        severity: 'medium',
        rule: 'empty-catch',
        suggestion: 'Log the error or rethrow it: catch(err) { console.error(err); throw err; }',
      });
    }

    // 12. N+1 QUERY (database in loop)
    if (loopDepth > 0 && /(?:await\s+)?(?:db|pool|prisma|knex|sequelize|mongoose)\.\w+\s*\(/.test(line)) {
      issues.performance.push({
        line: lineNum,
        message: 'Database query inside loop - potential N+1 query problem.',
        severity: 'high',
        rule: 'n-plus-one-query',
        suggestion: 'Batch queries using WHERE IN clause or use eager loading.',
      });
    }

    // 13. SYNCHRONOUS FILE OPERATIONS
    if (/(?:readFileSync|writeFileSync|existsSync|readdirSync|statSync)\s*\(/.test(line)) {
      issues.performance.push({
        line: lineNum,
        message: 'Synchronous file operation blocks event loop.',
        severity: 'medium',
        rule: 'sync-file-operation',
        suggestion: 'Use async versions: fs.promises.readFile() or fs.readFile() with callback.',
      });
    }

    // 14. UNBOUNDED ARRAY GROWTH
    if (/\.push\s*\(/.test(line) && loopDepth > 0 && !/\.length\s*[<>]/.test(fileContent.substring(Math.max(0, index - 200), index))) {
      issues.performance.push({
        line: lineNum,
        message: 'Array push in loop without size check may cause memory issues.',
        severity: 'low',
        rule: 'unbounded-array',
        suggestion: 'Add size limit check: if (arr.length < MAX_SIZE) arr.push(item)',
      });
    }

    // 15. MISSING INPUT VALIDATION
    if (/req\.(?:body|params|query)\.\w+/.test(line) && !/(?:validate|sanitize|check|joi|yup|zod)/.test(fileContent.substring(Math.max(0, index - 500), index))) {
      // Only flag once per function
      if (!issues.security.some(i => i.rule === 'missing-validation' && Math.abs(i.line - lineNum) < 10)) {
        issues.security.push({
          line: lineNum,
          message: 'User input used without apparent validation.',
          severity: 'medium',
          rule: 'missing-validation',
          suggestion: 'Validate input using Joi, Yup, Zod, or express-validator.',
        });
      }
    }
  });

  return issues;
}

async function analyzeCode(fileContent, fileName) {
  //   DLQ testing with structured error
  if (process.env.ALLOW_FORCE_FAIL === "true" && fileName === "force_fail.js") {
    throw new AnalysisError(ERROR_CODES.FORCED_FAILURE, "Forced failure for DLQ testing");
  }

  const startTime = Date.now();

  try {
    // ============================================
    // STAGE 0: Detect Language
    // ============================================
    const language = detectLanguage(fileName, fileContent);
    console.log(`🔍 Detected language: ${language}`);

    // ============================================
    // STAGE 1a: Pattern-based Analysis
    // ============================================
    const patternIssues = detectPatternIssues(fileContent, fileName);

    // ============================================
    // STAGE 1b: Language-Specific Detection
    // ============================================
    let langIssues = [];
    if (language === 'java') {
      langIssues = detectJavaIssues(fileContent, fileName);
      console.log(`☕ Java analysis: ${langIssues.length} issues found`);
    } else if (language === 'python') {
      langIssues = detectPythonIssues(fileContent, fileName);
      console.log(`🐍 Python analysis: ${langIssues.length} issues found`);
    }
    
    // Merge language-specific issues
    langIssues.forEach(issue => {
      if (issue.category === 'security') {
        patternIssues.security.push(issue);
      } else if (issue.category === 'performance') {
        patternIssues.performance.push(issue);
      } else if (issue.category === 'reliability') {
        patternIssues.security.push(issue); // Reliability issues are critical
      } else {
        patternIssues.style.push(issue);
      }
    });

    // ============================================
    // STAGE 1c: Async/Concurrency Bug Detection
    // ============================================
    const asyncIssues = detectAsyncIssues(fileContent, fileName);
    
    // Merge async issues into appropriate categories
    asyncIssues.forEach(issue => {
      if (issue.category === 'memory-leak' || issue.category === 'concurrency') {
        patternIssues.performance.push(issue);
      } else {
        patternIssues.security.push(issue);
      }
    });

    // ============================================
    // STAGE 1d: Semantic/Logic Bug Detection
    // ============================================
    const semanticIssues = detectSemanticIssues(fileContent, fileName);
    
    // Merge semantic issues into appropriate categories
    semanticIssues.forEach(issue => {
      if (issue.category === 'reliability' || issue.category === 'concurrency') {
        patternIssues.security.push(issue); // Critical logic bugs go to security
      } else if (issue.category === 'memory-leak' || issue.category === 'observability' || issue.category === 'testability') {
        patternIssues.performance.push(issue);
      } else {
        patternIssues.style.push(issue);
      }
    });

    // ============================================
    // STAGE 1e: Auth-Specific Bug Detection
    // Catches: promise liveness, refresh races, thundering herd
    // ============================================
    const authIssues = detectAuthIssues(fileContent, fileName);
    
    // Auth issues are critical - all go to security
    authIssues.forEach(issue => {
      patternIssues.security.push(issue);
    });
    console.log(`🔐 Auth analysis: ${authIssues.length} issues found`);

    // ============================================
    // STAGE 1f: Static Analysis (ESLint) - JavaScript/TypeScript only
    // ============================================
    const issues = {
      security: [...patternIssues.security],
      performance: [...patternIssues.performance],
      style: [...patternIssues.style],
    };

    if (language === 'javascript' || language === 'typescript') {
      const eslint = new ESLint({
        overrideConfigFile: true,
        overrideConfig: [
          {
            files: ['**/*.js', '**/*.jsx'],
            languageOptions: {
              ecmaVersion: 2021,
              sourceType: 'module',
              globals: {
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
    }

    console.log(`  Static analysis complete: ${issues.security.length} security, ${issues.performance.length} performance, ${issues.style.length} style issues`);

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
    // Calculate Quality Score
    // ============================================
    const calculateQualityScore = () => {
      // Start with 100 points
      let score = 100;
      
      // Deduct points for issues (weighted by severity)
      // Security issues are most severe
      score -= issues.security.filter(i => i.severity === 'critical').length * 15;
      score -= issues.security.filter(i => i.severity === 'high').length * 10;
      score -= issues.security.filter(i => i.severity === 'medium').length * 5;
      score -= issues.security.filter(i => i.severity === 'low').length * 2;
      
      // Performance issues
      score -= issues.performance.filter(i => i.severity === 'critical').length * 10;
      score -= issues.performance.filter(i => i.severity === 'high').length * 7;
      score -= issues.performance.filter(i => i.severity === 'medium').length * 4;
      score -= issues.performance.filter(i => i.severity === 'low').length * 1;
      
      // Style issues (minor deductions)
      score -= issues.style.length * 0.5;
      
      // AI suggestions
      score -= aiSuggestions.filter(s => s.severity === 'critical').length * 8;
      score -= aiSuggestions.filter(s => s.severity === 'high').length * 5;
      score -= aiSuggestions.filter(s => s.severity === 'medium').length * 3;
      score -= aiSuggestions.filter(s => s.severity === 'low').length * 1;
      
      // Ensure score is between 0 and 100
      score = Math.max(0, Math.min(100, score));
      
      // Convert to letter grade
      if (score >= 90) return 'A';
      if (score >= 80) return 'B';
      if (score >= 70) return 'C';
      if (score >= 60) return 'D';
      return 'F';
    };

    const qualityScore = calculateQualityScore();

    // ============================================
    // Return Combined Results
    // ============================================

    return {
      fileName,
      security: issues.security,
      performance: issues.performance,
      style: issues.style,
      aiSuggestions,
      qualityScore,
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
    //   Structured error handling with context
    const analysisError = new AnalysisError(
      error.code || ERROR_CODES.ESLINT_FAILED,
      `Analysis failed for ${fileName}: ${error.message}`,
      error
    );
    
    console.error('  Analysis error:', {
      code: analysisError.code,
      fileName,
      message: error.message,
      stack: error.stack?.split('\n').slice(0, 3).join('\n'),
    });
    
    throw analysisError;
  }
}

module.exports = { analyzeCode, AnalysisError, ERROR_CODES };
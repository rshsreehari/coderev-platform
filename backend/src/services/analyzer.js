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

  // ✅ Track loop depth properly to avoid false positives
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
    // STAGE 1b: Async/Concurrency Bug Detection
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
    // STAGE 1c: Semantic/Logic Bug Detection
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
    // STAGE 1d: Static Analysis (ESLint)
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
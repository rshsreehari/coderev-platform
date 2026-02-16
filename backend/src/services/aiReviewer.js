// Backend AI Reviewer Service using API keys
const https = require('https');

// ==============================================
// CONFIGURATION - Configurable AI Provider
// ==============================================
const AI_PROVIDERS = {
  openai: {
    hostname: 'api.openai.com',
    path: '/v1/chat/completions',
    defaultModel: 'gpt-4-turbo-preview',
  },
  mistral: {
    hostname: 'api.mistral.ai',
    path: '/v1/chat/completions',
    defaultModel: 'mistral-large-latest',
  },
  anthropic: {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    defaultModel: 'claude-3-5-sonnet-20241022',
  },
  gemini: {
    hostname: 'generativelanguage.googleapis.com',
    path: '/v1beta/models/{model}:generateContent',
    defaultModel: 'gemini-2.0-flash',
  },
};

// Get provider config from environment
const AI_PROVIDER = process.env.AI_PROVIDER || 'openai';
const AI_MODEL = process.env.AI_MODEL || AI_PROVIDERS[AI_PROVIDER]?.defaultModel || 'gpt-4-turbo-preview';
const REQUEST_TIMEOUT_MS = parseInt(process.env.AI_REQUEST_TIMEOUT_MS || '30000', 10);

// ==============================================
// API KEY VALIDATION (Secure - No Fallback)
// ==============================================
function validateApiKey() {
  if (!process.env.AI_API_KEY) {
    console.warn('⚠️ AI_API_KEY not set - AI reviews will be disabled');
    return false;
  }
  if (process.env.AI_API_KEY.length < 20) {
    console.warn('⚠️ AI_API_KEY appears invalid (too short) - AI reviews will be disabled');
    return false;
  }
  // Log masked key for debugging (never full key)
  const maskedKey = process.env.AI_API_KEY.substring(0, 7) + '...' + process.env.AI_API_KEY.slice(-4);
  console.log(`✅ AI API key validated: ${maskedKey}`);
  return true;
}

const IS_AI_KEY_VALID = validateApiKey();

// ==============================================
// JSON SCHEMA VALIDATION for AI Responses
// ==============================================
const SUGGESTION_SCHEMA = {
  requiredFields: ['line', 'severity', 'category', 'issue', 'explanation', 'suggestion'],
  validSeverities: ['critical', 'high', 'medium', 'low'],
  validCategories: ['security', 'performance', 'logic', 'style', 'reliability'],
};

function validateSuggestion(suggestion) {
  // Check required fields exist
  for (const field of SUGGESTION_SCHEMA.requiredFields) {
    if (!(field in suggestion)) {
      return { valid: false, error: `Missing required field: ${field}` };
    }
  }
  // Validate types
  if (typeof suggestion.line !== 'number' || suggestion.line < 1) {
    return { valid: false, error: 'line must be a positive number' };
  }
  if (!SUGGESTION_SCHEMA.validSeverities.includes(suggestion.severity)) {
    return { valid: false, error: `Invalid severity: ${suggestion.severity}` };
  }
  if (!SUGGESTION_SCHEMA.validCategories.includes(suggestion.category)) {
    return { valid: false, error: `Invalid category: ${suggestion.category}` };
  }
  if (typeof suggestion.issue !== 'string' || suggestion.issue.length === 0) {
    return { valid: false, error: 'issue must be a non-empty string' };
  }
  return { valid: true };
}

function validateAIResponse(response) {
  if (!response || typeof response !== 'object') {
    return { valid: false, suggestions: [], errors: ['Response is not an object'] };
  }
  if (!Array.isArray(response.suggestions)) {
    return { valid: false, suggestions: [], errors: ['suggestions is not an array'] };
  }

  const validSuggestions = [];
  const errors = [];

  for (let i = 0; i < response.suggestions.length; i++) {
    const validation = validateSuggestion(response.suggestions[i]);
    if (validation.valid) {
      validSuggestions.push(response.suggestions[i]);
    } else {
      errors.push(`Suggestion[${i}]: ${validation.error}`);
    }
  }

  return {
    valid: errors.length === 0,
    suggestions: validSuggestions,
    errors,
  };
}

// System prompt that defines AI's role
const SYSTEM_PROMPT = `You are a Senior Security Researcher and Performance Engineer. 
Your task is to perform a DEEP audit of the provided code.

CRITICAL PRIORITIES:
1. SECURITY: Identify SQL Injection, XSS, CSRF, IDOR, ReDoS, and Insecure Cryptography.
2. PERFORMANCE: Identify blocking I/O in the event loop, memory leaks, and O(n^2) operations.
3. RELIABILITY: Identify unhandled promise rejections and race conditions.

STRICT RULES:
- Report EVERY valid issue, even if it might be caught by static tools.
- Do NOT defer to static analysis; your goal is to be more thorough.
- Ignore minor style issues like 'console.log' unless they leak sensitive data.
- Provide a clear 'explanation' of the exploit or bottleneck.
- Ensure 'suggestion' is a concrete code fix.

RESPONSE FORMAT - Return ONLY valid JSON:
{
  "suggestions": [
    {
      "line": <number>,
      "severity": "critical" | "high" | "medium" | "low",
      "category": "security" | "performance" | "logic",
      "issue": "Title",
      "explanation": "Depth description",
      "suggestion": "Code fix"
    }
  ]
}

RULES:
1. Only report real issues, not opinions
2. Provide specific line numbers
3. Explain WHY it's a problem
4. Suggest concrete fixes
5. Do not include markdown or text outside JSON`;

// Few-shot examples teach the AI
const EXAMPLES = [
  {
    role: 'user',
    content: `Review this code:
    
    app.post('/check', (req, res) => {
      const regex = /^([a-zA-Z0-9])(([\-.]|[_]+)?([a-zA-Z0-9]+))*(@){1}$/;
      regex.test(req.body.input);
      let data = [];
      globalCache.push(req.body.data);
      res.send("ok");
    });`
  },
  {
    role: 'assistant',
    content: JSON.stringify({
      suggestions: [
        {
          line: 2,
          severity: 'high',
          category: 'performance',
          issue: 'Regular Expression Denial of Service (ReDoS)',
          explanation: 'The regex contains nested quantifiers that cause catastrophic backtracking on specific inputs, hanging the Node.js event loop.',
          suggestion: 'Use a simplified regex or a library like "validator.js" that avoids complex backtracking.'
        },
        {
          line: 5,
          severity: 'medium',
          category: 'performance',
          issue: 'Potential Memory Leak',
          explanation: 'Pushing request data into a global array (globalCache) without a cleanup mechanism will eventually exhaust server memory.',
          suggestion: 'Use a capped buffer, a database, or a TTL-based cache like Redis.'
        }
      ]
    })
  }
];

function getFileLanguage(fileName) {
  const ext = fileName.split('.').pop().toLowerCase();
  const langMap = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    java: 'java',
    go: 'go',
    rb: 'ruby',
    php: 'php',
    cpp: 'c++',
    c: 'c',
  };
  return langMap[ext] || 'text';
}

// ==============================================
// ERROR HANDLING - Structured Error Codes
// ==============================================
const ERROR_CODES = {
  API_KEY_MISSING: 'API_KEY_MISSING',
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
  NETWORK_ERROR: 'NETWORK_ERROR',
  PARSE_ERROR: 'PARSE_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RATE_LIMIT: 'RATE_LIMIT',
  API_ERROR: 'API_ERROR',
};

class AIReviewError extends Error {
  constructor(code, message, originalError = null) {
    super(message);
    this.name = 'AIReviewError';
    this.code = code;
    this.originalError = originalError;
  }
}

// ==============================================
// API REQUEST - With Timeout & Secure Headers
// ==============================================
function makeAIRequest(payload) {
  return new Promise((resolve, reject) => {
    // Get provider config
    const provider = AI_PROVIDERS[AI_PROVIDER] || AI_PROVIDERS.openai;

    // Build path - Gemini requires model in URL
    let requestPath = provider.path;
    if (AI_PROVIDER === 'gemini') {
      requestPath = provider.path.replace('{model}', AI_MODEL) + `?key=${process.env.AI_API_KEY}`;
    }

    const options = {
      hostname: provider.hostname,
      port: 443,
      path: requestPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    };

    // Add Authorization header for non-Gemini providers (Gemini uses query param)
    if (AI_PROVIDER !== 'gemini') {
      options.headers['Authorization'] = `Bearer ${process.env.AI_API_KEY}`;
    }
    
    // Anthropic requires special headers
    if (AI_PROVIDER === 'anthropic') {
      options.headers['x-api-key'] = process.env.AI_API_KEY;
      options.headers['anthropic-version'] = '2023-06-01';
      delete options.headers['Authorization'];
    }

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const response = JSON.parse(data);
            resolve(response);
          } catch (error) {
            reject(new AIReviewError(
              ERROR_CODES.PARSE_ERROR,
              `Failed to parse API response: ${error.message}`,
              error
            ));
          }
        } else if (res.statusCode === 429) {
          reject(new AIReviewError(
            ERROR_CODES.RATE_LIMIT,
            'Rate limit exceeded. Try again later.'
          ));
        } else {
          reject(new AIReviewError(
            ERROR_CODES.API_ERROR,
            `API Error ${res.statusCode}: ${data.substring(0, 200)}`
          ));
        }
      });
    });

    // ✅ REQUEST TIMEOUT - Prevents hanging connections
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      reject(new AIReviewError(
        ERROR_CODES.REQUEST_TIMEOUT,
        `Request timeout after ${REQUEST_TIMEOUT_MS / 1000} seconds`
      ));
    });

    req.on('error', (error) => {
      reject(new AIReviewError(
        ERROR_CODES.NETWORK_ERROR,
        `Network error: ${error.message}`,
        error
      ));
    });

    req.write(JSON.stringify(payload));
    req.end();
  });
}

async function reviewCodeWithAI(fileName, fileContent, staticIssues = []) {
  // ✅ Check if API key is valid before making request
  if (!IS_AI_KEY_VALID) {
    console.log('⏭️ AI review skipped (API key not configured)');
    return [];
  }

  // ✅ Build prompt using array.join() for efficiency (not string +=)
  const language = getFileLanguage(fileName);
  const lineCount = fileContent.split('\n').length;

  const promptParts = [
    `Review this ${language} code.\n\n`,
    `FILE: ${fileName}\n`,
    `LINES: ${lineCount}\n\n`,
    `CODE:\n\`\`\`${language}\n${fileContent}\n\`\`\``,
  ];
  const prompt = promptParts.join('');

  try {
    let payload;
    
    // Build provider-specific payload
    if (AI_PROVIDER === 'gemini') {
      // Gemini API format
      payload = {
        contents: [
          {
            parts: [
              { text: SYSTEM_PROMPT + '\n\n' + prompt }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 2000,
          responseMimeType: 'application/json',
        },
      };
    } else if (AI_PROVIDER === 'anthropic') {
      // Anthropic/Claude format
      payload = {
        model: AI_MODEL,
        system: SYSTEM_PROMPT,
        messages: [
          ...EXAMPLES,
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 2000,
      };
    } else {
      // OpenAI/Mistral format
      payload = {
        model: AI_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...EXAMPLES,
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
      };
    }

    console.log(`🤖 Calling ${AI_PROVIDER} API (model: ${AI_MODEL})...`);
    const response = await makeAIRequest(payload);

    // Parse response based on provider
    let aiContent;
    if (AI_PROVIDER === 'gemini') {
      // Gemini response format
      if (response.candidates && response.candidates[0] && response.candidates[0].content) {
        aiContent = response.candidates[0].content.parts[0].text;
      }
    } else if (AI_PROVIDER === 'anthropic') {
      // Anthropic response format
      if (response.content && response.content[0]) {
        aiContent = response.content[0].text;
      }
    } else {
      // OpenAI/Mistral response format
      if (response.choices && response.choices[0] && response.choices[0].message) {
        aiContent = response.choices[0].message.content;
      }
    }

    if (aiContent) {
      // ✅ Parse and validate AI response
      let parsed;
      try {
        // Clean response - remove markdown code blocks if present
        let cleanContent = aiContent.trim();
        if (cleanContent.startsWith('```json')) {
          cleanContent = cleanContent.slice(7);
        }
        if (cleanContent.startsWith('```')) {
          cleanContent = cleanContent.slice(3);
        }
        if (cleanContent.endsWith('```')) {
          cleanContent = cleanContent.slice(0, -3);
        }
        parsed = JSON.parse(cleanContent.trim());
      } catch (parseError) {
        console.error('❌ Failed to parse AI response JSON:', parseError.message);
        return [];
      }

      // ✅ Validate response schema
      const validation = validateAIResponse(parsed);
      if (!validation.valid) {
        console.warn('⚠️ Some AI suggestions were invalid:', validation.errors);
      }

      console.log(`✅ AI returned ${validation.suggestions.length} valid suggestions`);
      return validation.suggestions;
    } else {
      console.error('❌ Unexpected API response format');
      return [];
    }
  } catch (error) {
    // ✅ Structured error logging with context
    console.error('❌ AI review failed:', {
      code: error.code || 'UNKNOWN',
      message: error.message,
      fileName,
      provider: AI_PROVIDER,
      model: AI_MODEL,
    });
    return []; // Graceful failure - return empty suggestions
  }
}

module.exports = { reviewCodeWithAI, ERROR_CODES, AIReviewError };

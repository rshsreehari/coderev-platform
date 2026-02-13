const path = require('path');
const { ESLint } = require('eslint');

async function analyzeCode(fileName, fileContent) {
  const startTime = Date.now();

  const eslint = new ESLint({
    overrideConfigFile: path.join(__dirname, "../../eslint.config.js"),
  });


  const results = await eslint.lintText(fileContent, { filePath: fileName });

  const issues = {
    security: [],
    performance: [],
    style: [],
  };

  const securityRules = ['no-eval', 'no-implied-eval', 'no-new-func'];
  const performanceRules = ['no-await-in-loop', 'no-inner-declarations'];

  results[0].messages.forEach((msg) => {
    const issue = {
      line: msg.line,
      column: msg.column,
      message: msg.message,
      severity: msg.severity === 2 ? 'high' : msg.severity === 1 ? 'medium' : 'low',
      rule: msg.ruleId,
      file: fileName,
    };

    if (securityRules.includes(msg.ruleId)) {
      issues.security.push(issue);
    } else if (performanceRules.includes(msg.ruleId)) {
      issues.performance.push(issue);
    } else {
      issues.style.push(issue);
    }
  });

  const processingTime = Date.now() - startTime;

  return {
    security: issues.security,
    performance: issues.performance,
    aiSuggestions: [], // We'll add AI later
    metrics: {
      reviewTime: `${(processingTime / 1000).toFixed(1)}s`,
      cacheHit: false,
      linesAnalyzed: fileContent.split('\n').length,
      issuesFound: results[0].messages.length,
      processingTimeMs: processingTime,
    },
  };
}

module.exports = { analyzeCode };
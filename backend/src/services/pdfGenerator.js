// PDF Generator Service
const fs = require('fs');
const path = require('path');

// Using a lightweight approach without pdfkit dependency
// This generates a simple but professional text-based report that can be easily extended

async function generateReviewPDF(reviewData, outputPath) {
  return new Promise((resolve, reject) => {
    try {
      // Create a formatted text report that will be saved as a simple document
      let content = '';

      // Header
      content += '═══════════════════════════════════════════════════════════\n';
      content += '                    CODE REVIEW REPORT                      \n';
      content += '═══════════════════════════════════════════════════════════\n\n';

      // File info
      content += `FILE: ${reviewData.fileName}\n`;
      content += `LINES ANALYZED: ${reviewData.metrics.linesAnalyzed}\n`;
      content += `REVIEW TIME: ${reviewData.metrics.reviewTime}\n`;
      if (reviewData.metrics.originalReviewTime) {
        content += `ORIGINAL ANALYSIS TIME: ${reviewData.metrics.originalReviewTime}\n`;
        content += `CACHE STATUS: ✓ Cache Hit (served instantly)\n`;
      }
      content += `TOTAL ISSUES FOUND: ${reviewData.metrics.issuesFound}\n`;
      content += `PROCESSING TIME: ${reviewData.metrics.processingTimeMs}ms\n`;
      content += `GENERATED AT: ${new Date().toISOString()}\n\n`;

      // Security Issues
      if (reviewData.security && reviewData.security.length > 0) {
        content += '───────────────────────────────────────────────────────────\n';
        content += '🔴 SECURITY ISSUES (Critical)\n';
        content += '───────────────────────────────────────────────────────────\n\n';

        reviewData.security.forEach((issue, index) => {
          content += `${index + 1}. Line ${issue.line}: ${issue.message}\n`;
          content += `   Severity: ${issue.severity}\n`;
          content += `   Rule: ${issue.rule || 'N/A'}\n`;
          content += `   Suggestion: ${issue.suggestion || 'Follow best practices to fix this issue'}\n\n`;
        });
      }

      // Performance Issues
      if (reviewData.performance && reviewData.performance.length > 0) {
        content += '───────────────────────────────────────────────────────────\n';
        content += '⚡ PERFORMANCE ISSUES\n';
        content += '───────────────────────────────────────────────────────────\n\n';

        reviewData.performance.forEach((issue, index) => {
          content += `${index + 1}. Line ${issue.line}: ${issue.message}\n`;
          content += `   Severity: ${issue.severity}\n`;
          content += `   Rule: ${issue.rule || 'N/A'}\n`;
          content += `   Suggestion: ${issue.suggestion || 'Optimize this section'}\n\n`;
        });
      }

      // Style Issues
      if (reviewData.style && reviewData.style.length > 0) {
        content += '───────────────────────────────────────────────────────────\n';
        content += '📝 STYLE ISSUES\n';
        content += '───────────────────────────────────────────────────────────\n\n';

        reviewData.style.forEach((issue, index) => {
          content += `${index + 1}. Line ${issue.line}: ${issue.message}\n`;
          content += `   Rule: ${issue.rule || 'N/A'}\n`;
          content += `   Suggestion: ${issue.suggestion || 'Follow coding standards'}\n\n`;
        });
      }

      // AI Suggestions
      if (reviewData.aiSuggestions && reviewData.aiSuggestions.length > 0) {
        content += '───────────────────────────────────────────────────────────\n';
        content += '🤖 AI SUGGESTIONS\n';
        content += '───────────────────────────────────────────────────────────\n\n';

        reviewData.aiSuggestions.forEach((suggestion, index) => {
          content += `${index + 1}. Line ${suggestion.line} - ${suggestion.issue}\n`;
          content += `   Category: ${suggestion.category}\n`;
          content += `   Severity: ${suggestion.severity.toUpperCase()}\n`;
          content += `   Explanation: ${suggestion.explanation}\n`;
          content += `   Suggestion: ${suggestion.suggestion}\n\n`;
        });
      }

      // Summary
      content += '───────────────────────────────────────────────────────────\n';
      content += 'SUMMARY\n';
      content += '───────────────────────────────────────────────────────────\n\n';
      content += `Security Issues: ${reviewData.security?.length || 0}\n`;
      content += `Performance Issues: ${reviewData.performance?.length || 0}\n`;
      content += `Style Issues: ${reviewData.style?.length || 0}\n`;
      content += `AI Suggestions: ${reviewData.aiSuggestions?.length || 0}\n`;
      content += `Total Issues: ${reviewData.metrics.issuesFound}\n\n`;

      // Footer
      content += '═══════════════════════════════════════════════════════════\n';
      content += `Generated on ${new Date().toLocaleString()}\n`;
      content += 'Code Review Platform\n';
      content += '═══════════════════════════════════════════════════════════\n';

      // Ensure directory exists
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Write to file
      fs.writeFileSync(outputPath, content, 'utf8');
      resolve(outputPath);
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = { generateReviewPDF };

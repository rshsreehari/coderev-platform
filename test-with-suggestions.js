#!/usr/bin/env node

const http = require('http');
const fs = require('fs');

const badCode = `// bad_all.js

// STYLE: unused variable, missing semicolons, == instead of ===, console.log, weird spacing
const unused = 123
let x = "42"
if (x == 42) console.log("loose compare!")   // style + potential bug

// SECURITY: eval + building code from user-controlled input
function runUserCode(userInput) {
  return eval(userInput) // security: code injection
}

// SECURITY: command injection style pattern (even if not executed, should be flagged by simple scanner)
const { exec } = require("child_process")
function runShell(cmd) {
  exec("ls " + cmd) // security: command injection pattern
}

// PERFORMANCE: O(n^2) nested loops + expensive string concatenation in loop
function slow(n) {
  let s = ""
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      s = s + i + "," + j + ";" // perf: repeated concat in loops
    }
  }
  return s
}

// PERFORMANCE: regex in a hot loop
function slowRegex(arr) {
  let count = 0
  for (let i = 0; i < arr.length; i++) {
    if (/^a+b+$/.test(arr[i])) count++
  }
  return count
}

module.exports = { runUserCode, runShell, slow, slowRegex }`;

const API_URL = 'http://localhost:3000';

function makeRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Invalid JSON: ${data}`));
        }
      });
    });
    
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function test() {
  console.log('🧪 TESTING CODE REVIEW WITH DETAILED SUGGESTIONS\n');
  
  try {
    // Submit
    console.log('📤 Submitting bad_all.js for review...');
    const { jobId } = await makeRequest('POST', '/api/reviews/submit', {
      fileName: 'bad_all.js',
      fileContent: badCode,
    });
    console.log(`✅ Job ID: ${jobId}\n`);
    
    // Poll for completion
    console.log('⏳ Waiting for analysis...');
    let completed = false;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const status = await makeRequest('GET', `/api/reviews/status/${jobId}`);
      
      if (status.status === 'complete') {
        completed = true;
        const result = status.result;
        
        console.log('\n✅ ANALYSIS COMPLETE!\n');
        console.log('═'.repeat(75));
        console.log('DETAILED CODE REVIEW REPORT');
        console.log('═'.repeat(75));
        
        // Security Issues
        console.log(`\n🔴 SECURITY ISSUES (${result.security.length} found):\n`);
        if (result.security.length === 0) {
          console.log('  None found');
        } else {
          result.security.forEach((issue, idx) => {
            console.log(`  ${idx + 1}. Line ${issue.line}: ${issue.message}`);
            console.log(`     Rule: ${issue.rule}`);
            console.log(`     ✅ FIX: ${issue.suggestion}\n`);
          });
        }
        
        // Performance Issues
        console.log(`⚡ PERFORMANCE ISSUES (${result.performance.length} found):\n`);
        if (result.performance.length === 0) {
          console.log('  None found');
        } else {
          result.performance.forEach((issue, idx) => {
            console.log(`  ${idx + 1}. Line ${issue.line}: ${issue.message}`);
            console.log(`     Rule: ${issue.rule}`);
            console.log(`     ✅ FIX: ${issue.suggestion}\n`);
          });
        }
        
        // Style Issues
        console.log(`📝 STYLE ISSUES (${result.style.length} found):\n`);
        if (result.style.length === 0) {
          console.log('  None found');
        } else {
          result.style.forEach((issue, idx) => {
            console.log(`  ${idx + 1}. Line ${issue.line}: ${issue.message}`);
            console.log(`     Rule: ${issue.rule}`);
            console.log(`     ✅ FIX: ${issue.suggestion}\n`);
          });
        }
        
        // Summary
        console.log('═'.repeat(75));
        console.log(`📊 SUMMARY`);
        console.log('═'.repeat(75));
        console.log(`Total Issues Found: ${result.metrics.issuesFound}`);
        console.log(`  - Security: ${result.security.length}`);
        console.log(`  - Performance: ${result.performance.length}`);
        console.log(`  - Style: ${result.style.length}`);
        console.log(`  - AI Suggestions: ${result.aiSuggestions.length}`);
        console.log(`Processing Time: ${result.metrics.processingTimeMs}ms`);
        console.log(`Lines Analyzed: ${result.metrics.linesAnalyzed}`);
        console.log('═'.repeat(75) + '\n');
        
        // Test download
        console.log('📥 Testing download feature...');
        console.log(`   Visit: http://localhost:3000/api/reviews/download/${jobId}`);
        console.log(`   (This will download the full report as a text file)\n`);
        
        return;
      }
    }
    
    if (!completed) {
      console.log('❌ Timeout waiting for results');
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

test();

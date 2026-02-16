#!/usr/bin/env node

// Quick test script to verify the API flow
const http = require('http');
const fs = require('fs');

const testCode = `
// Sample code with a security issue
function getUserData(userId) {
  const query = "SELECT * FROM users WHERE id = " + userId;
  console.log("Executing:", query);
  return query;
}

// Sample performance issue
async function processItems() {
  for (let item of items) {
    await fetch('api/item/' + item.id);
  }
}
`;

const API_URL = 'http://localhost:3000';

async function testFlow() {
  console.log('🧪 Testing Code Review API Flow\n');
  
  try {
    // Step 1: Submit review
    console.log('1️⃣ Submitting review...');
    const submitRes = await makeRequest('POST', '/api/reviews/submit', {
      fileName: 'test.js',
      fileContent: testCode,
    });
    
    const { jobId, status: submitStatus, cacheHit } = submitRes;
    console.log(`   ✅ Submitted - JobID: ${jobId}`);
    console.log(`   Status: ${submitStatus}, Cache Hit: ${cacheHit}\n`);
    
    // Step 2: Poll for completion
    console.log('2️⃣ Polling for completion...');
    let attempts = 0;
    let jobResult;
    
    while (attempts < 20) {
      await sleep(500);
      attempts++;
      
      const statusRes = await makeRequest('GET', `/api/reviews/status/${jobId}`);
      console.log(`   Attempt ${attempts}: Status = ${statusRes.status}`);
      
      if (statusRes.status === 'complete') {
        jobResult = statusRes;
        break;
      }
    }
    
    if (!jobResult) {
      console.error('❌ Job did not complete within timeout');
      return;
    }
    
    console.log(`\n✅ Job completed!\n`);
    console.log('Result structure:');
    console.log(JSON.stringify(jobResult, null, 2));
    
    // Verify result structure
    const result = jobResult.result;
    if (result) {
      console.log('\n📊 Analysis Results:');
      console.log(`   Security Issues: ${result.security?.length || 0}`);
      console.log(`   Performance Issues: ${result.performance?.length || 0}`);
      console.log(`   Style Issues: ${result.style?.length || 0}`);
      console.log(`   AI Suggestions: ${result.aiSuggestions?.length || 0}`);
      console.log(`   Processing Time: ${result.metrics?.processingTimeMs}ms`);
    }
    
  } catch (error) {
    console.error(' Error:', error.message);
    console.error(error);
  }
}

function makeRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
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
          reject(new Error(`Invalid JSON response: ${data}`));
        }
      });
    });
    
    req.on('error', reject);
    
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

testFlow().catch(console.error);

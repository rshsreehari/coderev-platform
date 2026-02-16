/**
 * COMPREHENSIVE SECURITY & PERFORMANCE TEST FILE
 * ===============================================
 * 
 * This file contains ALL types of security and performance issues
 * that the Code Review Platform can detect.
 * 
 * Upload this file to test the full detection capabilities!
 */

const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');

const app = express();

// ========================================
// 🔴 INJECTION ATTACKS
// ========================================

// 1. Command Injection
function runCommand(userInput) {
    exec(`ls -la ${userInput}`);  // 🚨 User input in shell command
}

// 2. SQL Injection
async function getUser(userId) {
    const result = await db.query(`SELECT * FROM users WHERE id = '${userId}'`);  // 🚨 String concat in SQL
    return result;
}

// 3. XSS - innerHTML
function displayMessage(message) {
    document.getElementById('output').innerHTML = message;  // 🚨 Direct HTML injection
}

// 4. XSS - document.write
function showContent(content) {
    document.write(content);  // 🚨 document.write is dangerous
}

// 5. Code Injection - eval
function processData(data) {
    return eval(data);  // 🚨 Never use eval with user input
}

// 6. Prototype Pollution
function merge(target, source) {
    target["__proto__"] = source;  // 🚨 Prototype pollution
}

// 7. Path Traversal
function readUserFile(filename) {
    return fs.readFileSync(`/uploads/${filename}`);  // 🚨 User input in file path
}

// 8. ReDoS - Dynamic Regex
function validateInput(pattern, input) {
    const regex = new RegExp(pattern);  // 🚨 Dynamic regex with user input
    return regex.test(input);
}

// 9. Open Redirect
function redirect(req, res) {
    res.redirect(req.query.url);  // 🚨 User-controlled redirect
}

// ========================================
// 🔴 AUTHENTICATION & SECRETS
// ========================================

// 10. Hardcoded Secrets
const config = {
    password: "super_secret_password_123",  // 🚨 Hardcoded password
    apiKey: "sk_live_abcdefghijklmnop",
    secret: "my_jwt_secret_key_very_long",
};

// 11. Hardcoded JWT
const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";  // 🚨 Hardcoded JWT

// 12. Weak Cryptography
function hashPassword(password) {
    return crypto.createHash('md5').update(password).digest('hex');  // 🚨 MD5 is broken
}

// 13. Insecure Randomness
function generateToken() {
    return Math.random().toString(36);  // 🚨 Math.random() is not secure
}

// ========================================
// 🔴 DATA EXPOSURE
// ========================================

// 14. Logging Sensitive Data
function login(username, password) {
    console.log("Login attempt:", username, password);  // 🚨 Logging password
    return authenticate(username, password);
}

// 15. Stack Trace Exposure
app.use((err, req, res, next) => {
    res.json({ error: err.message, stack: err.stack });  // 🚨 Exposing stack to client
});

// ========================================
// 🔴 NETWORK SECURITY
// ========================================

// 16. SSRF Risk
async function fetchUrl(req) {
    const response = await fetch(req.body.url);  // 🚨 User input in outbound request
    return response.json();
}

// 17. Insecure CORS
app.use(cors({ origin: '*' }));  // 🚨 Allowing all origins

// 18. HTTP instead of HTTPS
const apiUrl = "http://api.example.com/data";  // 🚨 Using HTTP

// ========================================
// ⚡ PERFORMANCE ISSUES
// ========================================

// 19. N+1 Query
async function getUsersWithPosts() {
    const users = await User.find();
    for (const user of users) {
        user.posts = await Post.find({ userId: user.id });  // 🚨 DB call in loop
    }
    return users;
}

// 20. Synchronous File Operations
function loadConfig() {
    return JSON.parse(fs.readFileSync('./config.json'));  // 🚨 Sync file op blocks event loop
}

// 21. String Concatenation in Loop
function buildReport(items) {
    let report = "";
    for (const item of items) {
        report += `Item: ${item.name}\n`;  // 🚨 O(n²) string concat
    }
    return report;
}

// 22. Sequential Independent Requests
async function fetchData() {
    const users = await fetch('/api/users');
    const posts = await fetch('/api/posts');  // 🚨 Should use Promise.all()
    return { users, posts };
}

// 23. No Request Timeout
async function fetchExternal(url) {
    const response = await fetch(url);  // 🚨 No timeout
    return response.json();
}

// 24. Missing Pagination
async function getAllUsers() {
    return await User.find({});  // 🚨 No limit - could load millions
}

// 25. Deep Clone via JSON
function cloneObject(obj) {
    return JSON.parse(JSON.stringify(obj));  // 🚨 Slow, loses functions/dates
}

// 26. moment.js usage
const moment = require('moment');  // 🚨 300KB+ bundle size

// 27. Full lodash import
const _ = require('lodash');  // 🚨 Should import specific functions

// ========================================
// 🔄 ASYNC/CONCURRENCY ISSUES
// ========================================

// 28. Race Condition
function createSearch() {
    let timeoutId = null;
    return function search(query) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(async () => {
            const response = await fetch(`/api/search?q=${query}`);  // 🚨 No AbortController
            displayResults(response);
        }, 300);
    };
}

// 29. Memory Leak - setInterval
function startPolling() {
    setInterval(async () => {  // 🚨 No clearInterval
        const data = await fetch('/api/status');
        updateUI(data);
    }, 5000);
}

// 30. Memory Leak - Event Listener
function setupListeners() {
    document.addEventListener('click', handleClick);  // 🚨 No removeEventListener
}

// 31. Stale Closure
function createCounter() {
    let count = 0;  // 🚨 Mutable variable in closure
    return {
        increment: () => { count++; },
        getDelayed: () => {
            setTimeout(() => console.log(count), 1000);  // Stale value
        }
    };
}

// 32. Empty Catch Block
async function dangerousOperation() {
    try {
        await riskyApiCall();
    } catch (e) {
        // 🚨 Silent failure - swallowing error
    }
}

// 33. Retry Without Backoff
async function fetchWithRetry(url, attempts = 3) {
    let attempt = 0;
    while (attempt < attempts) {
        try {
            return await fetch(url);
        } catch (e) {
            attempt++;
            await sleep(1000);  // 🚨 Fixed delay = hammering server
        }
    }
}

// 34. Infinite Loop Risk
async function processQueue() {
    while (true) {  // 🚨 No break condition visible
        const item = await getNextItem();
        await process(item);
    }
}

// 35. WebSocket without close
function connectWebSocket(url) {
    const ws = new WebSocket(url);  // 🚨 No close handler
    ws.onmessage = handleMessage;
}

// 36. Cache without TTL
const cache = new Map();  // 🚨 No expiration
function getCached(key, fetchFn) {
    if (cache.has(key)) return cache.get(key);
    const value = fetchFn();
    cache.set(key, value);
    return value;
}

// 37. No Debouncing on Input
function SearchInput() {
    return (
        <input 
            onChange={(e) => fetch(`/search?q=${e.target.value}`)}  // 🚨 Fires on every keystroke
        />
    );
}

// ========================================
// 📝 STYLE & BEST PRACTICES
// ========================================

// 38. Loose Equality
function compare(a, b) {
    return a == b;  // 🚨 Should use ===
}

// 39. Missing key prop
function UserList({ users }) {
    return users.map(user => <div>{user.name}</div>);  // 🚨 Missing key
}

// 40. Inline functions in render
function Button({ onClick }) {
    return <button onClick={() => onClick()}>Click</button>;  // 🚨 New function each render
}

// ========================================
// ✅ CORRECT PATTERNS (for comparison)
// ========================================

// Correct: Using parameterized queries
async function getUserSafe(userId) {
    return await db.query('SELECT * FROM users WHERE id = $1', [userId]);
}

// Correct: Using AbortController
function createSearchSafe() {
    let controller = new AbortController();
    return async function search(query) {
        controller.abort();
        controller = new AbortController();
        try {
            const response = await fetch(`/api/search?q=${query}`, {
                signal: controller.signal
            });
            displayResults(response);
        } catch (e) {
            if (e.name !== 'AbortError') throw e;
        }
    };
}

// Correct: Promise.all for parallel requests
async function fetchDataSafe() {
    const [users, posts] = await Promise.all([
        fetch('/api/users'),
        fetch('/api/posts')
    ]);
    return { users, posts };
}

// Correct: Exponential backoff
async function fetchWithRetrySafe(url, maxAttempts = 3) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            return await fetch(url);
        } catch (e) {
            const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
            await sleep(delay);
        }
    }
    throw new Error('Max retries exceeded');
}

// Helper stubs
function authenticate() {}
function displayResults() {}
function updateUI() {}
function handleClick() {}
function handleMessage() {}
function riskyApiCall() {}
function getNextItem() {}
function process() {}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const db = { query: async () => {} };
const User = { find: async () => [] };
const Post = { find: async () => [] };
function cors() { return (req, res, next) => next(); }

module.exports = app;

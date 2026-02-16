/**
 * TEST FILE: Advanced Async/Concurrency Bug Patterns
 * =================================================
 * 
 * This file contains common async bugs that cause production issues.
 * Upload this to the Code Review Platform to test async bug detection.
 * 
 * Expected detections:
 * - Race conditions
 * - Memory leaks
 * - Promise overwrites
 * - Stale closures
 * - Missing abort controllers
 * - Retry hammering
 * - State corruption
 */

// ========================================
// 1. RACE CONDITION: Promise Overwrite
// ========================================
function createSearch() {
    let timeoutId = null;
    let lastQuery = "";

    return function search(query) {
        if (query === lastQuery) return;
        lastQuery = query;
        clearTimeout(timeoutId);

        // 🚨 BUG: Each call overwrites timeoutId, but previous fetch may still complete
        // Results can arrive out of order!
        timeoutId = setTimeout(async () => {
            try {
                // 🚨 BUG: No AbortController - previous request continues!
                const response = await fetch(`https://api.example.com/search?q=${query}`);
                const data = await response.json();
                console.log("Results:", data);
            } catch (err) {
                // 🚨 BUG: Generic error - no context for debugging
                console.error("Search failed");
            }
        }, 500);
    };
}

// ========================================
// 2. MEMORY LEAK: setInterval without cleanup
// ========================================
function startPolling(userId) {
    // 🚨 BUG: No way to stop this interval - runs forever
    setInterval(async () => {
        const data = await fetch(`/api/user/${userId}/status`);
        updateUI(data);
    }, 5000);
}

// ========================================
// 3. MEMORY LEAK: Event listener without cleanup
// ========================================
function setupKeyListener(callback) {
    // 🚨 BUG: Event listener never removed - memory leak!
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            callback();
        }
    });
}

// ========================================
// 4. STALE CLOSURE: Mutable variable in async
// ========================================
function createCounter() {
    let count = 0;  // 🚨 BUG: Mutable variable captured by closure

    return {
        increment: () => { count++; },
        getCountDelayed: () => {
            // 🚨 BUG: By the time setTimeout runs, count may have changed
            setTimeout(() => {
                console.log("Count was:", count);  // Stale value!
            }, 1000);
        }
    };
}

// ========================================
// 5. STATE CORRUPTION: Shared mutable state
// ========================================
let sharedCache = {};  // 🚨 BUG: Shared mutable state

async function fetchUser(id) {
    if (sharedCache[id]) return sharedCache[id];
    
    // 🚨 BUG: Multiple concurrent calls = duplicate fetches + race
    const user = await fetch(`/api/users/${id}`).then(r => r.json());
    sharedCache[id] = user;  // Could overwrite different user's data!
    return user;
}

// ========================================
// 6. RETRY HAMMERING: No exponential backoff
// ========================================
async function fetchWithRetry(url, maxRetries = 5) {
    let attempt = 0;
    
    while (attempt < maxRetries) {
        try {
            const response = await fetch(url);
            if (response.ok) return response.json();
        } catch (err) {
            attempt++;
            // 🚨 BUG: Fixed delay = server hammering during outages
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    throw new Error("Max retries exceeded");
}

// ========================================
// 7. INFINITE LOOP RISK
// ========================================
async function processQueue() {
    // 🚨 BUG: while(true) without clear exit condition
    while (true) {
        const item = await getNextQueueItem();
        if (item) {
            await processItem(item);
        }
        // What if getNextQueueItem() always returns something?
    }
}

// ========================================
// 8. FLOATING PROMISE: Async without await
// ========================================
async function saveData(data) {
    await database.save(data);
    return { success: true };
}

function handleSubmit() {
    // 🚨 BUG: Floating promise - error won't be caught!
    saveData({ name: "test" });  // No await!
    console.log("Done");  // Runs before save completes
}

// ========================================
// 9. CACHE WITHOUT TTL
// ========================================
const userCache = new Map();  // 🚨 BUG: No TTL - stale data forever

async function getCachedUser(id) {
    if (userCache.has(id)) {
        return userCache.get(id);  // Could be weeks old!
    }
    const user = await fetch(`/api/users/${id}`).then(r => r.json());
    userCache.set(id, user);
    return user;
}

// ========================================
// 10. RECURSIVE TIMEOUT WITHOUT CLEANUP
// ========================================
function pollForUpdates() {
    // 🚨 BUG: Recursive setTimeout with no stop mechanism
    setTimeout(async () => {
        const updates = await fetch('/api/updates');
        displayUpdates(updates);
        pollForUpdates();  // Calls itself forever!
    }, 3000);
}

// ========================================
// CORRECT PATTERNS (For comparison)
// ========================================

// ✅ CORRECT: Search with AbortController
function createSearchCorrect() {
    let controller = new AbortController();

    return async function search(query) {
        // Cancel previous request
        controller.abort();
        controller = new AbortController();

        try {
            const response = await fetch(
                `https://api.example.com/search?q=${query}`,
                { signal: controller.signal }
            );
            const data = await response.json();
            return data;
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.error("Search failed:", err.message);
            }
        }
    };
}

// ✅ CORRECT: Interval with cleanup
function startPollingCorrect(userId) {
    const intervalId = setInterval(async () => {
        const data = await fetch(`/api/user/${userId}/status`);
        updateUI(data);
    }, 5000);

    // Return cleanup function
    return () => clearInterval(intervalId);
}

// ✅ CORRECT: Retry with exponential backoff
async function fetchWithRetryCorrect(url, maxRetries = 5) {
    let attempt = 0;
    const baseDelay = 1000;
    
    while (attempt < maxRetries) {
        try {
            const response = await fetch(url);
            if (response.ok) return response.json();
        } catch (err) {
            attempt++;
            // Exponential backoff with jitter
            const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw new Error("Max retries exceeded");
}

// Helper functions (stubs)
function updateUI() {}
function displayUpdates() {}
async function getNextQueueItem() { return null; }
async function processItem() {}
const database = { save: async () => {} };

module.exports = {
    createSearch,
    startPolling,
    setupKeyListener,
    createCounter,
    fetchUser,
    fetchWithRetry,
    processQueue,
    handleSubmit,
    getCachedUser,
    pollForUpdates,
    // Correct versions
    createSearchCorrect,
    startPollingCorrect,
    fetchWithRetryCorrect
};

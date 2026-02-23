# CORE - Code Review Platform

**CORE** (Code Optimization and Review Engine) is a production-grade, distributed code review system that combines static analysis, security scanning, and AI-powered suggestions to deliver fast, consistent, and meaningful feedback on submitted code.

This is not a toy project or a wrapper around an LLM. It is a fully deployed, end-to-end system ran on AWS with real infrastructure -- PostgreSQL on RDS, Redis on ElastiCache, job queues on SQS, and a Node.js backend managed by PM2. The frontend is a React single-page application served from the same Express server in production.

---

## Table of Contents

1. [What This Project Does](#what-this-project-does)
2. [How It Works - The Simple View](#how-it-works---the-simple-view)
3. [How It Works - The Architecture Underneath](#how-it-works---the-architecture-underneath)
4. [Tech Stack](#tech-stack)
5. [Project Structure](#project-structure)
6. [Database Schema](#database-schema)
7. [API Endpoints](#api-endpoints)
8. [Running Locally](#running-locally)
9. [Deploying to AWS](#deploying-to-aws)
10. [Configuration Reference](#configuration-reference)
11. [Architectural Decisions and Trade-offs](#architectural-decisions-and-trade-offs)

---

## What This Project Does

You paste a code file (or upload one), and the platform reviews it. Not just syntax checking -- it runs multiple layers of analysis:

- **Static analysis** using ESLint with language-appropriate rule sets
- **Security scanning** that checks for hardcoded secrets, SQL injection patterns, insecure crypto usage, and other known vulnerability patterns
- **Best practice checks** for naming conventions, function complexity, error handling, and code organization
- **AI-powered suggestions** using Google Gemini that provide contextual feedback beyond what rule-based systems can catch

The results come back as a structured report with severity levels (critical, warning, info), specific line references, and actionable suggestions. Each issue is categorized so you know what must be fixed versus what is a style preference.

---

## How It Works - The Simple View

1. You open the web interface and paste your code (or upload a file).
2. You click Submit.
3. The platform queues your request, processes it in the background, and the UI polls until results are ready.
4. You see a detailed review with issues categorized by severity.

The entire round-trip typically takes under 2 seconds for cached results and 3-8 seconds for new analysis.

---

## How It Works - The Architecture Underneath

Here is what actually happens when you hit Submit:

### Step 1: Request Arrives

The Express API server receives the code submission at `POST /api/reviews/submit`. The controller generates a SHA-256 hash of the code content. This hash is the foundation of the caching layer.

### Step 2: Cache Check

Before doing any work, the system checks Redis for this hash. If someone has already submitted identical code, the cached result is returned immediately. No queue, no processing, no AI call. The response includes a `cache_hit: true` flag so the frontend knows this was instant.

Why this matters: In real-world usage -- CI/CD pipelines running on every commit, multiple developers reviewing the same shared utility files, PR review cycles where the same file is submitted multiple times -- cache hit rates of 60-70% are realistic. That means the majority of requests skip the entire processing pipeline.

### Step 3: Job Queuing

If there is no cache hit, a job record is created in PostgreSQL with status `queued`, and the job payload is sent to an AWS SQS queue. The API immediately returns a job ID to the client. The response is fast because no analysis has happened yet -- the work has been deferred.

SQS was chosen over an in-memory queue (like Bull/Redis-based queues) because it survives server restarts, provides built-in retry with exponential backoff, and has a native dead letter queue for jobs that repeatedly fail.

### Step 4: Worker Picks Up the Job

A separate Node.js process (the worker) long-polls the SQS queue. When it receives a message, it:

1. Updates the job status to `processing` in PostgreSQL
2. Calls the analyzer service, which runs the multi-layer analysis pipeline
3. On success: stores the result in PostgreSQL, caches it in Redis, updates status to `completed`
4. On failure: lets SQS handle the retry. After 3 failed attempts, SQS automatically moves the message to the dead letter queue

The worker runs as its own PM2 process, completely independent of the API server. You can scale workers horizontally without touching the API layer.

### Step 5: Client Gets Results

The frontend polls `GET /api/reviews/:id/status` every 2 seconds. Once the status flips to `completed`, it fetches the full result and renders it.

### Step 6: Dead Letter Queue Monitoring

A third PM2 process monitors the DLQ. When messages land there, it logs them and creates tracking records in the `dlq_messages` table. The frontend has a DLQ Management tab where you can inspect failed jobs, retry them, or mark them as resolved.

---

## Tech Stack

### Backend

| Component | Technology | Version | Purpose |
|-----------|-----------|---------|---------|
| Runtime | Node.js | 18.x | Server-side JavaScript |
| Framework | Express | 5.2.1 | HTTP API server |
| Database | PostgreSQL | 15 | Persistent storage for jobs and users |
| Cache | Redis | 7 | Result caching by code hash |
| Queue | AWS SQS | - | Async job processing with DLQ |
| AI | Google Gemini | 2.0 Flash | AI-powered code suggestions |
| Process Manager | PM2 | 6.x | Multi-process management in production |
| Linting Engine | ESLint | 9.x | Static analysis of submitted code |

### Frontend

| Component | Technology | Version | Purpose |
|-----------|-----------|---------|---------|
| UI Library | React | 18.x | Component-based interface |
| Build Tool | Vite | 5.x | Fast development and production builds |
| Styling | Tailwind CSS | 3.x | Utility-first CSS framework |
| HTTP Client | Axios | 1.x | API communication |
| Icons | Lucide React | - | UI icons |

### Infrastructure

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Compute | AWS EC2 (t3.micro) | Hosts the application |
| Database | AWS RDS (PostgreSQL 15) | Managed database with SSL |
| Cache | AWS ElastiCache (Redis 7) | Managed Redis cluster |
| Queue | AWS SQS | Managed message queue with DLQ |
| Local Dev | Docker Compose | PostgreSQL, Redis, LocalStack |

---

## Project Structure

```
code-review-platform/
|
|-- backend/
|   |-- ecosystem.config.js          # PM2 process configuration
|   |-- package.json
|   |-- src/
|       |-- index.js                  # Express API server + static file serving
|       |-- worker.js                 # SQS consumer, processes review jobs
|       |-- dlq-monitor.js            # Dead letter queue monitor
|       |-- config/
|       |   |-- database.js           # PostgreSQL connection pool with SSL
|       |   |-- queue.js              # SQS client configuration
|       |   |-- redis.js              # Redis client setup
|       |-- controllers/
|       |   |-- reviewController.js   # Submit, status, results, stats
|       |   |-- dlqController.js      # DLQ inspection and retry logic
|       |-- models/
|       |   |-- schema.sql            # Database tables and indexes
|       |-- routes/
|       |   |-- reviews.js            # /api/reviews/* routes
|       |   |-- dlq.js                # /api/dlq/* routes
|       |-- services/
|           |-- aiReviewer.js         # Gemini API integration with circuit breaker
|           |-- analyzer.js           # Multi-layer code analysis pipeline
|           |-- cache.js              # Redis cache get/set with TTL
|           |-- dlq.js                # DLQ message management
|           |-- pdfGenerator.js       # Text report generation
|           |-- queue.js              # SQS send/receive operations
|
|-- frontend/
|   |-- index.html
|   |-- package.json
|   |-- vite.config.js
|   |-- tailwind.config.js
|   |-- postcss.config.js
|   |-- public/
|   |-- src/
|       |-- App.jsx                   # Full SPA: submit, results, history, DLQ
|       |-- main.jsx                  # React entry point
|       |-- index.css                 # Tailwind directives
|       |-- services/
|           |-- api.js                # Axios client with polling logic
|
|-- infrastructure/                   # AWS setup scripts (01 through 08)
|-- docker-compose.yml                # Local dev: postgres, redis, localstack
|-- .gitignore
```

---

## Database Schema

Three tables handle all persistent state:

**users** - API key management and rate limiting (tier-based).

| Column | Type | Purpose |
|--------|------|---------|
| id | SERIAL | Primary key |
| email | VARCHAR(255) | Unique user identifier |
| api_key | VARCHAR(255) | Authentication token |
| tier | VARCHAR(50) | free / pro / enterprise |
| requests_count | INTEGER | Usage tracking |

**review_jobs** - Every code submission and its lifecycle.

| Column | Type | Purpose |
|--------|------|---------|
| id | UUID | Primary key (crypto.randomUUID) |
| status | VARCHAR(50) | queued / processing / completed / failed |
| code_hash | VARCHAR(64) | SHA-256 of submitted code, used for cache lookup |
| file_content | TEXT | The submitted source code |
| result | JSONB | Structured analysis output |
| cache_hit | BOOLEAN | Whether result came from Redis |
| processing_time_ms | INTEGER | End-to-end processing duration |
| attempts | INTEGER | Retry counter |

**dlq_messages** - Tracks jobs that failed after maximum retries.

| Column | Type | Purpose |
|--------|------|---------|
| job_id | UUID | References the failed review_job |
| message_id | VARCHAR(255) | SQS message identifier |
| receive_count | INTEGER | How many times SQS delivered this message |
| resolved | BOOLEAN | Whether the failure has been addressed |
| resolution_reason | TEXT | How it was resolved (retry, manual fix, etc.) |

Seven indexes optimize the most common query patterns: lookups by code hash, status filtering, chronological listing, and DLQ resolution status.

---

## API Endpoints

### Reviews

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/reviews/submit` | Submit code for review. Body: `{ code, fileName, language }` |
| GET | `/api/reviews/:id/status` | Poll job status. Returns `{ status, result? }` |
| GET | `/api/reviews/:id` | Get full review result |
| GET | `/api/reviews` | List all reviews (paginated) |
| GET | `/api/reviews/:id/report` | Download text report |
| GET | `/api/stats` | System stats: total jobs, cache hit rate, queue depth |

### Dead Letter Queue

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/dlq/messages` | List all DLQ messages |
| POST | `/api/dlq/retry/:id` | Retry a failed job |
| POST | `/api/dlq/retry-all` | Retry all unresolved DLQ messages |
| DELETE | `/api/dlq/:id` | Mark a DLQ message as resolved |

### System

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check. Returns `{ status: "ok", timestamp }` |

---

## Running Locally

### Prerequisites

- Node.js 18 or higher
- Docker and Docker Compose
- A Google Gemini API key (get one at https://aistudio.google.com/apikey)

### Steps

1. **Clone the repository**
   ```bash
   git clone https://github.com/your-username/code-review-platform.git
   cd code-review-platform
   ```

2. **Start local infrastructure**
   ```bash
   docker-compose up -d
   ```
   This starts PostgreSQL 15, Redis 7, and LocalStack (for SQS emulation) in containers.

3. **Configure the backend**
   ```bash
   cd backend
   cp .env.example .env.local
   ```
   Edit `.env.local` and fill in your Gemini API key. The database, Redis, and SQS settings are pre-configured for local Docker containers.

4. **Install dependencies and initialize the database**
   ```bash
   npm install
   # Run the schema migration (connects to local PostgreSQL)
   psql -h localhost -p 5432 -U postgres -d code_review -f src/models/schema.sql
   ```

5. **Start the backend (all three processes)**
   ```bash
   npm run dev
   ```
   Or start individually:
   ```bash
   node src/index.js      # API server on port 3000
   node src/worker.js     # SQS job processor
   node src/dlq-monitor.js # DLQ monitor
   ```

6. **Start the frontend (separate terminal)**
   ```bash
   cd ../frontend
   npm install
   npm run dev
   ```
   The Vite dev server starts on port 5173 with hot module replacement.

7. **Open the app**
   Visit `http://localhost:5173` in your browser. The frontend proxies API calls to `http://localhost:3000`.

---

## Deploying to AWS

The `infrastructure/` directory contains numbered shell scripts that set up each AWS resource in order:

| Script | What It Creates |
|--------|----------------|
| 01-vpc-setup.sh | VPC, subnets, internet gateway, route tables |
| 02-security-groups.sh | Security groups for EC2, RDS, ElastiCache, SQS |
| 03-rds-setup.sh | PostgreSQL 15 RDS instance with SSL |
| 04-elasticache-setup.sh | Redis 7 ElastiCache cluster |
| 05-sqs-setup.sh | SQS queue + dead letter queue with retry policy |
| 06-ec2-setup.sh | EC2 instance (t3.micro, Ubuntu 24.04) |
| 07-deploy.sh | Deploys application code to EC2 via SCP/SSH |
| 08-monitoring.sh | CloudWatch alarms and monitoring |

The scripts read from `infrastructure/config.sh` (not committed -- see `config.sh.example`).

### Production deployment summary:

1. Run scripts 01-06 to provision infrastructure
2. Create `backend/.env.production` with real connection strings (see `.env.example`)
3. Run script 07 to deploy code to EC2
4. PM2 starts three processes: API server (port 3000), worker, and DLQ monitor
5. Express serves the built React frontend as static files in production

In production, the frontend build output (`frontend/dist/`) is served by Express directly. There is no separate frontend server. This simplifies deployment and avoids CORS issues -- the API and UI share the same origin.

---

## Configuration Reference

### Environment Variables (backend/.env.production)

| Variable | Description |
|----------|-------------|
| NODE_ENV | `production` or `development` |
| PORT | API server port (default: 3000) |
| DATABASE_URL | PostgreSQL connection string |
| DB_SSL | `true` for RDS (uses AWS SSL certificate bundle) |
| REDIS_URL | Redis connection string |
| AWS_REGION | AWS region for SQS (e.g., us-west-2) |
| SQS_QUEUE_URL | Full SQS queue URL |
| SQS_DLQ_URL | Full SQS dead letter queue URL |
| GEMINI_API_KEY | Google Gemini API key |
| CORS_ORIGIN | Allowed origin for CORS (your domain or EC2 IP) |

---

## Architectural Decisions and Trade-offs

This section explains the reasoning behind the major design choices. These are the kinds of questions that come up during technical discussions and interviews.

---

### Why this architecture for a code review tool? Isn't it over-engineered?

The short answer: it depends on what you are building. A simple linting script does not need a queue and a database. But this is not a linting script.

The architecture solves three real problems:

**Blocking requests kill user experience.** AI analysis through Gemini takes 2-8 seconds depending on code length and API latency. If the API server ran analysis synchronously, the HTTP connection would hang for that entire duration. With async processing, the server responds immediately with a job ID, and the client polls until results are ready. The user sees a progress indicator instead of a frozen screen.

**Failures should not lose work.** Without a queue, if the AI API times out or the server crashes mid-analysis, the code submission is gone. SQS provides at-least-once delivery. If a worker crashes, the message becomes visible again after the visibility timeout and another worker picks it up. After 3 failures, it moves to the dead letter queue instead of disappearing.

**The components scale independently.** The API server handles HTTP requests. The worker handles CPU and I/O intensive analysis. The DLQ monitor handles failure recovery. In production, you can run 1 API server and 5 workers if analysis is the bottleneck, or 3 API servers and 1 worker if traffic is high but analysis is fast. They communicate through SQS, so they do not need to know about each other.

That said, for a personal project or a hackathon, this architecture would be overkill. The architecture makes sense when you are building something that needs to handle concurrent users, survive failures, and be deployable to production. Which is exactly the point of this project.

---

### Are cache hit rates of 60-70% realistic?

Yes, and here is why.

The cache key is a SHA-256 hash of the raw code content. Identical code produces identical hashes. This is not about "similar" code -- it is exact match only. The scenarios where this triggers are more common than you might expect:

**CI/CD pipelines.** If a pipeline runs code review on every push, and a developer pushes 3 commits that only change one file out of 20, the other 19 files hit the cache every time.

**Pull request review cycles.** A PR goes through 3 rounds of review. The reviewer requests changes to 2 functions. The developer fixes those 2 functions and re-submits. Every other function in the file that was not changed? Cache hit.

**Monorepo scenarios.** Ten services share a common utility library. That library gets reviewed once, and the next 9 times it appears in a submission, the cache handles it.

**Team environments.** Multiple developers working on the same codebase submit the same shared files for review. After the first submission, every subsequent one is a cache hit.

Based on these patterns, 60-70% cache hit rate is a conservative estimate for an active team. In a CI/CD pipeline with frequent small commits, it can go higher.

The cache uses a configurable TTL (time-to-live). Cached results expire after a set period, so if linting rules or AI models are updated, stale results eventually cycle out.

---

### Why single file upload instead of GitHub integration?

This is a deliberate MVP scoping decision, not a limitation.

The project was built to demonstrate the complete distributed system architecture: async job processing, caching, failure recovery with DLQ, and production deployment on AWS. Adding GitHub OAuth, webhook handling, diff parsing, and multi-file analysis would have expanded the scope significantly without adding architectural value.

That said, the architecture is designed to support it. The path from here to GitHub integration looks like this:

**Phase 2 would add:**
- GitHub OAuth for authentication (replacing the current API key system)
- Webhook endpoint that triggers on pull request events
- A diff parser that extracts changed files from the PR
- Parallel job submission -- one SQS message per changed file
- Result aggregation that waits for all file reviews to complete before posting a PR comment

The queue-based architecture makes this natural. Instead of submitting one job, the webhook handler would submit N jobs (one per file), and a result aggregator would collect them. The worker does not change at all -- it already processes one file at a time.

---

### AI reviewing AI-generated code -- is that circular?

This concern assumes the AI is the primary analysis layer. It is not.

The analysis pipeline has multiple layers, and AI is the last one:

**Layer 1: Static Analysis (catches ~80% of issues).** ESLint with language-appropriate rule configurations. This is deterministic, rule-based analysis. It catches unused variables, missing semicolons, unreachable code, inconsistent formatting, and hundreds of other patterns. No AI involved.

**Layer 2: Security Scanning.** Pattern matching against known vulnerability signatures: hardcoded API keys, SQL injection patterns (string concatenation in queries), eval() usage, insecure cryptographic functions, CORS misconfigurations, path traversal patterns. This is also deterministic.

**Layer 3: Best Practice Checks.** Naming convention analysis, function complexity scoring (cyclomatic complexity), error handling patterns, code organization heuristics. Rule-based.

**Layer 4: AI Suggestions (Gemini).** This is where contextual feedback happens. The AI looks at the code holistically and provides suggestions that rule-based systems cannot: "This function is doing three things and should be split," or "Consider using a Map instead of nested if-else for this lookup pattern." These are suggestions, not verdicts.

If the AI is unavailable (API error, rate limit, timeout), the circuit breaker trips and the review completes with Layers 1-3 only. The AI enhances the review; it does not gate it.

So the question becomes: can AI provide useful suggestions about code it might have generated? Yes, because the suggestions are about code quality and patterns, not about whether the logic is correct. An AI can reasonably say "this function has high cyclomatic complexity" regardless of who wrote it.

---

### How do you define "good code" vs "bad code"?

The system categorizes issues into three tiers, and this distinction is important:

**Tier 1: Objective Violations (Critical)**
These are things that are measurably wrong. Security vulnerabilities (hardcoded credentials, SQL injection), runtime errors (undefined references, type mismatches), and logic bugs (unreachable code, infinite loops). These are not matters of opinion. The code is broken or insecure, and it needs to change.

**Tier 2: Best Practice Violations (Warning)**
These are things the industry has broadly agreed on through decades of collective experience. Functions longer than 50 lines are harder to test. Deeply nested callbacks are harder to read than async/await. Magic numbers without named constants make code harder to maintain. Not everyone agrees on every rule, but there is strong consensus on most of them.

**Tier 3: Subjective Suggestions (Info)**
These are style preferences and architectural opinions. Should you use a for loop or a forEach? Should utility functions be in a separate file or co-located? Should you use early returns or a single return point? These are legitimate debates, and the system presents them as suggestions, not requirements.

The key design principle: the system's severity levels match these tiers. Critical issues are things that should block a merge. Warnings are things worth discussing. Info-level suggestions are take-it-or-leave-it. This prevents the common problem with automated review tools where everything is flagged as equally important, which causes developers to ignore all of it.

---

### Why not train your own model instead of using API calls?

API calls (Google Gemini in this case) are the right choice for 99% of code review use cases. Here is the decision tree:

**Training a custom model makes sense when:**
- You have proprietary coding standards that are unique to your organization and cannot be expressed as rules
- You need the model to learn from your specific codebase patterns (thousands of examples)
- You have the infrastructure: GPU clusters for training, ML engineers for maintenance, a pipeline for retraining as standards evolve
- You process millions of reviews per month and the per-API-call cost exceeds hosting your own model

**API calls make sense when (this project):**
- You need general code quality analysis, not company-specific pattern matching
- Your volume is in the thousands-to-tens-of-thousands range, not millions
- You want the model to improve automatically when the provider updates it
- You do not have a dedicated ML team or GPU infrastructure
- The cost per API call (fractions of a cent for Gemini Flash) is negligible compared to the engineering time to build and maintain a custom model

For this project, the math is simple. Gemini 2.0 Flash costs roughly $0.0001 per request for typical code review payloads. A thousand reviews costs 10 cents. Training a custom model would cost thousands of dollars in compute alone, plus ongoing maintenance. The API approach also means the model improves over time without any work on our end.

The hybrid approach (rule-based analysis for the predictable stuff, API calls for the contextual stuff) gives the best of both worlds. Rules handle 80% of findings with zero cost and zero latency. The AI handles the remaining 20% where pattern matching falls short.

---

*Built as a major project demonstrating distributed systems architecture, async processing patterns, and production AWS deployment.*

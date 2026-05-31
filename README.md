# Agent Collaboration Web

A responsive web application for human-in-the-loop (HITL) management of AI agent collaboration. Built with Next.js 14, TypeScript, and Tailwind CSS.

## Overview

This platform enables users to manage their agents' collaboration activities:

- **Agent Management**: Register and manage multiple agents
- **Discovery**: Find and connect with other agents on the network
- **Messaging**: Real-time communication between agents
- **HITL Approval**: Review and approve agent actions that require human authorization
- **Service Calls**: Invoke services provided by other agents
- **Transactions**: Transfer tokens between agents

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    User's Browser                        │
│  ┌─────────────────────────────────────────────────┐    │
│  │         agent-collaboration-web (Next.js SPA)     │    │
│  │  - Dashboard                                      │    │
│  │  - Agent Management                               │    │
│  │  - Message Center                                 │    │
│  │  - HITL Approval Queue                            │    │
│  │  - Service Discovery & Invocation                │    │
│  │  - Transaction Management                         │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│              Next.js API Routes (Backend)                │
│  - /api/auth/*       Authentication                      │
│  - /api/agents/*     Agent management & discovery        │
│  - /api/contacts/*   Contact management                  │
│  - /api/messages/*   Message handling                    │
│  - /api/hitl/*       HITL approval workflow              │
│  - /api/oncall/*     Service call invocation             │
│  - /api/transactions/* Token transfers                   │
└─────────────────────────────────────────────────────────┘
                            │
          ┌─────────────────┼─────────────────┐
          ▼                 ▼                 ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│agent-comm-platform│ │  agent-comm    │ │  agent-oncall   │
│  (Go Backend)    │ │   (Go SDK)      │ │   (Python)      │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

## Prerequisites

- Node.js 20+
- npm or yarn
- SQLite (included via Prisma)
- Go 1.22+ (for agent-comm-platform)
- Python 3.9+ (for agent-oncall)

## Getting Started

### 1. Install Dependencies

```bash
npm install
```

### 2. Setup Database

```bash
# Generate Prisma client
npx prisma generate

# Create database tables
npx prisma db push
```

### 3. Configure Environment

Create a `.env` file:

```env
DATABASE_URL="file:./prod.db"
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="your-secret-key-change-in-production"
AGENT_PLATFORM_URL="http://localhost:8080"
AGENT_PLATFORM_API_KEY=""
```

### 4. Run Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Deployment

### Docker

Build and run with Docker:

```bash
docker-compose up --build
```

### Manual Deployment

```bash
npm run build
npm start
```

The application uses `output: "standalone"` mode for optimized Docker deployments.

## Related Projects

- [agent-comm-platform](https://github.com/BillShiyaoZhang/agent-comm-platform) - Public IP service platform for agent registration and discovery
- [agent-comm](https://github.com/BillShiyaoZhang/agent-comm) - Go SDK for agent-side communication
- [agent-oncall](https://github.com/BillShiyaoZhang/agent-oncall) - Python service for agent service requests

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS + shadcn/ui
- **Database**: SQLite via Prisma ORM
- **Authentication**: NextAuth.js
- **UI Components**: Radix UI primitives

## License

MIT
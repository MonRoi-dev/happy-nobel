---
description: "Protocol for querying and updating knowledge graph in codebase-memory MCP and ARCHITECTURE_MAP.md upon structural NestJS/database/queue changes"
trigger: model_decision
---

# Workflow Rule: Codebase Memory & Architecture Sync

Strict protocol for maintaining an accurate mental model and dependency graph of the project using the `codebase-memory` MCP server and `ARCHITECTURE_MAP.md`.

## 1. Context Retrieval (Read Phase)

Before planning refactors, adding features, or tracing bugs across modules:

1. **Check High-Level Map:** Read `ARCHITECTURE_MAP.md` for domain boundaries, Redis key namespaces, and RabbitMQ topology.
2. **Query Graph Memory:** Invoke `codebase-memory` MCP tools (search/graph/relations) to inspect:
    - Incoming and outgoing dependency edges of target NestJS modules/services.
    - Impact radius of changing an Entity, DTO, or shared interface.
3. **Avoid Blind Scanning:** Do NOT run broad `grep` or directory tree walks if the relation is already indexed in `codebase-memory`.

## 2. Knowledge Synchronization (Write/Update Phase)

Trigger a memory update **immediately after** completing any of the following structural changes:

- Creating, renaming, or deleting a NestJS `@Module`, `@Controller`, or exported `@Injectable` facade.
- Adding or modifying database entities/tables or cross-domain relations.
- Adding new RabbitMQ exchanges, queues, routing keys, or Redis cache prefixes.

**Sync Steps:**

1. Call the `codebase-memory` MCP indexing/update tool to record the new/modified nodes and edges.
2. If high-level topology changed (new module, queue, or cache namespace), update the corresponding table in `ARCHITECTURE_MAP.md`.

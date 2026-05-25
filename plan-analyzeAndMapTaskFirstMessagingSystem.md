{
  "task": "Critique and map a task-first messaging system",
  "steps": [
    {
      "id": "step-1",
      "title": "Collect current chat architecture details",
      "type": "search",
      "input": {
        "scope": "workspace",
        "queries": [
          "Message schema",
          "Task schema",
          "Socket.IO events",
          "worker queue",
          "outbox",
          "idempotency",
          "optimistic concurrency"
        ]
      },
      "output": "Relevant files and symbols for message storage, realtime events, task-related models, and async processing."
    },
    {
      "id": "step-2",
      "title": "Extract persistence and event contracts",
      "type": "extract",
      "input": {
        "sources": [
          "message model files",
          "task model files",
          "socket event definitions",
          "worker/job definitions"
        ],
        "fields": [
          "schema shapes",
          "indexes",
          "validation rules",
          "event payloads",
          "versioning fields",
          "retry and dedupe logic"
        ]
      },
      "output": "Structured data describing current schemas, event contracts, and processing flow."
    },
    {
      "id": "step-3",
      "title": "Identify consistency and failure risks",
      "type": "extract",
      "input": {
        "sources": [
          "schema definitions",
          "queue handlers",
          "socket emit paths",
          "update handlers"
        ],
        "targets": [
          "race conditions",
          "duplicate processing paths",
          "ordering hazards",
          "transaction boundaries",
          "event loss scenarios"
        ]
      },
      "output": "Risk inventory with concrete failure modes and affected code paths."
    },
    {
      "id": "step-4",
      "title": "Generate implementation mapping",
      "type": "generate",
      "input": {
        "context": [
          "current architecture extraction",
          "risk inventory"
        ],
        "deliverable": "step-by-step mapping from current chat flow to task-first messaging flow",
        "constraints": [
          "do not break existing chat paths",
          "preserve backward compatibility",
          "separate strong vs eventual consistency"
        ]
      },
      "output": "A concrete architecture mapping with components, data flow, and event flow."
    },
    {
      "id": "step-5",
      "title": "Store plan and critique artifacts",
      "type": "store",
      "input": {
        "destination": "session memory",
        "artifacts": [
          "architecture mapping",
          "failure modes",
          "schema notes",
          "event contract notes"
        ]
      },
      "output": "Persisted planning notes for later implementation or review."
    },
    {
      "id": "step-6",
      "title": "Notify completion",
      "type": "notify",
      "input": {
        "audience": "user",
        "message": "Task-first messaging system critique and implementation mapping is ready."
      },
      "output": "User receives completion notification."
    }
  ]
}
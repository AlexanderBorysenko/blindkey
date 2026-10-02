// Static descriptors for the Blindkey server's own `/mcp` tools (spec §2.4) — the bridge always lists
// these, even before the agent is connected (first session: no token yet, or the keyring dependency
// still installing), so Claude sees the full tool surface from the start. Copied verbatim (name,
// description, JSON inputSchema) from what packages/server/src/http/mcp.ts produces over `tools/list`;
// `agent.bridge.tools.test.ts` compares this module to a live server's list, so any drift fails the
// suite. When connected, the bridge prefers the upstream's own schema for an allowlisted name.
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const UPSTREAM_TOOL_DESCRIPTORS: Tool[] = [
  {
    "name": "list_projects",
    "description": "List projects visible to this token (slug, name, status, tags, summary).",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  },
  {
    "name": "get_project",
    "description": "Get a project with its document index and secret metadata (no sensitive values).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "slug": {
          "type": "string",
          "pattern": "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$"
        }
      },
      "required": [
        "slug"
      ],
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  },
  {
    "name": "list_documents",
    "description": "List documents of a project (or global documents when project is omitted).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "project": {
          "type": "string",
          "pattern": "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$"
        }
      },
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  },
  {
    "name": "read_document",
    "description": "Read a Markdown document. Omit project for global documents (e.g. \"guidelines\"). Includes resolved secret refs (keys only).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "project": {
          "type": "string",
          "pattern": "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$"
        },
        "slug": {
          "type": "string",
          "pattern": "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$"
        }
      },
      "required": [
        "slug"
      ],
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  },
  {
    "name": "write_document",
    "description": "Create or update a Markdown document. Rejected if it looks like it contains secret values or references unknown secrets; pass force=true to override.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "project": {
          "type": "string",
          "pattern": "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$"
        },
        "slug": {
          "type": "string",
          "pattern": "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$"
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 300
        },
        "category": {
          "type": "string",
          "enum": [
            "context",
            "architecture",
            "deploy",
            "conventions",
            "client",
            "notes",
            "guidelines"
          ]
        },
        "body_md": {
          "type": "string",
          "maxLength": 2000000
        },
        "force": {
          "type": "boolean"
        }
      },
      "required": [
        "slug",
        "title",
        "category",
        "body_md"
      ],
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  },
  {
    "name": "search",
    "description": "Search project names, document text and secret names. Never searches secret values.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "query"
      ],
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  },
  {
    "name": "list_secrets",
    "description": "List secret metadata for a project (or global when project omitted): name, description, tags, field keys and non-sensitive values.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "project": {
          "type": "string",
          "pattern": "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$"
        }
      },
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  },
  {
    "name": "update_project",
    "description": "Update a project's name, status, tags or summary (never its slug). Requires projects:write.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "slug": {
          "type": "string",
          "pattern": "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$"
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "status": {
          "type": "string",
          "enum": [
            "active",
            "paused",
            "archived"
          ]
        },
        "tags": {
          "maxItems": 50,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 50
          }
        },
        "summary": {
          "type": "string",
          "maxLength": 5000
        }
      },
      "required": [
        "slug"
      ],
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  },
  {
    "name": "create_project",
    "description": "Create a project. Requires projects:create. The new project is added to this token's projects immediately, so you can write its documents and secrets straight away.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "slug": {
          "type": "string",
          "pattern": "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$"
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "status": {
          "type": "string",
          "enum": [
            "active",
            "paused",
            "archived"
          ]
        },
        "tags": {
          "maxItems": 50,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 50
          }
        },
        "summary": {
          "type": "string",
          "maxLength": 5000
        }
      },
      "required": [
        "slug",
        "name"
      ],
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  },
  {
    "name": "upsert_secret_meta",
    "description": "Create a secret (project omitted for global) or patch an existing one's description/tags/fields, by name. Requires secrets:meta-write. Fields may only be non-sensitive both before and after: keys that are non-sensitive by default (host, port, url, username, database, public_key), or any other key passed with sensitive:false unless it looks like a credential (pass, secret, token, key, salt, auth, private, ...). Creating or touching a sensitive field is refused with a 403; use secret_request_link instead so the user types the value in.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "project": {
          "type": "string",
          "pattern": "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$"
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "description": {
          "type": "string",
          "maxLength": 5000
        },
        "tags": {
          "maxItems": 50,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 50
          }
        },
        "fields": {
          "maxItems": 200,
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "key": {
                "type": "string",
                "pattern": "^[A-Za-z0-9_.-]{1,64}$"
              },
              "value": {
                "type": "string",
                "maxLength": 1000000
              },
              "sensitive": {
                "type": "boolean",
                "const": false
              }
            },
            "required": [
              "key",
              "value"
            ]
          }
        }
      },
      "required": [
        "name"
      ],
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  },
  {
    "name": "secret_request_link",
    "description": "Build a prefilled admin-UI link for creating or updating a secret's values: give this link to the user; they type the values; then call list_secrets to confirm. Points at the new-secret form for a name that does not exist yet, or at that existing secret's edit page otherwise (existing fields are left alone; only keys not already on the secret get an empty row to fill in). sensitive:false is honoured only for keys that are non-sensitive by default (host, port, url, username, database, public_key); any other key stays sensitive. Works with any secrets scope. Never returns or asks for a value.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "project": {
          "type": "string",
          "pattern": "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$"
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "description": {
          "type": "string",
          "maxLength": 5000
        },
        "tags": {
          "maxItems": 50,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 50
          }
        },
        "keys": {
          "minItems": 1,
          "maxItems": 200,
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "key": {
                "type": "string",
                "pattern": "^[A-Za-z0-9_.-]{1,64}$"
              },
              "sensitive": {
                "type": "boolean"
              }
            },
            "required": [
              "key",
              "sensitive"
            ]
          }
        }
      },
      "required": [
        "name",
        "keys"
      ],
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  }
];

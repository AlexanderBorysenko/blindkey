# Security policy

Blindkey stores credentials, so security reports are very welcome.

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for a security problem.

Include what you found, how to reproduce it, and the impact you expect. You should get a first response within a week. Once a fix is released, you will be credited in the advisory unless you ask not to be.

## Scope

In scope:

- the server (`packages/server`): REST API, MCP endpoint, admin UI, encryption, authentication, and the ops CLI;
- the client CLI (`packages/cli`), including secret injection and redaction;
- the Claude Code plugin (`plugin/`): guard and redaction hooks, the MCP bridge, and token storage;
- the Docker deployment files (`docker/`).

Out of scope:

- the gaps already listed under [Known limits](README.md#known-limits), unless you find a way to make them worse than described;
- attacks that need root on the server host or possession of the master key;
- an agent that is deliberately malicious (see the [threat model](README.md#threat-model-at-a-glance));
- vulnerabilities in third-party dependencies with no demonstrated impact on Blindkey.

## Supported versions

Only the latest commit on the default branch receives security fixes.

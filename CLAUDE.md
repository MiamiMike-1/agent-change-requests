# Working in this repository

This repository is public: the SEP and its reference packages are for anyone who implements the extension.

- Keep everything generic. Code, defaults, examples, docs, and tests must not point at a particular vendor's server, repository, account, or deployment. Use placeholders such as `com.example/change-requests`, `example-org/repo`, and `Example MCP`.
- No defaults that send data to a specific party. Anything that leaves a server, such as an upstream relay or a sink, takes its destination from the operator's configuration.
- The SEP's Preamble may name where this extension's own maintainers accept requests. That is the extension's address, not a package default.
- Real products may appear only as cited evidence in the SEP's prose (Motivation, Rationale, Reference Implementation), never as behavior in the packages.
- Build order: server, then client, then demo. `npm run build`, `npm run typecheck`, and `npm test` at the root run all three.

# dsh-session-vault

English | [中文](README.zh.md)

A DeepSeek Harness settings plugin. It lists and deletes sessions the sidebar hides: archived sessions, or blank sessions whose log has no `turn/start`. A session whose log cannot be read is listed too, marked “Unreadable” — this page is the only surface left that can remove it. Subagent sessions are excluded.

Deleting a session:

- disposes any live agent / session so the next flush cannot rewrite the files and so `@` mentions no longer list it
- removes the JSONL session directory (`$DSH_HOME/sessions/.../<session-id>/`)
- drops the id from workspace `sessionIds` and the global `archivedSessionIds` set

The settings nav label follows the product locale: 「归档」 in Chinese, “Archive” in English. The list can be filtered by kind and date, and is paginated.

This plugin does not create a directory under `$DSH_HOME` and does not write a settings namespace.

## Install

```sh
dsh plugin --profile web add dsh-session-vault
```

From a local checkout:

```sh
dsh plugin --profile web add /path/to/dsh-session-vault
```

Restart `dsh web`, then open Settings.

## Usage

- The session you are currently viewing cannot be deleted; switch away first.
- A `running` session is refused.
- Deletion asks for confirmation and cannot be undone.

## Develop

```sh
npm install
npm test
```

`npm install` builds the browser bundle (`client/client.js`). After changing files under `client/`, run `npm run build:client` and refresh `dsh web`.

## Uninstall

```sh
dsh plugin --profile web remove dsh-session-vault
```

Restart `dsh web`.

## Limits

- Requires the JSONL persistence backend (`dsh web` default). Delete refuses any backend whose `locate()` does not answer `kind: 'jsonl'` with a session-owned directory, so a store with no per-session files (SQLite) or a shared artifact is never removed.
- Deletes go through Connection RPC with `authority: loopback`, so only the local settings page can call them.
- One `vault.delete` call accepts at most 200 ids.
- Removing an id from the archive ledger has no published API upstream (`archiveSession` ships without a counterpart), so `lib/registry-compat.js` writes `WorkspaceRegistry` state directly. That write does not run on the registry's own operation queue: a workspace mutation landing in the same instant is reported as `registry-unsupported` rather than silently overwritten. A DSH build that changes those internals fails loud instead of leaving a deleted session archived.

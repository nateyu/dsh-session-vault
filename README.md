# dsh-session-vault

English | [中文](README.zh.md)

A DeepSeek Harness settings plugin. It lists and deletes sessions the sidebar hides: archived sessions, or blank sessions whose log has no `turn/start`. Subagent sessions are excluded.

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

- Requires the JSONL persistence backend (`dsh web` default). SQLite session stores have no per-session files, so delete is refused.
- Deletes go through Connection RPC with `authority: loopback`, so only the local settings page can call them.

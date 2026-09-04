# dsh-session-vault

[English](README.md) | 中文

DeepSeek Harness 设置页插件。列出并删除侧栏中不显示的会话：已归档，或日志里还没有 `turn/start` 的空白会话。子代理不会出现在本页。

删除会同时：

- 拆除仍在内存中的 agent / session，避免下次 flush 把文件写回，也避免对话框 `@` 继续列出它
- 删除 JSONL 会话目录（`$DSH_HOME/sessions/.../<session-id>/`）
- 从工作区 `sessionIds` 和全局 `archivedSessionIds` 中移除

设置导航随系统语言切换：中文「归档」，English “Archive”。列表可按种类、日期筛选并分页。

本插件不在 `$DSH_HOME` 下创建自有目录，也不写 settings 命名空间。

## 安装

```sh
dsh plugin --profile web add dsh-session-vault
```

本地 checkout：

```sh
dsh plugin --profile web add /path/to/dsh-session-vault
```

重启 `dsh web` 后，打开设置即可看到该页。

## 使用

- 当前正在查看的会话不能删，需先切走。
- 正在 `running` 的会话会拒绝删除。
- 删除前有确认框，不可恢复。

## 开发

```sh
npm install
npm test
```

`npm install` 会构建浏览器端 bundle（`client/client.js`）。改 `client/` 源码后执行 `npm run build:client`，再刷新 `dsh web`。

## 卸载

```sh
dsh plugin --profile web remove dsh-session-vault
```

重启 `dsh web`。

## 限制

- 需要 JSONL 持久化后端（`dsh web` 默认即是）。SQLite 会话库没有按会话文件，删除会被拒绝。
- 删除走 Connection RPC，`authority: loopback`，仅本机设置页可调。

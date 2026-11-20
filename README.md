# Antigravity Cache Display

**Antigravity Cache Display** 是一个用于 Antigravity 的辅助侧边栏插件，同时附带独立的命令行工具与本地预览服务。它能够以只读方式解析本地对话数据库，直观展示当前对话中每一次模型请求的 Prompt Cache 命中率，帮助你快速定位零缓存、前缀失效、缓存过期和上下文截断等问题。

---

## 用途与功能

在和 AI Coding Agent 进行长对话时，Prompt Caching 直接决定了响应速度与 Token 消耗。但在实际使用中，缓存命中率有时会突然跌到 0% 或大幅下滑，仅靠体感很难判断原因。Cache Display 把每轮请求的底层用量拆解出来，方便你直接排查：

- **总览与趋势**：顶部卡片汇总总命中率、最近一次命中率、总请求数、0 缓存次数以及前缀未命中次数，下方用柱状图呈现整个对话的命中率波动。
- **逐请求明细**：表格按顺序列出每轮请求的时间、距上一轮回答的间隔、输入 Token、命中 Token、未命中 Token、命中率、输出 Token、首字延迟以及模型名称。界面支持只看异常筛选和一键复制 CSV，语言和深浅色主题会自动跟随当前环境。
- **自动异常诊断**：针对常见的缓存异常情况，系统会自动打上诊断标记：
  - **0 缓存**：输入达到 1024 tokens，但没有任何 token 命中缓存。
  - **0 缓存 · 输入过短**：输入不足 1024 tokens，可能尚未达到隐式缓存的最小门槛。
  - **前缀未读取**：上一轮请求的完整 Prompt 本应可复用，但本轮未命中的部分超过了预期前缀的一半，且至少有 2000 tokens。
  - **间隔过长**：距离上一轮回答结束已超过 5 分钟，服务端缓存可能已经过期。
  - **上下文缩小**：本轮输入比上一轮少了 30% 以上，通常是因为触发了上下文压缩或截断，破坏了原有前缀。
  - **有重试**：这次请求经历过失败重试。

---

## 环境要求

运行本项目只需 **Node.js 22.5.0 及以上版本**。底层直接使用 Node.js 内置的 `node:sqlite` 模块读取数据库，整个项目零第三方依赖，无需执行 `npm install`。

如果你希望把它作为侧边栏插件使用，需要本地已安装 Antigravity；如果只是临时排查对话数据，命令行工具和本地预览服务可以脱离 Antigravity 独立运行。

---

## 安装方式

### 人类指南

#### Windows 一键安装

1. 克隆本仓库到本地：
   ```powershell
   git clone https://github.com/<your-org>/antigravity-cache-display.git
   cd antigravity-cache-display
   ```
2. 运行根目录下的安装脚本，它会自动将 `cache-display` 同步到 `%USERPROFILE%\.gemini\config\plugins\cache-display`：
   ```powershell
   .\install.bat
   ```
3. 打开 Antigravity，进入 **Plugins** 面板启用 **Cache Display**，随后即可在右侧辅助侧边栏打开 **Cache** 面板。

如需卸载，运行 `.\uninstall.bat` 即可移除已安装的插件目录。

#### macOS 与 Linux 手动安装

1. 克隆仓库后，将 `cache-display` 目录复制到 Antigravity 的插件目录下：
   ```bash
   mkdir -p ~/.gemini/config/plugins
   cp -r cache-display ~/.gemini/config/plugins/cache-display
   ```
2. 打开 Antigravity，在 **Plugins** 面板中启用 **Cache Display**，然后从辅助侧边栏打开 **Cache** 面板。

#### 不安装插件，直接本地排查

如果你只想快速分析某个对话的缓存数据，可以直接使用项目自带的命令行或本地网页工具：

```bash
# 在终端打印最新对话的缓存明细表，也可以传入具体的 conversationId 或 .db 文件路径
npm run inspect
node tools/inspect.mjs <conversationId> --csv

# 启动本地预览服务器，随后在浏览器访问 http://127.0.0.1:8765/
npm run dev
```

---

### Agent 指南

如果你想让你的 Coding Agent 帮你完成安装，或者直接帮你排查某个对话的缓存问题，可以把下面这段提示发给它：

> 请帮我安装当前仓库中的 Antigravity 插件 `cache-display`。先检查本地 Node.js 版本是否达到 22.5.0 及以上，安装完成后告诉我如何在界面里启用。

如果你本身就是正在读取本仓库的 Agent，可以按以下顺序操作：

1. 运行 `node -v`，确认 Node.js 版本不低于 `22.5.0`。
2. 将 `cache-display` 安装到 `~/.gemini/config/plugins/cache-display`：
   - 在 Windows 上，执行 `.\install.bat` 或运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/manage-plugin.ps1 -Action install`。
   - 在 macOS 或 Linux 上，执行 `mkdir -p ~/.gemini/config/plugins && cp -r cache-display ~/.gemini/config/plugins/cache-display`。
3. 提示用户前往 Antigravity 的 **Plugins** 面板手动启用 **Cache Display**，并从辅助侧边栏打开 **Cache** 面板。
4. 如果用户的目的只是诊断某次对话的缓存命中情况，你可以直接运行只读命令 `node tools/inspect.mjs [conversationId] --csv` 获取分析数据，无需等待插件启用。

---

## 原理解析

```text
Antigravity 对话数据库 (~/.gemini/antigravity/conversations/<id>.db)
        │
        ▼
  parser.mjs ──► 只读打开 SQLite，解码 gen_metadata 与 steps 中的 Protobuf 字段
        │
        ▼
  service.mjs ─► 计算命中率、请求间隔与异常标记，并维护文件指纹与内存快照
        │
        ▼
  server.mjs ──► 通过 sidecar_sdk 校验 UI Token，响应 POST /api/cache 增量轮询
        │
        ▼
  index.html ──► 渲染统计卡片、趋势柱状图与明细表
```

1. **定位本地数据库**  
   Antigravity 会为每个对话生成一个独立的 SQLite 数据库，默认存放在 `~/.gemini/antigravity/conversations/<id>.db`。插件启动后，会通过宿主传入的 `ANTIGRAVITY_EXECUTABLE_DATA_DIR` 环境变量推导出该目录路径。如果用户当前停留在新建对话页面、尚未选中具体对话，服务会自动跟踪最近修改过的 `.db` 文件。

2. **只读解析 Protobuf 二进制数据**  
   `parser.mjs` 使用 Node.js 内置的 `DatabaseSync` 以只读模式打开数据库，确保不会对对话记录产生任何写入或锁冲突。它会查询 `gen_metadata` 表中每轮模型请求对应的二进制数据，通过内置的轻量级 Protobuf 解析器提取 uncached input、cached input、output tokens、首字时间 TTFT、流式输出耗时、模型名称以及重试错误信息。字段编号映射参考了开源项目 `agy-capsule`。同时，代码会关联 `steps` 表中的时间戳，推算出相邻两轮请求之间的空闲间隔，过滤掉尚未完成或无输入用量的预检请求，最终输出命中率与各类诊断标记。

3. **增量轮询与快照容错**  
   `service.mjs` 会记录 `.db` 与 `.db-wal` 文件的大小和纳秒级修改时间作为版本指纹。前端页面轮询 `/api/cache` 时，如果文件指纹没有变化，服务端会直接返回 `{ ok: true, unchanged: true }`，跳过重复解析与 DOM 重绘。当数据库恰好处于写入瞬间导致读取失败时，服务端会自动回退返回上一次成功的内存快照，保证面板显示稳定。

4. **侧边栏挂载与安全校验**  
   `sidecar.json` 将页面注册为 Antigravity 的辅助侧边栏入口 `SIDECAR_UI_ENTRYPOINT_AUX_PANE`。`server.mjs` 启动时会检查宿主注入的 `ANTIGRAVITY_SIDECAR_UI_TOKEN`，如果缺少 Token 则拒绝提供服务；数据接口仅开放 `POST /api/cache`，从而保证所有请求都经过 `sidecar_sdk` 的鉴权路径。

---

## 目录结构

```text
├── cache-display/
│   ├── plugin.json               # 插件清单
│   ├── logo.svg                  # 插件图标
│   └── sidecars/cache_display/
│       ├── sidecar.json          # Sidecar 与侧边栏入口配置
│       ├── server.mjs            # sidecar_sdk 服务入口
│       ├── service.mjs           # 数据库定位、文件指纹与快照缓存
│       ├── parser.mjs            # SQLite 与 Protobuf 解析及诊断分析
│       └── index.html            # 侧边栏前端页面
├── scripts/manage-plugin.ps1     # Windows 安装与卸载脚本
├── tools/
│   ├── inspect.mjs               # 命令行分析工具
│   └── dev-server.mjs            # 本地调试预览服务器
├── test/parser.test.mjs          # 解析与诊断逻辑单元测试
├── install.bat
├── uninstall.bat
└── package.json
```

## 测试

```bash
npm test
```

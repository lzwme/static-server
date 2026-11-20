# LocalSend API 参考

LocalSend 的全部 HTTP 接口清单。面向需要脚本集成或二次开发的场景；日常使用直接用网页端即可。

- 功能说明见 [LocalSend 使用指南](localsend.md)
- 配置项说明见 [配置参考](config.md)

## 认证

网页端只显示**一个**输入框：口令与访问令牌的摘要一起提交，用户不必先分辨自己手里拿的是哪一种。服务端已配置的凭据类型（`hasAdmin` / `hasVisitor` / `hasToken`）会用于生成输入框提示。

| 接口 | 说明 |
| --- | --- |
| `GET /localsend/api/auth/salt` | 取回各密钥的公开盐值与迭代次数（客户端据此派生摘要） |
| `POST /localsend/api/auth/login` | 提交摘要并返回会话令牌与身份。`digests` 可同时带 `password`、`visitorPassword`、`token`，由服务端判断匹配哪一种，返回的 `via` 表示本次使用的凭据类型 |
| `POST /localsend/api/auth/token` | 只提交访问令牌摘要换取会话（脚本客户端用） |
| `POST /localsend/api/logout` | 注销当前会话 |
| `GET /localsend/api/session` | 查询当前身份（角色、是否开放模式、是否配置了口令、会话是否仍然有效） |

未授权时的 401 响应带一个标记字段，用于区分「从未认证」与「认证已失效」（网页端已统一为一个认证入口，这两个字段主要供脚本客户端区分处理）：

```jsonc
// 没带任何凭证（或令牌不对）：需要输入访问令牌
{ "code": 1, "msg": "需要访问令牌", "needToken": true }
// 带了会话但服务端不认（口令已变更 / 会话过期 / 服务重启）：需要重新登录
{ "code": 1, "msg": "会话已失效，请重新登录", "needLogin": true }
```

> 认证接口（取盐值、登录、换令牌）同样受频率限制保护：摘要比对要跑 PBKDF2，不限流的话一次重复提交就能把服务端的 CPU 打满。

## 上传、用量与访问地址

| 接口 | 说明 |
| --- | --- |
| `POST /localsend/api/upload?dir=归档/2026` | 多文件上传（`multipart`，字段名 `files`）。`dir` 指定目标目录，省略则落根目录；文件名中的子路径（上传文件夹）会拼在目标目录之后。`dir` 非法时直接 400，不会静默落到根目录 |
| `GET /localsend/api/usage` | 存储用量：`used`、`limit`、`files`、`trash`、`trashCount`，以及 `trashDays`、`autoCleanDays`、`maxSize`；`dir`（本机存储路径）只对管理员返回 |
| `GET /localsend/api/network` | 候选访问地址（免鉴权）：`addresses`（地址 + 网卡名）、`suggested`、`loopback`，供页面生成与切换二维码；多网卡机器不会再把 WSL / Docker 的地址当成唯一入口 |

## 短期票据

下载、预览、打包与事件流的 URL 由浏览器直接发起（带不了请求头），因此改用**短期票据**：页面先换一张只对指定文件有效、2 分钟过期的票据，再访问 `/localsend/api/t/<token>/...`。这样复制出去的链接不会带上会话令牌，视频拖动进度条、断点下载也能复用同一张票据。

| 接口 | 说明 |
| --- | --- |
| `POST /localsend/api/ticket` | 换短期票据：`{ scope: 'download' \| 'preview' \| 'zip' \| 'events', names: [...] }`，返回 `token` 与 `expiresAt` |
| `GET /localsend/api/t/<token>/download/<name>` | 用票据下载（无需会话，文件类票据 2 分钟过期） |
| `GET /localsend/api/t/<token>/preview/<name>` | 用票据预览（支持 Range，视频可拖动） |
| `GET /localsend/api/t/<token>/zip?names=a,b` | 用票据打包下载 |
| `GET /localsend/api/t/<token>/events` | 用票据建立 SSE（30 分钟过期，断线后会重新换票） |

> 票据只对签发时列出的文件有效：用途或文件不匹配会被拒绝；过期返回 401 且带 `ticketExpired: true`，页面据此重新换票并重试。

## 列表与筛选

| 接口 | 说明 |
| --- | --- |
| `GET /localsend/api/list` | 分页文件列表。参数：`page`、`pageSize`（默认 50，上限 500）、`q`（关键词，匹配相对路径）、`dir`（目录，`__root__` 表示根目录）、`ext`（扩展名）、`since`（只看该时间戳之后修改的文件，用于收件箱）、`sort`（`time`/`size`/`name`）、`order`（`asc`/`desc`） |
| `GET /localsend/api/facets` | 筛选选项，返回所有目录、扩展名及各自的条目数，供页面渲染筛选下拉 |

返回结构为 `{ items, total, page, pageSize, totalPages, allTotal }`，其中 `total` 是筛选后的条数，`allTotal` 是全部文件数。网页端只渲染当前页，选中状态跨页保留，全选范围为当前页。

## 文件整理

网页端可以直接整理存储目录里的文件，操作的都是**真实文件**（不引入任何元数据存储），整理结果在列表、回收站、分享链接与 WebDAV 中立即可见：

| 接口 | 说明 |
| --- | --- |
| `POST /localsend/api/rename` | 重命名或移动单个文件，传入 `from` 与 `to`；`to` 带目录即为跨目录移动 |
| `POST /localsend/api/move` | 批量移动，传入 `names` 与目标目录 `dir`（空或 `__root__` 表示根目录，目录不存在会自动创建） |
| `POST /localsend/api/rename-batch` | 按规则批量重命名，传入 `names` 与 `rule` |

批量重命名的 `rule` 支持四种模式，并可按扩展名限定处理范围：

| 模式 | 字段 | 说明 |
| --- | --- | --- |
| `prefix` | `prefix` | 在文件名之前添加前缀 |
| `suffix` | `suffix` | 在文件名之后添加后缀 |
| `replace` | `find`、`replace` | 按字面文本查找替换 |
| `sequence` | `start`、`padding`、`template` | 按序号重命名，模板中 `{n}` 代表序号、`{name}` 代表原文件名 |

另有 `ext` 字段可限定只处理某一类文件（如 `jpg`）。目标重名时自动追加 `_1` 后缀，与上传时的处理保持一致；批量重命名会先落到临时名再改回，避免「a→b、b→c」这类互相覆盖的情况。

## 分享与剪贴板

| 接口 | 说明 |
| --- | --- |
| `POST /localsend/api/share` | 创建分享，传入 `{ names: [...], ttl: 24 }`，`ttl` 单位为小时（默认 24，最长 7 天），返回链接与到期时间 |
| `POST /localsend/api/paste` | 剪贴板内容落盘成文件。`kind`：`text` / `image`；`content`：文本或图片 data URL；`strategy`：`hash`（默认）/ `timestamp` / `custom`；`name`：`custom` 策略下的文件名；`dir`：存放目录（相对存储目录，不存在时自动创建）。相同内容重复粘贴复用已有文件，返回 `reused: true` |

> 分享链接 `/localsend/s/<token>` 始终免登录。配置了访问令牌时，创建分享的接口仍需会话令牌（`X-Localsend-Session` 请求头）。
> 单个文本或图片的分享链接会直接在浏览器打开，需要强制下载时加 `?dl=1`；html 与 svg 不走内联，避免对方页面里的脚本以本站源执行。

## 分片上传

| 接口 | 说明 |
| --- | --- |
| `POST /localsend/api/chunk/init` | 初始化上传任务，传入 `name`、`size`、`chunkSize`；可再带 `uploadId`（上次的任务）或 `fileKey`（`名称:大小:修改时间` 指纹）复用任务，返回值里的 `received` 是已上传的分片索引、`resumed` 表示本次是否续传 |
| `POST /localsend/api/chunk/upload?uploadId=xxx&index=0` | 上传单个分片（`multipart`，字段名 `chunk`） |
| `GET /localsend/api/chunk/status?uploadId=xxx` | 查询已上传的分片索引 |
| `POST /localsend/api/chunk/merge?uploadId=xxx` | 合并全部分片为正式文件（流式写入，不阻塞事件循环） |
| `DELETE /localsend/api/chunk/cancel?uploadId=xxx` | 取消上传并清理分片 |

## 文件变更推送

| 接口 | 说明 |
| --- | --- |
| `GET /localsend/api/events` | SSE 事件流，把目录变化实时推送给页面（也可通过短期票据 `/localsend/api/t/<token>/events` 访问）。收到 `changed` 事件后刷新列表 |

```
event: changed
data: {"names":["photo.jpg","doc.pdf"]}
```

## 测速

| 接口 | 说明 |
| --- | --- |
| `GET /localsend/api/speed?size=10` | 下载测速，返回指定大小（MB，1~100）的数据 |
| `POST /localsend/api/speed` | 上传测速，接收请求体后直接丢弃（不落盘），返回接收字节数与耗时 |

## 审计与指标

两个仅管理员可用的接口，网页端工具栏的「🩺 诊断」面板是它们的组合：

| 接口 | 说明 |
| --- | --- |
| `GET /localsend/api/audit?limit=100` | 最近的操作记录（从新到旧）。每条含 `ts`、`ip`、`role`、`action`、`target`；`limit` 上限 500 |
| `GET /localsend/api/stats` | 运行指标：运行时长、内存、文件数/已用、缓存命中、限流次数、上传与合并计数、合并耗时 P50/P95、事件流连接数、票据与分享数量 |

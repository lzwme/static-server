[![@lzwme/sserver](https://nodei.co/npm/@lzwme/sserver.png)][npm-url]

# @lzwme/sserver

[![NPM version][npm-badge]][npm-url]
[![node version][node-badge]][node-url]
[![npm download][download-badge]][download-url]
[![GitHub issues][issues-badge]][issues-url]
[![GitHub forks][forks-badge]][forks-url]
[![GitHub stars][stars-badge]][stars-url]

一个基于 Node.js 的简易静态服务器，用于辅助开发调试随启随用。

```bash
# 快速启动一个静态服务器
npx @lzwme/sserver -d ./dist
```

## 安装

```bash
# 全局安装
npm i -g @lzwme/sserver
ss -h

# 或者在项目中安装
npm i -D @lzwme/sserver
npm exec ss -- -h

# 或者直接使用 `npx`
npx @lzwme/sserver -h
```

## 使用

示例：

```bash
# 以当前目录下的 dist 作为静态根目录
ss -d ./dist

# 启用 https
ss --https

# 启用 https，指定域名(默认为 localhost)
ss -H --host local.lzw.me

# 启用 https，并保存默认生成的 ssl 证书
ss -H --ssl-cache ./cache

# 开启 localsend 局域网文件传输功能
ss --localsend
```

### 配置代理转发

支持通过配置文件 `ss.config.js` 指定代理转发等详细配置规则。

```bash
# 在当前目录初始化一个 ss.config.js 配置文件
ss init

# 在用户目录初始化一个 ss.config.js 配置文件（作为所有目录的兜底配置）
ss init --global
```

#### 配置文件的加载位置与优先级

配置按以下顺序加载，**后者覆盖前者**（对象深合并，函数则整体覆盖）：

| 优先级 | 位置 | 说明 |
| --- | --- | --- |
| 1（最低） | 内置默认值 | 见 `ss.config.sample.js` 中的注释 |
| 2 | `~/.static-server/ss.config.js` | 用户级兜底配置，所有目录生效 |
| 3 | `<当前目录>/ss.config.js` | 项目级配置，仅当前目录生效 |
| 4（最高） | 命令行参数 | 如 `ss -p 8080` |

```bash
# 用户级配置目录：~/.static-server/
#   ss.config.js   —— 用户级兜底配置
#   localsend/     —— localsend 上传文件的存储目录
```

合并规则说明：

- 普通对象（如 `ssl`、`headers`、`localsend`）按 key 深度合并，只写要改的字段即可。
- `proxyConfig` 按 `api` 路径合并：同 `api` 的规则深度合并，后者覆盖前者；不同的 `api` 追加保留，因此用户级配置里的通用代理规则与项目级配置里的项目规则可以共存。
- `custom` 是函数，只能整体覆盖：当前目录配置里定义了 `custom` 时，用户级配置里的 `custom` 不再执行。
- 配置文件中的相对路径（如 `rootDir`）一律相对**当前工作目录**解析，用户级配置中建议使用绝对路径。
- 配置文件加载失败（语法错误等）时会输出错误提示并忽略该文件，不会导致服务启动失败。

配置文件内容示例：

```js
// ss.config.js

/** @type {import('@lzwme/sserver').SSConfig} */
module.exports = {
  port: 8888,
  https: false,
  sslCache: '',
  rootDir: '.',
  // 代理转发配置
  proxyConfig: [
    // 内网代理企业微信机器人接口示例
    {
      api: '/proxy/cgi-bin/webhook/send',
      config: {
        target: 'https://qyapi.weixin.qq.com',
        changeOrigin: true,
        pathRewrite: {
          '^/proxy/cgi-bin': '/cgi-bin',
        },
      },
    },
  ],
}
```

### LocalSend 局域网文件传输

开启后可通过 `http://<本机IP>:<port>/localsend` 访问，实现同网段设备间的文件快速传输（支持多文件上传/下载、实时进度、二维码扫码访问、扫码直连下载、文件预览、服务端分页搜索与文件整理等）：

下载时按文件大小自动分流：**大于 50MB 的文件**交由浏览器原生下载（流式写盘，内存占用恒定，不会因为大文件撑爆浏览器内存），**小文件**仍在页面内显示实时进度与速度；批量下载为串行执行，避免多个大文件同时占用内存。

```bash
# 命令行方式开启
ss --localsend

# 指定文件存储目录（也可用环境变量 SS_LOCALSEND_DIR 指定）
ss --localsend --localsend-dir /tmp/localsend
```

配置文件方式开启：

```js
// ss.config.js
module.exports = {
  port: 8888,
  localsend: {
    enabled: true,
    // 文件存储目录。默认 ~/.static-server/localsend，可用环境变量 SS_LOCALSEND_DIR 覆盖
    dir: '/tmp/localsend',
    // 单个文件上传大小限制（字节），默认 1GB
    maxSize: 1024 * 1024 * 1024,
    // 总容量上限（字节），0 表示不限制
    maxTotalSize: 0,
    // 访问令牌，配置后所有接口都需要携带 ?key=令牌
    token: '',
    // 单 IP 并发上传数上限，默认 3
    maxConcurrent: 3,
    // 频率限制：窗口毫秒数与窗口内最大请求数
    rateLimit: { windowMs: 60000, max: 120 },
    // 禁止上传的扩展名，默认拦截 .php/.sh 等服务端脚本
    blockExtensions: ['.php', '.phtml', '.sh'],
    // 回收站保留天数，默认 1 天
    trashDays: 1,
    // 自动清理：按天数与容量清理旧文件
    autoCleanDays: 0,
    autoCleanMaxSize: 0,
    // WebDAV 端点开关，默认开启
    webdav: true,
  },
};
```

#### 网页端能力

| 分类 | 能力 |
| --- | --- |
| 上传 | 多文件并发队列（自动退避重试）、上传整个文件夹并保留目录结构、拖拽整个文件夹、监听本地目录自动上传、大文件（>8MB）分片并发上传 |
| 下载 | 单文件下载、多文件服务端打包 zip、File System Access API 直存并显示实时进度、系统分享（手机端可发到微信/AirDrop） |
| 浏览 | 服务端分页（首页/末页/跳页/每页条数可调）、关键词搜索、按目录与文件类型筛选、排序偏好记忆、图片缩略图、目录结构标记、收件箱模式、文件到达实时通知（可发系统通知） |
| 整理 | 单个文件重命名、文件移动到目录、批量移动、批量重命名（前缀/后缀/查找替换/序号四种规则）、按扩展名限定处理范围 |
| 分享 | 分享链接（文本与图片可直接在浏览器打开）、剪贴板粘贴分享（Ctrl+V 分享文本或截图）、分享管理（查看/复制/二维码/撤销） |
| 预览 | 图片 / PDF / 音视频在弹窗内直接播放，文本预览带长度上限提示 |
| 其它 | 二维码扫码访问与扫码直连下载、传输测速、回收站还原、移动端列表优先布局、PWA（可安装到桌面、离线可打开页面） |

下载时按文件大小自动分流：**大于 50MB 的文件**交由浏览器原生下载（流式写盘，内存占用恒定，不会因为大文件撑爆浏览器内存），**小文件**仍在页面内显示实时进度与速度；批量下载为串行执行，避免多个大文件同时占用内存。

> 目录监听（自动上传）与 Service Worker 离线能力依赖浏览器特性：前者需要 Chrome / Edge 桌面版且处于安全上下文（https 或 localhost），后者在通过局域网 IP 的 http 地址访问时不会启用，这是浏览器的安全限制。

#### 访问防护

局域网工具默认不设防，但只要有人知道地址就能上传/下载/删除文件，因此提供三道可选防护（默认关闭，不改变现有使用习惯）：

- **访问令牌**：`token` 配置后，页面与所有接口都需要携带 `?key=令牌`（接口也可通过 `X-Localsend-Key` 请求头传递）；静态资源（样式、脚本、图标）不含用户数据，匿名即可访问。
- **频率限制**：`rateLimit` 限制单 IP 在滑动窗口内的请求数，超出返回 429。
- **并发限制**：`maxConcurrent` 限制单 IP 同时进行的上传数，超出返回 429（网页端会自动退避重试）。
- **类型拦截**：默认禁止上传 `.php`、`.phtml`、`.sh` 等服务端脚本，避免上传目录与静态服务根目录重叠时形成远程代码执行入口。
- **容量配额**：`maxTotalSize` 限制存储目录总容量，超出时拒绝写入并撤销本次上传。

#### 回收站

删除的文件不会立即消失，而是移入存储目录下的 `.trash` 内部目录，可通过网页端的回收站面板还原：

- 还原时若原位置已被占用会自动改名（如 `a.txt` → `a_1.txt`），不会覆盖现有文件。
- `.trash` 目录不出现在文件列表、WebDAV 目录与自动清理范围内。
- 保留时长由 `trashDays` 控制（默认 1 天），到期自动清理。

#### 自动清理

`autoCleanDays` 按文件最后修改时间清理过期文件，`autoCleanMaxSize` 在存储目录超过容量上限时从旧文件开始清理，避免接收端长期运行把磁盘撑满。

#### 分享链接

可通过接口创建带时效的分享链接，拿到链接的人无需访问令牌即可下载指定文件：

```bash
# 创建分享，返回链接与到期时间
curl -X POST 'http://127.0.0.1:8888/localsend/api/share' \
  -H 'Content-Type: application/json' -d '{"names":["a.txt","b.txt"],"ttl":24}'
```

`ttl` 单位为小时，默认 24 小时，最长 7 天。

单个文本或图片的分享链接会**直接在浏览器里打开**（扫一眼就能看到内容），需要强制下载时在链接后加 `?dl=1`。html 与 svg 不走内联，避免对方页面里的脚本以本站源执行。

网页端的「🔗 分享管理」可以列出已创建的分享链接，查看剩余有效期与访问次数，并随时复制、看二维码或撤销。

#### 剪贴板分享

分享原本只能分享「已经存在于存储目录里的文件」，想发一段文字或一张截图得先手动存成文件。`/api/paste` 接口把剪贴板内容直接落盘成普通文件，于是「粘贴即分享」成为可能：

```bash
# 文本
curl -X POST 'http://127.0.0.1:8888/localsend/api/paste' \
  -H 'Content-Type: application/json' -d '{"kind":"text","content":"要分享的文字"}'

# 图片（data URL）
curl -X POST 'http://127.0.0.1:8888/localsend/api/paste' \
  -H 'Content-Type: application/json' -d '{"kind":"image","content":"data:image/png;base64,..."}'
```

| 参数 | 说明 |
| --- | --- |
| `kind` | `text`（纯文本）或 `image`（图片 data URL，支持 png/jpg/webp/gif/bmp/avif） |
| `content` | 文本内容或图片的 data URL |
| `strategy` | 命名策略：`hash`（默认）、`timestamp`、`custom` |
| `name` | `custom` 策略下的文件名 |
| `dir` | 存放目录（相对存储目录），不存在时自动创建 |

三种命名策略：

| 策略 | 生成结果 | 说明 |
| --- | --- | --- |
| `hash` | `文本-3d98abc6.txt` | 内容 md5 前 8 位，同内容天然同名 |
| `timestamp` | `文本-20261118-221530.txt` | 一眼看出粘贴时间 |
| `custom` | `我的笔记.txt` | 完全自定义，缺扩展名时自动补上 |

相同内容重复粘贴时会**复用已有文件**而不是产生副本，接口返回 `reused: true` 供页面提示。

落盘后即可用既有的 `/api/share` 接口生成分享链接。网页端在页面任意处按 `Ctrl+V` 即可分享：文本会弹出编辑框确认，截图直接存为图片并生成链接。

#### WebDAV 网络盘

开启 localsend 后，同时提供一个 WebDAV 端点，可把存储目录挂载成网络盘（Windows 资源管理器、macOS 访达、iOS「文件」App、安卓文件管理器均可挂载）：

```
http://<本机IP>:<port>/localsend/dav
```

- 支持 `OPTIONS` / `PROPFIND` / `GET` / `HEAD` / `PUT` / `DELETE` / `MKCOL` / `COPY` / `MOVE`，可正常浏览目录、拖拽上传、下载与删除。
- 配置了 `token` 时，WebDAV 使用 **Basic Auth** 认证（用户名为 `localsend`，密码为令牌）；未配置令牌时局域网内可直接挂载。
- 上传同样受 `blockExtensions`（默认拦截 `.php`、`.sh` 等服务端脚本）、`maxSize` 与 `maxTotalSize` 约束，与网页上传接口一致。
- 不需要时可在配置里关闭：

```js
localsend: {
  enabled: true,
  webdav: false, // 关闭 WebDAV 端点（默认开启）
},
```

中文文件名上传后显示乱码时（多见于旧版本上传的文件），可用以下命令批量修复存储目录中的乱码文件名：

```bash
# 修复存储目录中的乱码文件名（默认使用配置中的目录，也可用 --localsend-dir 指定）
ss fix-localsend-names
```

#### 分片上传与断点续传

大文件在弱网环境下常传到一半就断线，整包重传代价很大。服务端提供了分片上传接口，客户端可只补传缺失的分片：

| 接口 | 说明 |
| --- | --- |
| `POST /localsend/api/chunk/init` | 初始化上传任务，传入 `name`、`size`、`chunkSize`，返回 `uploadId` 与分片总数 |
| `POST /localsend/api/chunk/upload?uploadId=xxx&index=0` | 上传单个分片（`multipart`，字段名 `chunk`） |
| `GET /localsend/api/chunk/status?uploadId=xxx` | 查询已上传的分片索引，用于断点续传 |
| `POST /localsend/api/chunk/merge?uploadId=xxx` | 合并全部分片为正式文件 |
| `DELETE /localsend/api/chunk/cancel?uploadId=xxx` | 取消上传并清理分片 |

分片暂存在存储目录下的 `.chunks` 内部目录中，不会出现在文件列表、WebDAV 目录或自动清理范围内；合并完成后分片会自动删除。

#### 文件列表缓存与分页搜索

存储目录中文件较多时，每次打开列表都递归扫描一遍会明显拖慢响应。服务端对此做了两层优化：

- 首次访问全量扫描后驻留内存，后续请求直接读缓存；
- 通过 `fs.watch` 监听目录变化做增量更新，局域网内其它设备上传的文件也能实时出现在列表中。

上传、删除等写操作会主动让缓存失效，保证界面立即反映最新状态；缓存另有 5 分钟的兜底校准周期，防止个别文件系统事件丢失。

在此基础上，列表接口把「关键词、目录、扩展名、时间窗」等筛选条件全部下推到服务端，只返回当前需要的那一页，文件再多也不会把浏览器压垮：

| 接口 | 说明 |
| --- | --- |
| `GET /localsend/api/list` | 分页文件列表。参数：`page`、`pageSize`（默认 50，上限 500）、`q`（关键词，匹配相对路径）、`dir`（目录，`__root__` 表示根目录）、`ext`（扩展名）、`since`（只看该时间戳之后修改的文件，用于收件箱）、`sort`（`time`/`size`）、`order`（`asc`/`desc`） |
| `GET /localsend/api/facets` | 筛选选项，返回所有目录、扩展名及各自的条目数，供页面渲染筛选下拉 |

返回结构为 `{ items, total, page, pageSize, totalPages, allTotal }`，其中 `total` 是筛选后的条数，`allTotal` 是全部文件数。网页端只渲染当前页，选中状态跨页保留，全选范围为当前页。

#### 文件整理（重命名 / 移动 / 批量重命名）

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

#### 文件变更推送

服务端通过 SSE（`GET /localsend/api/events`）把目录变化实时推送给页面，手机端放一台「接文件」的设备时，不用手动刷新就能知道来新文件：

```
event: changed
data: {"names":["photo.jpg","doc.pdf"]}
```

网页端收到推送后会刷新列表、弹出提示并发送系统通知（需用户授权）；本机自己上传的文件不会触发提醒。

#### 传输测速

局域网速度受路由器、频段与负载影响较大，提供测速接口用于判断当前链路质量：

| 接口 | 说明 |
| --- | --- |
| `GET /localsend/api/speed?size=10` | 下载测速，返回指定大小（MB，1~100）的数据 |
| `POST /localsend/api/speed` | 上传测速，接收请求体后直接丢弃（不落盘），返回接收字节数与耗时 |

网页端工具栏的「🚀 测速」按钮会分别测量上下行速度并给出结果。

## 开发

本地二次开发：

```bash
git clone https://github.com/lzwme/static-server.git
pnpm install
pnpm build

# dev（使用 bun 直接运行 TypeScript 源码，无需编译；需先安装 bun）
pnpm dev

# 改动源码后自动重启
pnpm dev:watch

# 类型检查
pnpm typecheck

# 代码检查
pnpm lint

# 自动化测试（会先构建再运行）
pnpm test

# global link
npm link
```

开发模式依赖 [bun](https://bun.sh/)（`bun run src/cli.ts` 直接执行 TS 源码），不再依赖 ts-node。

### 自动化测试

测试使用 Node 内置的测试运行器，不引入额外依赖，运行在编译产物（`dist`）之上：

```bash
pnpm test                    # 构建后运行全部用例
node --test test/paths.test.js   # 只跑某个文件
```

用例覆盖路径安全、访问防护、分片暂存、回收站、列表查询与分页、文件整理、剪贴板分享，以及通过真实 HTTP 访问的上传、下载、预览、打包、测速、分享、WebDAV 与 SSE 等接口。

或者 fork 本项目进行代码贡献。

**欢迎贡献想法与代码。**

## License

`@lzwme/sserver` is released under the MIT license.

该插件由[志文工作室](https://lzw.me)开发和维护。


[stars-badge]: https://img.shields.io/github/stars/lzwme/static-server.svg
[stars-url]: https://github.com/lzwme/static-server/stargazers
[forks-badge]: https://img.shields.io/github/forks/lzwme/static-server.svg
[forks-url]: https://github.com/lzwme/static-server/network
[issues-badge]: https://img.shields.io/github/issues/lzwme/static-server.svg
[issues-url]: https://github.com/lzwme/static-server/issues
[npm-badge]: https://img.shields.io/npm/v/@lzwme/sserver.svg?style=flat-square
[npm-url]: https://npmjs.org/package/@lzwme/sserver
[node-badge]: https://img.shields.io/badge/node.js-%3E=_10.0.0-green.svg?style=flat-square
[node-url]: https://nodejs.org/download/
[download-badge]: https://img.shields.io/npm/dm/@lzwme/sserver.svg?style=flat-square
[download-url]: https://npmjs.org/package/@lzwme/sserver
[bundlephobia-url]: https://bundlephobia.com/result?p=@lzwme/sserver@latest
[bundlephobia-badge]: https://badgen.net/bundlephobia/minzip/@lzwme/sserver@latest

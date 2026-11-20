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
    // 访问令牌，配置后访问页面时需要输入令牌换取会话
    token: '',
    // 管理员口令：可删除文件、整理目录、撤销分享
    password: '',
    // 访客口令（可选）：设置后上传下载也需要口令；留空则谁都能上传下载
    visitorPassword: '',
    // 登录会话有效期（毫秒），默认 24 小时
    sessionTtl: 24 * 60 * 60 * 1000,
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
| 上传 | 多文件并发队列（自动退避重试）、上传可取消/失败可重试、上传目标跟随当前目录、上传整个文件夹并保留目录结构、拖拽整个文件夹、监听本地目录自动上传、大文件（>8MB）分片并发上传并支持断点续传 |
| 下载 | 单文件下载、多文件服务端打包 zip、File System Access API 直存并显示实时进度、系统分享（手机端可发到微信/AirDrop） |
| 浏览 | 服务端分页（首页/末页/跳页/每页条数可调）、关键词搜索、按目录与文件类型筛选、排序偏好记忆、图片缩略图、目录结构标记、收件箱模式、文件到达实时通知（可发系统通知）、存储用量与回收站占用 |
| 整理 | 单个文件重命名、文件移动到目录、批量移动、批量重命名（前缀/后缀/查找替换/序号四种规则）、按扩展名限定处理范围 |
| 分享 | 分享链接（文本与图片可直接在浏览器打开）、扫码分享、剪贴板粘贴分享（Ctrl+V 分享文本或截图）、分享管理（查看/复制/二维码/撤销） |
| 权限 | 口令 / 访问令牌统一登录入口（一个输入框）、管理员/访客/只读身份分级、危险操作按身份隐藏、权限不足自动引导登录 |
| 设置 | 网页端设置面板（管理员可在线改口令、令牌、限流、配额与清理策略，改完立即生效；未设口令时仅限本机修改） |
| 预览 | 图片 / PDF / 音视频在弹窗内直接播放，文本预览带长度上限提示并可一键复制 |
| 其它 | 多网卡地址切换与二维码、首屏三步引导与存储信息、传输测速、回收站还原、移动端「主操作 + 更多」布局、PWA（可安装到桌面、离线可打开页面） |

下载时按文件大小自动分流：**大于 50MB 的文件**交由浏览器原生下载（流式写盘，内存占用恒定，不会因为大文件撑爆浏览器内存），**小文件**仍在页面内显示实时进度与速度；批量下载为串行执行，避免多个大文件同时占用内存。

服务端打包的 zip 使用 UTF-8 文件名并置 EFS 标志位，含中文的文件名在各平台解压后不会乱码。

> 下载、预览、打包与事件流的 URL 由浏览器直接发起（带不了请求头），因此改用**短期票据**：页面先换一张只对指定文件有效、2 分钟过期的票据，再访问 `/localsend/api/t/<token>/...`。这样复制出去的链接不会带上会话令牌，视频拖动进度条、断点下载也能复用同一张票据。

#### 手机端能力与 HTTPS

手机通过局域网 IP 以 `http://` 访问时属于浏览器的「非安全上下文」，部分能力会被禁用。这会在页面顶部以提示条说明（可关闭），也可以先看这张表：

| 能力 | http 访问 | https 访问 |
| --- | --- | --- |
| 上传 / 下载 / 预览 / 整理 / 分享 | ✅ | ✅ |
| 安装到桌面（PWA）、离线打开页面 | ❌ | ✅ |
| 剪贴板读写（Ctrl+V 粘贴分享、一键复制） | ❌（复制会回退到 `execCommand`） | ✅ |
| 目录监听自动上传、直写磁盘、系统分享、系统通知 | ❌ | ✅ |

需要这些能力时启用 HTTPS（自签证书）：

```bash
# --https 会按 --host 生成证书；用 IP 访问时建议把 host 设成该 IP
ss --localsend --https --host 192.168.1.20 --ssl-cache ~/.static-server/ssl
```

首次访问需要在手机上信任一次自签证书（否则浏览器会拦截）。也可以改用 mkcert 生成受信任的证书并在 `ss.config.js` 里配置 `https` 与 `ssl`。

#### 访问防护

局域网工具默认不设防，但只要有人知道地址就能上传/下载/删除文件，因此提供多层可选防护（默认关闭，不改变现有使用习惯）：

- **访问令牌**：`token` 配置后，页面照常加载，但接口需要先输入令牌换取会话令牌；令牌不再出现在地址栏里，脚本客户端也可以把令牌摘要放在 `X-Localsend-Key` 请求头里。
- **访问口令**：`password` / `visitorPassword` 配置后，删除与整理等危险操作需要登录管理员身份，详见下文「访问密码与权限分级」。
- **频率限制**：`rateLimit` 限制单 IP 在滑动窗口内的请求数，超出返回 429。
- **并发限制**：`maxConcurrent` 限制单 IP 同时进行的上传数，超出返回 429（网页端会自动退避重试）。
- **类型拦截**：默认禁止上传 `.php`、`.phtml`、`.sh` 等服务端脚本，避免上传目录与静态服务根目录重叠时形成远程代码执行入口。
- **容量配额**：`maxTotalSize` 限制存储目录总容量（**递归统计子目录**，不含回收站与分片暂存），超出时拒绝写入并撤销本次上传。
- **设置写入**：未配置任何口令或令牌（开放模式）时，设置面板的保存只接受**本机**（回环地址）发起的请求；想远程管理请先在配置文件里设置 `password`。否则局域网内任何人都能匿名设一个管理员口令，随后以管理员身份删光文件、把原使用者锁在门外。

#### 访问密码与权限分级

站点级 `token` 是「大门锁」，配置后所有人拿到的是同一把钥匙。如果还需要区分「谁能删文件、谁能整理目录」，可以在令牌之下再叠一层身份口令。两者可独立使用：只配 `token` 则全站需先输入令牌换取会话（换到的人等同管理员）；配了管理员口令后，未登录的人默认可以上传下载（删除与整理仍需登录）；若另外配置了访客口令，则上传下载也必须先输入口令。

```js
// ss.config.js
module.exports = {
  localsend: {
    enabled: true,
    // 管理员口令：可删除文件、整理目录、撤销分享
    password: 'your-admin-password',
    // 访客口令（可选）：设置后上传下载也需要口令；留空则谁都能上传下载
    visitorPassword: 'your-visitor-password',
    // 登录会话有效期（毫秒），默认 24 小时
    sessionTtl: 24 * 60 * 60 * 1000,
  },
};
```

| 身份 | 触发方式 | 浏览下载 | 上传 / 粘贴 / 分享 | 删除 / 整理 / 撤销分享 |
| --- | --- | --- | --- | --- |
| 开放 | 未配置任何口令 | ✅ | ✅ | ✅ |
| 未登录 | 只配了管理员口令，未登录 | ✅ | ✅ | ❌ |
| 只读 | 配了访客口令但未登录 | ✅ | ❌ | ❌ |
| 访客 | 用访客口令登录 | ✅ | ✅ | ❌ |
| 管理员 | 用管理员口令登录 | ✅ | ✅ | ✅ |

几点说明：

- **默认保持开放**：不配置口令时行为与之前完全一致，不会打断现有用法；收紧需要主动配置。
- **访客口令为空即开放上传**：只配置管理员口令时，未登录的人也能上传与下载（危险操作仍然拦截）；一旦配置访客口令，上传、粘贴、分享都会要求先输入口令。
- **口令与令牌只走摘要**：浏览器用服务端公开的盐值把口令/令牌派生成 PBKDF2 摘要后再提交，明文永不上网，服务端只保存摘要；地址栏、二维码、网关日志里都不会出现口令或令牌。
- **会话而非每次传口令**：口令只在登录时提交一次，服务端签发会话令牌（请求头 `X-Localsend-Session`）；会话存在内存中，服务重启即失效，需要重新登录。访问令牌同理：输入一次即可换取会话，之后请求里只有会话标识。
- **会话失效会被明确识别**：接口返回 401 时会区分两种情况 —— `needToken`（没带凭证，需要输入访问令牌）与 `needLogin`（带了会话但服务端不认，例如口令已变更、会话过期、服务重启）。网页端据此弹出对应的重新认证入口，不会继续拿失效会话发请求。
- **口令只走配置文件**：命令行参数会出现在进程列表与 shell 历史中，因此不提供 `--localsend-password` 之类的开关。
- **网页端按身份显示**：只读身份隐藏上传区与粘贴入口，访客隐藏重命名、移动、删除等危险按钮；被服务端拒绝的操作会自动弹出登录框。
- **认证失效即停**：网页端把 401 当作异常终止 —— 清掉失效会话、断开事件流、停掉后台定时器，并在重新认证成功前不再发出任何请求。这样即使令牌或口令在别处被改动，正在打开的页面也只会安静地提示重新认证，而不会反复重试打满频率限制。
- **分享链接始终免登录**：`/localsend/s/<token>` 是分享的核心价值，不受口令与令牌影响。
- **WebDAV 只能用明文**：资源管理器等客户端只会发 Basic Auth，服务端用同一套盐值现场算摘要再比对；这是唯一还会出现明文口令的地方。

> 只配置 `visitorPassword` 而不配置 `password` 时，删除与整理将无法执行（没有能拿到管理员身份的口令），启动日志会给出提示。

相关接口：

| 接口 | 说明 |
| --- | --- |
| `GET /localsend/api/auth/salt` | 取回各密钥的公开盐值与迭代次数（客户端据此派生摘要） |
| `POST /localsend/api/auth/login` | 提交摘要并返回会话令牌与身份。`digests` 可同时带 `password`、`visitorPassword`、`token`，由服务端判断匹配哪一种，返回的 `via` 表示本次使用的凭据类型 |
| `POST /localsend/api/auth/token` | 只提交访问令牌摘要换取会话（脚本客户端用） |
| `POST /localsend/api/logout` | 注销当前会话 |
| `GET /localsend/api/session` | 查询当前身份（角色、是否开放模式、是否配置了口令、会话是否仍然有效） |

> 网页端只显示**一个**输入框：口令与访问令牌的摘要一起提交，用户不必先分辨自己手里拿的是哪一种。服务端已配置的凭据类型（`hasAdmin` / `hasVisitor` / `hasToken`）会用于生成输入框提示。

未授权时的 401 响应带一个标记字段，用于区分「从未认证」与「认证已失效」（网页端已统一为一个认证入口，这两个字段主要供脚本客户端区分处理）：

```jsonc
// 没带任何凭证（或令牌不对）：需要输入访问令牌
{ "code": 1, "msg": "需要访问令牌", "needToken": true }
// 带了会话但服务端不认（口令已变更 / 会话过期 / 服务重启）：需要重新登录
{ "code": 1, "msg": "会话已失效，请重新登录", "needLogin": true }
```

> 认证接口（取盐值、登录、换令牌）同样受频率限制保护：摘要比对要跑 PBKDF2，不限流的话一次重复提交就能把服务端的 CPU 打满。

#### 配置在哪里改

LocalSend 的配置有三个来源，优先级由低到高：

| 来源 | 位置 | 说明 |
| --- | --- | --- |
| 内置默认值 | — | 见下表「默认值」列 |
| 用户级配置文件 | `~/.static-server/ss.config.js` | 所有目录共用的兜底配置 |
| 当前目录配置文件 | `./ss.config.js` | 启动目录下的配置，优先级更高 |
| 运行时设置 | `~/.static-server/localsend-settings.json` | 网页端设置面板改出来的值，优先级最高 |

另外 `dir` 还可以用环境变量 `SS_LOCALSEND_DIR` 指定（优先级高于配置文件），运行时设置文件的位置可用 `SS_LOCALSEND_SETTINGS` 指定。

**哪些能在线改、哪些必须重启：**

| 配置项 | 运行时可改 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `token` 访问令牌 | ✅ | 空 | 修改后旧令牌立即失效，需重新输入令牌 |
| `password` 管理员口令 | ✅ | 空 | 修改需验证当前口令，其它会话随即失效（已打开的页面会提示重新登录） |
| `visitorPassword` 访客口令 | ✅ | 空 | 同上 |
| `sessionTtl` 会话有效期 | ✅ | 24 小时 | 只影响之后签发的会话 |
| `maxSize` 单文件上限 | ✅ | 1GB | 0 表示不限制 |
| `maxTotalSize` 容量上限 | ✅ | 0 | 0 表示不限制 |
| `maxConcurrent` 并发上传数 | ✅ | 3 | 0 表示不限制 |
| `rateLimit` 频率限制 | ✅ | 120 次 / 60 秒 | 0 表示不限制 |
| `blockExtensions` 禁止扩展名 | ✅ | 常见服务端脚本 | 留空表示不拦截 |
| `trashDays` 回收站保留天数 | ✅ | 1 天 | |
| `autoCleanDays` 自动清理天数 | ✅ | 0（关闭） | |
| `autoCleanMaxSize` 自动清理容量 | ✅ | 0（关闭） | |
| `dir` 文件存储目录 | ❌ | `~/.static-server/localsend` | 与已存文件位置绑定，需改配置后重启 |
| `webdav` 网络盘开关 | ❌ | 开启 | 路由在启动时注册，需重启 |
| `port` / `rootDir` / `https` 等站点级 | ❌ | — | 属于站点配置，需重启 |

**网页端设置面板**：管理员登录后，工具栏会出现「⚙️ 设置」，可在线修改上表中所有「运行时可改」的项目，改完立即生效，无需重启服务。

- 面板按「访问控制 / 传输限制 / 文件维护」分组；敏感项只显示掩码，留空表示不修改，可用「清除」按钮停用该项。
- 数值项按 MB、小时等直观单位显示，提交时自动换算回原始单位。
- 只提交改动过的项；改动过的项会标上「运行时」，可单独「恢复默认」回到配置文件里的值。
- 修改口令需要额外填写当前管理员口令，避免会话被劫持后直接改掉口令；提交的同样是它的摘要。
- 修改访问令牌后，页面会自动用新令牌换取一个新的会话，旧令牌随即失效。

**优先级规则**：配置文件是「出厂设置」，运行时设置是「临时调整」。若管理员改完运行时设置后，又去改了配置文件里的同一项，则以配置文件为准，该项的运行时覆盖会被自动放弃 —— 这样「改了配置文件却不生效」的困惑就不会出现。

> 运行时设置文件里明文保存了口令与令牌，与配置文件的安全性同级；它位于用户主目录下的 `~/.static-server/`，请勿提交到代码仓库。

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

> 配置了访问令牌时，创建分享的接口同样需要会话令牌（`X-Localsend-Session` 请求头）；但拿到分享链接的人依旧无需登录即可下载。

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
- 配置了 `token` 时，WebDAV 使用 **Basic Auth** 认证（用户名为 `localsend`，密码为令牌）；未配置令牌时局域网内可直接挂载。Basic Auth 只能传明文，服务端会用同一套盐值现场算摘要再比对，明文不会离开客户端之外的地方。
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

大文件在弱网环境下常传到一半就断线，整包重传代价很大。服务端提供分片上传接口，**元信息落盘**，因此断线、刷新页面乃至服务重启之后都能接着传：

| 接口 | 说明 |
| --- | --- |
| `POST /localsend/api/chunk/init` | 初始化上传任务，传入 `name`、`size`、`chunkSize`；可再带 `uploadId`（上次的任务）或 `fileKey`（`名称:大小:修改时间` 指纹）复用任务，返回值里的 `received` 是已上传的分片索引、`resumed` 表示本次是否续传 |
| `POST /localsend/api/chunk/upload?uploadId=xxx&index=0` | 上传单个分片（`multipart`，字段名 `chunk`） |
| `GET /localsend/api/chunk/status?uploadId=xxx` | 查询已上传的分片索引 |
| `POST /localsend/api/chunk/merge?uploadId=xxx` | 合并全部分片为正式文件（流式写入，不阻塞事件循环） |
| `DELETE /localsend/api/chunk/cancel?uploadId=xxx` | 取消上传并清理分片 |

分片暂存在存储目录下的 `.chunks` 内部目录中，不会出现在文件列表、WebDAV 目录或自动清理范围内；合并完成后分片与元信息会自动删除。

几点约定：

- **只复用同名同大小的任务**：内容变了的同名文件不会被续到一起；分片已被清空的任务也不会复用，避免客户端拿着死 ID 反复重试。
- **网页端自动续传**：把 `uploadId` 按文件指纹记在浏览器里（最多 20 条），重连后先 `init` 拿回已传分片，只补传缺失部分，并提示「继续上传（已传 x/y）」。
- **分片有独立的限流与并发预算**：分片按「片」发请求，1GB 文件就是 256 个请求；与普通接口共用一个频率窗口会导致「越大越传不完」，因此单独计费（默认按完整上传所需分片数 × 2 + 50 给预算）。
- **合并是流式的**：逐片边读边写，先写 `.merging` 临时文件，校验大小后再转正，中断不会留下半截文件，也不会在合并 1GB 文件时卡住其它请求。

#### 文件列表缓存与分页搜索

存储目录中文件较多时，每次打开列表都递归扫描一遍会明显拖慢响应。服务端对此做了两层优化：

- 首次访问全量扫描后驻留内存，后续请求直接读缓存；
- 通过 `fs.watch` 监听目录变化做增量更新（默认覆盖根目录与向下 3 层、最多 64 个目录，更深的层级由 TTL 兜底），局域网内其它设备上传的文件也能实时出现在列表中。

上传、删除等写操作会主动让缓存失效，保证界面立即反映最新状态；缓存另有 5 分钟的兜底校准周期，防止个别文件系统事件丢失。

在此基础上，列表接口把「关键词、目录、扩展名、时间窗」等筛选条件全部下推到服务端，只返回当前需要的那一页，文件再多也不会把浏览器压垮：

| 接口 | 说明 |
| --- | --- |
| `GET /localsend/api/list` | 分页文件列表。参数：`page`、`pageSize`（默认 50，上限 500）、`q`（关键词，匹配相对路径）、`dir`（目录，`__root__` 表示根目录）、`ext`（扩展名）、`since`（只看该时间戳之后修改的文件，用于收件箱）、`sort`（`time`/`size`/`name`）、`order`（`asc`/`desc`） |
| `GET /localsend/api/facets` | 筛选选项，返回所有目录、扩展名及各自的条目数，供页面渲染筛选下拉 |

返回结构为 `{ items, total, page, pageSize, totalPages, allTotal }`，其中 `total` 是筛选后的条数，`allTotal` 是全部文件数。网页端只渲染当前页，选中状态跨页保留，全选范围为当前页。

#### 上传目标、用量与访问地址

| 接口 | 说明 |
| --- | --- |
| `POST /localsend/api/upload?dir=归档/2026` | 多文件上传（`multipart`，字段名 `files`）。`dir` 指定目标目录，省略则落根目录；文件名中的子路径（上传文件夹）会拼在目标目录之后。`dir` 非法时直接 400，不会静默落到根目录 |
| `GET /localsend/api/usage` | 存储用量：`used`、`limit`、`files`、`trash`、`trashCount`，以及 `trashDays`、`autoCleanDays`、`maxSize`；`dir`（本机存储路径）只对管理员返回 |
| `GET /localsend/api/network` | 候选访问地址（免鉴权）：`addresses`（地址 + 网卡名）、`suggested`、`loopback`，供页面生成与切换二维码；多网卡机器不会再把 WSL / Docker 的地址当成唯一入口 |
| `POST /localsend/api/ticket` | 换短期票据：`{ scope: 'download' \| 'preview' \| 'zip' \| 'events', names: [...] }`，返回 `token` 与 `expiresAt` |
| `GET /localsend/api/t/<token>/download/<name>` | 用票据下载（无需会话，文件类票据 2 分钟过期） |
| `GET /localsend/api/t/<token>/preview/<name>` | 用票据预览（支持 Range，视频可拖动） |
| `GET /localsend/api/t/<token>/zip?names=a,b` | 用票据打包下载 |
| `GET /localsend/api/t/<token>/events` | 用票据建立 SSE（30 分钟过期，断线后会重新换票） |

> 票据只对签发时列出的文件有效：用途或文件不匹配会被拒绝；过期返回 401 且带 `ticketExpired: true`，页面据此重新换票并重试。

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

#### 审计与运行指标

局域网工具最常被问的两个问题是「谁把文件删了」与「为什么大家传不上去」。服务端为此提供两个仅管理员可用的接口，网页端工具栏的「🩺 诊断」面板就是它们的组合：

| 接口 | 说明 |
| --- | --- |
| `GET /localsend/api/audit?limit=100` | 最近的操作记录（从新到旧）。每条含 `ts`、`ip`、`role`、`action`、`target`；`limit` 上限 500 |
| `GET /localsend/api/stats` | 运行指标：运行时长、内存、文件数/已用、缓存命中、限流次数、上传与合并计数、合并耗时 P50/P95、事件流连接数、票据与分享数量 |

审计只记录**改动性操作**：删除、批量删除、重命名、移动、批量重命名、回收站还原/彻底删除/清空、创建与撤销分享、修改与恢复设置、登录成功与失败，以及 WebDAV 侧的上传/删除/建目录/移动/复制。浏览与下载不记录，避免日志被正常使用刷满。

- 日志是 JSON Lines，默认 `~/.static-server/localsend-audit.log`（可用 `SS_LOCALSEND_AUDIT` 指定），单文件超过 5MB 轮转为 `.1`，只保留一份历史；
- 写在**用户配置目录**而不是存储目录，因此不会出现在文件列表、不计入配额、不被自动清理，也不会被「清空回收站」带走；
- 不记录口令、令牌与会话，只记角色与动作。

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

### 目录结构与构建产物

`src/` 按「功能」划分目录，localsend 作为一个完整功能独立维护，其内部再分服务端代码、前端资源与样式入口：

```
src/localsend/           localsend 功能目录
  index.ts               服务端主模块（路由、静态资源挂载）
  auth.ts cache.ts ...   服务端子模块（去掉冗余的 localsend- 前缀）
  client/                前端页面资源：index.html / app.js / sw.js / manifest / icons/ ...（随包发布）
  styles/input.css       Tailwind 样式入口，仅构建期使用，不随包发布
src/lib/                 通用库：get-cert.ts / merge-config.ts / mkcert.ts / utils.ts
assets/localsend/        构建产物：style.css（由 input.css 编译）、vendor/qr-code-styling.js
dist/                    发布物：localsend/ + lib/ + assets/（构建时从上述各处拷贝而来）
```

`assets/` 由构建脚本生成并已通过 `.gitignore` 排除，不纳入 git 管理。构建时先由 `pnpm build:css` 编译样式、`pnpm build:vendor` 拷贝 vendor 库，再由 `pnpm build` 统一拷贝到 `dist/`，顺序不可颠倒（`scripts/copy-assets.js` 会先清空目标目录）。产物由构建生成，`pnpm dev` 会自动先执行 `build:assets`，无需手动准备。

发布物只包含运行期真正需要的文件：`scripts/copy-assets.js` 只拷贝 `src/localsend/client` 与 `assets/`，服务端源码（`.ts`）与样式入口（`input.css`）都不会进入 `dist/`。

`dist/` 的目录结构与 `src/` 保持镜像（`src/localsend/client` → `dist/localsend/client`），因此服务端用同一条相对路径就能在开发态与运行态下都定位到页面资源。构建产物则按运行时目录特征自动识别——从运行目录逐级向上找第一个包含 `style.css` 的 `assets` 目录：

- **运行态**（模块位于 `dist/localsend/`）：命中 `dist/assets/localsend`，发布包自带全部前端资源，开箱即用
- **开发态**（模块位于 `src/localsend/`）：命中仓库根的 `assets/localsend`

页面 URL 不受影响，仍是 `/localsend/style.css`。

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

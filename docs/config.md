# 配置参考

sserver 零配置即可运行。需要定制端口、HTTPS、代理转发或 LocalSend 行为时，通过配置文件 `ss.config.js` 完成。命令行参数优先级最高。

## 初始化配置文件

```bash
# 当前目录生成 ss.config.js
ss init

# 用户级目录生成（~/.static-server/ss.config.js，作为所有目录的兜底配置）
ss init --global
```

## 加载位置与优先级

配置按以下顺序加载，**后者覆盖前者**（对象深合并，函数整体覆盖）：

| 优先级 | 位置 | 说明 |
| --- | --- | --- |
| 1（最低） | 内置默认值 | 见 `ss.config.sample.js` 中的注释 |
| 2 | `~/.static-server/ss.config.js` | 用户级兜底配置，所有目录生效 |
| 3 | `<当前目录>/ss.config.js` | 项目级配置，仅当前目录生效 |
| 4（最高） | 命令行参数 | 如 `ss -p 8080` |

```bash
# 用户级配置目录：~/.static-server/
#   ss.config.js              —— 用户级兜底配置
#   localsend/                —— localsend 上传文件的存储目录
#   localsend-settings.json   —— 网页端设置面板改出来的运行时设置
#   localsend-audit.log       —— 操作审计日志
```

合并规则：

- 普通对象（如 `ssl`、`headers`、`localsend`）按 key 深度合并，只写要改的字段即可。
- `proxyConfig` 按 `api` 路径合并：同 `api` 的规则深度合并，后者覆盖前者；不同的 `api` 追加保留。因此用户级配置里的通用代理规则与项目级配置里的项目规则可以共存。
- `custom` 是函数，只能整体覆盖：当前目录配置里定义了 `custom` 时，用户级配置里的 `custom` 不再执行。
- 配置文件中的相对路径（如 `rootDir`）一律相对**当前工作目录**解析，用户级配置中建议使用绝对路径。
- 配置文件加载失败（语法错误等）时会输出错误提示并忽略该文件，不会导致服务启动失败。

## 站点配置

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
};
```

## LocalSend 配置

命令行只需 `--localsend` 即可开启。需要定制时用配置文件：

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

也可用命令行开启并指定存储目录：

```bash
ss --localsend
# 指定文件存储目录（也可用环境变量 SS_LOCALSEND_DIR 指定）
ss --localsend --localsend-dir /tmp/localsend
```

## 配置在哪里改

LocalSend 的配置有四个来源，优先级由低到高：

| 来源 | 位置 | 说明 |
| --- | --- | --- |
| 内置默认值 | — | 见下方「默认值」列 |
| 用户级配置文件 | `~/.static-server/ss.config.js` | 所有目录共用的兜底配置 |
| 当前目录配置文件 | `./ss.config.js` | 启动目录下的配置，优先级更高 |
| 运行时设置 | `~/.static-server/localsend-settings.json` | 网页端设置面板改出来的值，优先级最高 |

另外 `dir` 还可以用环境变量 `SS_LOCALSEND_DIR` 指定（优先级高于配置文件），运行时设置文件的位置可用 `SS_LOCALSEND_SETTINGS` 指定。

### 哪些能在线改、哪些必须重启

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

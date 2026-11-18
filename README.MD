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

开启后可通过 `http://<本机IP>:<port>/localsend` 访问，实现同网段设备间的文件快速传输（支持多文件上传/下载、实时进度、二维码扫码访问、扫码直连下载、文件预览与排序等）：

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
  },
};
```

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

# global link
npm link
```

开发模式依赖 [bun](https://bun.sh/)（`bun run src/cli.ts` 直接执行 TS 源码），不再依赖 ts-node。

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

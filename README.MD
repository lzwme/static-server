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
```

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

## 开发

本地二次开发：

```bash
git clone https://github.com/lzwme/static-server.git
pnpm install
pnpm build

# dev
pnpm dev

# global link
npm link
```

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

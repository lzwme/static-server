[![@lzwme/sserver](https://nodei.co/npm/@lzwme/sserver.png)][npm-url]

# @lzwme/sserver

[![NPM version][npm-badge]][npm-url]
[![node version][node-badge]][node-url]
[![npm download][download-badge]][download-url]
[![GitHub issues][issues-badge]][issues-url]
[![GitHub forks][forks-badge]][forks-url]
[![GitHub stars][stars-badge]][stars-url]

一个基于 nodejs 的简易静态服务器，方便随时开发调试使用。

## 安装

安装：

```bash
# 全局安装
npm i -g @lzwme/sserver
# 测试
sserver -h

# 项目中安装
npm i -D @lzwme/sserver
yarn add -D @lzwme/sserver
```

也可以不安装，直接使用 `npx` 执行：

```bash
npx @lzwme/sserver -d ./dist
```

## 使用

示例：

```bash
# 已当前目录下的 dist 作为静态目录
sserver -d ./dist
```

### 配置代理转发

支持通过配置文件 `ss.config.js` 指定代理转发信息。示例：

```js
// ss.config.js

/** @type {import('@lzwme/sserver').SSConfig} */
module.exports = {
  port: 8890,
  baseDir: './dist',
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

## 开发

本地二次开发：

```bash
git clone https://github.com/lzwme/static-server
pnpm install
npm link
pnpm dev
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

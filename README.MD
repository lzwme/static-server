[![Code Climate](https://lzw.me/images/logo.png)](https://lzw.me)
[![@lzwme/static-server](https://nodei.co/npm/@lzwme/static-server.png)](npm-url)

# @lzwme/static-server

[![NPM version][npm-badge]][npm-url]
[![node version][node-badge]][node-url]
[![npm download][download-badge]][download-url]
[![GitHub issues][issues-badge]][issues-url]
[![GitHub forks][forks-badge]][forks-url]
[![GitHub stars][stars-badge]][stars-url]
[![minzipped size][bundlephobia-badge]][bundlephobia-url]

一个基于 nodejs 的简易静态服务器，方便随时开发调试使用。

## 安装

```bash
# 全局安装
npm i -g @lzwme/static-server
# 测试
sserver -h

# 项目中安装
npm i -D @lzwme/static-server
yarn add -D @lzwme/static-server

```

## 使用

### 帮助信息

```bash
sserver -h

Usage: sserver|ss [options]

一个基于 nodejs 的简易静态服务器，方便随时调试使用 [version@1.0.0]

Options:
  -v, --version        output the version number
  -d, --dir [rootDir]  静态服务器的根目录路径
  -p, --port           端口号 (default: 6010)
  -o, --open           启动后是否打开静态服务器首页
  --debug              开启调试模式。 (default: false)
  -h, --help           display help for command
```


## 开发

本地二次开发：

```bash
git clone https://github.com/lzwme/static-server
yarn install
npm link
yarn dev
```

或者 fork 本项目进行代码贡献。

**欢迎贡献想法与代码。**

## License

`@lzwme/static-server` is released under the MIT license.

该插件由[志文工作室](https://lzw.me)开发和维护。


[stars-badge]: https://img.shields.io/github/stars/lzwme/static-server.svg
[stars-url]: https://github.com/lzwme/static-server/stargazers
[forks-badge]: https://img.shields.io/github/forks/lzwme/static-server.svg
[forks-url]: https://github.com/lzwme/static-server/network
[issues-badge]: https://img.shields.io/github/issues/lzwme/static-server.svg
[issues-url]: https://github.com/lzwme/static-server/issues
[npm-badge]: https://img.shields.io/npm/v/@lzwme/static-server.svg?style=flat-square
[npm-url]: https://npmjs.org/package/@lzwme/static-server
[node-badge]: https://img.shields.io/badge/node.js-%3E=_10.0.0-green.svg?style=flat-square
[node-url]: https://nodejs.org/download/
[download-badge]: https://img.shields.io/npm/dm/@lzwme/static-server.svg?style=flat-square
[download-url]: https://npmjs.org/package/@lzwme/static-server
[bundlephobia-url]: https://bundlephobia.com/result?p=@lzwme/static-server@latest
[bundlephobia-badge]: https://badgen.net/bundlephobia/minzip/@lzwme/static-server@latest

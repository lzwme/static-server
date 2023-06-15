# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

### [0.0.7](https://github.com/lzwme/static-server/compare/v0.0.6...v0.0.7) (2023-06-15)


### Features

* 新增 autoindex 参数，支持目录列表浏览 ([be7a8a3](https://github.com/lzwme/static-server/commit/be7a8a30739407c27b45de5a71b8b7a17f9639da))

### [0.0.6](https://github.com/lzwme/static-server/compare/v0.0.5...v0.0.6) (2023-02-03)


### Features

* 新增 headers 选项，支持自定义 headers，默认配置允许跨域请求 ([2c240d1](https://github.com/lzwme/static-server/commit/2c240d1c550bb320798f87079a1432055d55a69e))
* 新增 php-cgi 代理调用支持 ([9009cfc](https://github.com/lzwme/static-server/commit/9009cfce00a2e92e5e941761abdeb5d6ba3ee5fe))


### Bug Fixes

* fix for config sample ([6958684](https://github.com/lzwme/static-server/commit/6958684449ba44ea20d566e91c95c15b774efc2d))

### [0.0.5](https://github.com/lzwme/static-server/compare/v0.0.4...v0.0.5) (2022-12-18)


### Features

* 新增 init 命令，支持根据模板创建配置文件 ([4ebc9ca](https://github.com/lzwme/static-server/commit/4ebc9cad784fe7bfa81a543acd14f2d058f828ad))
* 新增支持 https 模式 ([e6ebf98](https://github.com/lzwme/static-server/commit/e6ebf9826670d405687cbd93d4bf70f4bd120349))
* 增加 https 模式下随机生成 ssl 证书 ([a1c68ea](https://github.com/lzwme/static-server/commit/a1c68eaeabe9262e312e0a334d35697ad53b0db1))

### [0.0.4](https://github.com/lzwme/static-server/compare/v0.0.3...v0.0.4) (2022-09-23)


### Features

* 增加 log 配置参数，支持配置指定日志记录目录 ([1242aba](https://github.com/lzwme/static-server/commit/1242aba2c298fb6e8dd1cbf0540de31590c2c704))


### Bug Fixes

* open 参数默认为 false ([42a5bbf](https://github.com/lzwme/static-server/commit/42a5bbfe12461a44ac96c1d891d57755d340e755))

### [0.0.3](https://github.com/lzwme/static-server/compare/v0.0.2...v0.0.3) (2022-09-17)


### Bug Fixes

* 修正 cli.ts 引用 chalk 导致的异常 ([52616f0](https://github.com/lzwme/static-server/commit/52616f0afad9f1bdc7f7ab1a7f13ada01cc0dbcb))

### [0.0.2](https://github.com/lzwme/static-server/compare/v0.0.1...v0.0.2) (2022-09-15)


### Bug Fixes

* fix for cli error ([ce32f27](https://github.com/lzwme/static-server/commit/ce32f27f6658234bd888021a6a9cb3c12f151022))

### 0.0.1 (2022-07-01)


### Features

* 新增代理转发支持；使用 ts 重构 ([9d6a960](https://github.com/lzwme/static-server/commit/9d6a960c0a311f1f345f5e9c7b544161920fbae2))

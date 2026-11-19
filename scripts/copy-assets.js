#!/usr/bin/env node
/*
 * 构建后静态资源拷贝脚本：把需要随包分发的资源拷贝到 dist
 *  - src/localsend/client → dist/localsend/client：前端页面资源（index.html、app.js、sw.js、icons 等）
 *  - assets               → dist/assets：前端构建产物（tailwind 生成的 style.css、vendor 第三方库）
 *
 * 只拷贝 client 子目录：src/localsend 下还有服务端源码与样式入口，
 * 它们由 tsc 编译或仅在构建期使用，都不应原样进入发布包。
 *
 * dist 的目录结构与 src 保持镜像（src/localsend/client → dist/localsend/client），
 * 这样服务端用同一条相对路径就能在开发态（src）与运行态（dist）下都定位到页面资源。
 *
 * 拷贝到 dist/assets 后，运行态自带全部前端资源，发布时无需额外附带 assets。
 *
 * 仅用于开发/构建，不属于 npm 发布内容（package.json 的 files 仅包含 dist 与 ss.config.sample.js）
 */
const { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } = require('node:fs');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '..');
const distDir = join(root, 'dist');

/** 需要拷贝到 dist 的静态资源：源目录 → dist 下的目标目录 */
const assets = [
  {
    from: join(root, 'src/localsend/client'),
    to: join(distDir, 'localsend/client'),
    label: 'src/localsend/client -> dist/localsend/client',
  },
  { from: join(root, 'assets'), to: join(distDir, 'assets'), label: 'assets -> dist/assets' },
];

function copyDir(from, to) {
  if (!existsSync(from)) return;
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dst = join(to, name);
    if (statSync(src).isDirectory()) copyDir(src, dst);
    else copyFileSync(src, dst);
  }
}

for (const asset of assets) {
  rmSync(asset.to, { recursive: true, force: true });
  copyDir(asset.from, asset.to);
  console.log(`[copy-assets] ${asset.label}`);
}

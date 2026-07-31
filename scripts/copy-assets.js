#!/usr/bin/env node
/*
 * 构建后静态资源拷贝脚本：将 src 下的静态资源目录（如 localsend 前端页面）拷贝至 dist
 * 仅用于开发/构建，不属于 npm 发布内容（package.json 的 files 仅包含 dist 与 ss.config.sample.js）
 */
const { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } = require('node:fs');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '..');
const srcDir = join(root, 'src');
const distDir = join(root, 'dist');

/** 需要拷贝的静态资源目录（相对 src 的路径） */
const assets = ['localsend'];

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
  const from = join(srcDir, asset);
  const to = join(distDir, asset);
  rmSync(to, { recursive: true, force: true });
  copyDir(from, to);
  console.log(`[copy-assets] src/${asset} -> dist/${asset}`);
}

/**
 * 前端构建产物目录探测的单元测试
 *
 * 产物不在源码目录里，而是按运行时目录特征自动识别：
 *  - 运行态（模块在 dist 下）：dist 内自带 assets
 *  - 开发态（模块在 src 下）：产物在仓库根 assets/
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const { resolveAssetsDir } = require('../dist/lib/localsend');

/** 造一个包含 style.css 的产物目录 */
function makeAssetsDir(root, rel) {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'style.css'), '/* css */');
  return dir;
}

describe('前端构建产物目录探测', () => {
  it('运行态：优先取运行目录下的 assets', () => {
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sserver-assets-'));
    const expected = makeAssetsDir(root, 'dist/assets/localsend');
    assert.equal(resolveAssetsDir(path.join(root, 'dist')), expected);
  });

  it('开发态：运行目录没有产物时取上级的 assets', () => {
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sserver-assets-'));
    const expected = makeAssetsDir(root, 'assets/localsend');
    assert.equal(resolveAssetsDir(path.join(root, 'src')), expected);
  });

  it('运行态与开发态同时存在时以运行目录为准', () => {
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sserver-assets-'));
    makeAssetsDir(root, 'assets/localsend');
    const expected = makeAssetsDir(root, 'dist/assets/localsend');
    assert.equal(resolveAssetsDir(path.join(root, 'dist')), expected);
  });

  it('目录存在但没有 style.css 时不算命中', () => {
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sserver-assets-'));
    fs.mkdirSync(path.join(root, 'dist/assets/localsend'), { recursive: true });
    assert.equal(resolveAssetsDir(path.join(root, 'dist')), null);
  });

  it('两处都没有产物时返回 null', () => {
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sserver-assets-'));
    assert.equal(resolveAssetsDir(path.join(root, 'dist')), null);
  });

  it('产物在运行目录的更上层时逐级向上找到', () => {
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sserver-assets-'));
    const expected = makeAssetsDir(root, 'assets/localsend');
    // 开发态：模块位于 src/lib/localsend，产物在仓库根 assets
    assert.equal(resolveAssetsDir(path.join(root, 'src/lib/localsend')), expected);
  });

  it('就近优先：内层产物优先于外层', () => {
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sserver-assets-'));
    makeAssetsDir(root, 'assets/localsend');
    const inner = makeAssetsDir(root, 'dist/assets/localsend');
    assert.equal(resolveAssetsDir(path.join(root, 'dist/lib/localsend')), inner);
  });

  it('实际仓库中产物与源码分处两棵树（需先执行 npm run build:assets）', () => {
    const repoRoot = path.resolve(__dirname, '..');
    // 源码目录里不应再有产物
    assert.equal(fs.existsSync(path.join(repoRoot, 'src/assets')), false);
    // 构建产物统一在仓库根 assets 下
    assert.equal(fs.existsSync(path.join(repoRoot, 'assets/localsend/style.css')), true);
  });

  it('仓库结构：localsend 服务端代码与前端页面资源分开维护', () => {
    const repoRoot = path.resolve(__dirname, '..');
    // 服务端代码集中在 src/lib/localsend
    assert.equal(fs.existsSync(path.join(repoRoot, 'src/lib/localsend/index.ts')), true);
    // 前端页面资源独立放在 src/client
    assert.equal(fs.existsSync(path.join(repoRoot, 'src/client/index.html')), true);
    // src/lib 顶层只保留通用库
    assert.equal(fs.existsSync(path.join(repoRoot, 'src/lib/localsend.ts')), false);
  });
});

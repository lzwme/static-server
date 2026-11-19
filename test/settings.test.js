/**
 * 运行时设置存储的单元测试
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const { createSettingsStore, normalizeSetting, resolveSettingsFile } = require('../dist/lib/localsend/settings');

/** 临时目录 */
function tmpDir() {
  return fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sserver-set-'));
}

describe('设置取值校验', () => {
  it('口令类接受字符串并去掉空白语义', () => {
    assert.deepEqual(normalizeSetting('password', 'abc'), { value: 'abc' });
    assert.deepEqual(normalizeSetting('password', null), { value: '' });
    assert.deepEqual(normalizeSetting('visitorPassword', undefined), { value: '' });
    const long = normalizeSetting('token', 'x'.repeat(600));
    assert.match(long.error, /过长/);
  });

  it('数值型按上下限校验', () => {
    assert.deepEqual(normalizeSetting('maxConcurrent', '5'), { value: 5 });
    assert.deepEqual(normalizeSetting('maxConcurrent', 5.9), { value: 5 });
    assert.match(normalizeSetting('maxConcurrent', -1).error, /不能小于/);
    assert.match(normalizeSetting('maxConcurrent', 'abc').error, /必须是数字/);
  });

  it('扩展名列表自动补点并去重', () => {
    assert.deepEqual(normalizeSetting('blockExtensions', 'php, .sh,php').value, ['.php', '.sh']);
    assert.deepEqual(normalizeSetting('blockExtensions', '').value, []);
    assert.match(normalizeSetting('blockExtensions', 'not an ext!').error, /不是合法的扩展名/);
  });

  it('频率限制返回窗口与次数', () => {
    assert.deepEqual(normalizeSetting('rateLimit', { windowMs: 30000, max: 60 }).value, { windowMs: 30000, max: 60 });
    assert.match(normalizeSetting('rateLimit', { windowMs: 10 }).error, /窗口不能小于/);
  });
});

describe('运行时设置的存储与优先级', () => {
  it('默认文件位置在用户配置目录，可用环境变量覆盖', () => {
    const prev = process.env.SS_LOCALSEND_SETTINGS;
    delete process.env.SS_LOCALSEND_SETTINGS;
    assert.ok(resolveSettingsFile().includes('.static-server'));
    process.env.SS_LOCALSEND_SETTINGS = 'D:/tmp/custom.json';
    assert.equal(resolveSettingsFile(), 'D:/tmp/custom.json');
    if (prev === undefined) delete process.env.SS_LOCALSEND_SETTINGS;
    else process.env.SS_LOCALSEND_SETTINGS = prev;
  });

  it('运行时设置覆盖配置文件的值', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'settings.json');
    const store = createSettingsStore(file);
    store.load();
    const base = { maxConcurrent: 3, trashDays: 1 };
    store.set('maxConcurrent', 9, 3);
    const merged = store.apply({ ...base });
    assert.equal(merged.maxConcurrent, 9);
    assert.equal(merged.trashDays, 1);
    assert.equal(store.source('maxConcurrent'), 'runtime');
    assert.equal(store.source('trashDays'), 'config');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('配置文件里改了同一项时以配置文件为准', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'settings.json');
    const store = createSettingsStore(file);
    store.load();
    store.set('maxConcurrent', 9, 3);
    // 配置文件里的值变成了 5，与修改时的基准值 3 不同
    const merged = store.apply({ maxConcurrent: 5 });
    assert.equal(merged.maxConcurrent, 5);
    // 过期的覆盖被丢弃
    assert.equal(store.source('maxConcurrent'), 'config');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('设置会落盘并能重新读回', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'settings.json');
    const store = createSettingsStore(file);
    store.load();
    store.set('password', 'secret', '');
    assert.ok(fs.existsSync(file));
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.values.password, 'secret');

    const again = createSettingsStore(file);
    again.load();
    assert.equal(again.source('password'), 'runtime');
    assert.equal(again.apply({ password: '' }).password, 'secret');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('清除覆盖后回到配置文件的值', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'settings.json');
    const store = createSettingsStore(file);
    store.load();
    store.set('trashDays', 7, 1);
    assert.equal(store.apply({ trashDays: 1 }).trashDays, 7);
    store.clear('trashDays');
    assert.equal(store.apply({ trashDays: 1 }).trashDays, 1);
    assert.equal(store.source('trashDays'), 'config');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('文件损坏时按没有覆盖处理', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, '{ not json', 'utf8');
    const store = createSettingsStore(file);
    store.load();
    assert.deepEqual(store.overridden(), []);
    assert.equal(store.apply({ maxConcurrent: 3 }).maxConcurrent, 3);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

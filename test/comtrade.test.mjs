import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, parseData, nominalMicros, CONTRACT } from '../src/comtrade.mjs';

const CFG_LINES = [
  'SYNTHETIC,REC01,1999',
  '3,1A,2D',
  '1,IA,A,,A,0.1,1,0,-32767,32767,100,1,P',
  '1,TRIP,,,0',
  '2,BREAKER,,,0',
  '50',
  '2',
  '1000,2',
  '500,4',
  '15/11/2026,00:00:00.000000',
  '15/11/2026,00:00:00.001000',
  'BINARY',
  '1',
];

function cfgText(overrides = {}) {
  const lines = [...CFG_LINES];
  if (overrides.head) lines[0] = overrides.head;
  if (overrides.counts) lines[1] = overrides.counts;
  if (overrides.fileType) lines[11] = overrides.fileType;
  if (overrides.timeMult !== undefined) lines[12] = overrides.timeMult;
  if (overrides.extra) lines.push(...overrides.extra);
  return lines.join('\r\n') + '\r\n';
}

function binarySample(n, t, analogs, digitalWords) {
  const sample = Buffer.alloc(8 + 2 * analogs.length + 2 * digitalWords.length);
  sample.writeUInt32LE(n, 0);
  sample.writeInt32LE(t, 4);
  analogs.forEach((value, i) => sample.writeInt16LE(value, 8 + 2 * i));
  digitalWords.forEach((value, i) => sample.writeUInt16LE(value, 8 + 2 * analogs.length + 2 * i));
  return sample;
}

test('配置解析：多采样率闭合端点与量纲原文', () => {
  const { config, issues } = parseConfig(cfgText(), 'capture.cfg');
  assert.ok(config);
  assert.deepEqual(issues, []);
  assert.equal(config.totalSamples, 4);
  assert.deepEqual(config.rates, [{ rate: 1000, endSample: 2 }, { rate: 500, endSample: 4 }]);
  assert.equal(config.analog[0].text.a, '0.1');
  assert.equal(config.analog[0].text.primary, '100');
  assert.equal(config.analog[0].ps, 'P');
  assert.equal(config.timeMult, 1);
});

test('契约范围：非 1999 版本与未知编码给出可定位拒收原因', () => {
  const wrongRev = parseConfig(cfgText({ head: 'SYNTHETIC,REC01,2099' }), 'unsupported.cfg');
  assert.equal(wrongRev.config, null);
  assert.equal(wrongRev.issues[0].location, 'unsupported.cfg:1');
  assert.match(wrongRev.issues[0].message, /2099/);
  assert.match(wrongRev.issues[0].message, /1999/);
  const missingRev = parseConfig(cfgText({ head: 'SYNTHETIC,REC01' }), 'old.cfg');
  assert.equal(missingRev.config, null);
  assert.match(missingRev.issues[0].message, /1991/);
  const badType = parseConfig(cfgText({ fileType: 'CSV' }), 'capture.cfg');
  assert.equal(badType.config, null);
  assert.match(badType.issues[0].message, /CSV/);
});

test('BINARY：模拟量换算、数字位低位在前、int16 最小值缺测', () => {
  const { config } = parseConfig(cfgText(), 'capture.cfg');
  const bytes = Buffer.concat([
    binarySample(1, 1000, [100], [0x0001]),
    binarySample(2, 2000, [200], [0x0002]),
    binarySample(3, 3000, [-32768], [0x0003]),
    binarySample(4, 4000, [-10], [0x0000]),
  ]);
  const { records, issues, stats } = parseData(config, bytes, 'capture.dat');
  assert.deepEqual(issues, []);
  assert.equal(records.length, 4);
  assert.equal(records[0].analog[0].value, 11);
  assert.equal(records[3].analog[0].value, 0);
  assert.deepEqual(records[0].digital.map(d => d.value), [1, 0]);
  assert.deepEqual(records[1].digital.map(d => d.value), [0, 1]);
  assert.deepEqual(records[2].digital.map(d => d.value), [1, 1]);
  assert.equal(records[2].analog[0].value, null);
  assert.equal(records[2].analog[0].status, 'missing');
  assert.equal(records[2].analog[0].marker, 'int16-min');
  assert.equal(stats.missingValues, 1);
  assert.equal(records[0].timestamp.micros, 1000);
  assert.equal(records[0].timestamp.at, '2026-11-15T00:00:00.001000Z');
});

test('时间乘数：时间戳乘 timemult 得微秒', () => {
  const { config } = parseConfig(cfgText({ timeMult: '5' }), 'capture.cfg');
  const bytes = Buffer.concat([binarySample(1, 1000, [100], [0]), binarySample(2, 2000, [100], [0]), binarySample(3, 3000, [100], [0]), binarySample(4, 4000, [100], [0])]);
  const { records } = parseData(config, bytes, 'capture.dat');
  assert.equal(records[0].timestamp.micros, 5000);
  assert.equal(records[0].timestamp.raw, 1000);
});

test('零时间戳：按声明采样段闭合端点恢复并说明依据', () => {
  assert.equal(nominalMicros([{ rate: 1000, endSample: 2 }, { rate: 500, endSample: 4 }], 1), 1000);
  assert.equal(nominalMicros([{ rate: 1000, endSample: 2 }, { rate: 500, endSample: 4 }], 3), 4000);
  assert.equal(nominalMicros([{ rate: 1000, endSample: 2 }, { rate: 500, endSample: 4 }], 4), 6000);
  const { config } = parseConfig(cfgText(), 'capture.cfg');
  const bytes = Buffer.concat([
    binarySample(1, 1000, [100], [0]),
    binarySample(2, 2000, [100], [0]),
    binarySample(3, 0, [100], [0]),
    binarySample(4, 4000, [100], [0]),
  ]);
  const { records, issues, stats } = parseData(config, bytes, 'capture.dat');
  assert.equal(records[2].timestamp.micros, 4000);
  assert.equal(records[2].timestamp.recovered, true);
  assert.ok(records[2].timestamp.basis);
  assert.equal(stats.recoveredTimestamps, 1);
  assert.ok(issues.some(issue => issue.severity === 'warning' && issue.location === 'capture.dat#sample3'));
});

test('数字位排列：每 16 通道一字、低位在前、跨字分组', () => {
  const digitalLines = Array.from({ length: 17 }, (_, i) => `${i + 1},D${i + 1},,,0`);
  const text = [
    'SYNTHETIC,REC01,1999',
    '18,1A,17D',
    '1,IA,A,,A,1,0,0,-32767,32767,1,1,P',
    ...digitalLines,
    '50', '1', '1000,1',
    '15/11/2026,00:00:00.000000',
    '15/11/2026,00:00:00.001000',
    'BINARY', '1',
  ].join('\n');
  const { config, issues } = parseConfig(text, 'wide.cfg');
  assert.deepEqual(issues, []);
  const sample = Buffer.alloc(8 + 2 + 4);
  sample.writeUInt32LE(1, 0);
  sample.writeInt32LE(1000, 4);
  sample.writeInt16LE(7, 8);
  sample.writeUInt16LE(0x8001, 10);
  sample.writeUInt16LE(0x0001, 12);
  const { records } = parseData(config, sample, 'wide.dat');
  const values = records[0].digital.map(d => d.value);
  assert.equal(values[0], 1);
  assert.equal(values[1], 0);
  assert.equal(values[15], 1);
  assert.equal(values[16], 1);
  assert.equal(records[0].digital[16].channel, 'D17');
});

test('FLOAT32：NaN 保留缺测身份', () => {
  const { config } = parseConfig(cfgText({ fileType: 'FLOAT32' }), 'capture.cfg');
  const make = (n, t, value, word) => {
    const sample = Buffer.alloc(8 + 4 + 2);
    sample.writeUInt32LE(n, 0);
    sample.writeInt32LE(t, 4);
    sample.writeFloatLE(value, 8);
    sample.writeUInt16LE(word, 12);
    return sample;
  };
  const bytes = Buffer.concat([make(1, 1000, 1.5, 0), make(2, 2000, NaN, 1), make(3, 3000, -2.5, 0), make(4, 4000, 0, 0)]);
  const { records, stats } = parseData(config, bytes, 'float.dat');
  assert.equal(records[0].analog[0].value, 1.15);
  assert.equal(records[1].analog[0].value, null);
  assert.equal(records[1].analog[0].marker, 'NaN');
  assert.equal(records[1].analog[0].raw, null);
  assert.equal(stats.missingValues, 1);
});

test('BINARY32：int32 最小值保留缺测身份', () => {
  const { config } = parseConfig(cfgText({ fileType: 'BINARY32' }), 'capture.cfg');
  const make = (n, t, value, word) => {
    const sample = Buffer.alloc(8 + 4 + 2);
    sample.writeUInt32LE(n, 0);
    sample.writeInt32LE(t, 4);
    sample.writeInt32LE(value, 8);
    sample.writeUInt16LE(word, 12);
    return sample;
  };
  const bytes = Buffer.concat([make(1, 1000, 1000, 0), make(2, 2000, -2147483648, 0), make(3, 3000, 5, 0), make(4, 4000, 6, 0)]);
  const { records } = parseData(config, bytes, 'wide.dat');
  assert.equal(records[0].analog[0].value, 101);
  assert.equal(records[1].analog[0].value, null);
  assert.equal(records[1].analog[0].marker, 'int32-min');
});

test('ASCII：空字段缺测、数字列与字段数校验', () => {
  const { config } = parseConfig(cfgText({ fileType: 'ASCII' }), 'capture.cfg');
  const text = ['1,1000,100,1,0', '2,2000,,0,1', '3,3000,-32768,1,1', '4,4000,-10,0,0'].join('\n') + '\n';
  const { records, issues, stats } = parseData(config, Buffer.from(text), 'capture.dat');
  assert.deepEqual(issues, []);
  assert.equal(records[0].analog[0].value, 11);
  assert.equal(records[1].analog[0].value, null);
  assert.equal(records[1].analog[0].marker, 'empty');
  assert.equal(records[2].analog[0].marker, 'int16-min');
  assert.deepEqual(records[1].digital.map(d => d.value), [0, 1]);
  assert.equal(stats.missingValues, 2);
});

test('配置与数据不相容：截断不补零，给出可定位原因', () => {
  const { config } = parseConfig(cfgText(), 'capture.cfg');
  const full = Buffer.concat([
    binarySample(1, 1000, [100], [1]),
    binarySample(2, 2000, [200], [2]),
    binarySample(3, 3000, [300], [3]),
  ]);
  const truncated = Buffer.concat([full, Buffer.from([4, 0, 0, 0, 160, 15, 0, 0, 246])]);
  const { records, issues, stats } = parseData(config, truncated, 'short.dat');
  assert.equal(records.length, 3);
  assert.equal(stats.parsedSamples, 3);
  assert.ok(!records.some(record => record.sample === 4));
  const issue = issues.find(item => item.location === 'short.dat#sample4');
  assert.ok(issue);
  assert.equal(issue.severity, 'error');
  assert.match(issue.message, /不补零/);
});

test('数据尾部多余字节与样本编号不一致均可定位', () => {
  const { config } = parseConfig(cfgText(), 'capture.cfg');
  const samples = [binarySample(1, 1000, [100], [0]), binarySample(2, 2000, [100], [0]), binarySample(9, 3000, [100], [0]), binarySample(4, 4000, [100], [0])];
  const trailing = Buffer.concat([...samples, Buffer.from([1, 2, 3])]);
  const { records, issues } = parseData(config, trailing, 'capture.dat');
  assert.equal(records.length, 4);
  assert.ok(issues.some(issue => issue.location === 'capture.dat#sample3' && /编号 9/.test(issue.message)));
  assert.ok(issues.some(issue => issue.location === 'capture.dat#offset48' && /多出 3 字节/.test(issue.message)));
  assert.equal(records[2].sample, 9);
});

test('配置结构问题：通道数不符、采样段未递增均可定位', () => {
  const badCounts = parseConfig(cfgText({ counts: '4,1A,2D' }), 'capture.cfg');
  assert.equal(badCounts.config, null);
  assert.equal(badCounts.issues[0].location, 'capture.cfg:2');
  const lines = cfgText().split('\r\n');
  lines[8] = '500,2';
  const badRates = parseConfig(lines.join('\r\n'), 'capture.cfg');
  assert.equal(badRates.config, null);
  assert.match(badRates.issues[0].message, /闭合端点/);
});

test('契约常量与受支持编码一致', () => {
  assert.equal(CONTRACT.revision, '1999');
  assert.deepEqual([...CONTRACT.encodings], ['ASCII', 'BINARY', 'BINARY32', 'FLOAT32']);
});

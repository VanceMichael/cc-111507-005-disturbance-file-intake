import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/server.mjs';

async function structuredIntake(service) {
  const response = await fetch(`${service.baseUrl}/v1/intakes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'structured' }) });
  assert.equal(response.status, 201);
  return response.json();
}

test('结构化收件：标准场景完整解释、可查询且跨实例持久', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-check-'));
  const service = await createService({ dataDir });
  try {
    const receipt = await structuredIntake(service);
    assert.equal(receipt.state, 'complete');
    assert.ok(Array.isArray(receipt.records));
    assert.ok(Array.isArray(receipt.issues));
    assert.equal(receipt.records.length, 4);
    assert.ok(JSON.stringify(receipt.records).includes('null'));
    // 采样时刻、模拟量与数字量对应
    assert.equal(receipt.records[0].sample, 1);
    assert.equal(receipt.records[0].timestamp.micros, 1000);
    assert.equal(receipt.records[0].analog[0].value, 11);
    assert.deepEqual(receipt.records[0].digital.map(d => d.value), [1, 0]);
    // 缺测数值用 null 配合状态
    assert.equal(receipt.records[2].analog[0].value, null);
    assert.equal(receipt.records[2].analog[0].status, 'missing');
    // 一次值/二次值量纲依据保留原文
    assert.equal(receipt.channels.analog[0].source.a, '0.1');
    assert.equal(receipt.channels.analog[0].source.primary, '100');
    assert.equal(receipt.channels.analog[0].ps, 'P');
    assert.equal(receipt.channels.analog[0].unit, 'A');
    // 配对依据来自清单而非文件名
    assert.equal(receipt.evidence.recordingId, 'recording-local-1');
    assert.equal(receipt.evidence.configuration.name, 'capture.cfg');
    assert.equal(receipt.evidence.dataFile.name, 'capture.dat');
    assert.equal(receipt.blobs.length, 2);
    const saved = await (await fetch(`${service.baseUrl}/v1/receipts/${receipt.id}`)).json();
    assert.deepEqual(saved.records, receipt.records);
    assert.deepEqual(saved.coverage, receipt.coverage);
    await service.close();
    const reopened = await createService({ dataDir });
    try {
      const again = await (await fetch(`${reopened.baseUrl}/v1/receipts/${receipt.id}`)).json();
      assert.deepEqual(again.records, receipt.records);
      assert.deepEqual(again.coverage, receipt.coverage);
    } finally { await reopened.close(); }
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('结构化收件：数据截断形成 partial，原因可定位且不补零', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-check-'));
  const service = await createService({ dataDir, scenario: 'short-data' });
  try {
    const receipt = await structuredIntake(service);
    assert.equal(receipt.state, 'partial');
    assert.equal(receipt.records.length, 3);
    assert.equal(receipt.coverage.declaredSamples, 4);
    assert.equal(receipt.coverage.parsedSamples, 3);
    assert.ok(!receipt.records.some(record => record.sample === 4));
    const issue = receipt.issues.find(item => item.location === 'short.dat#sample4');
    assert.ok(issue, '应有定位到 short.dat#sample4 的问题');
    assert.match(issue.message, /不补零/);
    const saved = await (await fetch(`${service.baseUrl}/v1/receipts/${receipt.id}`)).json();
    assert.equal(saved.state, 'partial');
    assert.deepEqual(saved.records, receipt.records);
  } finally { await service.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('结构化收件：配置与清单标识不一致时拒收且不合并数据', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-check-'));
  const service = await createService({ dataDir, scenario: 'wrong-pair' });
  try {
    const receipt = await structuredIntake(service);
    assert.equal(receipt.state, 'rejected');
    assert.deepEqual(receipt.records, []);
    const issue = receipt.issues.find(item => item.location === 'other.cfg:1');
    assert.ok(issue, '应有定位到 other.cfg:1 的问题');
    assert.match(issue.message, /REC02/);
    assert.match(issue.message, /REC01/);
    assert.equal(issue.severity, 'fatal');
    assert.equal(receipt.evidence.dataFile, undefined);
    assert.equal(receipt.blobs.length, 1);
  } finally { await service.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('结构化收件：超出契约的版本被明确标记后拒收', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-check-'));
  const service = await createService({ dataDir, scenario: 'unsupported' });
  try {
    const receipt = await structuredIntake(service);
    assert.equal(receipt.state, 'rejected');
    assert.deepEqual(receipt.records, []);
    const issue = receipt.issues.find(item => item.location === 'unsupported.cfg:1');
    assert.ok(issue, '应有定位到 unsupported.cfg:1 的问题');
    assert.match(issue.message, /2099/);
    assert.match(issue.message, /1999/);
    assert.equal(receipt.coverage.parsedSamples, 0);
  } finally { await service.close(); await rm(dataDir, { recursive: true, force: true }); }
});

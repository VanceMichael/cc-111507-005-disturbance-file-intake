import { receiveBytes } from './http-client.mjs';
import { inspect } from './source-metadata.mjs';
import { parseConfig, parseData, describeConfig } from './comtrade.mjs';

export async function collect({ input, descriptor, sourceBase, store }) {
  if (input.mode === 'raw') {
    const source = await receiveBytes(`${sourceBase}/files/${encodeURIComponent(descriptor.entry)}`);
    const blob = await store.blob(source.bytes);
    const receipt = await store.save({ state: 'received', mode: 'raw', product: descriptor.product,
      source: descriptor.entry, sourceVersion: source.etag, metadata: inspect(source.bytes), blobs: [blob],
      records: [], issues: [], coverage: { structured: false, downloadedBytes: source.bytes.length } });
    return { receipt };
  }
  if (input.mode === 'structured') return collectStructured({ descriptor, sourceBase, store });
  return { httpStatus: 501, error: '当前仅开放原始资料接收' };
}

// 结构化收件：按来源清单绑定的配置与数据文件共同解释一次记录。
// 配对依据是清单的 recordingId+station+device，不按文件名前缀猜测；元数据无法配对不合并。
async function collectStructured({ descriptor, sourceBase, store }) {
  const issues = [];
  const blobs = [];
  const evidence = {
    recordingId: descriptor.recordingId ?? null,
    station: descriptor.station ?? null,
    device: descriptor.device ?? null,
    pairing: 'manifest(recordingId+station+device)，不按文件名猜测配对',
  };
  const finish = async (state, extra = {}) => {
    const receipt = await store.save({
      state, mode: 'structured', product: descriptor.product, source: descriptor.entry,
      sourceVersion: extra.sourceVersion ?? null, metadata: extra.metadata ?? null,
      blobs, records: extra.records ?? [], issues, channels: extra.channels ?? null,
      coverage: extra.coverage, evidence,
    });
    return { receipt };
  };
  const rejectCoverage = { structured: true, parsedSamples: 0 };

  const cfgName = descriptor.configuration;
  const datName = descriptor.dataFile;
  if (!cfgName || !datName) {
    issues.push({ location: 'manifest', severity: 'fatal', message: '来源清单未绑定配置与数据文件，拒绝按文件名猜测配对' });
    return finish('rejected', { coverage: rejectCoverage });
  }

  let cfgSource;
  try {
    cfgSource = await receiveBytes(`${sourceBase}/files/${encodeURIComponent(cfgName)}`);
  } catch (error) {
    issues.push({ location: cfgName, severity: 'fatal', message: `配置文件获取失败：${error.message}` });
    return finish('rejected', { coverage: rejectCoverage });
  }
  blobs.push(await store.blob(cfgSource.bytes));
  evidence.configuration = { name: cfgName, digest: cfgSource.digest, etag: cfgSource.etag, bytes: cfgSource.bytes.length };
  const metadata = inspect(cfgSource.bytes);
  const sourceVersion = cfgSource.etag;

  const parsed = parseConfig(cfgSource.bytes.toString('utf8'), cfgName);
  issues.push(...parsed.issues);
  if (!parsed.config) return finish('rejected', { sourceVersion, metadata, coverage: rejectCoverage });
  const config = parsed.config;
  const channels = describeConfig(config);
  const declaredCoverage = { ...rejectCoverage, declaredSamples: config.totalSamples, fileType: config.fileType };

  if (config.station !== evidence.station || config.device !== evidence.device) {
    issues.push({ location: `${cfgName}:1`, severity: 'fatal', message: `配置标识 ${config.station}/${config.device} 与清单 ${evidence.station}/${evidence.device} 不一致，元数据无法配对不合并` });
    return finish('rejected', { sourceVersion, metadata, channels, coverage: declaredCoverage });
  }

  let datSource;
  try {
    datSource = await receiveBytes(`${sourceBase}/files/${encodeURIComponent(datName)}`);
  } catch (error) {
    issues.push({ location: datName, severity: 'fatal', message: `数据文件获取失败：${error.message}` });
    return finish('rejected', { sourceVersion, metadata, channels, coverage: declaredCoverage });
  }
  blobs.push(await store.blob(datSource.bytes));
  evidence.dataFile = { name: datName, digest: datSource.digest, etag: datSource.etag, bytes: datSource.bytes.length };

  const { records, issues: dataIssues, stats } = parseData(config, datSource.bytes, datName);
  issues.push(...dataIssues);
  const coverage = {
    structured: true,
    recordingId: evidence.recordingId, station: config.station, device: config.device,
    fileType: config.fileType, timeMult: config.timeMult, lineFrequency: config.lineFrequency,
    rates: config.rates, declaredSamples: config.totalSamples, parsedSamples: stats.parsedSamples,
    missingValues: stats.missingValues, recoveredTimestamps: stats.recoveredTimestamps,
    analogChannels: config.analogCount, digitalChannels: config.digitalCount,
    downloadedBytes: cfgSource.bytes.length + datSource.bytes.length,
  };
  const common = { sourceVersion, metadata, channels, coverage };
  if (config.totalSamples > 0 && records.length === 0) return finish('rejected', { ...common, records: [] });
  const state = issues.some(issue => issue.severity !== 'warning') ? 'partial' : 'complete';
  return finish(state, { ...common, records });
}

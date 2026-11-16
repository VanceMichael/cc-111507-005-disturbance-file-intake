// COMTRADE 1999 结构化解释：一次记录由配置（cfg）与数据（dat）共同决定。
// 契约范围：版本 1999；编码 ASCII、BINARY（int16 模拟量）、BINARY32、FLOAT32。
// 规则：数字量每 16 通道一字、低位在前；时间戳乘 timemult 得微秒；
// 多采样率 endSample 为闭合端点；整数最小值与浮点 NaN 为缺测标记；
// 配置与数据不相容时留下可定位 issue，不补零凑齐。

export const CONTRACT = Object.freeze({ revision: '1999', encodings: Object.freeze(['ASCII', 'BINARY', 'BINARY32', 'FLOAT32']) });

const MISSING_INT16 = -32768;
const MISSING_INT32 = -2147483648;

const BINARY_TRAITS = {
  BINARY: { analogBytes: 2, read: (bytes, offset) => bytes.readInt16LE(offset), isMissing: value => value === MISSING_INT16, marker: 'int16-min' },
  BINARY32: { analogBytes: 4, read: (bytes, offset) => bytes.readInt32LE(offset), isMissing: value => value === MISSING_INT32, marker: 'int32-min' },
  FLOAT32: { analogBytes: 4, read: (bytes, offset) => bytes.readFloatLE(offset), isMissing: value => Number.isNaN(value), marker: 'NaN' },
};

// 换算值保留 12 位有效数字，避免二进制浮点尾差进入收件记录。
function round12(value) { return Number(value.toPrecision(12)); }

// 声明采样段（闭合端点）下第 n 个样本的名义时刻（微秒），用于零时间戳恢复。
export function nominalMicros(rates, n) {
  let previousEnd = 0;
  let base = 0;
  for (const { rate, endSample } of rates) {
    if (n <= endSample) return Math.round(base + (n - previousEnd) * (1e6 / rate));
    base += (endSample - previousEnd) * (1e6 / rate);
    previousEnd = endSample;
  }
  return null;
}

function parseTimestampLine(line, lineNo, name, issues) {
  const raw = (line ?? '').trim();
  const match = /^(\d{2})\/(\d{2})\/(\d{4})\s*,\s*(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(raw);
  if (!match) {
    issues.push({ location: `${name}:${lineNo}`, severity: 'warning', message: `时间行无法解释，保留原文：${raw || '（空）'}` });
    return { raw, epochMs: null, micros: 0 };
  }
  const [, dd, mm, yyyy, hh, mi, ss, frac = ''] = match;
  return { raw, epochMs: Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss)), micros: Number((frac + '000000').slice(0, 6)) };
}

// cfg 起始时刻加时间戳微秒数，按 UTC 表示；原始依据仍保留在 timestamp.raw 与 coverage.timeMult。
function absoluteIso(start, micros) {
  if (start.epochMs === null) return null;
  const total = start.micros + micros;
  const millis = Math.floor(total / 1000);
  const rest = ((total % 1000) + 1000) % 1000;
  return new Date(start.epochMs + millis).toISOString().replace(/(\.\d{3})Z$/, `$1${String(rest).padStart(3, '0')}Z`);
}

export function parseConfig(text, name = 'cfg') {
  const issues = [];
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const fail = (line, message) => { issues.push({ location: `${name}:${line}`, severity: 'fatal', message }); return { config: null, issues }; };

  if (lines.length < 2) return fail(1, '配置内容不足，无法解释');

  const head = lines[0].split(',').map(field => field.trim());
  const [station, device] = head;
  const revision = head[2] || '1991';
  if (!station || !device) return fail(1, '首行缺少站名或设备标识');
  if (revision !== CONTRACT.revision) return fail(1, `COMTRADE 版本 ${revision} 超出契约范围（仅支持 ${CONTRACT.revision}）`);

  const counts = /^\s*(\d+)\s*,\s*(\d+)\s*[Aa]\s*,\s*(\d+)\s*[Dd]\s*$/.exec(lines[1] || '');
  if (!counts) return fail(2, '通道总数行格式无效（期望 TT,nnA,nnD）');
  const [totalChannels, analogCount, digitalCount] = [Number(counts[1]), Number(counts[2]), Number(counts[3])];
  if (totalChannels !== analogCount + digitalCount) return fail(2, `通道总数 ${totalChannels} 与模拟 ${analogCount}+数字 ${digitalCount} 不一致`);

  const analog = [];
  const digital = [];
  let cursor = 2;
  for (let i = 0; i < analogCount; i++, cursor++) {
    const lineNo = cursor + 1;
    const raw = lines[cursor];
    const fields = (raw ?? '').split(',');
    if (fields.length < 13) return fail(lineNo, `模拟通道声明字段不足（期望 13，实际 ${fields.length}）`);
    const [an, id, phase, monitored, unit, aT, bT, skewT, minT, maxT, primaryT, secondaryT, psT] = fields.map(field => field.trim());
    const [number, a, b, skew, min, max, primary, secondary] = [an, aT, bT, skewT || '0', minT, maxT, primaryT, secondaryT].map(Number);
    if (!Number.isInteger(number) || number < 1) return fail(lineNo, `模拟通道号无效：${an}`);
    if (![a, b, skew, min, max, primary, secondary].every(Number.isFinite)) return fail(lineNo, `模拟通道 ${id || an} 的数值字段无法解释`);
    if (!['P', 'S'].includes(psT.toUpperCase())) issues.push({ location: `${name}:${lineNo}`, severity: 'warning', message: `模拟通道 ${id || an} 的一/二次标识非 P/S：${psT || '（空）'}，保留原文` });
    analog.push({ number, id: id || `A${number}`, phase, monitored, unit, a, b, skew, min, max, primary, secondary, ps: psT.toUpperCase(), text: { a: aT, b: bT, primary: primaryT, secondary: secondaryT, ps: psT, unit }, raw });
  }
  for (let i = 0; i < digitalCount; i++, cursor++) {
    const lineNo = cursor + 1;
    const raw = lines[cursor];
    const fields = (raw ?? '').split(',');
    if (fields.length < 5) return fail(lineNo, `数字通道声明字段不足（期望 5，实际 ${fields.length}）`);
    const [dn, id, phase, monitored, normalT] = fields.map(field => field.trim());
    const number = Number(dn);
    if (!Number.isInteger(number) || number < 1) return fail(lineNo, `数字通道号无效：${dn}`);
    digital.push({ number, id: id || `D${number}`, phase, monitored, normal: Number(normalT || '0'), raw });
  }

  const lineFrequency = Number((lines[cursor] ?? '').trim());
  if (!Number.isFinite(lineFrequency)) return fail(cursor + 1, '频率行无法解释');
  cursor++;
  const rateCount = Number((lines[cursor] ?? '').trim());
  if (!Number.isInteger(rateCount) || rateCount < 1) return fail(cursor + 1, '采样率段数无效');
  cursor++;
  const rates = [];
  let previousEnd = 0;
  for (let i = 0; i < rateCount; i++, cursor++) {
    const match = /^\s*(\d+(?:\.\d+)?)\s*,\s*(\d+)\s*$/.exec(lines[cursor] ?? '');
    if (!match) return fail(cursor + 1, '采样率行格式无效（期望 samp,endsamp）');
    const [rate, endSample] = [Number(match[1]), Number(match[2])];
    if (rate <= 0) return fail(cursor + 1, `采样率必须为正：${rate}`);
    if (endSample <= previousEnd) return fail(cursor + 1, `采样段终点 ${endSample} 未严格递增（endSample 为闭合端点）`);
    rates.push({ rate, endSample });
    previousEnd = endSample;
  }
  const totalSamples = previousEnd;

  const startTime = parseTimestampLine(lines[cursor], cursor + 1, name, issues);
  cursor++;
  const triggerTime = parseTimestampLine(lines[cursor], cursor + 1, name, issues);
  cursor++;
  const fileType = (lines[cursor] ?? '').trim().toUpperCase();
  if (!CONTRACT.encodings.includes(fileType)) return fail(cursor + 1, `编码 ${fileType || '（空）'} 超出契约范围（${CONTRACT.encodings.join('/')}）`);
  cursor++;
  let timeMult = 1;
  const multLine = (lines[cursor] ?? '').trim();
  if (multLine === '') issues.push({ location: `${name}:${cursor + 1}`, severity: 'warning', message: '缺少时间乘数行，按 1 处理' });
  else {
    timeMult = Number(multLine);
    if (!Number.isFinite(timeMult) || timeMult <= 0) return fail(cursor + 1, `时间乘数无效：${multLine}`);
  }
  cursor++;
  if (cursor < lines.length) issues.push({ location: `${name}:${cursor + 1}`, severity: 'warning', message: `配置尾部存在 ${lines.length - cursor} 行未使用内容，保留原文不解释` });

  return {
    config: {
      station, device, revision, totalChannels, analogCount, digitalCount, analog, digital,
      lineFrequency, rates, totalSamples, startTime, triggerTime, fileType, timeMult,
    },
    issues,
  };
}

function analogEntry(channel, raw, missing, marker) {
  const base = { channel: channel.id, number: channel.number, unit: channel.unit };
  if (missing) return { ...base, value: null, status: 'missing', raw: Number.isNaN(raw) ? null : raw, marker };
  return { ...base, value: round12(raw * channel.a + channel.b), status: 'ok', raw };
}

function assembleRecord(config, sampleNo, rawT, analog, digital, name, issues, stats) {
  let micros;
  let recovered = false;
  if (rawT === 0) {
    micros = nominalMicros(config.rates, sampleNo);
    recovered = true;
    stats.recoveredTimestamps++;
    issues.push({ location: `${name}#sample${sampleNo}`, severity: 'warning', message: `样本 ${sampleNo} 时间戳为 0，按声明采样段（闭合端点）推算为 ${micros} 微秒` });
  } else {
    micros = Math.round(rawT * config.timeMult);
  }
  stats.missingValues += analog.filter(entry => entry.status === 'missing').length;
  const timestamp = { micros, raw: rawT, recovered };
  const at = absoluteIso(config.startTime, micros);
  if (at) timestamp.at = at;
  if (recovered) timestamp.basis = '时间戳为 0，按 cfg 声明采样段（闭合端点）推算';
  return { sample: sampleNo, timestamp, analog, digital };
}

function parseBinary(config, bytes, name, issues, records, stats) {
  const traits = BINARY_TRAITS[config.fileType];
  const words = Math.ceil(config.digitalCount / 16);
  const sampleBytes = 8 + traits.analogBytes * config.analogCount + 2 * words;
  let parsed = 0;
  for (let n = 1; n <= config.totalSamples; n++) {
    const offset = (n - 1) * sampleBytes;
    const remaining = bytes.length - offset;
    if (remaining < sampleBytes) {
      issues.push({ location: `${name}#sample${n}`, severity: 'error', message: `样本 ${n} 数据不足：需要 ${sampleBytes} 字节，剩余 ${Math.max(remaining, 0)} 字节，不补零` });
      break;
    }
    const sampleNo = bytes.readUInt32LE(offset);
    const rawT = bytes.readInt32LE(offset + 4);
    if (sampleNo !== n) issues.push({ location: `${name}#sample${n}`, severity: 'error', message: `样本编号 ${sampleNo} 与位置期望 ${n} 不一致` });
    let cursor = offset + 8;
    const analog = config.analog.map(channel => {
      const raw = traits.read(bytes, cursor);
      cursor += traits.analogBytes;
      return analogEntry(channel, raw, traits.isMissing(raw), traits.marker);
    });
    const digital = config.digital.map((channel, d) => {
      const word = bytes.readUInt16LE(cursor + 2 * Math.floor(d / 16));
      return { channel: channel.id, number: channel.number, value: (word >> (d % 16)) & 1, status: 'ok' };
    });
    records.push(assembleRecord(config, sampleNo, rawT, analog, digital, name, issues, stats));
    parsed++;
  }
  stats.parsedSamples = parsed;
  if (parsed === config.totalSamples && bytes.length > parsed * sampleBytes) {
    issues.push({ location: `${name}#offset${parsed * sampleBytes}`, severity: 'error', message: `数据尾部多出 ${bytes.length - parsed * sampleBytes} 字节未解释` });
  }
}

function parseAscii(config, text, name, issues, records, stats) {
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');
  const expected = 2 + config.analogCount + config.digitalCount;
  let parsed = 0;
  for (let n = 1; n <= config.totalSamples; n++) {
    const line = lines[n - 1];
    if (line === undefined) {
      issues.push({ location: `${name}#sample${n}`, severity: 'error', message: `样本 ${n} 缺失：数据行不足（期望 ${config.totalSamples} 行，实际 ${lines.length} 行），不补零` });
      break;
    }
    const fields = line.split(',');
    if (fields.length < expected) {
      issues.push({ location: `${name}#sample${n}`, severity: 'error', message: `样本 ${n} 字段不足：期望 ${expected}，实际 ${fields.length}，不补零` });
      break;
    }
    if (fields.length > expected) issues.push({ location: `${name}#sample${n}`, severity: 'warning', message: `样本 ${n} 多出 ${fields.length - expected} 个字段，未解释` });
    const [sampleNo, rawT] = [Number(fields[0]), Number(fields[1])];
    if (!Number.isFinite(sampleNo) || !Number.isFinite(rawT)) {
      issues.push({ location: `${name}#sample${n}`, severity: 'error', message: `样本 ${n} 的编号或时间戳无法解释，不补零` });
      break;
    }
    if (sampleNo !== n) issues.push({ location: `${name}#sample${n}`, severity: 'error', message: `样本编号 ${sampleNo} 与位置期望 ${n} 不一致` });
    const analog = config.analog.map((channel, i) => {
      const field = (fields[2 + i] ?? '').trim();
      if (field === '') return analogEntry(channel, null, true, 'empty');
      const raw = Number(field);
      if (!Number.isFinite(raw)) {
        issues.push({ location: `${name}#sample${n}`, severity: 'warning', message: `样本 ${n} 模拟通道 ${channel.id} 取值无法解释：${field}` });
        return analogEntry(channel, null, true, 'unreadable');
      }
      return analogEntry(channel, raw, raw === MISSING_INT16, 'int16-min');
    });
    const digital = config.digital.map((channel, d) => {
      const field = (fields[2 + config.analogCount + d] ?? '').trim();
      if (!['0', '1'].includes(field)) issues.push({ location: `${name}#sample${n}`, severity: 'warning', message: `样本 ${n} 数字通道 ${channel.id} 取值非 0/1：${field || '（空）'}，按 ${field === '1' ? 1 : 0} 处理` });
      return { channel: channel.id, number: channel.number, value: field === '1' ? 1 : 0, status: 'ok' };
    });
    records.push(assembleRecord(config, sampleNo, rawT, analog, digital, name, issues, stats));
    parsed++;
  }
  stats.parsedSamples = parsed;
  if (parsed === config.totalSamples && lines.length > config.totalSamples) {
    issues.push({ location: `${name}#line${config.totalSamples + 1}`, severity: 'error', message: `数据多出 ${lines.length - config.totalSamples} 行未解释` });
  }
}

export function parseData(config, bytes, name = 'dat') {
  const issues = [];
  const records = [];
  const stats = { parsedSamples: 0, missingValues: 0, recoveredTimestamps: 0 };
  if (config.fileType === 'ASCII') parseAscii(config, bytes.toString('utf8'), name, issues, records, stats);
  else parseBinary(config, bytes, name, issues, records, stats);
  return { records, issues, stats };
}

// 通道声明与时刻依据：a、b、primary、secondary、P/S 及单位保留原文，供量纲追溯。
export function describeConfig(config) {
  return {
    station: config.station,
    device: config.device,
    revision: config.revision,
    analog: config.analog.map(channel => ({
      number: channel.number, id: channel.id, phase: channel.phase, monitored: channel.monitored, unit: channel.unit,
      scale: { a: channel.a, b: channel.b }, primary: channel.primary, secondary: channel.secondary, ps: channel.ps,
      range: { min: channel.min, max: channel.max }, skew: channel.skew,
      source: { ...channel.text, line: channel.raw },
    })),
    digital: config.digital.map(channel => ({
      number: channel.number, id: channel.id, phase: channel.phase, monitored: channel.monitored, normal: channel.normal,
      source: { line: channel.raw },
    })),
    times: { start: config.startTime.raw, trigger: config.triggerTime.raw },
  };
}

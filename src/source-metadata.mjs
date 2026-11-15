function parseJson(bytes) { try { return JSON.parse(bytes.toString()); } catch { return null; } }
export function inspect(bytes) { const rows = bytes.toString('utf8').trim().split(/\r?\n/); return { format: 'COMTRADE', station: rows[0]?.split(',')[0] || null, configRows: rows.length }; }

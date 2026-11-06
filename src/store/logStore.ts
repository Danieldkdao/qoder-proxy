import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import config from '../config';
type Log = Record<string, unknown>;
const requestLog: Log[] = [], systemLog: Log[] = [];
function truncate(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  const bytes = Buffer.from(raw);
  if (bytes.length <= config.LOG_BODY_MAX_BYTES) return value;
  const decoder = new StringDecoder('utf8');
  return decoder.write(bytes.subarray(0, config.LOG_BODY_MAX_BYTES)) + '…[truncated]';
}
function push(log: Log[], entry: Log) { log.push({ id: randomUUID(), timestamp: new Date().toISOString(), ...entry }); if (log.length > config.LOG_MAX_ENTRIES) log.shift(); }
export function addRequest(entry: Log): void { push(requestLog, { ...entry, requestPayload: config.LOG_PAYLOADS ? truncate(entry.requestPayload) : null, responsePayload: config.LOG_PAYLOADS ? truncate(entry.responsePayload) : null }); }
export function addSystem(message: string, level = 'info', source = 'server'): void { push(systemLog, { message: truncate(message), level, source }); }
export const getRequests = () => [...requestLog].reverse();
export const getSystem = () => [...systemLog].reverse();
export const clearRequests = () => { requestLog.length = 0; };
export const clearSystem = () => { systemLog.length = 0; };

/**
 * Every transition runs inside Redis as one script, so the check and the
 * write cannot interleave with another client's. Timestamps are computed by
 * the caller and passed in as strings: Lua's number formatting is not safe
 * for epoch milliseconds, and it keeps the arithmetic identical to the
 * memory and MongoDB stores.
 */

/** KEYS[1] key · ARGV: fingerprint, token, now, expiresAt, lockExpiresAt, keyTtlMs */
export const ACQUIRE = `
local key = KEYS[1]
local now = tonumber(ARGV[3])
local status = redis.call('HGET', key, 'status')
local claimable = false
if not status then
  claimable = true
else
  local expiresAt = tonumber(redis.call('HGET', key, 'expiresAt'))
  if expiresAt <= now then
    claimable = true
  elseif status == 'in-flight' then
    local lockExpiresAt = tonumber(redis.call('HGET', key, 'lockExpiresAt'))
    if lockExpiresAt <= now then claimable = true end
  end
end
if claimable then
  redis.call('DEL', key)
  redis.call('HSET', key,
    'status', 'in-flight',
    'fingerprint', ARGV[1],
    'token', ARGV[2],
    'createdAt', ARGV[3],
    'expiresAt', ARGV[4],
    'lockExpiresAt', ARGV[5])
  redis.call('PEXPIRE', key, tonumber(ARGV[6]))
  return { 'acquired', redis.call('HGETALL', key) }
end
return { status, redis.call('HGETALL', key) }
`;

/** KEYS[1] key · ARGV: token, response (JSON), completedAt */
export const COMPLETE = `
local key = KEYS[1]
if redis.call('HGET', key, 'status') ~= 'in-flight' then return 0 end
if redis.call('HGET', key, 'token') ~= ARGV[1] then return 0 end
redis.call('HSET', key, 'status', 'completed', 'response', ARGV[2], 'completedAt', ARGV[3])
redis.call('HDEL', key, 'lockExpiresAt')
return 1
`;

/** KEYS[1] key · ARGV: token */
export const RELEASE = `
local key = KEYS[1]
if redis.call('HGET', key, 'status') ~= 'in-flight' then return 0 end
if redis.call('HGET', key, 'token') ~= ARGV[1] then return 0 end
redis.call('DEL', key)
return 1
`;

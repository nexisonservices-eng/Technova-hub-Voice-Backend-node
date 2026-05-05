import axios from 'axios';

const baseUrl = (process.env.VOICE_API_BASE || 'http://localhost:5000').replace(/\/$/, '');
const token = process.env.AUTH_TOKEN || process.env.VOICE_AUTH_TOKEN || '';
const broadcastId = process.env.BROADCAST_ID || process.env.VOICE_BROADCAST_ID || '';

const client = axios.create({
  baseURL: baseUrl,
  timeout: 10000,
  validateStatus: () => true,
  headers: token ? { Authorization: `Bearer ${token}` } : {}
});

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const getCalls = (id, params = {}) => client.get(`/broadcast/${id}/calls`, { params });

if (!token) {
  console.log('Skipping broadcast calls smoke checks: set AUTH_TOKEN or VOICE_AUTH_TOKEN to call the authenticated API.');
  process.exit(0);
}

const invalidIdResponse = await getCalls('invalid-id');
assert(invalidIdResponse.status === 400, `Expected invalid id to return 400, got ${invalidIdResponse.status}`);

if (!broadcastId) {
  console.log('Invalid-id smoke check passed. Set BROADCAST_ID to run pagination, filter, limit, and cursor checks.');
  process.exit(0);
}

const pageResponse = await getCalls(broadcastId, { page: 1, limit: 50 });
assert(pageResponse.status === 200, `Expected page request to return 200, got ${pageResponse.status}`);
assert(Array.isArray(pageResponse.data?.calls), 'Expected calls array in page response');
assert(pageResponse.data?.pagination?.limit === 50, 'Expected pagination limit to remain 50');

const cappedLimitResponse = await getCalls(broadcastId, { page: 1, limit: 999 });
assert(cappedLimitResponse.status === 200, `Expected capped limit request to return 200, got ${cappedLimitResponse.status}`);
assert(cappedLimitResponse.data?.pagination?.limit === 200, 'Expected limit to be capped at 200');

const statusResponse = await getCalls(broadcastId, { status: 'completed', page: 1, limit: 25 });
assert(statusResponse.status === 200, `Expected status filter request to return 200, got ${statusResponse.status}`);
assert(
  (statusResponse.data?.calls || []).every((call) => call.status === 'completed'),
  'Expected completed status filter to return only completed calls'
);

const firstCursorResponse = await getCalls(broadcastId, { cursor: Buffer.from(JSON.stringify({
  value: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  id: 'ffffffffffffffffffffffff'
})).toString('base64'), limit: 10 });
assert(firstCursorResponse.status === 200, `Expected cursor request to return 200, got ${firstCursorResponse.status}`);
assert('hasMore' in (firstCursorResponse.data?.pagination || {}), 'Expected cursor metadata in pagination response');

console.log('Broadcast calls route smoke checks passed.');

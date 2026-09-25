import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import mongoose from 'mongoose';
import { getReadUserObjectId, getUserObjectId } from '../src/utils/authContext.js';

const admin = '111111111111111111111111';
const agent = '222222222222222222222222';
const outsider = '333333333333333333333333';
const reqFor = (role = 'admin') => ({ user: { id: admin, companyRole: role, workspaceReadUserIds: [admin, agent] }, query: {} });

test('admin reads include agents, while writes keep actor identity', () => {
  const req = reqFor();
  assert.deepEqual(getReadUserObjectId(req).$in.map(String), [admin, agent]);
  assert.equal(String(getUserObjectId(req)), admin);
  assert.ok(!getReadUserObjectId(req).$in.map(String).includes(outsider));
});

test('agents cannot widen scope with membership or query parameters', () => {
  const req = reqFor('user');
  req.query = { userId: outsider, workspaceReadUserIds: [outsider] };
  assert.equal(String(getReadUserObjectId(req)), admin);
  assert.equal(getReadUserObjectId({ user: { id: 'invalid', companyRole: 'admin' } }), null);
});

test('broadcast list, summary and count use the same admin/agent scope', async () => {
  const queries = [];
  const source = fs.readFileSync(new URL('../src/controllers/broadcastController.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('export default new BroadcastController();', 'globalThis.controller = new BroadcastController();');
  const context = {
    mongoose, getUserObjectId, getReadUserObjectId,
    logger: { error: (...args) => { throw new Error(args.join(' ')); } },
    Broadcast: {
      aggregate: async (pipeline) => { queries.push(pipeline[0].$match); return []; },
      countDocuments: async (filter) => { queries.push(filter); return 0; }
    }
  };
  vm.runInNewContext(source, context);
  let response;
  await context.controller.listBroadcasts(reqFor(), { json: (body) => { response = body; } });
  assert.equal(response.success, true);
  assert.equal(queries.length, 3);
  for (const query of queries) assert.deepEqual(query.createdBy.$in.map(String), [admin, agent]);
});

test('live analytics uses trusted membership and isolates workspace cache entries', () => {
  const source = fs.readFileSync(new URL('../src/controllers/analyticsController.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/export default .*;/, 'globalThis.controller = new AnalyticsController();');
  const context = { mongoose, getReadUserObjectId, getRawUserId: (user) => user.id };
  vm.runInNewContext(source, context);
  const controller = context.controller;
  controller.registerAnalyticsSubscription({ id: 'socket-admin', user: reqFor().user }, { userId: outsider });
  const [target] = controller.getActiveBroadcastTargets({ userId: agent });
  assert.equal(target.userId, admin);
  assert.deepEqual(target.readScope.$in.map(String), [admin, agent]);
  const key = controller.buildCacheKey('today', 'all', 'all', target.readScope);
  const otherKey = controller.buildCacheKey('today', 'all', 'all', { $in: [new mongoose.Types.ObjectId(outsider)] });
  assert.notEqual(key, otherKey);
  controller.cache.set(key, {});
  controller.cache.set(otherKey, {});
  controller.clearUserCache(agent);
  assert.equal(controller.cache.has(key), false);
  assert.equal(controller.cache.has(otherKey), true);
});

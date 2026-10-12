'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startServer, signIn } = require('./helpers');

// A service plan is live when the presenter publishes it alongside the slides.
function publishPlan(server, cookie, items, planIndex = 0) {
  return server.api('/remote/state', {
    method: 'POST',
    body: {
      title: items[planIndex].title,
      slides: items[planIndex].slides,
      index: 0,
      plan: { id: 'plan-1', title: 'Sunday service', date: '2026-10-12', items },
      plan_index: planIndex
    }
  }, cookie);
}

const ITEMS = [
  { id: 'song-1', title: 'Opening Song', slides: ['one-a', 'one-b'] },
  { id: 'song-2', title: 'Second Song', slides: ['two-a', 'two-b', 'two-c'] },
  { id: 'song-3', title: 'Closing Song', slides: ['three-a'] }
];

test('service plan navigation', async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const { cookie } = await signIn(server);
  const headers = async () => {
    const created = await server.api('/remote/pairing', { method: 'POST', body: {} }, cookie);
    const paired = await server.api('/remote/pair', { method: 'POST', body: { code: created.body.code } });
    return { Authorization: 'Bearer ' + paired.body.token };
  };

  await t.test('publishing a plan exposes the whole rundown', async () => {
    await publishPlan(server, cookie, ITEMS);
    const res = await server.api('/remote/state', {}, cookie);
    assert.equal(res.body.state.count, 2, 'starts on the first song');
    assert.equal(res.body.state.title, 'Opening Song');
    assert.equal(res.body.state.rundown.length, 3, 'every song appears in the rundown');
    assert.deepEqual(res.body.state.rundown.map(r => r.title), ['Opening Song', 'Second Song', 'Closing Song']);
    assert.equal(res.body.state.rundown[0].current, true);
    assert.deepEqual(res.body.state.plan, { id: 'plan-1', title: 'Sunday service', date: '2026-10-12', item_index: 0, item_count: 3 });
  });

  await t.test('next at the end of a song moves into the next song', async () => {
    await publishPlan(server, cookie, ITEMS);
    const h = await headers();

    const send = body => server.api('/remote/command', { method: 'POST', headers: h, body });
    assert.equal((await send({ action: 'next' })).body.state.index, 1, 'still within the first song');
    assert.equal((await send({ action: 'next' })).body.state.count, 3, 'crossed into the second song');
    assert.equal((await send({ action: 'next' })).body.state.title, 'Second Song');
  });

  await t.test('previous at the start of a song steps back into the last slide of the previous one', async () => {
    await publishPlan(server, cookie, ITEMS, 1);
    const h = await headers();

    const send = body => server.api('/remote/command', { method: 'POST', headers: h, body });
    const back = await send({ action: 'previous' });
    assert.equal(back.body.state.title, 'Opening Song');
    assert.equal(back.body.state.index, 1, 'lands on the last slide of that song');
    assert.equal(back.body.state.count, 2);
  });

  await t.test('goto can jump straight into another song', async () => {
    await publishPlan(server, cookie, ITEMS);
    const h = await headers();

    const res = await server.api('/remote/command', {
      method: 'POST', headers: h, body: { action: 'goto', item_index: 2, index: 0 }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.state.title, 'Closing Song');
    assert.equal(res.body.state.index, 0);
    assert.equal(res.body.state.plan.item_index, 2);
  });

  await t.test('goto rejects an item outside the plan', async () => {
    await publishPlan(server, cookie, ITEMS);
    const h = await headers();
    for (const item_index of [-1, 3, 1.5, 'x', null]) {
      const res = await server.api('/remote/command', {
        method: 'POST', headers: h, body: { action: 'goto', item_index }
      });
      assert.equal(res.status, 400, 'item_index ' + JSON.stringify(item_index) + ' must be rejected');
    }
  });

  await t.test('goto still validates the slide within the target song', async () => {
    await publishPlan(server, cookie, ITEMS);
    const h = await headers();
    // Closing Song has a single slide, so index 5 is out of range there.
    const res = await server.api('/remote/command', {
      method: 'POST', headers: h, body: { action: 'goto', item_index: 2, index: 5 }
    });
    assert.equal(res.status, 400);
  });

  await t.test('without a plan, next stops at the last slide', async () => {
    await server.api('/remote/state', {
      method: 'POST', body: { title: 'Solo', slides: ['a', 'b'], index: 0, plan: null }
    }, cookie);
    const h = await headers();
    const send = body => server.api('/remote/command', { method: 'POST', headers: h, body });

    await send({ action: 'next' });
    const end = await send({ action: 'next' });
    assert.equal(end.body.state.index, 1, 'cannot pass the last slide with no plan');
    assert.equal(end.body.state.plan, null);
    assert.equal(end.body.state.rundown.length, 0);
  });

  await t.test('the last song does not advance past the end of the plan', async () => {
    await publishPlan(server, cookie, ITEMS, 2);
    const h = await headers();
    const res = await server.api('/remote/command', { method: 'POST', headers: h, body: { action: 'next' } });
    assert.equal(res.body.state.plan.item_index, 2, 'stays on the final song');
    assert.equal(res.body.state.index, 0);
  });
});

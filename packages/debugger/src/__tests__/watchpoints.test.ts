import { describe, expect, it } from 'vitest';
import { WatchpointError, type WatchpointHit } from '../index.js';
import { addressOf, ARRAY_MAX, FIBONACCI, sessionFor, STACK } from './fixtures.js';

describe('watchpoints', () => {
  it('reports the STORE that writes 0x05 to 0x85 in fibonacci', () => {
    const session = sessionFor(FIBONACCI);
    const store = addressOf(FIBONACCI, 'STORE [R4], R2');
    session.addWatchpoint({ address: 0x85, kind: 'write' });

    const stop = session.run();

    expect(stop.stopReason).toBe('watchpoint');
    if (stop.stopReason !== 'watchpoint') return;
    expect(stop.hit).toMatchObject({
      access: 'write',
      pc: store,
      text: 'STORE [R4], R2',
      address: 0x85,
      oldValue: 0x00,
      newValue: 0x05,
    });
    expect(stop.hit.instruction?.id).toBe('STORE_IND');
    // The watchpoint stops after the accessing instruction completes.
    expect(session.getState().memory[0x85]).toBe(0x05);
    expect(stop.pc).toBe(store + 2);
    expect(stop.hits).toEqual([stop.hit]);
  });

  it('fires read watchpoints on LOAD only, not on writes', () => {
    const session = sessionFor(ARRAY_MAX);
    const table = addressOf(ARRAY_MAX, '.byte 7, 200, 3, 255, 9');
    session.addWatchpoint({ range: { start: table, end: table + 4 }, kind: 'read' });
    session.addWatchpoint({ address: 0xa0, kind: 'read' });

    const hits: WatchpointHit[] = [];
    for (let stop = session.run(); stop.stopReason === 'watchpoint'; stop = session.run()) {
      hits.push(stop.hit);
    }

    expect(hits.map((hit) => hit.address)).toEqual([0, 1, 2, 3, 4].map((i) => table + i));
    expect(hits.map((hit) => hit.newValue)).toEqual([7, 200, 3, 255, 9]);
    expect(hits.every((hit) => hit.access === 'read' && hit.oldValue === hit.newValue)).toBe(true);
    expect(hits[0]?.text).toBe('LOAD R3, [R1]');
    expect(session.getStatus()).toBe('HALTED');
  });

  it('fires access watchpoints on both the reads and writes of the stack', () => {
    const session = sessionFor(STACK);
    session.addWatchpoint({ address: 0xff, kind: 'access' });

    const first = session.run();
    const second = session.run();

    expect(first.stopReason === 'watchpoint' && first.hit).toMatchObject({
      access: 'write',
      text: 'PUSH R0',
      address: 0xff,
      oldValue: 0,
      newValue: 3,
    });
    expect(second.stopReason === 'watchpoint' && second.hit).toMatchObject({
      access: 'read',
      text: 'POP R3',
      address: 0xff,
      newValue: 3,
    });
    expect(session.run().stopReason).toBe('halted');
  });

  it('reports CALL and RET return-address traffic and every matching watchpoint', () => {
    const session = sessionFor(STACK);
    const write = session.addWatchpoint({ range: { start: 0xfc, end: 0xfd }, kind: 'write' });
    const access = session.addWatchpoint({ range: { start: 0xf0, end: 0xff }, kind: 'access' });
    session.toggleWatchpoint(access.id, false);

    const call = session.run();
    expect(call.stopReason === 'watchpoint' && call.hit).toMatchObject({
      watchpoint: write,
      // `sum:` is the PUSH R1 right before the subroutine's ADD.
      text: `CALL 0x${(addressOf(STACK, 'ADD R0, R1') - 2).toString(16).toUpperCase()}`,
      address: 0xfd,
      newValue: addressOf(STACK, 'POP R2'),
    });

    session.toggleWatchpoint(access.id);
    const push = session.step();
    expect(push.stopReason).toBe('watchpoint');
    expect(push.hits.map((hit) => hit.watchpoint.id)).toEqual([write.id, access.id]);
  });

  it('reports hits from step() without stopping it, and none from instruction fetches', () => {
    const session = sessionFor(FIBONACCI);
    session.addWatchpoint({ range: { start: 0, end: 0x7f }, kind: 'access' });
    session.addWatchpoint({ address: 0x80, kind: 'write' });

    const steps = [session.step(), session.step(), session.step(), session.step()];

    expect(steps.map((stop) => stop.stopReason)).toEqual(['step', 'step', 'step', 'watchpoint']);
    expect(steps[3]?.hits).toHaveLength(1);
  });

  it('validates targets and manages the list', () => {
    const session = sessionFor(FIBONACCI);
    expect(() => session.addWatchpoint({ range: { start: 5, end: 4 }, kind: 'read' })).toThrow(
      WatchpointError,
    );
    expect(() => session.addWatchpoint({ address: 300, kind: 'write' })).toThrow(WatchpointError);
    expect(() =>
      session.addWatchpoint({ address: 1, kind: 'execute' as unknown as 'read' }),
    ).toThrow(/read, write or access/);
    expect(() => session.toggleWatchpoint(42)).toThrow(/no watchpoint 42/);

    const watchpoint = session.addWatchpoint({ address: 0x85, kind: 'write' });
    expect(session.listWatchpoints()).toEqual([watchpoint]);
    expect(session.removeWatchpoint(watchpoint.id)).toBe(true);
    expect(session.removeWatchpoint(watchpoint.id)).toBe(false);
    expect(session.run().stopReason).toBe('halted');
  });
});

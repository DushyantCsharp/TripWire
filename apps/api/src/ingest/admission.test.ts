import { describe, expect, it } from '@jest/globals';
import { QueueDepthAdmission } from './admission.js';

/** A queue whose depth is `waiting` (fixed, or one value per sample), finishing `finishedSeries`. */
function admission(waiting: number | number[], finishedSeries: number[], random = 0) {
  let clock = 0;
  const depths = Array.isArray(waiting) ? [...waiting] : [];
  const finished = [...finishedSeries];
  return {
    control: new QueueDepthAdmission(
      {
        waiting: () => Promise.resolve(Array.isArray(waiting) ? (depths.shift() ?? 0) : waiting),
        finished: () => Promise.resolve(finished.shift() ?? 0),
      },
      { highWater: 1_000, now: () => clock, random: () => random },
    ),
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe('QueueDepthAdmission', () => {
  it('admits while the queue is at or under the high-water mark', async () => {
    const { control } = admission(1_000, [0]);
    await control.sample();
    expect(control.check()).toBeNull();
  });

  it('sheds above it, asking senders to wait as long as draining the excess takes', async () => {
    const { control, tick } = admission(1_500, [0, 100]);
    await control.sample();
    tick(1_000);
    await control.sample();
    // 500 jobs over the mark, draining at 100/s: 5 s.
    expect(control.check()).toEqual({ retryAfterSeconds: 5 });
  });

  it('adds up to 25% jitter', async () => {
    const { control, tick } = admission(1_500, [0, 100], 0.999);
    await control.sample();
    tick(1_000);
    await control.sample();
    expect(control.check()).toEqual({ retryAfterSeconds: 7 });
  });

  it('times the drain from when the backlog began, not across the quiet time before a storm', async () => {
    // Nine quiet seconds draining a trickle (50/s), then a storm: 4,000 waiting, and the worker
    // finishing 600 in the storm's first second.
    const depths = [...Array.from({ length: 10 }, () => 0), 4_000];
    const finished = [...Array.from({ length: 10 }, (_, second) => second * 50), 450 + 600];
    const { control, tick } = admission(depths, finished);
    await control.sample();
    for (let second = 1; second <= 10; second++) {
      tick(1_000);
      await control.sample();
    }
    // 3,000 over the mark at 600/s: 5 s. Averaged over the whole window (105/s) it would be 29 s.
    expect(control.check()).toEqual({ retryAfterSeconds: 5 });
  });

  it('asks for the maximum wait when nothing is draining', async () => {
    const { control, tick } = admission(5_000, [42, 42]);
    await control.sample();
    tick(1_000);
    await control.sample();
    expect(control.check()).toEqual({ retryAfterSeconds: 60 });
  });

  it('keeps its last known state when sampling fails', async () => {
    const errors: unknown[] = [];
    const control = new QueueDepthAdmission(
      {
        waiting: () => Promise.reject(new Error('redis down')),
        finished: () => Promise.resolve(0),
      },
      { highWater: 10, onError: (error) => errors.push(error) },
    );
    await control.sample();
    await control.sample();
    expect(control.check()).toBeNull();
    expect(errors).toHaveLength(1);
  });
});

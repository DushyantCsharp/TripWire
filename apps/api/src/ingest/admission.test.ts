import { describe, expect, it } from '@jest/globals';
import { QueueDepthAdmission } from './admission.js';

function admission(waiting: number, finishedSeries: number[], random = 0) {
  let clock = 0;
  const finished = [...finishedSeries];
  return {
    control: new QueueDepthAdmission(
      {
        waiting: () => Promise.resolve(waiting),
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

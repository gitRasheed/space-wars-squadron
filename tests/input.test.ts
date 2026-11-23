import { describe, expect, it } from 'vitest';
import { applyDeadzone, mergeFlightInputs } from '../src/input/combine';
import { NEUTRAL_INPUT } from '../src/sim/types';

describe('input deadzone and channel merging', () => {
  it('zeros values inside the deadzone and rescales remaining travel smoothly to 1', () => {
    expect(applyDeadzone(0.04, 0.1)).toBe(0);
    expect(applyDeadzone(-0.09, 0.1)).toBe(0);
    expect(applyDeadzone(0.55, 0.1)).toBeCloseTo(0.5, 6);
    expect(applyDeadzone(-1, 0.1)).toBe(-1);
    expect(applyDeadzone(1.5, 0.1)).toBe(1);
  });

  it('merges keyboard/mouse and controller inputs by clamping analog axes and OR-ing triggers', () => {
    const merged = mergeFlightInputs(
      {
        ...NEUTRAL_INPUT,
        pitch: 0.7,
        yaw: -0.6,
        roll: 1,
        firePrimary: true,
        toggleMute: false,
      },
      {
        ...NEUTRAL_INPUT,
        pitch: 0.6,
        yaw: -0.8,
        roll: -0.25,
        throttleDelta: 0.5,
        boost: true,
        drift: true,
        toggleMute: true,
      },
    );

    expect(merged.pitch).toBe(1);
    expect(merged.yaw).toBe(-1);
    expect(merged.roll).toBeCloseTo(0.75, 6);
    expect(merged.throttleDelta).toBe(0.5);
    expect(merged.firePrimary).toBe(true);
    expect(merged.boost).toBe(true);
    expect(merged.drift).toBe(true);
    expect(merged.toggleMute).toBe(true);
    expect(merged.cycleTarget).toBe(false);
  });
});

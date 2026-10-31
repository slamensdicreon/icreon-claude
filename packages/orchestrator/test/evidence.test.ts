import { describe, expect, it } from 'vitest';
import { checksLine } from '../src/evidence';

describe('checksLine', () => {
  it('says how the checks stood, failures first, and nothing when there were none', () => {
    expect(checksLine(undefined)).toBe('');
    expect(checksLine([])).toBe('');
    expect(
      checksLine([
        { id: 'build.green', status: 'pass' },
        { id: 'head.sections', status: 'pending' },
        { id: 'parity.visual', status: 'fail' },
        { id: 'component-map.registered', status: 'pass' },
      ]),
    ).toBe(
      'Checks on the last attempt: failed: parity.visual; passed: build.green, component-map.registered; pending: head.sections.',
    );
  });
});

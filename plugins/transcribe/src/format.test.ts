import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, formatTimestamp } from './format.js';

describe('formatTimestamp — must match asr.format_timestamp in the daemon', () => {
  it('is mm:ss under an hour', () => {
    expect(formatTimestamp(0)).toBe('00:00');
    expect(formatTimestamp(83.9)).toBe('01:23');
  });
  it('is h:mm:ss past an hour', () => {
    expect(formatTimestamp(3725)).toBe('1:02:05');
  });
  it('clamps negatives', () => {
    expect(formatTimestamp(-1)).toBe('00:00');
  });
});

describe('formatDuration', () => {
  it('reads naturally at every scale', () => {
    expect(formatDuration(7.9)).toBe('8 s');
    expect(formatDuration(246)).toBe('4 min 6 s');
    expect(formatDuration(3725)).toBe('1 h 2 min');
  });
  it('says so when ffprobe could not tell', () => {
    expect(formatDuration(null)).toBe('unknown length');
  });
});

describe('formatBytes', () => {
  it('picks a unit', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(74_349)).toBe('74 KB');
    expect(formatBytes(3_400_000)).toBe('3.4 MB');
    expect(formatBytes(1_500_000_000)).toBe('1.5 GB');
  });
});

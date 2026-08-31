import { describe, expect, it } from 'vitest'
import { detectSupervisor } from '../../src/host/supervisor.ts'

describe('detectSupervisor', () => {
  it('detects systemd only when an env marker AND ppid 1 both hold', () => {
    expect(detectSupervisor({ INVOCATION_ID: 'abc' }, { ppid: 1 })).toBe('systemd')
    expect(detectSupervisor({ JOURNAL_STREAM: '8:123' }, { ppid: 1 })).toBe('systemd')
    expect(detectSupervisor({ INVOCATION_ID: 'abc', JOURNAL_STREAM: '8:123' }, { ppid: 1 })).toBe('systemd')
  })

  it('returns null when the process is not the unit main process', () => {
    // INVOCATION_ID is inherited by every descendant of a unit (an ordinary
    // terminal included); ownership needs ppid 1 too.
    expect(detectSupervisor({ INVOCATION_ID: 'abc' }, { ppid: 4321 })).toBe(null)
    expect(detectSupervisor({ JOURNAL_STREAM: '8:123' }, { ppid: 4321 })).toBe(null)
  })

  it('returns null without any marker', () => {
    expect(detectSupervisor({}, { ppid: 1 })).toBe(null)
    expect(detectSupervisor({ PATH: '/usr/bin' }, { ppid: 1 })).toBe(null)
  })
})

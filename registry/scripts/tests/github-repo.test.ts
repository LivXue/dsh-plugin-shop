import { describe, expect, it } from 'vitest'
import { githubOwnerName } from '../src/github-repo.ts'

describe('githubOwnerName', () => {
  it('parses a plain https github url', () => {
    expect(githubOwnerName('https://github.com/octocat/hello-world')).toEqual({ owner: 'octocat', name: 'hello-world' })
  })

  it('strips a trailing .git and trailing slashes', () => {
    expect(githubOwnerName('https://github.com/octocat/hello-world.git')).toEqual({ owner: 'octocat', name: 'hello-world' })
    expect(githubOwnerName('https://github.com/octocat/hello-world/')).toEqual({ owner: 'octocat', name: 'hello-world' })
  })

  it('parses scoped-style repo names with dots and hyphens', () => {
    expect(githubOwnerName('https://github.com/octo-cat/hello.world')).toEqual({ owner: 'octo-cat', name: 'hello.world' })
  })

  it('rejects non-github hosts and protocols', () => {
    expect(githubOwnerName('https://gitlab.com/user/repo')).toBeNull()
    expect(githubOwnerName('https://www.npmjs.com/package/dsh-x')).toBeNull()
    expect(githubOwnerName('git+ssh://git@github.com:user/repo.git')).toBeNull()
    expect(githubOwnerName('http://github.com/user/repo')).toBeNull()
  })

  it('rejects malformed paths and extra segments', () => {
    expect(githubOwnerName('https://github.com/octocat')).toBeNull()
    expect(githubOwnerName('https://github.com/octocat/hello-world/tree/main')).toBeNull()
    expect(githubOwnerName('https://github.com/octocat/hello-world/issues')).toBeNull()
    expect(githubOwnerName('not a url')).toBeNull()
    expect(githubOwnerName('github.com/octocat/hello-world')).toBeNull()
    expect(githubOwnerName(null)).toBeNull()
  })
})

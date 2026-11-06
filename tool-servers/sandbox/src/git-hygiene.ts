/*
 * Git with a token in a machine where agent-written code runs. A build can write anything in the
 * working copy, .git included, so before each command that carries the token: drop every local
 * setting that could run a program or send the request somewhere else (hooks, fsmonitor, filter
 * and merge drivers, URL rewrites, proxies, includes), point origin back at GitHub, and run git
 * itself with hooks and fsmonitor off. The token then only ever goes to github.com.
 */

/** Local settings that could run a program, or reroute a fetch or push. */
const RISKY =
  '^(url|http|credential|include|includeif|filter|diff|merge|gpg|remote\\.origin\\.pushurl|core\\.(hookspath|fsmonitor|sshcommand|askpass|editor|pager|gitproxy)|sequence\\.editor)\\b';

/** A shell script that scrubs .git/config and resets origin. Takes the repo URL as $1. */
export const SCRUB = [
  `git config --local --name-only --get-regexp '${RISKY}' 2>/dev/null | sort -u | while read -r k; do git config --local --unset-all "$k"; done`,
  'git remote set-url origin "$1"',
  'rm -rf .git/hooks && mkdir -p .git/hooks',
].join('; ');

/** The flags every authenticated git command runs with, ahead of the token. */
export function authFlags(header: string): string[] {
  return [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    `http.extraHeader=${header}`,
  ];
}

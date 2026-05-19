# Contributing to Relay

Relay's Obsidian plugin is MIT licensed and developed in the open so users can inspect and audit the code they install. Transparency and trust are the primary goals of this repository.

The best place to start is the Relay Discord: [Join our Discord](https://discord.system3.md). Please discuss an idea there before opening a large pull request or starting work on a behavior change.

## What We Can Usually Review

We can usually review small, focused pull requests, especially:

- Typo and documentation fixes
- Small UI polish
- Narrowly scoped bug fixes with clear reproduction steps
- Small improvements to tests or developer ergonomics

Keep pull requests easy to evaluate. Include what changed, why it changed, and how you tested it.

## Changes to Discuss First

Please talk to us in Discord before working on:

- New product features
- Protocol, sync, merge, auth, permissions, or billing behavior
- Large refactors
- Changes that require server support
- Changes that affect data durability, privacy, encryption, or account access

We probably will not accept large pull requests that arrive without prior discussion, even if the code is good. Relay has product constraints and private infrastructure that may not be obvious from this repository.

## Testing

This repository includes public tests, but Relay also has a large proprietary test suite that is not public. Maintainers run that suite before shipping changes. A pull request passing the public tests is necessary, but it may not be sufficient for a merge or release.

Before opening a pull request, run the relevant checks:

```bash
npm test
npm run lint
npm run build
```

If a check fails for a reason unrelated to your change, mention that in the pull request.

## Support and Security

For questions, support, feature ideas, and early design discussion, use the [Relay Discord](https://discord.system3.md).

For responsible security disclosures, email security@system3.md.

## License

By submitting code, documentation, or other changes to this repository, you agree that your contribution may be distributed under the repository's MIT license.

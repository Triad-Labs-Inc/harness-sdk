# Third-party distribution and license notes

Harness SDK's own packages are MIT licensed. Provider software remains independently licensed and is not bundled into the core or Codex package.

## Codex

`@triadlabs/harness-sdk/codex` supervises a separately installed `codex app-server`. Applications are responsible for installing Codex, accepting its applicable terms, and authenticating it. Harness does not install, update, or log in to Codex. See the [upstream Codex repository and license](https://github.com/openai/codex).

The Codex adapter depends on `cross-spawn` 7.0.6 to resolve executable and npm `.cmd` shims safely on Windows without interpolating provider arguments through a shell. `cross-spawn` and its `path-key`, `shebang-command`, `shebang-regex`, `which`, and `isexe` dependencies are MIT licensed. Their license texts and package metadata are included by npm in an installed dependency tree. See the [`cross-spawn` source and license information](https://github.com/moxystudio/node-cross-spawn).

## Claude Agent SDK and Claude Code

The `@triadlabs/harness-sdk` package includes `@anthropic-ai/claude-agent-sdk` for its `/claude` export. That SDK declares its own license and optional platform-specific Claude Code packages; those terms are not replaced by Harness's MIT license. Review the installed SDK's `LICENSE.md`, package metadata, and Anthropic terms before redistribution.

The Claude adapter can delegate to credentials already available to the user-installed Claude Code runtime, including a local Claude.ai subscription login, or to API credentials supplied through the environment. Harness does not extract, persist, or log those credentials and does not perform login automatically.

Anthropic's current Agent SDK documentation says third-party developers may not offer Claude.ai login or subscription rate limits without prior approval. A product that enables this bring-your-own-subscription path is responsible for confirming that its distribution and account usage have any required approval. Harness's ability to detect and use a local login is not a representation about a distributor's compliance or account entitlement.

References:

- [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [Claude Agent SDK user input](https://code.claude.com/docs/en/agent-sdk/user-input)
- [Claude Agent SDK TypeScript repository](https://github.com/anthropics/claude-agent-sdk-typescript)

## Electron example

Electron is a development dependency of the reference application and retains its own MIT license and bundled third-party notices. A product based on the example must include the notices required by its Electron distribution.

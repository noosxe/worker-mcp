# Builds the Claude Code plugin folder: the repository's plugin manifest, a
# `.mcp.json` that starts the server with an absolute `command`, and the skill.
# Exposed as `lib.mkClaudePlugin`; see the README.
#
#   inputs.worker-mcp.lib.mkClaudePlugin {
#     inherit pkgs;
#     command = "/path/to/launcher";   # default: this flake's worker-mcp
#     env = { WORKER_MCP_ALLOWED_ROOTS = "/home/user/src"; };
#   }
#
# The result is a directory of real files (no symlinks inside), so it can be
# linked as a whole, for example to `~/.claude/skills/worker-mcp`. Claude Code
# rejects a plugin whose entries are symlinks that leave the plugin folder.
{ self }:
{
  pkgs,
  command ? "${self.packages.${pkgs.stdenv.hostPlatform.system}.worker-mcp}/bin/worker-mcp",
  env ? { },
}:
let
  json = pkgs.formats.json { };
  # `userConfig` is for installs without Nix; here `env` and `command` do its job.
  manifest = builtins.removeAttrs (builtins.fromJSON (
    builtins.readFile ../.claude-plugin/plugin.json
  )) [ "userConfig" ];
in
assert pkgs.lib.assertMsg (pkgs.lib.hasPrefix "/" command)
  "mkClaudePlugin: command must be an absolute path";
pkgs.runCommand "worker-mcp-claude-plugin" { } ''
  mkdir -p $out/.claude-plugin $out/skills
  cp ${json.generate "plugin.json" manifest} $out/.claude-plugin/plugin.json
  cp ${
    json.generate ".mcp.json" {
      mcpServers.worker-mcp = {
        inherit command;
      }
      // pkgs.lib.optionalAttrs (env != { }) { inherit env; };
    }
  } $out/.mcp.json
  cp -r ${../skills/worker-mcp} $out/skills/worker-mcp
  chmod -R u+w,a+r $out
''

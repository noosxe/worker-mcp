# A flake check: builds the plugin folder with `lib.mkClaudePlugin` and checks
# its contents and that it is accepted by the package-independent rules.
{ self, pkgs }:
let
  default = self.lib.mkClaudePlugin { inherit pkgs; };
  custom = self.lib.mkClaudePlugin {
    inherit pkgs;
    command = "/opt/launch";
    env.WORKER_MCP_ALLOWED_ROOTS = "/home/user/src";
  };
  bin = "${self.packages.${pkgs.stdenv.hostPlatform.system}.worker-mcp}/bin/worker-mcp";
in
pkgs.runCommand "worker-mcp-plugin-check" { nativeBuildInputs = [ pkgs.jq ]; } ''
  jq -e '.mcpServers["worker-mcp"].command == "${bin}"
         and (.mcpServers["worker-mcp"] | has("env") | not)' ${default}/.mcp.json
  jq -e '.mcpServers["worker-mcp"].command == "/opt/launch"
         and .mcpServers["worker-mcp"].env.WORKER_MCP_ALLOWED_ROOTS == "/home/user/src"' ${custom}/.mcp.json
  jq -e '.name == "worker-mcp" and (has("mcpServers") | not) and (has("userConfig") | not)' ${default}/.claude-plugin/plugin.json
  head -3 ${default}/skills/worker-mcp/SKILL.md | grep -q '^name: worker-mcp$'
  touch $out
''

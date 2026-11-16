# A flake check: evaluates the Home Manager module with sample configs
# against a minimal stub of the options it uses (Home Manager itself is not an
# input of this flake), builds the checked config file, the launcher and the
# plugin folder, and inspects them.
{ self, pkgs }:
let
  inherit (pkgs) lib;

  # Only what the module touches in Home Manager.
  stub =
    { lib, ... }:
    {
      options = {
        assertions = lib.mkOption {
          type = lib.types.listOf lib.types.unspecified;
          default = [ ];
        };
        warnings = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
        };
        home.packages = lib.mkOption {
          type = lib.types.listOf lib.types.package;
          default = [ ];
        };
        home.homeDirectory = lib.mkOption {
          type = lib.types.str;
          default = "/home/user";
        };
        home.file = lib.mkOption {
          type = lib.types.attrsOf (
            lib.types.submodule {
              options.source = lib.mkOption { type = lib.types.path; };
            }
          );
          default = { };
        };
        xdg.configFile = lib.mkOption {
          type = lib.types.attrsOf (
            lib.types.submodule {
              options.source = lib.mkOption { type = lib.types.path; };
            }
          );
          default = { };
        };
        # a sops-nix secret, as the module sees it
        sops.secrets = lib.mkOption {
          type = lib.types.attrsOf (
            lib.types.submodule {
              options.path = lib.mkOption { type = lib.types.str; };
            }
          );
          default = { };
        };
      };
    };

  evaluate =
    extra:
    lib.evalModules {
      modules = [
        stub
        self.homeManagerModules.worker-mcp
        (
          { config, ... }:
          {
            _module.args.pkgs = pkgs;
            sops.secrets.classifier_key.path = "/run/secrets/classifier_key";
            sops.secrets.api_key.path = "/run/secrets/api_key";
            sops.secrets.jev_key.path = "/run/secrets/jev_key";
            programs.worker-mcp = {
              enable = true;
              gate = {
                mode = "auto";
                maxAutoApprove = "MEDIUM";
              };
              classifiers = [
                {
                  name = "local";
                  url = "http://127.0.0.1:8787/classify";
                  tokenFile = config.sops.secrets.classifier_key.path;
                  settings.timeoutMs = 2000;
                }
                {
                  name = "jev";
                  dialect = "jev";
                  backend = "typesafe";
                  tokenFile = config.sops.secrets.jev_key.path;
                  thresholds.userRequestedProbability = 0.9;
                  cacheTtlMs = 30000;
                }
              ];
              piPath = "/opt/pi/bin/pi";
              defaultModel = "zai/test-model";
              allowedRoots = [ "/home/user/src" ];
              logLevel = "debug";
              legacyTools = false;
              persistRuns = false;
              persistSessions = false;
              recordRetentionMs = 86400000;
              maxRecordedRuns = 100;
              sessionRetentionMs = 43200000;
              maxSessionBytes = 67108864;
              maxResumeContextTokens = 80000;
              reportCost = false;
              sandbox = {
                default = "workspace";
                toolIsolation = "require";
                extraRo = [ "/opt/toolchain" ];
                extraRw = [ "/var/cache/build" ];
                hide = [ "/data/home-backup" ];
              };
              env.WORKER_MCP_RUN_TIMEOUT_MS = 600000;
              envFiles.TEST_API_KEY = config.sops.secrets.api_key.path;
              claude.enable = true;
              settings = {
                gate.onClassifierFailure = "deny";
                limits.maxWorkers = 2;
              };
            };
          }
        )
        extra
      ];
    };

  evaluated = evaluate { };
  cfg = evaluated.config;
  file = cfg.xdg.configFile."worker-mcp/config.json".source;
  failed = lib.filter (a: !a.assertion) cfg.assertions;
  launcher = cfg.programs.worker-mcp.launcher;
  plugin = cfg.home.file."/home/user/.claude/skills/worker-mcp".source;

  # The same module with a custom command, and with the claude-code module's
  # `configDir` present.
  custom = evaluate {
    programs.worker-mcp.claude.command = "/opt/wrapper/bin/launch";
  };
  customPlugin = custom.config.home.file."/home/user/.claude/skills/worker-mcp".source;
  withConfigDir = evaluate {
    options.programs.claude-code.configDir = lib.mkOption { type = lib.types.str; };
    config.programs.claude-code.configDir = "/home/user/.config/claude";
  };
  moved = withConfigDir.config.home.file."/home/user/.config/claude/skills/worker-mcp".source;

  # `legacyTools` does nothing, but an existing configuration that sets it
  # must still evaluate, with a warning; without it there is no warning.
  withoutLegacy = evaluate { programs.worker-mcp.legacyTools = lib.mkForce null; };

  # Bad sandbox settings are refused at evaluation: a relative path, and a
  # required sandbox where there is none.
  badSandbox = evaluate {
    programs.worker-mcp.sandbox.extraRw = [ "cache" ];
  };
  badSandboxFailed = lib.filter (a: !a.assertion) badSandbox.config.assertions;

  # A secret file in the Nix store is refused.
  storeFile = evaluate {
    programs.worker-mcp.envFiles.OTHER_KEY = "${pkgs.writeText "secret" "x"}";
  };
  storeFailed = lib.filter (a: !a.assertion) storeFile.config.assertions;
  relativeFile = evaluate {
    programs.worker-mcp.envFiles.OTHER_KEY = "secret.txt";
  };
  relativeFailed = lib.filter (a: !a.assertion) relativeFile.config.assertions;
in
assert lib.assertMsg (failed == [ ]) (lib.concatMapStringsSep "; " (a: a.message) failed);
assert lib.assertMsg (
  builtins.length storeFailed == 1 && lib.hasInfix "envFiles" (builtins.head storeFailed).message
) "an envFiles path in the Nix store must be refused";
assert lib.assertMsg (
  builtins.length relativeFailed == 1
) "a relative envFiles path must be refused";
assert lib.assertMsg (
  builtins.length badSandboxFailed == 1 && lib.hasInfix "sandbox" (builtins.head badSandboxFailed).message
) "a relative sandbox path must be refused";
assert lib.assertMsg (
  builtins.length (lib.filter (a: !a.assertion) withConfigDir.config.assertions) == 0
) "configDir of the claude-code module must be accepted";
assert lib.assertMsg (
  builtins.length cfg.warnings == 1 && lib.hasInfix "legacyTools" (builtins.head cfg.warnings)
) "legacyTools must evaluate and give exactly one warning";
assert lib.assertMsg (
  withoutLegacy.config.warnings == [ ]
) "leaving legacyTools unset must give no warning";
pkgs.runCommand "worker-mcp-module-eval"
  {
    nativeBuildInputs = [
      pkgs.jq
      self.packages.${pkgs.stdenv.hostPlatform.system}.worker-mcp
    ];
  }
  ''
        # The file the module wrote: the sample settings, a token file as a path,
        # the typed options, and the env file's name passed through to workers.
        jq -e '
          .gate.mode == "auto"
          and .gate.maxAutoApprove == "MEDIUM"
          and .gate.onClassifierFailure == "deny"
          and .gate.classifiers[0].name == "local"
          and .gate.classifiers[0].timeoutMs == 2000
          and .gate.classifiers[0].tokenFile == "/run/secrets/classifier_key"
          and .gate.classifiers[1].dialect == "jev"
          and .gate.classifiers[1].backend == "typesafe"
          and (.gate.classifiers[1] | has("url") | not)
          and .gate.classifiers[1].tokenFile == "/run/secrets/jev_key"
          and .gate.classifiers[1].thresholds == { userRequestedProbability: 0.9 }
          and .limits.allowedRoots == ["/home/user/src"]
          and .limits.maxWorkers == 2
          and .persistRuns == false
          and .persistSessions == false
          and .limits.recordRetentionMs == 86400000
          and .limits.maxRecordedRuns == 100
          and .limits.sessionRetentionMs == 43200000
          and .limits.maxSessionBytes == 67108864
          and .resume.maxContextTokens == 80000
          and .usage.reportCost == false
          and .logLevel == "debug"
          and .providers.pi.path == "/opt/pi/bin/pi"
          and .providers.pi.defaultModel == "zai/test-model"
          and (has("legacyTools") | not)
          and .sandbox == { default: "workspace", toolIsolation: "require", extraRo: ["/opt/toolchain"], extraRw: ["/var/cache/build"], hide: ["/data/home-backup"] }
          and .env.allow == ["TEST_API_KEY"]
        ' ${file}

        # The server accepts it and shows the token file path as a path.
        export HOME="$TMPDIR/home"; mkdir -p "$HOME"
        worker-mcp --config ${file} --print-config > effective.json
        jq -e '.gate.classifiers[0].tokenFile == "/run/secrets/classifier_key"
               and .gate.classifiers[0].dialect == "worker-mcp-v1"
               and .gate.classifiers[1].tokenFile == "/run/secrets/jev_key"
               and .gate.classifiers[1].url == "https://api.typesafe.ai"
               and .gate.classifiers[1].model == "jev-latest"
               and .gate.classifiers[1].jev.denyScore == 2.5
               and .gate.classifiers[1].jev.userRequestedProbability == 0.9
               and .gate.classifiers[1].cacheTtlMs == 30000
               and .providers.pi.defaultModel == "zai/test-model"
               and .logLevel == "debug"
               and .sandbox.minimum == "none"
               and .sandbox.default == "workspace"
               and .sandbox.toolIsolation == "require"
               and .sandbox.extraRo == ["/opt/toolchain"]' effective.json

        # On Linux the package finds its own bubblewrap.
        ${lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
          grep -q "WORKER_MCP_BWRAP" ${self.packages.${pkgs.stdenv.hostPlatform.system}.worker-mcp}/bin/worker-mcp
          WORKER_MCP_BWRAP= true
          export HOME="$TMPDIR/home"
          worker-mcp --print-config | jq -e '.sandbox.bwrapPath | endswith("/bin/bwrap")'
        ''}

        # The package is installed alongside.
        test "${toString (builtins.length cfg.home.packages)}" = 1

        # An invalid config must fail the server, so a bad module config fails the build.
        echo '{"gate":{"mode":"auto"}}' > bad.json
        if worker-mcp --config bad.json --print-config 2> bad.err; then
          echo "an invalid config was accepted" >&2; exit 1
        fi
        grep -q "gate.classifiers is empty" bad.err

        # The plugin is one link to a folder of real files with the launcher as
        # the command.
        test -f ${plugin}/.claude-plugin/plugin.json
        test -f ${plugin}/skills/worker-mcp/SKILL.md
        test ! -L ${plugin}/.mcp.json
        jq -e '.name == "worker-mcp" and (has("userConfig") | not) and (has("mcpServers") | not)' ${plugin}/.claude-plugin/plugin.json
        jq -e '.mcpServers["worker-mcp"].command == "${launcher}"' ${plugin}/.mcp.json
        test -z "$(find ${plugin} -type l)"
        # A custom command replaces the launcher; the config dir follows the claude-code module.
        jq -e '.mcpServers["worker-mcp"].command == "/opt/wrapper/bin/launch"' ${customPlugin}/.mcp.json
        test -f ${moved}/.mcp.json

        # The launcher: env files into the environment (one trailing newline
        # stripped), nothing on stdout before the exec, no secret echoed.
        mkdir bin secrets
        printf 'secret-value\n\n' > secrets/key
        cat > bin/worker-mcp <<'EOF'
        #!/bin/sh
        printf '%s' "$TEST_API_KEY" > value
        printf '%s' "$WORKER_MCP_RUN_TIMEOUT_MS" > timeout
        EOF
        chmod +x bin/worker-mcp
        # A copy of the launcher with the package swapped for the stub above.
        sed -e "s|exec .*worker-mcp\"* |exec $PWD/bin/worker-mcp |" \
            -e "s|/run/secrets/api_key|$PWD/secrets/key|" ${launcher} > run.sh
        chmod +x run.sh
        ./run.sh > run.out 2> run.err
        printf 'secret-value\n' > expected
        cmp value expected
        test "$(cat timeout)" = 600000
        test ! -s run.out
        test ! -s run.err
        # A missing file fails on stderr only, without the secret or the path's content.
        rm secrets/key
        if ./run.sh > miss.out 2> miss.err; then echo "a missing env file was accepted" >&2; exit 1; fi
        test ! -s miss.out
        grep -q "cannot read the file for TEST_API_KEY" miss.err

        touch $out
  ''

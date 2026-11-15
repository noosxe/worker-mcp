# Home Manager module for worker-mcp: installs the package and writes its
# config file, checked at build time. Used as
#   imports = [ inputs.worker-mcp.homeManagerModules.default ];
#   programs.worker-mcp.enable = true;
# Secrets are file paths only (`tokenFile`, `envFiles`); a secret never enters
# the store.
self:
{
  config,
  options,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib)
    mkEnableOption
    mkIf
    mkOption
    types
    ;
  cfg = config.programs.worker-mcp;
  json = pkgs.formats.json { };

  classifierType = types.submodule {
    options = {
      name = mkOption {
        type = types.str;
        description = "Names the classifier in the gate log as `http:<name>`.";
        example = "local";
      };
      url = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = ''
          https, or http only for localhost, 127.0.0.1 and [::1]. Required for
          dialect `worker-mcp-v1` and for `backend = "custom"`; for the
          `jev` dialect it is the base URL, and `/v1/systemone` is appended.
          Leave it out for the `typesafe` and `openrouter` backends.
        '';
        example = "http://127.0.0.1:8787/classify";
      };
      dialect = mkOption {
        type = types.nullOr (
          types.enum [
            "worker-mcp-v1"
            "jev"
          ]
        );
        default = null;
        description = ''
          The wire format. `jev` is TypeSafe's System One API; commands and up
          to 8 KiB of arguments are sent to the backend. Server default:
          `worker-mcp-v1`.
        '';
      };
      backend = mkOption {
        type = types.nullOr (
          types.enum [
            "typesafe"
            "openrouter"
            "custom"
          ]
        );
        default = null;
        description = ''
          Dialect `jev` only: `typesafe` (https://api.typesafe.ai, model
          `jev-latest`), `openrouter` (https://openrouter.ai/api, model
          `jev-1.13`) or `custom` (any compatible server, needs `url`).
          Server default: `typesafe`, or `custom` when `url` is set.
        '';
      };
      model = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "Dialect `jev` only: overrides the backend's default model.";
        example = "jev-latest";
      };
      thresholds = mkOption {
        type = types.attrsOf types.float;
        default = { };
        description = ''
          Dialect `jev` only: how answers map to a verdict. Keys:
          `denyScore` (2.5), `askScore` (1.5), `askProbability` (0.75),
          `untrustedProbability` (0.7), `userRequestedProbability` (0.85),
          `thresholdMargin` (0.05): an allow is refused when a probability or
          score it rests on is this close to its threshold.
          Unset keys keep the server default.
        '';
        example = {
          userRequestedProbability = 0.9;
        };
      };
      cacheTtlMs = mkOption {
        type = types.nullOr types.ints.positive;
        default = null;
        description = ''
          Dialect `jev` only: reuse an allow or deny for the same call of the
          same worker for this long. Default (null): off.
        '';
      };
      tokenFile = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = ''
          A file holding the bearer token: mode 0600 or stricter, owned by the
          user running worker-mcp. A symlink is judged by its target, so a
          sops-nix secret works. Re-read on SIGHUP. Give the path, never the
          token, and never a path in the Nix store (it is world-readable).
        '';
        example = lib.literalExpression "config.sops.secrets.classifier_key.path";
      };
      settings = mkOption {
        type = json.type;
        default = { };
        description = ''
          Other keys of this classifier (`timeoutMs`,
          `minAllowConfidence`, `minDenyConfidence`, `maxArgumentBytes`,
          `sendIntent`, `breaker`).
        '';
        example = {
          timeoutMs = 2000;
          minAllowConfidence = 0.9;
        };
      };
    };
  };

  classifierSettings =
    c:
    {
      inherit (c) name;
    }
    // lib.filterAttrs (_: v: v != null) {
      inherit (c)
        url
        dialect
        backend
        model
        cacheTtlMs
        tokenFile
        ;
    }
    // lib.optionalAttrs (c.thresholds != { }) { inherit (c) thresholds; }
    // c.settings;

  # Names of env files go to the workers too: they are only given to the
  # server so that the worker agent can use them.
  passthrough = lib.unique (cfg.envPassthrough ++ lib.attrNames cfg.envFiles);

  # What the typed options say; `settings` is merged over it and wins.
  typed = {
    inherit (cfg) logLevel;
    providers.pi = lib.filterAttrs (_: v: v != null) {
      path = cfg.piPath;
      inherit (cfg) defaultModel;
    };
    limits = lib.optionalAttrs (cfg.allowedRoots != [ ]) { inherit (cfg) allowedRoots; };
    sandbox =
      lib.filterAttrs (_: v: v != null) {
        inherit (cfg.sandbox) minimum default bwrapPath toolIsolation;
      }
      // lib.optionalAttrs (cfg.sandbox.extraRo != [ ]) { inherit (cfg.sandbox) extraRo; }
      // lib.optionalAttrs (cfg.sandbox.extraRw != [ ]) { inherit (cfg.sandbox) extraRw; }
      // lib.optionalAttrs (cfg.sandbox.hide != [ ]) { inherit (cfg.sandbox) hide; };
    env = lib.optionalAttrs (passthrough != [ ]) { allow = passthrough; };
    gate =
      lib.filterAttrs (_: v: v != null) {
        inherit (cfg.gate)
          mode
          httpAllowCeiling
          maxAutoApprove
          onClassifierFailure
          ;
      }
      // lib.optionalAttrs (cfg.classifiers != [ ]) {
        classifiers = map classifierSettings cfg.classifiers;
      };
  };
  effective = lib.recursiveUpdate typed cfg.settings;
  generated = json.generate "worker-mcp-config.json" effective;

  # The generated file is run through the package itself, so settings the
  # server would reject fail the build instead of the first start.
  checked =
    pkgs.runCommand "worker-mcp-config.json"
      {
        nativeBuildInputs = [ cfg.package ];
      }
      ''
        export HOME="$TMPDIR/home"
        mkdir -p "$HOME"
        worker-mcp --config ${generated} --print-config > "$TMPDIR/effective.json"
        cp ${generated} $out
      '';

  inStore = path: lib.hasPrefix builtins.storeDir path;

  # Starts the server with the env files read into the environment. Its
  # stdout is the MCP channel, so it prints nothing before the exec; problems
  # go to stderr and never include a value.
  launcher = pkgs.writeShellScript "worker-mcp-launcher" ''
    set -eu
    ${lib.concatStringsSep "\n" (
      lib.mapAttrsToList (name: value: "export ${name}=${lib.escapeShellArg (toString value)}") cfg.env
    )}
    ${lib.concatStringsSep "\n" (
      lib.mapAttrsToList (name: file: ''
        if ! _v=$(${pkgs.coreutils}/bin/cat ${lib.escapeShellArg file} 2>/dev/null && printf x); then
          echo "worker-mcp: cannot read the file for ${name}" >&2
          exit 1
        fi
        _v=''${_v%x}
        export ${name}="''${_v%$'\n'}"
      '') cfg.envFiles
    )}
    unset _v
    exec ${lib.getExe cfg.package} "$@"
  '';

  server = if cfg.claude.command != null then cfg.claude.command else toString launcher;
  plugin = self.lib.mkClaudePlugin {
    inherit pkgs;
    command = server;
  };

  claudeDir =
    if
      options ? programs && options.programs ? claude-code && options.programs.claude-code ? configDir
    then
      config.programs.claude-code.configDir
    else
      "${config.home.homeDirectory}/.claude";

  envName = n: builtins.match "[A-Za-z_][A-Za-z0-9_]*" n != null;
  tokenFiles =
    (map (c: c.tokenFile) (lib.filter (c: c.tokenFile != null) cfg.classifiers))
    ++ lib.concatMap (c: lib.optional (c ? tokenFile) c.tokenFile) (effective.gate.classifiers or [ ]);
in
{
  options.programs.worker-mcp = {
    enable = mkEnableOption "worker-mcp, an MCP server that supervises coding-agent workers";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.worker-mcp;
      defaultText = lib.literalExpression "worker-mcp from the flake that provides this module";
      description = "The worker-mcp package.";
    };

    settings = mkOption {
      type = json.type;
      default = { };
      description = ''
        The configuration file, as Nix: the same keys as the JSON config
        (see `worker-mcp --print-config`). Whatever the typed options below
        set is merged under it. Written to
        {file}`$XDG_CONFIG_HOME/worker-mcp/config.json` and validated at build
        time. Secrets are file paths, for example
        `gate.classifiers = [ { tokenFile = config.sops.secrets.x.path; } ]`.
      '';
      example = lib.literalExpression ''
        {
          gate.maxAutoApprove = "HIGH";
          limits.allowedRoots = [ "''${config.home.homeDirectory}/src" ];
        }
      '';
    };

    piPath = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "The pi binary (`providers.pi.path`). Default (null): `pi` from the PATH.";
      example = lib.literalExpression "lib.getExe pkgs.pi";
    };

    defaultModel = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = ''
        Model for pi workers spawned without `model`, as `<provider>/<model>`
        (`providers.pi.defaultModel`). An explicit `model` always wins.
      '';
      example = "zai/glm-5.3";
    };

    logLevel = mkOption {
      type = types.enum [
        "debug"
        "info"
        "warn"
        "error"
      ];
      default = "info";
      description = ''
        How much the server writes to stderr (`logLevel`). Tool inputs, file
        contents and worker output are written only at `debug`; every other
        level carries metadata only. `WORKER_MCP_LOG_LEVEL` in the server's
        environment overrides it.
      '';
    };

    allowedRoots = mkOption {
      type = types.listOf types.str;
      default = [ ];
      description = ''
        Absolute directories a worker's `cwd` must lie in
        (`limits.allowedRoots`). Default: no restriction.
      '';
      example = [ "/home/user/src" ];
    };

    legacyTools = mkOption {
      type = types.nullOr types.bool;
      default = null;
      description = "No longer used: the pi-named tools are gone. It is accepted so existing configurations still evaluate, but it does nothing and is not written to the config file. Setting it gives a warning; remove it.";
    };

    envPassthrough = mkOption {
      type = types.listOf types.str;
      default = [ ];
      description = ''
        Extra environment names (or `PREFIX_*` patterns) workers receive
        (`env.allow`). The names in `envFiles` are added automatically.
      '';
    };

    env = mkOption {
      type = types.attrsOf (
        types.oneOf [
          types.str
          types.int
          types.bool
        ]
      );
      default = { };
      description = ''
        Plain environment variables the launcher sets for the server. The
        values end up in the Nix store: never put a secret here, use
        `envFiles`.
      '';
      example = {
        WORKER_MCP_RUN_TIMEOUT_MS = 600000;
      };
    };

    envFiles = mkOption {
      type = types.attrsOf types.str;
      default = { };
      description = ''
        Environment variables read from files when the server starts: the
        name is the variable, the value is an absolute path outside the Nix
        store, for example a sops-nix secret. The launcher strips one
        trailing newline, never prints a value, and writes nothing to stdout.
        The server starts with an error on stderr when a file is unreadable.
        These names are also added to `envPassthrough`, so the worker agent
        (for example pi, which needs its provider's API key) gets them; use
        `tokenFile` on a classifier for a secret only the server needs.
      '';
      example = lib.literalExpression ''
        { ZAI_API_KEY = config.sops.secrets.zai_api_key.path; }
      '';
    };

    launcher = mkOption {
      type = types.package;
      readOnly = true;
      internal = true;
      default = launcher;
      description = "The generated launcher script (reads `envFiles`, then runs the server).";
    };

    claude = {
      enable = mkEnableOption ''
        the worker-mcp plugin for Claude Code (terminal and desktop app), linked
        as one symlink to the whole plugin folder in the skills directory.
        It does not use `programs.claude-code.plugins`, whose per-entry
        symlinks Claude Code rejects ("Path escapes plugin directory"), and
        does not need `programs.claude-code` to be enabled'';
      name = mkOption {
        type = types.strMatching "[A-Za-z0-9._-]+";
        default = "worker-mcp";
        description = "Name of the link in the skills directory.";
      };
      command = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = ''
          Absolute path of the command the plugin runs as the server, in
          place of the generated launcher (a wrapper of your own). Its
          environment, `env` and `envFiles` are then yours to handle.
        '';
        example = lib.literalExpression ''"''${myLauncher}/bin/my-launcher"'';
      };
      package = mkOption {
        type = types.package;
        readOnly = true;
        internal = true;
        default = plugin;
        description = "The plugin folder.";
      };
    };

    gate = {
      mode = mkOption {
        type = types.nullOr (
          types.enum [
            "manual"
            "auto"
          ]
        );
        default = null;
        description = ''
          `auto` lets the classifiers decide calls the rules would escalate;
          only uncertain ones reach the coordinator. Needs at least one
          classifier. Default (null): the server's default, `manual`.
        '';
      };
      httpAllowCeiling = mkOption {
        type = types.nullOr (
          types.enum [
            "LOW"
            "MEDIUM"
            "HIGH"
          ]
        );
        default = null;
        description = "Highest risk level a classifier may allow. Server default: HIGH.";
      };
      maxAutoApprove = mkOption {
        type = types.nullOr (
          types.enum [
            "LOW"
            "MEDIUM"
            "HIGH"
          ]
        );
        default = null;
        description = "Ceiling on what the coordinator's own policy may auto-approve. Server default: MEDIUM.";
      };
      onClassifierFailure = mkOption {
        type = types.nullOr (
          types.enum [
            "escalate"
            "deny"
          ]
        );
        default = null;
        description = "What a classifier that cannot answer means. There is no allow. Server default: escalate.";
      };
    };

    sandbox = {
      minimum = mkOption {
        type = types.nullOr (
          types.enum [
            "none"
            "workspace"
          ]
        );
        default = null;
        description = ''
          The least a worker may run with; `spawn_worker` cannot ask for less.
          `workspace` (bubblewrap, Linux only) lets a worker write only its
          workspace and hides the home directory. It makes a spawn fail when
          the sandbox does not work, so it is refused on macOS, which has no
          sandbox. Server default (null): `none`.
        '';
      };
      default = mkOption {
        type = types.nullOr (
          types.enum [
            "none"
            "workspace"
          ]
        );
        default = null;
        description = ''
          What a spawn gets when it names no sandbox. Server default (null):
          `workspace` where it works, otherwise `none`.
        '';
      };
      toolIsolation = mkOption {
        type = types.nullOr (
          types.enum [
            "auto"
            "require"
            "off"
          ]
        );
        default = null;
        description = ''
          Whether the shell commands a sandboxed worker runs get a second
          sandbox that hides pi's credential file and the pi process from
          them. `auto` uses it where it works and warns where it does not,
          `require` refuses a spawn where it cannot work, `off` never uses
          it. Server default (null): `auto`.
        '';
      };
      extraRo = mkOption {
        type = types.listOf types.str;
        default = [ ];
        description = "Absolute paths mounted read-only into the sandbox, besides the read-only system and the provider's own configuration.";
        example = [ "/opt/toolchain" ];
      };
      extraRw = mkOption {
        type = types.listOf types.str;
        default = [ ];
        description = "Absolute paths mounted writable into the sandbox, such as a shared build cache.";
        example = [ "/var/cache/build" ];
      };
      hide = mkOption {
        type = types.listOf types.str;
        default = [ ];
        description = ''
          Absolute paths always hidden behind an empty directory in the
          sandbox, besides the home directory and the other paths to it that
          the server finds from the mounts (for example `/persistent/home/user`
          on a system with impermanence). For ways to the home directory's
          data that it misses.
        '';
        example = [ "/data/home-backup" ];
      };
      bwrapPath = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = ''
          The bubblewrap binary. Default (null): the package's own
          bubblewrap on Linux, which it finds through `WORKER_MCP_BWRAP`.
        '';
      };
    };

    classifiers = mkOption {
      type = types.listOf classifierType;
      default = [ ];
      description = "HTTP classifiers, consulted in order in auto mode.";
      example = lib.literalExpression ''
        [
          {
            name = "local";
            url = "http://127.0.0.1:8787/classify";
            tokenFile = config.sops.secrets.classifier_key.path;
          }
          {
            name = "jev";
            dialect = "jev";
            backend = "typesafe";
            tokenFile = config.sops.secrets.jev_key.path;
          }
        ]
      '';
    };
  };

  config = mkIf cfg.enable {
    warnings = lib.optional (cfg.legacyTools != null) "programs.worker-mcp.legacyTools is no longer used and has no effect: the pi-named tools were removed. Remove it from your configuration.";

    assertions = [
      {
        assertion = lib.all (p: lib.hasPrefix "/" p && !inStore p) tokenFiles;
        message = "programs.worker-mcp: a tokenFile must be an absolute path outside the Nix store (for example a sops-nix secret path); the store is world-readable.";
      }
      {
        assertion = lib.all (p: lib.hasPrefix "/" p && !inStore p) (lib.attrValues cfg.envFiles);
        message = "programs.worker-mcp.envFiles: each value must be an absolute path outside the Nix store (for example a sops-nix secret path); the store is world-readable.";
      }
      {
        assertion = lib.all envName (lib.attrNames cfg.env ++ lib.attrNames cfg.envFiles);
        message = "programs.worker-mcp: names in env and envFiles must be valid environment variable names.";
      }
      {
        assertion = lib.all (p: lib.hasPrefix "/" p) cfg.allowedRoots;
        message = "programs.worker-mcp.allowedRoots: each entry must be an absolute path.";
      }
      {
        assertion = lib.all (p: lib.hasPrefix "/" p) (cfg.sandbox.extraRo ++ cfg.sandbox.extraRw ++ cfg.sandbox.hide);
        message = "programs.worker-mcp.sandbox: each extraRo, extraRw and hide entry must be an absolute path.";
      }
      {
        assertion = cfg.sandbox.bwrapPath == null || lib.hasPrefix "/" cfg.sandbox.bwrapPath;
        message = "programs.worker-mcp.sandbox.bwrapPath must be an absolute path.";
      }
      {
        assertion = cfg.sandbox.minimum != "workspace" || pkgs.stdenv.hostPlatform.isLinux;
        message = "programs.worker-mcp.sandbox.minimum = \"workspace\" needs Linux: macOS has no sandbox, so a worker could never be spawned. Leave it at \"none\".";
      }
      {
        assertion = cfg.claude.command == null || lib.hasPrefix "/" cfg.claude.command;
        message = "programs.worker-mcp.claude.command must be an absolute path.";
      }
      {
        assertion = !cfg.claude.enable || lib.hasPrefix "${config.home.homeDirectory}/" claudeDir;
        message = "programs.worker-mcp.claude: the Claude Code config directory (${claudeDir}) must be inside the home directory.";
      }
    ];

    home.packages = [ cfg.package ];
    xdg.configFile."worker-mcp/config.json".source = checked;

    # One symlink to the whole plugin folder.
    home.file = mkIf cfg.claude.enable {
      "${claudeDir}/skills/${cfg.claude.name}".source = plugin;
    };
  };
}

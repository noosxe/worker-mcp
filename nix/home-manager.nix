# Home Manager module for worker-mcp: installs the package and writes its
# config file, checked at build time. Used as
#   imports = [ inputs.worker-mcp.homeManagerModules.default ];
#   programs.worker-mcp.enable = true;
# Secrets are file paths only (`tokenFile`); a token never enters the store.
self:
{
  config,
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
        type = types.str;
        description = "https, or http only for localhost, 127.0.0.1 and [::1].";
        example = "http://127.0.0.1:8787/classify";
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
          Other keys of this classifier (`dialect`, `timeoutMs`,
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

  classifierSettings = c: {
    inherit (c) name url;
  }
  // lib.optionalAttrs (c.tokenFile != null) { inherit (c) tokenFile; }
  // c.settings;

  # What the typed options say; `settings` is merged over it and wins.
  typed = {
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
        ]
      '';
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = lib.all (p: lib.hasPrefix "/" p && !inStore p) tokenFiles;
        message = "programs.worker-mcp: a tokenFile must be an absolute path outside the Nix store (for example a sops-nix secret path); the store is world-readable.";
      }
    ];

    home.packages = [ cfg.package ];
    xdg.configFile."worker-mcp/config.json".source = checked;
  };
}

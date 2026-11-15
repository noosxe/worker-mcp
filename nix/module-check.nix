# A flake check: evaluates the Home Manager module with a sample config
# against a minimal stub of the options it uses (Home Manager itself is not an
# input of this flake), builds the checked config file and inspects it.
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
        home.packages = lib.mkOption {
          type = lib.types.listOf lib.types.package;
          default = [ ];
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

  evaluated = lib.evalModules {
    modules = [
      stub
      self.homeManagerModules.worker-mcp
      (
        { config, ... }:
        {
          _module.args.pkgs = pkgs;
          sops.secrets.classifier_key.path = "/run/secrets/classifier_key";
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
            ];
            settings = {
              gate.onClassifierFailure = "deny";
              limits.allowedRoots = [ "/home/user/src" ];
            };
          };
        }
      )
    ];
  };
  cfg = evaluated.config;
  file = cfg.xdg.configFile."worker-mcp/config.json".source;
  failed = lib.filter (a: !a.assertion) cfg.assertions;
in
assert lib.assertMsg (failed == [ ]) (lib.concatMapStringsSep "; " (a: a.message) failed);
pkgs.runCommand "worker-mcp-module-eval"
  {
    nativeBuildInputs = [
      pkgs.jq
      self.packages.${pkgs.stdenv.hostPlatform.system}.worker-mcp
    ];
  }
  ''
    # The file the module wrote: the sample settings, a token file as a path.
    jq -e '
      .gate.mode == "auto"
      and .gate.maxAutoApprove == "MEDIUM"
      and .gate.onClassifierFailure == "deny"
      and .gate.classifiers[0].name == "local"
      and .gate.classifiers[0].timeoutMs == 2000
      and .gate.classifiers[0].tokenFile == "/run/secrets/classifier_key"
      and .limits.allowedRoots == ["/home/user/src"]
    ' ${file}

    # The server accepts it and shows the token file path as a path.
    export HOME="$TMPDIR/home"; mkdir -p "$HOME"
    worker-mcp --config ${file} --print-config > effective.json
    jq -e '.gate.classifiers[0].tokenFile == "/run/secrets/classifier_key"
           and .gate.classifiers[0].dialect == "worker-mcp-v1"' effective.json

    # The package is installed alongside.
    test "${toString (builtins.length cfg.home.packages)}" = 1

    # An invalid config must fail the server, so a bad module config fails the build.
    echo '{"gate":{"mode":"auto"}}' > bad.json
    if worker-mcp --config bad.json --print-config 2> bad.err; then
      echo "an invalid config was accepted" >&2; exit 1
    fi
    grep -q "gate.classifiers is empty" bad.err

    touch $out
  ''

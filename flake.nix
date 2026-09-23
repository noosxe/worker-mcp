{
  description = "worker-mcp server: supervises local pi coding-agent sessions via MCP";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    systems.url = "github:nix-systems/default";
  };

  outputs =
    {
      self,
      nixpkgs,
      systems,
    }:
    let
      # Build a function over every system exposed by the `systems` input.
      eachSystem = f: nixpkgs.lib.genAttrs (import systems) (system: f system nixpkgs.legacyPackages.${system});

      version = "0.4.1";
      pnpmHash = "sha256-9TF7Y7gGXPMHzFPkes4O9XBHZTM+GdGxMYpR6QqwKOo=";

      worker-mcp-for =
        pkgs:
        let
          # fetchPnpmDeps' fixupPhase normalizes every *.json file in the pnpm store
          # with jq and aborts the whole fetch when a file is not strict JSON
          # (JSONC comments, NaN, ...). Guard the jq call so non-strict files
          # keep their original bytes instead (issue #62).
          pnpmDeps =
            (pkgs.fetchPnpmDeps {
              pname = "worker-mcp-deps";
              inherit version;
              src = ./.;
              fetcherVersion = 4;
              hash = pnpmHash;
            }).overrideAttrs
              (old: {
                fixupPhase = builtins.replaceStrings
                  [ ''jq --sort-keys "del(.. | .checkedAt?)" $f | sponge $f'' ]
                  [
                    ''
                      if jqOut=$(jq --sort-keys "del(.. | .checkedAt?)" $f 2>/dev/null); then
                        printf '%s\n' "$jqOut" | sponge $f
                      else
                        echo "fetchPnpmDeps: $f is not strict JSON, keeping original bytes" >&2
                      fi
                    ''
                  ]
                  old.fixupPhase;
                # pnpm only materializes the v11/links/<pkg> extracted trees on
                # darwin, not on linux, which makes the store output
                # platform-dependent (and drags the JSONC tsconfig.json files
                # above into the store). The data of record is v11/files plus
                # the index database, so drop links/ for a hash that is
                # identical on every platform.
                preFixup = ''rm -rf "$storePath"/v11/links'';
              });
        in
        pkgs.stdenv.mkDerivation {
          pname = "worker-mcp";
          inherit version;

          # Only ship build inputs into the store, not dist/ node_modules/ scratch/ result/ etc.
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [
              ./package.json
              ./pnpm-lock.yaml
              ./pnpm-workspace.yaml
              ./tsconfig.json
              ./src
            ];
          };

          inherit pnpmDeps;

          nativeBuildInputs = [
            pkgs.nodejs_24
            pkgs.pnpmConfigHook
            pkgs.pnpm
            pkgs.makeWrapper
          ];

          buildPhase = ''
            runHook preBuild

            # fetchPnpmDeps normalizes every file in the pnpm store to mode 444
            # (555 only for *-exec marker files, which the v11 store layout does
            # not use), and pnpm's offline import does not restore the executable
            # bit on native binaries. tsc 7 is a native binary, so re-grant +x on
            # anything with an ELF/Mach-O magic header before building.
            find node_modules -type f -print0 | while IFS= read -r -d "" f; do
              if [ -x "$f" ]; then
                continue
              fi
              magic=$(head -c 4 "$f" 2>/dev/null || true)
              case "$magic" in
                $'\x7fELF' | $'\xcf\xfa\xed\xfe' | $'\xca\xfe\xba\xbe' | $'\xfe\xed\xfa\xce' | $'\xce\xfa\xed\xfe' | $'\xbe\xba\xfe\xed')
                  chmod +x "$f"
                  ;;
              esac
            done

            pnpm build
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall

            mkdir -p $out/lib/node_modules/worker-mcp
            cp -r dist node_modules package.json $out/lib/node_modules/worker-mcp/

            mkdir -p $out/bin
            makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/worker-mcp \
              --add-flags "$out/lib/node_modules/worker-mcp/dist/index.js"

            runHook postInstall
          '';

          meta = with pkgs.lib; {
            description = "Supervises local pi coding-agent sessions via MCP";
            homepage = "https://github.com/noosxe/worker-mcp";
            license = licenses.mit;
            mainProgram = "worker-mcp";
            platforms = platforms.unix;
          };
        };
    in
    {
      overlays.default = final: prev: {
        worker-mcp = self.packages.${final.system}.worker-mcp;
      };

      packages = eachSystem (system: pkgs: {
        default = self.packages.${system}.worker-mcp;
        worker-mcp = worker-mcp-for pkgs;
      });

      apps = eachSystem (system: _: {
        default = let pkg = self.packages.${system}.worker-mcp; in {
          type = "app";
          program = "${pkg}/bin/worker-mcp";
          meta = pkg.meta;
        };
      });

      devShells = eachSystem (_: pkgs: {
        default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs_24
            pnpm
            typescript
            typescript-language-server
            oxlint
            oxfmt
          ];

          shellHook = ''
            echo "========================================="
            echo "  Welcome to the worker-mcp dev shell!   "
            echo "  Node.js: $(node --version)             "
            echo "  PNPM:    $(pnpm --version 2>/dev/null || echo 'not installed globally')"
            echo "========================================="
          '';
        };
      });
    };
}

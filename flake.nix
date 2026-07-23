{
  description = "worker-mcp server: supervises local pi coding-agent sessions via MCP";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    let
      overlays.default = final: prev: {
        worker-mcp = self.packages.${final.system}.worker-mcp;
      };
    in
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };

        worker-mcp =
          let
            pnpmDeps = pkgs.fetchPnpmDeps {
              pname = "worker-mcp-deps";
              version = "0.3.2";
              src = ./.;
              fetcherVersion = 4;
              hash = "sha256-5t/vaqqwpNisuHvm82a8kGQuUcxbzkJFvPkMZ8GL8Pw=";
            };
          in
          pkgs.stdenv.mkDerivation {
            pname = "worker-mcp";
            version = "0.3.2";
            src = ./.;

            inherit pnpmDeps;

            nativeBuildInputs = [
              pkgs.nodejs_24
              pkgs.pnpmConfigHook
              pkgs.pnpm
              pkgs.makeWrapper
            ];

            buildPhase = ''
              pnpm build
            '';

            installPhase = ''
              mkdir -p $out/lib/node_modules/worker-mcp
              cp -r dist node_modules package.json $out/lib/node_modules/worker-mcp/

              mkdir -p $out/bin
              makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/worker-mcp \
                --add-flags "$out/lib/node_modules/worker-mcp/dist/index.js"
            '';
          };
      in
      {
        packages.default = worker-mcp;
        packages.worker-mcp = worker-mcp;

        apps.default = flake-utils.lib.mkApp {
          drv = worker-mcp;
        };

        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs_24
            pnpm
            typescript
            typescript-language-server
            biome
          ];

          shellHook = ''
            echo "========================================="
            echo "  Welcome to the worker-mcp dev shell!   "
            echo "  Node.js: $(node --version)             "
            echo "  PNPM:    $(pnpm --version 2>/dev/null || echo 'not installed globally')"
            echo "========================================="
          '';
        };
      }
    )
    // {
      inherit overlays;
    };
}

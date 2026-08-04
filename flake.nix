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
        version = "0.4.1";

        worker-mcp =
          let
            pnpmDeps = pkgs.fetchPnpmDeps {
              pname = "worker-mcp-deps";
              inherit version;
              src = ./.;
              fetcherVersion = 4;
              hash = "sha256-CabYMfu1DE49R7QT2BGDCxQ+t0IjsLPvXudx9xm3pVs=";
            };
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
        packages.default = worker-mcp;
        packages.worker-mcp = worker-mcp;

        apps.default = {
          type = "app";
          program = "${worker-mcp}/bin/worker-mcp";
          meta = worker-mcp.meta;
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

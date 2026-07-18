{
  description = "Development environment for worker-mcp";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs_24
            pnpm
            typescript
            typescript-language-server
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
    );
}

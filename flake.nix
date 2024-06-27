{ description = "Tiled, scrollable window management for GNOME Shell";

  inputs."nixpkgs".url = github:NixOS/nixpkgs;

  outputs = { self, nixpkgs, flake-utils, ... }:
  flake-utils.lib.eachDefaultSystem
    (system:
    let pkgs = import nixpkgs { inherit system; };
    in
    { packages.default = pkgs.callPackage ./default.nix {};
    });
}

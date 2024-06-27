{ pkgs, stdenv, glib, ... }:

let
  uuid = "paperwm@paperwm.github.com";
in
stdenv.mkDerivation {
  pname = "gnome-shell-extension-paperwm";
  version = "unstable";
  src = ./.;

  nativeBuildInputs = with pkgs;
    [ glib
    ];
  buildPhase = ''
    make -C schemas gschemas.compiled
  '';

  installPhase = ''
    mkdir -p $out/share/gnome-shell/extensions
    cp -r -T . $out/share/gnome-shell/extensions/${uuid}
  '';

  passthru = {
    extensionPortalSlug = "paperwm";
    extensionUuid = uuid;
  };
}

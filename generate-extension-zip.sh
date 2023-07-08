#!/bin/sh

# Creates a zip of (only) the necessary files required by Gnome for the PaperWM extension.
# Designed for submitting a zip to extensions.gnome.org.
/usr/bin/zip -r paperwm@paperwm-redux.github.com.zip \
	metadata.json \
	stylesheet.css \
	*.js \
	*.ui \
	LICENSE \
	schemas/gschemas.compiled \
	schemas/org.gnome.shell.extensions.paperwm.gschema.xml \
	resources/

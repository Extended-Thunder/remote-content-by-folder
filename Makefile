FILES := \
	LICENSE \
	README.md \
	api/LegacyPrefs/implementation.js \
	api/LegacyPrefs/schema.json \
	api/LegacyPrefs/README.md \
	api/RemoteContent/implementation.js \
	api/RemoteContent/schema.json \
	background.js \
	options.html \
	options.js \
	i18n.js \
	icon48.png \
	icon96.png \
	manifest.json \
	$(wildcard _locales/*/messages.json) \
	$(nothing)

all: remote-content-by-folder.xpi

remote-content-by-folder.xpi: Makefile $(FILES)
	-rm -f $@.tmp
	zip -r $@.tmp $(FILES)
	mv -f $@.tmp $@

clean:
	-rm -f *.tmp *.xpi
